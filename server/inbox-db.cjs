const { installWorkTasksSchema } = require('./work-tasks-db.cjs');

function installInboxSchema(db) {
  installWorkTasksSchema(db);
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
    CREATE TABLE IF NOT EXISTS inbox_work_task_user_state (
      company_id INTEGER NOT NULL REFERENCES companies(id),
      user_id INTEGER NOT NULL REFERENCES users(id),
      task_id INTEGER NOT NULL REFERENCES work_tasks(id) ON DELETE CASCADE,
      acknowledged_revision TEXT,
      acknowledged_at TEXT,
      snoozed_revision TEXT,
      snoozed_until TEXT,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY(company_id,user_id,task_id)
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
  const taskForeignKey=db.prepare('PRAGMA foreign_key_list(inbox_work_task_user_state)').all()
    .some(row=>row.table==='work_tasks' && row.from==='task_id' && row.on_delete==='CASCADE');
  if (!taskForeignKey) {
    db.exec('SAVEPOINT inbox_work_task_state_fk');
    try {
      db.exec(`
        CREATE TABLE inbox_work_task_user_state_with_fk (
          company_id INTEGER NOT NULL REFERENCES companies(id),
          user_id INTEGER NOT NULL REFERENCES users(id),
          task_id INTEGER NOT NULL REFERENCES work_tasks(id) ON DELETE CASCADE,
          acknowledged_revision TEXT,
          acknowledged_at TEXT,
          snoozed_revision TEXT,
          snoozed_until TEXT,
          updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          PRIMARY KEY(company_id,user_id,task_id)
        );
        INSERT INTO inbox_work_task_user_state_with_fk
          (company_id,user_id,task_id,acknowledged_revision,acknowledged_at,snoozed_revision,snoozed_until,updated_at)
          SELECT s.company_id,s.user_id,s.task_id,s.acknowledged_revision,s.acknowledged_at,s.snoozed_revision,s.snoozed_until,s.updated_at
          FROM inbox_work_task_user_state s JOIN work_tasks t ON t.id=s.task_id AND t.company_id=s.company_id;
        DROP TABLE inbox_work_task_user_state;
        ALTER TABLE inbox_work_task_user_state_with_fk RENAME TO inbox_work_task_user_state;
      `);
      db.exec('RELEASE inbox_work_task_state_fk');
    } catch (error) {
      db.exec('ROLLBACK TO inbox_work_task_state_fk');
      db.exec('RELEASE inbox_work_task_state_fk');
      throw error;
    }
  }
}

module.exports = { installInboxSchema };
