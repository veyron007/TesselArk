import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const express = require('express');
const { openDatabase } = require('../db.cjs');
const { createApp } = require('../api.cjs');
const { allowedScopes } = require('../access.cjs');
const { registerGstInvoiceAssistantRoutes,assessInvoice,assertInvoiceTaxReady,seedGstInvoiceCheckDemo } = require('../gst-invoice-assistant.cjs');

async function fixture(t) {
  const db = openDatabase(':memory:');
  const app = express();
  app.use(express.json());
  app.use('/api',(req,_res,next) => {
    try {
      const companyId = Number(req.header('x-company-id') || 1);
      const userId = Number(req.header('x-user-id') || 1);
      req.company = db.prepare('SELECT * FROM companies WHERE id=?').get(companyId);
      req.user = db.prepare('SELECT * FROM users WHERE id=? AND company_id=?').get(userId,companyId);
      if (!req.company || !req.user) throw Object.assign(new Error('Unknown company or user'),{status:403});
      req.scopes = allowedScopes(db,{companyId,userId});
      next();
    } catch (error) { next(error); }
  });
  registerGstInvoiceAssistantRoutes(app,db);
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

function submittedInvoice(db,{itemId=1,rateBps=1200,hsn='3822'}={}) {
  const today = new Date().toISOString().slice(0,10);
  const subtotal = 10000;
  const tax = Math.round(subtotal*rateBps/10000);
  const result = db.prepare(`INSERT INTO invoices(company_id,branch_id,gstin_id,party_id,number,supplier_gstin_snapshot,party_name_snapshot,type,status,invoice_date,subtotal_cents,tax_cents,total_cents,created_by,submitted_by)
    VALUES (1,1,1,1,?,'27DEMOH0000A1Z4','Harbor Clinic','sale','submitted',?,?,?,?,1,1)`)
    .run(`GST-CHECK-${Math.random().toString(36).slice(2,10)}`,today,subtotal,tax,subtotal+tax);
  const invoiceId = Number(result.lastInsertRowid);
  db.prepare(`INSERT INTO invoice_lines(invoice_id,item_id,quantity,unit_price_cents,gst_rate_bps,subtotal_cents,tax_cents,total_cents,item_hsn_snapshot)
    VALUES (?,?,1,10000,?,?,?,?,?)`).run(invoiceId,itemId,rateBps,subtotal,tax,subtotal+tax,hsn);
  return invoiceId;
}

const proposal = ({itemId=1,rateBps=1200,effectiveFrom='2020-01-01',effectiveTo=null,hsn='3822'}={}) => ({
  itemId,hsn,rateBps,effectiveFrom,effectiveTo,sourceReference:'Internal demonstration tax assumption',reason:'Review the illustrative item treatment before use',
});

test('reviewed dated policy is independent, immutable, and cannot overlap another approved policy',async t => {
  const {api,db} = await fixture(t);
  const made = await api('POST','/api/gst-invoice-checks/policies',proposal());
  assert.equal(made.status,200);
  const id = made.data.policy.id;
  assert.equal(made.data.policy.status,'pending');
  assert.equal((await api('POST',`/api/gst-invoice-checks/policies/${id}/review`,{decision:'approved',reason:'Independent check'},1,1)).status,403);
  assert.equal((await api('POST',`/api/gst-invoice-checks/policies/${id}/review`,{decision:'approved',reason:'Independent check'},1,2)).status,200);
  assert.equal((await api('POST',`/api/gst-invoice-checks/policies/${id}/review`,{decision:'rejected',reason:'Changed mind'},1,2)).status,409);
  const competing = await api('POST','/api/gst-invoice-checks/policies',proposal({rateBps:1800,effectiveFrom:'2025-01-01'}));
  assert.equal(competing.status,200);
  assert.equal((await api('POST',`/api/gst-invoice-checks/policies/${competing.data.policy.id}/review`,{decision:'approved',reason:'Overlap'},1,2)).status,409);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM gst_item_tax_policy_events WHERE policy_id=?').get(id).count,2);
  assert.equal((await api('GET','/api/gst-invoice-checks/policies')).data.policies.some(row=>row.id===id && row.status==='approved'),true);
});

test('invoice assessment blocks reviewed policy mismatch and expires an override when invoice changes',async t => {
  const {api,db} = await fixture(t);
  const policy = await api('POST','/api/gst-invoice-checks/policies',proposal());
  await api('POST',`/api/gst-invoice-checks/policies/${policy.data.policy.id}/review`,{decision:'approved',reason:'Reviewed for demo'},1,2);
  const id = submittedInvoice(db,{rateBps:1800});
  const first = await api('GET',`/api/gst-invoice-checks/invoices/${id}`);
  assert.equal(first.status,200);
  assert.equal(first.data.assessment.blockers,1);
  assert.equal(first.data.assessment.findings.some(row=>row.code==='RATE_POLICY_MISMATCH'),true);
  assert.equal(first.data.assessment.lines[0].policy.rateBps,1200);
  assert.throws(() => assertInvoiceTaxReady(db,{companyId:1,invoiceId:id}),error=>error.status===409);
  assert.equal((await api('POST',`/api/gst-invoice-checks/invoices/${id}/reviews`,{decision:'accepted',reason:'Reviewed source exception'},1,1)).status,403);
  const reviewed = await api('POST',`/api/gst-invoice-checks/invoices/${id}/reviews`,{decision:'accepted',reason:'Illustrative exception approved after source document check'},1,2);
  assert.equal(reviewed.status,200);
  assert.equal(reviewed.data.assessment.approvalReady,true);
  assert.equal(reviewed.data.assessment.reviews[0].reviewerName,'Dev Accountant');
  assert.equal(reviewed.data.assessment.acceptedOverride.reason,'Illustrative exception approved after source document check');
  assert.equal(assertInvoiceTaxReady(db,{companyId:1,invoiceId:id}).acceptedOverride.reason,'Illustrative exception approved after source document check');
  db.prepare('UPDATE invoice_lines SET gst_rate_bps=1700,tax_cents=1700,total_cents=11700 WHERE invoice_id=?').run(id);
  db.prepare('UPDATE invoices SET tax_cents=1700,total_cents=11700 WHERE id=?').run(id);
  const changed = assessInvoice(db,{companyId:1,invoiceId:id});
  assert.equal(changed.approvalReady,false);
  assert.equal(changed.acceptedOverride,null);
  assert.notEqual(changed.fingerprint,first.data.assessment.fingerprint);
});

test('missing policy is advisory; arithmetic corruption cannot be overridden',async t => {
  const {api,db} = await fixture(t);
  const id = submittedInvoice(db);
  const original = assessInvoice(db,{companyId:1,invoiceId:id});
  assert.equal(original.blockers,0);
  assert.equal(original.approvalReady,true);
  assert.equal(original.findings.some(row=>row.code==='NO_REVIEWED_POLICY'),true);
  db.prepare('UPDATE invoice_lines SET tax_cents=tax_cents+1 WHERE invoice_id=?').run(id);
  const broken = assessInvoice(db,{companyId:1,invoiceId:id});
  assert.equal(broken.nonOverridable,true);
  assert.equal((await api('POST',`/api/gst-invoice-checks/invoices/${id}/reviews`,{decision:'accepted',reason:'Attempt to bypass arithmetic'},1,2)).status,409);
});

test('historical invoice HSN snapshot remains the review basis after item master changes',async t => {
  const {api,db} = await fixture(t);
  const policy = await api('POST','/api/gst-invoice-checks/policies',proposal());
  await api('POST',`/api/gst-invoice-checks/policies/${policy.data.policy.id}/review`,{decision:'approved',reason:'Reviewed snapshot basis'},1,2);
  const id = submittedInvoice(db,{hsn:'3822'});
  const before = assessInvoice(db,{companyId:1,invoiceId:id});
  assert.equal(before.blockers,0);
  db.prepare("UPDATE items SET hsn='9999' WHERE id=1").run();
  const after = assessInvoice(db,{companyId:1,invoiceId:id});
  assert.equal(after.blockers,0);
  assert.equal(after.fingerprint,before.fingerprint);
  db.prepare("UPDATE invoice_lines SET item_hsn_snapshot='' WHERE invoice_id=?").run(id);
  const missing = assessInvoice(db,{companyId:1,invoiceId:id});
  assert.equal(missing.findings.some(row=>row.code==='HSN_POLICY_MISMATCH'),true);
});

test('company and revoked branch scope protect invoice checks; policy item is company scoped',async t => {
  const {api,db} = await fixture(t);
  const id = submittedInvoice(db);
  assert.equal((await api('GET',`/api/gst-invoice-checks/invoices/${id}`,undefined,2,4)).status,404);
  assert.equal((await api('POST','/api/gst-invoice-checks/policies',proposal({itemId:4}),1,1)).status,404);
  db.prepare("UPDATE user_branch_grants SET revoked_by=3,revoked_at=CURRENT_TIMESTAMP,revoked_reason='Scope test' WHERE company_id=1 AND user_id=1 AND branch_id=1 AND revoked_at IS NULL").run();
  assert.equal((await api('GET',`/api/gst-invoice-checks/invoices/${id}`)).status,403);
  db.prepare("UPDATE user_branch_grants SET revoked_by=3,revoked_at=CURRENT_TIMESTAMP,revoked_reason='Scope test' WHERE company_id=1 AND user_id=1 AND revoked_at IS NULL").run();
  assert.equal((await api('GET','/api/gst-invoice-checks/policies')).status,403);
});

test('invalid policy dates and rates fail at the boundary',async t => {
  const {api} = await fixture(t);
  assert.equal((await api('POST','/api/gst-invoice-checks/policies',proposal({effectiveFrom:'2026-02-30'}))).status,400);
  assert.equal((await api('POST','/api/gst-invoice-checks/policies',proposal({effectiveFrom:'2026-10-01',effectiveTo:'2026-09-01'}))).status,400);
  assert.equal((await api('POST','/api/gst-invoice-checks/policies',proposal({rateBps:10001}))).status,400);
});

test('synthetic consumer health policy specimen stays pending and replay safe',async t => {
  const {db,api} = await fixture(t);
  db.prepare("INSERT INTO items(company_id,sku,name,hsn,gst_rate_bps) VALUES (1,'CHD-01-01','Synthetic oral care demo','',1200)").run();
  const first = seedGstInvoiceCheckDemo(db);
  const second = seedGstInvoiceCheckDemo(db);
  assert.equal(first.policyId,second.policyId);
  const row = (await api('GET','/api/gst-invoice-checks/policies')).data.policies.find(policy=>policy.id===first.policyId);
  assert.equal(row.status,'pending');
  assert.match(row.sourceReference,/Internal demo assumption/);
  assert.equal(row.reviewedBy,null);
});

test('invoice approval route enforces reviewed policy findings and accepts independent decision',async t => {
  const db = openDatabase(':memory:');
  const server = createApp({db}).listen(0);
  t.after(() => { server.close(); db.close(); });
  const api = async (method,path,body,userId=1) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`,{
      method,headers:{'content-type':'application/json','x-company-id':'1','x-user-id':String(userId)},
      body:body === undefined ? undefined : JSON.stringify(body),
    });
    return {status:response.status,data:await response.json()};
  };
  const made = await api('POST','/api/gst-invoice-checks/policies',proposal());
  assert.equal(made.status,200);
  assert.equal((await api('POST',`/api/gst-invoice-checks/policies/${made.data.policy.id}/review`,{decision:'approved',reason:'Independent illustrative check'},2)).status,200);
  const created = await api('POST','/api/invoices',{
    type:'sale',partyId:1,branchId:1,gstinId:1,invoiceDate:new Date().toISOString().slice(0,10),
    lines:[{itemId:1,quantity:1,unitPriceCents:10000,gstRateBps:1800}],
  });
  assert.equal(created.status,200);
  const id = created.data.invoice.id;
  assert.equal((await api('POST',`/api/invoices/${id}/submit`,{})).status,200);
  assert.equal((await api('POST',`/api/invoices/${id}/approve`,{},2)).status,409);
  const review = await api('POST',`/api/gst-invoice-checks/invoices/${id}/reviews`,{
    decision:'accepted',reason:'Reviewed and accepted this illustrative exception against the source document',
  },2);
  assert.equal(review.status,200);
  const approved = await api('POST',`/api/invoices/${id}/approve`,{},2);
  assert.equal(approved.status,200);
  assert.equal(approved.data.invoice.status,'approved');
});
