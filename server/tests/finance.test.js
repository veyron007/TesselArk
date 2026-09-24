import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const { createApp } = require('../api.cjs');
const { openDatabase } = require('../db.cjs');

async function fixture(t) {
  const db = openDatabase(':memory:');
  const server = createApp({ db }).listen(0);
  t.after(() => { server.close(); db.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  return async (method, path, body, companyId = 1, userId = 1) => {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: { 'content-type': 'application/json', 'x-company-id': String(companyId), 'x-user-id': String(userId) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, data: await response.json() };
  };
}

const payment = (amountCents, reference) => ({ invoiceId: 1, amountCents, method: 'bank', reference, paymentDate: '2026-09-24' });

test('approved invoice balances update after partial and final allocations', async t => {
  const api = await fixture(t);
  const initial = await api('GET', '/api/finance/open?type=sale');
  assert.equal(initial.status, 200);
  assert.equal(initial.data.invoices.find(row => row.id === 1).outstandingCents, 22400);
  assert.equal((await api('POST', '/api/finance/payments', payment(10000, 'BANK-100'), 1, 1)).status, 403);
  const first = await api('POST', '/api/finance/payments', payment(10000, 'BANK-100'), 1, 2);
  assert.equal(first.status, 200);
  assert.equal(first.data.invoice.paidCents, 10000);
  assert.equal(first.data.invoice.outstandingCents, 12400);
  const second = await api('POST', '/api/finance/payments', payment(12400, 'BANK-101'), 1, 2);
  assert.equal(second.status, 200);
  assert.equal(second.data.invoice.outstandingCents, 0);
  const history = await api('GET', '/api/finance/payments?invoiceId=1');
  assert.equal(history.data.payments.length, 2);
  const current = await api('GET', '/api/finance/open?type=sale');
  assert.equal(current.data.invoices.find(row => row.id === 1).paidCents, 22400);
  assert.equal(current.data.invoices.find(row => row.id === 1).outstandingCents, 0);
});

test('duplicate references, overpayments, invalid dates, and drafts are rejected', async t => {
  const api = await fixture(t);
  assert.equal((await api('POST', '/api/finance/payments', payment(10000, 'BANK-100'), 1, 2)).status, 200);
  assert.equal((await api('POST', '/api/finance/payments', payment(1000, 'BANK-100'), 1, 2)).status, 409);
  assert.equal((await api('POST', '/api/finance/payments', payment(12401, 'BANK-101'), 1, 2)).status, 409);
  assert.equal((await api('POST', '/api/finance/payments', payment(0, 'BANK-102'), 1, 2)).status, 400);
  assert.equal((await api('POST', '/api/finance/payments', { ...payment(100, 'BANK-103'), paymentDate: '2026-02-30' }, 1, 2)).status, 400);
  const after = await api('GET', '/api/finance/payments?invoiceId=1');
  assert.equal(after.data.invoice.paidCents, 10000);
  const created = await api('POST', '/api/invoices', { type: 'sale', partyId: 1, branchId: 1, gstinId: 1, invoiceDate: '2026-09-24', lines: [{ itemId: 1, quantity: 1, unitPriceCents: 1000 }] });
  assert.equal(created.status, 200);
  assert.equal((await api('POST', '/api/finance/payments', { ...payment(100, 'DRAFT-1'), invoiceId: created.data.invoice.id }, 1, 2)).status, 409);
});

test('company scope hides invoices and their payment histories', async t => {
  const api = await fixture(t);
  assert.equal((await api('POST', '/api/finance/payments', payment(100, 'BANK-100'), 2, 5)).status, 404);
  assert.equal((await api('GET', '/api/finance/payments?invoiceId=1', undefined, 2, 5)).status, 404);
  const companyTwo = await api('GET', '/api/finance/open?type=sale', undefined, 2, 5);
  assert.equal(companyTwo.status, 200);
  assert.equal(companyTwo.data.invoices.some(row => row.id === 1), false);
  assert.equal((await api('GET', '/api/finance/open?type=other')).status, 400);
});

test('payment allocations persist across database reopen', t => {
  const directory = mkdtempSync(join(tmpdir(), 'tesselark-finance-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, 'demo.sqlite');
  const first = openDatabase(file);
  first.prepare("INSERT INTO invoice_payments(company_id,invoice_id,amount_cents,method,reference,payment_date,recorded_by) VALUES (1,1,500,'bank','REOPEN-1','2026-09-24',2)").run();
  first.close();
  const reopened = openDatabase(file);
  assert.equal(reopened.prepare('SELECT SUM(amount_cents) AS paid FROM invoice_payments WHERE invoice_id=1').get().paid, 500);
  reopened.close();
});

test('approved invoice keeps its counterparty snapshot after party master edit', async t => {
  const api = await fixture(t);
  const before = await api('GET', '/api/finance/open?type=sale');
  const original = before.data.invoices.find(row => row.id === 1).partyName;
  const updated = await api('PUT', '/api/parties/1', { name: 'Harbor Clinic Renamed' });
  assert.equal(updated.status, 200);
  const after = await api('GET', '/api/finance/open?type=sale');
  assert.equal(after.data.invoices.find(row => row.id === 1).partyName, original);
  const detail = await api('GET', '/api/finance/payments?invoiceId=1');
  assert.equal(detail.data.invoice.partyName, original);
});

test('cash receipts are assigned to an open drawer and cannot bypass a closed day', async t => {
  const api = await fixture(t);
  const cash = { ...payment(500, 'CASH-OPEN-1'), method: 'cash' };
  assert.equal((await api('POST', '/api/finance/payments', cash, 1, 2)).status, 409);
  const opened = await api('POST', '/api/cashier/sessions',
    { branchId: 3, businessDate: '2026-09-24', openingCashCents: 1000 }, 1, 1);
  assert.equal(opened.status, 200);
  const sale = await api('GET', '/api/finance/open?type=sale');
  const branchInvoice = sale.data.invoices.find(row => row.branchId === 3 && row.outstandingCents >= 500);
  assert.ok(branchInvoice);
  const receipt = await api('POST', '/api/finance/payments', { ...cash, invoiceId: branchInvoice.id }, 1, 2);
  assert.equal(receipt.status, 200);
  const detail = await api('GET', `/api/cashier/sessions/${opened.data.session.id}`);
  assert.equal(detail.data.assignments.length, 1);
  assert.equal(detail.data.session.expectedCashCents, 1500);
  assert.equal((await api('POST', `/api/cashier/sessions/${opened.data.session.id}/close`,
    { countedCashCents: 1500, notes: 'Counted' }, 1, 1)).status, 200);
  assert.equal((await api('POST', '/api/finance/payments',
    { ...cash, invoiceId: branchInvoice.id, reference: 'CASH-CLOSED-2' }, 1, 2)).status, 409);
});

test('commercial return settlement reduces finance outstanding and caps later payment', async t => {
  const api = await fixture(t);
  const before = await api('GET', '/api/finance/open?type=sale');
  const source = before.data.invoices.find(row => row.number === 'DEMO-MUM-201');
  assert.ok(source);
  const returns = await api('GET', '/api/returns');
  const note = returns.data.returns.find(row => row.number === 'DEMO-CRN-MUM-201');
  assert.ok(note);
  const posted = await api('POST', '/api/return-settlements',
    { returnId: note.id, settlementDate: '2026-09-24' }, 1, 2);
  assert.equal(posted.status, 200);
  const after = await api('GET', '/api/finance/payments?invoiceId=' + source.id);
  assert.equal(after.data.invoice.commercialAdjustmentCents, note.subtotalCents);
  assert.equal(after.data.invoice.outstandingCents, source.outstandingCents - note.subtotalCents);
  assert.equal((await api('POST', '/api/finance/payments',
    { ...payment(after.data.invoice.outstandingCents + 1, 'OVER-CREDIT'), invoiceId: source.id }, 1, 2)).status, 409);
});
