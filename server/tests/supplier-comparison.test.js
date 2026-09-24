import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const express = require('express');
const { openDatabase } = require('../db.cjs');
const { allowedScopes } = require('../access.cjs');
const { registerSupplierComparisonRoutes, quoteCost } = require('../supplier-comparison.cjs');

async function fixture(t) {
  const db = openDatabase(':memory:');
  const app = express();
  app.use(express.json());
  app.use('/api', (req, _res, next) => {
    const companyId = Number(req.header('x-company-id') || 1), userId = Number(req.header('x-user-id') || 1);
    req.company = db.prepare('SELECT * FROM companies WHERE id=?').get(companyId);
    req.user = db.prepare('SELECT * FROM users WHERE id=? AND company_id=?').get(userId, companyId);
    if (!req.company || !req.user) return next(Object.assign(new Error('Invalid identity'), { status: 403 }));
    req.scopes = allowedScopes(db, { companyId, userId });
    next();
  });
  registerSupplierComparisonRoutes(app, db);
  app.use((error, _req, res, _next) => res.status(error.status || 500).json({ error: error.message }));
  const server = app.listen(0);
  t.after(() => { server.close(); db.close(); });
  const api = async (method, path, body, companyId = 1, userId = 1) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`, { method, headers: { 'content-type': 'application/json', 'x-company-id': String(companyId), 'x-user-id': String(userId) }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, data: await response.json() };
  };
  return { db, api };
}
const today = () => new Date().toISOString().slice(0, 10);
const tomorrow = () => new Date(Date.now() + 86400000).toISOString().slice(0, 10);
const yesterday = () => new Date(Date.now() - 86400000).toISOString().slice(0, 10);
const baseComparison = { gstinId: 1, branchId: 1, itemId: 1, title: 'Glucose strip replenishment', clientReference: 'CMP-001' };
const quote = (supplierId, clientReference, changes = {}) => ({ supplierId, clientReference, quoteDate: today(), validUntil: tomorrow(), sourceReference: `${clientReference} written offer`, paymentTerms: '30 days', paidPackQuantity: 10, freePackQuantity: 0, unitsPerPackNumerator: 1, unitsPerPackDenominator: 1, priceCentsPerPack: 10000, taxRateBps: 1200, freightCents: 0, taxTreatment: 'include', ...changes });

// Exact rational arithmetic is exposed as strings, with only the display rounded.
test('pack conversion, free goods, GST and freight produce comparable exact unit costs', async t => {
  const { db, api } = await fixture(t);
  db.prepare("INSERT INTO parties(company_id,name,type) VALUES (1,'Second supplier','supplier')").run();
  const made = await api('POST', '/api/supplier-comparisons', baseComparison);
  assert.equal(made.status, 200, JSON.stringify(made.data));
  const id = made.data.comparison.id;
  const first = await api('POST', `/api/supplier-comparisons/${id}/quotes`, quote(2, 'Q-A', { paidPackQuantity: 5, freePackQuantity: 1, unitsPerPackNumerator: 12, priceCentsPerPack: 12001, freightCents: 123, taxRateBps: 333 }));
  assert.equal(first.status, 200, JSON.stringify(first.data));
  const cost = first.data.quote.cost;
  assert.equal(cost.subtotalCents, '60005');
  assert.equal(cost.quotedTaxCents, '1998');
  assert.equal(cost.landedTotalCents, '62126');
  assert.deepEqual(cost.equivalentBaseUnits, { numerator: '72', denominator: '1' });
  assert.deepEqual(cost.landedUnitCost, { numerator: '62126', denominator: '72', rupeesPerBaseUnit: '8.6286' });
  const supplier2 = db.prepare("SELECT id FROM parties WHERE name='Second supplier'").get().id;
  const second = await api('POST', `/api/supplier-comparisons/${id}/quotes`, quote(supplier2, 'Q-B', { paidPackQuantity: 12, unitsPerPackNumerator: 6, priceCentsPerPack: 5000, taxTreatment: 'exclude' }));
  assert.equal(second.status, 200, JSON.stringify(second.data));
  assert.equal(second.data.quote.cost.includedTaxCents, '0');
  assert.equal(second.data.quote.cost.landedUnitCost.rupeesPerBaseUnit, '8.3333');
  assert.equal((await api('GET', `/api/supplier-comparisons/${id}`)).data.comparison.purchaseHistory.some(row => row.invoiceId && row.invoiceLineId && row.quantityBaseUnits > 0), true);
  assert.equal(quoteCost({ paid_pack_quantity: 1, free_pack_quantity: 0, units_per_pack_numerator: 3, units_per_pack_denominator: 2, price_cents_per_pack: 1, tax_rate_bps: 0, freight_cents: 0, tax_treatment: 'include' }).landedUnitCost.rupeesPerBaseUnit, '0.0067');
});

test('selection requires two suppliers, independent review, exact replay and preserves invoices', async t => {
  const { db, api } = await fixture(t);
  const supplier2 = Number(db.prepare("INSERT INTO parties(company_id,name,type) VALUES (1,'Second supplier','supplier')").run().lastInsertRowid);
  const made = await api('POST', '/api/supplier-comparisons', baseComparison);
  const id = made.data.comparison.id;
  assert.equal((await api('POST', '/api/supplier-comparisons', baseComparison)).data.replayed, true);
  assert.equal((await api('POST', '/api/supplier-comparisons', { ...baseComparison, title: 'Changed' })).status, 409);
  const one = await api('POST', `/api/supplier-comparisons/${id}/quotes`, quote(2, 'Q-1'));
  assert.equal((await api('POST', `/api/supplier-comparisons/${id}/submit`, { selectedQuoteId: one.data.quote.id, reason: 'Best lead time' })).status, 400);
  const two = await api('POST', `/api/supplier-comparisons/${id}/quotes`, quote(supplier2, 'Q-2'));
  assert.equal(two.status, 200);
  assert.equal((await api('POST', `/api/supplier-comparisons/${id}/quotes`, quote(supplier2, 'Q-2'))).data.replayed, true);
  assert.equal((await api('POST', `/api/supplier-comparisons/${id}/quotes`, quote(supplier2, 'Q-2', { freightCents: 99 }))).status, 409);
  const submitted = await api('POST', `/api/supplier-comparisons/${id}/submit`, { selectedQuoteId: two.data.quote.id, reason: 'Better terms' });
  assert.equal(submitted.status, 200, JSON.stringify(submitted.data));
  assert.equal((await api('POST', `/api/supplier-comparisons/${id}/submit`, { selectedQuoteId: two.data.quote.id, reason: 'Better terms' })).data.replayed, true);
  assert.equal((await api('POST', `/api/supplier-comparisons/${id}/review`, { decision: 'approve', reason: 'Checked offers' }, 1, 1)).status, 403);
  const reviewed = await api('POST', `/api/supplier-comparisons/${id}/review`, { decision: 'approve', reason: 'Checked offers' }, 1, 2);
  assert.equal(reviewed.status, 200, JSON.stringify(reviewed.data));
  assert.equal(reviewed.data.comparison.status, 'approved');
  assert.equal((await api('POST', `/api/supplier-comparisons/${id}/review`, { decision: 'approve', reason: 'Checked offers' }, 1, 2)).data.replayed, true);
  assert.equal((await api('POST', `/api/supplier-comparisons/${id}/review`, { decision: 'reject', reason: 'No' }, 1, 2)).status, 409);
  assert.deepEqual(reviewed.data.comparison.events.map(row => row.action), ['created', 'quote_added', 'quote_added', 'submitted', 'approved']);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM orders WHERE company_id=1').get().n > 0, true);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM supplier_comparisons WHERE company_id=1').get().n, 1);
});

test('approval rejects a selected party whose supplier status changed after submission', async t => {
  const { db, api } = await fixture(t);
  const secondSupplierId = Number(db.prepare("INSERT INTO parties(company_id,name,type) VALUES (1,'Fresh supplier','supplier')").run().lastInsertRowid);
  const id = (await api('POST','/api/supplier-comparisons',{...baseComparison,clientReference:'CMP-TYPE-CHANGE'})).data.comparison.id;
  const first = (await api('POST',`/api/supplier-comparisons/${id}/quotes`,quote(2,'TYPE-A'))).data.quote;
  await api('POST',`/api/supplier-comparisons/${id}/quotes`,quote(secondSupplierId,'TYPE-B'));
  assert.equal((await api('POST',`/api/supplier-comparisons/${id}/submit`,{selectedQuoteId:first.id,reason:'Initial offer selected'})).status,200);
  db.prepare("UPDATE parties SET type='customer' WHERE id=2").run();
  const result=await api('POST',`/api/supplier-comparisons/${id}/review`,{decision:'approve',reason:'Check current supplier'},1,2);
  assert.equal(result.status,409);
  assert.equal(db.prepare('SELECT status FROM supplier_comparisons WHERE id=?').get(id).status,'submitted');
});

test('company, GSTIN, branch, supplier and role boundaries apply server side', async t => {
  const { api } = await fixture(t);
  assert.equal((await api('POST', '/api/supplier-comparisons', { ...baseComparison, itemId: 4 })).status, 404);
  assert.equal((await api('POST', '/api/supplier-comparisons', { ...baseComparison, branchId: 3 })).status, 400);
  assert.equal((await api('POST', '/api/supplier-comparisons', baseComparison, 1, 2)).status, 403);
  const created = await api('POST', '/api/supplier-comparisons', baseComparison);
  const id = created.data.comparison.id;
  assert.equal((await api('GET', `/api/supplier-comparisons/${id}`, undefined, 2, 8)).status, 404);
  assert.equal((await api('GET', '/api/supplier-comparisons', undefined, 2, 8)).data.comparisons.length, 0);
  assert.equal((await api('POST', `/api/supplier-comparisons/${id}/quotes`, quote(1, 'BAD-CUSTOMER'))).status, 404);
  assert.equal((await api('POST', `/api/supplier-comparisons/${id}/quotes`, quote(5, 'BAD-COMPANY'))).status, 404);
  assert.equal((await api('POST', `/api/supplier-comparisons/${id}/quotes`, quote(2, 'GOOD'), 1, 2)).status, 403);
});

test('expired quote, changed purchase history and changed item unit prevent stale approval', async t => {
  const { db, api } = await fixture(t);
  const supplier2 = Number(db.prepare("INSERT INTO parties(company_id,name,type) VALUES (1,'Second supplier','supplier')").run().lastInsertRowid);
  const make = async suffix => {
    const id = (await api('POST', '/api/supplier-comparisons', { ...baseComparison, clientReference: `CMP-${suffix}` })).data.comparison.id;
    const one = (await api('POST', `/api/supplier-comparisons/${id}/quotes`, quote(2, `Q-${suffix}-1`))).data.quote;
    await api('POST', `/api/supplier-comparisons/${id}/quotes`, quote(supplier2, `Q-${suffix}-2`));
    return { id, selectedQuoteId: one.id };
  };
  const expired = await make('EXP');
  db.prepare('UPDATE supplier_comparison_quotes SET valid_until=? WHERE id=?').run(yesterday(), expired.selectedQuoteId);
  assert.equal((await api('POST', `/api/supplier-comparisons/${expired.id}/submit`, { selectedQuoteId: expired.selectedQuoteId, reason: 'Old quote' })).status, 409);
  const changed = await make('HISTORY');
  assert.equal((await api('POST', `/api/supplier-comparisons/${changed.id}/submit`, { selectedQuoteId: changed.selectedQuoteId, reason: 'Initially best' })).status, 200);
  db.prepare("UPDATE invoice_lines SET subtotal_cents=subtotal_cents+1 WHERE id=(SELECT l.id FROM invoice_lines l JOIN invoices i ON i.id=l.invoice_id WHERE i.type='purchase' AND i.status='approved' AND i.branch_id=1 AND l.item_id=1 LIMIT 1)").run();
  assert.equal((await api('POST', `/api/supplier-comparisons/${changed.id}/review`, { decision: 'approve', reason: 'Checked' }, 1, 2)).status, 409);
  assert.equal((await api('POST', `/api/supplier-comparisons/${changed.id}/review`, { decision: 'reject', reason: 'History changed' }, 1, 2)).status, 200);
  const unit = await make('UNIT');
  assert.equal((await api('POST', `/api/supplier-comparisons/${unit.id}/submit`, { selectedQuoteId: unit.selectedQuoteId, reason: 'Chosen' })).status, 200);
  db.prepare("UPDATE items SET unit='piece' WHERE id=1").run();
  assert.equal((await api('POST', `/api/supplier-comparisons/${unit.id}/review`, { decision: 'approve', reason: 'Checked' }, 1, 2)).status, 409);
});

test('invalid quantities, dates and money are rejected without quote events', async t => {
  const { api } = await fixture(t);
  const id = (await api('POST', '/api/supplier-comparisons', baseComparison)).data.comparison.id;
  const path = `/api/supplier-comparisons/${id}/quotes`;
  for (const changes of [{ paidPackQuantity: 0 }, { freePackQuantity: -1 }, { unitsPerPackDenominator: 0 }, { priceCentsPerPack: 1.5 }, { taxRateBps: 10001 }, { freightCents: -1 }, { validUntil: '2026-02-30' }, { taxTreatment: 'eligible' }]) {
    assert.equal((await api('POST', path, quote(2, `BAD-${JSON.stringify(changes)}`, changes))).status, 400);
  }
  assert.deepEqual((await api('GET', `/api/supplier-comparisons/${id}`)).data.comparison.events.map(row => row.action), ['created']);
});

test('synthetic reviewed seed is idempotent, source linked and leaves purchasing documents untouched', async t => {
  const { db, api } = await fixture(t);
  const { seedSupplierComparisonDemo } = require('../supplier-comparison.cjs');
  const before = {
    invoices: db.prepare('SELECT COUNT(*) n FROM invoices').get().n,
    orders: db.prepare('SELECT COUNT(*) n FROM orders').get().n,
    evidence: db.prepare('SELECT COUNT(*) n FROM purchase_evidence').get().n,
  };
  const first = seedSupplierComparisonDemo(db);
  assert.equal(first.created, true);
  const second = seedSupplierComparisonDemo(db);
  assert.deepEqual(second, { created: false, comparisonId: first.comparisonId });
  const detail = await api('GET', `/api/supplier-comparisons/${first.comparisonId}`);
  assert.equal(detail.status, 200, JSON.stringify(detail.data));
  const seeded = detail.data.comparison;
  assert.equal(seeded.status, 'approved');
  assert.equal(seeded.branchId, 1);
  assert.equal(seeded.gstinId, 1);
  assert.equal(seeded.itemUnitSnapshot, 'box');
  assert.equal(seeded.quotes.length, 2);
  assert.equal(new Set(seeded.quotes.map(row => row.supplierId)).size, 2);
  assert.equal(seeded.quotes[0].freePackQuantity, 1);
  assert.equal(seeded.quotes[1].unitsPerPackNumerator, 12);
  assert.ok(seeded.quotes.every(row => row.sourceReference.startsWith('SYNTHETIC QUOTE')));
  assert.equal(seeded.selectedQuoteId, seeded.quotes[0].id);
  assert.ok(seeded.purchaseHistory.some(row => row.invoiceId && row.invoiceLineId && row.invoiceNumber.startsWith('DEMO-')));
  assert.equal(seeded.historyChangedSinceSubmit, false);
  assert.deepEqual(seeded.events.map(row => row.action), ['created', 'quote_added', 'quote_added', 'submitted', 'approved']);
  assert.deepEqual({
    invoices: db.prepare('SELECT COUNT(*) n FROM invoices').get().n,
    orders: db.prepare('SELECT COUNT(*) n FROM orders').get().n,
    evidence: db.prepare('SELECT COUNT(*) n FROM purchase_evidence').get().n,
  }, before);
});
