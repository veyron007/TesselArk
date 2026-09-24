import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { openDatabase } = require('../db.cjs');
const { registerBudgetsRoutes } = require('../budgets.cjs');
const { seedBudgetsDemo } = require('../budgets-db.cjs');

async function fixture(t) {
  const db = openDatabase(':memory:');
  const app = express();
  app.use(express.json());
  app.use('/api', (req,_res,next) => {
    req.company = db.prepare('SELECT * FROM companies WHERE id=?').get(Number(req.header('x-company-id') || 1));
    req.user = db.prepare('SELECT * FROM users WHERE id=? AND company_id=?').get(Number(req.header('x-user-id') || 1),req.company?.id);
    if (!req.company || !req.user) return next(Object.assign(new Error('Unknown company or user'),{status:403}));
    next();
  });
  registerBudgetsRoutes(app,db);
  app.use((error,_req,res,_next) => res.status(error.status || 500).json({error:error.message}));
  const server = app.listen(0);
  t.after(() => { server.close(); db.close(); });
  const api = async (method,path,body,userId=1,companyId=1) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`,{method,headers:{'content-type':'application/json','x-company-id':String(companyId),'x-user-id':String(userId)},body:body === undefined ? undefined : JSON.stringify(body)});
    return {status:response.status,data:await response.json()};
  };
  return {db,api};
}

async function centre(api) {
  const result = await api('POST','/api/budgets/centres',{gstinId:1,branchId:1,code:'MFG',name:'Manufacturing',purpose:'Branch manufacturing costs and revenue'},2);
  assert.equal(result.status,200);
  return result.data.centre.id;
}

test('scoped centre, separate plans and independent approval create variance only after review',async t => {
  const {db,api} = await fixture(t);
  const centreId = await centre(api);
  const sale = db.prepare("SELECT l.id,i.invoice_date FROM invoice_lines l JOIN invoices i ON i.id=l.invoice_id WHERE i.company_id=1 AND i.gstin_id=1 AND i.branch_id=1 AND i.type='sale' AND i.status='approved' AND l.subtotal_cents>=12345 ORDER BY l.id LIMIT 1").get();
  assert.ok(sale);
  const period = sale.invoice_date.slice(0,7);
  const plan = await api('POST','/api/budgets/plans',{centreId,period,measure:'sales',amountCents:20000,basis:'Approved net-of-tax invoice subtotal target',clientReference:'PLAN-SALES-1'});
  assert.equal(plan.status,200);
  assert.equal((await api('POST',`/api/budgets/plans/${plan.data.plan.id}/review`,{decision:'approve',reason:'Own request'},1)).status,403);
  const pending = await api('GET',`/api/budgets/overview?gstinId=1&branchId=1&period=${period}`);
  assert.equal(pending.status,200);
  assert.equal(pending.data.rows.find(row => row.centreId===centreId && row.measure==='sales').planCents,null);
  const approved = await api('POST',`/api/budgets/plans/${plan.data.plan.id}/review`,{decision:'approve',reason:'Sales plan reviewed'},2);
  assert.equal(approved.status,200);
  assert.equal((await api('POST',`/api/budgets/plans/${plan.data.plan.id}/review`,{decision:'approve',reason:'Sales plan reviewed'},2)).data.replayed,true);
  const allocation = await api('POST','/api/budgets/allocations',{centreId,sourceType:'sale_line',sourceId:sale.id,amountCents:12345,basis:'12,345 paise of line assigned to manufacturing',clientReference:'ALLOC-SALES-1'});
  assert.equal(allocation.status,200);
  assert.equal((await api('POST',`/api/budgets/allocations/${allocation.data.allocation.id}/review`,{decision:'approve',reason:'Source checked'},2)).status,200);
  const overview = await api('GET',`/api/budgets/overview?gstinId=1&branchId=1&period=${period}`);
  const sales = overview.data.rows.find(row => row.centreId===centreId && row.measure==='sales');
  const expense = overview.data.rows.find(row => row.centreId===centreId && row.measure==='expense');
  assert.equal(sales.planCents,20000);
  assert.equal(sales.actualCents,12345);
  assert.equal(sales.varianceCents,-7655);
  assert.deepEqual(sales.allocationIds,[allocation.data.allocation.id]);
  assert.equal(expense.actualCents,0);
  assert.equal(expense.planCents,null);
  assert.match(overview.data.allocations[0].basis,/line assigned/);
  assert.ok(overview.data.events.some(event => event.action==='approved' && event.entityType==='allocation'));
});

test('allocation capacity uses integer paise and replays cannot change source or basis',async t => {
  const {db,api} = await fixture(t);
  const centreId = await centre(api);
  const line = db.prepare("SELECT l.id,l.subtotal_cents,i.invoice_date FROM invoice_lines l JOIN invoices i ON i.id=l.invoice_id WHERE i.company_id=1 AND i.gstin_id=1 AND i.branch_id=1 AND i.type='purchase' AND i.status='approved' AND l.subtotal_cents>1 ORDER BY l.id LIMIT 1").get();
  assert.ok(line);
  const body = {centreId,sourceType:'purchase_line',sourceId:line.id,amountCents:line.subtotal_cents-1,basis:'All but one paise of approved purchase line',clientReference:'ALLOC-PUR-1'};
  const first = await api('POST','/api/budgets/allocations',body);
  assert.equal(first.status,200);
  assert.equal((await api('POST','/api/budgets/allocations',body)).data.replayed,true);
  assert.equal((await api('POST','/api/budgets/allocations',{...body,basis:'Changed reason'})).status,409);
  assert.equal((await api('POST','/api/budgets/allocations',{...body,clientReference:'ALLOC-PUR-2',amountCents:2})).status,409);
  assert.equal((await api('POST','/api/budgets/allocations',{...body,clientReference:'ALLOC-PUR-2',amountCents:1})).status,200);
  assert.equal((await api('POST',`/api/budgets/allocations/${first.data.allocation.id}/review`,{decision:'reject',reason:'Wrong attribution'},2)).status,200);
  assert.equal((await api('POST','/api/budgets/allocations',{...body,clientReference:'ALLOC-PUR-3',amountCents:line.subtotal_cents-1})).status,200);
  assert.equal((await api('POST','/api/budgets/allocations',{...body,clientReference:'ALLOC-PUR-4',amountCents:1.5})).status,400);
});

test('rejected plan can be corrected while an active plan remains unique',async t => {
  const {api} = await fixture(t);
  const centreId = await centre(api);
  const first = await api('POST','/api/budgets/plans',{centreId,period:'2026-09',measure:'expense',amountCents:10000,basis:'Draft expense estimate',clientReference:'EXPENSE-1'});
  assert.equal(first.status,200);
  assert.equal((await api('POST',`/api/budgets/plans/${first.data.plan.id}/review`,{decision:'reject',reason:'Missing cost rationale'},2)).status,200);
  const corrected = await api('POST','/api/budgets/plans',{centreId,period:'2026-09',measure:'expense',amountCents:12000,basis:'Revised line-item cost estimate',clientReference:'EXPENSE-2'});
  assert.equal(corrected.status,200);
  assert.equal((await api('POST','/api/budgets/plans',{centreId,period:'2026-09',measure:'expense',amountCents:13000,basis:'Competing estimate',clientReference:'EXPENSE-3'})).status,409);
});

test('lost-response retry reuses the allocation reference and counts actual once',async t => {
  const {db,api} = await fixture(t);
  const centreId = await centre(api);
  const line = db.prepare("SELECT l.id,i.invoice_date FROM invoice_lines l JOIN invoices i ON i.id=l.invoice_id WHERE i.company_id=1 AND i.gstin_id=1 AND i.branch_id=1 AND i.type='sale' AND i.status='approved' AND l.subtotal_cents>=5000 ORDER BY l.id LIMIT 1").get();
  const body = {centreId,sourceType:'sale_line',sourceId:line.id,amountCents:5000,basis:'Partial source share after branch attribution',clientReference:'RETRY-ALLOC-1'};
  const acceptedResponse = await api('POST','/api/budgets/allocations',body);
  assert.equal(acceptedResponse.status,200);
  // The caller loses the successful response and resends the same payload and key.
  const retried = await api('POST','/api/budgets/allocations',body);
  assert.equal(retried.status,200);
  assert.equal(retried.data.replayed,true);
  assert.equal(retried.data.allocation.id,acceptedResponse.data.allocation.id);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM budget_allocations WHERE company_id=1 AND client_reference='RETRY-ALLOC-1'").get().n,1);
  assert.equal((await api('POST',`/api/budgets/allocations/${retried.data.allocation.id}/review`,{decision:'approve',reason:'Source verified independently'},2)).status,200);
  const overview = await api('GET',`/api/budgets/overview?gstinId=1&branchId=1&period=${line.invoice_date.slice(0,7)}`);
  assert.equal(overview.data.rows.find(row => row.centreId===centreId && row.measure==='sales').actualCents,5000);
});

test('collection actual uses payment date and source, without changing accounting or GST',async t => {
  const {db,api} = await fixture(t);
  const centreId = await centre(api);
  const payment = db.prepare("SELECT p.id,p.amount_cents,p.payment_date FROM invoice_payments p JOIN invoices i ON i.id=p.invoice_id WHERE i.company_id=1 AND i.gstin_id=1 AND i.branch_id=1 AND i.type='sale' AND i.status='approved' ORDER BY p.id LIMIT 1").get();
  assert.ok(payment);
  const journalBefore = db.prepare('SELECT COUNT(*) AS n FROM journals').get().n;
  const periodBefore = db.prepare('SELECT COUNT(*) AS n FROM gst_periods').get().n;
  const allocation = await api('POST','/api/budgets/allocations',{centreId,sourceType:'sale_receipt',sourceId:payment.id,amountCents:payment.amount_cents,basis:'Recorded payment attributed to manufacturing',clientReference:'ALLOC-COLL-1'});
  assert.equal(allocation.status,200);
  assert.equal((await api('POST',`/api/budgets/allocations/${allocation.data.allocation.id}/review`,{decision:'approve',reason:'Payment source checked'},2)).status,200);
  const overview = await api('GET',`/api/budgets/overview?gstinId=1&branchId=1&period=${payment.payment_date.slice(0,7)}`);
  assert.equal(overview.data.rows.find(row => row.centreId===centreId && row.measure==='collections').actualCents,payment.amount_cents);
  assert.equal(overview.data.rows.find(row => row.centreId===centreId && row.measure==='sales').actualCents,0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM journals').get().n,journalBefore);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM gst_periods').get().n,periodBefore);
});

test('company, GSTIN, branch grants and approved source status are enforced',async t => {
  const {db,api} = await fixture(t);
  assert.equal((await api('POST','/api/budgets/centres',{gstinId:1,branchId:1,code:'NO',name:'No',purpose:'Staff cannot create'},1)).status,403);
  const centreId = await centre(api);
  assert.equal((await api('GET','/api/budgets/overview?gstinId=1&branchId=3&period=2026-08')).status,404);
  assert.equal((await api('GET','/api/budgets/overview?gstinId=1&branchId=1&period=2026-08',undefined,4,2)).status,404);
  const other = db.prepare("SELECT l.id FROM invoice_lines l JOIN invoices i ON i.id=l.invoice_id WHERE i.company_id=1 AND i.branch_id=3 AND i.type='sale' AND i.status='approved' LIMIT 1").get();
  assert.ok(other);
  assert.equal((await api('POST','/api/budgets/allocations',{centreId,sourceType:'sale_line',sourceId:other.id,amountCents:1,basis:'Wrong branch',clientReference:'BAD-SCOPE'})).status,400);
  const draft = db.prepare("SELECT l.id FROM invoice_lines l JOIN invoices i ON i.id=l.invoice_id WHERE i.company_id=1 AND i.type='sale' AND i.status='draft' LIMIT 1").get();
  if (draft) assert.equal((await api('POST','/api/budgets/allocations',{centreId,sourceType:'sale_line',sourceId:draft.id,amountCents:1,basis:'Draft invoice',clientReference:'BAD-DRAFT'})).status,404);
  db.prepare('UPDATE user_branch_grants SET revoked_at=CURRENT_TIMESTAMP,revoked_by=3,revoked_reason=\'Test revoke\' WHERE company_id=1 AND user_id=1 AND branch_id=1 AND revoked_at IS NULL').run();
  assert.equal((await api('GET','/api/budgets/overview?gstinId=1&branchId=1&period=2026-08')).status,403);
});

test('synthetic seed is idempotent and explicitly invoked',async t => {
  const {db} = await fixture(t);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM budget_centres').get().n,0);
  assert.equal(seedBudgetsDemo(db),true);
  const counts = ['budget_centres','budget_plans','budget_allocations','budget_events'].map(table => db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n);
  assert.equal(seedBudgetsDemo(db),false);
  assert.deepEqual(['budget_centres','budget_plans','budget_allocations','budget_events'].map(table => db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n),counts);
  assert.equal(counts[0],1);
  assert.equal(counts[1],3);
});
