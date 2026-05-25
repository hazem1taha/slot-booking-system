import Fastify from 'fastify';
import cors from '@fastify/cors';
import {readFileSync} from 'fs';
import {fileURLToPath} from 'url';
import {dirname, join} from 'path';
import {InMemoryStore} from './store/inMemoryStore.js';
import {SlotService} from './services/slotService.js';
import {BookingEngine, HoldResult} from './services/bookingEngine.js';
import type {Config, GeoPoint, SlotType} from '@slot/shared';

function formatTime(windowStart: string, minutesFromStart: number): string {
  const [h, m] = windowStart.split(':').map(Number);
  const totalMins = h * 60 + m + Math.round(minutesFromStart);
  const hh = Math.floor(totalMins / 60) % 24;
  const mm = totalMins % 60;
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const config: Config = JSON.parse(readFileSync(join(__dirname, '../../../data/config.json'), 'utf-8'));
const DEPOT: GeoPoint = {...config.fulfillment_center};

const store = new InMemoryStore();
const slotService = new SlotService(store, config, DEPOT);
const bookingEngine = new BookingEngine(slotService, store);

const server = Fastify({logger: true});
await server.register(cors, {origin: true});

server.get('/health', () => ({status: 'ok', timestamp: new Date().toISOString()}));

// ─── GET /availability ─────────────────────────────────────────────────────
server.get<{Querystring: {date: string; lat?: string; lng?: string; event_type_id?: string}}>(
  '/availability',
  async (req, reply) => {
    const {date, lat, lng, event_type_id = 'default'} = req.query;
    if (!date) return reply.status(400).send({error: 'date is required'});
    const location: GeoPoint | undefined =
      lat && lng ? {lat: parseFloat(lat), lng: parseFloat(lng)} : undefined;
    const avail = await slotService.getSlotAvailability(date, location, event_type_id);

    // Per-slot route feasibility for this specific location
    const results = await Promise.all(
      avail.map(async (s) => {
        if (!location) return {...s, route_feasible: true};
        const r = await slotService.isRoutable(location, s.slot.id as SlotType, date, config.event_types.find(e => e.id === event_type_id)?.setup_minutes ?? config.routing.setup_minutes_per_stop);
        return {...s, route_feasible: r.routable, route_reason: r.reason};
      }),
    );

    return {date, slots: results};
  },
);

// ─── GET /sub-slots ────────────────────────────────────────────────────────
server.get<{
  Querystring: {date: string; main_slot: string; lat?: string; lng?: string; event_type_id?: string};
}>('/sub-slots', async (req, reply) => {
  const {date, main_slot, lat, lng, event_type_id = 'default'} = req.query;
  if (!date || !main_slot) return reply.status(400).send({error: 'date and main_slot are required'});
  const location: GeoPoint | undefined =
    lat && lng ? {lat: parseFloat(lat), lng: parseFloat(lng)} : undefined;
  const subSlots = await slotService.getSubSlotAvailability(
    date, main_slot as SlotType, location, event_type_id,
  );
  const suggested = subSlots.find((s) => !s.is_taken && !s.is_held && s.is_feasible);
  return {date, main_slot, sub_slots: subSlots, suggested: suggested?.time ?? null};
});

// ─── POST /holds ───────────────────────────────────────────────────────────
server.post<{
  Body: {session_id: string; customer_id: string; location: GeoPoint; date: string; slot: SlotType; event_type_id?: string; sub_slot_time?: string};
}>('/holds', async (req, reply) => {
  const {session_id, customer_id, location, date, slot, event_type_id = 'default', sub_slot_time} = req.body;
  if (!session_id || !customer_id || !location || !date || !slot) {
    return reply.status(400).send({error: 'Missing required fields'});
  }
  const result = await bookingEngine.createHold(
    session_id, customer_id, location, date, slot, event_type_id, sub_slot_time,
  );
  if (result && 'reason_code' in result && result.status === 'refused') {
    return reply.status(409).send(result);
  }
  return (result as HoldResult);
});

// ─── POST /bookings ────────────────────────────────────────────────────────
server.post<{
  Body: {hold_id: string; customer_id: string; area?: string};
  Headers: Record<string, string | undefined>;
}>('/bookings', async (req, reply) => {
  const {hold_id, customer_id, area} = req.body;
  const idempotencyKey = req.headers['idempotency-key'] ?? `default-${hold_id}`;
  if (!hold_id || !customer_id) {
    return reply.status(400).send({error: 'Missing hold_id or customer_id'});
  }
  const decision = await bookingEngine.confirmBooking(hold_id, customer_id, idempotencyKey as string, area);
  if (decision.status === 'refused') {
    return reply.status(409).send(decision);
  }
  return decision;
});

// ─── DELETE /holds/:holdId ──────────────────────────────────────────────
server.delete<{Params: {holdId: string}}>('/holds/:holdId', async (req, reply) => {
  await bookingEngine.releaseHold(req.params.holdId);
  return {ok: true};
});

// ─── GET /day-plan ────────────────────────────────────────────────────────
server.get<{Querystring: {date: string; slot: string}}>(
  '/day-plan',
  async (req, reply) => {
    const {date, slot} = req.query;
    if (!date || !slot) return reply.status(400).send({error: 'date and slot are required'});
    const orders = await store.getOrders({date, slot, status: 'confirmed'});
    const rv = slotService.getRouteValidator();
    const window = slotService.getSlotWindow(slot as SlotType);
    const windowMins = rv.windowDuration(window.window_start, window.must_finish_by);
    const stops = orders.map((o) => o.location);
    const route = rv.buildRoute(stops);
    const eventTypesMap = new Map(config.event_types.map((e) => [e.id, e]));
    const avgSetup = config.routing.setup_minutes_per_stop;
    const {total_minutes, sequence} = rv.computeRoute(stops, eventTypesMap, avgSetup);

    const sequenceOut = sequence.map((s, i) => ({
      order_id: orders[i]?.order_id ?? `step-${i}`,
      area: orders[i]?.area ?? '',
      location: s.stop,
      arrive_minute: Math.round(s.eta_mins),
      depart_minute: Math.round(s.eta_mins + s.setup_mins),
      eta_clock: formatTime(window.window_start, s.eta_mins),
      setup_mins: s.setup_mins,
    }));

    return {
      date,
      slot,
      depot: DEPOT,
      route: {
        total_minutes: Math.round(total_minutes),
        budget_minutes: windowMins,
        sequence: sequenceOut,
        over_budget: total_minutes > windowMins,
      },
    };
  },
);

// ─── GET /config ──────────────────────────────────────────────────────────
server.get('/config', () => ({
  ...config,
  routing: {
    ...config.routing,
    checkout_session_seconds: 600,
    route_finish_mode: config.routing.route_finish_mode,
  },
}));

// ─── GET /orders ──────────────────────────────────────────────────────────
server.get<{Querystring: {date?: string; slot?: string; status?: string}}>(
  '/orders',
  async (req, reply) => {
    const orders = await store.getOrders({
      date: req.query.date,
      slot: req.query.slot,
      status: (req.query.status as any) ?? 'confirmed',
    });
    return {orders};
  },
);

// ─── DELETE /orders/:orderId ──────────────────────────────────────────────
server.delete<{Params: {orderId: string}}>('/orders/:orderId', async (req, reply) => {
  const updated = await store.updateOrder(req.params.orderId, {status: 'cancelled'});
  if (!updated) return reply.status(404).send({error: 'Order not found'});
  return {ok: true, order_id: req.params.orderId, status: 'cancelled'};
});

// ─── GET /sessions/:sessionId ─────────────────────────────────────────────
server.get<{Params: {sessionId: string}}>(
  '/sessions/:sessionId',
  async (req, reply) => {
    const session = await store.getSession(req.params.sessionId);
    if (!session) return reply.status(404).send({error: 'Session not found'});
    return session;
  },
);

// ─── DELETE /sessions/:sessionId ─────────────────────────────────────────
server.delete<{Params: {sessionId: string}}>(
  '/sessions/:sessionId',
  async (req, reply) => {
    await store.deleteSession(req.params.sessionId);
    return {ok: true};
  },
);

const PORT = parseInt(process.env.PORT ?? '3001', 10);
const HOST = process.env.HOST ?? '0.0.0.0';
server.listen({port: PORT, host: HOST}, (err, addr) => {
  if (err) { server.log.error(err); process.exit(1); }
  console.log(`🚀 Slot Booking Service → ${addr}`);
});