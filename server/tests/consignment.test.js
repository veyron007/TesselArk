import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { openDatabase } = require('../db.cjs');
const { allowedScopes } = require('../access.cjs');
const { registerConsignmentRoutes } = require('../consignment.cjs');
const { seedConsignmentDemo } = require('../consignment-db.cjs');

async function fixture(t) {
  const db = openDatabase(':memory:');
  const app = express();
  app.use(express.json());
  app.use('/api', (req, _res, next) => {
    const companyId = Number(req.header('x-company-id') || 1);
    const userId = Number(req.header('x-user-id') || 1);
    req.company = db.prepare('SELECT * FROM companies WHERE id=?').get(companyId);
    req.user = db.prepare('SELECT * FROM users WHERE id=? AND company_id=?').get(userId, companyId);
    if (!req.company || !req.user) return next(Object.assign(new Error('Unknown company or user'), { status: 403 }));
    req.scopes = allowedScopes(db, { companyId, userId });
    next();
  });
  registerConsignmentRoutes(app, db);
  app.use((error, _req, res, _next) => res.status(error.status || 500).json({ error: error.message }));
  const server = app.listen(0);
  t.after(() => { server.close(); db.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const api = async (method, path, body, userId = 1, companyId = 1) => {
    const response = await fetch(base + path, { method,
      headers: { 'content-type': 'application/json', 'x-company-id': String(companyId), 'x-user-id': String(userId) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, data: await response.json() };
  };
  return { db, api };
}

const incoming = { gstinId: 1, branchId: 1, partyId: 2, itemId: 1,
  direction: 'incoming', reference: 'CON-IN-001', quantity: 10, reason: 'Supplier trial goods' };
const outgoing = { gstinId: 1, branchId: 1, partyId: 1, itemId: 1,
  direction: 'outgoing', reference: 'CON-OUT-001', quantity: 5, reason: 'Customer shelf trial' };
const count = (db, table) => db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
const balance = db => db.prepare('SELECT COALESCE(SUM(quantity_delta),0) AS n FROM stock_movements WHERE company_id=1 AND branch_id=1 AND item_id=1').get().n;

test('incoming receipt and unsold return change custody without owned stock, invoice, GST, or ledger entries', async t => {
  const { db, api } = await fixture(t);
  const before = { stock: balance(db), invoices: count(db, 'invoices'), movements: count(db, 'stock_movements'),
    periods: db.prepare('SELECT group_concat(id || status) AS state FROM gst_periods').get().state,
    journals: count(db, 'journals') };
  const created = await api('POST', '/api/consignments', incoming);
  assert.equal(created.status, 200);
  assert.equal(created.data.consignment.ownerKind, 'party');
  const id = created.data.consignment.id;
  const received = await api('POST', `/api/consignments/${id}/activate`, { evidenceReference: 'SUP-GRN-01' });
  assert.equal(received.status, 200);
  assert.equal(received.data.consignment.custodian, 'company');
  assert.equal(received.data.consignment.custodyQuantity, 10);
  const returned = await api('POST', `/api/consignments/${id}/returns`,
    { quantity: 4, evidenceReference: 'SUP-RETURN-01', clientReference: 'IN-RETURN-01' });
  assert.equal(returned.status, 200);
  assert.equal(returned.data.consignment.custodyQuantity, 6);
  assert.equal((await api('POST', `/api/consignments/${id}/returns`,
    { quantity: 4, evidenceReference: 'SUP-RETURN-01', clientReference: 'IN-RETURN-01' })).data.replayed, true);
  assert.equal((await api('POST', `/api/consignments/${id}/returns`,
    { quantity: 7, evidenceReference: 'SUP-RETURN-02', clientReference: 'IN-RETURN-02' })).status, 409);
  assert.equal(balance(db), before.stock);
  assert.equal(count(db, 'stock_movements'), before.movements);
  assert.equal(count(db, 'invoices'), before.invoices);
  assert.equal(count(db, 'journals'), before.journals);
  assert.equal(db.prepare('SELECT group_concat(id || status) AS state FROM gst_periods').get().state, before.periods);
  assert.deepEqual((await api('GET', `/api/consignments/${id}`)).data.events.map(row => row.action),
    ['create', 'activate', 'unsold_return']);
});

test('outgoing dispatch and return affect saleable physical stock once, while owner remains company', async t => {
  const { db, api } = await fixture(t);
  const before = balance(db);
  const created = await api('POST', '/api/consignments', outgoing);
  assert.equal(created.status, 200);
  const id = created.data.consignment.id;
  assert.equal(balance(db), before);
  const dispatched = await api('POST', `/api/consignments/${id}/activate`, { evidenceReference: 'DISPATCH-01' });
  assert.equal(dispatched.status, 200);
  assert.equal(dispatched.data.consignment.ownerKind, 'company');
  assert.equal(dispatched.data.consignment.custodian, 'party');
  assert.equal(balance(db), before - 5);
  assert.equal((await api('POST', `/api/consignments/${id}/activate`, { evidenceReference: 'DISPATCH-01' })).data.replayed, true);
  assert.equal(balance(db), before - 5);
  assert.equal((await api('POST', `/api/consignments/${id}/returns`,
    { quantity: 2, evidenceReference: 'RETURN-01', clientReference: 'OUT-RETURN-01' })).status, 200);
  assert.equal(balance(db), before - 3);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM stock_movements WHERE type LIKE 'consignment_%'").get().n, 2);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM invoices WHERE number=?').get(outgoing.reference).n, 0);
});

test('settlement review is independent, reserves custody, and posts no taxable or ledger transaction', async t => {
  const { db, api } = await fixture(t);
  const id = (await api('POST', '/api/consignments', incoming)).data.consignment.id;
  await api('POST', `/api/consignments/${id}/activate`, { evidenceReference: 'GRN-SETTLE' });
  const invoiceCount = count(db, 'invoices');
  const journalCount = count(db, 'journals');
  const proposed = await api('POST', `/api/consignments/${id}/settlements`,
    { quantity: 6, proposedUnitPriceCents: 2500, reason: 'Four sold, two retained pending confirmation', clientReference: 'SET-01' });
  assert.equal(proposed.status, 200);
  const settlementId = proposed.data.settlement.id;
  assert.equal(proposed.data.consignment.returnableQuantity, 4);
  assert.equal((await api('POST', `/api/consignments/${id}/returns`,
    { quantity: 5, evidenceReference: 'RET-OVER', clientReference: 'RET-OVER' })).status, 409);
  assert.equal((await api('POST', `/api/consignments/${id}/settlements/${settlementId}/review`,
    { decision: 'approve', reason: 'Verified statement' })).status, 403);
  const reviewed = await api('POST', `/api/consignments/${id}/settlements/${settlementId}/review`,
    { decision: 'approve', reason: 'Verified statement' }, 2);
  assert.equal(reviewed.status, 200);
  assert.equal(reviewed.data.settlement.status, 'reviewed_pending_document');
  assert.equal(reviewed.data.consignment.ownerKind, 'party');
  assert.equal(reviewed.data.consignment.custodyQuantity, 10);
  assert.equal((await api('POST', `/api/consignments/${id}/settlements/${settlementId}/review`,
    { decision: 'approve', reason: 'Verified statement' }, 2)).data.replayed, true);
  assert.equal(count(db, 'invoices'), invoiceCount);
  assert.equal(count(db, 'journals'), journalCount);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM stock_movements WHERE type LIKE ?').get('consignment_%').n, 0);
});

test('company, GSTIN and branch grants isolate consignment records and writes', async t => {
  const { db, api } = await fixture(t);
  const id = (await api('POST', '/api/consignments', incoming)).data.consignment.id;
  assert.equal((await api('GET', `/api/consignments/${id}`, undefined, 4, 2)).status, 404);
  assert.equal((await api('POST', `/api/consignments/${id}/activate`, { evidenceReference: 'BAD' }, 4, 2)).status, 404);
  assert.equal((await api('POST', '/api/consignments', { ...incoming, reference: 'BAD-SCOPE', branchId: 3 })).status, 400);
  const restricted = Number(db.prepare("INSERT INTO users(company_id,name,role) VALUES (1,'Restricted storekeeper','staff')").run().lastInsertRowid);
  assert.equal((await api('GET', `/api/consignments/${id}`, undefined, restricted)).status, 403);
  assert.equal((await api('POST', '/api/consignments', { ...incoming, reference: 'BAD-GRANT' }, restricted)).status, 403);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM consignments WHERE reference LIKE 'BAD-%'").get().n, 0);
});

test('synthetic consignment specimens seed once with custody conservation and no commercial posting', async t => {
  const { db, api } = await fixture(t);
  const outgoingStock = () => db.prepare('SELECT COALESCE(SUM(quantity_delta),0) AS n FROM stock_movements WHERE company_id=1 AND branch_id=1 AND item_id=3').get().n;
  const before = { stock: balance(db), invoices: count(db, 'invoices'), journals: count(db, 'journals'),
    outgoingStock: outgoingStock(), periodState: db.prepare('SELECT group_concat(id || status) AS state FROM gst_periods').get().state };
  const first = seedConsignmentDemo(db);
  assert.equal(first.seeded, true);
  assert.ok(first.incomingId && first.outgoingId);
  const incomingDetail = (await api('GET', `/api/consignments/${first.incomingId}`)).data;
  const outgoingDetail = (await api('GET', `/api/consignments/${first.outgoingId}`)).data;
  assert.equal(incomingDetail.consignment.status, 'active');
  assert.equal(incomingDetail.consignment.ownerKind, 'party');
  assert.equal(incomingDetail.consignment.custodyQuantity, 6);
  assert.equal(incomingDetail.consignment.returnedQuantity, 2);
  assert.equal(incomingDetail.consignment.settlementReservedQuantity, 3);
  assert.equal(incomingDetail.consignment.returnableQuantity, 3);
  assert.equal(incomingDetail.settlements[0].status, 'reviewed_pending_document');
  assert.equal(incomingDetail.settlements[0].proposedBy === incomingDetail.settlements[0].reviewedBy, false);
  assert.equal(outgoingDetail.consignment.ownerKind, 'company');
  assert.equal(outgoingDetail.consignment.custodyQuantity, 2);
  assert.equal(outgoingDetail.consignment.returnedQuantity, 1);
  assert.equal(balance(db), before.stock);
  assert.equal(outgoingStock(), before.outgoingStock - 2);
  assert.equal(count(db, 'invoices'), before.invoices);
  assert.equal(count(db, 'journals'), before.journals);
  assert.equal(db.prepare('SELECT group_concat(id || status) AS state FROM gst_periods').get().state, before.periodState);
  const snapshots = ['consignments','consignment_returns','consignment_settlements','consignment_events','stock_movements']
    .map(table => count(db, table));
  const second = seedConsignmentDemo(db);
  assert.equal(second.seeded, false);
  assert.equal(second.incomingId, first.incomingId);
  assert.equal(second.outgoingId, first.outgoingId);
  assert.deepEqual(['consignments','consignment_returns','consignment_settlements','consignment_events','stock_movements']
    .map(table => count(db, table)), snapshots);
  assert.ok(incomingDetail.events.every(row => row.details.includes('SYNTHETIC DEMO ONLY')));
  assert.ok(outgoingDetail.events.every(row => row.details.includes('SYNTHETIC DEMO ONLY')));
});
