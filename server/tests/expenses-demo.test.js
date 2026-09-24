import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import database from '../db.cjs';
import fixture from '../expenses-demo.cjs';
import settlement from '../return-settlement.cjs';

const { openDatabase } = database;
const { seedExpensesDemo } = fixture;
const { invoiceSettlementBalance } = settlement;

test('synthetic expense fixture links existing bills, balances journals, and replays safely', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(),'erp-expenses-demo-'));
  const filename = path.join(directory,'demo.sqlite');
  let db;
  try {
    db = openDatabase(filename);
    const gstBefore = db.prepare('SELECT invoice_id,match_status,eligibility_status,claim_period FROM purchase_evidence ORDER BY invoice_id').all();
    const invoicesBefore = db.prepare('SELECT COUNT(*) AS count FROM invoices').get().count;
    assert.deepEqual(seedExpensesDemo(db),{ created:3,skipped:0 });
    const rows = db.prepare(`SELECT v.number,c.id AS claim_id,c.paid_by,c.approved_amount_cents,c.status,
      c.evidence_document_id,c.evidence_version,c.evidence_sha256,d.target_type,d.target_id,d.gstin_id,d.branch_id
      FROM expense_claims c JOIN invoices v ON v.id=c.invoice_id
      JOIN evidence_documents d ON d.id=c.evidence_document_id ORDER BY v.number`).all();
    assert.deepEqual(rows.map(row => row.number),['DEMO-NS-501','DEMO-NS-502','DEMO-PUR-BLR-302']);
    for (const row of rows) {
      assert.equal(row.status,'approved');
      assert.equal(row.target_type,'invoice');
      assert.equal(row.evidence_version,2);
      const invoice = db.prepare('SELECT id,gstin_id,branch_id FROM invoices WHERE number=?').get(row.number);
      assert.equal(row.target_id,invoice.id);
      assert.equal(row.gstin_id,invoice.gstin_id);
      assert.equal(row.branch_id,invoice.branch_id);
      const proof = db.prepare('SELECT status,sha256,content,byte_size FROM evidence_versions WHERE document_id=? AND version=2').get(row.evidence_document_id);
      assert.equal(proof.status,'approved');
      assert.equal(proof.sha256,row.evidence_sha256);
      assert.equal(proof.content.length,proof.byte_size);
      assert.match(Buffer.from(proof.content).toString('utf8'),/SYNTHETIC DEMO DOCUMENT/);
      assert.deepEqual(db.prepare('SELECT action FROM expense_claim_events WHERE claim_id=? ORDER BY id').all(row.claim_id).map(event => event.action),['created','submitted','approved']);
    }
    const employee = rows.find(row => row.number === 'DEMO-NS-501');
    const bengaluru = rows.find(row => row.number === 'DEMO-PUR-BLR-302');
    const company = rows.find(row => row.number === 'DEMO-NS-502');
    assert.equal(employee.paid_by,'employee');
    assert.equal(bengaluru.paid_by,'employee');
    assert.equal(company.paid_by,'company');
    const allocation = db.prepare('SELECT amount_cents FROM employee_invoice_allocations WHERE claim_id=?').get(employee.claim_id);
    const reimbursement = db.prepare('SELECT amount_cents FROM expense_reimbursements WHERE claim_id=?').get(employee.claim_id);
    assert.equal(allocation.amount_cents,employee.approved_amount_cents);
    assert.equal(reimbursement.amount_cents,12000);
    assert.ok(reimbursement.amount_cents < allocation.amount_cents);
    assert.equal(invoiceSettlementBalance(db,db.prepare("SELECT id FROM invoices WHERE number='DEMO-NS-501'").get().id,1).outstandingCents,0);
    assert.equal(invoiceSettlementBalance(db,db.prepare("SELECT id FROM invoices WHERE number='DEMO-PUR-BLR-302'").get().id,1).outstandingCents,0);
    assert.equal(invoiceSettlementBalance(db,db.prepare("SELECT id FROM invoices WHERE number='DEMO-NS-502'").get().id,1).outstandingCents,0);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM employee_invoice_allocations').get().count,2);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM invoice_payments WHERE reference='SYNTH-SUPPLIER-PAY-NS-502'").get().count,1);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM invoices').get().count,invoicesBefore);
    assert.deepEqual(db.prepare('SELECT invoice_id,match_status,eligibility_status,claim_period FROM purchase_evidence ORDER BY invoice_id').all(),gstBefore);
    const journals = db.prepare("SELECT id,source_type FROM journals WHERE source_type IN ('employee_expense_allocation','expense_reimbursement')").all();
    assert.equal(journals.length,3);
    for (const journal of journals) {
      const sums = db.prepare('SELECT SUM(debit_cents) AS debit,SUM(credit_cents) AS credit FROM journal_lines WHERE journal_id=?').get(journal.id);
      assert.equal(sums.debit,sums.credit);
      assert.ok(sums.debit > 0);
    }
    const counts = ['expense_claims','expense_claim_events','employee_invoice_allocations','expense_reimbursements','evidence_documents','evidence_versions','invoice_payments','journals','journal_lines']
      .map(table => db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count);
    assert.deepEqual(seedExpensesDemo(db),{ created:0,skipped:3 });
    assert.deepEqual(['expense_claims','expense_claim_events','employee_invoice_allocations','expense_reimbursements','evidence_documents','evidence_versions','invoice_payments','journals','journal_lines']
      .map(table => db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count),counts);
    db.close();
    db = openDatabase(filename);
    assert.deepEqual(seedExpensesDemo(db),{ created:0,skipped:3 });
  } finally {
    db?.close();
    fs.rmSync(directory,{recursive:true,force:true});
  }
});
