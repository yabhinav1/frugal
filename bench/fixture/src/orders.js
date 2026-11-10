// Orders and their lifecycle.

export const STATUSES = ['pending', 'paid', 'shipped', 'delivered', 'cancelled'];

/** Which statuses an order may move to from each status. */
const TRANSITIONS = {
  pending: ['paid', 'cancelled'],
  paid: ['shipped', 'cancelled'],
  shipped: ['delivered', 'cancelled'],
  delivered: [],
  cancelled: [],
};

let nextId = 1000;

/** Create an order from a cart snapshot (see Cart#toJSON). */
export function createOrder(cartSnapshot, userId) {
  if (!cartSnapshot || !Array.isArray(cartSnapshot.lines) || cartSnapshot.lines.length === 0) {
    throw new Error('Cannot create an order from an empty cart');
  }
  if (!userId) throw new Error('userId is required');
  const now = new Date().toISOString();
  return {
    id: `ORD-${nextId++}`,
    userId,
    lines: cartSnapshot.lines.map((line) => ({ ...line })),
    total: cartSnapshot.total,
    status: 'pending',
    history: [{ status: 'pending', at: now }],
  };
}

/** Whether an order may move to the given status. */
export function canTransition(order, next) {
  return (TRANSITIONS[order.status] ?? []).includes(next);
}

/** Move an order to a new status, recording it in the history. Throws on an invalid move. */
export function transition(order, next) {
  if (!STATUSES.includes(next)) throw new RangeError(`Unknown status: ${next}`);
  if (!canTransition(order, next)) throw new Error(`Cannot move order from ${order.status} to ${next}`);
  order.status = next;
  order.history.push({ status: next, at: new Date().toISOString() });
  return order;
}

/** True once an order can no longer change. */
export function isFinal(order) {
  return TRANSITIONS[order.status].length === 0;
}

/** Total value of orders that were paid for and not cancelled. */
export function revenue(orders) {
  return orders.filter((o) => ['paid', 'shipped', 'delivered'].includes(o.status)).reduce((sum, o) => sum + o.total, 0);
}
