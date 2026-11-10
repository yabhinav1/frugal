import assert from 'node:assert/strict';
import test from 'node:test';
import { parseCsv } from '../src/csv.js';

test('plain rows still parse', () => {
  assert.deepEqual(parseCsv('id,name,price\np1,Pen,2\n\np2,Book,10\n'), [
    { id: 'p1', name: 'Pen', price: '2' },
    { id: 'p2', name: 'Book', price: '10' },
  ]);
});

test('quoted fields may contain commas', () => {
  const rows = parseCsv('id,name,price\np1,"Pen, blue",2\np2,"Notebook, A5, ruled",4');
  assert.equal(rows[0].name, 'Pen, blue');
  assert.equal(rows[0].price, '2');
  assert.equal(rows[1].name, 'Notebook, A5, ruled');
});

test('doubled quotes inside a quoted field are one quote', () => {
  const rows = parseCsv('id,name\np1,"The ""Best"" Pen"');
  assert.equal(rows[0].name, 'The "Best" Pen');
});

test('quoted fields keep their inner spaces', () => {
  const rows = parseCsv('id,name\np1,"  padded  "');
  assert.equal(rows[0].name, '  padded  ');
});
