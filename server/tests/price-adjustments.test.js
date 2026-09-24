import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const express = require('express');
const { openDatabase } = require('../db.cjs');
const { allowedScopes } = require('../access.cjs');
const { registerPriceAdjustmentRoutes } = require('../price-adjustments.cjs');
const { seedPriceAdjustmentDemo } = require('../price-adjustment-db.cjs');

async function fixture(t) {
  const db = openDatabase(':memory:');
  const app = express();
  app.use(express.json());
  app.use('/api',(req,_res,next) => {
    const companyId = Number(req.header('x-company-id') || 1);
    const userId = Number(req.header('x-user-id') || 1);
    req.company = db.prepare('SELECT * FROM companies WHERE id=?').get(companyId);
    req.user = db.prepare('SELECT * FROM users WHERE id=? AND company_id=?').get(userId,companyId);
    if (!req.company || !req.user) return next(Object.assign(new Error('Unknown company or user'),{status:403}));
    req.scopes = allowedScopes(db,{companyId,userId});
    next();
  });
  registerPriceAdjustmentRoutes(app,db);
  app.use((error,_req,res,_next) => res.status(error.status || 500).json({error:error.message}));
  const server = app.listen(0);
  t.after(() => { server.close(); db.close(); });
  const api = async (method,path,body,companyId=1,userId=1) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`,{
      method,headers:{'content-type':'application/json','x-company-id':String(companyId),'x-user-id':String(userId)},
      body:body === undefined ? undefined : JSON.stringify(body),
    });
    return {status:response.status,data:await response.json()};
  };
  return {db,api};
}

const proposal = (invoiceLineId,quantity,newUnitPriceCents,clientReference='PRICE-001') => ({
  clientReference,reason:'Documented supplier or customer rate correction',lines:[{invoiceLineId,quantity,newUnitPriceCents}],
});
const totals = db => ({
  invoice:db.prepare('SELECT subtotal_cents,tax_cents,total_cents FROM invoices WHERE id=1').get(),
  line:db.prepare('SELECT unit_price_cents,subtotal_cents,tax_cents FROM invoice_lines WHERE id=1').get(),
  journal:db.prepare('SELECT COUNT(*) AS count FROM journals').get().count,
  gst:db.prepare('SELECT status FROM gst_periods WHERE company_id=1 AND gstin_id=1 AND period=?').get(new Date().toISOString().slice(0,7)),
});

test('source quantity is conserved across pending and approved proposals; rejected quantity is released',async t => {
  const {api} = await fixture(t);
  const sources = await api('GET','/api/price-adjustments/sources?branchId=1');
  assert.equal(sources.status,200);
  const source = sources.data.sources.find(row => row.invoiceLineId === 1);
  assert.equal(source.availableQuantity,2);
  const first = await api('POST','/api/price-adjustments',proposal(1,1,10005));
  assert.equal(first.status,200);
  assert.equal(first.data.adjustment.lines[0].oldUnitPriceCents,10000);
  assert.equal(first.data.adjustment.lines[0].subtotalDeltaCents,5);
  assert.equal(first.data.adjustment.lines[0].taxProposalCents,1);
  assert.equal((await api('POST','/api/price-adjustments',proposal(1,2,10020,'PRICE-OVER'))).status,409);
  const second = await api('POST','/api/price-adjustments',proposal(1,1,9995,'PRICE-SECOND'));
  assert.equal(second.status,200);
  assert.equal((await api('POST','/api/price-adjustments',proposal(1,1,9990,'PRICE-THIRD'))).status,409);
  const rejected = await api('POST',`/api/price-adjustments/${second.data.adjustment.id}/review`,{decision:'rejected',reason:'Incorrect commercial evidence'},1,2);
  assert.equal(rejected.status,200);
  assert.equal((await api('GET','/api/price-adjustments/sources?branchId=1')).data.sources.find(row=>row.invoiceLineId===1).availableQuantity,1);
  assert.equal((await api('POST','/api/price-adjustments',proposal(1,1,9990,'PRICE-THIRD'))).status,200);
});

test('duplicate line and reference replay are safe; independent commercial and tax reviews leave books untouched',async t => {
  const {db,api} = await fixture(t);
  const before = totals(db);
  const input = proposal(1,2,10005);
  const duplicate = {...input,lines:[input.lines[0],input.lines[0]]};
  assert.equal((await api('POST','/api/price-adjustments',duplicate)).status,409);
  const made = await api('POST','/api/price-adjustments',input);
  assert.equal(made.status,200);
  const id = made.data.adjustment.id;
  assert.equal((await api('POST','/api/price-adjustments',input)).data.replayed,true);
  assert.equal((await api('POST','/api/price-adjustments',proposal(1,2,10010))).status,409);
  assert.equal((await api('POST',`/api/price-adjustments/${id}/review`,{decision:'approved',reason:'Checked original rate'},1,1)).status,403);
  const commercial = await api('POST',`/api/price-adjustments/${id}/review`,{decision:'approved',reason:'Checked original rate'},1,2);
  assert.equal(commercial.status,200);
  assert.equal((await api('POST',`/api/price-adjustments/${id}/review`,{decision:'approved',reason:'Checked original rate'},1,2)).data.replayed,true);
  const currentPeriod = new Date().toISOString().slice(0,7);
  assert.equal((await api('POST',`/api/price-adjustments/${id}/tax-review`,{decision:'accepted',period:currentPeriod,reason:'Tax consequence reviewed'},1,1)).status,403);
  const tax = await api('POST',`/api/price-adjustments/${id}/tax-review`,{decision:'accepted',period:currentPeriod,reason:'Tax consequence reviewed'},1,2);
  assert.equal(tax.status,200);
  assert.equal(tax.data.adjustment.taxReview.decision,'accepted');
  assert.equal(tax.data.adjustment.taxEvents.length,1);
  assert.equal((await api('POST',`/api/price-adjustments/${id}/tax-review`,{decision:'accepted',period:currentPeriod,reason:'Tax consequence reviewed'},1,2)).data.replayed,true);
  assert.equal((await api('POST',`/api/price-adjustments/${id}/tax-review`,{decision:'rejected',period:currentPeriod,reason:'Change'},1,2)).status,409);
  assert.deepEqual(totals(db),before);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM price_adjustment_events WHERE adjustment_id=?').get(id).count,2);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM price_adjustment_tax_events WHERE adjustment_id=?').get(id).count,1);
});

test('company, GSTIN, branch, approved source and tax period boundaries',async t => {
  const {db,api} = await fixture(t);
  const other = db.prepare("SELECT l.id FROM invoice_lines l JOIN invoices v ON v.id=l.invoice_id WHERE v.company_id=2 AND v.status='approved' LIMIT 1").get();
  assert.ok(other);
  assert.equal((await api('POST','/api/price-adjustments',proposal(other.id,1,10005))).status,404);
  assert.equal((await api('POST','/api/price-adjustments',{
    clientReference:'PRICE-MIX',reason:'Mix',lines:[{invoiceLineId:1,quantity:1,newUnitPriceCents:10005},{invoiceLineId:4,quantity:1,newUnitPriceCents:5005}],
  })).status,409);
  const draft = db.prepare("SELECT l.id FROM invoice_lines l JOIN invoices v ON v.id=l.invoice_id WHERE v.company_id=1 AND v.status='draft' LIMIT 1").get();
  if (draft) assert.equal((await api('POST','/api/price-adjustments',proposal(draft.id,1,10005,'PRICE-DRAFT'))).status,409);
  const made = await api('POST','/api/price-adjustments',proposal(1,1,10005));
  const id = made.data.adjustment.id;
  assert.equal((await api('GET',`/api/price-adjustments/${id}`,undefined,2,5)).status,404);
  assert.equal((await api('POST',`/api/price-adjustments/${id}/tax-review`,{decision:'accepted',period:new Date().toISOString().slice(0,7),reason:'Too early'},1,2)).status,409);
  assert.equal((await api('POST',`/api/price-adjustments/${id}/review`,{decision:'approved',reason:'Source checked'},1,2)).status,200);
  const closed = db.prepare("SELECT period FROM gst_periods WHERE company_id=1 AND gstin_id=1 AND status='approved' LIMIT 1").get();
  assert.equal((await api('POST',`/api/price-adjustments/${id}/tax-review`,{decision:'accepted',period:closed.period,reason:'Closed'},1,2)).status,409);
});

test('paise arithmetic handles negative differences and snapshots are checked again at review',async t => {
  const {db,api} = await fixture(t);
  const made = await api('POST','/api/price-adjustments',proposal(1,1,9995));
  assert.equal(made.status,200);
  assert.equal(made.data.adjustment.subtotalDeltaCents,-5);
  assert.equal(made.data.adjustment.taxProposalCents,-1);
  db.prepare('UPDATE invoice_lines SET unit_price_cents=unit_price_cents+1 WHERE id=1').run();
  assert.equal((await api('POST',`/api/price-adjustments/${made.data.adjustment.id}/review`,{decision:'approved',reason:'Check'},1,2)).status,409);
});

test('synthetic seed is idempotent, reviewed commercially, and does not alter invoice, GST or ledger',async t => {
  const {db,api} = await fixture(t);
  const before = totals(db);
  const first = seedPriceAdjustmentDemo(db);
  const second = seedPriceAdjustmentDemo(db);
  assert.equal(first.seeded,true);
  assert.equal(second.seeded,false);
  assert.equal(second.adjustmentId,first.adjustmentId);
  const response = await api('GET',`/api/price-adjustments/${first.adjustmentId}`);
  assert.equal(response.status,200);
  const adjustment = response.data.adjustment;
  assert.equal(adjustment.clientReference,'DEMO-PRICE-MUM-001');
  assert.equal(adjustment.status,'approved');
  assert.equal(adjustment.createdBy,1);
  assert.equal(adjustment.reviewedBy,2);
  assert.equal(adjustment.lines[0].invoiceLineId,1);
  assert.equal(adjustment.lines[0].quantity,1);
  assert.equal(adjustment.lines[0].oldUnitPriceCents,10000);
  assert.equal(adjustment.lines[0].newUnitPriceCents,9850);
  assert.equal(adjustment.taxReview,null);
  assert.deepEqual(adjustment.events.map(row=>row.action),['created','approved']);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM price_adjustments WHERE company_id=1 AND client_reference='DEMO-PRICE-MUM-001'").get().count,1);
  assert.deepEqual(totals(db),before);
});
