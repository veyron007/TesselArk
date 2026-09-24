import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const { openDatabase } = require('../db.cjs');
const { createApp } = require('../api.cjs');
const { installLedgerSchema, syncLedgerSources, postInvoice, postPayment, trialBalance, ledgerReports } = require('../ledger.cjs');

test('existing journal schema upgrades without losing lines or foreign keys', t => {
  const directory = mkdtempSync(join(tmpdir(), 'erp-ledger-upgrade-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, 'legacy.sqlite');
  const db = openDatabase(file);
  const before = db.prepare('SELECT COUNT(*) AS count FROM journal_lines').get().count;
  db.exec('PRAGMA foreign_keys=OFF');
  db.exec(`
    CREATE TABLE journals_legacy (
      id INTEGER PRIMARY KEY, company_id INTEGER NOT NULL REFERENCES companies(id),
      gstin_id INTEGER REFERENCES gstins(id), branch_id INTEGER REFERENCES branches(id),
      party_id INTEGER REFERENCES parties(id), party_name_snapshot TEXT NOT NULL DEFAULT '',
      source_type TEXT NOT NULL CHECK(source_type IN ('invoice','payment')), source_id INTEGER NOT NULL,
      document_number TEXT NOT NULL, journal_date TEXT NOT NULL, description TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE(company_id,source_type,source_id)
    );
    INSERT INTO journals_legacy SELECT * FROM journals;
    DROP TABLE journals;
    ALTER TABLE journals_legacy RENAME TO journals;
  `);
  db.close();
  const reopened = openDatabase(file);
  t.after(() => reopened.close());
  assert.equal(reopened.prepare('SELECT COUNT(*) AS count FROM journal_lines').get().count, before);
  assert.deepEqual(reopened.prepare('PRAGMA foreign_key_check').all(), []);
  const schema = reopened.prepare("SELECT sql FROM sqlite_master WHERE name='journals'").get().sql;
  for (const source of ['return_settlement','employee_expense_allocation','expense_reimbursement']) assert.match(schema,new RegExp(source));
  assert.ok(reopened.prepare("SELECT id FROM ledger_accounts WHERE company_id=1 AND code='2400'").get());
});

function fixture(t) {
  const db = openDatabase(':memory:');
  t.after(() => db.close());
  installLedgerSchema(db);
  return db;
}

test('approved invoice sources create balanced, idempotent, scoped journals', t => {
  const db = fixture(t);
  const invoice = db.prepare("SELECT * FROM invoices WHERE company_id=1 AND number='SAL-01-00001'").get();
  const first = postInvoice(db, invoice.id);
  const second = postInvoice(db, invoice.id);
  assert.equal(first.id, second.id);
  const lines = db.prepare('SELECT a.code,l.debit_cents,l.credit_cents FROM journal_lines l JOIN ledger_accounts a ON a.id=l.account_id WHERE l.journal_id=? ORDER BY l.id').all(first.id);
  assert.deepEqual(lines.map(row => [row.code,row.debit_cents,row.credit_cents]), [
    ['1200',22400,0], ['4000',0,20000], ['2200',0,2400],
  ]);
  assert.equal(lines.reduce((sum,row) => sum+row.debit_cents-row.credit_cents,0),0);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM journals WHERE source_type=? AND source_id=?').get('invoice',invoice.id).count,1);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM journals WHERE company_id=2 AND source_type=? AND source_id=?').get('invoice',invoice.id).count,0);
});

test('payment posts against receivable and bank, preserving balance and source replay', t => {
  const db = fixture(t);
  const payment = db.prepare("SELECT * FROM invoice_payments WHERE reference='DEMO-MUM-BANK-201'").get();
  const first = postPayment(db,payment.id);
  assert.equal(postPayment(db,payment.id).id,first.id);
  const lines = db.prepare('SELECT a.code,l.debit_cents,l.credit_cents FROM journal_lines l JOIN ledger_accounts a ON a.id=l.account_id WHERE l.journal_id=? ORDER BY l.id').all(first.id);
  assert.deepEqual(lines.map(row => [row.code,row.debit_cents,row.credit_cents]), [['1100',5000,0],['1200',0,5000]]);
  assert.equal(lines.reduce((sum,row) => sum+row.debit_cents-row.credit_cents,0),0);
});

test('purchase and supplier settlement post opposite payable and tax control entries', t => {
  const db = fixture(t);
  const purchase = db.prepare("SELECT * FROM invoices WHERE company_id=1 AND type='purchase' AND status='approved' LIMIT 1").get();
  assert.ok(purchase);
  const journal = postInvoice(db,purchase.id);
  const lines = db.prepare('SELECT a.code,l.debit_cents,l.credit_cents FROM journal_lines l JOIN ledger_accounts a ON a.id=l.account_id WHERE l.journal_id=? ORDER BY l.id').all(journal.id);
  assert.deepEqual(lines.map(row=>[row.code,row.debit_cents,row.credit_cents]),[
    ['5000',purchase.subtotal_cents,0],['1300',purchase.tax_cents,0],['2100',0,purchase.total_cents],
  ]);
  const paymentId = Number(db.prepare("INSERT INTO invoice_payments(company_id,invoice_id,amount_cents,method,reference,payment_date,recorded_by) VALUES (1,?,1000,'cheque','TEST-CHEQUE-1','2026-09-24',2)").run(purchase.id).lastInsertRowid);
  const paymentJournal = postPayment(db,paymentId);
  const paymentLines = db.prepare('SELECT a.code,l.debit_cents,l.credit_cents FROM journal_lines l JOIN ledger_accounts a ON a.id=l.account_id WHERE l.journal_id=? ORDER BY l.id').all(paymentJournal.id);
  assert.deepEqual(paymentLines.map(row=>[row.code,row.debit_cents,row.credit_cents]),[['2100',1000,0],['2300',0,1000]]);
});

test('backfill includes seeded approved sources once and excludes draft invoices', t => {
  const db = fixture(t);
  const expectedInvoices = db.prepare("SELECT COUNT(*) AS count FROM invoices WHERE status='approved'").get().count;
  const expectedPayments = db.prepare('SELECT COUNT(*) AS count FROM invoice_payments').get().count;
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM journals WHERE source_type='invoice'").get().count,expectedInvoices);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM journals WHERE source_type='payment'").get().count,expectedPayments);
  const journalCount = db.prepare('SELECT COUNT(*) AS count FROM journals').get().count;
  const again = syncLedgerSources(db);
  assert.deepEqual(again,{invoices:0,payments:0});
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM journals').get().count,journalCount);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM journals j JOIN invoices i ON j.source_type='invoice' AND j.source_id=i.id WHERE i.status<>'approved'").get().count,0);
});

test('trial balance and statements stay balanced with period filters and company isolation', t => {
  const db = fixture(t);
  syncLedgerSources(db);
  const foreignInvoiceId = Number(db.prepare("INSERT INTO invoices(company_id,branch_id,gstin_id,party_id,number,type,status,invoice_date,subtotal_cents,tax_cents,total_cents,created_by,submitted_by,approved_by) VALUES (2,4,3,4,'TEST-SVC-1','sale','approved','2026-09-24',10000,1800,11800,4,4,5)").run().lastInsertRowid);
  postInvoice(db,foreignInvoiceId);
  const trial = trialBalance(db,1,'2026-12-31');
  assert.equal(trial.totalDebitCents,trial.totalCreditCents);
  assert.equal(trial.rows.reduce((sum,row)=>sum+row.balanceDebitCents-row.balanceCreditCents,0),0);
  const reports = ledgerReports(db,1,'2026-09');
  assert.equal(reports.balanceSheet.balanced,true);
  assert.ok(reports.limitations.some(line=>line.includes('return')));
  const foreign = db.prepare('SELECT COUNT(*) AS count FROM journals WHERE company_id=2').get().count;
  assert.ok(foreign > 0);
  assert.equal(trial.rows.some(row=>row.companyId===2),false);
});

test('ledger HTTP reports and journal detail enforce selected company and date validation', async t => {
  const db = fixture(t);
  const server = createApp({db}).listen(0);
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = async (path,companyId=1,userId=2) => {
    const response = await fetch(`${base}${path}`,{headers:{'x-company-id':String(companyId),'x-user-id':String(userId)}});
    return {status:response.status,body:await response.json()};
  };
  const journals = await get('/api/ledger/journals?limit=5');
  assert.equal(journals.status,200);
  assert.ok(journals.body.journals.length > 0);
  const journalId = journals.body.journals[0].id;
  assert.equal((await get(`/api/ledger/journals/${journalId}`)).body.journal.totalDebitCents,(await get(`/api/ledger/journals/${journalId}`)).body.journal.totalCreditCents);
  assert.equal((await get(`/api/ledger/journals/${journalId}`,2,5)).status,404);
  assert.equal((await get('/api/ledger/trial-balance?asOf=2026-02-30')).status,400);
  assert.equal((await get('/api/ledger/trial-balance?asOf=2026-99-99')).status,400);
  assert.equal((await get('/api/ledger/trial-balance?asOf=not-a-date')).status,400);
  assert.equal((await get('/api/ledger/reports?period=2026-13')).status,400);
  assert.equal((await get('/api/ledger/reports?period=2026-99')).status,400);
  assert.equal((await get('/api/ledger/journals?period=2026-99')).status,400);
});

test('legacy approved zero-value invoice backfills as a balanced source journal', t => {
  const db = fixture(t);
  const invoiceId = Number(db.prepare("INSERT INTO invoices(company_id,branch_id,gstin_id,party_id,number,type,status,invoice_date,subtotal_cents,tax_cents,total_cents,created_by,submitted_by,approved_by) VALUES (1,1,1,1,'ZERO-LEGACY-1','sale','approved','2026-09-24',0,0,0,1,1,2)").run().lastInsertRowid);
  assert.deepEqual(syncLedgerSources(db),{invoices:1,payments:0});
  const journal = postInvoice(db,invoiceId);
  assert.equal(journal.sourceId,invoiceId);
  assert.equal(journal.totalDebitCents,0);
  assert.equal(journal.totalCreditCents,0);
  assert.deepEqual(journal.lines,[]);
  assert.deepEqual(syncLedgerSources(db),{invoices:0,payments:0});
});

test('zero-price purchase approves and posts without stranding submitted state', async t => {
  const db = fixture(t);
  const server = createApp({db}).listen(0);
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = async (method,path,body,userId=1) => {
    const response = await fetch(`${base}${path}`,{
      method,headers:{'content-type':'application/json','x-company-id':'1','x-user-id':String(userId)},
      body:body === undefined ? undefined : JSON.stringify(body),
    });
    return {status:response.status,body:await response.json()};
  };
  const draft = await request('POST','/api/invoices',{
    type:'purchase',partyId:2,branchId:1,gstinId:1,invoiceDate:'2026-09-24',
    lines:[{itemId:1,quantity:1,unitPriceCents:0}],
  });
  assert.equal(draft.status,200);
  const id = draft.body.invoice.id;
  assert.equal((await request('POST',`/api/invoices/${id}/submit`)).status,200);
  const approval = await request('POST',`/api/invoices/${id}/approve`,{},2);
  assert.equal(approval.status,200);
  assert.equal(approval.body.invoice.status,'approved');
  const journal = db.prepare("SELECT id FROM journals WHERE source_type='invoice' AND source_id=?").get(id);
  assert.ok(journal);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM journal_lines WHERE journal_id=?').get(journal.id).count,0);
});
