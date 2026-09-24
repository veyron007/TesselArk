import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createApp } = require('../api.cjs');
const { openDatabase } = require('../db.cjs');

test('workspace menu shows only actionable reviews in the granted branch', async t => {
  const db = openDatabase(':memory:');
  const server = createApp({ db }).listen(0);
  t.after(() => { server.close(); db.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const api = async (method, path, userId, body) => {
    const response = await fetch(`${base}${path}`, {
      method,
      headers:{ 'content-type':'application/json', 'x-company-id':'1', 'x-user-id':String(userId) },
      body:body === undefined ? undefined : JSON.stringify(body),
    });
    return { status:response.status, data:await response.json() };
  };
  const path = '/api/workspace-menu?gstinId=1&branchId=1';
  const before = await api('GET', path, 2);
  const otherBranchBefore = await api('GET', '/api/workspace-menu?gstinId=2&branchId=3', 2);
  assert.equal(before.status, 200);
  assert.deepEqual(before.data.access.gstins.map(row => row.id), [1, 2]);
  assert.equal(before.data.access.branches.some(row => row.id === 1), true);
  assert.equal((await api('GET', path, 1)).data.work.submittedInvoices, 0);

  const invoice = { type:'sale', partyId:1, branchId:1, gstinId:1,
    invoiceDate:new Date().toISOString().slice(0,10), lines:[{ itemId:1, quantity:1, unitPriceCents:1000 }] };
  const created = await api('POST', '/api/invoices', 1, invoice);
  assert.equal(created.status, 200);
  assert.equal((await api('POST', `/api/invoices/${created.data.invoice.id}/submit`, 1, {})).status, 200);
  const after = await api('GET', path, 2);
  assert.equal(after.data.work.submittedInvoices, before.data.work.submittedInvoices + 1);
  assert.equal((await api('GET', path, 1)).data.work.submittedInvoices, 0);
  assert.equal((await api('GET', '/api/workspace-menu?gstinId=2&branchId=3', 2)).data.work.submittedInvoices,
    otherBranchBefore.data.work.submittedInvoices);
  const proposal = await api('POST', '/api/gst-invoice-checks/policies', 1, {
    itemId:1, hsn:'3822', rateBps:1200, effectiveFrom:'2026-01-01',
    sourceReference:'Internal test source', reason:'Review before using this test policy',
  });
  assert.equal(proposal.status, 200);
  assert.equal((await api('GET', path, 2)).data.work.pendingTaxPolicies, before.data.work.pendingTaxPolicies + 1);
  assert.equal((await api('GET', path, 1)).data.work.pendingTaxPolicies, 0);

  db.prepare("UPDATE user_branch_grants SET revoked_by=3,revoked_at=CURRENT_TIMESTAMP,revoked_reason='Menu scope test' WHERE company_id=1 AND user_id=2 AND branch_id=1 AND revoked_at IS NULL").run();
  assert.equal((await api('GET', path, 2)).status, 403);
  const remaining = await api('GET', '/api/workspace-menu?gstinId=1&branchId=2', 2);
  assert.equal(remaining.status, 200);
  assert.equal(remaining.data.access.branches.some(row => row.id === 1), false);
  assert.equal(remaining.data.work.submittedInvoices, 0);
  assert.equal((await api('GET', '/api/workspace-menu?gstinId=1&branchId=3', 2)).status, 400);
  assert.equal((await api('GET', '/api/workspace-menu?branchId=abc', 2)).status, 400);
});
