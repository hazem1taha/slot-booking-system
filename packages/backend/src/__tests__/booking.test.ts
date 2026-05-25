import {describe, it, expect, beforeEach} from 'vitest';
import {InMemoryStore} from '../store/inMemoryStore.js';
import {RouteValidator} from '../services/routeValidator.js';
import {SlotService} from '../services/slotService.js';
import {BookingEngine} from '../services/bookingEngine.js';

// ─── Test config (matches data/config.json) ─────────────────────────────────
const CONFIG = {
  timezone: 'Asia/Riyadh',
  fulfillment_center: {name: 'Warehouse', lat: 24.7136, lng: 46.6753},
  slots: [
    {id: 'afternoon', label: 'Afternoon', window_start: '12:00', window_end: '16:00', must_finish_by: '15:30'},
    {id: 'evening', label: 'Evening', window_start: '16:00', window_end: '20:00', must_finish_by: '19:30'},
  ],
  capacity: {weekday_per_slot: 3, weekend_per_slot: 10},
  weekend_days: ['Friday', 'Saturday'],
  routing: {avg_speed_kmh: 22, setup_minutes_per_stop: 15, route_finish_mode: 'return_to_fc'},
  event_types: [
    {id: 'balloon_arch', label: 'Balloon Arch', setup_minutes: 10},
    {id: 'backdrop', label: 'Themed Backdrop', setup_minutes: 25},
    {id: 'full_setup', label: 'Full Themed Setup', setup_minutes: 45},
    {id: 'default', label: 'Standard', setup_minutes: 15},
  ],
  bounds: {north: 24.85, south: 24.55, east: 46.90, west: 46.45},
};

const DEPOT = {lat: 24.7136, lng: 46.6753};
const MALQA   = {lat: 24.7655, lng: 46.6378};   // north Riyadh
const NARJIS  = {lat: 24.7399, lng: 46.6177};  // south-central
const SUWAIDI = {lat: 24.7153, lng: 46.6202};  // very close to depot (~5.6 km away)
const OLAYA   = {lat: 24.7740, lng: 46.6848};  // north-east
const FAR_SE  = {lat: 24.57, lng: 46.87};      // far SE corner — in-bounds but distant
const NAMAR   = {lat: 24.4337, lng: 46.5202};  // OUT of bounds (south of 24.55)

function makeOrder(orderId: string, customerId: string, location: any, slot: 'afternoon' | 'evening', eventTypeId = 'default') {
  return {
    order_id: orderId,
    customer_id: customerId,
    location,
    date: '2026-05-26',
    slot,
    area: '',
    event_type_id: eventTypeId,
    status: 'confirmed' as const,
    created_at: new Date().toISOString(),
  };
}

// ─── RouteValidator ─────────────────────────────────────────────────────────
describe('RouteValidator', () => {
  const rv = new RouteValidator(DEPOT, CONFIG.bounds, CONFIG.routing);

  it('isInBounds: accepts depot and nearby points', () => {
    expect(rv.isInBounds(DEPOT)).toBe(true);
    expect(rv.isInBounds(MALQA)).toBe(true);
    expect(rv.isInBounds(SUWAIDI)).toBe(true);
  });

  it('isInBounds: accepts FAR_SE (lat 24.57 > south 24.55)', () => {
    expect(rv.isInBounds(FAR_SE)).toBe(true);
  });

  it('isInBounds: rejects NAMAR (lat 24.43 < south 24.55)', () => {
    expect(rv.isInBounds(NAMAR)).toBe(false);
  });

  it('computeRouteTime: empty = 0', () => {
    expect(rv.computeRouteTime([], 15)).toBe(0);
  });

  it('computeRouteTime: MALQA alone ≈ 53 min (round-trip, 15 min setup)', () => {
    // depot→MALQA (6.9 km) + MALQA→depot (6.9 km) + 15 min setup = ~53 min
    const t = rv.computeRouteTime([MALQA], 15);
    expect(t).toBeGreaterThan(45);
    expect(t).toBeLessThan(90);
  });

  it('computeRouteTime: SUWAIDI alone ≈ 45 min (very close to depot)', () => {
    const t = rv.computeRouteTime([SUWAIDI], 15);
    expect(t).toBeLessThan(60);
  });

  it('computeRouteTime: MALQA+SUWAIDI (2-stop) ≈ 80 min', () => {
    const t = rv.computeRouteTime([MALQA, SUWAIDI], 15);
    expect(t).toBeGreaterThan(70);
    expect(t).toBeLessThan(95);
  });

  it('computeRouteTime: MALQA+NARJIS+SUWAIDI (3 near stops) ≈ 96 min — FEASIBLE', () => {
    const t = rv.computeRouteTime([MALQA, NARJIS, SUWAIDI], 15);
    expect(t).toBeGreaterThan(90);
    expect(t).toBeLessThan(110);
    expect(t).toBeLessThan(210); // under budget
  });

  it('computeRouteTime: MALQA+NARJIS+FAR_SE (3rd is far SE) ≈ 229 min — EXCEEDS 210', () => {
    // depot→Narjis→Malqa→FAR_SE→depot ≈ 229 min with round-trip
    const t = rv.computeRouteTime([MALQA, NARJIS, FAR_SE], 15);
    expect(t).toBeGreaterThan(210);
  });

  it('canAddStop: SUWAIDI on empty slot is feasible', () => {
    const r = rv.canAddStop(SUWAIDI, [], 210, 15);
    expect(r.feasible).toBe(true);
  });

  it('canAddStop: FAR_SE added to [MALQA, NARJIS] → route_over_budget', () => {
    const r = rv.canAddStop(FAR_SE, [MALQA, NARJIS], 210, 15);
    expect(r.feasible).toBe(false);
    expect(r.reason).toBe('route_over_budget');
  });

  it('canAddStop: NAMAR is out_of_bounds even on empty slot', () => {
    const r = rv.canAddStop(NAMAR, [], 210, 15);
    expect(r.feasible).toBe(false);
    expect(r.reason).toBe('out_of_bounds');
  });

  it('buildRoute: nearest-neighbour orders by distance from current position', () => {
    const route = rv.buildRoute([MALQA, NARJIS, FAR_SE]);
    // First stop should be closest to depot (Suwaidi-ish), not FAR_SE
    expect(rv.distanceMeters(DEPOT, route[0])).toBeLessThan(rv.distanceMeters(DEPOT, FAR_SE));
  });
});

describe('RouteValidator — round-trip vs last-stop', () => {
  const rt = new RouteValidator(DEPOT, CONFIG.bounds, {...CONFIG.routing, route_finish_mode: 'return_to_fc'});
  const ls = new RouteValidator(DEPOT, CONFIG.bounds, {...CONFIG.routing, route_finish_mode: 'last_stop'});

  it('round-trip adds return leg (longer than last-stop)', () => {
    expect(rt.computeRouteTime([MALQA, NARJIS], 15)).toBeGreaterThan(ls.computeRouteTime([MALQA, NARJIS], 15));
  });

  it('3-stop route exceeding 210 in round-trip may be feasible in last-stop', () => {
    expect(rt.computeRouteTime([MALQA, NARJIS, FAR_SE], 15)).toBeGreaterThan(210);
    expect(ls.computeRouteTime([MALQA, NARJIS, FAR_SE], 15)).toBeLessThan(210);
  });
});

// ─── SlotService ─────────────────────────────────────────────────────────────
describe('SlotService', () => {
  let store: InMemoryStore;
  let ss: SlotService;

  beforeEach(() => {
    store = new InMemoryStore();
    ss = new SlotService(store, CONFIG, DEPOT);
  });

  it('weekday cap = 3, weekend cap = 10', () => {
    expect(ss.getCapacity('2026-05-26')).toBe(3);  // Tuesday
    expect(ss.getCapacity('2026-05-22')).toBe(10); // Friday
  });

  it('both slots returned', async () => {
    const avail = await ss.getSlotAvailability('2026-05-26');
    expect(avail).toHaveLength(2);
    expect(avail.map(s => s.slot.id)).toEqual(['afternoon', 'evening']);
  });

  it('remaining_capacity decrements', async () => {
    await store.createOrder(makeOrder('ORD-1', 'C1', MALQA, 'afternoon'));
    await store.createOrder(makeOrder('ORD-2', 'C2', NARJIS, 'afternoon'));
    const avail = await ss.getSlotAvailability('2026-05-26');
    const aft = avail.find(s => s.slot.id === 'afternoon')!;
    expect(aft.current_load).toBe(2);
    expect(aft.remaining_capacity).toBe(1);
  });

  it('full slot is not bookable', async () => {
    for (let i = 0; i < 3; i++) {
      await store.createOrder(makeOrder(`ORD-${i}`, `C${i}`, {lat: 24.75 + i * 0.005, lng: 46.70}, 'afternoon'));
    }
    const avail = await ss.getSlotAvailability('2026-05-26');
    const aft = avail.find(s => s.slot.id === 'afternoon')!;
    expect(aft.is_bookable).toBe(false);
    expect(aft.remaining_capacity).toBe(0);
  });

  it('NAMAR (out-of-bounds) is not routable', async () => {
    const r = await ss.isRoutable(NAMAR, 'afternoon', '2026-05-26', 15);
    expect(r.routable).toBe(false);
    expect(r.reason).toBe('out_of_bounds');
  });

  it('FAR_SE with 2 existing stops → route_over_budget', async () => {
    await store.createOrder(makeOrder('ORD-1', 'C1', MALQA, 'afternoon'));
    await store.createOrder(makeOrder('ORD-2', 'C2', NARJIS, 'afternoon'));
    const r = await ss.isRoutable(FAR_SE, 'afternoon', '2026-05-26', 15);
    expect(r.routable).toBe(false);
    expect(r.reason).toBe('route_over_budget');
  });
});

// ─── BookingEngine — accept/refuse boundary ───────────────────────────────────
describe('BookingEngine', () => {
  let store: InMemoryStore;
  let ss: SlotService;
  let be: BookingEngine;

  beforeEach(() => {
    store = new InMemoryStore();
    ss = new SlotService(store, CONFIG, DEPOT);
    be = new BookingEngine(ss, store);
  });

  it('accepts a valid booking', async () => {
    const d = await be.decide('sess-1', 'cust-1', MALQA, '2026-05-26', 'afternoon');
    expect(d.status).toBe('accepted');
    expect(d.confirmation_id).toMatch(/^TWL-/);
    expect(d.reason_code).toBe('ok');
  });

  it('NAMAR (out-of-bounds) → out_of_bounds', async () => {
    const d = await be.decide('sess-1', 'cust-1', NAMAR, '2026-05-26', 'afternoon');
    expect(d.status).toBe('refused');
    expect(d.reason_code).toBe('out_of_bounds');
  });

  it('full slot → capacity_full, nextBest is same slot next available date', async () => {
    for (let i = 0; i < 3; i++) {
      await store.createOrder(makeOrder(`ORD-${i}`, `C${i}`, {lat: 24.75 + i * 0.005, lng: 46.70}, 'afternoon'));
    }
    const d = await be.decide('sess-1', 'cust-1', MALQA, '2026-05-26', 'afternoon');
    expect(d.status).toBe('refused');
    expect(d.reason_code).toBe('capacity_full');
    // nextBest = same afternoon slot on next available date (2026-05-22, Friday)
    expect(d.suggestions?.[0]?.slot).toBe('afternoon');
    expect(d.suggestions?.[0]?.date).toBe('2026-05-22'); // next Friday
  });

  it('[KEY TEST] FAR_SE with 2 existing stops (capacity=1 open) → refused on geography', async () => {
    // Seed 2 stops (capacity still 1 open), but FAR_SE makes route = 229 min > 210
    await store.createOrder(makeOrder('ORD-1', 'C1', MALQA, 'afternoon'));
    await store.createOrder(makeOrder('ORD-2', 'C2', NARJIS, 'afternoon'));
    const capBefore = await ss.getCapacityRemaining('2026-05-26', 'afternoon');
    expect(capBefore).toBe(1); // 1 seat still open!
    const d = await be.decide('sess-3', 'cust-3', FAR_SE, '2026-05-26', 'afternoon');
    expect(d.status).toBe('refused');
    expect(d.reason_code).toBe('route_over_budget');
    expect(d.route?.over_budget).toBe(true);
  });

  it('idempotent: re-submit same session+slot → accepted', async () => {
    const d1 = await be.decide('sess-1', 'cust-1', MALQA, '2026-05-26', 'afternoon');
    const d2 = await be.decide('sess-1', 'cust-1', MALQA, '2026-05-26', 'afternoon');
    expect(d1.status).toBe('accepted');
    expect(d2.status).toBe('accepted');
  });

  it('session conflict: trying evening while holding afternoon', async () => {
    await be.createHold('sess-1', 'cust-1', MALQA, '2026-05-26', 'afternoon', 'default');
    const d = await be.createHold('sess-1', 'cust-1', OLAYA, '2026-05-26', 'evening', 'default');
    expect(d.status).toBe('refused');
    expect((d as any).reason_code).toBe('session_conflict');
  });

  it('two customers auto-get different sub-slots — both succeed', async () => {
    // MALQA and NARJIS both get auto-assigned to their earliest feasible sub-slot.
    // With sub-slot exclusivity, second customer skips to the next available window.
    const a = await be.createHold('sess-a', 'cust-a', MALQA, '2026-05-26', 'afternoon', 'default');
    expect(a).toHaveProperty('holdId');

    const b = await be.createHold('sess-b', 'cust-b', NARJIS, '2026-05-26', 'afternoon', 'default');
    expect(b).toHaveProperty('holdId');

    // They must occupy different sub-slots
    const aTime = (a as any).sub_slot_time;
    const bTime = (b as any).sub_slot_time;
    expect(aTime).toBeTruthy();
    expect(bTime).toBeTruthy();
    expect(aTime).not.toEqual(bTime);
  });

  it('explicitly requesting a held sub-slot → sub_slot_taken', async () => {
    // A grabs the earliest feasible sub-slot for MALQA
    const a = await be.createHold('sess-a', 'cust-a', MALQA, '2026-05-26', 'afternoon', 'default') as any;
    expect(a).toHaveProperty('holdId');
    const takenTime = a.sub_slot_time as string;

    // B explicitly requests the same sub-slot → refused
    const b = await be.createHold('sess-b', 'cust-b', NARJIS, '2026-05-26', 'afternoon', 'default', takenTime);
    expect(b).toMatchObject({status: 'refused', reason_code: 'sub_slot_taken'});
  });

  it('second customer can book after the first releases their sub-slot', async () => {
    const a = (await be.createHold('sess-a', 'cust-a', MALQA, '2026-05-26', 'afternoon', 'default')) as any;
    const aTime = a.sub_slot_time as string;
    await be.releaseHold(a.holdId);

    // B can now claim the released sub-slot
    const b = (await be.createHold('sess-b', 'cust-b', NARJIS, '2026-05-26', 'afternoon', 'default', aTime)) as any;
    expect(b).toHaveProperty('holdId');
  });

  it('concurrent holds for the last confirmed-capacity seat: exactly one succeeds', async () => {
    await store.createOrder(makeOrder('ORD-1', 'C1', MALQA, 'afternoon'));
    await store.createOrder(makeOrder('ORD-2', 'C2', NARJIS, 'afternoon'));
    // 2 confirmed orders, cap = 3 → 1 slot remaining

    const results = await Promise.all([
      be.createHold('sess-a', 'cust-a', SUWAIDI, '2026-05-26', 'afternoon', 'default'),
      be.createHold('sess-b', 'cust-b', OLAYA, '2026-05-26', 'afternoon', 'default'),
    ]);

    const successes = results.filter((r) => 'holdId' in r);
    const refused = results.filter((r) => 'status' in r && (r as any).status === 'refused');
    expect(successes).toHaveLength(1);
    expect(refused).toHaveLength(1);
    // Second racer fails on capacity (confirmed + active hold = 3 >= cap)
    expect(refused[0]).toMatchObject({reason_code: 'capacity_full'});
  });
});

// ─── Dynamic setup time (section 5) ────────────────────────────────────────
describe('Dynamic setup time per event type', () => {
  let store: InMemoryStore;
  let ss: SlotService;
  let be: BookingEngine;

  beforeEach(() => {
    store = new InMemoryStore();
    ss = new SlotService(store, CONFIG, DEPOT);
    be = new BookingEngine(ss, store);
  });

  it('3× balloon_arch (10 min): 3-stop route is feasible', async () => {
    await store.createOrder(makeOrder('ORD-1', 'C1', MALQA, 'afternoon', 'balloon_arch'));
    await store.createOrder(makeOrder('ORD-2', 'C2', NARJIS, 'afternoon', 'balloon_arch'));
    const d = await be.decide('sess-3', 'cust-3', SUWAIDI, '2026-05-26', 'afternoon', 'balloon_arch');
    expect(d.status).toBe('accepted');
  });

  it('3× full_setup (45 min) with FAR_SE: route = 319 min >> 210 → refused', async () => {
    // 3 × 45 = 135 min setup alone + driving ≈ 319 min total
    await store.createOrder(makeOrder('ORD-1', 'C1', MALQA, 'afternoon', 'full_setup'));
    await store.createOrder(makeOrder('ORD-2', 'C2', NARJIS, 'afternoon', 'full_setup'));
    const d = await be.decide('sess-3', 'cust-3', FAR_SE, '2026-05-26', 'afternoon', 'full_setup');
    expect(d.status).toBe('refused');
    expect(d.reason_code).toBe('route_over_budget');
    // But capacity is still open (1 seat remaining)
    const cap = await ss.getCapacityRemaining('2026-05-26', 'afternoon');
    expect(cap).toBe(1);
  });

  it('3× full_setup (45 min) with nearby SUWAIDI: route = 186 min < 210 → accepted', async () => {
    await store.createOrder(makeOrder('ORD-1', 'C1', MALQA, 'afternoon', 'full_setup'));
    await store.createOrder(makeOrder('ORD-2', 'C2', NARJIS, 'afternoon', 'full_setup'));
    const d = await be.decide('sess-3', 'cust-3', SUWAIDI, '2026-05-26', 'afternoon', 'full_setup');
    expect(d.status).toBe('accepted');
  });

  it('accepted route response includes total_minutes reflecting event type setup', async () => {
    const dBalloon = await be.decide('sess-1', 'cust-1', NARJIS, '2026-05-26', 'afternoon', 'balloon_arch');
    const dFull = await be.decide('sess-2', 'cust-2', NARJIS, '2026-05-26', 'evening', 'full_setup');
    if (dBalloon.status === 'accepted' && dFull.status === 'accepted') {
      expect(dFull.route!.total_minutes).toBeGreaterThan(dBalloon.route!.total_minutes);
    }
  });
});