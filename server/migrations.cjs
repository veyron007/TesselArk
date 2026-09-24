const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');

const migrationFiles = ['001-baseline.cjs'];
const directory = path.join(__dirname, 'migrations');

function availableMigrations() {
  return migrationFiles.map(file => ({
    ...require(path.join(directory, file)),
    checksum: createHash('sha256').update(fs.readFileSync(path.join(directory, file))).digest('hex'),
  }));
}

function runMigrations(db, migrations = availableMigrations()) {
  const ids = new Set();
  for (const migration of migrations) {
    if (!/^\d{3}-[a-z0-9-]+$/.test(migration.id) || ids.has(migration.id) ||
        !/^[a-f0-9]{64}$/.test(migration.checksum) || typeof migration.up !== 'function') {
      throw new Error('Invalid migration manifest');
    }
    ids.add(migration.id);
  }
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    id TEXT PRIMARY KEY,
    checksum TEXT NOT NULL,
    applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`);
  const applied = db.prepare('SELECT id, checksum FROM schema_migrations ORDER BY id').all();
  for (const row of applied) {
    const known = migrations.find(migration => migration.id === row.id);
    if (!known || known.checksum !== row.checksum) {
      throw new Error(`Unknown or changed migration: ${row.id}`);
    }
  }
  const appliedIds = new Set(applied.map(row => row.id));
  let pendingStarted = false;
  for (const migration of migrations) {
    if (!appliedIds.has(migration.id)) pendingStarted = true;
    else if (pendingStarted) throw new Error(`Migration gap before ${migration.id}`);
  }
  const pending = migrations.filter(migration => !appliedIds.has(migration.id));
  for (const migration of pending) {
    db.exec('BEGIN IMMEDIATE');
    try {
      migration.up(db);
      db.prepare('INSERT INTO schema_migrations(id, checksum) VALUES (?, ?)')
        .run(migration.id, migration.checksum);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
  return pending.map(migration => migration.id);
}

module.exports = { availableMigrations, runMigrations };
