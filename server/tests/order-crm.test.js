import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const { openDatabase } = require('../db.cjs');
const { registerOrderCrmRoutes } = require('../order-crm.cjs');
const { seedOrderCrmDemo } = require('../order-crm-db.cjs');

async function fixture(t) {
  const db = openDatabase(':memory:');
  const app = express(); app.use(express.json());
  app.use('/api',(req,_res,next) => {
    const companyId=Number(req.header('x-company-id') || 1),userId=Number(req.header('x-user-id') || 1);
    req.company=db.prepare('SELECT * FROM companies WHERE id=?').get(companyId);
    req.user=db.prepare('SELECT * FROM users WHERE id=? AND company_id=?').get(userId,companyId);
    if (!req.company || !req.user) return next(Object.assign(new Error('Unknown identity'),{status:403}));
    next();
  });
  registerOrderCrmRoutes(app,db);
  app.use((error,_req,res,_next) => res.status(error.status || 500).json({error:error.message}));
  const server=app.listen(0);
  t.after(() => {server.close();db.close();});
  const base=`http://127.0.0.1:${server.address().port}`;
  const api=async(method,path,body,userId=1,companyId=1) => {
    const response=await fetch(base+path,{method,headers:{'content-type':'application/json','x-company-id':String(companyId),'x-user-id':String(userId)},body:body===undefined?undefined:JSON.stringify(body)});
    return {status:response.status,data:await response.json()};
  };
  return {db,api};
}

const payload = (orderId, overrides={}) => ({gstinId:2,branchId:3,partyId:1,orderId,ownerId:1,
  clientReference:'TEST-CRM-1',subject:'Delivery enquiry',customerRequest:'Customer asks when the remaining boxes arrive',
  nextAction:'Call customer with dispatch date',dueDate:'2026-10-01',...overrides});

test('scoped follow-up links exact customer order, replays, and never posts commerce',async t => {
  const {db,api}=await fixture(t);
  const order=db.prepare("SELECT id FROM orders WHERE number='DEMO-SO-BLR-301'").get();
  assert.ok(order);
  const before={stock:db.prepare('SELECT COUNT(*) AS n FROM stock_movements').get().n,
    invoices:db.prepare('SELECT COUNT(*) AS n FROM invoices').get().n,
    journals:db.prepare('SELECT COUNT(*) AS n FROM journals').get().n};
  assert.equal((await api('POST','/api/order-crm',payload(order.id,{branchId:1}))).status,400);
  assert.equal((await api('POST','/api/order-crm',payload(order.id,{partyId:3}))).status,409);
  assert.equal((await api('POST','/api/order-crm',payload(order.id,{orderId:null,ownerId:3}))).status,403);
  const created=await api('POST','/api/order-crm',payload(order.id));
  assert.equal(created.status,200);
  assert.equal(created.data.case.order.id,order.id);
  assert.equal(created.data.case.partyName,'Harbor Clinic');
  assert.equal(created.data.case.events[0].kind,'request');
  const replay=await api('POST','/api/order-crm',payload(order.id));
  assert.equal(replay.data.replayed,true);
  assert.equal(replay.data.case.id,created.data.case.id);
  assert.equal((await api('POST','/api/order-crm',payload(order.id,{subject:'Different'}))).status,409);
  assert.equal((await api('GET',`/api/order-crm/${created.data.case.id}`,undefined,4,2)).status,404);
  assert.equal((await api('GET',`/api/order-crm/${created.data.case.id}`,undefined,2)).status,200);
  assert.equal((await api('POST',`/api/order-crm/${created.data.case.id}/actions`,{kind:'request',clientReference:'ACCOUNTANT',detail:'No'},2)).status,403);
  assert.deepEqual({stock:db.prepare('SELECT COUNT(*) AS n FROM stock_movements').get().n,
    invoices:db.prepare('SELECT COUNT(*) AS n FROM invoices').get().n,
    journals:db.prepare('SELECT COUNT(*) AS n FROM journals').get().n},before);
});

test('commitments retain immutable history with dispositions, owner changes and blockers',async t => {
  const {db,api}=await fixture(t);
  const order=db.prepare("SELECT id FROM orders WHERE number='DEMO-SO-BLR-301'").get();
  const fulfillment=db.prepare('SELECT id FROM order_fulfillments WHERE order_id=?').get(order.id);
  const caseId=(await api('POST','/api/order-crm',payload(order.id))).data.case.id;
  const act=(body,userId=1) => api('POST',`/api/order-crm/${caseId}/actions`,body,userId);
  const promised=await act({kind:'commitment',clientReference:'promise-1',detail:'Dispatch six boxes by Friday'});
  assert.equal(promised.status,200);
  const promiseId=promised.data.event.id;
  const disposition={kind:'disposition',clientReference:'disposition-1',detail:'Four boxes dispatched',relatedEventId:promiseId,disposition:'partial'};
  assert.equal((await act(disposition)).status,200);
  assert.equal((await act(disposition)).data.replayed,true);
  assert.equal((await act({...disposition,detail:'Changed'})).status,409);
  assert.equal((await act({kind:'disposition',clientReference:'wrong',detail:'No',relatedEventId:1,disposition:'unmet'})).status,409);
  const second=await act({kind:'commitment',clientReference:'promise-2',detail:'Call with new ETA'});
  assert.equal(second.data.case.commitments.length,2);
  assert.equal(second.data.case.commitments[0].latestDisposition.disposition,'partial');
  assert.equal(second.data.case.commitments[0].detail,'Dispatch six boxes by Friday');
  assert.equal((await act({kind:'follow_up',clientReference:'owner-bad',detail:'Hand over',nextAction:'Call tomorrow',dueDate:'2026-10-02',ownerId:3})).status,403);
  assert.equal((await act({kind:'follow_up',clientReference:'owner-good',detail:'Hand over',nextAction:'Call tomorrow',dueDate:'2026-10-02',ownerId:3},3)).status,200);
  assert.equal((await act({kind:'commitment',clientReference:'promise-1',detail:'Dispatch six boxes by Friday'})).data.replayed,true);
  assert.equal((await act({kind:'request',clientReference:'old-owner',detail:'Cannot edit'})).status,403);
  const blocked=await act({kind:'blocker_open',clientReference:'blocker-1',detail:'Warehouse confirmation pending',fulfillmentId:fulfillment.id},3);
  assert.equal(blocked.status,200);
  assert.equal(blocked.data.case.blockers[0].fulfillmentId,fulfillment.id);
  assert.equal(blocked.data.case.blockers[0].fulfillmentNumber,'DEMO-DISP-BLR-301');
  assert.equal(blocked.data.case.fulfillments[0].id,fulfillment.id);
  const blockerId=blocked.data.case.blockers[0].id;
  assert.equal((await act({kind:'blocker_resolve',clientReference:'resolve-1',detail:'Date confirmed',blockerId},3)).data.case.blockers[0].status,'resolved');
  assert.equal((await act({kind:'close',clientReference:'close-1',detail:'Follow-up complete'},3)).data.case.status,'closed');
  assert.equal((await act({kind:'request',clientReference:'too-late',detail:'More'},3)).status,409);
  assert.equal((await act({kind:'reopen',clientReference:'reopen-1',detail:'Customer called again'},3)).data.case.status,'open');
});

test('synthetic case seeds once with prior promise and source fulfillment',async t => {
  const {db}=await fixture(t);
  assert.equal(seedOrderCrmDemo(db),true);
  assert.equal(seedOrderCrmDemo(db),false);
  const defaultCase=db.prepare("SELECT id,order_id,gstin_id,branch_id FROM order_crm_cases WHERE client_reference='DEMO-CRM-MUM-029'").get();
  assert.ok(defaultCase);
  assert.equal(defaultCase.order_id,null);
  assert.equal(defaultCase.gstin_id,1);
  assert.equal(defaultCase.branch_id,1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM order_crm_events WHERE case_id=?').get(defaultCase.id).n,2);
  const row=db.prepare("SELECT id FROM order_crm_cases WHERE client_reference='DEMO-CRM-BLR-029'").get();
  assert.ok(row);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM order_crm_events WHERE case_id=?').get(row.id).n,5);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM order_crm_blockers WHERE case_id=?').get(row.id).n,1);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM order_crm_cases WHERE client_reference LIKE 'DEMO-CRM-%-029'").get().n,2);
});

test('synthetic enquiries and linked cases are not duplicated when the database reopens',() => {
  const directory=mkdtempSync(join(tmpdir(),'order-crm-'));
  try {
    const filename=join(directory,'demo.sqlite');
    const first=openDatabase(filename);
    assert.equal(seedOrderCrmDemo(first),true);
    first.close();
    const reopened=openDatabase(filename);
    assert.equal(seedOrderCrmDemo(reopened),false);
    assert.equal(reopened.prepare("SELECT COUNT(*) AS n FROM order_crm_cases WHERE client_reference LIKE 'DEMO-CRM-%-029'").get().n,2);
    assert.equal(reopened.prepare('SELECT COUNT(*) AS n FROM order_crm_events').get().n,7);
    reopened.close();
  } finally { rmSync(directory,{recursive:true,force:true}); }
});
