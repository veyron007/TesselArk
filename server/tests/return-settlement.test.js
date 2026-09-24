import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createApp } = require('../api.cjs');
const { openDatabase } = require('../db.cjs');
const { installReturnSettlementSchema } = require('../return-settlement-db.cjs');
const { registerReturnSettlementRoutes, invoiceSettlementBalance } = require('../return-settlement.cjs');

async function fixture(t) {
  const db = openDatabase(':memory:');
  installReturnSettlementSchema(db);
  const app = createApp({ db });
  registerReturnSettlementRoutes(app, db);
  app.use((error, _req, res, _next) => res.status(error.status || 500).json({ error:error.message }));
  const server = app.listen(0);
  t.after(() => { server.close(); db.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const api = async (method, path, body, companyId=1, userId=2) => {
    const response = await fetch(base+path, { method, headers:{ 'content-type':'application/json','x-company-id':String(companyId),'x-user-id':String(userId) }, body:body===undefined?undefined:JSON.stringify(body) });
    return { status:response.status, data:await response.json() };
  };
  return { db, api };
}

function seededReturn(db) {
  return db.prepare("SELECT r.*,v.total_cents FROM returns r JOIN invoices v ON v.id=r.invoice_id WHERE r.company_id=1 AND r.status='approved' AND r.kind='sales_return' AND r.subtotal_cents>0 ORDER BY r.id LIMIT 1").get();
}

test('approved sale return commercial settlement posts once and leaves GST proposal untouched', async t => {
  const { db, api } = await fixture(t);
  const row = seededReturn(db);
  const beforeGst = db.prepare('SELECT SUM(tax_cents) AS cents FROM invoices WHERE company_id=1 AND status=\'approved\'').get().cents;
  const first = await api('POST','/api/return-settlements',{ returnId:row.id,settlementDate:'2026-09-24' });
  assert.equal(first.status,200);
  assert.equal(first.data.settlement.amountCents,row.subtotal_cents);
  assert.equal(first.data.settlement.taxProposalCents,row.tax_proposal_cents);
  assert.equal(first.data.settlement.taxPostingStatus,'excluded_pending_review');
  const journal = db.prepare("SELECT * FROM journals WHERE source_type='return_settlement' AND source_id=?").get(row.id);
  assert.ok(journal);
  const lines = db.prepare('SELECT a.code,l.debit_cents,l.credit_cents FROM journal_lines l JOIN ledger_accounts a ON a.id=l.account_id WHERE l.journal_id=? ORDER BY a.code').all(journal.id);
  assert.deepEqual(lines.map(line=>[line.code,line.debit_cents,line.credit_cents]),[['1200',0,row.subtotal_cents],['4100',row.subtotal_cents,0]]);
  assert.equal(db.prepare('SELECT SUM(tax_cents) AS cents FROM invoices WHERE company_id=1 AND status=\'approved\'').get().cents,beforeGst);
  const replay = await api('POST','/api/return-settlements',{ returnId:row.id,settlementDate:'2026-09-24' });
  assert.equal(replay.status,200);
  assert.equal(replay.data.alreadySettled,true);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM journals WHERE source_type=\'return_settlement\' AND source_id=?').get(row.id).n,1);
  const changed = await api('POST','/api/return-settlements',{ returnId:row.id,settlementDate:'2026-09-25' });
  assert.equal(changed.status,409);
});

test('balance reconciles payments and commercial adjustments, including customer refund due', async t => {
  const { db, api } = await fixture(t);
  const row = seededReturn(db);
  const existingPaid = db.prepare('SELECT COALESCE(SUM(amount_cents),0) AS cents FROM invoice_payments WHERE invoice_id=?').get(row.invoice_id).cents;
  const fullPayment = await api('POST','/api/finance/payments',{invoiceId:row.invoice_id,amountCents:row.total_cents-existingPaid,method:'bank',reference:'FULL-BEFORE-RETURN',paymentDate:'2026-09-24'});
  assert.equal(fullPayment.status,200);
  const paid = row.total_cents;
  const posted = await api('POST','/api/return-settlements',{ returnId:row.id,settlementDate:'2026-09-24' });
  assert.equal(posted.status,200);
  const balance = await api('GET',`/api/return-settlements/balance?invoiceId=${row.invoice_id}`);
  assert.equal(balance.status,200);
  assert.equal(balance.data.balance.adjustedTotalCents,row.total_cents-row.subtotal_cents);
  assert.equal(balance.data.balance.outstandingCents,Math.max(0,row.total_cents-row.subtotal_cents-paid));
  assert.equal(balance.data.balance.refundableCents,row.subtotal_cents);
  assert.equal(balance.data.balance.pendingTaxProposalCents,row.tax_proposal_cents);
  const direct = invoiceSettlementBalance(db,row.invoice_id,1);
  assert.equal(direct.outstandingCents,balance.data.balance.outstandingCents);
  const list = await api('GET',`/api/return-settlements?invoiceId=${row.invoice_id}`);
  assert.equal(list.data.settlements.length,1);
});

test('company, role, approval and source amount boundaries prevent invalid settlement', async t => {
  const { db, api } = await fixture(t);
  const row = seededReturn(db);
  const body = {returnId:row.id,settlementDate:'2026-09-24'};
  assert.equal((await api('POST','/api/return-settlements',body,1,1)).status,403);
  assert.equal((await api('POST','/api/return-settlements',body,2,5)).status,404);
  assert.equal((await api('GET',`/api/return-settlements/balance?invoiceId=${row.invoice_id}`,undefined,2,5)).status,404);
  assert.equal((await api('POST','/api/return-settlements',{...body,settlementDate:'2026-02-30'})).status,400);
  const draft = db.prepare("SELECT id FROM returns WHERE company_id=1 AND status='draft' LIMIT 1").get();
  assert.ok(draft);
  assert.equal((await api('POST','/api/return-settlements',{returnId:draft.id,settlementDate:'2026-09-24'})).status,409);
  db.prepare('UPDATE returns SET subtotal_cents=subtotal_cents+1 WHERE id=?').run(row.id);
  assert.equal((await api('POST','/api/return-settlements',body)).status,409);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM return_settlements').get().n,0);
});

test('purchase return settlement debits payable and credits purchases', async t => {
  const { db, api } = await fixture(t);
  const source = db.prepare("SELECT v.id,l.id AS line_id FROM invoices v JOIN invoice_lines l ON l.invoice_id=v.id WHERE v.company_id=1 AND v.type='purchase' AND v.status='approved' AND l.subtotal_cents>0 ORDER BY v.id LIMIT 1").get();
  assert.ok(source);
  const created = await api('POST','/api/returns',{invoiceId:source.id,lines:[{invoiceLineId:source.line_id,quantity:1}],reason:'Supplier goods rejected'},1,1);
  assert.equal(created.status,200);
  assert.equal((await api('POST',`/api/returns/${created.data.return.id}/approve`,{})).status,200);
  const settled = await api('POST','/api/return-settlements',{returnId:created.data.return.id,settlementDate:'2026-09-24'});
  assert.equal(settled.status,200);
  const journal = db.prepare("SELECT id FROM journals WHERE source_type='return_settlement' AND source_id=?").get(created.data.return.id);
  const lines = db.prepare('SELECT a.code,l.debit_cents,l.credit_cents FROM journal_lines l JOIN ledger_accounts a ON a.id=l.account_id WHERE l.journal_id=? ORDER BY a.code').all(journal.id);
  assert.deepEqual(lines.map(line=>[line.code,line.debit_cents,line.credit_cents]),[['2100',settled.data.settlement.amountCents,0],['5100',0,settled.data.settlement.amountCents]]);
});
