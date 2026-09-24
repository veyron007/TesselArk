import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createApp } = require('../api.cjs');
const { openDatabase } = require('../db.cjs');
const { registerStatutoryLifecycleRoutes } = require('../statutory-lifecycle.cjs');
const express = require('express');

async function fixture(t) {
  const db = openDatabase(':memory:');
  const app = createApp({ db });
  if (!app.router.stack.some(layer => layer.route?.path === '/api/statutory/auth')) registerStatutoryLifecycleRoutes(app, db);
  const server = app.listen(0);
  t.after(() => { server.close(); db.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const api = async (method, path, body, companyId=1, userId=2) => {
    const response = await fetch(base+path,{method,headers:{'content-type':'application/json','x-company-id':String(companyId),'x-user-id':String(userId)},body:body === undefined ? undefined : JSON.stringify(body)});
    return {status:response.status,data:await response.json()};
  };
  const invoice = db.prepare("SELECT id,gstin_id FROM invoices WHERE company_id=1 AND type='sale' AND status='approved' AND gstin_id=1 LIMIT 1").get();
  const period = db.prepare("SELECT id,gstin_id FROM gst_periods WHERE company_id=1 AND status='approved' AND gstin_id=1 LIMIT 1").get();
  let counter=0;
  const key = () => `lifecycle-test-${++counter}`;
  const auth = async (service,scenario='success',userId=2) => api('POST','/api/statutory/auth',{gstinId:1,service,scenario,idempotencyKey:key()},1,userId);
  return {db,api,invoice,period,key,auth};
}

test('IRN auth, generation, get and cancel retain simulated references and immutable events', async t => {
  const {db,api,invoice,key,auth} = await fixture(t);
  const token = await auth('irn');
  assert.equal(token.status,200);
  assert.match(token.data.token.token_reference,/^SIM-/);
  const body = {gstinId:1,sourceId:invoice.id,tokenId:token.data.token.id,scenario:'success',idempotencyKey:key()};
  assert.equal((await api('POST','/api/statutory/irn/generate',body,1,1)).status,403);
  assert.equal((await api('POST','/api/statutory/irn/generate',body,1,3)).status,403);
  const generated = await api('POST','/api/statutory/irn/generate',body);
  assert.equal(generated.status,200);
  assert.equal(generated.data.document.status,'generated');
  assert.match(generated.data.document.reference,/^SIM-/);
  assert.equal(generated.data.event.sourceSnapshot.id,invoice.id);
  assert.equal(generated.data.event.response.officialSubmission,false);
  const replay = await api('POST','/api/statutory/irn/generate',body);
  assert.equal(replay.data.replayed,true);
  assert.equal(replay.data.event.id,generated.data.event.id);
  assert.equal((await api('POST','/api/statutory/irn/generate',{...body,idempotencyKey:key()})).status,409);
  assert.equal((await api('POST','/api/statutory/irn/get',{...body,idempotencyKey:key()})).data.document.status,'generated');
  const cancelled = await api('POST','/api/statutory/irn/cancel',{...body,idempotencyKey:key(),reason:'Duplicate demo document'});
  assert.equal(cancelled.data.document.status,'cancelled');
  assert.equal(cancelled.data.document.reference,generated.data.document.reference);
  assert.equal((await api('POST','/api/statutory/irn/cancel',{...body,idempotencyKey:key(),reason:'Again'})).status,409);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM statutory_lifecycle_events WHERE action='generate' AND kind='irn' AND source_id=?").get(invoice.id).n,1);
});

test('e-way Part B, rejection, timeout and retry preserve state and scope', async t => {
  const {db,api,invoice,key,auth} = await fixture(t);
  const token=(await auth('eway')).data.token;
  const body={gstinId:1,sourceId:invoice.id,tokenId:token.id,idempotencyKey:key()};
  const timedOut=await api('POST','/api/statutory/eway/generate',{...body,scenario:'timeout'});
  assert.equal(timedOut.status,200,JSON.stringify(timedOut.data));
  assert.equal(timedOut.data.document,null);
  const made=await api('POST','/api/statutory/eway/generate',{...body,idempotencyKey:key(),scenario:'success',vehicleNumber:'MH12AB1234'});
  assert.equal(made.data.document.status,'generated');
  assert.equal(made.data.document.vehicleNumber,'MH12AB1234');
  const rejected=await api('POST','/api/statutory/eway/update_part_b',{...body,idempotencyKey:key(),scenario:'rejection',vehicleNumber:'MH12AB9999'});
  assert.equal(rejected.data.document.vehicleNumber,'MH12AB1234');
  const updated=await api('POST','/api/statutory/eway/update_part_b',{...body,idempotencyKey:key(),scenario:'success',vehicleNumber:'MH12AB9999'});
  assert.equal(updated.data.document.vehicleNumber,'MH12AB9999');
  assert.equal((await api('POST','/api/statutory/eway/get',{...body,idempotencyKey:key()},2,5)).status,404);
  assert.equal((await api('POST','/api/statutory/eway/get',{...body,gstinId:2,idempotencyKey:key()})).status,403);
  db.prepare("UPDATE statutory_lifecycle_sessions SET expires_at=datetime('now','-1 minute') WHERE id=?").run(token.id);
  assert.equal((await api('POST','/api/statutory/eway/get',{...body,idempotencyKey:key()})).status,401);
});

test('GST return simulated save, independent review, sign, file and status never imply official filing', async t => {
  const {api,period,key,auth} = await fixture(t);
  const token=(await auth('gst_return')).data.token;
  const body={gstinId:1,sourceId:period.id,tokenId:token.id,scenario:'success'};
  const save=await api('POST','/api/statutory/gst_return/save',{...body,idempotencyKey:key()});
  assert.equal(save.data.document.status,'saved');
  assert.equal((await api('POST','/api/statutory/gst_return/review',{...body,idempotencyKey:key()})).status,403);
  const reviewed=await api('POST','/api/statutory/gst_return/review',{...body,idempotencyKey:key()},1,3);
  assert.equal(reviewed.data.document.status,'reviewed');
  assert.equal((await api('POST','/api/statutory/gst_return/sign',{...body,idempotencyKey:key()},1,3)).status,403);
  const signed=await api('POST','/api/statutory/gst_return/sign',{...body,idempotencyKey:key()});
  assert.equal(signed.data.document.status,'signed');
  assert.equal(signed.data.event.response.officialSignature,false);
  const filed=await api('POST','/api/statutory/gst_return/file',{...body,idempotencyKey:key()},1,3);
  assert.equal(filed.data.document.status,'filed');
  assert.match(filed.data.document.acknowledgement,/^SIM-ARN-/);
  assert.equal(filed.data.event.response.officialSubmission,false);
  assert.equal((await api('POST','/api/statutory/gst_return/status',{...body,idempotencyKey:key()})).data.document.status,'filed');
  assert.equal((await api('GET','/api/statutory/documents?gstinId=1')).data.documents.length,1);
  assert.equal((await api('GET','/api/statutory/events?gstinId=1')).data.events.length,6);
});

test('revoked GSTIN grant blocks action, replay and history after token issue', async t => {
  const {db,api,invoice,key,auth} = await fixture(t);
  const token=(await auth('irn')).data.token;
  const body={gstinId:1,sourceId:invoice.id,tokenId:token.id,scenario:'success',idempotencyKey:key()};
  assert.equal((await api('POST','/api/statutory/irn/generate',body)).status,200);
  db.prepare("UPDATE user_gstin_grants SET revoked_at=CURRENT_TIMESTAMP,revoked_by=3,revoked_reason='Scoped access removed' WHERE company_id=1 AND user_id=2 AND gstin_id=1").run();
  assert.equal((await api('POST','/api/statutory/irn/generate',body)).status,403);
  assert.equal((await api('POST','/api/statutory/auth',{gstinId:1,service:'irn',scenario:'success',idempotencyKey:key()})).status,403);
  assert.equal((await api('GET','/api/statutory/events?gstinId=1')).status,403);
  assert.equal((await api('GET','/api/statutory/documents?gstinId=1')).status,403);
});
