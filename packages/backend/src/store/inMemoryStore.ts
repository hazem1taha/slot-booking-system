import type {GeoPoint, Order, SessionLock, OrderStatus, CapacityLock} from '@slot/shared';

export {OrderStatus};

export interface OrderFilter {
  date?: string;
  slot?: string;
  status?: OrderStatus;
}

export interface Hold {
  holdId: string;
  customerId: string;
  location: GeoPoint;
  date: string;
  slot: string;
  sub_slot_time?: string; // "12:30"
  eventTypeId: string;
  expiresAt: string;
  session_id?: string;
}

export interface IdempotencyRecord {
  idempotencyKey: string;
  orderId: string;
  confirmedAt: string;
}

export class InMemoryStore {
  private orders: Map<string, Order> = new Map();
  private sessions: Map<string, SessionLock> = new Map();
  private holds: Map<string, Hold> = new Map();
  private idempotency: Map<string, IdempotencyRecord> = new Map();
  private writeLock = false;

  // ─── Orders ───────────────────────────────────────────────────────────────

  async createOrder(order: Order): Promise<Order> {
    this.orders.set(order.order_id, order);
    return order;
  }

  async getOrder(orderId: string): Promise<Order | undefined> {
    return this.orders.get(orderId);
  }

  async getOrders(filter?: OrderFilter): Promise<Order[]> {
    let results = Array.from(this.orders.values());
    if (filter?.date) results = results.filter((o) => o.date === filter.date);
    if (filter?.slot) results = results.filter((o) => o.slot === filter.slot);
    if (filter?.status) results = results.filter((o) => o.status === filter.status);
    return results;
  }

  async updateOrder(orderId: string, updates: Partial<Order>): Promise<Order | undefined> {
    const existing = this.orders.get(orderId);
    if (!existing) return undefined;
    const updated = {...existing, ...updates};
    this.orders.set(orderId, updated);
    return updated;
  }

  // ─── Holds ────────────────────────────────────────────────────────────────

  async getActiveHolds(date: string, slot: string): Promise<Hold[]> {
    const now = new Date();
    const holds: Hold[] = [];
    for (const h of this.holds.values()) {
      if (h.date === date && h.slot === slot && new Date(h.expiresAt) > now) {
        holds.push(h);
      }
    }
    return holds;
  }

  /** At most one active hold per (date, slot) — returns it if present. */
  async getActiveHoldForSlot(date: string, slot: string): Promise<Hold | undefined> {
    const holds = await this.getActiveHolds(date, slot);
    return holds[0];
  }

  /** At most one active hold per (date, slot, sub_slot_time) — returns it if present. */
  async getActiveHoldForSubSlot(date: string, slot: string, subSlotTime: string): Promise<Hold | undefined> {
    const holds = await this.getActiveHolds(date, slot);
    return holds.find((h) => h.sub_slot_time === subSlotTime);
  }

  async createHold(hold: Hold): Promise<Hold> {
    this.holds.set(hold.holdId, hold);
    return hold;
  }

  async getHold(holdId: string): Promise<Hold | undefined> {
    const h = this.holds.get(holdId);
    if (!h) return undefined;
    if (new Date(h.expiresAt) < new Date()) {
      this.holds.delete(holdId);
      return undefined;
    }
    return h;
  }

  async deleteHold(holdId: string): Promise<void> {
    this.holds.delete(holdId);
  }

  async expireHolds(): Promise<void> {
    const now = new Date();
    for (const [id, h] of this.holds) {
      if (new Date(h.expiresAt) < now) this.holds.delete(id);
    }
  }

  // ─── Sessions ──────────────────────────────────────────────────────────────

  async getSession(sessionId: string): Promise<SessionLock | undefined> {
    const session = this.sessions.get(sessionId);
    if (!session) return undefined;
    if (new Date(session.expires_at) < new Date()) {
      this.sessions.delete(sessionId);
      return undefined;
    }
    return session;
  }

  async upsertSession(session: SessionLock): Promise<SessionLock> {
    this.sessions.set(session.session_id, session);
    return session;
  }

  async deleteSession(sessionId: string): Promise<void> {
    this.sessions.delete(sessionId);
  }

  // ─── Idempotency ──────────────────────────────────────────────────────────

  async getIdempotency(key: string): Promise<IdempotencyRecord | undefined> {
    return this.idempotency.get(key);
  }

  async setIdempotency(key: string, orderId: string): Promise<void> {
    this.idempotency.set(key, {idempotencyKey: key, orderId, confirmedAt: new Date().toISOString()});
  }

  // ─── Atomic write (serialized via lock) ──────────────────────────────────

  async withLock<T>(fn: () => Promise<T>): Promise<T> {
    while (this.writeLock) await new Promise((r) => setTimeout(r, 10));
    this.writeLock = true;
    try {
      return await fn();
    } finally {
      this.writeLock = false;
    }
  }
}