import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { openDatabase } = require('../db.cjs');
const { registerDeliveryRoutes, seedDeliveryDemo } = require('../delivery.cjs');

async function fixture(t) {
  const db = openDatabase(':memory:');
  const app = express(); app.use(express.json());
  app.use('/api',(req,_res,next) => {
    req.company = db.prepare('SELECT * FROM companies WHERE id=?').get(Number(req.header('x-company-id') || 1));
    req.user = db.prepare('SELECT * FROM users WHERE id=? AND company_id=?').get(Number(req.header('x-user-id') || 1),req.company?.id);
    if (!req.company || !req.user) return next(Object.assign(new Error('Unknown identity'),{status:403}));
    next();
  });
  registerDeliveryRoutes(app,db);
  app.use((error,_req,res,_next) => res.status(error.status || 500).json({error:error.message}));
  const server=app.listen(0);
  t.after(() => { server.close(); db.close(); });
  const api=async(method,path,body,userId=1,companyId=1) => {
    const response=await fetch(`http://127.0.0.1:${server.address().port}${path}`,{
      method,headers:{'content-type':'application/json','x-user-id':String(userId),'x-company-id':String(companyId)},
      body:body===undefined?undefined:JSON.stringify(body)
    });
    return {status:response.status,data:await response.json()};
  };
  const fulfillment=db.prepare("SELECT f.id,fl.order_line_id FROM order_fulfillments f JOIN order_fulfillment_lines fl ON fl.fulfillment_id=f.id WHERE f.number='DEMO-DISP-BLR-301'").get();
  return {db,api,fulfillment};
}

const assign=(fulfillmentId,extra={}) => ({fulfillmentId,assigneeId:1,address:'123 Demo Street, Bengaluru',clientReference:'TEST-DELIVERY-ASSIGN',...extra});
const attempt=(lineId,quantity,extra={}) => ({clientReference:`TEST-ATTEMPT-${quantity}`,outcome:'partial',attemptDate:'2026-09-24',lines:[{orderLineId:lineId,quantity}],proofMethod:'recipient_name',recipientName:'Demo receiver',note:'Staff reported handover',...extra});

test('partial delivery retains dispatch balance, proof metadata and replay safety',async t => {
  const {db,api,fulfillment}=await fixture(t);
  const baseline=db.prepare('SELECT COUNT(*) AS n FROM stock_movements').get().n;
  const created=await api('POST','/api/delivery',assign(fulfillment.id));
  assert.equal(created.status,200);
  const id=created.data.delivery.id;
  assert.equal(created.data.delivery.status,'assigned');
  assert.equal((await api('POST','/api/delivery',assign(fulfillment.id))).data.replayed,true);
  assert.equal((await api('POST','/api/delivery',assign(fulfillment.id,{address:'changed'}))).status,409);
  const first=await api('POST',`/api/delivery/${id}/attempts`,attempt(fulfillment.order_line_id,2));
  assert.equal(first.status,200);
  assert.equal(first.data.delivery.status,'partial');
  assert.equal(first.data.delivery.lines[0].deliveredQuantity,2);
  assert.equal(first.data.delivery.lines[0].remainingQuantity,2);
  assert.equal(first.data.delivery.attempts[0].proofMethod,'recipient_name');
  assert.equal(first.data.delivery.attempts[0].proofSource,'staff_reported');
  assert.equal((await api('POST',`/api/delivery/${id}/attempts`,attempt(fulfillment.order_line_id,2))).data.replayed,true);
  assert.equal((await api('POST',`/api/delivery/${id}/attempts`,attempt(fulfillment.order_line_id,2,{recipientName:'Someone else'}))).status,409);
  assert.equal((await api('POST',`/api/delivery/${id}/attempts`,attempt(fulfillment.order_line_id,3,{clientReference:'OVER'}))).status,409);
  const failed=await api('POST',`/api/delivery/${id}/attempts`,{clientReference:'FAILED',outcome:'failed',attemptDate:'2026-09-25',lines:[],proofMethod:'none',reason:'Customer unavailable',note:'Door was closed'});
  assert.equal(failed.status,200);
  assert.equal(failed.data.delivery.status,'partial');
  assert.equal(failed.data.delivery.lines[0].remainingQuantity,2);
  const final=await api('POST',`/api/delivery/${id}/attempts`,attempt(fulfillment.order_line_id,2,{clientReference:'FINAL',outcome:'delivered',attemptDate:'2026-09-26'}));
  assert.equal(final.data.delivery.status,'delivered');
  assert.equal(final.data.delivery.lines[0].remainingQuantity,0);
  assert.equal((await api('POST',`/api/delivery/${id}/attempts`,attempt(fulfillment.order_line_id,1,{clientReference:'AFTER'}))).status,409);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM stock_movements').get().n,baseline);
});

test('assignment, attempts and collection enforce scope, source and role boundaries',async t => {
  const {db,api,fulfillment}=await fixture(t);
  const beforePayments=db.prepare('SELECT COUNT(*) AS n FROM invoice_payments').get().n;
  const beforeJournals=db.prepare('SELECT COUNT(*) AS n FROM journals').get().n;
  assert.equal((await api('POST','/api/delivery',assign(fulfillment.id),2)).status,403);
  assert.equal((await api('POST','/api/delivery',assign(fulfillment.id,{assigneeId:3}),1)).status,403);
  const purchase=db.prepare("SELECT id FROM order_fulfillments WHERE number='DEMO-GRN-BLR-302'").get();
  assert.equal((await api('POST','/api/delivery',assign(purchase.id,{clientReference:'PURCHASE'}))).status,409);
  const id=(await api('POST','/api/delivery',assign(fulfillment.id))).data.delivery.id;
  assert.equal((await api('GET',`/api/delivery/${id}`,undefined,4,2)).status,404);
  assert.equal((await api('POST',`/api/delivery/${id}/attempts`,attempt(fulfillment.order_line_id,1,{clientReference:'ACCOUNTANT'}),2)).status,403);
  assert.equal((await api('POST',`/api/delivery/${id}/attempts`,attempt(999999,1,{clientReference:'WRONG'}))).status,409);
  assert.equal((await api('POST',`/api/delivery/${id}/attempts`,attempt(fulfillment.order_line_id,1,{clientReference:'NO-PROOF',proofMethod:'none'}))).status,400);
  assert.equal((await api('POST',`/api/delivery/${id}/attempts`,{clientReference:'BAD-FAIL',outcome:'failed',attemptDate:'2026-09-25',lines:[],proofMethod:'none',note:'No reason'})).status,400);
  const collection={clientReference:'COLLECT-1',reportedAmountCents:5000,method:'cash',reference:'DEMO-CASH-NOTE',note:'Staff reported collection, unallocated'};
  const report=await api('POST',`/api/delivery/${id}/collections`,collection);
  assert.equal(report.status,200);
  assert.equal(report.data.delivery.collectionStatus,'reported_unallocated');
  assert.equal(report.data.delivery.status,'assigned');
  assert.equal((await api('POST',`/api/delivery/${id}/collections`,collection)).data.replayed,true);
  assert.equal((await api('POST',`/api/delivery/${id}/collections`,{...collection,reportedAmountCents:6000})).status,409);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM invoice_payments').get().n,beforePayments);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM journals').get().n,beforeJournals);
});

test('synthetic specimen is idempotent and explicitly staff reported',async t => {
  const {db}=await fixture(t);
  assert.equal(seedDeliveryDemo(db),true);
  assert.equal(seedDeliveryDemo(db),false);
  const row=db.prepare("SELECT id FROM delivery_jobs WHERE client_reference='DEMO-DELIVERY-BLR-030'").get();
  assert.ok(row);
  const event=db.prepare('SELECT proof_source,recipient_name FROM delivery_attempts WHERE delivery_id=?').get(row.id);
  assert.equal(event.proof_source,'staff_reported');
  assert.match(event.recipient_name,/Demo/);
});
