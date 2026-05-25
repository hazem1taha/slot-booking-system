import type {GeoPoint, SlotType, SessionLock, OrderStatus} from '@slot/shared';
export type {GeoPoint, SlotType, SessionLock, OrderStatus};
export interface LatLng { lat: number; lng: number; }
export interface SlotWindow { id: 'afternoon' | 'evening'; label: string; window_start: string; window_end: string; must_finish_by: string; }
export interface EventType { id: string; label: string; setup_minutes: number; }
export interface RouteConfig { avg_speed_kmh: number; setup_minutes_per_stop: number; route_finish_mode: 'return_to_fc' | 'last_stop'; }
export interface Config { timezone: string; fulfillment_center: GeoPoint & {name: string}; slots: SlotWindow[]; capacity: {weekday_per_slot: number; weekend_per_slot: number}; weekend_days: string[]; routing: RouteConfig; event_types: EventType[]; bounds: {north: number; south: number; east: number; west: number}; }
export interface Order { order_id: string; customer_id: string; date: string; slot: SlotType; sub_slot_time?: string; area: string; location: GeoPoint; event_type_id: string; status: OrderStatus; created_at: string; }
export interface SubSlotInfo { time: string; minutes_from_start: number; is_taken: boolean; is_held: boolean; is_feasible: boolean; order_id?: string; reason?: string; }
export interface SlotAvailability { slot: SlotWindow; day_type: 'weekday' | 'weekend'; date: string; remaining_capacity: number; is_bookable: boolean; current_load: number; is_routable: boolean; reason?: string; }
export interface RouteStop { order_id: string; location: GeoPoint; eta_mins: number; travel_time_mins: number; setup_mins: number; }
export interface Decision { status: 'accepted' | 'refused'; order_id?: string; confirmation_id?: string; date: string; slot: SlotType; location: GeoPoint; reason_code?: string; message?: string; capacity?: {used: number; max: number}; route?: {total_minutes: number; budget_minutes: number; sequence: RouteStop[]; over_budget: boolean}; suggestions?: {date: string; slot: SlotType; remaining_capacity: number; is_routable: boolean; reason?: string}[]; }