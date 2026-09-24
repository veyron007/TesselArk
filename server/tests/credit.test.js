import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { openDatabase } = require('../db.cjs');
const { registerCreditRoutes } = require('../credit.cjs');

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
    next();
  });
  registerCreditRoutes(app, db);
  app.use((error, _req, res, _next) => res.status(error.status || 500).json({ error: error.message }));
  const server = app.listen(0);
  t.after(() => { server.close(); db.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const api = async (method, path, body, userId = 1, companyId = 1) => {
    const response = await fetch(base + path, {
      method, headers: { 'content-type': 'application/json', 'x-company-id': String(companyId), 'x-user-id': String(userId) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, data: await response.json() };
  };
  return { db, api };
}

const scope = { gstinId: 1, branchId: 1, partyId: 1 };
const policy = { ...scope, baseLimitCents: 500000, mode: 'hold', reason: 'Approved branch customer limit', expectedVersion: 0 };
const requestBody = () => {
  const start = new Date();
  start.setUTCDate(start.getUTCDate() + 1);
  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + 7);
  return { ...scope, additionalLimitCents: 100000, validFrom: start.toISOString().slice(0, 10),
    validThrough: end.toISOString().slice(0, 10), reason: 'Seasonal purchase order', clientReference: 'TEMP-1' };
};

test('policy requires admin, scoped identity, optimistic version and an audit trail', async t => {
  const { api } = await fixture(t);
  assert.equal((await api('PUT','/api/credit/policies',policy)).status,403);
  assert.equal((await api('PUT','/api/credit/policies',{...policy,branchId:3},3)).status,400);
  const created = await api('PUT','/api/credit/policies',policy,3);
  assert.equal(created.status,200);
  assert.equal(created.data.policy.version,1);
  assert.equal(created.data.assessment.enforcement,'hold_on_new_commitments');
  assert.equal((await api('PUT','/api/credit/policies',policy,3)).status,409);
  const changed = await api('PUT','/api/credit/policies',{...policy,baseLimitCents:600000,expectedVersion:1},3);
  assert.equal(changed.status,200);
  assert.equal(changed.data.policy.version,2);
  const audit = await api('GET','/api/credit/parties/1/events?gstinId=1&branchId=1');
  assert.deepEqual(audit.data.events.map(row => row.action),['policy_created','policy_updated']);
});

test('temporary limit review is independent, replay safe and expires without deleting history', async t => {
  const { api } = await fixture(t);
  assert.equal((await api('PUT','/api/credit/policies',policy,3)).status,200);
  const body = requestBody();
  const created = await api('POST','/api/credit/requests',body);
  assert.equal(created.status,200);
  assert.equal((await api('POST','/api/credit/requests',body)).data.replayed,true);
  assert.equal((await api('POST','/api/credit/requests',{...body,additionalLimitCents:200000})).status,409);
  const requestId = created.data.request.id;
  assert.equal((await api('POST',`/api/credit/requests/${requestId}/review`,{decision:'approve',reason:'Verified need'})).status,403);
  const reviewed = await api('POST',`/api/credit/requests/${requestId}/review`,{decision:'approve',reason:'Verified need'},2);
  assert.equal(reviewed.status,200);
  assert.equal(reviewed.data.request.reviewedBy,2);
  assert.equal((await api('POST',`/api/credit/requests/${requestId}/review`,{decision:'approve',reason:'Verified need'},2)).data.replayed,true);
  assert.equal((await api('POST',`/api/credit/requests/${requestId}/review`,{decision:'reject',reason:'Changed mind'},3)).status,409);
  const atStart = await api('GET',`/api/credit/parties/1/assessment?gstinId=1&branchId=1&asOf=${body.validFrom}`);
  assert.equal(atStart.data.assessment.effectiveLimitCents,600000);
  const after = new Date(`${body.validThrough}T00:00:00Z`);
  after.setUTCDate(after.getUTCDate()+1);
  const expired = await api('GET',`/api/credit/parties/1/assessment?gstinId=1&branchId=1&asOf=${after.toISOString().slice(0,10)}`);
  assert.equal(expired.data.assessment.activeTemporaryLimit,null);
  assert.equal(expired.data.assessment.effectiveLimitCents,500000);
  assert.equal((await api('GET','/api/credit/overview?gstinId=1&branchId=1')).data.requests[0].status,'approved');
});

test('overlapping approvals serialize and rejected requests do not add available credit', async t => {
  const { db, api } = await fixture(t);
  await api('PUT','/api/credit/policies',policy,3);
  const first = requestBody();
  const second = { ...first, clientReference:'TEMP-2',additionalLimitCents:200000 };
  const a = (await api('POST','/api/credit/requests',first)).data.request.id;
  const b = (await api('POST','/api/credit/requests',second)).data.request.id;
  const results = await Promise.all([
    api('POST',`/api/credit/requests/${a}/review`,{decision:'approve',reason:'First reviewed'},2),
    api('POST',`/api/credit/requests/${b}/review`,{decision:'approve',reason:'Second reviewed'},3),
  ]);
  assert.deepEqual(results.map(row=>row.status).sort(),[200,409]);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM credit_requests WHERE status='approved'").get().n,1);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM credit_events WHERE action='request_approved'").get().n,1);
  const pendingId = results[0].status === 409 ? a : b;
  const rejected = await api('POST',`/api/credit/requests/${pendingId}/review`,{decision:'reject',reason:'Overlapping override'},2);
  assert.equal(rejected.status,200);
  const atStart = await api('GET',`/api/credit/parties/1/assessment?gstinId=1&branchId=1&asOf=${first.validFrom}`);
  assert.equal(atStart.data.assessment.effectiveLimitCents,results[0].status===200?600000:700000);
});

test('exposure nets approved payments and settlements, keeps cheques, and excludes linked order double count', async t => {
  const { db, api } = await fixture(t);
  await api('PUT','/api/credit/policies',policy,3);
  const initial = (await api('GET','/api/credit/parties/1/assessment?gstinId=1&branchId=1')).data.assessment.exposure;
  const invoice = db.prepare("SELECT id FROM invoices WHERE company_id=1 AND gstin_id=1 AND branch_id=1 AND party_id=1 AND type='sale' AND status='approved' ORDER BY total_cents DESC LIMIT 1").get();
  assert.ok(invoice);
  db.prepare("INSERT INTO invoice_payments(company_id,invoice_id,amount_cents,method,reference,payment_date,recorded_by) VALUES (1,?,10000,'bank','CREDIT-BANK','2026-09-24',2)").run(invoice.id);
  const afterBank = (await api('GET','/api/credit/parties/1/assessment?gstinId=1&branchId=1')).data.assessment.exposure;
  assert.equal(afterBank.totalCents,initial.totalCents-10000);
  db.prepare("INSERT INTO invoice_payments(company_id,invoice_id,amount_cents,method,reference,payment_date,recorded_by) VALUES (1,?,5000,'cheque','CREDIT-CHEQUE','2026-09-24',2)").run(invoice.id);
  const afterCheque = (await api('GET','/api/credit/parties/1/assessment?gstinId=1&branchId=1')).data.assessment.exposure;
  assert.equal(afterCheque.totalCents,afterBank.totalCents);
  assert.equal(afterCheque.unclearedChequeCents,afterBank.unclearedChequeCents+5000);
  assert.ok(afterCheque.orders.every(order => order.exposureCents === order.orderedCents-order.linkedInvoiceCents));
});

test('company and branch grants isolate policy, requests, assessment and events', async t => {
  const { db, api } = await fixture(t);
  await api('PUT','/api/credit/policies',policy,3);
  await api('POST','/api/credit/requests',requestBody());
  assert.equal((await api('GET','/api/credit/overview?gstinId=1&branchId=1',undefined,4,2)).status,400);
  assert.equal((await api('GET','/api/credit/parties/1/assessment?gstinId=1&branchId=1',undefined,4,2)).status,400);
  assert.equal((await api('GET','/api/credit/parties/1/events?gstinId=1&branchId=1',undefined,4,2)).status,400);
  const deniedId = Number(db.prepare("INSERT INTO users(company_id,name,role) VALUES (1,'Credit restricted','accountant')").run().lastInsertRowid);
  assert.equal((await api('GET','/api/credit/overview?gstinId=1&branchId=1',undefined,deniedId)).status,403);
  assert.equal((await api('POST','/api/credit/requests',{...requestBody(),clientReference:'DENIED'},deniedId)).status,403);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM credit_requests WHERE client_reference='DENIED'").get().n,0);
  const other = await api('GET','/api/credit/overview?gstinId=3&branchId=4',undefined,4,2);
  assert.equal(other.status,200);
  assert.equal(other.data.policies.length,0);
  const otherBranch = await api('GET','/api/credit/parties/1/assessment?gstinId=1&branchId=2');
  assert.equal(otherBranch.status,200);
  assert.equal(otherBranch.data.assessment.policy,null);
  assert.equal(otherBranch.data.assessment.effectiveLimitCents,null);
});

test('unsafe money, expired approvals and effective-limit overflow cannot change credit', async t => {
  const { db, api } = await fixture(t);
  await api('PUT','/api/credit/policies',policy,3);
  assert.equal((await api('PUT','/api/credit/policies',{...policy,expectedVersion:1,baseLimitCents:Number.MAX_SAFE_INTEGER+1},3)).status,400);
  assert.equal((await api('POST','/api/credit/requests',{...requestBody(),additionalLimitCents:1.5})).status,400);
  const huge = { ...requestBody(),clientReference:'TEMP-HUGE',additionalLimitCents:Number.MAX_SAFE_INTEGER };
  const created = await api('POST','/api/credit/requests',huge);
  assert.equal(created.status,200);
  assert.equal((await api('POST',`/api/credit/requests/${created.data.request.id}/review`,{decision:'approve',reason:'Too high'},2)).status,409);
  assert.equal(db.prepare('SELECT status FROM credit_requests WHERE id=?').get(created.data.request.id).status,'pending');
  const past = { ...requestBody(),clientReference:'TEMP-PAST',validFrom:'2020-01-01',validThrough:'2020-01-02' };
  const expired = await api('POST','/api/credit/requests',past);
  assert.equal(expired.status,200);
  assert.equal((await api('POST',`/api/credit/requests/${expired.data.request.id}/review`,{decision:'approve',reason:'Expired'},2)).status,409);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM credit_events WHERE action='request_approved'").get().n,0);
});

test('a later approval never changes credit availability for an earlier assessment date', async t => {
  const { api } = await fixture(t);
  const today = new Date().toISOString().slice(0,10);
  const yesterday = new Date(Date.now()-86400000).toISOString().slice(0,10);
  const tomorrow = new Date(Date.now()+86400000).toISOString().slice(0,10);
  await api('PUT','/api/credit/policies',policy,3);
  const created = await api('POST','/api/credit/requests',{
    ...requestBody(),clientReference:'TEMP-HISTORICAL',validFrom:yesterday,validThrough:tomorrow,
  });
  assert.equal(created.status,200);
  assert.equal((await api('POST',`/api/credit/requests/${created.data.request.id}/review`,{decision:'approve',reason:'Valid from review date'},2)).status,200);
  const before = (await api('GET',`/api/credit/parties/1/assessment?gstinId=1&branchId=1&asOf=${yesterday}`)).data.assessment;
  const current = (await api('GET',`/api/credit/parties/1/assessment?gstinId=1&branchId=1&asOf=${today}`)).data.assessment;
  assert.equal(before.activeTemporaryLimit,null);
  assert.equal(before.effectiveLimitCents,policy.baseLimitCents);
  assert.equal(current.activeTemporaryLimit.effectiveFrom,today);
  assert.equal(current.effectiveLimitCents,policy.baseLimitCents+100000);
});
