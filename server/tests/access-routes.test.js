import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createApp } = require('../api.cjs');
const { openDatabase } = require('../db.cjs');

test('company admin grants and revokes a demo user GSTIN and branch with durable audit', async t => {
  const db = openDatabase(':memory:');
  const server = createApp({ db }).listen(0);
  t.after(() => { server.close(); db.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (path, body, actor = 3) => {
    const response = await fetch(base + path, { method:body ? 'POST' : 'GET',
      headers:{ 'content-type':'application/json','x-company-id':'1','x-user-id':String(actor) },
      body:body ? JSON.stringify(body) : undefined });
    return {status:response.status, data:await response.json()};
  };
  assert.equal((await call('/api/access/grants',undefined,1)).status,403);
  const initial = await call('/api/access/grants');
  assert.equal(initial.status,200);
  assert.equal(initial.data.gstins.length,2);
  assert.equal(initial.data.users.find(user => user.id === 1).branchIds.length,3);

  const revoke = await call('/api/access/grants/gstin/revoke',{userId:1,scopeId:1,reason:'Moved to Bengaluru'});
  assert.equal(revoke.status,200);
  assert.deepEqual(revoke.data.gstinIds,[2]);
  assert.deepEqual(revoke.data.branchIds,[3]);
  assert.equal((await call('/api/stock?branchId=1',undefined,1)).status,403);

  const grant = await call('/api/access/grants/gstin/grant',{userId:1,scopeId:1,reason:'Reassigned registration'});
  assert.equal(grant.status,200);
  assert.deepEqual(grant.data.gstinIds,[1,2]);
  assert.deepEqual(grant.data.branchIds,[3]);
  assert.equal((await call('/api/access/grants/branch/grant',{userId:1,scopeId:1,reason:'Reassigned Mumbai'})).status,200);
  assert.equal((await call('/api/stock?branchId=1',undefined,1)).status,200);
  const final = await call('/api/access/grants');
  assert.deepEqual(final.data.users.find(user => user.id === 1).branchIds,[1,3]);
  assert.equal(final.data.events[0].reason,'Reassigned Mumbai');
  assert.equal((await call('/api/access/grants/branch/revoke',{userId:1,scopeId:1,reason:''})).status,400);
  assert.equal((await call('/api/access/grants/gstin/grant',{userId:1,scopeId:3,reason:'Other company'})).status,404);
});
