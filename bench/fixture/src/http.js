// JSON API handler for node:http. Usage: http.createServer(createHandler({ products }))

function send(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

function intParam(url, name, fallback) {
  const raw = url.searchParams.get(name);
  if (raw === null) return fallback;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : NaN;
}

/**
 * @param {{ products: import('./store.js').Store }} deps
 * @returns {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => void}
 */
export function createHandler({ products }) {
  return function handler(req, res) {
    const url = new URL(req.url ?? '/', 'http://localhost');

    if (req.method !== 'GET') {
      return send(res, 405, { error: 'Method not allowed' });
    }

    if (url.pathname === '/health') {
      return send(res, 200, { ok: true, products: products.size });
    }

    if (url.pathname === '/products') {
      const page = intParam(url, 'page', 1);
      const size = intParam(url, 'size', 10);
      if (Number.isNaN(page) || Number.isNaN(size)) {
        return send(res, 400, { error: 'page and size must be positive integers' });
      }
      let result = products;
      const maxPrice = url.searchParams.get('maxPrice');
      if (maxPrice !== null) result = result.filter((p) => p.price <= Number(maxPrice));
      const sort = url.searchParams.get('sort');
      if (sort) result = result.sortBy(sort, url.searchParams.get('dir') ?? 'asc');
      return send(res, 200, result.paginate(page, size));
    }

    return send(res, 404, { error: 'Not found' });
  };
}
