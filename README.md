# Delivery Slot & Capacity Service

## Core idea

Late deliveries are bad. Every decision in this service defaults toward protecting on-time delivery. A clean "no" with a better alternative is a feature, not a failure.

---

## Project structure

```
slot-booking-system/
├── packages/
│   ├── shared/     # Shared domain types (Config, Order, Decision, etc.)
│   ├── backend/    # Fastify API — slot availability + booking engine
│   └── frontend/   # Vite + React — booking flow + map
├── data/
│   ├── config.json    # Capacity rules, slot windows, routing constants, event types
│   └── bookings.json  # Persisted confirmed orders
└── README.md
```

---

## How route finish time works

`must_finish_by` means **truck back at the fulfillment center, ready to reload** — not just last setup complete. The same crew handles both slots; the truck has to return to FC before the evening run can start. Measuring to "back at FC" is the honest constraint. Without it, the route budget never fires and geography-aware refusals stop working.

You can change this behavior via `routing.route_finish_mode` in `config.json`:

- `"return_to_fc"` (default) — round-trip; truck must be back at FC by `must_finish_by`
- `"last_stop"` — one-way; budget ends when the last setup finishes

## Event types and setup time

Each order has an `event_type_id`. Setup time per stop comes from the event type, not a global constant. Three `full_setup` orders (45 min each) blow through a slot's time budget where three `balloon_arch` orders (10 min each) would not — same order count, completely different outcome.

| Event Type | Setup Time |
|-----------|-----------|
| Balloon Arch | 10 min |
| Standard | 15 min |
| Themed Backdrop | 25 min |
| Baby Shower Package | 30 min |
| Full Themed Setup | 45 min |

---

## Tech stack

| Layer | Tech |
|-------|------|
| Backend | TypeScript + Node.js + Fastify |
| Frontend | TypeScript + React + Vite |
| Map | Leaflet + OpenStreetMap (no API key) |
| Persistence | JSON file store (`data/`) |
| Types | Shared package (`@slot/shared`) |

---

## Getting started

Requires Node.js 20+.

```bash
# Install all workspace packages
npm install

# Build shared types first (backend and frontend depend on this)
npm run build --workspace=@slot/shared

# Start backend on port 3001
npm run dev --workspace=@slot/backend

# Start frontend on port 5173 (separate terminal)
npm run dev --workspace=@slot/frontend
```

Open `http://localhost:5173` for the booking UI.

---

## API

Base URL: `http://localhost:3001`

### `GET /availability`

Returns both delivery slots for a given date, with remaining capacity and route feasibility for a specific customer location.

**Query parameters**

| Param | Required | Description |
|-------|----------|-------------|
| `date` | Yes | `YYYY-MM-DD` |
| `lat` | No | Customer latitude |
| `lng` | No | Customer longitude |
| `event_type_id` | No | Event type (default: `"default"`) |

**Example request**

```bash
curl "http://localhost:3001/availability?date=2026-05-26&lat=24.7655&lng=46.6378&event_type_id=balloon_arch"
```

**Example response**

```json
{
  "date": "2026-05-26",
  "slots": [
    {
      "slot": {
        "id": "afternoon",
        "label": "Afternoon",
        "window_start": "12:00",
        "window_end": "16:00",
        "must_finish_by": "15:30"
      },
      "day_type": "weekday",
      "date": "2026-05-26",
      "remaining_capacity": 2,
      "is_bookable": true,
      "current_load": 1,
      "is_routable": true,
      "route_feasible": true,
      "route_reason": "ok"
    },
    {
      "slot": {
        "id": "evening",
        "label": "Evening",
        "window_start": "16:00",
        "window_end": "20:00",
        "must_finish_by": "19:30"
      },
      "day_type": "weekday",
      "date": "2026-05-26",
      "remaining_capacity": 3,
      "is_bookable": true,
      "current_load": 0,
      "is_routable": true,
      "route_feasible": true,
      "route_reason": "ok"
    }
  ]
}
```

When `is_bookable: false`, check `route_reason` for the specific reason code — e.g. `"capacity_full"` or `"route_over_budget"`.

---

### `POST /bookings`

Confirms a booking from an existing hold. This is step two of the two-step flow: first get a hold via `POST /holds`, then confirm it here.

**Headers**

| Header | Required | Description |
|--------|----------|-------------|
| `Idempotency-Key` | No | Re-submitting the same key returns the existing order instead of double-booking |

**Request body**

```json
{
  "hold_id": "hold-abc123",
  "customer_id": "CUST-001",
  "area": "Al Malqa"
}
```

**Accepted — `200`**

```json
{
  "status": "accepted",
  "order_id": "ORD-1002",
  "confirmation_id": "ORD-1002",
  "date": "2026-05-26",
  "slot": "afternoon",
  "location": { "lat": 24.7655, "lng": 46.6378 },
  "reason_code": "ok",
  "message": "Booking confirmed",
  "capacity": { "used": 2, "max": 3 },
  "route": {
    "total_minutes": 149,
    "budget_minutes": 210,
    "over_budget": false,
    "sequence": [
      {
        "order_id": "ORD-1001",
        "location": { "lat": 24.7655, "lng": 46.6378 },
        "eta_mins": 18,
        "travel_time_mins": 18,
        "setup_mins": 10
      }
    ]
  }
}
```

**Refused — `409`**

```json
{
  "status": "refused",
  "date": "2026-05-26",
  "slot": "afternoon",
  "location": { "lat": 24.68, "lng": 46.59 },
  "reason_code": "route_over_budget",
  "message": "Adding this stop would push the afternoon route to 225 min, exceeding the 210 min budget.",
  "capacity": { "used": 1, "max": 3 },
  "suggestions": [
    {
      "date": "2026-05-26",
      "slot": "evening",
      "remaining_capacity": 3,
      "is_routable": true,
      "reason": "Same day, evening slot available"
    }
  ]
}
```

**Reason codes**

| Code | Meaning |
|------|---------|
| `capacity_full` | Slot has no remaining confirmed capacity |
| `route_over_budget` | Adding this stop exceeds the slot's time budget |
| `out_of_bounds` | Location is outside the configured service area |
| `date_in_past` | Requested date is before today |
| `slot_held` | Slot is held by another active session |
| `duplicate_idempotent` | Same `Idempotency-Key` already confirmed — returns the existing order |

---

### Other endpoints

| Method | Path | Purpose |
|--------|------|---------|
| `POST` | `/holds` | Acquire a provisional hold on a slot before confirming |
| `DELETE` | `/holds/:holdId` | Release a hold (customer abandoned) |
| `GET` | `/sub-slots` | 30-min sub-slot windows within a main slot, with feasibility per window |
| `GET` | `/day-plan?date=&slot=` | Ordered delivery sequence + per-stop ETAs for a slot |
| `GET` | `/orders?date=&slot=` | List confirmed orders (admin/debug) |
| `GET` | `/config` | Full config including event types |

---

## Booking flow

The UI is a sequential, location-first flow.

**1. Location** — the customer drops a pin. This comes first because location is what actually determines slot availability; capacity alone isn't enough. Travel time from the fulfillment center (or from the previous stop in the same slot) is calculated immediately on pin drop.

**2. Event type** — the customer picks their setup type (Balloon Arch, Full Themed Setup, etc.). Each type carries a setup time that feeds into the route budget. Options show their setup duration so the customer can see the operational weight of their choice.

**3. Slot selection** — afternoon and evening slots are shown with remaining capacity and a suggested sub-slot time optimized for route efficiency. The customer can accept the suggestion or pick a different 30-minute window. Each option shows travel time (minutes to drive from the previous stop) and buffer time (how early the crew can arrive; positive means breathing room). Sub-slots that would overlap a confirmed booking are greyed out.

**4. Confirmation** — the backend re-validates the slot in full (capacity + route budget) on submit. A booking that looked fine at step 3 can be refused here if another session claimed the last spot in the interim.

**5. Map** — every confirmed booking appears as a marker, giving a live view of the day's delivery geography.

**A few notes on routing logic:**

The evening slot always routes from the fulfillment center, not from the last afternoon stop. The crew reloads between slots; the truck returns to FC before the evening run starts.

The backend rejects locations outside the bounding box in `config.json` (`bounds.north/south/east/west`) before any routing calculation runs.

---

## What I'd improve next

### Multiple trucks

Right now each slot has one virtual truck and a flat capacity number (3 weekday / 10 weekend). With a real fleet, capacity should scale with truck count:

1. Split confirmed bookings into geographic clusters — one per truck. K-means works; a greedy radial partition (sort stops by bearing from FC, divide into N equal arcs) is simpler and good enough for Riyadh's layout.
2. Run the existing nearest-neighbour route and budget check independently per cluster.
3. Accept a new stop if any truck's cluster can absorb it within budget.
4. Capacity = trucks × feasible load per truck, not a flat ceiling.

A `POST /routes/optimize?date=&slot=` endpoint could trigger this on demand — read all confirmed bookings for the slot, cluster them, compute truck routes, and return assignments with per-stop ETAs. Useful for the ops team before a shift starts.

### Slot reservation with Redis TTL

The current hold uses an in-memory store, which is fine for a single process but won't survive a restart or scale horizontally. The production path:

1. When a customer selects a sub-slot, write a Redis key `hold:{date}:{slot}:{sub_slot_time}:{holdId}` using `SET ... EX 600 NX` — 10-minute TTL, atomic create-if-absent.
2. Use a Lua script (or `MULTI`/`WATCH`) for the check-and-reserve sequence. A plain GET-then-SET is a race condition.
3. The hold expires automatically if the customer doesn't complete the booking. No cleanup job needed.
4. Reset the TTL (`EXPIRE`) on each interaction — the 10 minutes is renewable, not a hard countdown from first click.
5. On confirm, verify the hold still exists before writing the order. If it expired, return `slot_held` and let the customer re-select.

This maps directly to the real business rule: give the customer a window to finish their customization; if they don't, the seat reopens for the next customer.