import type {
  GeoPoint,
  SlotType,
  Decision,
  Order,
  SessionLock,
  EventType,
  RouteStop,
  SlotWindow,
} from '@slot/shared';
import {SlotService} from './slotService.js';
import {InMemoryStore, Hold} from '../store/inMemoryStore.js';

const HOLD_TTL_MS = 10 * 60 * 1000; // 10-minute checkout session
const ID_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function generateId(prefix: string, len = 6): string {
  let id = '';
  for (let i = 0; i < len; i++) id += ID_CHARS[Math.floor(Math.random() * ID_CHARS.length)];
  return `${prefix}-${id}`;
}

export interface HoldResult {
  holdId: string;
  date: string;
  slot: SlotType;
  sub_slot_time: string;
  location: GeoPoint;
  eventTypeId: string;
  expiresAt: string;
}

export class BookingEngine {
  constructor(
    private readonly slotService: SlotService,
    private readonly store: InMemoryStore,
  ) {}

  /**
   * Convenience: single-method booking decision (checks availability then acquires hold).
   * Use createHold + confirmBooking for the two-step checkout flow.
   */
  async decide(
    sessionId: string,
    customerId: string,
    location: GeoPoint,
    date: string,
    slotType: SlotType,
    eventTypeId = 'default',
  ): Promise<Decision> {
    const result = await this.createHold(sessionId, customerId, location, date, slotType, eventTypeId);
    if (result && 'reason_code' in result && result.status === 'refused') {
      return result as Decision;
    }
    const hold = result as HoldResult;
    return this.confirmBooking(hold.holdId, customerId, `idem-${sessionId}-${date}-${slotType}`);
  }

  /**
   * Pipeline: Date → Morning check → Capacity → Route → ok
   */
  async checkAvailability(
    location: GeoPoint,
    date: string,
    slotType: SlotType,
    eventTypeId: string,
  ): Promise<Decision> {
    const eventType = this.slotService.getEventType(eventTypeId);
    const setupMins = eventType.setup_minutes;
    const config = this.slotService.getConfig();

    // 1. Date not in past
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const reqDate = new Date(date + 'T12:00:00');
    if (reqDate < today) {
      return {status: 'refused', date, slot: slotType, location, reason_code: 'date_in_past', message: 'Cannot book a past date.'};
    }

    // 2. No morning slot (by construction — only afternoon/evening exist)
    // Already validated by caller

    // 3. Capacity: confirmed + active_holds < cap
    const max = this.slotService.getCapacity(date);
    const confirmedCount = await this.slotService.getOrderCount(date, slotType);
    const activeHolds = await this.store.getActiveHolds(date, slotType);
    const totalHeld = confirmedCount + activeHolds.length;
    if (totalHeld >= max) {
      const nextBest = await this.slotService.findNextBest(location, date, slotType, setupMins);
      return {
        status: 'refused', date, slot: slotType, location,
        reason_code: 'capacity_full',
        message: `${slotType} on ${date} is fully booked.`,
        capacity: {used: totalHeld, max},
        suggestions: nextBest ? [{...nextBest, reason: 'Available slot'}] : [],
      };
    }

    // 4. Route feasibility
    const window = this.slotService.getSlotWindow(slotType);
    const rv = this.slotService.getRouteValidator();
    const windowMins = rv.windowDuration(window.window_start, window.must_finish_by);
    const existingStops = await this.slotService.getExistingStops(date, slotType);

    // Always check in-bounds first.
    if (!rv.isInBounds(location)) {
      const nextBest = await this.slotService.findNextBest(location, date, slotType, setupMins);
      return {
        status: 'refused', date, slot: slotType, location,
        reason_code: 'out_of_bounds',
        message: 'Location is outside the service area.',
        suggestions: nextBest ? [{...nextBest, reason: 'Out of service area'}] : [],
      };
    }

    // NN route budget check: skip when sub-slot orders already exist.
    // canAddAtSubSlot (time-ordered) is authoritative in that case; NN routing
    // ignores the waiting gaps between sub-slots and over-counts total time.
    const existingOrders = await this.store.getOrders({date, slot: slotType, status: 'confirmed'});
    const hasSubSlotOrders = existingOrders.some((o) => o.sub_slot_time);

    if (!hasSubSlotOrders) {
      const feasibility = rv.canAddStop(location, existingStops, windowMins, setupMins);
      if (!feasibility.feasible) {
        const nextBest = await this.slotService.findNextBest(location, date, slotType, setupMins);
        return {
          status: 'refused', date, slot: slotType, location,
          reason_code: 'route_over_budget',
          message: `Adding this stop would need ${Math.round(feasibility.route_time!)} min but only ${windowMins} min are available.`,
          route: {total_minutes: feasibility.route_time!, budget_minutes: windowMins, sequence: [], over_budget: true},
          suggestions: nextBest ? [{...nextBest, reason: 'Route feasible in this slot'}] : [],
        };
      }
    }

    // 5. OK — route summary for FE
    const allStops = [...existingStops, location];
    const routeResult = rv.computeRoute(
      allStops,
      new Map([[eventTypeId, eventType]]),
      setupMins,
    );
    const overBudget = routeResult.total_minutes > windowMins;

    return {
      status: 'accepted', date, slot: slotType, location,
      reason_code: 'ok',
      message: `${slotType} slot on ${date} is available.`,
      capacity: {used: totalHeld, max},
      route: {
        total_minutes: Math.round(routeResult.total_minutes),
        budget_minutes: windowMins,
        sequence: [],
        over_budget: overBudget,
      },
    };
  }

  /**
   * Acquire a hold on a specific sub-slot (step 1 of checkout).
   * If subSlotTime is omitted the engine auto-assigns the earliest feasible one.
   * Serialized per process so two racers cannot both grab the last sub-slot.
   */
  async createHold(
    sessionId: string,
    customerId: string,
    location: GeoPoint,
    date: string,
    slotType: SlotType,
    eventTypeId: string,
    subSlotTime?: string,
  ): Promise<HoldResult | Decision> {
    return this.store.withLock(async (): Promise<HoldResult | Decision> => {
      await this.store.expireHolds();

      // Session must not be holding a different main slot on the same date
      const session = await this.store.getSession(sessionId);
      if (session?.selected_slot && session.selected_slot !== slotType) {
        return {
          status: 'refused', date, slot: slotType, location,
          reason_code: 'session_conflict',
          message: `Session already holds ${session.selected_slot}. Abandon to try another slot.`,
        } as Decision;
      }

      // Resolve sub-slot: use caller's choice or auto-assign earliest feasible
      const subSlots = await this.slotService.getSubSlotAvailability(date, slotType, location, eventTypeId);
      let resolvedSubSlot: string;

      if (subSlotTime) {
        const requested = subSlots.find((s) => s.time === subSlotTime);
        if (!requested) {
          return {
            status: 'refused', date, slot: slotType, location,
            reason_code: 'no_sub_slot_available',
            message: `Sub-slot ${subSlotTime} does not exist for this main slot.`,
          } as Decision;
        }
        if (requested.is_taken) {
          return {
            status: 'refused', date, slot: slotType, location,
            reason_code: 'sub_slot_taken',
            message: `Sub-slot ${subSlotTime} is already booked.`,
          } as Decision;
        }
        if (requested.is_held) {
          const existingHold = await this.store.getActiveHoldForSubSlot(date, slotType, subSlotTime);
          if (existingHold && existingHold.customerId !== customerId) {
            return {
              status: 'refused', date, slot: slotType, location,
              reason_code: 'sub_slot_taken',
              message: `Sub-slot ${subSlotTime} is held by another customer. Try again shortly.`,
            } as Decision;
          }
        }
        if (!requested.is_feasible && !requested.is_held) {
          return {
            status: 'refused', date, slot: slotType, location,
            reason_code: 'route_over_budget',
            message: `Your location cannot be reached in time for the ${subSlotTime} sub-slot.`,
          } as Decision;
        }
        resolvedSubSlot = subSlotTime;
      } else {
        const available = subSlots.find((s) => !s.is_taken && !s.is_held && s.is_feasible);
        if (!available) {
          // Surface the specific reason: out_of_bounds beats generic no_sub_slot_available
          const isOutOfBounds = subSlots.some((s) => s.reason === 'out_of_bounds');
          if (isOutOfBounds) {
            return {
              status: 'refused', date, slot: slotType, location,
              reason_code: 'out_of_bounds',
              message: 'Location is outside the service area.',
            } as Decision;
          }
          const nextBest = await this.slotService.findNextBest(
            location, date, slotType,
            this.slotService.getEventType(eventTypeId).setup_minutes,
          );
          return {
            status: 'refused', date, slot: slotType, location,
            reason_code: 'no_sub_slot_available',
            message: `No sub-slot available for your location in the ${slotType} slot.`,
            suggestions: nextBest ? [{...nextBest, reason: 'Next available slot'}] : [],
          } as Decision;
        }
        resolvedSubSlot = available.time;
      }

      // Release any existing hold this customer has on this main slot (switching sub-slot)
      const existingCustomerHold = (await this.store.getActiveHolds(date, slotType))
        .find((h) => h.customerId === customerId);
      if (existingCustomerHold) {
        await this.store.deleteHold(existingCustomerHold.holdId);
      }

      // Capacity + NN route feasibility (guards against over-booking regardless of sub-slot)
      const availability = await this.checkAvailability(location, date, slotType, eventTypeId);
      if (availability.status === 'refused') return availability;

      const now = new Date();
      const expiresAt = new Date(now.getTime() + HOLD_TTL_MS);
      const holdId = generateId('HOLD');

      const hold: Hold = {
        holdId,
        customerId,
        location,
        date,
        slot: slotType,
        sub_slot_time: resolvedSubSlot,
        eventTypeId,
        session_id: sessionId,
        expiresAt: expiresAt.toISOString(),
      };

      await this.store.createHold(hold);
      await this.store.upsertSession({
        session_id: sessionId,
        expires_at: expiresAt.toISOString(),
        selected_location: location,
        selected_date: date,
        selected_slot: slotType,
      } as SessionLock);

      return {holdId, date, slot: slotType, sub_slot_time: resolvedSubSlot, location, eventTypeId, expiresAt: expiresAt.toISOString()};
    });
  }

  /**
   * Release a hold.
   */
  async releaseHold(holdId: string): Promise<void> {
    await this.store.deleteHold(holdId);
  }

  /**
   * Confirm a booking from a hold (step 2 of checkout).
   * Idempotent: re-confirming same idempotency key returns existing order.
   */
  async confirmBooking(
    holdId: string,
    customerId: string,
    idempotencyKey: string,
    area?: string,
  ): Promise<Decision> {
    return this.store.withLock(async () => {
      await this.store.expireHolds();

      const existing = await this.store.getIdempotency(idempotencyKey);
      if (existing) {
        const order = await this.store.getOrder(existing.orderId);
        if (order) {
          // Release any dangling hold from a retry attempt
          const dangling = await this.store.getHold(holdId);
          if (dangling) await this.store.deleteHold(holdId);
          return {
            status: 'accepted',
            order_id: order.order_id,
            confirmation_id: order.order_id,
            date: order.date,
            slot: order.slot,
            location: order.location,
            reason_code: 'ok',
            message: 'Booking already confirmed (idempotent).',
          };
        }
      }

      const hold = await this.store.getHold(holdId);
      if (!hold) {
        return {
          status: 'refused', date: '', slot: 'afternoon' as SlotType, location: {lat: 0, lng: 0},
          reason_code: 'capacity_locked',
          message: 'Hold expired or not found. Please start a new booking.',
        };
      }

      if (hold.customerId !== customerId) {
        return {
          status: 'refused', date: hold.date, slot: hold.slot as SlotType, location: hold.location,
          reason_code: 'capacity_locked',
          message: 'Hold belongs to a different customer.',
        };
      }

      const slotType = hold.slot as SlotType;
      const max = this.slotService.getCapacity(hold.date);
      const confirmedCount = await this.slotService.getOrderCount(hold.date, slotType);
      const otherHolds = (await this.store.getActiveHolds(hold.date, hold.slot))
        .filter((h) => h.holdId !== holdId);
      if (confirmedCount + otherHolds.length >= max) {
        await this.store.deleteHold(holdId);
        const nextBest = await this.slotService.findNextBest(
          hold.location, hold.date, slotType,
          this.slotService.getEventType(hold.eventTypeId).setup_minutes,
        );
        return {
          status: 'refused', date: hold.date, slot: slotType, location: hold.location,
          reason_code: 'capacity_full',
          message: `${slotType} on ${hold.date} is fully booked.`,
          capacity: {used: confirmedCount + otherHolds.length, max},
          suggestions: nextBest ? [{...nextBest, reason: 'Available slot'}] : [],
        };
      }

      const confirmationId = generateId('TWL');
      const now = new Date();

      const order: Order = {
        order_id: confirmationId,
        customer_id: customerId,
        location: hold.location,
        date: hold.date,
        slot: slotType,
        sub_slot_time: hold.sub_slot_time,
        area: area ?? '',
        event_type_id: hold.eventTypeId,
        status: 'confirmed',
        created_at: now.toISOString(),
      };

      await this.store.createOrder(order);
      await this.store.setIdempotency(idempotencyKey, confirmationId);
      await this.store.deleteHold(holdId);
      if (hold.session_id) await this.store.deleteSession(hold.session_id);

      const eventType = this.slotService.getEventType(hold.eventTypeId);
      const window = this.slotService.getSlotWindow(slotType);
      const rv = this.slotService.getRouteValidator();
      const windowMins = rv.windowDuration(window.window_start, window.must_finish_by);
      const existingStops = await this.slotService.getExistingStops(hold.date, slotType);
      const allStops = [...existingStops, hold.location];
      const routeResult = rv.computeRoute(
        allStops, new Map([[hold.eventTypeId, eventType]]), eventType.setup_minutes,
      );

      return {
        status: 'accepted',
        order_id: confirmationId,
        confirmation_id: confirmationId,
        date: hold.date,
        slot: slotType,
        location: hold.location,
        reason_code: 'ok',
        message: `Delivery confirmed for ${hold.date} ${hold.slot}.`,
        capacity: {
          used: await this.slotService.getOrderCount(hold.date, slotType),
          max: this.slotService.getCapacity(hold.date),
        },
        route: {
          total_minutes: Math.round(routeResult.total_minutes),
          budget_minutes: windowMins,
          sequence: [],
          over_budget: routeResult.total_minutes > windowMins,
        },
      };
    });
  }

}