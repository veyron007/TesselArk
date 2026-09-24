const crypto = require('node:crypto');
const net = require('node:net');

const SESSION_SECONDS = 8 * 60 * 60;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const unsafe = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const fail = (message, status) => Object.assign(new Error(message), { status });
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
const token = () => crypto.randomBytes(32).toString('hex');
const csrfFor = sessionToken => crypto.createHmac('sha256', Buffer.from(sessionToken, 'hex')).update('erp-csrf-v1').digest('hex');
const normalizeIp = value => value?.startsWith('::ffff:') && net.isIP(value.slice(7)) === 4 ? value.slice(7) : value;

function installAuthSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS auth_credentials (
      user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS auth_sessions (
      token_hash TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      csrf_hash TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      revoked_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_auth_sessions_user ON auth_sessions(user_id,revoked_at,expires_at);
    CREATE TABLE IF NOT EXISTS auth_login_attempts (
      key_hash TEXT PRIMARY KEY,
      attempts INTEGER NOT NULL,
      reset_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_auth_login_attempts_reset ON auth_login_attempts(reset_at);
  `);
}

function normalizeEmail(value) {
  if (typeof value !== 'string' || value.length > 254) throw fail('Invalid email', 400);
  const email = value.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw fail('Invalid email', 400);
  return email;
}

function validatePassword(value, provisioning = false) {
  if (typeof value !== 'string' || value.length > 1024 || value.length < (provisioning ? 12 : 1)) {
    throw fail(provisioning ? 'Password must be 12 to 1024 characters' : 'Invalid credentials', provisioning ? 400 : 401);
  }
  return value;
}

function passwordHash(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1, maxmem: 32 * 1024 * 1024 });
  return `scrypt$16384$8$1$${salt.toString('hex')}$${hash.toString('hex')}`;
}

function verifyPassword(password, stored) {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt' || parts[1] !== '16384' || parts[2] !== '8' || parts[3] !== '1' || !/^[a-f0-9]{32}$/.test(parts[4]) || !/^[a-f0-9]{128}$/.test(parts[5])) return false;
  const expected = Buffer.from(parts[5], 'hex');
  const actual = crypto.scryptSync(password, Buffer.from(parts[4], 'hex'), expected.length, { N: 16384, r: 8, p: 1, maxmem: 32 * 1024 * 1024 });
  return crypto.timingSafeEqual(actual, expected);
}

function provisionCredential(db, { userId, email, password }) {
  installAuthSchema(db);
  if (!Number.isSafeInteger(userId) || userId < 1 || !db.prepare('SELECT 1 FROM users WHERE id=?').get(userId)) throw fail('Existing user ID required', 400);
  const normalized = normalizeEmail(email);
  const hash = passwordHash(validatePassword(password, true));
  const timestamp = Date.now();
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare(`INSERT INTO auth_credentials(user_id,email,password_hash,updated_at) VALUES (?,?,?,?)
      ON CONFLICT(user_id) DO UPDATE SET email=excluded.email,password_hash=excluded.password_hash,updated_at=excluded.updated_at`)
      .run(userId, normalized, hash, timestamp);
    db.prepare('UPDATE auth_sessions SET revoked_at=? WHERE user_id=? AND revoked_at IS NULL').run(timestamp, userId);
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}

function cookieValue(req, cookieName) {
  const header = req.headers.cookie;
  if (typeof header !== 'string' || header.length > 8192) return null;
  const cookies = header.split(';').map(part => part.trim()).filter(part => part.startsWith(`${cookieName}=`));
  if (cookies.length !== 1) return null;
  const value = cookies[0].slice(cookieName.length + 1);
  return /^[a-f0-9]{64}$/.test(value) ? value : null;
}

function checkOrigin(req) {
  if (req.headers['sec-fetch-site'] && !['same-origin', 'none'].includes(req.headers['sec-fetch-site'])) throw fail('Cross-origin request denied', 403);
  if (!req.headers.origin) return;
  let origin;
  try { origin = new URL(req.headers.origin); } catch { throw fail('Invalid request origin', 403); }
  if (!['http:', 'https:'].includes(origin.protocol) || origin.host !== req.headers.host || origin.username || origin.password) throw fail('Cross-origin request denied', 403);
}

function createAuth(db, { secureCookies = true, now = Date.now, trustedProxyIps = '' } = {}) {
  installAuthSchema(db);
  const apiWindows = new Map();
  const trustedPeers = new Set((Array.isArray(trustedProxyIps) ? trustedProxyIps : String(trustedProxyIps).split(','))
    .map(value => normalizeIp(value.trim())).filter(Boolean));
  if ([...trustedPeers].some(value => !net.isIP(value))) throw new Error('ERP_AUTH_TRUSTED_PROXY_IPS must contain numeric IP addresses');
  const cookieName = secureCookies ? '__Host-erp_session' : 'erp_session';
  const cookie = (value, maxAge) => `${cookieName}=${value}; Path=/; HttpOnly; SameSite=Strict; ${secureCookies ? 'Secure; ' : ''}Max-Age=${maxAge}`;
  const handle = action => (req, res, next) => { try { action(req, res); } catch (error) { next(error); } };
  const clientIp = req => {
    const peer = normalizeIp(req.socket.remoteAddress) || 'unknown';
    if (!trustedPeers.has(peer)) return peer;
    const header = req.headers['x-forwarded-for'];
    const forwarded = typeof header === 'string' ? normalizeIp(header.split(',').at(-1).trim()) : null;
    return forwarded && net.isIP(forwarded) ? forwarded : peer;
  };

  function consumeAttempt(key, limit) {
    const keyHash = sha256(key);
    const current = db.prepare('SELECT attempts,reset_at FROM auth_login_attempts WHERE key_hash=?').get(keyHash);
    const timestamp = now();
    if (!current || current.reset_at <= timestamp) {
      db.prepare('INSERT INTO auth_login_attempts(key_hash,attempts,reset_at) VALUES (?,1,?) ON CONFLICT(key_hash) DO UPDATE SET attempts=1,reset_at=excluded.reset_at')
        .run(keyHash, timestamp + LOGIN_WINDOW_MS);
      return;
    }
    if (current.attempts >= limit) throw fail('Too many login attempts. Try again later.', 429);
    db.prepare('UPDATE auth_login_attempts SET attempts=attempts+1 WHERE key_hash=?').run(keyHash);
  }

  function sessionFor(req) {
    const value = cookieValue(req, cookieName);
    if (!value) throw fail('Authentication required', 401);
    const row = db.prepare(`SELECT s.token_hash,s.user_id,s.csrf_hash,u.company_id
      FROM auth_sessions s JOIN users u ON u.id=s.user_id
      JOIN auth_credentials c ON c.user_id=u.id
      WHERE s.token_hash=? AND s.revoked_at IS NULL AND s.expires_at>?`).get(sha256(value), now());
    if (!row) throw fail('Authentication required', 401);
    return row;
  }

  function requireCsrf(req, session) {
    checkOrigin(req);
    if (secureCookies && req.headers.origin && new URL(req.headers.origin).protocol !== 'https:') throw fail('HTTPS origin required', 403);
    const supplied = req.header('x-csrf-token');
    if (typeof supplied !== 'string' || !/^[a-f0-9]{64}$/.test(supplied)) throw fail('CSRF token required', 403);
    const expected = Buffer.from(session.csrf_hash, 'hex');
    const actual = Buffer.from(sha256(supplied), 'hex');
    if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) throw fail('Invalid CSRF token', 403);
  }

  function apiLimiter(req, res, next) {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    const key = clientIp(req);
    const timestamp = now();
    const bucket = apiWindows.get(key);
    if (bucket && bucket.resetAt > timestamp && bucket.count >= 300) return next(fail('Too many requests', 429));
    if (!bucket || bucket.resetAt <= timestamp) apiWindows.set(key, { count: 1, resetAt: timestamp + 60_000 });
    else bucket.count += 1;
    if (apiWindows.size > 10_000) apiWindows.delete(apiWindows.keys().next().value);
    next();
  }

  function registerRoutes(app) {
    app.post('/api/auth/login', handle((req, res) => {
      checkOrigin(req);
      if (secureCookies && req.headers.origin && new URL(req.headers.origin).protocol !== 'https:') throw fail('HTTPS origin required', 403);
      if (!req.is('application/json')) throw fail('JSON body required', 415);
      const email = normalizeEmail(req.body?.email);
      const password = validatePassword(req.body?.password);
      db.prepare(`DELETE FROM auth_login_attempts WHERE key_hash IN (
        SELECT key_hash FROM auth_login_attempts WHERE reset_at<=? ORDER BY reset_at LIMIT 100
      )`).run(now());
      const ip = clientIp(req);
      consumeAttempt(`ip:${ip}`, 20);
      consumeAttempt(`email:${email}`, 6);
      const credential = db.prepare('SELECT user_id,password_hash FROM auth_credentials WHERE email=?').get(email);
      // Run the same password derivation for unknown accounts.
      const dummy = 'scrypt$16384$8$1$00000000000000000000000000000000$' + '0'.repeat(128);
      if (!verifyPassword(password, credential?.password_hash || dummy) || !credential) throw fail('Invalid credentials', 401);
      const sessionToken = token();
      const csrfToken = csrfFor(sessionToken);
      const timestamp = now();
      db.prepare('DELETE FROM auth_sessions WHERE expires_at<=? OR revoked_at IS NOT NULL').run(timestamp);
      db.prepare('INSERT INTO auth_sessions(token_hash,user_id,csrf_hash,created_at,expires_at) VALUES (?,?,?,?,?)')
        .run(sha256(sessionToken), credential.user_id, sha256(csrfToken), timestamp, timestamp + SESSION_SECONDS * 1000);
      res.setHeader('Set-Cookie', cookie(sessionToken, SESSION_SECONDS));
      res.json({ csrfToken, expiresAt: timestamp + SESSION_SECONDS * 1000 });
    }));

    app.get('/api/auth/session', handle((req, res) => {
      const session = sessionFor(req);
      const csrfToken = csrfFor(cookieValue(req, cookieName));
      if (sha256(csrfToken) !== session.csrf_hash) throw fail('Authentication required', 401);
      const user = db.prepare('SELECT id,company_id,name,role FROM users WHERE id=?').get(session.user_id);
      res.json({ user: { id: user.id, companyId: user.company_id, name: user.name, role: user.role }, csrfToken });
    }));

    app.post('/api/auth/logout', handle((req, res) => {
      const session = sessionFor(req);
      requireCsrf(req, session);
      db.prepare('UPDATE auth_sessions SET revoked_at=? WHERE token_hash=?').run(now(), session.token_hash);
      res.setHeader('Set-Cookie', cookie('', 0));
      res.json({ success: true });
    }));
  }

  function authenticate(req, _res, next) {
    try {
      const session = sessionFor(req);
      if (unsafe.has(req.method)) requireCsrf(req, session);
      req.authIdentity = { userId: session.user_id, companyId: session.company_id };
      next();
    } catch (error) { next(error); }
  }

  return { apiLimiter, registerRoutes, authenticate };
}

module.exports = { createAuth, installAuthSchema, provisionCredential };
