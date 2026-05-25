// Shared domain types for Slot Booking Service

export interface LatLng {
  lat: number;
  lng: number;
}

export interface GeoPoint {
  lat: number;
  lng: number;
  address?: string;
}

export type SlotType = 'afternoon' | 'evening';
export type DayType = 'weekday' | 'weekend';
export type DecisionOutcome = 'accepted' | 'refused';
export type OrderStatus = 'pending' | 'confirmed' | 'cancelled' | 'completed';

export type RefusalReasonCode =
  | 'ok'
  | 'no_morning_slot'
  | 'capacity_full'
  | 'route_over_budget'
  | 'date_in_past'
  | 'out_of_bounds'
  | 'capacity_locked'
  | 'session_conflict'
  | 'slot_held'
  | 'sub_slot_taken'
  | 'no_sub_slot_available';

// ─── Config ────────────────────────────────────────────────────────────────

export interface SlotWindow {
  id: 'afternoon' | 'evening';
  label: string;
  window_start: string; // "12:00"
  window_end: string;   // "16:00"
  must_finish_by: string; // "15:30"
}

export interface EventType {
  id: string;
  label: string;
  setup_minutes: number;
}

export interface RouteConfig {
  avg_speed_kmh: number;
  setup_minutes_per_stop: number; // fallback when event type unknown
  route_finish_mode: 'return_to_fc' | 'last_stop';
}

export interface Config {
  timezone: string;
  fulfillment_center: GeoPoint & { name: string };
  slots: SlotWindow[];
  capacity: {
    weekday_per_slot: number;
    weekend_per_slot: number;
  };
  weekend_days: string[]; // ["Friday", "Saturday"]
  routing: RouteConfig;
  event_types: EventType[];
  bounds: {
    north: number;
    south: number;
    east: number;
    west: number;
  };
}

// ─── Domain ───────────────────────────────────────────────────────────────

export interface Order {
  order_id: string;
  customer_id: string;
  date: string; // "2026-05-26"
  slot: SlotType;
  sub_slot_time?: string; // "12:30" — committed 30-min delivery window
  area: string;
  location: GeoPoint;
  event_type_id: string;
  status: OrderStatus;
  created_at: string; // ISO
}

// A 30-minute delivery window within a main slot (e.g. 12:00, 12:30, …)
export interface SubSlotInfo {
  time: string;               // "12:00"
  minutes_from_start: number; // minutes from window_start
  is_taken: boolean;          // confirmed order occupies this sub-slot
  is_held: boolean;           // active hold occupies this sub-slot
  is_feasible: boolean;       // route allows crew to reach this location in time
  order_id?: string;
  reason?: string;
}

export interface SessionLock {
  session_id: string;
  expires_at: string;
  selected_location?: GeoPoint;
  selected_date?: string;
  selected_slot?: SlotType;
}

export interface CapacityLock {
  order_id: string;
  customer_id: string;
  slot: SlotType;
  date: string;
  expires_at: string;
}

// ─── Availability ─────────────────────────────────────────────────────────

export interface SlotAvailability {
  slot: SlotWindow;
  day_type: DayType;
  date: string;
  remaining_capacity: number;
  is_bookable: boolean;
  current_load: number;
  is_routable: boolean;
  reason?: string;
}

// ─── Decision ─────────────────────────────────────────────────────────────

export interface RouteStop {
  order_id: string;
  location: GeoPoint;
  eta_mins: number;
  travel_time_mins: number;
  setup_mins: number;
}

export interface Decision {
  status: DecisionOutcome;
  order_id?: string;
  confirmation_id?: string;
  date: string;
  slot: SlotType;
  location: GeoPoint;
  reason_code?: RefusalReasonCode;
  message?: string;
  capacity?: { used: number; max: number };
  route?: {
    total_minutes: number;
    budget_minutes: number;
    sequence: RouteStop[];
    over_budget: boolean;
  };
  suggestions?: Suggestion[];
}

export interface Suggestion {
  date: string;
  slot: SlotType;
  remaining_capacity: number;
  is_routable: boolean;
  reason?: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────

export function getDefaultEventType(config: Config): EventType {
  return config.event_types.find((e) => e.id === 'default') ?? {
    id: 'default',
    label: 'Standard',
    setup_minutes: config.routing.setup_minutes_per_stop,
  };
}

export function getEventType(config: Config, eventTypeId: string): EventType {
  return config.event_types.find((e) => e.id === eventTypeId) ?? getDefaultEventType(config);
}

export function isWeekend(dateStr: string, config: Config): boolean {
  const date = new Date(dateStr + 'T12:00:00');
  const dayName = date.toLocaleDateString('en-US', {weekday: 'long'});
  return config.weekend_days.includes(dayName);
}

export function getCapacityForDate(config: Config, dateStr: string): number {
  return isWeekend(dateStr, config)
    ? config.capacity.weekend_per_slot
    : config.capacity.weekday_per_slot;
}