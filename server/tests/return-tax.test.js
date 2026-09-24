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
  const api = async (method,path,body,companyId=1,userId=2) => {
    const response = await fetch(base+path,{method,headers:{'content-type':'application/json','x-company-id':String(companyId),'x-user-id':String(userId)},body:body===undefined?undefined:JSON.stringify(body)});
    return {status:response.status,data:await response.json()};
  };
  return {db,api};
}

test('approved sale return gets one local accountant decision and separate arithmetic preview', async t => {
  const {db,api} = await fixture(t);
  const row = db.prepare("SELECT r.id,v.gstin_id FROM returns r JOIN invoices v ON v.id=r.invoice_id WHERE r.status='approved' AND r.kind='sales_return' AND v.company_id=1 ORDER BY r.id LIMIT 1").get();
  assert.ok(row);
  const period = new Date().toISOString().slice(0,7);
  const before = (await api('GET','/api/gst/periods')).data.periods.find(item => item.gstinId === row.gstin_id && item.period === period);
  const body = {decision:'eligible',period,reason:'Internal source-linked arithmetic reviewed'};
  assert.equal((await api('POST',`/api/return-tax/reviews/${row.id}/decision`,body,1,1)).status,403);
  const first = await api('POST',`/api/return-tax/reviews/${row.id}/decision`,body);
  assert.equal(first.status,200);
  assert.equal(first.data.review.reviewDecision,'eligible');
  assert.equal(first.data.review.events.length,1);
  assert.equal((await api('POST',`/api/return-tax/reviews/${row.id}/decision`,body)).data.replayed,true);
  assert.equal((await api('GET',`/api/return-tax/reviews/${row.id}`)).data.review.events.length,1);
  const result = await api('GET',`/api/return-tax/preview?gstinId=${row.gstin_id}&period=${period}`);
  assert.equal(result.status,200);
  assert.equal(result.data.preview.salesCreditTaxCents,first.data.review.taxProposalCents);
  assert.equal(result.data.preview.purchaseDebitTaxCents,0);
  assert.equal(result.data.preview.indicativeNetAdjustmentCents,-first.data.review.taxProposalCents);
  assert.equal(result.data.preview.excludedFromRecordedGstTotals,true);
  const after = (await api('GET','/api/gst/periods')).data.periods.find(item => item.id === before.id);
  assert.equal(after.salesTaxCents,before.salesTaxCents);
  assert.equal(after.eligibleItcCents,before.eligibleItcCents);
  assert.equal(after.status,before.status);
  db.prepare("UPDATE gst_periods SET status='reviewed' WHERE id=?").run(before.id);
  assert.equal((await api('POST',`/api/return-tax/reviews/${row.id}/decision`,body)).data.replayed,true);
  assert.equal((await api('POST',`/api/return-tax/reviews/${row.id}/decision`,{...body,decision:'rejected'})).status,409);
});

test('draft return cannot be reviewed; deferred decisions retain audit and do not enter preview', async t => {
  const {db,api} = await fixture(t);
  const period = new Date().toISOString().slice(0,7);
  const draft = db.prepare("SELECT r.id,v.gstin_id FROM returns r JOIN invoices v ON v.id=r.invoice_id WHERE r.status='draft' AND v.company_id=1 LIMIT 1").get();
  assert.ok(draft);
  assert.equal((await api('POST',`/api/return-tax/reviews/${draft.id}/decision`,{decision:'eligible',period,reason:'Too early'})).status,409);
  const approved = db.prepare("SELECT r.id,v.gstin_id FROM returns r JOIN invoices v ON v.id=r.invoice_id WHERE r.status='approved' AND v.company_id=1 LIMIT 1").get();
  const deferred = await api('POST',`/api/return-tax/reviews/${approved.id}/decision`,{decision:'deferred',period,reason:'Awaiting note evidence'});
  assert.equal(deferred.status,200);
  assert.equal(deferred.data.review.reviewDecision,'deferred');
  assert.equal((await api('GET',`/api/return-tax/preview?gstinId=${approved.gstin_id}&period=${period}`)).data.preview.documentCount,0);
  const rejected = await api('POST',`/api/return-tax/reviews/${approved.id}/decision`,{decision:'rejected',period,reason:'Proposal not accepted locally'});
  assert.equal(rejected.status,200);
  assert.deepEqual(rejected.data.review.events.map(event => event.decision),['deferred','rejected']);
  assert.equal((await api('GET',`/api/return-tax/preview?gstinId=${approved.gstin_id}&period=${period}`)).data.preview.documentCount,0);
});

test('purchase debit note preview is separate and closed periods reject acceptance', async t => {
  const {db,api} = await fixture(t);
  const purchase = db.prepare("SELECT id FROM invoices WHERE company_id=1 AND type='purchase' AND status='approved' AND gstin_id=1 LIMIT 1").get();
  const source = (await api('GET',`/api/invoices/${purchase.id}`)).data.invoice;
  const made = await api('POST','/api/returns',{invoiceId:purchase.id,lines:[{invoiceLineId:source.lines[0].id,quantity:1}],reason:'Supplier accepted return'},1,1);
  assert.equal(made.status,200);
  const id = made.data.return.id;
  assert.equal((await api('POST',`/api/returns/${id}/approve`,{})).status,200);
  const period = new Date().toISOString().slice(0,7);
  const closed = db.prepare("SELECT period FROM gst_periods WHERE company_id=1 AND gstin_id=1 AND status='approved' LIMIT 1").get();
  assert.ok(closed);
  assert.equal((await api('POST',`/api/return-tax/reviews/${id}/decision`,{decision:'eligible',period:closed.period,reason:'Late return'})).status,409);
  const reviewed = await api('POST',`/api/return-tax/reviews/${id}/decision`,{decision:'eligible',period,reason:'Local purchase note review'});
  assert.equal(reviewed.status,200);
  const preview = (await api('GET',`/api/return-tax/preview?gstinId=1&period=${period}`)).data.preview;
  assert.equal(preview.purchaseDebitTaxCents,reviewed.data.review.taxProposalCents);
  assert.equal(preview.indicativeNetAdjustmentCents,preview.purchaseDebitTaxCents);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM return_tax_review_events WHERE return_id=?').get(id).n,1);
});

test('company, GSTIN, period and source reconciliation boundaries', async t => {
  const {db,api} = await fixture(t);
  const row = db.prepare("SELECT r.id,v.gstin_id FROM returns r JOIN invoices v ON v.id=r.invoice_id WHERE r.status='approved' AND v.company_id=1 LIMIT 1").get();
  const period = new Date().toISOString().slice(0,7);
  assert.equal((await api('GET',`/api/return-tax/reviews/${row.id}`,undefined,2,5)).status,404);
  assert.equal((await api('GET',`/api/return-tax/preview?gstinId=${row.gstin_id}&period=${period}`,undefined,2,5)).status,404);
  assert.equal((await api('GET','/api/return-tax/reviews?gstinId=999')).status,404);
  assert.equal((await api('GET','/api/return-tax/preview?gstinId=1&period=2026-99')).status,400);
  db.prepare('UPDATE returns SET tax_proposal_cents=tax_proposal_cents+1 WHERE id=?').run(row.id);
  assert.equal((await api('POST',`/api/return-tax/reviews/${row.id}/decision`,{decision:'eligible',period,reason:'Check'})).status,409);
});
