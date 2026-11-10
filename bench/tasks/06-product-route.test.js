import assert from 'node:assert/strict';
import http from 'node:http';
import test, { after, before } from 'node:test';
import { createHandler } from '../src/http.js';
import { Store } from '../src/store.js';

const products = new Store([
  { id: 'pen', name: 'Pen', price: 2 },
  { id: 'book', name: 'Book', price: 10 },
]);
let server;
let base;

before(async () => {
  server = http.createServer(createHandler({ products }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

test('GET /products/:id returns the product', async () => {
  const res = await fetch(`${base}/products/book`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { id: 'book', name: 'Book', price: 10 });
});

test('GET /products/:id returns 404 for an unknown id', async () => {
  const res = await fetch(`${base}/products/nope`);
  assert.equal(res.status, 404);
  assert.deepEqual(await res.json(), { error: 'Product not found' });
});

test('existing routes are unchanged', async () => {
  assert.equal((await fetch(`${base}/health`)).status, 200);
  assert.equal((await fetch(`${base}/products?size=1`)).status, 200);
  assert.equal((await fetch(`${base}/nothing/here`)).status, 404);
  assert.deepEqual(await (await fetch(`${base}/products/pen/reviews`)).json(), { error: 'Not found' });
});
