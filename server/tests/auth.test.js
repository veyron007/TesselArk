import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const DEMO_TEST_PASSPHRASE = ['correct', 'horse', 'battery', 'staple'].join(' ');
const ALT_TEST_PASSPHRASE = ['a', 'different', 'sufficiently', 'long', 'passphrase'].join(' ');
const INCORRECT_TEST_PASSPHRASE = ['incorrect', 'password'].join(' ');
const WRONG_TEST_PASSPHRASE = ['wrong', 'password'].join(' ');
const { createApp } = require('../api.cjs');
const { openDatabase } = require('../db.cjs');
const { provisionCredential } = require('../auth.cjs');

async function fixture(t, authOptions = {}) {
  const db = openDatabase(':memory:');
  const server = createApp({ db, authMode: 'production', authOptions: { secureCookies: false, ...authOptions } }).listen(0);
  t.after(() => { server.close(); db.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = async (method, path, { body, cookie, csrf, headers = {} } = {}) => {
    const response = await fetch(base + path, {
      method,
      headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(cookie ? { cookie } : {}), ...(csrf ? { 'x-csrf-token': csrf } : {}), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, data: await response.json(), cookie: response.headers.get('set-cookie'), headers: response.headers };
  };
  return { db, request };
}

async function login(request, email, password) {
  const result = await request('POST', '/api/auth/login', { body: { email, password } });
  return { ...result, sessionCookie: result.cookie?.split(';')[0] };
}

test('production mode requires a provisioned credential and never trusts demo headers', async t => {
  const { db, request } = await fixture(t);
  const unauthenticated = await request('GET', '/api/bootstrap', { headers: { 'x-user-id': '3', 'x-company-id': '2' } });
  assert.equal(unauthenticated.status, 401);
  assert.equal(unauthenticated.headers.get('x-powered-by'), null);
  assert.equal(unauthenticated.headers.get('x-frame-options'), 'DENY');
  assert.equal(unauthenticated.headers.get('strict-transport-security'), 'max-age=31536000');
  assert.match(unauthenticated.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.equal((await login(request, 'maya@example.test', DEMO_TEST_PASSPHRASE)).status, 401);
  provisionCredential(db, { userId: 1, email: 'maya@example.test', password: DEMO_TEST_PASSPHRASE });
  assert.equal((await login(request, 'maya@example.test', WRONG_TEST_PASSPHRASE)).status, 401);
  const auth = await login(request, 'maya@example.test', DEMO_TEST_PASSPHRASE);
  assert.equal(auth.status, 200);
  assert.match(auth.cookie, /HttpOnly/);
  assert.match(auth.cookie, /SameSite=Strict/);
  const boot = await request('GET', '/api/bootstrap', { cookie: auth.sessionCookie, headers: { 'x-user-id': '3', 'x-company-id': '2' } });
  assert.equal(boot.status, 200);
  assert.equal(boot.data.demoMode, false);
  assert.equal(boot.data.currentCompanyId, 1);
  assert.equal(boot.data.currentUserId, 1);
  assert.deepEqual(boot.data.companies.map(row => row.id), [1]);
  assert.deepEqual(boot.data.users.map(row => row.id), [1]);
  assert.equal((await request('GET', '/api/items', { cookie: auth.sessionCookie, headers: { 'x-user-id': '3', 'x-company-id': '2' } })).status, 200);
  assert.equal((await request('GET', '/api/access/grants', { cookie: auth.sessionCookie, headers: { 'x-user-id': '3' } })).status, 403);
});

test('mutations require CSRF, reject foreign origins, and logout revokes the session', async t => {
  const { db, request } = await fixture(t);
  provisionCredential(db, { userId: 1, email: 'maya@example.test', password: DEMO_TEST_PASSPHRASE });
  const auth = await login(request, 'maya@example.test', DEMO_TEST_PASSPHRASE);
  const body = { name: 'CSRF test supplier' };
  assert.equal((await request('POST', '/api/parties', { cookie: auth.sessionCookie, body })).status, 403);
  assert.equal((await request('POST', '/api/parties', { cookie: auth.sessionCookie, csrf: auth.data.csrfToken, body, headers: { origin: 'https://evil.example' } })).status, 403);
  assert.equal((await request('POST', '/api/parties', { cookie: auth.sessionCookie, csrf: auth.data.csrfToken, body })).status, 200);
  const session = await request('GET', '/api/auth/session', { cookie: auth.sessionCookie });
  assert.equal(session.status, 200);
  assert.equal(session.data.user.id, 1);
  assert.equal(session.data.csrfToken, auth.data.csrfToken);
  assert.equal((await request('POST', '/api/parties', { cookie: auth.sessionCookie, csrf: auth.data.csrfToken, body })).status, 200);
  assert.equal((await request('POST', '/api/auth/logout', { cookie: auth.sessionCookie, csrf: session.data.csrfToken })).status, 200);
  assert.equal((await request('GET', '/api/bootstrap', { cookie: auth.sessionCookie })).status, 401);
});

test('production session applies live company, GSTIN, and branch grants', async t => {
  const { db, request } = await fixture(t);
  provisionCredential(db, { userId: 1, email: 'maya@example.test', password: DEMO_TEST_PASSPHRASE });
  const auth = await login(request, 'maya@example.test', DEMO_TEST_PASSPHRASE);
  db.prepare("UPDATE user_branch_grants SET revoked_by=3,revoked_at=CURRENT_TIMESTAMP,revoked_reason='Auth test' WHERE company_id=1 AND user_id=1 AND branch_id=1 AND revoked_at IS NULL").run();
  db.prepare("UPDATE user_gstin_grants SET revoked_by=3,revoked_at=CURRENT_TIMESTAMP,revoked_reason='Auth test' WHERE company_id=1 AND user_id=1 AND gstin_id=2 AND revoked_at IS NULL").run();
  assert.equal((await request('GET', '/api/stock?branchId=1', { cookie: auth.sessionCookie })).status, 403);
  assert.equal((await request('GET', '/api/stock?branchId=3', { cookie: auth.sessionCookie })).status, 403);
  const boot = await request('GET', '/api/bootstrap', { cookie: auth.sessionCookie });
  assert.deepEqual(boot.data.companies[0].branches.map(row => row.id), [2]);
  assert.deepEqual(boot.data.companies[0].gstins.map(row => row.id), [1]);
});

test('password reprovisioning revokes sessions and login attempts are limited', async t => {
  const { db, request } = await fixture(t);
  provisionCredential(db, { userId: 1, email: 'maya@example.test', password: DEMO_TEST_PASSPHRASE });
  const auth = await login(request, 'maya@example.test', DEMO_TEST_PASSPHRASE);
  provisionCredential(db, { userId: 1, email: 'maya@example.test', password: ALT_TEST_PASSPHRASE });
  assert.equal((await request('GET', '/api/bootstrap', { cookie: auth.sessionCookie })).status, 401);
  for (let i = 0; i < 5; i += 1) assert.equal((await login(request, 'maya@example.test', 'bad')).status, 401);
  assert.equal((await login(request, 'maya@example.test', ALT_TEST_PASSPHRASE)).status, 429);
});

test('sessions expire and production cookies are Secure by default', async t => {
  let clock = Date.now();
  const db = openDatabase(':memory:');
  const server = createApp({ db, authMode: 'production', authOptions: { now: () => clock } }).listen(0);
  t.after(() => { server.close(); db.close(); });
  provisionCredential(db, { userId: 1, email: 'maya@example.test', password: DEMO_TEST_PASSPHRASE });
  const base = `http://127.0.0.1:${server.address().port}`;
  const insecureOrigin = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json', origin: base }, body: JSON.stringify({ email: 'maya@example.test', password: DEMO_TEST_PASSPHRASE }) });
  assert.equal(insecureOrigin.status, 403);
  const response = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'maya@example.test', password: DEMO_TEST_PASSPHRASE }) });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('set-cookie'), /^__Host-erp_session=/);
  assert.match(response.headers.get('set-cookie'), /Secure/);
  const cookie = response.headers.get('set-cookie').split(';')[0];
  clock += 8 * 60 * 60 * 1000;
  const expired = await fetch(`${base}/api/bootstrap`, { headers: { cookie } });
  assert.equal(expired.status, 401);
});

test('environment-only provisioning command writes a hash to an isolated database', t => {
  const dir = mkdtempSync(join(tmpdir(), 'erp-auth-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const dbPath = join(dir, 'erp.sqlite');
  const output = execFileSync(process.execPath, [fileURLToPath(new URL('../auth-provision.cjs', import.meta.url))], {
    encoding: 'utf8',
    env: { ...process.env, ERP_DB_PATH: dbPath, ERP_AUTH_USER_ID: '1', ERP_AUTH_EMAIL: 'maya@example.test', ERP_AUTH_PASSWORD: DEMO_TEST_PASSPHRASE },
  });
  assert.match(output, /Credential provisioned/);
  assert.doesNotMatch(output, /correct horse battery staple/);
  const db = openDatabase(dbPath);
  try {
    const row = db.prepare('SELECT email,password_hash FROM auth_credentials WHERE user_id=1').get();
    assert.equal(row.email, 'maya@example.test');
    assert.match(row.password_hash, /^scrypt\$/);
    assert.doesNotMatch(row.password_hash, /correct horse battery staple/);
  } finally { db.close(); }
});

test('secure-cookie mode accepts same-origin HTTPS mutations and rejects cross-site metadata', async t => {
  const db = openDatabase(':memory:');
  const server = createApp({ db, authMode: 'production' }).listen(0);
  t.after(() => { server.close(); db.close(); });
  provisionCredential(db, { userId: 1, email: 'maya@example.test', password: DEMO_TEST_PASSPHRASE });
  const base = `http://127.0.0.1:${server.address().port}`;
  const origin = `https://127.0.0.1:${server.address().port}`;
  const loginResponse = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json', origin }, body: JSON.stringify({ email: 'maya@example.test', password: DEMO_TEST_PASSPHRASE }) });
  assert.equal(loginResponse.status, 200);
  const { csrfToken } = await loginResponse.json();
  const cookie = loginResponse.headers.get('set-cookie').split(';')[0];
  const body = JSON.stringify({ name: 'Secure origin supplier' });
  const mutation = headers => fetch(`${base}/api/parties`, { method: 'POST', headers: { 'content-type': 'application/json', cookie, 'x-csrf-token': csrfToken, ...headers }, body });
  assert.equal((await mutation({ origin: 'https://evil.example' })).status, 403);
  assert.equal((await mutation({ origin, 'sec-fetch-site': 'cross-site' })).status, 403);
  assert.equal((await mutation({ origin: 'http://127.0.0.1:' + server.address().port })).status, 403);
  assert.equal((await mutation({ origin, 'sec-fetch-site': 'same-origin' })).status, 200);
});

test('trusted proxy IP uses the appended client address for login limits', async t => {
  const { db, request } = await fixture(t, { trustedProxyIps: '127.0.0.1' });
  provisionCredential(db, { userId: 1, email: 'maya@example.test', password: DEMO_TEST_PASSPHRASE });
  for (let i = 0; i < 20; i += 1) {
    const attempt = await request('POST', '/api/auth/login', {
      body: { email: `unknown${i}@example.test`, password: INCORRECT_TEST_PASSPHRASE },
      headers: { 'x-forwarded-for': '203.0.113.99, 198.51.100.1' },
    });
    assert.equal(attempt.status, 401);
  }
  assert.equal((await request('POST', '/api/auth/login', {
    body: { email: 'another@example.test', password: INCORRECT_TEST_PASSPHRASE },
    headers: { 'x-forwarded-for': '198.51.100.1' },
  })).status, 429);
  assert.equal((await request('POST', '/api/auth/login', {
    body: { email: 'maya@example.test', password: DEMO_TEST_PASSPHRASE },
    headers: { 'x-forwarded-for': '198.51.100.2' },
  })).status, 200);
});

test('runtime server refuses an implicit demo mode before opening a database', t => {
  const dir = mkdtempSync(join(tmpdir(), 'erp-auth-start-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const dbPath = join(dir, 'erp.sqlite');
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('../index.js', import.meta.url))], {
    encoding: 'utf8', env: { ...process.env, ERP_AUTH_MODE: '', ERP_DB_PATH: dbPath }, timeout: 5000,
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Set ERP_AUTH_MODE=demo or ERP_AUTH_MODE=production/);
  assert.equal(existsSync(dbPath), false);
  const exposed = spawnSync(process.execPath, [fileURLToPath(new URL('../index.js', import.meta.url))], {
    encoding: 'utf8', env: { ...process.env, ERP_AUTH_MODE: 'production', ERP_HOST: '0.0.0.0', ERP_DB_PATH: dbPath }, timeout: 5000,
  });
  assert.notEqual(exposed.status, 0);
  assert.match(exposed.stderr, /ERP API may only bind to loopback/);
  assert.equal(existsSync(dbPath), false);
});

test('login removes expired attempt rows in bounded batches', async t => {
  const timestamp = Date.now();
  const { db, request } = await fixture(t, { now: () => timestamp });
  provisionCredential(db, { userId: 1, email: 'maya@example.test', password: DEMO_TEST_PASSPHRASE });
  const insert = db.prepare('INSERT INTO auth_login_attempts(key_hash,attempts,reset_at) VALUES (?,1,?)');
  for (let i = 0; i < 150; i += 1) insert.run(`expired-${i}`, timestamp - 1);
  assert.equal((await login(request, 'maya@example.test', DEMO_TEST_PASSPHRASE)).status, 200);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM auth_login_attempts WHERE reset_at<=?').get(timestamp).n, 50);
  assert.equal((await login(request, 'maya@example.test', DEMO_TEST_PASSPHRASE)).status, 200);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM auth_login_attempts WHERE reset_at<=?').get(timestamp).n, 0);
});
