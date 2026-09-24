import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createApp } = require('../api.cjs');
const { openDatabase } = require('../db.cjs');

test('hold blocks new over-limit sales commitments while warn remains advisory', async t => {
  const db = openDatabase(':memory:');
  const server = createApp({ db }).listen(0);
  t.after(() => { server.close(); db.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const api = async (method, path, body, userId = 1) => {
    const response = await fetch(base + path, { method, headers: { 'content-type': 'application/json', 'x-company-id': '1', 'x-user-id': String(userId) }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, data: await response.json() };
  };
  const scope = { gstinId: 1, branchId: 1, partyId: 1 };
  const policy = { ...scope, baseLimitCents: 1, mode: 'hold', expectedVersion: 0, reason: 'Block new commitments' };
  assert.equal((await api('PUT', '/api/credit/policies', policy, 3)).status, 200);

  const order = (await api('POST', '/api/orders', { ...scope, type: 'sale', number: 'SO-CREDIT-GATE', orderDate: new Date().toISOString().slice(0,10), lines: [{ itemId: 1, quantity: 1, unitPriceCents: 1000 }] })).data.order;
  const blockedOrder = await api('POST', `/api/orders/${order.id}/confirm`, {});
  assert.equal(blockedOrder.status, 409);
  assert.match(blockedOrder.data.error, /credit limit/i);
  assert.equal(db.prepare('SELECT status FROM orders WHERE id=?').get(order.id).status, 'draft');

  const invoice = (await api('POST', '/api/invoices', { ...scope, type: 'sale', invoiceDate: new Date().toISOString().slice(0,10), lines: [{ itemId: 1, quantity: 1, unitPriceCents: 1000, gstRateBps: 1200 }] })).data.invoice;
  const blockedInvoice = await api('POST', `/api/invoices/${invoice.id}/submit`, {});
  assert.equal(blockedInvoice.status, 409);
  assert.match(blockedInvoice.data.error, /credit limit/i);
  assert.equal(db.prepare('SELECT status FROM invoices WHERE id=?').get(invoice.id).status, 'draft');

  assert.equal((await api('PUT', '/api/credit/policies', { ...policy, mode: 'warn', expectedVersion: 1 }, 3)).status, 200);
  assert.equal((await api('POST', `/api/orders/${order.id}/confirm`, {})).status, 200);
  assert.equal((await api('POST', `/api/invoices/${invoice.id}/submit`, {})).status, 200);

  const fulfillment = (await api('POST', `/api/orders/${order.id}/fulfillments`, {
    number: 'DC-CREDIT-GATE', eventDate: new Date().toISOString().slice(0,10),
    lines: [{ orderLineId: order.lines[0].id, quantity: 1 }],
  })).data.fulfillment;
  assert.equal((await api('POST', `/api/orders/fulfillments/${fulfillment.id}/confirm`, {})).status, 200);
  const linked = (await api('POST', '/api/invoices', { ...scope, type: 'sale', fulfillmentId: fulfillment.id,
    invoiceDate: new Date().toISOString().slice(0,10),
    lines: [{ itemId: 1, quantity: 1, unitPriceCents: 1000, gstRateBps: order.lines[0].gstRateBps }],
  })).data.invoice;
  assert.ok(linked?.id);
  assert.equal((await api('PUT', '/api/credit/policies', { ...policy, expectedVersion: 2 }, 3)).status, 200);
  const exposureBefore = (await api('GET', '/api/credit/parties/1/assessment?gstinId=1&branchId=1')).data.assessment.exposure.totalCents;
  assert.equal((await api('POST', `/api/invoices/${linked.id}/submit`, {})).status, 200);
  const exposureAfter = (await api('GET', '/api/credit/parties/1/assessment?gstinId=1&branchId=1')).data.assessment.exposure.totalCents;
  assert.equal(exposureAfter, exposureBefore);
});
