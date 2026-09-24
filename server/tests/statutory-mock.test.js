import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const express = require('express');
const { openDatabase } = require('../db.cjs');
const { registerStatutoryMockRoutes } = require('../statutory-mock.cjs');

async function fixture(t) {
  const db = openDatabase(':memory:');
  const app = express();
  app.use(express.json());
  app.use('/api', (req, res, next) => {
    const companyId = Number(req.header('x-company-id') || 1);
    const userId = Number(req.header('x-user-id') || 1);
    req.company = db.prepare('SELECT * FROM companies WHERE id=?').get(companyId);
    req.user = db.prepare('SELECT * FROM users WHERE id=? AND company_id=?').get(userId, companyId);
    if (!req.company || !req.user) return res.status(403).json({ error: 'Unknown company or user' });
    next();
  });
  registerStatutoryMockRoutes(app, db);
  app.use((error, _req, res, _next) => res.status(error.status || 500).json({ error: error.message }));
  const server = app.listen(0);
  t.after(() => { server.close(); db.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const api = async (method, path, body, companyId = 1, userId = 1) => {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: { 'content-type': 'application/json', 'x-company-id': String(companyId), 'x-user-id': String(userId) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, data: await response.json() };
  };
  return { db, api };
}

test('all scenarios persist as explicit simulations without changing invoice or period status', async t => {
  const { db, api } = await fixture(t);
  const invoiceBefore = db.prepare('SELECT * FROM invoices WHERE id=1').get();
  const period = db.prepare('SELECT * FROM gst_periods WHERE company_id=1 AND gstin_id=1 LIMIT 1').get();
  db.prepare("UPDATE gst_periods SET status='approved',approved_by=2 WHERE id=?").run(period.id);
  const periodBefore = db.prepare('SELECT * FROM gst_periods WHERE id=?').get(period.id);
  const cases = [
    { kind: 'irn', sourceId: 1, scenario: 'success', actor: 1 },
    { kind: 'eway', sourceId: 1, scenario: 'rejection', actor: 1 },
    { kind: 'gst_return', sourceId: period.id, scenario: 'timeout', actor: 2 },
  ];
  for (const [index, item] of cases.entries()) {
    const response = await api('POST', '/api/simulations', {
      kind: item.kind, gstinId: 1, sourceId: item.sourceId,
      scenario: item.scenario, idempotencyKey: `scenario-${index}`,
    }, 1, item.actor);
    assert.equal(response.status, 200);
    assert.equal(response.data.replayed, false);
    assert.equal(response.data.simulation.simulation, true);
    assert.equal(response.data.simulation.status, `simulated_${item.scenario}`);
    assert.match(response.data.simulation.reference, /^SIM-/);
    assert.equal(response.data.simulation.response.reference, response.data.simulation.reference);
    assert.equal(response.data.simulation.actorId, item.actor);
    assert.ok(response.data.simulation.createdAt);
  }
  assert.deepEqual(db.prepare('SELECT * FROM invoices WHERE id=1').get(), invoiceBefore);
  assert.deepEqual(db.prepare('SELECT * FROM gst_periods WHERE id=?').get(period.id), periodBefore);
  assert.equal((await api('GET', '/api/simulations?gstinId=1')).data.simulations.length, 3);
});

test('idempotency replays the same record and rejects changed content within a company', async t => {
  const { db, api } = await fixture(t);
  const request = { kind: 'irn', gstinId: 1, sourceId: 1, scenario: 'success', idempotencyKey: 'create-one' };
  const first = await api('POST', '/api/simulations', request);
  const replay = await api('POST', '/api/simulations', request);
  assert.equal(first.status, 200);
  assert.equal(replay.data.replayed, true);
  assert.deepEqual(replay.data.simulation, first.data.simulation);
  assert.equal((await api('POST', '/api/simulations', { ...request, scenario: 'timeout' })).status, 409);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM statutory_simulations').get().count, 1);
});

test('company, GSTIN, source approval, and role boundaries are enforced', async t => {
  const { db, api } = await fixture(t);
  const request = { kind: 'irn', gstinId: 1, sourceId: 1, scenario: 'success', idempotencyKey: 'scope' };
  assert.equal((await api('POST', '/api/simulations', { ...request, gstinId: 3 })).status, 404);
  assert.equal((await api('POST', '/api/simulations', { ...request, sourceId: 999 })).status, 404);
  assert.equal((await api('POST', '/api/simulations', { ...request, kind: 'gst_return' })).status, 403);
  const period = db.prepare("SELECT id FROM gst_periods WHERE company_id=1 AND gstin_id=1 AND status='open' LIMIT 1").get();
  assert.equal((await api('POST', '/api/simulations', { ...request, kind: 'gst_return', sourceId: period.id }, 1, 2)).status, 409);
  const secondCompanyPeriod = db.prepare('SELECT id FROM gst_periods WHERE company_id=2 LIMIT 1').get();
  assert.equal((await api('POST', '/api/simulations', { ...request, kind: 'gst_return', sourceId: secondCompanyPeriod.id }, 1, 2)).status, 404);
  assert.equal((await api('GET', '/api/simulations?gstinId=3')).status, 404);
  assert.equal((await api('POST', '/api/simulations', request)).status, 200);
  assert.equal((await api('GET', '/api/simulations', undefined, 2, 5)).data.simulations.length, 0);
  assert.equal((await api('POST', '/api/simulations', { ...request, gstinId: 3, sourceId: 1 }, 2, 5)).status, 404);
  assert.equal((await api('GET', '/api/simulations?gstinId=1', undefined, 2, 5)).status, 404);
});

test('GST return simulations require every branch of the registration for writes and reads', async t => {
  const { db, api } = await fixture(t);
  const period = db.prepare('SELECT id FROM gst_periods WHERE company_id=1 AND gstin_id=1 LIMIT 1').get();
  db.prepare("UPDATE gst_periods SET status='approved',approved_by=3 WHERE id=?").run(period.id);
  const request = { kind: 'gst_return', gstinId: 1, sourceId: period.id,
    scenario: 'success', idempotencyKey: 'full-registration-only' };
  assert.equal((await api('POST', '/api/simulations', request, 1, 2)).status, 200);
  assert.equal((await api('POST', '/api/simulations', {
    kind: 'irn', gstinId: 1, sourceId: 1, scenario: 'success', idempotencyKey: 'invoice-branch-only',
  }, 1, 2)).status, 200);

  const branches = db.prepare('SELECT id FROM branches WHERE company_id=1 AND gstin_id=1 ORDER BY id').all();
  assert.ok(branches.length > 1);
  db.prepare("UPDATE user_branch_grants SET revoked_at=CURRENT_TIMESTAMP,revoked_by=3,revoked_reason='Scoped test' WHERE company_id=1 AND user_id=2 AND branch_id=?")
    .run(branches.at(-1).id);

  assert.equal((await api('POST', '/api/simulations', request, 1, 2)).status, 403);
  const scoped = await api('GET', '/api/simulations?gstinId=1', undefined, 1, 2);
  assert.equal(scoped.status, 200);
  assert.deepEqual(scoped.data.simulations.map(row => row.kind), ['irn']);
  assert.deepEqual((await api('GET', '/api/simulations', undefined, 1, 2)).data.simulations.map(row => row.kind), ['irn']);
});
