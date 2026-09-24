import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { openDatabase } = require('../db.cjs');
const { createApp } = require('../api.cjs');
const { grantGstin, grantBranch } = require('../access.cjs');

async function fixture(t) {
  const db = openDatabase(':memory:');
  const userId = Number(db.prepare("INSERT INTO users(company_id,name,role) VALUES (1,'Scoped Finance Accountant','accountant')").run().lastInsertRowid);
  grantGstin(db,{companyId:1,actorId:3,userId,gstinId:1,reason:'Assigned Mumbai registration'});
  grantBranch(db,{companyId:1,actorId:3,userId,branchId:1,reason:'Assigned Mumbai branch'});
  const server = createApp({db}).listen(0);
  t.after(() => { server.close(); db.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = async (method,path,body) => {
    const response = await fetch(`${base}${path}`,{
      method,
      headers:{'content-type':'application/json','x-company-id':'1','x-user-id':String(userId)},
      body:body === undefined ? undefined : JSON.stringify(body),
    });
    return {status:response.status,data:await response.json()};
  };
  return {db,request};
}

test('partial accountant sees only granted finance and cashier branches, never denied source IDs',async t => {
  const {db,request} = await fixture(t);
  const allowedInvoice = db.prepare("SELECT id FROM invoices WHERE company_id=1 AND branch_id=1 AND status='approved' LIMIT 1").get();
  const deniedInvoice = db.prepare("SELECT id FROM invoices WHERE company_id=1 AND branch_id=3 AND status='approved' LIMIT 1").get();
  assert.ok(allowedInvoice && deniedInvoice);
  const open = await request('GET','/api/finance/open?type=sale');
  assert.equal(open.status,200);
  assert.ok(open.data.invoices.every(row => row.branchId === 1));
  assert.equal((await request('GET',`/api/finance/payments?invoiceId=${allowedInvoice.id}`)).status,200);
  assert.equal((await request('GET',`/api/finance/payments?invoiceId=${deniedInvoice.id}`)).status,403);
  assert.equal((await request('POST','/api/finance/payments',{
    invoiceId:deniedInvoice.id,amountCents:100,method:'bank',reference:'DENIED-SCOPE',paymentDate:'2026-09-24',
  })).status,403);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM invoice_payments WHERE reference='DENIED-SCOPE'").get().count,0);
  assert.equal((await request('GET','/api/cashier/eligible-payments?branchId=3&businessDate=2026-09-24')).status,403);
  assert.equal((await request('POST','/api/cashier/sessions',{
    branchId:3,businessDate:'2026-09-24',openingCashCents:0,
  })).status,403);
  const deniedSessionId = Number(db.prepare(`INSERT INTO cashier_sessions
    (company_id,branch_id,business_date,opening_cash_cents,opened_by) VALUES (1,3,'2026-09-24',0,3)`).run().lastInsertRowid);
  assert.equal((await request('GET',`/api/cashier/sessions/${deniedSessionId}`)).status,403);
  assert.equal((await request('POST',`/api/cashier/sessions/${deniedSessionId}/close`,{
    countedCashCents:0,notes:'',
  })).status,403);
  const sessions = await request('GET','/api/cashier/sessions');
  assert.equal(sessions.status,200);
  assert.ok(sessions.data.sessions.every(row => row.branchId === 1));
});

test('partial accountant cannot read company-wide bank and ledger aggregates or denied journal IDs',async t => {
  const {db,request} = await fixture(t);
  for (const path of ['/api/bank/accounts','/api/bank/payments/unassigned','/api/ledger/accounts',
    '/api/ledger/trial-balance','/api/ledger/reports','/api/ledger/party/1']) {
    assert.equal((await request('GET',path)).status,403,path);
  }
  const journal = db.prepare('SELECT id FROM journals WHERE company_id=1 AND branch_id=3 LIMIT 1').get();
  assert.ok(journal);
  assert.equal((await request('GET',`/api/ledger/journals/${journal.id}`)).status,403);
  const list = await request('GET','/api/ledger/journals');
  assert.equal(list.status,200);
  assert.ok(list.data.journals.every(row => row.branchId === 1));
});

test('branch report hides GSTIN-wide periods until all branches are granted',async t => {
  const {request} = await fixture(t);
  const scoped = await request('GET','/api/reports/operations?from=2020-01-01&to=2030-12-31&branchId=1');
  assert.equal(scoped.status,200);
  assert.ok(scoped.data.invoices.every(row => row.branchId === 1));
  assert.deepEqual(scoped.data.gstPeriods,[]);
  assert.equal((await request('GET','/api/reports/operations?from=2020-01-01&to=2030-12-31&branchId=3')).status,403);
  assert.equal((await request('GET','/api/reports/operations?from=2020-01-01&to=2030-12-31&gstinId=1')).status,403);
  assert.equal((await request('GET','/api/reports/operations?from=2020-01-01&to=2030-12-31')).status,403);
});
