import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import express from 'express';

const require = createRequire(import.meta.url);
const { openDatabase } = require('../db.cjs');
const { installCashierSchema } = require('../cashier-db.cjs');
const { registerCashierRoutes } = require('../cashier.cjs');

async function fixture(t) {
  const db = openDatabase(':memory:');
  installCashierSchema(db);
  const app = express();
  app.use(express.json());
  app.use('/api', (req, _res, next) => {
    const companyId = Number(req.header('x-company-id') || 1);
    const userId = Number(req.header('x-user-id') || 1);
    req.company = db.prepare('SELECT * FROM companies WHERE id=?').get(companyId);
    req.user = db.prepare('SELECT * FROM users WHERE id=? AND company_id=?').get(userId, companyId);
    if (!req.company || !req.user) return next(Object.assign(new Error('Unknown context'), { status: 403 }));
    next();
  });
  registerCashierRoutes(app, db);
  app.use((error, _req, res, _next) => res.status(error.status || 500).json({ error: error.message }));
  const server = app.listen(0);
  t.after(() => { server.close(); db.close(); });
  const api = async (method, path, body, companyId = 1, userId = 1) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`, {
      method,
      headers: { 'content-type': 'application/json', 'x-company-id': String(companyId), 'x-user-id': String(userId) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, data: await response.json() };
  };
  return { db, api };
}

test('cashier reconciles only explicitly assigned cash payments and typed payouts', async t => {
  const { db, api } = await fixture(t);
  const businessDate = '2026-09-24';
  db.prepare("INSERT INTO invoice_payments(company_id,invoice_id,amount_cents,method,reference,payment_date,recorded_by) VALUES (1,1,2500,'cash','CASHIER-TEST-1',?,2)").run(businessDate);
  const eligible = await api('GET', `/api/cashier/eligible-payments?branchId=1&businessDate=${businessDate}`);
  assert.equal(eligible.status, 200);
  assert.equal(eligible.data.payments.length, 1);
  const opened = await api('POST', '/api/cashier/sessions', { branchId: 1, businessDate, openingCashCents: 10000 });
  assert.equal(opened.status, 200);
  const id = opened.data.session.id;
  assert.equal(opened.data.session.expectedCashCents, 10000);
  assert.equal((await api('POST', `/api/cashier/sessions/${id}/assignments`, { paymentId: eligible.data.payments[0].id })).status, 200);
  assert.equal((await api('POST', `/api/cashier/sessions/${id}/assignments`, { paymentId: eligible.data.payments[0].id })).status, 409);
  assert.equal((await api('GET', `/api/cashier/eligible-payments?branchId=1&businessDate=${businessDate}`)).data.payments.length, 0);
  assert.equal((await api('POST', `/api/cashier/sessions/${id}/payouts`, { kind: 'expense', amountCents: 500, reference: 'PETTY-1', notes: 'Stationery' })).status, 200);
  const detail = await api('GET', `/api/cashier/sessions/${id}`);
  assert.equal(detail.data.session.expectedCashCents, 12000);
  assert.equal(detail.data.events.length, 3);
  const close = await api('POST', `/api/cashier/sessions/${id}/close`, { countedCashCents: 12000, notes: 'Counted twice' });
  assert.equal(close.status, 200);
  assert.equal(close.data.session.status, 'closed');
  assert.equal((await api('POST', `/api/cashier/sessions/${id}/payouts`, { kind: 'expense', amountCents: 1, reference: 'LATE' })).status, 409);
});

test('discrepancy needs independent accountant decision with audit trail', async t => {
  const { api } = await fixture(t);
  const opened = await api('POST', '/api/cashier/sessions', { branchId: 2, businessDate: '2026-09-24', openingCashCents: 2000 });
  const id = opened.data.session.id;
  const close = await api('POST', `/api/cashier/sessions/${id}/close`, { countedCashCents: 1900, notes: 'Short by one rupee' });
  assert.equal(close.data.session.status, 'pending_review');
  assert.equal(close.data.session.discrepancyCents, -100);
  assert.equal((await api('POST', `/api/cashier/sessions/${id}/review`, { decision: 'approve', reason: 'Verified count' })).status, 403);
  assert.equal((await api('POST', `/api/cashier/sessions/${id}/review`, { decision: 'approve', reason: 'Verified count' }, 1, 2)).status, 200);
  const detail = await api('GET', `/api/cashier/sessions/${id}`);
  assert.equal(detail.data.session.status, 'closed');
  assert.equal(detail.data.session.reviewedBy, 2);
  assert.equal(detail.data.events.at(-1).action, 'discrepancy_approved');
});

test('cashier rejects wrong branch, company, date, method, and duplicate active drawer', async t => {
  const { db, api } = await fixture(t);
  const created = await api('POST', '/api/cashier/sessions', { branchId: 1, businessDate: '2026-09-24', openingCashCents: 0 });
  const id = created.data.session.id;
  assert.equal((await api('POST', '/api/cashier/sessions', { branchId: 1, businessDate: '2026-09-24', openingCashCents: 0 })).status, 409);
  assert.equal((await api('GET', `/api/cashier/sessions/${id}`, undefined, 2, 5)).status, 404);
  assert.equal((await api('POST', '/api/cashier/sessions', { branchId: 4, businessDate: '2026-09-24', openingCashCents: 0 })).status, 404);
  assert.equal((await api('POST', '/api/cashier/sessions', { branchId: 2, businessDate: '2026-02-30', openingCashCents: 0 })).status, 400);
  assert.equal((await api('GET', '/api/cashier/eligible-payments?branchId=1&businessDate=2026-99-99')).status, 400);
  db.prepare("INSERT INTO invoice_payments(company_id,invoice_id,amount_cents,method,reference,payment_date,recorded_by) VALUES (1,1,100,'bank','CASHIER-BANK', '2026-09-24',2)").run();
  const bankPayment = db.prepare("SELECT id FROM invoice_payments WHERE reference='CASHIER-BANK'").get();
  assert.equal((await api('POST', `/api/cashier/sessions/${id}/assignments`, { paymentId: bankPayment.id })).status, 409);
  assert.equal((await api('POST', `/api/cashier/sessions/${id}/payouts`, { kind: 'refund', amountCents: 1, reference: 'TOO-MUCH' })).status, 409);
});

test('rejected discrepancy reopens drawer and retains immutable review events', async t => {
  const { api } = await fixture(t);
  const created = await api('POST', '/api/cashier/sessions', { branchId: 2, businessDate: '2026-09-24', openingCashCents: 500 });
  const id = created.data.session.id;
  assert.equal((await api('POST', `/api/cashier/sessions/${id}/close`, { countedCashCents: 400, notes: 'Count one' })).data.session.status, 'pending_review');
  assert.equal((await api('POST', `/api/cashier/sessions/${id}/payouts`, { kind: 'expense', amountCents: 1, reference: 'LOCKED' })).status, 409);
  const rejected = await api('POST', `/api/cashier/sessions/${id}/review`, { decision: 'reject', reason: 'Recount required' }, 1, 2);
  assert.equal(rejected.data.session.status, 'open');
  assert.equal(rejected.data.session.countedCashCents, null);
  const closed = await api('POST', `/api/cashier/sessions/${id}/close`, { countedCashCents: 500, notes: 'Recounted' });
  assert.equal(closed.data.session.status, 'closed');
  assert.equal(closed.data.session.reviewedBy, null);
  const detail = await api('GET', `/api/cashier/sessions/${id}`);
  assert.deepEqual(detail.data.events.map(row => row.action), ['opened', 'discrepancy_submitted', 'discrepancy_rejected', 'closed_balanced']);
});

test('close requires all eligible cash payments assigned and business date cannot reopen', async t => {
  const { db, api } = await fixture(t);
  const businessDate = '2026-09-24';
  const paymentId = Number(db.prepare(`INSERT INTO invoice_payments
    (company_id,invoice_id,amount_cents,method,reference,payment_date,recorded_by)
    VALUES (1,1,750,'cash','CASHIER-UNASSIGNED',?,2)`).run(businessDate).lastInsertRowid);
  const created = await api('POST', '/api/cashier/sessions', { branchId: 1, businessDate, openingCashCents: 1000 });
  const sessionId = created.data.session.id;
  assert.equal((await api('POST', `/api/cashier/sessions/${sessionId}/close`, { countedCashCents: 1000 })).status, 409);
  assert.equal((await api('GET', `/api/cashier/sessions/${sessionId}`)).data.session.status, 'open');
  assert.equal((await api('POST', `/api/cashier/sessions/${sessionId}/assignments`, { paymentId })).status, 200);
  assert.equal((await api('POST', `/api/cashier/sessions/${sessionId}/close`, { countedCashCents: 1750 })).status, 200);
  assert.equal((await api('POST', '/api/cashier/sessions', { branchId: 1, businessDate, openingCashCents: 0 })).status, 409);
  assert.equal((await api('POST', '/api/cashier/sessions', { branchId: 1, businessDate: '2026-09-25', openingCashCents: 0 })).status, 200);
});
