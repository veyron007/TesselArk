function installAccessSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS access_seed_state (
      key TEXT PRIMARY KEY,
      completed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS user_gstin_grants (
      id INTEGER PRIMARY KEY,
      company_id INTEGER NOT NULL REFERENCES companies(id),
      user_id INTEGER NOT NULL REFERENCES users(id),
      gstin_id INTEGER NOT NULL REFERENCES gstins(id),
      granted_by INTEGER REFERENCES users(id),
      reason TEXT NOT NULL,
      granted_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      revoked_by INTEGER REFERENCES users(id),
      revoked_at TEXT,
      revoked_reason TEXT,
      CHECK ((revoked_at IS NULL AND revoked_by IS NULL AND revoked_reason IS NULL) OR
        (revoked_at IS NOT NULL AND revoked_by IS NOT NULL AND revoked_reason IS NOT NULL))
    );
    CREATE UNIQUE INDEX IF NOT EXISTS uq_active_gstin_grant
      ON user_gstin_grants(company_id,user_id,gstin_id) WHERE revoked_at IS NULL;
    CREATE INDEX IF NOT EXISTS idx_gstin_grants_user ON user_gstin_grants(user_id,company_id,revoked_at);
    CREATE TABLE IF NOT EXISTS user_branch_grants (
      id INTEGER PRIMARY KEY,
      company_id INTEGER NOT NULL REFERENCES companies(id),
      user_id INTEGER NOT NULL REFERENCES users(id),
      branch_id INTEGER NOT NULL REFERENCES branches(id),
      granted_by INTEGER REFERENCES users(id),
      reason TEXT NOT NULL,
      granted_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      revoked_by INTEGER REFERENCES users(id),
      revoked_at TEXT,
      revoked_reason TEXT,
      CHECK ((revoked_at IS NULL AND revoked_by IS NULL AND revoked_reason IS NULL) OR
        (revoked_at IS NOT NULL AND revoked_by IS NOT NULL AND revoked_reason IS NOT NULL))
    );
    CREATE UNIQUE INDEX IF NOT EXISTS uq_active_branch_grant
      ON user_branch_grants(company_id,user_id,branch_id) WHERE revoked_at IS NULL;
    CREATE INDEX IF NOT EXISTS idx_branch_grants_user ON user_branch_grants(user_id,company_id,revoked_at);
    CREATE TABLE IF NOT EXISTS access_events (
      id INTEGER PRIMARY KEY,
      company_id INTEGER NOT NULL REFERENCES companies(id),
      user_id INTEGER NOT NULL REFERENCES users(id),
      actor_id INTEGER REFERENCES users(id),
      scope_type TEXT NOT NULL CHECK(scope_type IN ('gstin','branch')),
      scope_id INTEGER NOT NULL,
      action TEXT NOT NULL CHECK(action IN ('grant','revoke')),
      reason TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_access_events_user ON access_events(company_id,user_id,id);
  `);
}

function seedDemoGrants(db) {
  db.exec('SAVEPOINT seed_demo_grants');
  try {
    if (db.prepare("SELECT 1 FROM access_seed_state WHERE key='initial_demo_grants_v1'").get()) {
      db.exec('RELEASE seed_demo_grants');
      return false;
    }
    const demoUsers = new Set([
      '1:Maya Staff:staff','1:Dev Accountant:accountant','1:Ravi Owner:admin',
      '2:Anika Staff:staff','2:Dev Services Accountant:accountant',
      '2:Aarav Services Owner:admin','3:Nila Staff:staff',
      '3:Ravi Retail Owner:admin','3:Nila Retail Accountant:accountant',
    ]);
    const users = db.prepare('SELECT id,company_id,name,role FROM users ORDER BY id').all()
      .filter(user => demoUsers.has(`${user.company_id}:${user.name}:${user.role}`));
    const registrations = db.prepare('SELECT id,company_id FROM gstins ORDER BY id').all();
    const branches = db.prepare('SELECT id,company_id FROM branches ORDER BY id').all();
    const insertGstin = db.prepare("INSERT INTO user_gstin_grants(company_id,user_id,gstin_id,reason) VALUES (?,?,?,'Initial synthetic demo scope')");
    const insertBranch = db.prepare("INSERT INTO user_branch_grants(company_id,user_id,branch_id,reason) VALUES (?,?,?,'Initial synthetic demo scope')");
    const event = db.prepare("INSERT INTO access_events(company_id,user_id,actor_id,scope_type,scope_id,action,reason) VALUES (?,?,NULL,?,?,'grant','Initial synthetic demo scope')");
    for (const user of users) {
      for (const gstin of registrations.filter(row => row.company_id === user.company_id)) {
        insertGstin.run(user.company_id,user.id,gstin.id);
        event.run(user.company_id,user.id,'gstin',gstin.id);
      }
      for (const branch of branches.filter(row => row.company_id === user.company_id)) {
        insertBranch.run(user.company_id,user.id,branch.id);
        event.run(user.company_id,user.id,'branch',branch.id);
      }
    }
    db.prepare("INSERT INTO access_seed_state(key) VALUES ('initial_demo_grants_v1')").run();
    db.exec('RELEASE seed_demo_grants');
    return true;
  } catch (error) {
    db.exec('ROLLBACK TO seed_demo_grants');
    db.exec('RELEASE seed_demo_grants');
    throw error;
  }
}

module.exports = { installAccessSchema, seedDemoGrants };
