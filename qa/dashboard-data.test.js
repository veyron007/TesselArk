import test from 'node:test';
import assert from 'node:assert/strict';
import { monthWindow, invoiceTrend, gstTrend, scopedOutstanding } from '../src/components/dashboard-data.js';

test('month windows cross years without timezone shifts', () => {
  assert.deepEqual(monthWindow('2026-02', 3), ['2025-12', '2026-01', '2026-02']);
});

test('invoice chart counts only approved in-window subtotals, preserving zero months', () => {
  const rows = Object.freeze([
    Object.freeze({ status: 'approved', type: 'sale', invoiceDate: '2026-01-31', subtotalCents: 12500, totalCents: 14000 }),
    { status: 'approved', type: 'sale', invoiceDate: '2026-01-01', subtotalCents: 2500 },
    { status: 'approved', type: 'purchase', invoiceDate: '2026-01-20', subtotalCents: 8000 },
    { status: 'submitted', type: 'sale', invoiceDate: '2026-02-01', subtotalCents: 99000 },
    { status: 'approved', type: 'sale', invoiceDate: '2025-12-01', subtotalCents: 99000 },
  ]);
  assert.deepEqual(invoiceTrend(rows, ['2026-01', '2026-02']), [
    { month: '2026-01', salesCents: 15000, purchasesCents: 8000 },
    { month: '2026-02', salesCents: 0, purchasesCents: 0 },
  ]);
});

test('GST chart never substitutes raw purchase tax for reviewed eligible ITC; missing periods stay missing', () => {
  assert.deepEqual(gstTrend([
    { period: '2026-01', salesTaxCents: 5000, purchaseTaxCents: 9000, eligibleItcCents: 1200 },
  ], ['2026-01', '2026-02']), [
    { month: '2026-01', outputCents: 5000, eligibleItcCents: 1200, hasPeriod: true },
    { month: '2026-02', outputCents: null, eligibleItcCents: null, hasPeriod: false },
  ]);
});

test('collections use selected legal registration and branch, and retain granted all-scope results', () => {
  const invoices = [
    { branchId: 1, gstinId: 10, outstandingCents: 4500 },
    { branchId: 2, gstinId: 10, outstandingCents: 2000 },
    { branchId: 3, gstinId: 11, outstandingCents: 9900 },
  ];
  assert.equal(scopedOutstanding(invoices, { branchId: '1', gstinId: '10' }), 4500);
  assert.equal(scopedOutstanding(invoices, { branchId: '', gstinId: 10 }), 6500);
  assert.equal(scopedOutstanding(invoices, { branchId: 1, gstinId: 11 }), 0);
  assert.equal(scopedOutstanding(invoices, {}), 16400);
});
