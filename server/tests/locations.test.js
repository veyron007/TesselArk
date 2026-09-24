import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const express = require('express');
const { openDatabase } = require('../db.cjs');
const { installLocationsSchema } = require('../locations-db.cjs');
const { registerLocationsRoutes } = require('../locations.cjs');
const { allowedScopes } = require('../access.cjs');

async function fixture(t) {
  const db = openDatabase(':memory:');
  installLocationsSchema(db);
  const app = express();
  app.use(express.json());
  app.use('/api', (req, _res, next) => {
    const companyId = Number(req.header('x-company-id') || 1);
    const userId = Number(req.header('x-user-id') || 1);
    req.company = db.prepare('SELECT * FROM companies WHERE id=?').get(companyId);
    req.user = db.prepare('SELECT * FROM users WHERE id=? AND company_id=?').get(userId, companyId);
    if (!req.company || !req.user) return next(Object.assign(new Error('Invalid identity'), { status: 403 }));
    req.scopes = allowedScopes(db, { companyId, userId });
    next();
  });
  registerLocationsRoutes(app, db);
  app.use((error, _req, res, _next) => res.status(error.status || 500).json({ error: error.message }));
  const server = app.listen(0);
  t.after(() => { server.close(); db.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const api = async (method, path, body, companyId = 1, userId = 1) => {
    const response = await fetch(base + path, { method, headers: { 'content-type': 'application/json', 'x-company-id': String(companyId), 'x-user-id': String(userId) }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, data: await response.json() };
  };
  return { db, api };
}

const physical = (db, branchId, itemId = 1) => db.prepare('SELECT COALESCE(SUM(quantity_delta),0) AS quantity FROM stock_movements WHERE company_id=1 AND branch_id=? AND item_id=?').get(branchId, itemId).quantity;
const location = (db, id, itemId = 1) => db.prepare('SELECT COALESCE(SUM(quantity_delta),0) AS quantity FROM location_movements WHERE location_id=? AND item_id=?').get(id, itemId).quantity;
const createLocation = async (api, branchId, kind, name, parentId) => {
  const result = await api('POST', '/api/locations', { branchId, kind, name, parentId });
  assert.equal(result.status, 200, JSON.stringify(result.data));
  return result.data.location.id;
};

test('warehouse/store/rack hierarchy, allocation, partial transit and receipt reconcile physical stock', async t => {
  const { db, api } = await fixture(t);
  const warehouse = await createLocation(api, 1, 'warehouse', 'Main warehouse');
  const store = await createLocation(api, 1, 'store', 'Dispatch store', warehouse);
  const rack = await createLocation(api, 1, 'rack', 'A-01', store);
  const destination = await createLocation(api, 2, 'warehouse', 'Pune depot');
  const beforeSource = physical(db, 1), beforeDest = physical(db, 2);
  const assigned = await api('POST', '/api/location-assignments', { locationId: rack, itemId: 1, quantity: 8, reason: 'Counted opening shelf stock', clientReference: 'ASSIGN-1' });
  assert.equal(assigned.status, 200, JSON.stringify(assigned.data));
  assert.equal(location(db, rack), 8);
  assert.equal(physical(db, 1), beforeSource);
  assert.equal((await api('POST', '/api/location-assignments', { locationId: rack, itemId: 1, quantity: 8, reason: 'Counted opening shelf stock', clientReference: 'ASSIGN-1' })).data.replayed, true);
  assert.equal((await api('POST', '/api/location-assignments', { locationId: rack, itemId: 1, quantity: 9, reason: 'Counted opening shelf stock', clientReference: 'ASSIGN-1' })).status, 409);
  const created = await api('POST', '/api/location-transfers', { sourceLocationId: rack, destinationLocationId: destination, itemId: 1, quantity: 6, reason: 'Replenish Pune', clientReference: 'XFER-1' });
  assert.equal(created.status, 200, JSON.stringify(created.data));
  const id = created.data.transfer.id;
  assert.equal((await api('POST', `/api/location-transfers/${id}/dispatch`, { evidenceReference: 'DC-100' })).status, 200);
  assert.equal(location(db, rack), 2);
  assert.equal(physical(db, 1), beforeSource - 6);
  assert.equal(physical(db, 2), beforeDest);
  const first = await api('POST', `/api/location-transfers/${id}/receive`, { quantity: 2, evidenceReference: 'GRN-100', clientReference: 'RCV-1' });
  assert.equal(first.status, 200, JSON.stringify(first.data));
  assert.equal(first.data.transfer.status, 'partial_received');
  assert.equal(first.data.transfer.inTransitQuantity, 4);
  assert.equal(location(db, destination), 2);
  assert.equal(physical(db, 2), beforeDest + 2);
  assert.equal((await api('POST', `/api/location-transfers/${id}/receive`, { quantity: 2, evidenceReference: 'GRN-100', clientReference: 'RCV-1' })).data.replayed, true);
  assert.equal(physical(db, 2), beforeDest + 2);
  assert.equal((await api('POST', `/api/location-transfers/${id}/receive`, { quantity: 5, evidenceReference: 'GRN-101', clientReference: 'RCV-2' })).status, 409);
  const second = await api('POST', `/api/location-transfers/${id}/receive`, { quantity: 4, evidenceReference: 'GRN-101', clientReference: 'RCV-2' });
  assert.equal(second.data.transfer.status, 'received');
  assert.equal(second.data.transfer.inTransitQuantity, 0);
  assert.equal(physical(db, 1) + physical(db, 2), beforeSource + beforeDest);
  assert.deepEqual(db.prepare('SELECT action FROM location_events WHERE transfer_id=? ORDER BY id').all(id).map(row => row.action), ['create', 'dispatch', 'receive', 'receive']);
});

test('scope, hierarchy, validation and cross-GSTIN document boundary are enforced', async t => {
  const { db, api } = await fixture(t);
  const source = await createLocation(api, 1, 'warehouse', 'Mumbai');
  const sameGstin = await createLocation(api, 2, 'warehouse', 'Pune');
  const otherGstin = await createLocation(api, 3, 'warehouse', 'Bengaluru');
  assert.equal((await api('POST', '/api/locations', { branchId: 2, kind: 'rack', parentId: source, name: 'Wrong branch' })).status, 400);
  assert.equal((await api('POST', '/api/locations', { branchId: 1, kind: 'rack', parentId: source, name: 'Missing store' })).status, 400);
  assert.equal((await api('POST', '/api/location-assignments', { locationId: source, itemId: 6, quantity: 1, reason: 'Service', clientReference: 'SERVICE-1' })).status, 400);
  assert.equal((await api('POST', '/api/location-assignments', { locationId: source, itemId: 1, quantity: physical(db, 1) + 1, reason: 'Over allocation', clientReference: 'OVER-1' })).status, 409);
  assert.equal((await api('POST', '/api/location-assignments', { locationId: source, itemId: 1, quantity: 3, reason: 'Count', clientReference: 'COUNT-1' })).status, 200);
  const regular = await api('POST', '/api/location-transfers', { sourceLocationId: source, destinationLocationId: sameGstin, itemId: 1, quantity: 1, reason: 'Move', clientReference: 'SAME-1' });
  assert.equal(regular.data.transfer.taxBoundary, 'same_gstin');
  const distinct = await api('POST', '/api/location-transfers', { sourceLocationId: source, destinationLocationId: otherGstin, itemId: 1, quantity: 1, reason: 'Move', clientReference: 'CROSS-1' });
  assert.equal(distinct.data.transfer.taxBoundary, 'inter_gstin');
  assert.equal((await api('POST', `/api/location-transfers/${distinct.data.transfer.id}/dispatch`, { evidenceReference: 'DC-1' })).status, 409);
  db.prepare('UPDATE user_branch_grants SET revoked_by=3,revoked_at=CURRENT_TIMESTAMP,revoked_reason=? WHERE company_id=1 AND user_id=1 AND branch_id=2 AND revoked_at IS NULL').run('Scope test');
  assert.equal((await api('GET', `/api/location-transfers/${regular.data.transfer.id}`)).status, 403);
  assert.equal((await api('GET', '/api/location-transfers')).data.transfers.some(row => row.id === regular.data.transfer.id), false);
  assert.equal((await api('POST', '/api/location-transfers', { sourceLocationId: source, destinationLocationId: sameGstin, itemId: 1, quantity: 1, reason: 'Denied', clientReference: 'DENIED-1' })).status, 403);
  assert.equal((await api('GET', `/api/locations/${otherGstin}`, undefined, 2, 5)).status, 404);
});

test('accountant cannot mutate, assignment protects batch balances, and dispatch evidence is idempotent', async t => {
  const { db, api } = await fixture(t);
  assert.equal((await api('POST', '/api/locations', { branchId: 2, kind: 'warehouse', name: 'Denied' }, 1, 2)).status, 403);
  const source = await createLocation(api, 2, 'warehouse', 'Pune batch shelf');
  const destination = await createLocation(api, 1, 'warehouse', 'Mumbai inbound');
  assert.equal((await api('POST', '/api/location-assignments', { locationId: source, itemId: 1, quantity: 11, reason: 'Physical count', clientReference: 'PUNE-COUNT-TOO-MUCH' })).status, 409);
  assert.equal((await api('POST', '/api/location-assignments', { locationId: source, itemId: 1, quantity: 10, reason: 'Physical count', clientReference: 'PUNE-COUNT' })).status, 200);
  const before = physical(db, 2);
  const smaller = await api('POST', '/api/location-transfers', { sourceLocationId: source, destinationLocationId: destination, itemId: 1, quantity: 10, reason: 'Pune replenishment', clientReference: 'PUNE-XFER-SMALL' });
  const smallId = smaller.data.transfer.id;
  assert.equal((await api('POST', `/api/location-transfers/${smallId}/dispatch`, { evidenceReference: 'DC-OK' })).status, 200);
  assert.equal((await api('POST', `/api/location-transfers/${smallId}/dispatch`, { evidenceReference: 'DC-OK' })).data.replayed, true);
  assert.equal((await api('POST', `/api/location-transfers/${smallId}/dispatch`, { evidenceReference: 'DIFFERENT' })).status, 409);
  assert.equal(physical(db, 2), before - 10);
  assert.equal((await api('POST', `/api/location-transfers/${smallId}/receive`, { quantity: 1, evidenceReference: 'GRN-1', clientReference: 'GRN-1' }, 1, 2)).status, 403);
});

test('later unlocated stock issues flag location recount and cannot dispatch unavailable stock', async t => {
  const { db, api } = await fixture(t);
  const source = await createLocation(api, 1, 'warehouse', 'Recount source');
  const destination = await createLocation(api, 2, 'warehouse', 'Recount destination');
  assert.equal((await api('POST', '/api/location-assignments', { locationId: source, itemId: 1, quantity: 5, reason: 'Counted shelf', clientReference: 'RECOUNT-COUNT' })).status, 200);
  const transfer = await api('POST', '/api/location-transfers', { sourceLocationId: source, destinationLocationId: destination, itemId: 1, quantity: 5, reason: 'Replenishment', clientReference: 'RECOUNT-XFER' });
  assert.equal(transfer.status, 200);
  const current = physical(db, 1);
  db.prepare("INSERT INTO stock_movements(company_id,branch_id,item_id,quantity_delta,type,reason) VALUES (1,1,1,?,'sale','Synthetic unlocated issue')").run(3 - current);
  const availability = (await api('GET', '/api/locations/availability')).data.availability.find(row => row.locationId === source);
  assert.equal(availability.reconciliationRequired, true);
  assert.equal(availability.unbatchedPhysicalQuantity, 3);
  assert.equal((await api('POST', `/api/location-transfers/${transfer.data.transfer.id}/dispatch`, { evidenceReference: 'DC-RECOUNT' })).status, 409);
});
