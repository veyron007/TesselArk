import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const { openDatabase } = require('../db.cjs');
const { installAccessSchema, seedDemoGrants } = require('../access-db.cjs');
const { allowedScopes, assertCompanyWideAccess, assertGstinAccess, assertBranchAccess, assertScopeAccess,
  grantGstin, grantBranch, revokeGstin, revokeBranch } = require('../access.cjs');

function fixture(t) {
  const db = openDatabase(':memory:');
  installAccessSchema(db);
  seedDemoGrants(db);
  t.after(() => db.close());
  return db;
}

test('named demo users receive explicit own-company grants; new users deny by default', t => {
  const db = fixture(t);
  assert.deepEqual(allowedScopes(db,{companyId:1,userId:1}),{gstinIds:[1,2],branchIds:[1,2,3]});
  assert.deepEqual(assertCompanyWideAccess(db,{companyId:1,userId:1}),{gstinIds:[1,2],branchIds:[1,2,3]});
  assert.deepEqual(allowedScopes(db,{companyId:2,userId:4}),{gstinIds:[3],branchIds:[4]});
  assert.throws(() => allowedScopes(db,{companyId:2,userId:1}),{status:403});
  const id = Number(db.prepare("INSERT INTO users(company_id,name,role) VALUES (1,'New Hire','staff')").run().lastInsertRowid);
  seedDemoGrants(db);
  assert.deepEqual(allowedScopes(db,{companyId:1,userId:id}),{gstinIds:[],branchIds:[]});
  assert.throws(() => assertBranchAccess(db,{companyId:1,userId:id,branchId:1}),{status:403});
});

test('admin grants GSTIN and branch independently; branch must belong to granted GSTIN', t => {
  const db = fixture(t);
  const userId = Number(db.prepare("INSERT INTO users(company_id,name,role) VALUES (1,'New Hire','staff')").run().lastInsertRowid);
  assert.throws(() => grantBranch(db,{companyId:1,actorId:3,userId,branchId:1,reason:'Assigned depot'}),{status:409});
  grantGstin(db,{companyId:1,actorId:3,userId,gstinId:1,reason:'Assigned Mumbai registration'});
  assert.deepEqual(allowedScopes(db,{companyId:1,userId}),{gstinIds:[1],branchIds:[]});
  assert.throws(() => assertCompanyWideAccess(db,{companyId:1,userId}),{status:403});
  grantBranch(db,{companyId:1,actorId:3,userId,branchId:1,reason:'Assigned depot'});
  assert.equal(assertScopeAccess(db,{companyId:1,userId,gstinId:1,branchId:1}).id,1);
  assert.throws(() => assertScopeAccess(db,{companyId:1,userId,gstinId:2,branchId:1}),{status:400});
  assert.throws(() => assertBranchAccess(db,{companyId:1,userId,branchId:3}),{status:403});
  assert.throws(() => grantGstin(db,{companyId:1,actorId:1,userId,gstinId:2,reason:'Staff escalation'}),{status:403});
  assert.throws(() => grantGstin(db,{companyId:1,actorId:3,userId,gstinId:3,reason:'Foreign company'}),{status:404});
});

test('revocation persists through reseed and a regrant does not restore child branch', t => {
  const db = fixture(t);
  revokeGstin(db,{companyId:1,actorId:3,userId:1,gstinId:1,reason:'Access review'});
  assert.deepEqual(allowedScopes(db,{companyId:1,userId:1}),{gstinIds:[2],branchIds:[3]});
  assert.throws(() => assertGstinAccess(db,{companyId:1,userId:1,gstinId:1}),{status:403});
  seedDemoGrants(db);
  assert.deepEqual(allowedScopes(db,{companyId:1,userId:1}),{gstinIds:[2],branchIds:[3]});
  grantGstin(db,{companyId:1,actorId:3,userId:1,gstinId:1,reason:'Restored registration'});
  assert.deepEqual(allowedScopes(db,{companyId:1,userId:1}),{gstinIds:[1,2],branchIds:[3]});
  grantBranch(db,{companyId:1,actorId:3,userId:1,branchId:1,reason:'Restore Mumbai'});
  revokeBranch(db,{companyId:1,actorId:3,userId:1,branchId:1,reason:'Remove Mumbai'});
  assert.deepEqual(allowedScopes(db,{companyId:1,userId:1}),{gstinIds:[1,2],branchIds:[3]});
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM access_events WHERE company_id=1 AND user_id=1 AND action='revoke'").get().n,4);
});

test('grant history survives database reopen without reseeding revoked access', t => {
  const directory = mkdtempSync(join(tmpdir(),'erp-access-'));
  t.after(() => rmSync(directory,{recursive:true,force:true}));
  const file = join(directory,'test.sqlite');
  let db = openDatabase(file);
  installAccessSchema(db);
  assert.equal(seedDemoGrants(db),false);
  revokeBranch(db,{companyId:1,actorId:3,userId:1,branchId:2,reason:'Remove Pune access'});
  db.close();
  db = openDatabase(file);
  t.after(() => db.close());
  installAccessSchema(db);
  assert.equal(seedDemoGrants(db),false);
  assert.deepEqual(allowedScopes(db,{companyId:1,userId:1}),{gstinIds:[1,2],branchIds:[1,3]});
});
