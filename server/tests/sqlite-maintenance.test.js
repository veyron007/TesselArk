import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { openDatabase } = require('../db.cjs');
const { runMigrations } = require('../migrations.cjs');
const { backupFile, restoreFile, migrateFile, checkFile } = require('../sqlite-maintenance.cjs');

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'erp-maintenance-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = name => path.join(directory, name);
  const db = openDatabase(file('source.sqlite'));
  return { directory, file, db };
}

test('baseline records an existing isolated schema and remains unchanged on reopen', t => {
  const { file, db } = fixture(t);
  assert.deepEqual(runMigrations(db), ['001-baseline']);
  assert.deepEqual(db.prepare('SELECT id FROM schema_migrations').all().map(row => row.id), ['001-baseline']);
  const before = db.prepare('SELECT count(*) AS count FROM companies').get().count;
  db.close();
  const reopened = openDatabase(file('source.sqlite'));
  assert.deepEqual(runMigrations(reopened), []);
  assert.equal(reopened.prepare('SELECT count(*) AS count FROM companies').get().count, before);
  assert.deepEqual(reopened.prepare('SELECT id FROM schema_migrations').all().map(row => row.id), ['001-baseline']);
  reopened.close();
});

test('migration failure rolls back its SQL and rejects changed checksums', () => {
  const db = new DatabaseSync(':memory:');
  const first = { id: '001-test', checksum: 'a'.repeat(64), up: conn => conn.exec('CREATE TABLE sample(id INTEGER)') };
  assert.deepEqual(runMigrations(db, [first]), ['001-test']);
  assert.deepEqual(runMigrations(db, [first]), []);
  assert.throws(() => runMigrations(db, [{ ...first, checksum: 'b'.repeat(64) }]), /changed migration/);
  const broken = { id: '002-broken', checksum: 'c'.repeat(64), up: conn => {
    conn.exec('CREATE TABLE should_rollback(id INTEGER)');
    throw new Error('broken');
  } };
  assert.throws(() => runMigrations(db, [first, broken]), /broken/);
  assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name='should_rollback'").get(), undefined);
  assert.equal(db.prepare('SELECT count(*) AS count FROM schema_migrations').get().count, 1);
  db.close();
});

test('backup includes committed WAL rows and refuses overwrite', async t => {
  const { file, db } = fixture(t);
  db.exec("INSERT INTO companies(name,tax_regime) VALUES ('Backup snapshot marker','regular')");
  await backupFile(file('source.sqlite'), file('snapshot.sqlite'));
  const snapshot = new DatabaseSync(file('snapshot.sqlite'), { readOnly: true });
  assert.equal(snapshot.prepare("SELECT count(*) AS count FROM companies WHERE name='Backup snapshot marker'").get().count, 1);
  snapshot.close();
  assert.ok(checkFile(file('snapshot.sqlite')).logicalBytes > 0);
  assert.equal(fs.statSync(file('snapshot.sqlite')).mode & 0o777, 0o600);
  await assert.rejects(backupFile(file('source.sqlite'), file('snapshot.sqlite')), /already exists/);
  db.close();
});

test('backup rejects a foreign key violation and publishes no output', async t => {
  const { file, db } = fixture(t);
  db.close();
  const invalid = new DatabaseSync(file('source.sqlite'));
  invalid.exec('PRAGMA foreign_keys = OFF');
  invalid.prepare("INSERT INTO gstins(company_id,gstin,state_code) VALUES (9999,'99INVALID0000X0Z','99')").run();
  invalid.close();
  await assert.rejects(backupFile(file('source.sqlite'), file('invalid-backup.sqlite')), /foreign_key_check/);
  assert.equal(fs.existsSync(file('invalid-backup.sqlite')), false);
});

test('restore replaces only with offline flag and preserves previous data in recovery backup', async t => {
  const { file, db } = fixture(t);
  await backupFile(file('source.sqlite'), file('snapshot.sqlite'));
  db.exec("INSERT INTO companies(name,tax_regime) VALUES ('Later marker','regular')");
  db.close();
  await assert.rejects(restoreFile(file('snapshot.sqlite'), file('source.sqlite'), {
    replace: true, recoveryFile: file('recovery.sqlite'),
  }), /--offline/);
  await assert.rejects(restoreFile(file('snapshot.sqlite'), file('source.sqlite'), { offline: true }), /--replace/);
  await restoreFile(file('snapshot.sqlite'), file('source.sqlite'), {
    replace: true, offline: true, recoveryFile: file('recovery.sqlite'),
  });
  const restored = new DatabaseSync(file('source.sqlite'), { readOnly: true });
  const recovery = new DatabaseSync(file('recovery.sqlite'), { readOnly: true });
  assert.equal(restored.prepare("SELECT count(*) AS count FROM companies WHERE name='Later marker'").get().count, 0);
  assert.equal(recovery.prepare("SELECT count(*) AS count FROM companies WHERE name='Later marker'").get().count, 1);
  restored.close();
  recovery.close();
});

test('restore leaves destination untouched when source is corrupt or a WAL sidecar remains', async t => {
  const { file, db } = fixture(t);
  db.close();
  await backupFile(file('source.sqlite'), file('snapshot.sqlite'));
  fs.writeFileSync(file('invalid.sqlite'), 'not a SQLite file');
  const original = fs.readFileSync(file('source.sqlite'));
  await assert.rejects(restoreFile(file('invalid.sqlite'), file('source.sqlite'), {
    replace: true, offline: true, recoveryFile: file('recovery.sqlite'),
  }));
  assert.deepEqual(fs.readFileSync(file('source.sqlite')), original);
  fs.writeFileSync(file('source.sqlite-wal'), 'active');
  await assert.rejects(restoreFile(file('source.sqlite'), file('source.sqlite'), { offline: true }), /paths must differ/);
  await assert.rejects(restoreFile(file('snapshot.sqlite'), file('source.sqlite'), {
    replace: true, offline: true, recoveryFile: file('recovery.sqlite'),
  }), /sidecar exists/);
  await assert.rejects(migrateFile(file('source.sqlite'), { offline: true, backupPath: file('migration-backup.sqlite') }), /sidecar exists/);
  fs.rmSync(file('source.sqlite-wal'));
});

test('migration command takes a verified backup and requires offline mode', async t => {
  const { file, db } = fixture(t);
  db.close();
  await assert.rejects(migrateFile(file('source.sqlite'), { backupPath: file('before.sqlite') }), /--offline/);
  const result = await migrateFile(file('source.sqlite'), { backupPath: file('before.sqlite'), offline: true });
  assert.deepEqual(result.applied, ['001-baseline']);
  assert.ok(checkFile(file('before.sqlite')).logicalBytes > 0);
  const before = new DatabaseSync(file('before.sqlite'));
  const after = new DatabaseSync(file('source.sqlite'));
  assert.equal(before.prepare("SELECT name FROM sqlite_master WHERE name='schema_migrations'").get(), undefined);
  assert.equal(after.prepare('SELECT count(*) AS count FROM schema_migrations').get().count, 1);
  before.close();
  after.close();
});

test('restore can create a new isolated database without replacing another file', async t => {
  const { file, db } = fixture(t);
  db.close();
  await backupFile(file('source.sqlite'), file('snapshot.sqlite'));
  const result = await restoreFile(file('snapshot.sqlite'), file('new.sqlite'), { offline: true });
  assert.equal(result.recoveryFile, null);
  assert.ok(checkFile(file('new.sqlite')).logicalBytes > 0);
  await assert.rejects(restoreFile(file('snapshot.sqlite'), file('new.sqlite'), { offline: true }), /--replace/);
});
