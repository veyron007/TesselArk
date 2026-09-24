const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { DatabaseSync, backup } = require('node:sqlite');
const { runMigrations } = require('./migrations.cjs');

function resolvedFile(file) {
  if (!file || file === ':memory:') throw new Error('An explicit SQLite file path is required');
  return path.resolve(file);
}

function existingFile(file) {
  const absolute = resolvedFile(file);
  const stat = fs.lstatSync(absolute);
  if (!stat.isFile()) throw new Error(`Expected a regular, non-symlink SQLite file: ${absolute}`);
  return absolute;
}

function assertNoSidecars(file) {
  for (const suffix of ['-wal', '-shm', '-journal']) {
    if (fs.existsSync(file + suffix)) throw new Error(`Database sidecar exists: ${file + suffix}. Stop the server and checkpoint it before restore or migration.`);
  }
}

function assertHealthy(db) {
  const integrity = db.prepare('PRAGMA integrity_check').all();
  if (integrity.length !== 1 || integrity[0].integrity_check !== 'ok') {
    throw new Error(`SQLite integrity_check failed: ${JSON.stringify(integrity)}`);
  }
  const violations = db.prepare('PRAGMA foreign_key_check').all();
  if (violations.length) throw new Error(`SQLite foreign_key_check failed: ${JSON.stringify(violations.slice(0, 5))}`);
}

function checkFile(file) {
  const absolute = existingFile(file);
  const db = new DatabaseSync(absolute);
  let logicalBytes;
  try {
    db.exec('PRAGMA query_only = ON');
    assertHealthy(db);
    logicalBytes = db.prepare('PRAGMA page_count').get().page_count * db.prepare('PRAGMA page_size').get().page_size;
  } finally {
    db.close();
  }
  return { file: absolute, logicalBytes };
}

function syncFile(file) {
  const fd = fs.openSync(file, 'r');
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

function syncDirectory(directory) {
  const fd = fs.openSync(directory, 'r');
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

function temporaryFile(target) {
  return path.join(path.dirname(target), `.${path.basename(target)}.${randomUUID()}.tmp`);
}

async function backupFile(source, output) {
  const from = existingFile(source);
  const to = resolvedFile(output);
  if (from === to) throw new Error('Source and backup paths must differ');
  if (fs.existsSync(to)) throw new Error(`Backup already exists: ${to}`);
  const directory = path.dirname(to);
  if (!fs.statSync(directory).isDirectory()) throw new Error(`Not a directory: ${directory}`);
  const stage = temporaryFile(to);
  let db;
  try {
    db = new DatabaseSync(from);
    db.exec('PRAGMA query_only = ON');
    assertHealthy(db);
    await backup(db, stage);
    db.close();
    db = undefined;
    checkFile(stage);
    fs.chmodSync(stage, 0o600);
    syncFile(stage);
    fs.linkSync(stage, to); // Atomic no-clobber publication in the destination directory.
    syncDirectory(directory);
    return checkFile(to);
  } finally {
    if (db) db.close();
    fs.rmSync(stage, { force: true });
  }
}

async function restoreFile(source, destination, { replace = false, offline = false, recoveryFile } = {}) {
  if (!offline) throw new Error('Restore requires --offline after stopping the ERP server');
  const from = existingFile(source);
  const to = resolvedFile(destination);
  if (from === to) throw new Error('Source and destination paths must differ');
  checkFile(from);
  const exists = fs.existsSync(to);
  if (exists && !replace) throw new Error('Destination exists; restore requires --replace and --recovery');
  if (exists && !recoveryFile) throw new Error('Replacing a database requires a separate recovery backup path');
  if (exists) {
    existingFile(to);
    assertNoSidecars(to);
  }
  if (!fs.statSync(path.dirname(to)).isDirectory()) throw new Error('Destination directory does not exist');
  const recovery = recoveryFile && resolvedFile(recoveryFile);
  if (recovery && (recovery === from || recovery === to)) throw new Error('Recovery path must be distinct');
  const before = exists ? fs.lstatSync(to, { bigint: true }) : null;
  if (exists) await backupFile(to, recovery);
  const stage = temporaryFile(to);
  try {
    await backupFile(from, stage);
    if (exists) {
      const after = fs.lstatSync(to, { bigint: true });
      if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeNs !== after.mtimeNs) {
        throw new Error('Destination changed during restore; recovery backup preserved');
      }
      assertNoSidecars(to);
      fs.renameSync(stage, to); // Atomic replacement on the same filesystem.
    } else {
      fs.linkSync(stage, to); // Atomic create without overwriting a concurrent file.
    }
    syncDirectory(path.dirname(to));
    return { restored: checkFile(to), recoveryFile: recovery || null };
  } finally {
    fs.rmSync(stage, { force: true });
  }
}

async function migrateFile(file, { backupPath, offline = false } = {}) {
  if (!offline) throw new Error('Migration requires --offline after stopping the ERP server');
  const target = existingFile(file);
  assertNoSidecars(target);
  if (!backupPath) throw new Error('Migration requires a separate --backup path');
  await backupFile(target, backupPath);
  const db = new DatabaseSync(target);
  try {
    db.exec('PRAGMA foreign_keys = ON');
    assertHealthy(db);
    const applied = runMigrations(db);
    assertHealthy(db);
    return { applied, backupPath: path.resolve(backupPath) };
  } finally {
    db.close();
  }
}

module.exports = { backupFile, restoreFile, migrateFile, checkFile, assertHealthy };
