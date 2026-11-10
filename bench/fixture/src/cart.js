// Shopping cart. Prices come from the product objects; rules come from pricing.js.
import { applyCoupon, parseCoupon, taxFor } from './pricing.js';

export class Cart {
  /**
   * @param {string} country ISO country code used for tax
   */
  constructor(country = 'US') {
    this.country = country;
    /** @type {Map<string, { product: { id: string, name: string, price: number }, qty: number }>} */
    this.lines = new Map();
    this.coupon = null;
  }

  /** Add a product, or increase its quantity if it is already in the cart. */
  add(product, qty = 1) {
    if (!product || typeof product.id !== 'string') throw new TypeError('product must have an id');
    if (!Number.isInteger(qty) || qty < 1) throw new RangeError('qty must be a positive integer');
    const line = this.lines.get(product.id);
    if (line) line.qty += qty;
    else this.lines.set(product.id, { product, qty });
    return this;
  }

  /** Remove a product entirely. Returns true if it was in the cart. */
  remove(productId) {
    return this.lines.delete(productId);
  }

  /** Set the quantity of a product already in the cart. Zero removes it. */
  setQty(productId, qty) {
    const line = this.lines.get(productId);
    if (!line) throw new Error(`Product ${productId} is not in the cart`);
    if (!Number.isInteger(qty) || qty < 0) throw new RangeError('qty must be a non-negative integer');
    if (qty === 0) this.lines.delete(productId);
    else line.qty = qty;
    return this;
  }

  /** Total number of units across all lines. */
  get count() {
    let n = 0;
    for (const line of this.lines.values()) n += line.qty;
    return n;
  }

  get isEmpty() {
    return this.lines.size === 0;
  }

  /** Sum of price * qty, before coupons and tax. */
  subtotal() {
    let sum = 0;
    for (const { product, qty } of this.lines.values()) sum += product.price * qty;
    return sum;
  }

  /** Attach a coupon code. Returns false, leaving the cart unchanged, if the code is invalid. */
  applyCoupon(code) {
    const coupon = parseCoupon(code);
    if (!coupon) return false;
    this.coupon = coupon;
    return true;
  }

  /** Amount payable: subtotal, minus coupon, plus tax. */
  total() {
    const discounted = applyCoupon(this.subtotal(), this.coupon);
    return discounted + taxFor(discounted, this.country);
  }

  /** Plain-object snapshot, used when an order is created. */
  toJSON() {
    return {
      country: this.country,
      lines: [...this.lines.values()].map(({ product, qty }) => ({ id: product.id, name: product.name, price: product.price, qty })),
      subtotal: this.subtotal(),
      total: this.total(),
    };
  }
}
