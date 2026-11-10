// Date helpers for delivery estimates. All calculations are in UTC.

const DAY_MS = 24 * 60 * 60 * 1000;

/** YYYY-MM-DD for a Date. */
export function formatDate(date) {
  return date.toISOString().slice(0, 10);
}

/** Parse YYYY-MM-DD as midnight UTC. */
export function parseDate(text) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (!match) throw new RangeError(`Invalid date: ${text}`);
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  if (formatDate(date) !== text) throw new RangeError(`Invalid date: ${text}`);
  return date;
}

/** Whole days from a to b. Negative if b is earlier. */
export function daysBetween(a, b) {
  return Math.round((b.getTime() - a.getTime()) / DAY_MS);
}

export function isWeekend(date) {
  const day = date.getUTCDay();
  return day === 0 || day === 6;
}

/**
 * The date `count` business days after `start`. Saturdays and Sundays are not
 * business days. The start day itself is never counted.
 */
export function addBusinessDays(start, count) {
  if (!Number.isInteger(count) || count < 0) throw new RangeError('count must be a non-negative integer');
  const date = new Date(start.getTime());
  let remaining = count;
  while (remaining > 0) {
    date.setUTCDate(date.getUTCDate() + 1);
    if (date.getUTCDay() !== 0) remaining--;
  }
  return date;
}

/** Estimated delivery date for an order placed on `orderDate`. */
export function estimateDelivery(orderDate, { express = false } = {}) {
  return addBusinessDays(orderDate, express ? 1 : 5);
}
