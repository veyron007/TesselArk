import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createApp } = require('../api.cjs');
const { openDatabase } = require('../db.cjs');

async function fixture(t, authMode = 'demo') {
  const db = openDatabase(':memory:');
  const server = createApp({ db, authMode }).listen(0);
  t.after(() => { server.close(); db.close(); });
  const url = `http://127.0.0.1:${server.address().port}/api/demo/accounts`;
  const read = async (headers = {}) => {
    const response = await fetch(url, { headers });
    return { status: response.status, data: await response.json(), cacheControl: response.headers.get('cache-control') };
  };
  return { db, read };
}

test('demo account catalogue reflects seeded users and their live GSTIN and branch grants', async t => {
  const { db, read } = await fixture(t);
  const response = await read();
  assert.equal(response.status, 200);
  assert.equal(response.data.demoMode, true);
  assert.equal(response.cacheControl, 'no-store');
  const expected = db.prepare('SELECT id,company_id,name,role FROM users ORDER BY company_id,role,name').all();
  assert.equal(response.data.accounts.length, expected.length);
  for (const user of expected) {
    const account = response.data.accounts.find(row => row.userId === user.id);
    assert.ok(account);
    assert.equal(account.companyId, user.company_id);
    assert.equal(account.companyName, db.prepare('SELECT name FROM companies WHERE id=?').get(user.company_id).name);
    assert.equal(account.userName, user.name);
    assert.equal(account.role, user.role);
    assert.ok(account.gstins.length > 0);
    assert.ok(account.branches.length > 0);
    assert.ok(account.branches.every(branch => account.gstins.some(gstin => gstin.id === branch.gstinId)));
  }
});

test('demo account catalogue uses current grants and database IDs instead of fixed seed IDs', async t => {
  const { db, read } = await fixture(t);
  const ungrantedId = Number(db.prepare("INSERT INTO users(company_id,name,role) VALUES (2,'Unprepared Demo User','staff')").run().lastInsertRowid);
  const userId = Number(db.prepare("INSERT INTO users(company_id,name,role) VALUES (2,'Another Demo Reviewer','accountant')").run().lastInsertRowid);
  const gstinId = db.prepare('SELECT id FROM gstins WHERE company_id=2').get().id;
  const branchId = db.prepare('SELECT id FROM branches WHERE company_id=2').get().id;
  db.prepare("INSERT INTO user_gstin_grants(company_id,user_id,gstin_id,reason) VALUES (2,?,?,'Test demo grant')").run(userId,gstinId);
  db.prepare("INSERT INTO user_branch_grants(company_id,user_id,branch_id,reason) VALUES (2,?,?,'Test demo grant')").run(userId,branchId);
  let accounts = (await read()).data.accounts;
  assert.ok(!accounts.some(account => account.userId === ungrantedId));
  assert.deepEqual(accounts.find(account => account.userId === userId).branches.map(branch => branch.id), [branchId]);

  const seeded = accounts.find(account => account.companyId === 1 && account.userName === 'Maya Staff');
  const removed = seeded.branches[0];
  db.prepare("UPDATE user_branch_grants SET revoked_by=?,revoked_at=CURRENT_TIMESTAMP,revoked_reason='Test revocation' WHERE user_id=? AND branch_id=? AND revoked_at IS NULL").run(
    db.prepare("SELECT id FROM users WHERE company_id=1 AND role='admin'").get().id, seeded.userId, removed.id);
  accounts = (await read()).data.accounts;
  assert.ok(!accounts.find(account => account.userId === seeded.userId).branches.some(branch => branch.id === removed.id));

  db.prepare("UPDATE user_gstin_grants SET revoked_by=?,revoked_at=CURRENT_TIMESTAMP,revoked_reason='Test revocation' WHERE user_id=? AND gstin_id=? AND revoked_at IS NULL").run(
    db.prepare("SELECT id FROM users WHERE company_id=1 AND role='admin'").get().id, seeded.userId, removed.gstinId);
  accounts = (await read()).data.accounts;
  const after = accounts.find(account => account.userId === seeded.userId);
  assert.ok(!after.gstins.some(gstin => gstin.id === removed.gstinId));
  assert.ok(!after.branches.some(branch => branch.gstinId === removed.gstinId));
});

test('production mode never exposes chooser identities or accepts demo selection headers', async t => {
  const { read } = await fixture(t, 'production');
  const response = await read({ 'x-company-id': '1', 'x-user-id': '3' });
  assert.equal(response.status, 403);
  assert.deepEqual(response.data, { demoMode: false, error: 'Demo accounts are unavailable in production mode' });
  assert.equal(response.cacheControl, 'no-store');
});
