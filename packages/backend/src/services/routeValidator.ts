import type {GeoPoint, RouteConfig, EventType} from '@slot/shared';

export {RouteConfig};

export class RouteValidator {
  constructor(
    private readonly depot: GeoPoint,
    private readonly bounds: {north: number; south: number; east: number; west: number},
    private readonly config: RouteConfig,
  ) {}

  isInBounds(point: GeoPoint): boolean {
    return (
      point.lat <= this.bounds.north &&
      point.lat >= this.bounds.south &&
      point.lng <= this.bounds.east &&
      point.lng >= this.bounds.west
    );
  }

  distanceMeters(from: GeoPoint, to: GeoPoint): number {
    const R = 6371000;
    const dLat = this.toRad(to.lat - from.lat);
    const dLng = this.toRad(to.lng - from.lng);
    const a =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(this.toRad(from.lat)) *
        Math.cos(this.toRad(to.lat)) *
        Math.sin(dLng / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  travelTimeMins(from: GeoPoint, to: GeoPoint): number {
    const distKm = this.distanceMeters(from, to) / 1000;
    return (distKm / this.config.avg_speed_kmh) * 60;
  }

  /**
   * Nearest-neighbour route from depot.
   */
  buildRoute(stops: GeoPoint[]): GeoPoint[] {
    if (stops.length === 0) return [];
    const route: GeoPoint[] = [];
    const remaining = [...stops];
    let current = this.depot;
    while (remaining.length > 0) {
      let nearestIdx = 0;
      let nearestDist = Infinity;
      for (let i = 0; i < remaining.length; i++) {
        const d = this.distanceMeters(current, remaining[i]);
        if (d < nearestDist) { nearestDist = d; nearestIdx = i; }
      }
      route.push(...remaining.splice(nearestIdx, 1));
      current = route[route.length - 1];
    }
    return route;
  }

  /**
   * Total route time in minutes.
   * Each stop contributes travel_time + setup_minutes.
   * If route_finish_mode = 'return_to_fc', adds return leg to depot.
   */
  computeRouteTime(
    stops: GeoPoint[],
    setupMinutesPerStop: number,
  ): number {
    if (stops.length === 0) return 0;
    const route = this.buildRoute(stops);
    let totalMins = 0;
    let current = this.depot;
    for (const stop of route) {
      totalMins += this.travelTimeMins(current, stop);
      totalMins += setupMinutesPerStop;
      current = stop;
    }
    if (this.config.route_finish_mode === 'return_to_fc') {
      totalMins += this.travelTimeMins(current, this.depot);
    }
    return totalMins;
  }

  /**
   * Per-stop ETAs and route metadata.
   */
  computeRoute(
    stops: GeoPoint[],
    eventTypes: Map<string, EventType>,
    defaultSetupMins: number,
  ): {
    total_minutes: number;
    sequence: {stop: GeoPoint; eta_mins: number; travel_time_mins: number; setup_mins: number}[];
  } {
    if (stops.length === 0) return {total_minutes: 0, sequence: []};
    const route = this.buildRoute(stops);
    const sequence: {stop: GeoPoint; eta_mins: number; travel_time_mins: number; setup_mins: number}[] = [];
    let totalMins = 0;
    let current = this.depot;
    for (const stop of route) {
      const travelMins = this.travelTimeMins(current, stop);
      const setupMins = defaultSetupMins; // per-stop setup varies by order, caller passes avg
      totalMins += travelMins;
      sequence.push({stop, eta_mins: totalMins, travel_time_mins: travelMins, setup_mins: setupMins});
      totalMins += setupMins;
      current = stop;
    }
    if (this.config.route_finish_mode === 'return_to_fc') {
      totalMins += this.travelTimeMins(current, this.depot);
    }
    return {total_minutes: totalMins, sequence};
  }

  /**
   * Check if adding a new stop to existing stops is feasible.
   * Uses the DEFAULT setup time for feasibility check (worst-case).
   * Returns {feasible, reason, route_time}.
   */
  canAddStop(
    location: GeoPoint,
    existingStops: GeoPoint[],
    windowMins: number,
    setupMinutesPerStop?: number,
  ): {feasible: boolean; reason?: string; route_time?: number} {
    if (!this.isInBounds(location)) {
      return {feasible: false, reason: 'out_of_bounds', route_time: undefined};
    }
    const setup = setupMinutesPerStop ?? this.config.setup_minutes_per_stop;
    const allStops = [...existingStops, location];
    const routeTime = this.computeRouteTime(allStops, setup);
    if (routeTime > windowMins) {
      return {feasible: false, reason: 'route_over_budget', route_time: routeTime};
    }
    return {feasible: true, route_time: routeTime};
  }

  windowDuration(windowStart: string, mustFinishBy: string): number {
    return this.hhmmToMins(mustFinishBy) - this.hhmmToMins(windowStart);
  }

  /**
   * Generate 30-minute sub-slot time windows within a main slot.
   * Returns objects with the clock label ("12:30") and minutes-from-window-start.
   */
  generateSubSlots(
    windowStart: string,
    mustFinishBy: string,
    intervalMins = 30,
  ): {time: string; minutes: number}[] {
    const startMins = this.hhmmToMins(windowStart);
    const endMins = this.hhmmToMins(mustFinishBy);
    const slots: {time: string; minutes: number}[] = [];
    for (let m = startMins; m < endMins; m += intervalMins) {
      const h = Math.floor(m / 60);
      const min = m % 60;
      slots.push({
        time: `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`,
        minutes: m - startMins,
      });
    }
    return slots;
  }

  /**
   * Time-ordered feasibility check for sub-slot bookings.
   * Crew leaves depot at minute 0 (window_start). Stops are served in sub-slot order.
   * If crew arrives before the committed time they wait — sub-slot is a firm delivery promise.
   * Returns infeasible if crew cannot reach a stop by its committed time, or total > budget.
   */
  canAddAtSubSlot(
    newLocation: GeoPoint,
    subSlotMins: number,
    newSetupMins: number,
    existingSubSlotOrders: {location: GeoPoint; sub_slot_mins: number; setup_mins: number}[],
    budgetMins: number,
  ): {feasible: boolean; reason?: string} {
    if (!this.isInBounds(newLocation)) {
      return {feasible: false, reason: 'out_of_bounds'};
    }

    const allStops = [
      ...existingSubSlotOrders,
      {location: newLocation, sub_slot_mins: subSlotMins, setup_mins: newSetupMins},
    ].sort((a, b) => a.sub_slot_mins - b.sub_slot_mins);

    let prevLocation = this.depot;
    // prevDeparture is null for the first stop: the crew can leave the depot as early
    // as needed to arrive on time — the slot window is a customer-facing promise, not
    // a crew-departure time. Only inter-stop gaps and the must-finish-by budget are
    // enforced here.
    let prevDeparture: number | null = null;

    for (const stop of allStops) {
      const travel = this.travelTimeMins(prevLocation, stop.location);
      if (prevDeparture !== null) {
        // Crew must reach this stop from the previous stop's departure time
        if (prevDeparture + travel > stop.sub_slot_mins) {
          return {feasible: false, reason: 'route_over_budget'};
        }
      }
      // else: first stop from depot — crew departs depot early enough, no constraint
      prevDeparture = stop.sub_slot_mins + stop.setup_mins;
      prevLocation = stop.location;
    }

    if (prevDeparture === null) return {feasible: true}; // no stops (shouldn't happen)

    // budgetMins = must_finish_by - window_start: last delivery must be DONE by that time.
    // Return-to-depot is a crew concern, not a customer commitment — excluded here.
    if (prevDeparture > budgetMins) {
      return {feasible: false, reason: 'route_over_budget'};
    }

    return {feasible: true};
  }

  private toRad(deg: number): number {
    return (deg * Math.PI) / 180;
  }

  hhmmToMins(hhmm: string): number {
    const [h, m] = hhmm.split(':').map(Number);
    return h * 60 + m;
  }
}