import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { openDatabase } = require('../db.cjs');
const { seedOperatingHistory } = require('../operating-history.cjs');
const { syncLedgerSources } = require('../ledger.cjs');

test('synthetic operating history spans months and reseeds without changing balances', t => {
  const db = openDatabase(':memory:');
  t.after(() => db.close());
  const first = seedOperatingHistory(db);
  assert.ok(first.invoices >= 50);
  assert.ok(first.orders >= 12);
  const counts = Object.fromEntries(['invoices','invoice_lines','invoice_payments','orders','order_fulfillments','returns','stock_movements','purchase_evidence']
    .map(table => [table,db.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n]));
  const months = db.prepare("SELECT COUNT(DISTINCT substr(invoice_date,1,7)) n FROM invoices WHERE number LIKE 'HIST-%'").get().n;
  assert.ok(months >= 6);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM invoices WHERE number LIKE 'HIST-%' AND invoice_date>date('now')").get().n,0);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM invoices WHERE number LIKE 'HIST-%' AND notes NOT LIKE '%SYNTHETIC%'").get().n,0);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM invoices i JOIN branches b ON b.id=i.branch_id JOIN gstins g ON g.id=i.gstin_id WHERE i.number LIKE 'HIST-%' AND (b.gstin_id<>g.id OR b.company_id<>i.company_id OR g.company_id<>i.company_id)").get().n,0);
  const reviews = db.prepare("SELECT e.claim_period,f.source_period,f.source_name FROM purchase_evidence e JOIN invoices i ON i.id=e.invoice_id JOIN purchase_fixtures f ON f.id=e.fixture_id WHERE i.number LIKE 'HIST-%' AND e.eligibility_status='eligible'").all();
  assert.ok(reviews.length >= 6);
  assert.ok(reviews.every(row => row.claim_period === row.source_period && row.source_name.includes('SYNTHETIC')));
  assert.equal(db.prepare("SELECT COUNT(*) n FROM purchase_evidence e JOIN invoices i ON i.id=e.invoice_id WHERE i.company_id=3 AND i.number LIKE 'HIST-%' AND e.eligibility_status='eligible'").get().n,0);
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM invoices i LEFT JOIN invoice_lines l ON l.invoice_id=i.id WHERE i.number LIKE 'HIST-%' GROUP BY i.id HAVING i.subtotal_cents<>SUM(l.subtotal_cents) OR i.tax_cents<>SUM(l.tax_cents) OR i.total_cents<>SUM(l.total_cents)").all().length,0);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM invoice_payments p JOIN invoices i ON i.id=p.invoice_id WHERE i.number LIKE 'HIST-%' GROUP BY i.id HAVING SUM(p.amount_cents)>MAX(i.total_cents)").all().length,0);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM (SELECT branch_id,item_id,SUM(quantity_delta) q FROM stock_movements GROUP BY branch_id,item_id HAVING q<0)").get().n,0);
  const posted = syncLedgerSources(db);
  assert.ok(posted.invoices >= 50);
  assert.deepEqual(db.prepare('SELECT j.id FROM journals j JOIN journal_lines l ON l.journal_id=j.id GROUP BY j.id HAVING SUM(l.debit_cents)<>SUM(l.credit_cents)').all(),[]);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM invoices i LEFT JOIN journals j ON j.source_type='invoice' AND j.source_id=i.id WHERE i.number LIKE 'HIST-%' AND j.id IS NULL").get().n,0);
  assert.deepEqual(seedOperatingHistory(db),{invoices:0,orders:0,returns:0});
  const after = Object.fromEntries(Object.keys(counts).map(table => [table,db.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n]));
  assert.deepEqual(after,counts);
  assert.deepEqual(syncLedgerSources(db),{invoices:0,payments:0});
});

test('linked history invoices do not duplicate confirmed fulfillment stock', t => {
  const db = openDatabase(':memory:');
  t.after(() => db.close());
  seedOperatingHistory(db);
  const linked = db.prepare("SELECT i.id,i.fulfillment_id,f.status FROM invoices i JOIN order_fulfillments f ON f.id=i.fulfillment_id WHERE i.number LIKE 'HIST-%'").all();
  assert.ok(linked.length >= 12);
  for (const row of linked) {
    assert.equal(row.status,'confirmed');
    assert.equal(db.prepare('SELECT COUNT(*) n FROM stock_movements WHERE invoice_id=?').get(row.id).n,0);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM order_fulfillment_lines WHERE fulfillment_id=? AND stock_movement_id IS NOT NULL').get(row.fulfillment_id).n,1);
  }
  const specimen = db.prepare("SELECT fl.id line_id,fl.stock_movement_id movement_id,f.id fulfillment_id,f.number FROM order_fulfillment_lines fl JOIN order_fulfillments f ON f.id=fl.fulfillment_id WHERE f.number LIKE 'HIST-DSP-%' LIMIT 1").get();
  db.prepare("UPDATE stock_movements SET type='order_dispatch',reason='legacy synthetic label',client_reference='history:legacy' WHERE id=?").run(specimen.movement_id);
  const physicalBefore = db.prepare('SELECT quantity_delta FROM stock_movements WHERE id=?').get(specimen.movement_id).quantity_delta;
  assert.deepEqual(seedOperatingHistory(db),{invoices:0,orders:0,returns:0});
  const fixed = db.prepare('SELECT type,reason,client_reference,quantity_delta FROM stock_movements WHERE id=?').get(specimen.movement_id);
  assert.equal(fixed.type,'sales_dispatch');
  assert.equal(fixed.reason,specimen.number);
  assert.equal(fixed.client_reference,`order-fulfillment:${specimen.fulfillment_id}:line:${specimen.line_id}`);
  assert.equal(fixed.quantity_delta,physicalBefore);
});
