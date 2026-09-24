function installStatutoryLifecycleSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS statutory_lifecycle_sessions (
      id INTEGER PRIMARY KEY,
      company_id INTEGER NOT NULL REFERENCES companies(id),
      gstin_id INTEGER NOT NULL REFERENCES gstins(id),
      service TEXT NOT NULL CHECK(service IN ('irn','eway','gst_return')),
      token_reference TEXT NOT NULL UNIQUE CHECK(token_reference LIKE 'SIM-%'),
      actor_id INTEGER NOT NULL REFERENCES users(id),
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS statutory_lifecycle_documents (
      id INTEGER PRIMARY KEY,
      company_id INTEGER NOT NULL REFERENCES companies(id),
      gstin_id INTEGER NOT NULL REFERENCES gstins(id),
      kind TEXT NOT NULL CHECK(kind IN ('irn','eway','gst_return')),
      source_id INTEGER NOT NULL,
      status TEXT NOT NULL,
      reference TEXT CHECK(reference IS NULL OR reference LIKE 'SIM-%'),
      acknowledgement TEXT CHECK(acknowledgement IS NULL OR acknowledgement LIKE 'SIM-%'),
      vehicle_number TEXT,
      saved_by INTEGER REFERENCES users(id),
      reviewed_by INTEGER REFERENCES users(id),
      signed_by INTEGER REFERENCES users(id),
      filed_by INTEGER REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(company_id,gstin_id,kind,source_id)
    );
    CREATE TABLE IF NOT EXISTS statutory_lifecycle_events (
      id INTEGER PRIMARY KEY,
      company_id INTEGER NOT NULL REFERENCES companies(id),
      gstin_id INTEGER NOT NULL REFERENCES gstins(id),
      kind TEXT NOT NULL,
      source_id INTEGER,
      action TEXT NOT NULL,
      outcome TEXT NOT NULL CHECK(outcome IN ('success','rejection','timeout')),
      idempotency_key TEXT NOT NULL,
      request_json TEXT NOT NULL,
      response_json TEXT NOT NULL,
      source_snapshot_json TEXT,
      actor_id INTEGER NOT NULL REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(company_id,idempotency_key)
    );
    CREATE INDEX IF NOT EXISTS idx_statutory_lifecycle_documents_scope ON statutory_lifecycle_documents(company_id,gstin_id,kind,id DESC);
    CREATE INDEX IF NOT EXISTS idx_statutory_lifecycle_events_scope ON statutory_lifecycle_events(company_id,gstin_id,kind,source_id,id DESC);
    CREATE INDEX IF NOT EXISTS idx_statutory_lifecycle_sessions_scope ON statutory_lifecycle_sessions(company_id,gstin_id,service,expires_at);
    CREATE TRIGGER IF NOT EXISTS statutory_lifecycle_events_no_update
      BEFORE UPDATE ON statutory_lifecycle_events BEGIN
        SELECT RAISE(ABORT,'statutory lifecycle event snapshots are immutable');
      END;
    CREATE TRIGGER IF NOT EXISTS statutory_lifecycle_events_no_delete
      BEFORE DELETE ON statutory_lifecycle_events BEGIN
        SELECT RAISE(ABORT,'statutory lifecycle event snapshots are immutable');
      END;
  `);
}

module.exports = { installStatutoryLifecycleSchema };
