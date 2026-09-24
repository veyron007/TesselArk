import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const { openDatabase } = require('../db.cjs');

test('Bengaluru and first-visit Mumbai demo payments and returns reconcile and reseed idempotently', t => {
  const dir = mkdtempSync(join(tmpdir(), 'erp-seed-'));
  t.after(() => rmSync(dir, { recursive:true, force:true }));
  const file = join(dir, 'demo.sqlite');
  const check = db => {
    const sale = db.prepare("SELECT * FROM invoices WHERE number='DEMO-BLR-101'").get();
    const second = db.prepare("SELECT * FROM invoices WHERE number='DEMO-BLR-102'").get();
    assert.equal(sale.company_id,1);
    assert.equal(sale.gstin_id,2);
    assert.equal(sale.branch_id,3);
    assert.equal(sale.total_cents,56000);
    assert.equal(second.total_cents,11800);
    assert.equal(sale.invoice_date.slice(0,7),second.invoice_date.slice(0,7));
    assert.notEqual(sale.invoice_date.slice(0,7),new Date().toISOString().slice(0,7));
    assert.equal(db.prepare('SELECT COALESCE(SUM(amount_cents),0) AS paid FROM invoice_payments WHERE invoice_id=?').get(sale.id).paid,20000);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM invoice_payments WHERE invoice_id=?').get(sale.id).n,1);
    const approved = db.prepare('SELECT * FROM returns WHERE invoice_id=?').get(sale.id);
    const draft = db.prepare('SELECT * FROM returns WHERE invoice_id=?').get(second.id);
    assert.equal(approved.status,'approved');
    assert.equal(approved.tax_proposal_status,'unreviewed');
    assert.equal(approved.total_proposal_cents,11200);
    assert.equal(draft.status,'draft');
    assert.equal(draft.tax_proposal_status,'unreviewed');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM stock_movements WHERE branch_id=3 AND item_id=1 AND invoice_id=?').get(sale.id).n,2);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM stock_movements WHERE branch_id=3 AND item_id=2 AND invoice_id=?').get(second.id).n,1);
    assert.equal(db.prepare('SELECT SUM(quantity_delta) AS quantity FROM stock_movements WHERE branch_id=3 AND item_id=1').get().quantity,28);
    assert.equal(db.prepare('SELECT SUM(quantity_delta) AS quantity FROM stock_movements WHERE branch_id=3 AND item_id=2').get().quantity,26);
    assert.equal(db.prepare("SELECT SUM(tax_cents) AS tax FROM invoices WHERE gstin_id=2 AND type='sale' AND status='approved' AND substr(invoice_date,1,7)=?").get(sale.invoice_date.slice(0,7)).tax,9720);
    assert.equal(db.prepare("SELECT SUM(tax_cents) AS tax FROM invoices WHERE gstin_id=2 AND type='purchase' AND status='approved' AND substr(invoice_date,1,7)=?").get(sale.invoice_date.slice(0,7)).tax,1350);
    assert.equal(db.prepare('SELECT tax_cents FROM invoices WHERE id=1').get().tax_cents,2400);
    const mumbai = db.prepare("SELECT id,gstin_id,branch_id,total_cents,invoice_date FROM invoices WHERE number='DEMO-MUM-201'").get();
    assert.equal(mumbai.gstin_id,1);
    assert.equal(mumbai.branch_id,1);
    assert.equal(mumbai.total_cents,14160);
    assert.notEqual(mumbai.invoice_date.slice(0,7),new Date().toISOString().slice(0,7));
    assert.equal(db.prepare('SELECT SUM(amount_cents) AS paid FROM invoice_payments WHERE invoice_id=?').get(mumbai.id).paid,5000);
    assert.equal(db.prepare('SELECT status FROM returns WHERE invoice_id=?').get(mumbai.id).status,'approved');
    assert.equal(db.prepare('SELECT SUM(quantity_delta) AS quantity FROM stock_movements WHERE branch_id=1 AND item_id=3').get().quantity,17);
    const prior = db.prepare('SELECT status,review_notes,approved_by FROM gst_periods WHERE company_id=1 AND gstin_id=1 AND period=?').get(mumbai.invoice_date.slice(0,7));
    assert.equal(prior.status,'approved');
    assert.match(prior.review_notes,/INTERNAL DEMO REVIEW ONLY/);
    assert.equal(prior.approved_by,2);
    assert.equal(db.prepare('SELECT status FROM gst_periods WHERE company_id=1 AND gstin_id=1 AND period=?').get(new Date().toISOString().slice(0,7)).status,'open');
    const specimens = [
      ['DEMO-CASE-MFG-046','ERP-046','draft',['create']],
      ['DEMO-CASE-PHARM-036','ERP-036','submitted',['create','submit']],
      ['DEMO-CASE-PHARM-037','ERP-037','draft',['create']],
      ['DEMO-CASE-PAYROLL-047','ERP-047','approved',['create','submit','approve']],
      ['DEMO-CASE-NOTICE-19','TAX-19','submitted',['create','submit']],
    ];
    for (const [reference,featureId,status,actions] of specimens) {
      const rows = db.prepare('SELECT * FROM workflow_cases WHERE company_id=1 AND reference=?').all(reference);
      assert.equal(rows.length,1,reference);
      assert.equal(rows[0].feature_id,featureId);
      assert.equal(rows[0].status,status);
      assert.match(rows[0].notes,/SYNTHETIC PROTOTYPE ONLY/);
      assert.match(rows[0].evidence_reference,/^SYNTHETIC-/);
      assert.deepEqual(db.prepare('SELECT action FROM workflow_case_events WHERE case_id=? ORDER BY id').all(rows[0].id).map(row=>row.action),actions);
    }
    const specimen = db.prepare("SELECT d.* FROM evidence_documents d JOIN workflow_cases c ON c.id=d.target_id WHERE d.company_id=1 AND d.target_type='workflow_case' AND c.reference='DEMO-CASE-PHARM-036' AND d.title='SYNTHETIC DEMO: Pharmacy receiving note'").all();
    assert.equal(specimen.length,1);
    assert.equal(specimen[0].gstin_id,1);
    assert.equal(specimen[0].branch_id,1);
    const versions = db.prepare('SELECT * FROM evidence_versions WHERE document_id=? ORDER BY version').all(specimen[0].id);
    assert.deepEqual(versions.map(row => row.status),['approved','pending']);
    assert.deepEqual(versions.map(row => row.version),[1,2]);
    assert.equal(versions[0].reviewed_by,2);
    assert.match(versions[0].review_reason,/synthetic presentation specimen/i);
    assert.equal(versions[1].reviewed_by,null);
    for (const version of versions) {
      assert.match(Buffer.from(version.content).toString('utf8'),/^SYNTHETIC DEMO ONLY/);
      assert.equal(version.byte_size,version.content.length);
    }
    for (const [number,ordered,fulfilled,invoiceNumber] of [['DEMO-SO-BLR-301',10,4,'DEMO-SAL-BLR-301'],['DEMO-PO-BLR-302',12,5,'DEMO-PUR-BLR-302']]) {
      const order = db.prepare('SELECT * FROM orders WHERE company_id=1 AND number=?').get(number);
      assert.equal(order.status,'confirmed');
      const line = db.prepare('SELECT * FROM order_lines WHERE order_id=?').get(order.id);
      assert.equal(line.quantity,ordered);
      const fulfillment = db.prepare('SELECT * FROM order_fulfillments WHERE order_id=?').get(order.id);
      assert.equal(fulfillment.status,'confirmed');
      const fulfilledLine = db.prepare('SELECT * FROM order_fulfillment_lines WHERE fulfillment_id=?').get(fulfillment.id);
      assert.equal(fulfilledLine.quantity,fulfilled);
      assert.ok(fulfilledLine.stock_movement_id);
      const invoice = db.prepare('SELECT * FROM invoices WHERE number=?').get(invoiceNumber);
      assert.equal(invoice.fulfillment_id,fulfillment.id);
      assert.equal(db.prepare('SELECT fulfillment_line_id FROM invoice_lines WHERE invoice_id=?').get(invoice.id).fulfillment_line_id,fulfilledLine.id);
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM stock_movements WHERE invoice_id=?').get(invoice.id).n,0);
    }
  };
  const first = openDatabase(file);
  check(first);
  first.close();
  const second = openDatabase(file);
  check(second);
  second.close();
});
