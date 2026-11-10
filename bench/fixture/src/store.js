// A small in-memory collection with chainable querying.

export class Store {
  /** @param {object[]} items each item needs a unique string `id` */
  constructor(items = []) {
    this.items = [...items];
  }

  get size() {
    return this.items.length;
  }

  find(id) {
    return this.items.find((item) => item.id === id) ?? null;
  }

  insert(item) {
    if (!item || typeof item.id !== 'string') throw new TypeError('item must have a string id');
    if (this.find(item.id)) throw new Error(`Duplicate id: ${item.id}`);
    this.items.push(item);
    return item;
  }

  update(id, patch) {
    const item = this.find(id);
    if (!item) return null;
    Object.assign(item, patch, { id });
    return item;
  }

  delete(id) {
    const index = this.items.findIndex((item) => item.id === id);
    if (index === -1) return false;
    this.items.splice(index, 1);
    return true;
  }

  /** A new Store holding only the items that match. */
  filter(predicate) {
    return new Store(this.items.filter(predicate));
  }

  /** A new Store sorted by a key. `direction` is 'asc' or 'desc'. */
  sortBy(key, direction = 'asc') {
    const factor = direction === 'desc' ? -1 : 1;
    const sorted = [...this.items].sort((a, b) => {
      if (a[key] < b[key]) return -1 * factor;
      if (a[key] > b[key]) return 1 * factor;
      return 0;
    });
    return new Store(sorted);
  }

  /**
   * One page of items. Pages are numbered from 1.
   * @returns {{ items: object[], page: number, pages: number, total: number }}
   */
  paginate(page = 1, size = 10) {
    if (!Number.isInteger(page) || page < 1) throw new RangeError('page must be a positive integer');
    if (!Number.isInteger(size) || size < 1) throw new RangeError('size must be a positive integer');
    const start = page * size;
    return {
      items: this.items.slice(start, start + size),
      page,
      pages: Math.ceil(this.items.length / size),
      total: this.items.length,
    };
  }
}
