import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const express = require('express');
const { openDatabase } = require('../db.cjs');
const { registerCatalogueRoutes } = require('../catalogue.cjs');
const { allowedScopes } = require('../access.cjs');

async function fixture(t) {
  const db = openDatabase(':memory:');
  const app = express();
  app.use(express.json());
  app.use('/api', (req, _res, next) => {
    const companyId = Number(req.header('x-company-id') || 1), userId = Number(req.header('x-user-id') || 3);
    req.company = db.prepare('SELECT * FROM companies WHERE id=?').get(companyId);
    req.user = db.prepare('SELECT * FROM users WHERE id=? AND company_id=?').get(userId, companyId);
    if (!req.company || !req.user) return next(Object.assign(new Error('Invalid identity'), { status: 403 }));
    req.scopes = allowedScopes(db, { companyId, userId });
    next();
  });
  registerCatalogueRoutes(app, db);
  app.use((error, _req, res, _next) => res.status(error.status || 500).json({ error: error.message }));
  const server = app.listen(0);
  t.after(() => { server.close(); db.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const api = async (method, path, body, companyId = 1, userId = 3) => {
    const response = await fetch(base + path, { method, headers: { 'content-type': 'application/json', 'x-company-id': String(companyId), 'x-user-id': String(userId) }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, data: await response.json() };
  };
  return { db, api };
}

test('curated discovery filters metadata, launches and explicit mapped substitutes while retaining item identity', async t => {
  const { api } = await fixture(t);
  const category = await api('POST', '/api/catalogue/categories', { name: 'Diagnostics', sourceReference: 'internal:catalogue:1' });
  assert.equal(category.status, 200, JSON.stringify(category.data));
  const categoryId = category.data.category.id;
  const launch = new Date().toISOString().slice(0, 10);
  const detail = await api('PUT', '/api/catalogue/items/1', { categoryId, productKind: 'medicinal', salt: 'Glucose oxidase', tags: ['Diabetes', 'Home use'], parameters: [{ key: 'pack size', value: '50 strips' }], launchedOn: launch, sourceReference: 'supplier-sheet-2026-01', changeReason: 'Label review' });
  assert.equal(detail.status, 200, JSON.stringify(detail.data));
  assert.equal(detail.data.item.id, 1);
  assert.equal(detail.data.item.sku, 'MED-001');
  assert.equal((await api('GET', '/api/catalogue/items?categoryId=' + categoryId + '&tag=diabetes&parameterKey=pack%20size&parameterValue=50%20strips&newOnly=true')).data.items[0].id, 1);
  assert.equal((await api('GET', '/api/catalogue/items?q=oxidase')).data.items[0].id, 1);
  assert.equal((await api('GET', '/api/catalogue/items?tag=unknown')).data.items.length, 0);
  const mapping = await api('POST', '/api/catalogue/substitutes', { itemId: 1, substituteItemId: 2, reason: 'Counter staff may review this product identity with the customer', sourceReference: 'internal-review-4' });
  assert.equal(mapping.status, 400, JSON.stringify(mapping.data)); // medicinal/general is an invalid mapping
  await api('PUT', '/api/catalogue/items/2', { productKind: 'medicinal', salt: 'Sodium chloride', tags: ['Fluid'], parameters: [], sourceReference: 'label-2', changeReason: 'Classification' });
  const curated = await api('POST', '/api/catalogue/substitutes', { itemId: 1, substituteItemId: 2, reason: 'Catalogue suggestion for human product review', sourceReference: 'steward-note-7' });
  assert.equal(curated.status, 200, JSON.stringify(curated.data));
  assert.equal((await api('PUT', '/api/catalogue/items/2', { productKind: 'general', tags: [], parameters: [], sourceReference: 'label-2', changeReason: 'Reclassify' })).status, 409);
  const result = await api('GET', '/api/catalogue/items?substituteFor=1');
  assert.deepEqual(result.data.items.map(item => item.id), [2]);
  assert.match(result.data.safetyNotice, /not clinical equivalence/i);
  const item = await api('GET', '/api/catalogue/items/1');
  assert.equal(item.data.substitutes[0].substituteItemId, 2);
  assert.equal(item.data.substitutes[0].sourceReference, 'steward-note-7');
  assert.equal(item.data.item.id, 1);
  assert.equal((await api('PATCH', `/api/catalogue/substitutes/${curated.data.substitute.id}`, { active: false, sourceReference: 'steward-note-8', changeReason: 'Retired' })).status, 200);
  assert.equal((await api('GET', '/api/catalogue/items?substituteFor=1')).data.items.length, 0);
});

test('permissions, company isolation, validation and audit are enforced server side', async t => {
  const { db, api } = await fixture(t);
  assert.equal((await api('GET', '/api/catalogue/items', undefined, 1, 1)).status, 200);
  assert.equal((await api('POST', '/api/catalogue/categories', { name: 'Denied', sourceReference: 'x' }, 1, 1)).status, 403);
  assert.equal((await api('PUT', '/api/catalogue/items/1', { productKind: 'general', sourceReference: 'x' }, 2, 8)).status, 404);
  assert.equal((await api('GET', '/api/catalogue/items/1', undefined, 2, 8)).status, 404);
  assert.equal((await api('GET', '/api/catalogue/items', undefined, 2, 8)).data.items.every(item => item.companyId === 2), true);
  assert.equal((await api('PUT', '/api/catalogue/items/1', { tags: ['x'], sourceReference: 'x' })).status, 400);
  assert.equal((await api('PUT', '/api/catalogue/items/1', { productKind: 'medicinal', salt: 'x', tags: ['x', 'X'], parameters: [], sourceReference: 'source', changeReason: 'test' })).status, 400);
  const valid = await api('PUT', '/api/catalogue/items/1', { productKind: 'general', tags: ['Diagnostic'], parameters: [{ key: 'pack size', value: '50' }], sourceReference: 'manual-review', changeReason: 'Corrected metadata' });
  assert.equal(valid.status, 200, JSON.stringify(valid.data));
  assert.equal((await api('GET', '/api/catalogue/audit?itemId=1')).data.events.some(event => event.sourceReference === 'manual-review'), true);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM catalogue_item_events WHERE company_id=1 AND item_id=1').get().n, 1);
  assert.equal((await api('GET', '/api/catalogue/items?categoryId=999')).status, 404);
  assert.equal((await api('PUT', '/api/catalogue/items/1', { productKind: 'general', tags: [], parameters: [], launchedOn: '2099-01-01', sourceReference: 'source', changeReason: 'test' })).status, 400);
  db.prepare("UPDATE user_branch_grants SET revoked_at=CURRENT_TIMESTAMP,revoked_by=3,revoked_reason='Scope regression test' WHERE company_id=1 AND user_id=3 AND branch_id=2").run();
  assert.equal((await api('POST', '/api/catalogue/categories', { name: 'Partial', sourceReference: 'x' })).status, 403);
});
