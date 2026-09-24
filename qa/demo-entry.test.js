import test from 'node:test';
import assert from 'node:assert/strict';
import { readEntryRoute } from '../src/public-route.js';
import { readDemoSelection, saveDemoSelection } from '../src/demo-entry.js';

test('public and workspace paths stay distinct while old work bookmarks remain in the workspace', () => {
  assert.equal(readEntryRoute(new URL('http://localhost/')), 'landing');
  assert.equal(readEntryRoute(new URL('http://localhost/demo')), 'demo');
  assert.equal(readEntryRoute(new URL('http://localhost/app')), 'workspace');
  assert.equal(readEntryRoute(new URL('http://localhost/orders?record=8&gstin=2&branch=3')), 'workspace');
  assert.equal(readEntryRoute(new URL('http://localhost/?page=coverage')), 'workspace');
});

test('a demo account selection survives another page load and rejects invalid IDs', () => {
  const values = new Map();
  const storage = { getItem: key => values.get(key), setItem: (key, value) => values.set(key, value) };
  assert.equal(saveDemoSelection({ companyId: 2, userId: 5 }, storage), true);
  assert.deepEqual(readDemoSelection(storage), { companyId: 2, userId: 5 });
  assert.equal(saveDemoSelection({ companyId: 2, userId: '../5' }, storage), false);
  assert.deepEqual(readDemoSelection(storage), { companyId: 2, userId: 5 });
});
