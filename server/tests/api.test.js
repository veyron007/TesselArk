import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createApp } = require('../api.cjs');
const { openDatabase } = require('../db.cjs');

async function fixture(t) {
  const db = openDatabase(':memory:');
  const server = createApp({ db }).listen(0);
  t.after(() => { server.close(); db.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const api = async (method, path, body, companyId = 1, userId = 1) => {
    const response = await fetch(`${base}${path}`, { method, headers: { 'content-type':'application/json','x-company-id':String(companyId),'x-user-id':String(userId) }, body:body === undefined ? undefined : JSON.stringify(body) });
    return { status:response.status, data:await response.json() };
  };
  api.db = db;
  return api;
}

test('bootstrap contains scoped synthetic companies, branches, GSTINs, and roles', async t => {
  const api = await fixture(t);
  const { status, data } = await api('GET','/api/bootstrap');
  assert.equal(status,200);
  assert.equal(data.demoMode,true);
  assert.equal(data.companies.length,3);
  assert.equal(data.companies.reduce((n,c)=>n+c.gstins.length,0),2);
  assert.equal(data.companies[0].branches.length,3);
  assert.equal(data.companies[1].gstins.length,0);
  assert.equal(data.companies[2].taxRegime,'composition');
  assert.equal((await api('GET','/api/items',undefined,2,1)).status,403);
  assert.equal((await api('GET','/api/items',undefined,2,4)).data.items.every(x=>x.companyId===2),true);
});

test('revoked GSTIN and branch grants hide core records and reject direct writes', async t => {
  const api = await fixture(t);
  const db = api.db;
  const bengaluru = db.prepare('SELECT id FROM invoices WHERE company_id=1 AND branch_id=3 ORDER BY id LIMIT 1').get().id;
  const mumbai = db.prepare('SELECT id FROM invoices WHERE company_id=1 AND branch_id=1 ORDER BY id LIMIT 1').get().id;
  const deniedPeriod = db.prepare('SELECT id FROM gst_periods WHERE company_id=1 AND gstin_id=2 LIMIT 1').get().id;
  db.prepare("UPDATE user_branch_grants SET revoked_by=3,revoked_at=CURRENT_TIMESTAMP,revoked_reason='Scope test' WHERE company_id=1 AND user_id=1 AND branch_id=1 AND revoked_at IS NULL").run();
  db.prepare("UPDATE user_gstin_grants SET revoked_by=3,revoked_at=CURRENT_TIMESTAMP,revoked_reason='Scope test' WHERE company_id=1 AND user_id=1 AND gstin_id=2 AND revoked_at IS NULL").run();
  const boot = await api('GET','/api/bootstrap');
  assert.deepEqual(boot.data.companies.find(row => row.id === 1).gstins.map(row => row.id),[1]);
  assert.deepEqual(boot.data.companies.find(row => row.id === 1).branches.map(row => row.id),[2]);
  assert.deepEqual((await api('GET','/api/stock')).data.stock.map(row => row.branchId).filter((id,index,all) => all.indexOf(id) === index),[2]);
  assert.equal((await api('GET','/api/stock?branchId=1')).status,403);
  assert.equal((await api('POST','/api/stock/movements',{itemId:1,branchId:1,type:'receipt',quantity:1,reason:'Denied'})).status,403);
  assert.equal((await api('GET','/api/invoices')).data.invoices.every(row => row.branchId === 2),true);
  assert.equal((await api('GET',`/api/invoices/${mumbai}`)).status,403);
  assert.equal((await api('POST',`/api/invoices/${bengaluru}/submit`,{})).status,403);
  assert.equal((await api('POST','/api/invoices',{type:'sale',partyId:1,branchId:1,gstinId:1,invoiceDate:'2026-09-24',lines:[{itemId:1,quantity:1,unitPriceCents:100}]})).status,403);
  assert.equal((await api('GET','/api/gst/purchase-evidence?gstinId=2')).status,403);
  assert.equal((await api('GET','/api/gst/purchase-evidence')).data.evidence.length,0);
  assert.equal((await api('GET','/api/gst/periods')).data.periods.length,0);
  assert.equal((await api('GET',`/api/gst/periods/${deniedPeriod}`)).status,403);
  const partiallyGrantedPeriod = db.prepare('SELECT id FROM gst_periods WHERE company_id=1 AND gstin_id=1 LIMIT 1').get().id;
  assert.equal((await api('GET',`/api/gst/periods/${partiallyGrantedPeriod}`)).status,403);
  assert.equal((await api('GET','/api/gst/periods?gstinId=1')).status,403);
  db.prepare("UPDATE user_branch_grants SET revoked_by=3,revoked_at=CURRENT_TIMESTAMP,revoked_reason='Scope test' WHERE company_id=1 AND user_id=2 AND branch_id=1 AND revoked_at IS NULL").run();
  assert.equal((await api('POST',`/api/gst/periods/${partiallyGrantedPeriod}/review`,{},1,2)).status,403);
  const dashboard = await api('GET','/api/dashboard');
  assert.equal(dashboard.data.recentActivity.every(row => row.branchId === 2),true);
  assert.equal(dashboard.data.stats.invoices,(await api('GET','/api/invoices')).data.invoices.length);
});

test('a user with no branch grant cannot read or change company master records', async t => {
  const api = await fixture(t);
  api.db.prepare("UPDATE user_branch_grants SET revoked_by=3,revoked_at=CURRENT_TIMESTAMP,revoked_reason='Scope test' WHERE company_id=1 AND user_id=1 AND revoked_at IS NULL").run();
  assert.equal((await api('GET','/api/items')).status,403);
  assert.equal((await api('GET','/api/parties')).status,403);
  assert.equal((await api('POST','/api/items',{sku:'DENIED',name:'Denied'})).status,403);
  assert.equal((await api('POST','/api/parties',{name:'Denied'})).status,403);
  assert.equal((await api('GET','/api/invoices')).data.invoices.length,0);
  const dashboard = await api('GET','/api/dashboard');
  assert.equal(dashboard.data.stats.items,0);
  assert.equal(dashboard.data.stats.parties,0);
  assert.equal(dashboard.data.stats.invoices,0);
});

test('invoice approval posts stock exactly once and GST includes only approved invoices', async t => {
  const api = await fixture(t);
  const input = { type:'sale',partyId:1,branchId:1,gstinId:1,invoiceDate:new Date().toISOString().slice(0,10),lines:[{itemId:1,quantity:3,unitPriceCents:10000,gstRateBps:1200}],notes:'Demo sale' };
  const created = await api('POST','/api/invoices',input);
  assert.equal(created.status,200);
  assert.equal(created.data.invoice.totalCents,33600);
  const id = created.data.invoice.id;
  const before = await api('GET','/api/gst/periods');
  assert.equal(before.data.periods.find(x=>x.gstinId===1).salesTaxCents,2400);
  assert.equal((await api('POST',`/api/invoices/${id}/submit`,{})).data.invoice.status,'submitted');
  assert.equal((await api('POST',`/api/invoices/${id}/approve`,{},1,1)).status,403);
  const approved = await api('POST',`/api/invoices/${id}/approve`,{},1,2);
  assert.equal(approved.data.invoice.status,'approved');
  assert.equal((await api('POST',`/api/invoices/${id}/approve`,{},1,2)).status,409);
  const stock = await api('GET','/api/stock?branchId=1');
  assert.equal(stock.data.stock.find(x=>x.itemId===1).quantity,40);
  const after = await api('GET','/api/gst/periods');
  const period = after.data.periods.find(x=>x.gstinId===1);
  assert.equal(period.salesTaxCents,6000);
  assert.equal(period.purchaseTaxCents,6000);
  assert.equal(period.eligibleItcCents,0);
  assert.equal(period.localEstimateCents,6000);
  assert.equal((await api('GET',`/api/gst/periods/${period.id}`)).data.period.transactions.some(x=>x.id===id),true);
});

test('review notes persist; reviewed period blocks backdated posting', async t => {
  const api = await fixture(t);
  const periods = await api('GET','/api/gst/periods');
  const id = periods.data.periods.find(x=>x.gstinId===2).id;
  assert.equal((await api('POST',`/api/gst/periods/${id}/review`,{notes:'Awaiting source evidence'},1,1)).status,403);
  const reviewed = await api('POST',`/api/gst/periods/${id}/review`,{notes:'Awaiting source evidence'},1,2);
  assert.equal(reviewed.data.period.reviewNotes,'Awaiting source evidence');
  assert.equal(reviewed.data.period.status,'reviewed');
  assert.equal((await api('POST',`/api/gst/periods/${id}/approve`,{},1,3)).data.period.status,'approved');
  const input = { type:'sale',partyId:1,branchId:3,gstinId:2,invoiceDate:new Date().toISOString().slice(0,10),lines:[{itemId:1,quantity:1,unitPriceCents:100}] };
  const created = await api('POST','/api/invoices',input);
  await api('POST',`/api/invoices/${created.data.invoice.id}/submit`,{});
  assert.equal((await api('POST',`/api/invoices/${created.data.invoice.id}/approve`,{},1,2)).status,409);
});

test('invoice creator and submitter cannot approve their own invoice', async t => {
  const api = await fixture(t);
  const body = {type:'sale',partyId:1,branchId:1,gstinId:1,invoiceDate:new Date().toISOString().slice(0,10),lines:[{itemId:1,quantity:1,unitPriceCents:1000}]};
  const creatorOwned = await api('POST','/api/invoices',body,1,2);
  const firstId = creatorOwned.data.invoice.id;
  await api('POST',`/api/invoices/${firstId}/submit`,{},1,1);
  assert.equal((await api('POST',`/api/invoices/${firstId}/approve`,{},1,2)).status,403);
  assert.equal((await api('GET',`/api/invoices/${firstId}`)).data.invoice.status,'submitted');
  assert.equal((await api('POST',`/api/invoices/${firstId}/approve`,{},1,3)).status,200);
  const submitterOwned = await api('POST','/api/invoices',body,1,1);
  const secondId = submitterOwned.data.invoice.id;
  await api('POST',`/api/invoices/${secondId}/submit`,{},1,2);
  assert.equal((await api('POST',`/api/invoices/${secondId}/approve`,{},1,2)).status,403);
  assert.equal((await api('POST',`/api/invoices/${secondId}/approve`,{},1,3)).status,200);
});

test('GST period reviewer cannot approve their own review', async t => {
  const api = await fixture(t);
  const id = (await api('GET','/api/gst/periods')).data.periods.find(row => row.gstinId === 2 && row.period === new Date().toISOString().slice(0,7)).id;
  assert.equal((await api('POST',`/api/gst/periods/${id}/review`,{notes:'Accountant review'},1,2)).status,200);
  assert.equal((await api('POST',`/api/gst/periods/${id}/approve`,{},1,2)).status,403);
  assert.equal((await api('GET',`/api/gst/periods/${id}`)).data.period.status,'reviewed');
  assert.equal((await api('POST',`/api/gst/periods/${id}/approve`,{},1,3)).status,200);
});

test('stock cannot go below zero; composition demo blocks ordinary GST', async t => {
  const api = await fixture(t);
  assert.equal((await api('POST','/api/stock/movements',{itemId:1,branchId:1,type:'issue',quantity:999,reason:'Too many'})).status,409);
  const composition = { type:'sale',partyId:6,branchId:5,gstinId:4,invoiceDate:new Date().toISOString().slice(0,10),lines:[{itemId:5,quantity:1,unitPriceCents:1000,gstRateBps:1200}] };
  assert.equal((await api('POST','/api/invoices',composition,3,6)).status,400);
  composition.lines[0].gstRateBps = 0;
  assert.equal((await api('POST','/api/invoices',composition,3,6)).data.invoice.taxCents,0);
});

test('synthetic 2B match, eligibility, and preview count only reviewed credit', async t => {
  const api = await fixture(t);
  const list = await api('GET','/api/gst/purchase-evidence?gstinId=1');
  assert.equal(list.status,200);
  assert.equal(list.data.evidence.length,2);
  const matching = list.data.evidence.find(x=>x.supplierInvoiceNumber==='NS-501');
  const differing = list.data.evidence.find(x=>x.supplierInvoiceNumber==='NS-502');
  assert.equal(matching.candidateSource.taxableCents,30000);
  assert.equal(differing.candidateSource.taxableCents,22000);
  assert.equal((await api('POST',`/api/gst/purchase-evidence/${matching.invoiceId}/eligibility`,{decision:'eligible',reason:'Fixture reviewed'},1,2)).status,409);
  assert.equal((await api('POST',`/api/gst/purchase-evidence/${matching.invoiceId}/match`,{},1,1)).status,403);
  const matched = await api('POST',`/api/gst/purchase-evidence/${matching.invoiceId}/match`,{},1,2);
  assert.equal(matched.data.evidence.matchStatus,'matched');
  assert.equal(matched.data.evidence.source.sourceName,'Synthetic imported 2B fixture');
  const repeat = await api('POST',`/api/gst/purchase-evidence/${matching.invoiceId}/match`,{},1,2);
  assert.equal(repeat.data.evidence.events.length,1);
  const eligible = await api('POST',`/api/gst/purchase-evidence/${matching.invoiceId}/eligibility`,{decision:'eligible',reason:'Invoice and demo source agree'},1,2);
  assert.equal(eligible.data.evidence.eligibilityStatus,'eligible');
  assert.equal((await api('POST',`/api/gst/purchase-evidence/${matching.invoiceId}/eligibility`,{decision:'eligible',reason:'Invoice and demo source agree'},1,2)).data.evidence.events.length,2);
  const mismatch = await api('POST',`/api/gst/purchase-evidence/${differing.invoiceId}/match`,{},1,2);
  assert.equal(mismatch.data.evidence.matchStatus,'mismatch');
  assert.equal((await api('POST',`/api/gst/purchase-evidence/${differing.invoiceId}/eligibility`,{decision:'eligible',reason:'Wrong amount'},1,2)).status,409);
  assert.equal((await api('POST',`/api/gst/purchase-evidence/${differing.invoiceId}/eligibility`,{decision:'blocked',reason:'Amount differs from imported fixture'},1,2)).data.evidence.eligibilityStatus,'blocked');
  const periods = await api('GET','/api/gst/periods');
  const period = periods.data.periods.find(x=>x.gstinId===1);
  assert.equal(period.purchaseTaxCents,6000);
  assert.equal(period.eligibleItcCents,3600);
  assert.equal(period.salesTaxCents,2400);
  assert.equal(period.localEstimateCents,-1200);
  assert.equal((await api('POST',`/api/gst/periods/${period.id}/review`,{notes:'Local evidence review'},1,2)).data.period.status,'reviewed');
  assert.equal((await api('POST',`/api/gst/purchase-evidence/${matching.invoiceId}/eligibility`,{decision:'blocked',reason:'Late change'},1,2)).status,409);
});

test('a later open statement period can review a purchase from a closed invoice period', async t => {
  const api = await fixture(t);
  const created = await api('POST','/api/invoices',{type:'purchase',partyId:2,branchId:1,gstinId:1,
    supplierInvoiceNumber:'LATE-STMT-501',invoiceDate:'2026-01-15',lines:[{itemId:2,quantity:1,unitPriceCents:10000,gstRateBps:1800}]});
  assert.equal(created.status,200);
  const id = created.data.invoice.id;
  await api('POST',`/api/invoices/${id}/submit`,{});
  assert.equal((await api('POST',`/api/invoices/${id}/approve`,{},1,2)).status,200);
  api.db.prepare("UPDATE gst_periods SET status='approved' WHERE company_id=1 AND gstin_id=1 AND period='2026-01'").run();
  const input = { gstinId:1,period:'2026-02',sourceName:'Local later statement',
    csv:'supplier_gstin,invoice_number,invoice_date,taxable_amount,tax_amount\n27DEMOS0000A1Z2,LATE-STMT-501,2026-01-15,100.00,18.00\n' };
  const preview = await api('POST','/api/gst/statement-imports/preview',input,1,2);
  assert.equal(preview.data.preview.canCommit,true);
  assert.equal((await api('POST','/api/gst/statement-imports/commit',{...input,expectedSha256:preview.data.preview.sha256},1,2)).status,200);
  assert.equal((await api('GET','/api/gst/purchase-evidence?gstinId=1&period=2026-02')).data.evidence.some(row => row.invoiceId === id),true);
  const february = (await api('GET','/api/gst/periods')).data.periods.find(period => period.gstinId===1 && period.period==='2026-02');
  assert.equal((await api('POST',`/api/gst/periods/${february.id}/review`,{notes:'Late source review'},1,2)).status,409);
  const match = await api('POST',`/api/gst/purchase-evidence/${id}/match`,{},1,2);
  assert.equal(match.status,200);
  assert.equal(match.data.evidence.matchStatus,'matched');
  assert.equal(match.data.evidence.source.sourcePeriod,'2026-02');
  const decision = await api('POST',`/api/gst/purchase-evidence/${id}/eligibility`,{decision:'eligible',reason:'Reviewed later local statement'},1,2);
  assert.equal(decision.status,200);
  assert.equal(decision.data.evidence.claimPeriod,'2026-02');
  assert.equal(api.db.prepare("SELECT status FROM gst_periods WHERE company_id=1 AND gstin_id=1 AND period='2026-01'").get().status,'approved');
  assert.equal((await api('GET','/api/gst/periods')).data.periods.find(period => period.gstinId===1 && period.period==='2026-02').eligibleItcCents,1800);
  assert.equal((await api('POST',`/api/gst/periods/${february.id}/review`,{notes:'Late source reviewed'},1,2)).status,200);
});

test('pending purchase blocks period review and company scope blocks evidence access', async t => {
  const api = await fixture(t);
  const periods = await api('GET','/api/gst/periods');
  const period = periods.data.periods.find(x=>x.gstinId===1);
  assert.equal((await api('POST',`/api/gst/periods/${period.id}/review`,{},1,2)).status,409);
  const invoiceId = (await api('GET','/api/gst/purchase-evidence')).data.evidence[0].invoiceId;
  assert.equal((await api('GET','/api/gst/purchase-evidence',undefined,2,4)).data.evidence.length,0);
  assert.equal((await api('POST',`/api/gst/purchase-evidence/${invoiceId}/match`,{},2,5)).status,404);
  assert.equal((await api('GET','/api/gst/purchase-evidence?gstinId=1',undefined,2,4)).status,404);
});

test('duplicate supplier reference is rejected and matched supplier identity is immutable', async t => {
  const api = await fixture(t);
  const original = (await api('GET','/api/gst/purchase-evidence')).data.evidence.find(x=>x.supplierInvoiceNumber==='NS-501');
  assert.equal((await api('POST',`/api/gst/purchase-evidence/${original.invoiceId}/match`,{},1,2)).data.evidence.matchStatus,'matched');
  await api('PUT','/api/parties/2',{gstin:'27CHANGED0000A1Z1',name:'Renamed Supplier'});
  const afterEdit = (await api('GET','/api/gst/purchase-evidence')).data.evidence.find(x=>x.invoiceId===original.invoiceId);
  assert.equal(afterEdit.supplierGstin,'27DEMOS0000A1Z2');
  assert.equal(afterEdit.partyName,'Northstar Pharma');
  assert.equal((await api('POST',`/api/gst/purchase-evidence/${original.invoiceId}/match`,{},1,2)).data.evidence.matchStatus,'matched');
  const input = { type:'purchase',partyId:2,branchId:1,gstinId:1,supplierInvoiceNumber:'NS-501',invoiceDate:new Date().toISOString().slice(0,10),lines:[{itemId:1,quantity:1,unitPriceCents:10000}] };
  const draft = await api('POST','/api/invoices',input);
  await api('POST',`/api/invoices/${draft.data.invoice.id}/submit`,{});
  assert.equal((await api('POST',`/api/invoices/${draft.data.invoice.id}/approve`,{},1,2)).status,409);
});

test('duplicate supplier bill across party masters is blocked before stock or AP posting', async t => {
  const api = await fixture(t);
  const alternate = await api('POST','/api/parties',{name:'Northstar Alternate',type:'supplier',gstin:'27demos0000a1z2'});
  assert.equal(alternate.status,200);
  const input = { type:'purchase',partyId:alternate.data.party.id,branchId:1,gstinId:1,
    supplierInvoiceNumber:' ns-501 ',invoiceDate:new Date().toISOString().slice(0,10),
    lines:[{itemId:1,quantity:2,unitPriceCents:10000}] };
  const draft = await api('POST','/api/invoices',input);
  assert.equal(draft.status,200);
  const id = draft.data.invoice.id;
  assert.equal((await api('POST',`/api/invoices/${id}/submit`,{})).status,200);
  const stockBefore = (await api('GET','/api/stock?branchId=1')).data.stock.find(row => row.itemId===1).quantity;
  const apBefore = (await api('GET','/api/finance/open?type=purchase')).data.invoices.length;
  const approved = await api('POST',`/api/invoices/${id}/approve`,{},1,2);
  assert.equal(approved.status,409);
  assert.match(approved.data.error,/Duplicate approved supplier invoice reference/);
  assert.equal((await api('GET',`/api/invoices/${id}`)).data.invoice.status,'submitted');
  assert.equal((await api('GET','/api/stock?branchId=1')).data.stock.find(row => row.itemId===1).quantity,stockBefore);
  assert.equal((await api('GET','/api/finance/open?type=purchase')).data.invoices.length,apBefore);
});

test('invoice counterparty name is captured when the draft is created', async t => {
  const api = await fixture(t);
  const input = { type:'sale',partyId:1,branchId:1,gstinId:1,invoiceDate:new Date().toISOString().slice(0,10),lines:[{itemId:1,quantity:1,unitPriceCents:100}] };
  const created = await api('POST','/api/invoices',input);
  assert.equal(created.data.invoice.partyName,'Harbor Clinic');
  await api('PUT','/api/parties/1',{name:'Renamed Clinic'});
  const persisted = await api('GET',`/api/invoices/${created.data.invoice.id}`);
  assert.equal(persisted.data.invoice.partyName,'Harbor Clinic');
  assert.equal((await api('GET','/api/invoices')).data.invoices.find(x=>x.id===created.data.invoice.id).partyName,'Harbor Clinic');
});

test('service invoice approval posts no stock movement and submitted invoice blocks period review', async t => {
  const api = await fixture(t);
  const today = new Date().toISOString().slice(0,10);
  const service = { type:'sale',partyId:4,branchId:4,gstinId:3,invoiceDate:today,lines:[{itemId:4,quantity:1,unitPriceCents:50000}] };
  const created = await api('POST','/api/invoices',service,2,4);
  assert.equal(created.status,200);
  await api('POST',`/api/invoices/${created.data.invoice.id}/submit`,{},2,4);
  const period = (await api('GET','/api/gst/periods',undefined,2,4)).data.periods.find(x=>x.gstinId===3);
  assert.equal((await api('POST',`/api/gst/periods/${period.id}/review`,{},2,5)).status,409);
  assert.equal((await api('POST',`/api/invoices/${created.data.invoice.id}/approve`,{},2,5)).status,200);
  assert.equal(api.db.prepare('SELECT COUNT(*) AS n FROM stock_movements WHERE invoice_id=?').get(created.data.invoice.id).n,0);
});

test('eligible credit follows fixture appearance period and manual stock reference is idempotent', async t => {
  const api = await fixture(t);
  const originalMonth = new Date().toISOString().slice(0,7);
  const nextMonth = new Date(`${originalMonth}-01T00:00:00Z`);
  nextMonth.setUTCMonth(nextMonth.getUTCMonth()+1);
  const claimMonth = nextMonth.toISOString().slice(0,7);
  api.db.prepare("UPDATE purchase_fixtures SET source_period=? WHERE invoice_number='NS-501'").run(claimMonth);
  const invoiceId = (await api('GET','/api/gst/purchase-evidence')).data.evidence.find(x=>x.supplierInvoiceNumber==='NS-501').invoiceId;
  await api('POST',`/api/gst/purchase-evidence/${invoiceId}/match`,{},1,2);
  const eligible = await api('POST',`/api/gst/purchase-evidence/${invoiceId}/eligibility`,{decision:'eligible',reason:'Later source appearance'},1,2);
  assert.equal(eligible.data.evidence.claimPeriod,claimMonth);
  const periods = (await api('GET','/api/gst/periods')).data.periods.filter(x=>x.gstinId===1);
  assert.equal(periods.find(x=>x.period===originalMonth).eligibleItcCents,0);
  assert.equal(periods.find(x=>x.period===claimMonth).eligibleItcCents,3600);
  assert.equal((await api('GET',`/api/gst/purchase-evidence?period=${claimMonth}`)).data.evidence.some(x=>x.invoiceId===invoiceId),true);
  const movement = { itemId:1,branchId:1,type:'receipt',quantity:2,reason:'Count correction',clientReference:'demo-count-1' };
  const first = await api('POST','/api/stock/movements',movement);
  const replay = await api('POST','/api/stock/movements',movement);
  assert.equal(replay.data.replayed,true);
  assert.equal(first.data.movement.id,replay.data.movement.id);
  assert.equal((await api('POST','/api/stock/movements',{...movement,quantity:3})).status,409);
});

test('closed claim period keeps prior eligible credit immutable', async t => {
  const api = await fixture(t);
  const billMonth = new Date().toISOString().slice(0,7);
  const next = new Date(`${billMonth}-01T00:00:00Z`);
  next.setUTCMonth(next.getUTCMonth()+1);
  const claimMonth = next.toISOString().slice(0,7);
  api.db.prepare("UPDATE purchase_fixtures SET source_period=? WHERE invoice_number='NS-501'").run(claimMonth);
  const invoiceId = (await api('GET','/api/gst/purchase-evidence')).data.evidence.find(row => row.supplierInvoiceNumber === 'NS-501').invoiceId;
  assert.equal((await api('POST',`/api/gst/purchase-evidence/${invoiceId}/match`,{},1,2)).status,200);
  assert.equal((await api('POST',`/api/gst/purchase-evidence/${invoiceId}/eligibility`,{decision:'eligible',reason:'Matched later statement'},1,2)).status,200);
  const period = (await api('GET','/api/gst/periods')).data.periods.find(row => row.gstinId === 1 && row.period === claimMonth);
  assert.equal(period.eligibleItcCents,3600);
  assert.equal((await api('POST',`/api/gst/periods/${period.id}/review`,{notes:'Local review'},1,2)).status,200);
  assert.equal((await api('POST',`/api/gst/periods/${period.id}/approve`,{},1,3)).status,200);
  assert.equal((await api('POST',`/api/gst/purchase-evidence/${invoiceId}/eligibility`,{decision:'blocked',reason:'Later reassessment'},1,2)).status,409);
  assert.equal((await api('POST',`/api/gst/purchase-evidence/${invoiceId}/eligibility`,{decision:'eligible',reason:'Changed rationale'},1,2)).status,409);
  api.db.prepare("UPDATE purchase_fixtures SET taxable_cents=taxable_cents+1 WHERE invoice_number='NS-501'").run();
  assert.equal((await api('POST',`/api/gst/purchase-evidence/${invoiceId}/match`,{},1,2)).status,409);
  const after = (await api('GET','/api/gst/periods')).data.periods.find(row => row.id === period.id);
  assert.equal(after.eligibleItcCents,3600);
  assert.equal((await api('GET','/api/gst/purchase-evidence')).data.evidence.find(row => row.invoiceId === invoiceId).eligibilityStatus,'eligible');
});

test('stock tracking is fixed after item history and unique conflicts return 409', async t => {
  const api = await fixture(t);
  const used = await api('PUT','/api/items/1',{trackStock:false});
  assert.equal(used.status,409);
  assert.equal(api.db.prepare('SELECT track_stock FROM items WHERE id=1').get().track_stock,1);
  const service = await api('PUT','/api/items/4',{trackStock:true},2,4);
  assert.equal(service.status,200);
  const created = await api('POST','/api/items',{sku:'NEW-UNUSED',name:'New unused item',trackStock:false});
  assert.equal(created.status,200);
  assert.equal((await api('PUT',`/api/items/${created.data.item.id}`,{trackStock:true})).status,200);
  const duplicate = await api('POST','/api/items',{sku:'NEW-UNUSED',name:'Duplicate'});
  assert.equal(duplicate.status,409);
});

test('sale invoice and manual issue allocate dated batch stock once', async t => {
  const api = await fixture(t);
  const received = await api('POST','/api/batches/receive',{itemId:1,branchId:1,gstinId:1,batchCode:'LOT-INVOICE-TEST',expiresOn:'2028-12-31',quantity:3,reason:'Test receipt',clientReference:'invoice-lot'});
  assert.equal(received.status,200);
  const batchId = received.data.batch.id;
  const input = {type:'sale',partyId:1,branchId:1,gstinId:1,invoiceDate:new Date().toISOString().slice(0,10),lines:[{itemId:1,quantity:2,unitPriceCents:1000}]};
  const created = await api('POST','/api/invoices',input);
  await api('POST',`/api/invoices/${created.data.invoice.id}/submit`,{});
  assert.equal((await api('POST',`/api/invoices/${created.data.invoice.id}/approve`,{},1,2)).status,200);
  assert.equal(api.db.prepare('SELECT COALESCE(SUM(quantity_delta),0) AS q FROM batch_movements WHERE batch_id=?').get(batchId).q,1);
  const issued = await api('POST','/api/stock/movements',{itemId:1,branchId:1,type:'issue',quantity:1,reason:'Manual test',clientReference:'manual-lot'});
  assert.equal(issued.status,200);
  assert.equal(issued.data.batchAllocation.batchAllocated,1);
  assert.equal((await api('POST','/api/stock/movements',{itemId:1,branchId:1,type:'issue',quantity:1,reason:'Manual test',clientReference:'manual-lot'})).data.replayed,true);
  assert.equal(api.db.prepare('SELECT COALESCE(SUM(quantity_delta),0) AS q FROM batch_movements WHERE batch_id=?').get(batchId).q,0);
});
