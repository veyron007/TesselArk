function installWorkTasksSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS work_templates (
      id INTEGER PRIMARY KEY,
      company_id INTEGER NOT NULL REFERENCES companies(id),
      gstin_id INTEGER NOT NULL REFERENCES gstins(id),
      branch_id INTEGER REFERENCES branches(id),
      scope_type TEXT NOT NULL CHECK(scope_type IN ('gstin','branch')),
      created_by INTEGER NOT NULL REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CHECK((scope_type='gstin' AND branch_id IS NULL) OR (scope_type='branch' AND branch_id IS NOT NULL))
    );
    CREATE TABLE IF NOT EXISTS work_template_versions (
      id INTEGER PRIMARY KEY,
      template_id INTEGER NOT NULL REFERENCES work_templates(id),
      version INTEGER NOT NULL CHECK(version>0),
      title TEXT NOT NULL,
      obligation_key TEXT NOT NULL,
      recurrence TEXT NOT NULL CHECK(recurrence IN ('none','monthly','quarterly','annual')),
      checklist_json TEXT NOT NULL,
      dependency_template_ids_json TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('draft','approved')),
      created_by INTEGER NOT NULL REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      approved_by INTEGER REFERENCES users(id),
      approved_at TEXT,
      approval_reason TEXT,
      UNIQUE(template_id,version)
    );
    CREATE INDEX IF NOT EXISTS idx_work_templates_scope ON work_templates(company_id,gstin_id,branch_id);
    CREATE TABLE IF NOT EXISTS work_tasks (
      id INTEGER PRIMARY KEY,
      company_id INTEGER NOT NULL REFERENCES companies(id),
      gstin_id INTEGER NOT NULL REFERENCES gstins(id),
      branch_id INTEGER REFERENCES branches(id),
      scope_type TEXT NOT NULL CHECK(scope_type IN ('gstin','branch')),
      template_id INTEGER NOT NULL REFERENCES work_templates(id),
      source_period_id INTEGER REFERENCES gst_periods(id),
      template_version INTEGER NOT NULL,
      title TEXT NOT NULL,
      obligation_key TEXT NOT NULL,
      period TEXT NOT NULL,
      period_start TEXT NOT NULL,
      period_end TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','submitted','closed')),
      version INTEGER NOT NULL DEFAULT 1,
      preparer_user_id INTEGER NOT NULL REFERENCES users(id),
      reviewer_user_id INTEGER NOT NULL REFERENCES users(id),
      internal_target_date TEXT NOT NULL,
      statutory_due_date TEXT,
      statutory_basis_json TEXT,
      checklist_json TEXT NOT NULL,
      completed_checklist_keys_json TEXT NOT NULL DEFAULT '[]',
      dependency_task_ids_json TEXT NOT NULL DEFAULT '[]',
      generation_hash TEXT NOT NULL,
      created_by INTEGER NOT NULL REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      submitted_by INTEGER REFERENCES users(id),
      submitted_at TEXT,
      closed_by INTEGER REFERENCES users(id),
      closed_at TEXT,
      closure_evidence_id INTEGER,
      closure_evidence_version INTEGER,
      closure_evidence_sha256 TEXT,
      reopen_evidence_version INTEGER NOT NULL DEFAULT 0,
      CHECK((scope_type='gstin' AND branch_id IS NULL) OR (scope_type='branch' AND branch_id IS NOT NULL)),
      UNIQUE(template_id,period)
    );
    CREATE INDEX IF NOT EXISTS idx_work_tasks_scope ON work_tasks(company_id,gstin_id,period_start,period_end);
    CREATE TABLE IF NOT EXISTS work_task_events (
      id INTEGER PRIMARY KEY,
      task_id INTEGER NOT NULL REFERENCES work_tasks(id),
      action TEXT NOT NULL,
      details TEXT NOT NULL,
      actor_id INTEGER NOT NULL REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS work_task_evidence (
      id INTEGER PRIMARY KEY,
      task_id INTEGER NOT NULL REFERENCES work_tasks(id),
      version INTEGER NOT NULL CHECK(version>0),
      file_name TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      byte_size INTEGER NOT NULL CHECK(byte_size>0),
      sha256 TEXT NOT NULL,
      content BLOB NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected')),
      uploaded_by INTEGER NOT NULL REFERENCES users(id),
      uploaded_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      reviewed_by INTEGER REFERENCES users(id),
      reviewed_at TEXT,
      review_reason TEXT NOT NULL DEFAULT '',
      UNIQUE(task_id,version)
    );
  `);
  if (!db.prepare('PRAGMA table_info(work_tasks)').all().some(row=>row.name==='reopen_evidence_version'))
    db.exec('ALTER TABLE work_tasks ADD COLUMN reopen_evidence_version INTEGER NOT NULL DEFAULT 0');
  if (!db.prepare('PRAGMA table_info(work_tasks)').all().some(row=>row.name==='source_period_id'))
    db.exec('ALTER TABLE work_tasks ADD COLUMN source_period_id INTEGER REFERENCES gst_periods(id)');
}

module.exports = { installWorkTasksSchema };
