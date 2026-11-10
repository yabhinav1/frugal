import assert from 'node:assert/strict';
import test from 'node:test';
import { toCsv } from '../src/csv.js';

test('plain values are written as they are', () => {
  assert.equal(toCsv([{ id: 'p1', name: 'Pen', price: 2 }]), 'id,name,price\np1,Pen,2');
});

test('values with commas, quotes or line breaks are quoted', () => {
  const csv = toCsv([
    { id: 'p1', name: 'Pen, blue' },
    { id: 'p2', name: 'The "Best" Pen' },
    { id: 'p3', name: 'Two\nlines' },
  ]);
  assert.equal(csv, 'id,name\np1,"Pen, blue"\np2,"The ""Best"" Pen"\np3,"Two\nlines"');
});

test('explicit columns choose and order the output, and missing values are empty', () => {
  assert.equal(toCsv([{ id: 'p1', name: 'Pen' }, { id: 'p2' }], ['name', 'id']), 'name,id\nPen,p1\n,p2');
});

test('null and undefined become empty cells, zero and false are kept', () => {
  assert.equal(toCsv([{ a: null, b: 0, c: false, d: undefined }]), 'a,b,c,d\n,0,false,');
});
