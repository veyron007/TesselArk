import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { openDatabase } = require('../db.cjs');
const { syncLedgerSources } = require('../ledger.cjs');
const { seedConsumerHealthDemo } = require('../consumer-health-seed.cjs');

const tables = ['items', 'parties', 'orders', 'order_fulfillments', 'invoices', 'invoice_lines',
  'invoice_payments', 'returns', 'stock_movements', 'batch_lots', 'batch_movements'];
const counts = db => Object.fromEntries(tables.map(table => [table, db.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n]));

test('consumer health history is coherent, synthetic, and replay safe', t => {
  const db = openDatabase(':memory:');
  t.after(() => db.close());
  const first = seedConsumerHealthDemo(db);
  assert.ok(first.invoices >= 24);
  assert.ok(first.orders >= 12);
  assert.ok(first.returns >= 3);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM items WHERE company_id=1 AND sku LIKE 'CHD-%'").get().n, 18);
  assert.equal(db.prepare("SELECT COUNT(DISTINCT substr(invoice_date,1,7)) n FROM invoices WHERE number LIKE 'CHD-%'").get().n, 4);
  assert.deepEqual(db.prepare("SELECT DISTINCT branch_id FROM invoices WHERE number LIKE 'CHD-%' ORDER BY branch_id").all().map(row => row.branch_id), [1, 2, 3]);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM invoices WHERE number LIKE 'CHD-%' AND (notes NOT LIKE '%SYNTHETIC%' OR invoice_date>'2026-09-24')").get().n, 0);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM parties WHERE company_id=1 AND name LIKE '%Haleon%'").get().n, 0);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM parties WHERE company_id=1 AND address LIKE '%SYNTHETIC DEMO fictional counterparty%' AND gstin<>''").get().n, 0);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM invoices i JOIN gst_periods p ON p.gstin_id=i.gstin_id AND p.period=substr(i.invoice_date,1,7) WHERE i.number LIKE 'CHD-%' AND p.status<>'open'").get().n, 0);
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  assert.equal(db.prepare("SELECT i.id FROM invoices i JOIN invoice_lines l ON l.invoice_id=i.id WHERE i.number LIKE 'CHD-%' GROUP BY i.id HAVING i.subtotal_cents<>SUM(l.subtotal_cents) OR i.tax_cents<>SUM(l.tax_cents) OR i.total_cents<>SUM(l.total_cents)").all().length, 0);
  assert.equal(db.prepare("SELECT branch_id,item_id FROM stock_movements GROUP BY branch_id,item_id HAVING SUM(quantity_delta)<0").all().length, 0);
  assert.equal(db.prepare("SELECT i.id FROM invoices i JOIN order_fulfillments f ON f.id=i.fulfillment_id WHERE i.number LIKE 'CHD-%' AND (SELECT COUNT(*) FROM stock_movements m WHERE m.invoice_id=i.id)>0").all().length, 0);
  assert.equal(db.prepare("SELECT i.id FROM invoices i JOIN invoice_payments p ON p.invoice_id=i.id WHERE i.number LIKE 'CHD-%' GROUP BY i.id HAVING SUM(p.amount_cents)>MAX(i.total_cents)").all().length, 0);
  const before = counts(db);
  syncLedgerSources(db);
  assert.equal(db.prepare('SELECT j.id FROM journals j JOIN journal_lines l ON l.journal_id=j.id GROUP BY j.id HAVING SUM(l.debit_cents)<>SUM(l.credit_cents)').all().length, 0);
  assert.deepEqual(seedConsumerHealthDemo(db), { invoices: 0, orders: 0, returns: 0 });
  assert.deepEqual(counts(db), before);
});

test('consumer health seed respects a locally approved GST period', t => {
  const db = openDatabase(':memory:');
  t.after(() => db.close());
  db.prepare("INSERT OR IGNORE INTO gst_periods(company_id,gstin_id,period,status) VALUES (1,2,'2026-04','approved')").run();
  db.prepare("UPDATE gst_periods SET status='approved' WHERE gstin_id=2 AND period='2026-04'").run();
  seedConsumerHealthDemo(db);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM invoices WHERE number LIKE 'CHD-%' AND gstin_id=2 AND invoice_date LIKE '2026-04%'").get().n, 0);
});
