import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const { createApp } = require('../api.cjs');
const { openDatabase } = require('../db.cjs');
const featureIds = require('../../src/data/features.json').map(feature => feature.id);

async function fixture(t) {
  const db = openDatabase(':memory:');
  const server = createApp({ db }).listen(0);
  t.after(() => { server.close(); db.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  return async (method, path, body, companyId = 1, userId = 1) => {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: { 'content-type':'application/json','x-company-id':String(companyId),'x-user-id':String(userId) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status:response.status,data:await response.json() };
  };
}

const draft = (featureId = 'ERP-001') => ({
  featureId,gstinId:1,branchId:1,title:'Catalogue search evidence',reference:'DEMO-001',date:'2026-09-24',amountCents:12345,
  notes:'Prototype review record',evidenceReference:'LOCAL-FILE-1',fields:{query:'glucose',resultCount:3,confirmed:true},
});

test('all catalogue IDs can create scoped interactive prototype records', async t => {
  const api = await fixture(t);
  assert.equal(featureIds.length,85);
  for (const featureId of featureIds) {
    const created = await api('POST','/api/workflows/cases',draft(featureId));
    assert.equal(created.status,200,featureId);
    assert.equal(created.data.prototype,true);
    assert.equal(created.data.case.featureId,featureId);
    assert.equal(created.data.case.status,'draft');
    assert.equal(created.data.case.fields.resultCount,3);
  }
  const list = await api('GET',`/api/workflows/cases?featureId=${featureIds[42]}`);
  assert.equal(list.data.cases.length,1);
  assert.equal(list.data.cases[0].featureId,featureIds[42]);
  assert.equal((await api('POST','/api/workflows/cases',draft('UNKNOWN-999'))).status,400);
});

test('draft editing, submission, accountant approval and audit are durable', async t => {
  const api = await fixture(t);
  const stockBefore = (await api('GET','/api/stock')).data;
  const gstBefore = (await api('GET','/api/gst/periods')).data;
  const financeBefore = (await api('GET','/api/finance/open?type=sale')).data;
  const created = await api('POST','/api/workflows/cases',draft());
  const id = created.data.case.id;
  const edited = await api('PUT',`/api/workflows/cases/${id}`,{title:'Updated evidence',fields:{searchTerm:'saline'},amountCents:25000});
  assert.equal(edited.data.case.title,'Updated evidence');
  assert.deepEqual(edited.data.case.fields,{searchTerm:'saline'});
  assert.equal((await api('POST',`/api/workflows/cases/${id}/submit`,{})).data.case.status,'submitted');
  assert.equal((await api('PUT',`/api/workflows/cases/${id}`,{title:'Too late'})).status,409);
  assert.equal((await api('POST',`/api/workflows/cases/${id}/approve`,{},1,1)).status,403);
  const approved = await api('POST',`/api/workflows/cases/${id}/approve`,{reason:'Evidence reviewed locally'},1,2);
  assert.equal(approved.data.case.status,'approved');
  assert.equal(approved.data.case.reviewReason,'Evidence reviewed locally');
  assert.equal((await api('POST',`/api/workflows/cases/${id}/approve`,{},1,2)).status,409);
  assert.equal((await api('PUT',`/api/workflows/cases/${id}`,{title:'Changed approved'})).status,409);
  const events = await api('GET',`/api/workflows/cases/${id}/events`);
  assert.deepEqual(events.data.events.map(event => event.action),['create','update','submit','approve']);
  assert.equal(events.data.events[0].snapshot.title,'Catalogue search evidence');
  assert.equal(events.data.events.at(-1).snapshot.status,'approved');
  assert.equal((await api('GET',`/api/workflows/cases/${id}`)).data.case.title,'Updated evidence');
  assert.deepEqual((await api('GET','/api/stock')).data,stockBefore);
  assert.deepEqual((await api('GET','/api/gst/periods')).data,gstBefore);
  assert.deepEqual((await api('GET','/api/finance/open?type=sale')).data,financeBefore);
});

test('rejection, company isolation, scope and structured-field validation', async t => {
  const api = await fixture(t);
  assert.equal((await api('POST','/api/workflows/cases',{...draft(),gstinId:2,branchId:1})).status,400);
  assert.equal((await api('POST','/api/workflows/cases',{...draft(),fields:{nested:{value:1}}})).status,400);
  assert.equal((await api('POST','/api/workflows/cases',{...draft(),date:'2026-02-30'})).status,400);
  const created = await api('POST','/api/workflows/cases',draft());
  const id = created.data.case.id;
  assert.equal((await api('GET',`/api/workflows/cases/${id}`,undefined,2,5)).status,404);
  assert.equal((await api('GET',`/api/workflows/cases/${id}/events`,undefined,2,5)).status,404);
  assert.equal((await api('PUT',`/api/workflows/cases/${id}`,{title:'Cross company'},2,5)).status,404);
  assert.equal((await api('GET','/api/workflows/cases',undefined,2,5)).data.cases.some(row => row.id === id),false);
  await api('POST',`/api/workflows/cases/${id}/submit`,{});
  const rejected = await api('POST',`/api/workflows/cases/${id}/reject`,{reason:'Evidence incomplete'},1,2);
  assert.equal(rejected.data.case.status,'rejected');
  assert.equal((await api('POST',`/api/workflows/cases/${id}/approve`,{},1,2)).status,409);
});

test('workflow cases and event history persist across database reopen', t => {
  const directory = mkdtempSync(join(tmpdir(),'tesselark-workflow-'));
  t.after(() => rmSync(directory,{recursive:true,force:true}));
  const file = join(directory,'demo.sqlite');
  const first = openDatabase(file);
  const id = Number(first.prepare("INSERT INTO workflow_cases(company_id,feature_id,gstin_id,branch_id,title,reference,record_date,amount_cents,fields_json,created_by) VALUES (1,'ERP-001',1,1,'Saved case','REF-1','2026-09-24',100,'{}',1)").run().lastInsertRowid);
  first.prepare("INSERT INTO workflow_case_events(case_id,company_id,action,actor_id,snapshot_json) VALUES (?,1,'create',1,'{}')").run(id);
  first.close();
  const reopened = openDatabase(file);
  assert.equal(reopened.prepare('SELECT title FROM workflow_cases WHERE id=?').get(id).title,'Saved case');
  assert.equal(reopened.prepare('SELECT COUNT(*) AS n FROM workflow_case_events WHERE case_id=?').get(id).n,1);
  reopened.close();
});
