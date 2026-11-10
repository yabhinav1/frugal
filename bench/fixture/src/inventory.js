// Stock levels and reservations. A reservation holds stock for a cart without removing it.

export class Inventory {
  /** @param {Record<string, number>} initial stock by SKU */
  constructor(initial = {}) {
    /** @type {Map<string, number>} */
    this.stock = new Map(Object.entries(initial));
    /** @type {Map<string, number>} */
    this.reserved = new Map();
  }

  /** Units physically in stock. */
  stockOf(sku) {
    return this.stock.get(sku) ?? 0;
  }

  /** Units in stock that are not reserved. */
  available(sku) {
    return this.stockOf(sku) - (this.reserved.get(sku) ?? 0);
  }

  /** Receive new stock. */
  receive(sku, qty) {
    if (!Number.isInteger(qty) || qty < 1) throw new RangeError('qty must be a positive integer');
    this.stock.set(sku, this.stockOf(sku) + qty);
  }

  /** Hold units for a cart. Throws if not enough are available. */
  reserve(sku, qty) {
    if (!Number.isInteger(qty) || qty < 1) throw new RangeError('qty must be a positive integer');
    if (this.available(sku) < qty) throw new RangeError(`Insufficient stock for ${sku}: wanted ${qty}, available ${this.available(sku)}`);
    this.reserved.set(sku, (this.reserved.get(sku) ?? 0) + qty);
  }

  /** Give back units held by a reservation. */
  release(sku, qty) {
    const held = this.reserved.get(sku) ?? 0;
    if (qty > held) throw new RangeError(`Cannot release ${qty} of ${sku}: only ${held} reserved`);
    if (held === qty) this.reserved.delete(sku);
    else this.reserved.set(sku, held - qty);
  }

  /** Turn a reservation into a sale: the units leave stock. */
  commit(sku, qty) {
    this.release(sku, qty);
    this.stock.set(sku, this.stockOf(sku) - qty);
  }

  /** All known SKUs, sorted. */
  skus() {
    return [...this.stock.keys()].sort();
  }
}
