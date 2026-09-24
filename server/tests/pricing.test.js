import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const express = require('express');
const { openDatabase } = require('../db.cjs');
const { registerPricingRoutes } = require('../pricing.cjs');
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
  registerPricingRoutes(app, db);
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

const baseRule = { scope: 'company', rateCents: 10000, minDiscountBps: 0, defaultDiscountBps: 500, maxDiscountBps: 1000, effectiveFrom: '2026-01-01', effectiveTo: '2026-12-31', sourceReference: 'Price circular 2026', reason: 'Annual base rate' };
const quotePath = (itemId = 1, partyId = 1, date = '2026-09-24', branchId = 1) => `/api/pricing/quote?itemId=${itemId}&partyId=${partyId}&priceDate=${date}&branchId=${branchId}`;

test('dated precedence, paise rounding, overlap, validation and retirement', async t => {
  const { db, api } = await fixture(t);
  assert.equal((await api('GET', quotePath())).data.quote.hasPolicy, false);
  const base = await api('POST', '/api/pricing/rules', baseRule);
  assert.equal(base.status, 200, JSON.stringify(base.data));
  assert.equal((await api('POST', '/api/pricing/rules', { ...baseRule, effectiveFrom: '2026-06-01' })).status, 409);
  assert.equal((await api('POST', '/api/pricing/rules', { ...baseRule, defaultDiscountBps: 1100 })).status, 400);
  assert.equal((await api('POST', '/api/pricing/rules', { ...baseRule, effectiveFrom: '2026-02-30' })).status, 400);
  assert.equal((await api('POST', '/api/pricing/rules', { ...baseRule, effectiveFrom: '2026-13-01' })).status, 400);
  const item = await api('POST', '/api/pricing/rules', { ...baseRule, scope: 'item', itemId: 1, rateCents: 10001, defaultDiscountBps: 333, effectiveFrom: '2026-09-01', effectiveTo: '2026-09-30' });
  assert.equal(item.status, 200, JSON.stringify(item.data));
  const party = await api('POST', '/api/pricing/rules', { ...baseRule, scope: 'party', partyId: 1, rateCents: 11000 });
  assert.equal(party.status, 200, JSON.stringify(party.data));
  const exact = await api('POST', '/api/pricing/rules', { ...baseRule, scope: 'party_item', partyId: 1, itemId: 1, rateCents: 10001, defaultDiscountBps: 333 });
  assert.equal(exact.status, 200, JSON.stringify(exact.data));
  const current = (await api('GET', quotePath())).data.quote;
  assert.equal(current.rule.id, exact.data.rule.id);
  assert.equal(current.netRateCents, 9668);
  assert.equal((await api('GET', quotePath(1, 3))).data.quote.rule.id, item.data.rule.id);
  assert.equal((await api('GET', quotePath(2, 1))).data.quote.rule.id, party.data.rule.id);
  assert.equal((await api('GET', quotePath(1, 1, '2027-01-01'))).data.quote.hasPolicy, false);
  assert.equal((await api('POST', `/api/pricing/rules/${exact.data.rule.id}/retire`, { reason: 'Replaced circular' })).status, 200);
  assert.equal((await api('GET', quotePath())).data.quote.rule.id, party.data.rule.id);
  assert.deepEqual(db.prepare('SELECT action FROM pricing_rule_events WHERE rule_id=? ORDER BY id').all(exact.data.rule.id).map(row => row.action), ['created', 'retired']);
});

test('exception approval is scoped, independently decided, replay safe and audited', async t => {
  const { db, api } = await fixture(t);
  await api('POST', '/api/pricing/rules', baseRule);
  const proposal = { branchId: 1, itemId: 1, partyId: 1, priceDate: '2026-09-24', proposedRateCents: 9000, proposedDiscountBps: 1500, reason: 'Contract rate request', clientReference: 'REQ-1' };
  const create = await api('POST', '/api/pricing/exceptions', proposal, 1, 1);
  assert.equal(create.status, 200, JSON.stringify(create.data));
  const id = create.data.exception.id;
  assert.equal(create.data.exception.gstinId, 1);
  assert.equal(create.data.exception.baseline.rateCents, 10000);
  assert.equal((await api('POST', '/api/pricing/exceptions', proposal, 1, 1)).data.replayed, true);
  assert.equal((await api('POST', '/api/pricing/exceptions', { ...proposal, proposedRateCents: 8000 }, 1, 1)).status, 409);
  assert.equal((await api('POST', `/api/pricing/exceptions/${id}/decision`, { decision: 'approved', reason: 'Reviewed contract' }, 1, 1)).status, 403);
  const approval = await api('POST', `/api/pricing/exceptions/${id}/decision`, { decision: 'approved', reason: 'Reviewed contract' }, 1, 3);
  assert.equal(approval.status, 200, JSON.stringify(approval.data));
  assert.equal(approval.data.exception.status, 'approved');
  assert.equal((await api('POST', `/api/pricing/exceptions/${id}/decision`, { decision: 'approved', reason: 'Reviewed contract' })).data.replayed, true);
  assert.equal((await api('POST', `/api/pricing/exceptions/${id}/decision`, { decision: 'rejected', reason: 'No' })).status, 409);
  assert.deepEqual(db.prepare('SELECT action FROM pricing_exception_events WHERE exception_id=? ORDER BY id').all(id).map(row => row.action), ['requested', 'approved']);
  assert.equal((await api('GET', '/api/pricing/audit')).data.exceptionEvents.length, 2);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM invoices WHERE company_id=1').get().n > 0, true);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM invoice_lines WHERE unit_price_cents=9000').get().n, 0);
});

test('company, branch and role boundaries prevent cross-scope leakage', async t => {
  const { db, api } = await fixture(t);
  const created = await api('POST', '/api/pricing/rules', baseRule);
  assert.equal(created.status, 200);
  assert.equal((await api('GET', '/api/pricing/rules', undefined, 2, 8)).data.rules.length, 0);
  assert.equal((await api('POST', '/api/pricing/rules', { ...baseRule, itemId: 1, scope: 'item' }, 2, 8)).status, 404);
  assert.equal((await api('POST', '/api/pricing/rules', baseRule, 1, 1)).status, 403);
  assert.equal((await api('POST', '/api/pricing/rules', { ...baseRule, scope: 'party', partyId: 2 })).status, 400);
  assert.equal((await api('GET', quotePath(1, 1, '2026-09-24', 999))).status, 404);
  const proposal = { branchId: 1, itemId: 1, partyId: 1, priceDate: '2026-09-24', proposedRateCents: 10000, proposedDiscountBps: 500, reason: 'No change', clientReference: 'REQ-2' };
  assert.equal((await api('POST', '/api/pricing/exceptions', proposal, 1, 1)).status, 400);
  assert.equal((await api('POST', '/api/pricing/exceptions', { ...proposal, proposedDiscountBps: 1500, branchId: 999 }, 1, 1)).status, 404);
  const exception = await api('POST', '/api/pricing/exceptions', { ...proposal, proposedDiscountBps: 1500 }, 1, 1);
  assert.equal(exception.status, 200);
  assert.equal((await api('GET', '/api/pricing/exceptions', undefined, 2, 8)).data.exceptions.length, 0);
  assert.equal((await api('POST', `/api/pricing/exceptions/${exception.data.exception.id}/decision`, { decision: 'approved', reason: 'No' }, 2, 8)).status, 404);
  db.prepare("UPDATE user_branch_grants SET revoked_at=CURRENT_TIMESTAMP,revoked_by=3,revoked_reason='Test' WHERE company_id=1 AND user_id=3 AND branch_id=2").run();
  assert.equal((await api('POST', '/api/pricing/rules', { ...baseRule, effectiveFrom: '2027-01-01' })).status, 403);
  assert.equal((await api('POST', `/api/pricing/exceptions/${exception.data.exception.id}/decision`, { decision: 'approved', reason: 'No' })).status, 403);
});

test('policy replacement blocks stale approval while exact request replay keeps original snapshot', async t => {
  const { api } = await fixture(t);
  const rule = await api('POST', '/api/pricing/rules', baseRule);
  const proposal = { branchId: 1, itemId: 1, partyId: 1, priceDate: '2026-09-24', proposedRateCents: 9000, proposedDiscountBps: 1200, reason: 'Negotiated rate', clientReference: 'STALE-1' };
  const created = await api('POST', '/api/pricing/exceptions', proposal, 1, 1);
  assert.equal(created.status, 200);
  assert.equal((await api('POST', `/api/pricing/rules/${rule.data.rule.id}/retire`, { reason: 'New circular' })).status, 200);
  assert.equal((await api('POST', '/api/pricing/exceptions', proposal, 1, 1)).data.replayed, true);
  assert.equal((await api('POST', `/api/pricing/exceptions/${created.data.exception.id}/decision`, { decision: 'approved', reason: 'Old terms' })).status, 409);
  const replacement = await api('POST', '/api/pricing/rules', { ...baseRule, rateCents: 9500, sourceReference: 'Price circular replacement' });
  assert.equal(replacement.status, 200);
  assert.equal((await api('POST', `/api/pricing/exceptions/${created.data.exception.id}/decision`, { decision: 'approved', reason: 'Old terms' })).status, 409);
  assert.equal((await api('POST', `/api/pricing/exceptions/${created.data.exception.id}/decision`, { decision: 'rejected', reason: 'Policy changed' })).status, 200);
});

test('a pricing exception cannot receive approval for an earlier price date', async t => {
  const { api } = await fixture(t);
  const yesterday = new Date(Date.now()-86400000).toISOString().slice(0,10);
  const tomorrow = new Date(Date.now()+86400000).toISOString().slice(0,10);
  assert.equal((await api('POST','/api/pricing/rules',{
    ...baseRule,effectiveFrom:yesterday,effectiveTo:tomorrow,sourceReference:'Current temporary price circular',
  })).status,200);
  const created = await api('POST','/api/pricing/exceptions',{
    branchId:1,itemId:1,partyId:1,priceDate:yesterday,proposedRateCents:9000,
    proposedDiscountBps:1500,reason:'Late approval attempt',clientReference:'PAST-EX-1',
  },1,1);
  assert.equal(created.status,200);
  const approved = await api('POST',`/api/pricing/exceptions/${created.data.exception.id}/decision`,{
    decision:'approved',reason:'Too late',
  });
  assert.equal(approved.status,409);
  assert.equal((await api('GET','/api/pricing/exceptions')).data.exceptions[0].status,'pending');
});
