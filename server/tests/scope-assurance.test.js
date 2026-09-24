import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { openDatabase } = require('../db.cjs');
const { createApp } = require('../api.cjs');
const { revokeGstin, revokeBranch } = require('../access.cjs');

async function fixture(t) {
  const db = openDatabase(':memory:');
  const server = createApp({db}).listen(0);
  t.after(() => { server.close(); db.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const api = async (method,path,body,userId=1) => {
    const response = await fetch(`${base}${path}`,{method,headers:{'content-type':'application/json','x-company-id':'1','x-user-id':String(userId)},body:body === undefined ? undefined : JSON.stringify(body)});
    return {status:response.status,data:await response.json()};
  };
  return {db,api};
}

test('evidence and workflow details, events, writes and lists respect partial branch grants', async t => {
  const {db,api} = await fixture(t);
  const caseId = Number(db.prepare("INSERT INTO workflow_cases(company_id,feature_id,gstin_id,branch_id,title,reference,record_date,amount_cents,created_by) VALUES (1,'ERP-001',2,3,'Scoped case','SC-1','2026-09-24',0,1)").run().lastInsertRowid);
  const contentBase64 = Buffer.from('Scoped specimen').toString('base64');
  const evidence = await api('POST','/api/evidence',{gstinId:2,branchId:3,targetType:'invoice',targetId:4,title:'Scoped',fileName:'scope.txt',mimeType:'text/plain',contentBase64});
  assert.equal(evidence.status,200);
  const evidenceId = evidence.data.document.id;
  revokeGstin(db,{companyId:1,actorId:3,userId:1,gstinId:2,reason:'Restrict to Mumbai'});
  assert.equal((await api('GET','/api/evidence')).data.documents.some(row => row.id === evidenceId),false);
  assert.equal((await api('GET','/api/workflows/cases')).data.cases.some(row => row.id === caseId),false);
  for (const path of [`/api/evidence/${evidenceId}`,`/api/evidence/${evidenceId}/download`,`/api/workflows/cases/${caseId}`,`/api/workflows/cases/${caseId}/events`]) {
    assert.equal((await api('GET',path)).status,403,path);
  }
  assert.equal((await api('POST',`/api/evidence/${evidenceId}/versions`,{fileName:'v2.txt',mimeType:'text/plain',contentBase64})).status,403);
  assert.equal((await api('POST','/api/evidence',{gstinId:2,branchId:3,targetType:'invoice',targetId:4,title:'Another',fileName:'scope.txt',mimeType:'text/plain',contentBase64})).status,403);
  assert.equal((await api('POST',`/api/workflows/cases/${caseId}/submit`,{})).status,403);
  assert.equal((await api('GET','/api/evidence?gstinId=2')).status,403);
  assert.equal((await api('GET','/api/workflows/cases?branchId=3')).status,403);
  assert.equal((await api('GET','/api/evidence?gstinId=1')).status,200);
});

test('statement imports and both statutory simulators enforce scope on source and replay', async t => {
  const {db,api} = await fixture(t);
  const simulated = await api('POST','/api/simulations',{kind:'irn',gstinId:2,sourceId:4,scenario:'success',idempotencyKey:'scope-sim'});
  assert.equal(simulated.status,200);
  const auth = await api('POST','/api/statutory/auth',{gstinId:2,service:'irn',scenario:'success',idempotencyKey:'scope-auth'},2);
  assert.equal(auth.status,200);
  const tokenId = auth.data.token.id;
  const lifecycle = await api('POST','/api/statutory/irn/generate',{gstinId:2,sourceId:4,tokenId,scenario:'success',idempotencyKey:'scope-life'},2);
  assert.equal(lifecycle.status,200);
  revokeGstin(db,{companyId:1,actorId:3,userId:1,gstinId:2,reason:'Restrict to Mumbai'});
  revokeGstin(db,{companyId:1,actorId:3,userId:2,gstinId:2,reason:'Restrict reviewer'});
  assert.equal((await api('GET','/api/simulations')).data.simulations.some(row => row.id === simulated.data.simulation.id),false);
  assert.equal((await api('GET','/api/gst/statement-imports?gstinId=2')).status,403);
  assert.equal((await api('GET','/api/statutory/documents?gstinId=2',undefined,2)).status,403);
  assert.equal((await api('GET','/api/statutory/events?gstinId=2',undefined,2)).status,403);
  assert.equal((await api('POST','/api/simulations',{kind:'irn',gstinId:2,sourceId:4,scenario:'success',idempotencyKey:'scope-sim'})).status,403);
  assert.equal((await api('POST','/api/statutory/irn/generate',{gstinId:2,sourceId:4,tokenId,scenario:'success',idempotencyKey:'scope-life'},2)).status,403);
  assert.equal((await api('POST','/api/gst/statement-imports/preview',{gstinId:2,period:'2026-09',sourceName:'test',csv:'supplier_gstin,invoice_number,invoice_date,taxable_amount,tax_amount\n27ABCDE1234F1Z5,A,2026-09-01,10,1'},2)).status,403);
});

test('GSTIN grant without invoice branch grant cannot expose statutory source history', async t => {
  const {db,api} = await fixture(t);
  const mock = await api('POST','/api/simulations',{kind:'irn',gstinId:2,sourceId:4,scenario:'success',idempotencyKey:'branch-mock'},2);
  assert.equal(mock.status,200);
  const auth = await api('POST','/api/statutory/auth',{gstinId:2,service:'irn',scenario:'success',idempotencyKey:'branch-auth'},2);
  assert.equal(auth.status,200);
  const request = {gstinId:2,sourceId:4,tokenId:auth.data.token.id,scenario:'success',idempotencyKey:'branch-life'};
  const made = await api('POST','/api/statutory/irn/generate',request,2);
  assert.equal(made.status,200);
  revokeBranch(db,{companyId:1,actorId:3,userId:2,branchId:3,reason:'Remove Bengaluru branch'});
  assert.equal((await api('GET','/api/simulations?gstinId=2',undefined,2)).data.simulations.some(row => row.id === mock.data.simulation.id),false);
  assert.equal((await api('GET','/api/statutory/documents?gstinId=2',undefined,2)).data.documents.some(row => row.id === made.data.document.id),false);
  const events = (await api('GET','/api/statutory/events?gstinId=2',undefined,2)).data.events;
  assert.equal(events.some(row => row.id === made.data.event.id),false);
  assert.equal(events.some(row => row.action === 'auth'),true);
  assert.equal((await api('POST','/api/simulations',{kind:'irn',gstinId:2,sourceId:4,scenario:'success',idempotencyKey:'branch-mock'},2)).status,403);
  assert.equal((await api('POST','/api/statutory/irn/generate',request,2)).status,403);
});

test('partial branch grant cannot create, replay or read GST return simulation for the whole GSTIN', async t => {
  const {db,api} = await fixture(t);
  const period = db.prepare("SELECT id FROM gst_periods WHERE company_id=1 AND gstin_id=1 AND status='approved' LIMIT 1").get();
  assert.ok(period);
  const authBody = {gstinId:1,service:'gst_return',scenario:'success',idempotencyKey:'period-auth-scope'};
  const auth = await api('POST','/api/statutory/auth',authBody,2);
  assert.equal(auth.status,200);
  const action = {gstinId:1,sourceId:period.id,tokenId:auth.data.token.id,scenario:'success',idempotencyKey:'period-save-scope'};
  const saved = await api('POST','/api/statutory/gst_return/save',action,2);
  assert.equal(saved.status,200);
  revokeBranch(db,{companyId:1,actorId:3,userId:2,branchId:2,reason:'Remove Pune branch'});
  assert.equal((await api('GET',`/api/gst/periods/${period.id}`,undefined,2)).status,403);
  assert.equal((await api('POST','/api/statutory/auth',{...authBody,idempotencyKey:'period-auth-scope-2'},2)).status,403);
  assert.equal((await api('POST','/api/statutory/auth',authBody,2)).status,403);
  assert.equal((await api('POST','/api/statutory/gst_return/save',action,2)).status,403);
  const documents = await api('GET','/api/statutory/documents?gstinId=1',undefined,2);
  assert.equal(documents.status,200);
  assert.equal(documents.data.documents.some(row => row.id === saved.data.document.id),false);
  const events = await api('GET','/api/statutory/events?gstinId=1',undefined,2);
  assert.equal(events.status,200);
  assert.equal(events.data.events.some(row => row.id === saved.data.event.id || row.id === auth.data.event.id),false);
});
