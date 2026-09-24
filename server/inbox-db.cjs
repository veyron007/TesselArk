function installInboxSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS inbox_user_state (
      company_id INTEGER NOT NULL REFERENCES companies(id),
      user_id INTEGER NOT NULL REFERENCES users(id),
      source_type TEXT NOT NULL CHECK(source_type IN ('crm','invoice','expense','cashier')),
      source_id INTEGER NOT NULL,
      acknowledged_revision TEXT,
      acknowledged_at TEXT,
      snoozed_revision TEXT,
      snoozed_until TEXT,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY(company_id,user_id,source_type,source_id)
    );
    CREATE TABLE IF NOT EXISTS inbox_escalation_policies (
      id INTEGER PRIMARY KEY,
      company_id INTEGER NOT NULL REFERENCES companies(id),
      source_type TEXT NOT NULL CHECK(source_type IN ('crm','invoice','expense','cashier')),
      overdue_days INTEGER NOT NULL CHECK(overdue_days BETWEEN 0 AND 365),
      blocker_allowed INTEGER NOT NULL CHECK(blocker_allowed IN (0,1)),
      reason TEXT NOT NULL,
      approved_by INTEGER NOT NULL REFERENCES users(id),
      approved_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      revoked_by INTEGER REFERENCES users(id),
      revoked_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_inbox_active_policy ON inbox_escalation_policies(company_id,source_type,revoked_at,id);
    CREATE TABLE IF NOT EXISTS inbox_escalations (
      id INTEGER PRIMARY KEY,
      company_id INTEGER NOT NULL REFERENCES companies(id),
      source_type TEXT NOT NULL CHECK(source_type IN ('crm','invoice','expense','cashier')),
      source_id INTEGER NOT NULL,
      source_revision TEXT NOT NULL,
      policy_id INTEGER NOT NULL REFERENCES inbox_escalation_policies(id),
      target_user_id INTEGER NOT NULL REFERENCES users(id),
      reason TEXT NOT NULL,
      escalated_by INTEGER NOT NULL REFERENCES users(id),
      escalated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(company_id,source_type,source_id,source_revision)
    );
  `);
}

module.exports = { installInboxSchema };
