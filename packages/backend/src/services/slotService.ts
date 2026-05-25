import type {
  GeoPoint,
  SlotType,
  SlotWindow,
  SlotAvailability,
  SubSlotInfo,
  Config,
  Order,
  EventType,
} from '@slot/shared';
import {InMemoryStore} from '../store/inMemoryStore.js';
import {RouteValidator} from './routeValidator.js';
import {
  getEventType,
  getCapacityForDate,
  isWeekend,
} from '@slot/shared';

export class SlotService {
  private readonly rv: RouteValidator;
  private readonly eventTypes: EventType[];

  constructor(
    private readonly store: InMemoryStore,
    private readonly config: Config,
    depot: GeoPoint,
  ) {
    this.rv = new RouteValidator(depot, config.bounds, config.routing);
    this.eventTypes = config.event_types;
  }

  getRouteValidator(): RouteValidator {
    return this.rv;
  }

  getConfig(): Config {
    return this.config;
  }

  getSlots(): SlotWindow[] {
    return this.config.slots;
  }

  getSlotWindow(slotType: SlotType): SlotWindow {
    return this.config.slots.find((s) => s.id === slotType)!;
  }

  getCapacity(dateStr: string): number {
    return getCapacityForDate(this.config, dateStr);
  }

  getDayType(dateStr: string): 'weekday' | 'weekend' {
    return isWeekend(dateStr, this.config) ? 'weekend' : 'weekday';
  }

  getEventType(eventTypeId: string): EventType {
    return getEventType(this.config, eventTypeId);
  }

  async getOrderCount(dateStr: string, slot: SlotType): Promise<number> {
    const orders = await this.store.getOrders({date: dateStr, slot, status: 'confirmed'});
    return orders.length;
  }

  async getExistingOrders(dateStr: string, slot: SlotType): Promise<Order[]> {
    return this.store.getOrders({date: dateStr, slot, status: 'confirmed'});
  }

  async getExistingStops(dateStr: string, slot: SlotType): Promise<GeoPoint[]> {
    const orders = await this.getExistingOrders(dateStr, slot);
    return orders.map((o) => o.location);
  }

  async isRoutable(
    location: GeoPoint,
    slotType: SlotType,
    dateStr: string,
    setupMinsPerStop: number,
  ): Promise<{routable: boolean; reason?: string; route_time?: number}> {
    const window = this.getSlotWindow(slotType);
    const windowMins = this.rv.windowDuration(window.window_start, window.must_finish_by);
    const existingStops = await this.getExistingStops(dateStr, slotType);
    const result = this.rv.canAddStop(location, existingStops, windowMins, setupMinsPerStop);
    return {routable: result.feasible, reason: result.reason, route_time: result.route_time};
  }

  async getCapacityRemaining(dateStr: string, slot: SlotType): Promise<number> {
    const max = this.getCapacity(dateStr);
    const current = await this.getOrderCount(dateStr, slot);
    return Math.max(0, max - current);
  }

  async getSlotAvailability(
    dateStr: string,
    location?: GeoPoint,
    eventTypeId?: string,
  ): Promise<SlotAvailability[]> {
    const results: SlotAvailability[] = [];
    const max = this.getCapacity(dateStr);
    const dayType = this.getDayType(dateStr);

    for (const window of this.config.slots) {
      const slotType = window.id as SlotType;
      const currentLoad = await this.getOrderCount(dateStr, slotType);
      const remaining = Math.max(0, max - currentLoad);
      let isBookable = remaining > 0;

      const existingStops = await this.getExistingStops(dateStr, slotType);
      const setupMins = eventTypeId
        ? this.getEventType(eventTypeId).setup_minutes
        : this.config.routing.setup_minutes_per_stop;

      let isRoutable = true;
      let reason: string | undefined;
      if (location) {
        const check = this.rv.canAddStop(
          location,
          existingStops,
          this.rv.windowDuration(window.window_start, window.must_finish_by),
          setupMins,
        );
        isRoutable = check.feasible;
        reason = check.reason;
      }

      results.push({
        slot: window,
        day_type: dayType,
        date: dateStr,
        remaining_capacity: remaining,
        is_bookable: isBookable,
        current_load: currentLoad,
        is_routable: isRoutable,
        reason,
      });
    }

    return results;
  }

  /**
   * Return sub-slot availability for a given (date, mainSlot, location, eventType).
   * Each sub-slot is a 30-min window; at most one booking per sub-slot.
   */
  async getSubSlotAvailability(
    dateStr: string,
    mainSlot: SlotType,
    location?: GeoPoint,
    eventTypeId?: string,
  ): Promise<SubSlotInfo[]> {
    const window = this.getSlotWindow(mainSlot);
    const budgetMins = this.rv.windowDuration(window.window_start, window.must_finish_by);
    const subSlots = this.rv.generateSubSlots(window.window_start, window.must_finish_by);
    const existingOrders = await this.getExistingOrders(dateStr, mainSlot);
    const setupMins = eventTypeId
      ? this.getEventType(eventTypeId).setup_minutes
      : this.config.routing.setup_minutes_per_stop;

    // Build time-ordered constraints from confirmed orders that have sub_slot_time
    const windowStartMins = this.rv.hhmmToMins(window.window_start);
    const existingSubSlotOrders = existingOrders
      .filter((o) => o.sub_slot_time)
      .map((o) => ({
        location: o.location,
        sub_slot_mins: this.rv.hhmmToMins(o.sub_slot_time!) - windowStartMins,
        setup_mins: this.getEventType(o.event_type_id).setup_minutes,
      }));

    const results: SubSlotInfo[] = [];

    for (const ss of subSlots) {
      const takenOrder = existingOrders.find((o) => o.sub_slot_time === ss.time);
      const activeHold = await this.store.getActiveHoldForSubSlot(dateStr, mainSlot, ss.time);

      let isFeasible = false;
      let reason: string | undefined;

      if (!takenOrder && !activeHold) {
        if (location) {
          const check = this.rv.canAddAtSubSlot(
            location, ss.minutes, setupMins, existingSubSlotOrders, budgetMins,
          );
          isFeasible = check.feasible;
          reason = check.reason;
        } else {
          isFeasible = true; // No location yet — just show structural availability
        }
      }

      results.push({
        time: ss.time,
        minutes_from_start: ss.minutes,
        is_taken: !!takenOrder,
        is_held: !!activeHold,
        is_feasible: isFeasible,
        order_id: takenOrder?.order_id,
        reason,
      });
    }

    return results;
  }

  async findNextBest(
    location: GeoPoint,
    preferredDate: string,
    preferredSlot: SlotType,
    setupMinsPerStop: number,
  ): Promise<{date: string; slot: SlotType; remaining_capacity: number; is_routable: boolean} | null> {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    for (let dayOffset = 0; dayOffset <= 14; dayOffset++) {
      const candidate = new Date(today);
      candidate.setDate(candidate.getDate() + dayOffset);
      const dateStr = candidate.toISOString().split('T')[0];

      const avail = await this.getSlotAvailability(dateStr, location);

      const preferred = avail.find((a) => a.slot.id === preferredSlot);
      if (preferred && preferred.is_bookable && preferred.is_routable) {
        return {
          date: dateStr,
          slot: preferredSlot,
          remaining_capacity: preferred.remaining_capacity,
          is_routable: true,
        };
      }

      const other = avail.find((a) => a.slot.id !== preferredSlot);
      if (other && other.is_bookable && other.is_routable) {
        return {
          date: dateStr,
          slot: other.slot.id as SlotType,
          remaining_capacity: other.remaining_capacity,
          is_routable: other.is_routable,
        };
      }
    }

    return null;
  }
}