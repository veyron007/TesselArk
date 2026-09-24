import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const { openDatabase } = require('../db.cjs');

test('expanded synthetic data stays scoped, balanced and idempotent on reopen', t => {
  const dir = mkdtempSync(join(tmpdir(), 'erp-expanded-demo-'));
  t.after(() => rmSync(dir, { recursive:true, force:true }));
  const file = join(dir, 'demo.sqlite');
  const inspect = db => {
    const common = db.prepare("SELECT company_id,gstin_id,branch_id,status,tax_cents FROM invoices WHERE number LIKE 'DEMO-COMMON-%' ORDER BY gstin_id").all();
    assert.deepEqual(common.map(row => [row.company_id,row.gstin_id,row.branch_id,row.status,row.tax_cents]),[[1,1,1,'draft',21600],[1,2,3,'draft',21600]]);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM purchase_evidence e JOIN invoices i ON i.id=e.invoice_id WHERE i.number LIKE 'DEMO-COMMON-%'").get().n,0);

    const pune = db.prepare("SELECT id,status FROM orders WHERE company_id=1 AND number='DEMO-SO-PUN-401'").get();
    assert.equal(pune.status,'confirmed');
    assert.equal(db.prepare('SELECT COUNT(*) n FROM order_fulfillments WHERE order_id=?').get(pune.id).n,0);
    const mysuru = db.prepare("SELECT gstin_id,branch_id,status FROM orders WHERE company_id=1 AND number='DEMO-SO-BLR-402'").get();
    assert.deepEqual([mysuru.gstin_id,mysuru.branch_id,mysuru.status],[2,3,'draft']);
    const lots = db.prepare("SELECT l.batch_code,l.expires_on,m.quantity_delta,m.is_allocation,s.quantity_delta physical_delta FROM batch_lots l JOIN batch_movements m ON m.batch_id=l.id JOIN stock_movements s ON s.id=m.stock_movement_id WHERE l.batch_code LIKE 'DEMO-PUN-GLU-%' ORDER BY l.batch_code").all();
    assert.deepEqual(lots.map(row => [row.batch_code,row.quantity_delta,row.is_allocation,row.physical_delta]),[['DEMO-PUN-GLU-EXPIRED',4,1,0],['DEMO-PUN-GLU-READY',6,1,0]]);
    assert.ok(lots[0].expires_on < new Date().toISOString().slice(0,10));
    assert.ok(lots[1].expires_on > new Date().toISOString().slice(0,10));
    assert.equal(db.prepare('SELECT SUM(quantity_delta) q FROM stock_movements WHERE company_id=1 AND branch_id=2 AND item_id=1').get().q,20);

    const service = db.prepare("SELECT * FROM invoices WHERE company_id=2 AND number='DEMO-SVC-MUM-501'").get();
    assert.equal(service.gstin_id,3);
    assert.equal(service.total_cents,177000);
    assert.equal(db.prepare('SELECT SUM(amount_cents) paid FROM invoice_payments WHERE invoice_id=?').get(service.id).paid,60000);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM stock_movements WHERE invoice_id=?').get(service.id).n,0);
    const doc = db.prepare("SELECT * FROM statutory_lifecycle_documents WHERE company_id=2 AND kind='irn' AND source_id=?").get(service.id);
    assert.equal(doc.status,'generated');
    assert.match(doc.reference,/^SIM-DEMO-/);
    const event = db.prepare("SELECT * FROM statutory_lifecycle_events WHERE company_id=2 AND kind='irn' AND source_id=?").get(service.id);
    assert.equal(JSON.parse(event.response_json).officialSubmission,false);
    assert.equal(db.prepare("SELECT status FROM evidence_versions v JOIN evidence_documents d ON d.id=v.document_id WHERE d.company_id=2 AND d.target_type='invoice' AND d.target_id=?").get(service.id).status,'pending');
    assert.equal(db.prepare("SELECT status FROM invoices WHERE company_id=2 AND number='DEMO-RCM-REVIEW-502'").get().status,'draft');

    const nila = db.prepare("SELECT * FROM invoices WHERE company_id=3 AND number='DEMO-NILA-BOS-601'").get();
    assert.equal(nila.gstin_id,4);
    assert.equal(nila.tax_cents,0);
    assert.equal(nila.total_cents,47500);
    assert.equal(db.prepare('SELECT SUM(quantity_delta) q FROM stock_movements WHERE company_id=3 AND branch_id=5 AND item_id=5').get().q,65);
    assert.equal(db.prepare("SELECT status,tax_proposal_cents FROM returns WHERE company_id=3 AND number='DEMO-NILA-RET-601'").get().status,'draft');
    assert.equal(db.prepare("SELECT status,tax_proposal_cents FROM returns WHERE company_id=3 AND number='DEMO-NILA-RET-601'").get().tax_proposal_cents,0);
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);
    const imbalanced = db.prepare('SELECT j.id FROM journals j JOIN journal_lines l ON l.journal_id=j.id GROUP BY j.id HAVING SUM(l.debit_cents)<>SUM(l.credit_cents)').all();
    assert.deepEqual(imbalanced,[]);
    return Object.fromEntries(['invoices','invoice_lines','invoice_payments','returns','stock_movements','batch_lots','batch_movements','evidence_versions','statutory_lifecycle_events','journals'].map(table => [table,db.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n]));
  };
  const first = openDatabase(file);
  const counts = inspect(first);
  first.close();
  const reopened = openDatabase(file);
  assert.deepEqual(inspect(reopened),counts);
  reopened.close();
});
