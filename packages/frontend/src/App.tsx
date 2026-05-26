import {useEffect, useState, useCallback, useRef} from 'react';
import 'leaflet/dist/leaflet.css';
import L from 'leaflet';
import type {GeoPoint, SlotType, SlotAvailability, SubSlotInfo, Decision, EventType} from './types';
import './App.css';

// ─── Leaflet icon fix ────────────────────────────────────────────────────
delete (L.Icon.Default.prototype as any)._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png',
  iconUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png',
  shadowUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png',
});

// ─── Config ──────────────────────────────────────────────────────────────
const API = import.meta.env.VITE_API_URL ?? 'http://localhost:3001';
const DEPOT: GeoPoint = {lat: 24.7136, lng: 46.6753};
const AVG_SPEED_KMH = 22;

const EVENT_TYPES: EventType[] = [
  {id: 'balloon_arch', label: 'Balloon Arch', setup_minutes: 10},
  {id: 'backdrop', label: 'Themed Backdrop', setup_minutes: 25},
  {id: 'full_setup', label: 'Full Themed Setup', setup_minutes: 45},
  {id: 'baby_shower', label: 'Baby Shower Package', setup_minutes: 30},
  {id: 'default', label: 'Standard Setup', setup_minutes: 15},
];

// ─── Route helpers (mirrors backend math) ────────────────────────────────
function haversineKm(a: GeoPoint, b: GeoPoint): number {
  const R = 6371;
  const dLat = (b.lat - a.lat) * Math.PI / 180;
  const dLng = (b.lng - a.lng) * Math.PI / 180;
  const aa =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a.lat * Math.PI / 180) * Math.cos(b.lat * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(aa), Math.sqrt(1 - aa));
}
function travelMins(from: GeoPoint, to: GeoPoint): number {
  return (haversineKm(from, to) / AVG_SPEED_KMH) * 60;
}
function clockToMins(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}
function minsToClock(mins: number): string {
  const h = Math.floor(mins / 60) % 24;
  const m = Math.round(mins % 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}
function setupFor(eventTypeId?: string): number {
  return EVENT_TYPES.find(e => e.id === eventTypeId)?.setup_minutes ?? 15;
}

// ─── App ─────────────────────────────────────────────────────────────────
function App() {
  const [sessionId] = useState(() => `sess-${Math.random().toString(36).slice(2)}`);
  const [customerId] = useState(() => `cust-${Math.random().toString(36).slice(2)}`);

  const [selectedLocation, setSelectedLocation] = useState<GeoPoint | null>(null);
  const [selectedDate, setSelectedDate] = useState(() => {
    const d = new Date(); d.setDate(d.getDate() + 1);
    return d.toISOString().split('T')[0];
  });
  const [selectedEventType, setSelectedEventType] = useState('default');
  const [selectedSlot, setSelectedSlot] = useState<SlotType | null>(null);
  const [suggestedSlot, setSuggestedSlot] = useState<SlotType | null>(null);
  const [subSlots, setSubSlots] = useState<SubSlotInfo[]>([]);
  const [selectedSubSlot, setSelectedSubSlot] = useState<string | null>(null);
  const [suggestedSubSlot, setSuggestedSubSlot] = useState<string | null>(null);

  const [slots, setSlots] = useState<SlotAvailability[]>([]);
  const [orders, setOrders] = useState<any[]>([]);
  const [decision, setDecision] = useState<Decision | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // ─── Data fetching ───────────────────────────────────────────────────

  const fetchSlots = useCallback(async () => {
    if (!selectedDate) return;
    setSelectedSlot(null); setSuggestedSlot(null);
    setSubSlots([]); setSelectedSubSlot(null); setSuggestedSubSlot(null);
    try {
      const params = new URLSearchParams({date: selectedDate, event_type_id: selectedEventType});
      if (selectedLocation) {
        params.set('lat', selectedLocation.lat.toString());
        params.set('lng', selectedLocation.lng.toString());
      }
      const res = await fetch(`${API}/availability?${params}`);
      const data = await res.json();
      setSlots(data.slots ?? []);
    } catch (e: any) {
      setError('Failed to fetch slots: ' + e.message);
    }
  }, [selectedDate, selectedLocation, selectedEventType]);

  const fetchSubSlots = useCallback(async () => {
    if (!selectedDate || !selectedSlot || !selectedLocation) {
      setSubSlots([]); setSelectedSubSlot(null); setSuggestedSubSlot(null); return;
    }
    try {
      const params = new URLSearchParams({
        date: selectedDate, main_slot: selectedSlot,
        lat: selectedLocation.lat.toString(), lng: selectedLocation.lng.toString(),
        event_type_id: selectedEventType,
      });
      const res = await fetch(`${API}/sub-slots?${params}`);
      const data = await res.json();
      setSubSlots(data.sub_slots ?? []);
      setSuggestedSubSlot(data.suggested ?? null);
      setSelectedSubSlot(data.suggested ?? null);
    } catch { setSubSlots([]); }
  }, [selectedDate, selectedSlot, selectedLocation, selectedEventType]);

  const fetchOrders = useCallback(async () => {
    try {
      const params = new URLSearchParams();
      if (selectedDate) params.set('date', selectedDate);
      const res = await fetch(`${API}/orders?${params}`);
      const data = await res.json();
      setOrders(data.orders ?? []);
    } catch (e: any) {
      setError('Failed to fetch orders: ' + e.message);
    }
  }, [selectedDate]);

  useEffect(() => { fetchSlots(); fetchOrders(); }, [fetchSlots, fetchOrders]);
  useEffect(() => { fetchSubSlots(); }, [fetchSubSlots]);

  // Auto-suggest main slot when location + slots load
  useEffect(() => {
    if (!selectedLocation || slots.length === 0) return;
    const bookable = slots.filter(s => s.is_bookable && s.is_routable);
    if (bookable.length > 0 && !selectedSlot) setSuggestedSlot(bookable[0].slot.id as SlotType);
  }, [selectedLocation, slots, selectedSlot]);
  useEffect(() => {
    if (suggestedSlot && !selectedSlot) setSelectedSlot(suggestedSlot);
  }, [suggestedSlot, selectedSlot]);

  // ─── Booking ─────────────────────────────────────────────────────────

  const cancelOrder = async (orderId: string) => {
    try {
      await fetch(`${API}/orders/${orderId}`, {method: 'DELETE'});
      fetchOrders(); fetchSlots(); fetchSubSlots();
    } catch (e: any) {
      setError('Cancel failed: ' + e.message);
    }
  };

  const handleBook = async () => {
    if (!selectedLocation || !selectedSlot || !selectedSubSlot) {
      setError('Pick a location, slot and delivery window first'); return;
    }
    setLoading(true); setError(null); setDecision(null);
    try {
      const holdRes = await fetch(`${API}/holds`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({
          session_id: sessionId, customer_id: customerId,
          location: selectedLocation, date: selectedDate,
          slot: selectedSlot, event_type_id: selectedEventType,
          sub_slot_time: selectedSubSlot,
        }),
      });
      const holdData = await holdRes.json();
      if (!holdRes.ok) {
        setError(holdData.message ?? holdData.reason_code ?? 'Failed to hold slot');
        setDecision(holdData); setLoading(false); return;
      }
      const bookRes = await fetch(`${API}/bookings`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json', 'idempotency-key': `${sessionId}-${Date.now()}`},
        body: JSON.stringify({hold_id: holdData.holdId, customer_id: customerId}),
      });
      const bookData: Decision = await bookRes.json();
      setDecision(bookData);
      if (bookData.status === 'accepted') { fetchSlots(); fetchOrders(); fetchSubSlots(); }
    } catch (e: any) {
      setError('Booking failed: ' + e.message);
    } finally { setLoading(false); }
  };

  // ─── Helpers ─────────────────────────────────────────────────────────

  const dayOfWeek = (d: string) => new Date(d + 'T12:00:00').toLocaleDateString('en-US', {weekday: 'long'});
  const isWeekend = (d: string) => { const day = new Date(d + 'T12:00:00').getDay(); return day === 5 || day === 6; };
  const maxCap = (d: string) => isWeekend(d) ? 10 : 3;
  const eventType = EVENT_TYPES.find(e => e.id === selectedEventType)!;

  // For each sub-slot, compute travel-from-previous diagnostics using client-side haversine
  const slotOrders = orders
    .filter(o => o.date === selectedDate && o.slot === selectedSlot && o.sub_slot_time)
    .sort((a: any, b: any) => a.sub_slot_time.localeCompare(b.sub_slot_time));

  function subSlotDiagnostics(ssTime: string): {prevLabel: string; travelNeeded: number; gapAvailable: number | null} {
    const prevOrder = slotOrders.filter((o: any) => o.sub_slot_time < ssTime).pop();
    const prevLoc: GeoPoint = prevOrder?.location ?? DEPOT;
    const prevLabel = prevOrder ? prevOrder.sub_slot_time : 'depot';
    const travelNeeded = selectedLocation ? travelMins(prevLoc, selectedLocation) : 0;
    if (!prevOrder) {
      // Crew departs depot early enough to arrive on time — no gap constraint
      return {prevLabel, travelNeeded, gapAvailable: null};
    }
    const prevDep = clockToMins(prevOrder.sub_slot_time) + setupFor(prevOrder.event_type_id);
    const gapAvailable = clockToMins(ssTime) - prevDep;
    return {prevLabel, travelNeeded, gapAvailable};
  }

  // ─── Admin table data ────────────────────────────────────────────────
  const dayOrders = orders
    .filter((o: any) => o.date === selectedDate)
    .sort((a: any, b: any) => {
      if (a.slot !== b.slot) return a.slot === 'afternoon' ? -1 : 1;
      return (a.sub_slot_time ?? '').localeCompare(b.sub_slot_time ?? '');
    });

  function buildRouteTable(slotId: string) {
    const slotOrd = dayOrders.filter((o: any) => o.slot === slotId);
    let prevLoc = DEPOT;
    let prevDep: number | null = null; // null = first stop from depot, crew adjusts departure
    return slotOrd.map((o: any) => {
      const travel = travelMins(prevLoc, o.location);
      const promised = o.sub_slot_time ? clockToMins(o.sub_slot_time) : null;
      const gap = promised !== null && prevDep !== null ? promised - prevDep : null;
      const setup = setupFor(o.event_type_id);
      const depMins = promised !== null ? promised + setup : (prevDep ?? 0) + travel + setup;
      const row = {
        order: o, travel: Math.round(travel),
        gap: gap !== null ? Math.round(gap) : null,
        onTime: gap !== null ? gap >= travel : true,
        departure: minsToClock(depMins),
        setup,
      };
      prevLoc = o.location;
      prevDep = depMins;
      return row;
    });
  }

  const afternoonRows = buildRouteTable('afternoon');
  const eveningRows = buildRouteTable('evening');

  // ─── JSX ─────────────────────────────────────────────────────────────

  return (
    <div className="app">
      <header>
        <h1>🎈 Slot Booking Service</h1>
      </header>

      {/* STEP 1 — Location */}
      <section className="card step-card">
        <div className="step-label">Step 1</div>
        <h2>📍 Delivery Location</h2>
        <p className="map-hint">
          {selectedLocation
            ? `📌 ${selectedLocation.lat.toFixed(4)}, ${selectedLocation.lng.toFixed(4)}`
            : 'Click the map to pin your delivery address'}
        </p>
        <div className="map-wrapper">
          <MapComponent
            center={[DEPOT.lat, DEPOT.lng]}
            zoom={11}
            markers={selectedLocation ? [{...selectedLocation, label: '📍 Delivery'}] : []}
            depot={{...DEPOT, label: '🏭 Warehouse (FC)'}}
            existingMarkers={dayOrders.map((o: any) => ({
              ...o.location,
              label: `${o.slot === 'afternoon' ? '🌤️' : '🌙'} ${o.sub_slot_time ?? ''} · ${o.area || o.order_id}`,
            }))}
            onMapClick={(lat, lng) => {
              setSelectedLocation({lat, lng});
              setSelectedSlot(null); setSuggestedSlot(null);
              setSubSlots([]); setSelectedSubSlot(null); setSuggestedSubSlot(null);
            }}
          />
        </div>
        {selectedLocation && (
          <button className="btn-text" onClick={() => {
            setSelectedLocation(null);
            setSelectedSlot(null); setSuggestedSlot(null);
            setSubSlots([]); setSelectedSubSlot(null);
          }}>Clear location</button>
        )}
      </section>

      {/* STEP 2 — Date */}
      <section className="card step-card">
        <div className="step-label">Step 2</div>
        <h2>📅 Date</h2>
        <input type="date" value={selectedDate} min={new Date().toISOString().split('T')[0]}
          onChange={e => { setSelectedDate(e.target.value); setDecision(null); }} className="date-input" />
        {selectedDate && (
          <div className="day-badges">
            <span className={`day-type ${isWeekend(selectedDate) ? 'weekend' : 'weekday'}`}>
              {dayOfWeek(selectedDate)} · {isWeekend(selectedDate) ? 'Weekend' : 'Weekday'} · max {maxCap(selectedDate)}/slot
            </span>
          </div>
        )}
      </section>

      {/* STEP 3 — Event Type */}
      <section className="card step-card">
        <div className="step-label">Step 3</div>
        <h2>🎪 Service Type <span className="setup-hint">(setup time affects your delivery window)</span></h2>
        <div className="event-types">
          {EVENT_TYPES.map(et => (
            <button key={et.id}
              className={`event-type-btn ${selectedEventType === et.id ? 'selected' : ''}`}
              onClick={() => { setSelectedEventType(et.id); setDecision(null); }}>
              <span className="et-label">{et.label}</span>
              <span className="et-time">{et.setup_minutes} min setup</span>
            </button>
          ))}
        </div>
        {selectedEventType !== 'default' && (
          <p className="setup-note">
            ✱ {eventType.label} · {eventType.setup_minutes} min on-site setup
            {selectedEventType === 'full_setup' && ' — leaves less buffer for next stop!'}
          </p>
        )}
      </section>

      {/* STEP 4 — Main slot */}
      {slots.length > 0 && selectedLocation && (
        <section className="card step-card">
          <div className="step-label">Step 4</div>
          <h2>⏰ Delivery Window</h2>
          <div className="slots-grid">
            {slots.map(s => {
              const max = maxCap(selectedDate);
              const pct = (s.current_load / max) * 100;
              const isSelected = selectedSlot === s.slot.id;
              const unbookable = s.current_load >= max || !s.is_routable;
              return (
                <div key={s.slot.id}
                  className={`slot-card ${isSelected ? 'selected' : ''} ${unbookable ? 'unavailable' : ''}`}
                  onClick={() => {
                    if (unbookable) return;
                    const next = isSelected ? null : s.slot.id as SlotType;
                    setSelectedSlot(next);
                    setSubSlots([]); setSelectedSubSlot(null); setSuggestedSubSlot(null);
                  }}>
                  <div className="slot-header">
                    <span className="slot-name">{s.slot.id === 'afternoon' ? '🌤️' : '🌙'} {s.slot.label}</span>
                    <span className={`badge ${s.is_bookable && s.is_routable ? 'ok' : 'full'}`}>
                      {!s.is_routable ? 'Route limit' : !s.is_bookable ? 'Full' : 'Open'}
                    </span>
                  </div>
                  <div className="slot-time">{s.slot.window_start}–{s.slot.window_end}</div>
                  <div className="capacity-bar">
                    <div className="cap-fill" style={{
                      width: `${pct}%`,
                      background: pct >= 100 ? 'var(--danger)' : pct >= 66 ? '#f5a623' : 'var(--success)',
                    }} />
                  </div>
                  <div className="cap-text">{s.current_load}/{max} booked · {s.remaining_capacity} left</div>
                  {!s.is_routable && (
                    <div className="routability">⚠️ {s.reason === 'route_over_budget' ? 'Route exceeds time budget' : 'Outside service area'}</div>
                  )}
                  {suggestedSlot === s.slot.id && isSelected && (
                    <div className="suggested-badge">💡 Best match for your location</div>
                  )}
                </div>
              );
            })}
          </div>
        </section>
      )}

      {/* STEP 5 — Sub-slot picker */}
      {selectedSlot && selectedLocation && subSlots.length > 0 && (
        <section className="card step-card">
          <div className="step-label">Step 5</div>
          <h2>🕐 Pick Delivery Time
          </h2>
          <p className="map-hint">
            Each window shows travel time from the previous stop to your location at {AVG_SPEED_KMH} km/h.
          </p>
          <div className="sub-slot-picker">
            {subSlots.map((ss) => {
              const isSelected = selectedSubSlot === ss.time;
              const isSuggested = suggestedSubSlot === ss.time;
              const {prevLabel, travelNeeded, gapAvailable} = subSlotDiagnostics(ss.time);
              // null gapAvailable = crew from depot, always "fits" (they leave early)
              const canFit = gapAvailable === null || gapAvailable >= travelNeeded;
              const unavailable = ss.is_taken || ss.is_held || !ss.is_feasible;
              return (
                <button
                  key={ss.time}
                  className={[
                    'sub-slot-btn',
                    isSelected ? 'selected' : '',
                    ss.is_taken ? 'taken' : ss.is_held ? 'held' : !ss.is_feasible ? 'infeasible' : '',
                  ].filter(Boolean).join(' ')}
                  disabled={unavailable}
                  onClick={() => setSelectedSubSlot(isSelected ? null : ss.time)}
                >
                  {isSuggested && <span className="ss-badge">suggested</span>}
                  <span className="ss-time">{ss.time}</span>
                  <span className="ss-icon">
                    {ss.is_taken ? '📦' : ss.is_held ? '⏳' : !ss.is_feasible ? '🚫' : isSuggested && isSelected ? '⭐' : '✓'}
                  </span>
                  {!ss.is_taken && !ss.is_held && (
                    <span className={`ss-travel ${canFit ? 'ok' : 'tight'}`}>
                      {Math.round(travelNeeded)}m travel
                    </span>
                  )}
                  {!ss.is_taken && !ss.is_held && (
                    <span className={`ss-gap ${canFit ? 'ok' : 'tight'}`}>
                      {gapAvailable === null
                        ? 'early depart'
                        : canFit
                          ? `+${Math.round(gapAvailable - travelNeeded)}m buffer`
                          : `${Math.round(gapAvailable)}m gap`}
                    </span>
                  )}
                  <span className="ss-prev">from {prevLabel}</span>
                </button>
              );
            })}
          </div>
          {selectedSubSlot && (
            <p className="sub-slot-confirm">
              Delivery window: <strong>{selectedSubSlot}–{minsToClock(clockToMins(selectedSubSlot) + 30)}</strong>
              {' · '}{eventType.setup_minutes} min setup · departs {minsToClock(clockToMins(selectedSubSlot) + eventType.setup_minutes)}
            </p>
          )}
        </section>
      )}

      {/* Confirm */}
      <section className="card">
        <button className="btn-primary btn-large" onClick={handleBook}
          disabled={loading || !selectedLocation || !selectedSlot || !selectedSubSlot}>
          {loading ? 'Processing…' : decision ? 'Book Again' : '✅ Confirm Booking'}
        </button>
        {error && <div className="error-msg">❌ {error}</div>}

        {decision && (
          <div className={`decision ${decision.status}`}>
            {decision.status === 'accepted' ? (
              <>
                <h3>✅ {decision.message}</h3>
                <p>Confirmation: <strong>{decision.confirmation_id}</strong></p>
                <p>
                  {decision.date} · {decision.slot}
                  {(decision as any).sub_slot_time ? ` · ${(decision as any).sub_slot_time}` : ''}
                </p>
                {decision.route && (
                  <p className="route-info">
                    Route: {decision.route.total_minutes} min / {decision.route.budget_minutes} min budget
                    {decision.route.over_budget && ' ⚠️ OVER BUDGET'}
                  </p>
                )}
              </>
            ) : (
              <>
                <h3>❌ {decision.message}</h3>
                <p>Reason: <strong>{decision.reason_code?.replace(/_/g, ' ')}</strong></p>
              </>
            )}
          </div>
        )}
      </section>

      {/* Admin table */}
      <section className="card admin-section">
        <h2>📊 Day Schedule — {selectedDate}
          <span className="setup-hint"> ({dayOrders.length} booking{dayOrders.length !== 1 ? 's' : ''})</span>
        </h2>
        {dayOrders.length === 0 ? (
          <p className="empty-state">No confirmed bookings for this date.</p>
        ) : (
          <>
            {[{id: 'afternoon', rows: afternoonRows, label: '🌤️ Afternoon (12:00–16:00)'},
              {id: 'evening', rows: eveningRows, label: '🌙 Evening (16:00–20:00)'}].map(({id, rows, label}) =>
              rows.length > 0 && (
                <div key={id} className="admin-slot-group">
                  <div className="admin-slot-header">{label}</div>
                  <table className="admin-table">
                    <thead>
                      <tr>
                        <th>Window</th>
                        <th>Service</th>
                        <th>Setup</th>
                        <th>Location</th>
                        <th>Travel from prev</th>
                        <th>Gap</th>
                        <th>Departs</th>
                        <th>Order ID</th>
                        <th></th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map(({order: o, travel, gap, onTime, departure, setup}) => (
                        <tr key={o.order_id} className={!onTime ? 'row-tight' : ''}>
                          <td className="td-time">{o.sub_slot_time ?? '—'}</td>
                          <td>{EVENT_TYPES.find(e => e.id === o.event_type_id)?.label ?? o.event_type_id}</td>
                          <td>{setup} min</td>
                          <td className="td-loc">
                            {o.area || `${o.location.lat.toFixed(3)}, ${o.location.lng.toFixed(3)}`}
                          </td>
                          <td className={`td-travel ${onTime ? 'ok' : 'tight'}`}>
                            {travel} min
                          </td>
                          <td className={`td-gap ${onTime ? 'ok' : 'tight'}`}>
                            {gap !== null ? (onTime ? `+${gap - travel} min` : `${gap} min (short ${travel - gap} min)`) : '—'}
                          </td>
                          <td>{departure}</td>
                          <td className="td-id">{o.order_id}</td>
                          <td>
                            <button className="btn-cancel" onClick={() => cancelOrder(o.order_id)} title="Cancel booking">✕</button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )
            )}
          </>
        )}
      </section>
    </div>
  );
}

// ─── Map component ────────────────────────────────────────────────────────
interface MapProps {
  center: [number, number];
  zoom?: number;
  markers: {lat: number; lng: number; label: string}[];
  existingMarkers?: {lat: number; lng: number; label: string}[];
  depot: {lat: number; lng: number; label: string};
  onMapClick?: (lat: number, lng: number) => void;
}

function MapComponent({center, zoom = 11, markers, existingMarkers = [], depot, onMapClick}: MapProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const markersLayerRef = useRef<L.LayerGroup | null>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el || mapRef.current) return;
    const map = L.map(el).setView(center, zoom);
    mapRef.current = map;
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; <a href="https://www.openstreetmap.org/">OpenStreetMap</a>',
    }).addTo(map);
    markersLayerRef.current = L.layerGroup().addTo(map);
    return () => { map.remove(); mapRef.current = null; markersLayerRef.current = null; };
  }, [center, zoom]);

  useEffect(() => {
    const layer = markersLayerRef.current;
    if (!layer) return;
    layer.clearLayers();
    for (const m of markers) L.marker([m.lat, m.lng]).bindPopup(m.label).addTo(layer);
    for (const m of existingMarkers) L.marker([m.lat, m.lng]).bindPopup(m.label).addTo(layer);
    L.marker([depot.lat, depot.lng]).bindPopup(depot.label).addTo(layer);
  }, [markers, existingMarkers, depot]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const onClick = (e: L.LeafletMouseEvent) => onMapClick?.(e.latlng.lat, e.latlng.lng);
    if (onMapClick) map.on('click', onClick);
    return () => { map.off('click', onClick); };
  }, [onMapClick]);

  return (
    <div ref={containerRef} className="map-container"
      style={{height: 340, borderRadius: 12, cursor: onMapClick ? 'crosshair' : 'default'}} />
  );
}

export default App;
