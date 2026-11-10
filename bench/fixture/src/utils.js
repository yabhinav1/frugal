// General helpers with no domain knowledge.

/** URL-friendly version of a title: lowercase words joined by single dashes. */
export function slugify(text) {
  return String(text).toLowerCase().replace(/[^a-z0-9]/g, '-');
}

/** Split an array into chunks of at most `size` items. */
export function chunk(items, size) {
  if (!Number.isInteger(size) || size < 1) throw new RangeError('size must be a positive integer');
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** Group items by the value of a key function. */
export function groupBy(items, keyOf) {
  const groups = {};
  for (const item of items) {
    const key = keyOf(item);
    (groups[key] ??= []).push(item);
  }
  return groups;
}

/** Sum of a numeric property or mapping over items. */
export function sumBy(items, valueOf) {
  return items.reduce((sum, item) => sum + valueOf(item), 0);
}

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/** Recursively merge `source` into a copy of `target`. Arrays are replaced, not merged. */
export function deepMerge(target, source) {
  const out = { ...target };
  for (const [key, value] of Object.entries(source)) {
    out[key] = isPlainObject(value) && isPlainObject(out[key]) ? deepMerge(out[key], value) : value;
  }
  return out;
}

/** Clamp a number to a range. */
export function clamp(n, min, max) {
  return Math.min(max, Math.max(min, n));
}
