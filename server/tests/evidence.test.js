import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { openDatabase } = require('../db.cjs');
const { createApp } = require('../api.cjs');

async function fixture(t) {
  const db = openDatabase(':memory:');
  const server = createApp({db}).listen(0);
  t.after(() => { server.close(); db.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const api = async (method,path,body,companyId=1,userId=1) => {
    const response = await fetch(`${base}${path}`,{method,headers:{'content-type':'application/json','x-company-id':String(companyId),'x-user-id':String(userId)},body:body === undefined ? undefined : JSON.stringify(body)});
    return {status:response.status,data:response.headers.get('content-type')?.includes('json') ? await response.json() : Buffer.from(await response.arrayBuffer()),headers:response.headers};
  };
  return { api,db };
}
const content = Buffer.from('Delivery note for demo invoice', 'utf8');
const upload = (overrides = {}) => ({ gstinId:1,branchId:1,targetType:'invoice',targetId:1,title:'Delivery note',audience:'internal',fileName:'delivery.txt',mimeType:'text/plain',contentBase64:content.toString('base64'),...overrides });
const reviewBody = (version, decision, reason = '') => ({ expectedVersion:version.version, expectedSha256:version.sha256, decision, reason });

test('upload, scoped listing, immutable versions, download and local review', async t => {
  const {api} = await fixture(t);
  const created = await api('POST','/api/evidence',upload());
  assert.equal(created.status,200);
  const id = created.data.document.id;
  assert.equal(created.data.document.versions[0].sha256,'fd6dc61f5fa3b5f39210ddefdc1fc082f76877d26f8d933fa79c22c3b598f81f');
  assert.equal(created.data.document.versions[0].status,'pending');
  const list = await api('GET','/api/evidence?gstinId=1&branchId=1');
  assert.equal(list.data.documents.some(document => document.id === id && document.targetId === 1),true);
  assert.equal((await api('GET','/api/evidence?gstinId=2')).data.documents.length,0);
  const downloaded = await api('GET',`/api/evidence/${id}/download`);
  assert.equal(downloaded.status,200);
  assert.deepEqual(downloaded.data,content);
  assert.equal(downloaded.headers.get('x-content-type-options'),'nosniff');
  assert.equal((await api('POST',`/api/evidence/${id}/review`,{decision:'approved'},1,1)).status,403);
  const approved = await api('POST',`/api/evidence/${id}/review`,reviewBody(created.data.document.versions[0],'approved','Checked against source'),1,2);
  assert.equal(approved.data.document.versions[0].status,'approved');
  assert.equal(approved.data.document.versions[0].reviewedBy,2);
  const replacement = await api('POST',`/api/evidence/${id}/versions`,{fileName:'delivery-v2.txt',mimeType:'text/plain',contentBase64:Buffer.from('Updated copy').toString('base64')});
  assert.equal(replacement.data.document.versions.length,2);
  assert.equal(replacement.data.document.versions[0].status,'pending');
  assert.equal(replacement.data.document.versions[1].status,'approved');
  assert.deepEqual((await api('GET',`/api/evidence/${id}/download?version=1`)).data,content);
  assert.equal((await api('POST',`/api/evidence/${id}/review`,reviewBody(replacement.data.document.versions[0],'rejected'),1,2)).status,400);
  assert.equal((await api('POST',`/api/evidence/${id}/review`,reviewBody(replacement.data.document.versions[0],'rejected','Missing signature'),1,2)).data.document.versions[0].status,'rejected');
  assert.equal((await api('POST',`/api/evidence/${id}/review`,reviewBody(replacement.data.document.versions[0],'approved'),1,2)).status,409);
});

test('review is bound to the exact observed file version and hash', async t => {
  const {api} = await fixture(t);
  const created = await api('POST','/api/evidence',upload());
  const id = created.data.document.id;
  const observed = created.data.document.versions[0];
  assert.equal((await api('POST',`/api/evidence/${id}/review`,{decision:'approved'},1,2)).status,400);
  const replacement = await api('POST',`/api/evidence/${id}/versions`,{fileName:'new-copy.txt',mimeType:'text/plain',contentBase64:Buffer.from('New contents').toString('base64')});
  const current = replacement.data.document.versions[0];
  assert.equal((await api('POST',`/api/evidence/${id}/review`,reviewBody(observed,'approved'),1,2)).status,409);
  assert.equal((await api('POST',`/api/evidence/${id}/review`,{...reviewBody(current,'approved'),expectedSha256:observed.sha256},1,2)).status,409);
  assert.equal((await api('GET',`/api/evidence/${id}`)).data.document.versions[0].status,'pending');
  assert.equal((await api('POST',`/api/evidence/${id}/review`,reviewBody(current,'approved'),1,2)).status,200);
});

test('an uploader cannot review their own exact evidence version', async t => {
  const {api,db} = await fixture(t);
  const created = await api('POST','/api/evidence',upload(),1,2);
  const id = created.data.document.id;
  const first = created.data.document.versions[0];
  assert.equal((await api('POST',`/api/evidence/${id}/review`,reviewBody(first,'approved'),1,2)).status,403);
  assert.equal((await api('POST',`/api/evidence/${id}/review`,reviewBody(first,'rejected','Invalid document'),1,2)).status,403);
  assert.equal(db.prepare('SELECT status FROM evidence_versions WHERE document_id=? AND version=1').get(id).status,'pending');
  assert.equal((await api('POST',`/api/evidence/${id}/review`,reviewBody(first,'approved'),1,3)).status,200);
  const replacement = await api('POST',`/api/evidence/${id}/versions`,{fileName:'new-copy.txt',mimeType:'text/plain',contentBase64:Buffer.from('New contents').toString('base64')},1,3);
  const second = replacement.data.document.versions[0];
  assert.equal((await api('POST',`/api/evidence/${id}/review`,reviewBody(second,'approved'),1,3)).status,403);
  assert.equal((await api('POST',`/api/evidence/${id}/review`,reviewBody(second,'approved'),1,2)).status,200);
});

test('company and target isolation, scope matching and malicious file rejection', async t => {
  const {api} = await fixture(t);
  const created = await api('POST','/api/evidence',upload());
  const id = created.data.document.id;
  assert.equal((await api('GET',`/api/evidence/${id}`,undefined,2,5)).status,404);
  assert.equal((await api('GET',`/api/evidence/${id}/download`,undefined,2,5)).status,404);
  assert.equal((await api('POST',`/api/evidence/${id}/versions`,upload(),2,5)).status,404);
  assert.equal((await api('POST',`/api/evidence/${id}/review`,{decision:'approved'},2,5)).status,404);
  assert.equal((await api('POST','/api/evidence',upload({gstinId:2,branchId:1}))).status,400);
  assert.equal((await api('POST','/api/evidence',upload({targetId:999}))).status,404);
  assert.equal((await api('POST','/api/evidence',upload({targetId:1,gstinId:3,branchId:4}),2,5)).status,404);
  assert.equal((await api('POST','/api/evidence',upload({fileName:'../unsafe.txt'}))).status,400);
  assert.equal((await api('POST','/api/evidence',upload({fileName:'malware.html',mimeType:'text/html'}))).status,400);
  assert.equal((await api('POST','/api/evidence',upload({fileName:'fake.pdf',mimeType:'application/pdf'}))).status,400);
  assert.equal((await api('POST','/api/evidence',upload({contentBase64:Buffer.alloc(128*1024+1,65).toString('base64')}))).status,400);
});

test('workflow case links require exact company/GSTIN/branch', async t => {
  const {api,db} = await fixture(t);
  const caseId = Number(db.prepare("INSERT INTO workflow_cases(company_id,feature_id,gstin_id,branch_id,title,reference,record_date,amount_cents,created_by) VALUES (1,'ERP-001',1,1,'Sample','REF-1','2026-09-24',0,1)").run().lastInsertRowid);
  const record = await api('POST','/api/evidence',upload({targetType:'workflow_case',targetId:caseId}));
  assert.equal(record.status,200);
  assert.equal(record.data.document.targetType,'workflow_case');
  assert.equal((await api('POST','/api/evidence',upload({targetType:'workflow_case',targetId:caseId,branchId:2}))).status,404);
  assert.equal((await api('PUT',`/api/workflows/cases/${caseId}`,{branchId:2})).status,409);
  assert.equal(db.prepare('SELECT branch_id FROM workflow_cases WHERE id=?').get(caseId).branch_id,1);
  db.prepare('UPDATE workflow_cases SET branch_id=2 WHERE id=?').run(caseId);
  assert.equal((await api('GET',`/api/evidence/${record.data.document.id}/download`)).status,404);
  assert.equal((await api('POST',`/api/evidence/${record.data.document.id}/review`,{decision:'approved'},1,2)).status,404);
});
