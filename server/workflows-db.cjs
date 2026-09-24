function installWorkflowSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS workflow_cases (
      id INTEGER PRIMARY KEY,
      company_id INTEGER NOT NULL REFERENCES companies(id),
      feature_id TEXT NOT NULL,
      gstin_id INTEGER NOT NULL REFERENCES gstins(id),
      branch_id INTEGER NOT NULL REFERENCES branches(id),
      title TEXT NOT NULL,
      reference TEXT NOT NULL,
      record_date TEXT NOT NULL,
      amount_cents INTEGER NOT NULL CHECK(amount_cents >= 0),
      notes TEXT NOT NULL DEFAULT '',
      evidence_reference TEXT NOT NULL DEFAULT '',
      fields_json TEXT NOT NULL DEFAULT '{}',
      status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','submitted','approved','rejected')),
      created_by INTEGER NOT NULL REFERENCES users(id),
      submitted_by INTEGER REFERENCES users(id),
      reviewed_by INTEGER REFERENCES users(id),
      review_reason TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_workflow_cases_scope ON workflow_cases(company_id,feature_id,status);
    CREATE TABLE IF NOT EXISTS workflow_case_events (
      id INTEGER PRIMARY KEY,
      case_id INTEGER NOT NULL REFERENCES workflow_cases(id),
      company_id INTEGER NOT NULL REFERENCES companies(id),
      action TEXT NOT NULL CHECK(action IN ('create','update','submit','approve','reject')),
      actor_id INTEGER NOT NULL REFERENCES users(id),
      details TEXT NOT NULL DEFAULT '',
      snapshot_json TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_workflow_case_events ON workflow_case_events(company_id,case_id,id);
  `);
}

module.exports = { installWorkflowSchema };
