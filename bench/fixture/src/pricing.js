// Pricing rules: discounts, tax, coupons and display formatting.

/** Sales tax or VAT rate by ISO country code. Unknown countries are untaxed. */
export const TAX_RATES = {
  US: 0.07,
  IN: 0.18,
  DE: 0.19,
  GB: 0.2,
  JP: 0.1,
};

const CURRENCY_SYMBOLS = { USD: '$', EUR: '€', GBP: '£', INR: '₹', JPY: '¥' };

/**
 * Take a percentage off a total.
 * @param {number} total amount before discount
 * @param {number} percent 0-100
 */
export function applyDiscount(total, percent) {
  if (typeof total !== 'number' || Number.isNaN(total)) throw new TypeError('total must be a number');
  if (percent < 0 || percent > 100) throw new RangeError('percent must be 0-100');
  return total - total * percent;
}

/** Take a flat amount off a total, never going below zero. */
export function applyFlatDiscount(total, amount) {
  if (amount < 0) throw new RangeError('amount must not be negative');
  return Math.max(0, total - amount);
}

/** Tax owed on an amount in the given country. */
export function taxFor(amount, country) {
  const rate = TAX_RATES[country] ?? 0;
  return amount * rate;
}

/** Format an amount for display, e.g. formatPrice(3.5) -> "$3.50". */
export function formatPrice(amount, currency = 'USD') {
  const symbol = CURRENCY_SYMBOLS[currency];
  if (!symbol) throw new RangeError(`Unsupported currency: ${currency}`);
  const digits = currency === 'JPY' ? 0 : 2;
  const sign = amount < 0 ? '-' : '';
  return `${sign}${symbol}${Math.abs(amount).toFixed(digits)}`;
}

/**
 * Parse a coupon code.
 * "SAVE15" -> { type: 'percent', value: 15 }
 * "FLAT5"  -> { type: 'flat', value: 5 }
 * Anything else -> null
 */
export function parseCoupon(code) {
  if (typeof code !== 'string') return null;
  const match = /^(SAVE|FLAT)(\d{1,3})$/.exec(code.trim().toUpperCase());
  if (!match) return null;
  const value = Number(match[2]);
  if (match[1] === 'SAVE') {
    if (value < 1 || value > 100) return null;
    return { type: 'percent', value };
  }
  return { type: 'flat', value };
}

/** Apply a parsed coupon to a total. */
export function applyCoupon(total, coupon) {
  if (!coupon) return total;
  return coupon.type === 'percent' ? applyDiscount(total, coupon.value) : applyFlatDiscount(total, coupon.value);
}
