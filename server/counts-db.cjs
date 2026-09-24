function installCountsSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS count_sessions (
      id INTEGER PRIMARY KEY,
      company_id INTEGER NOT NULL REFERENCES companies(id),
      gstin_id INTEGER NOT NULL REFERENCES gstins(id),
      branch_id INTEGER NOT NULL REFERENCES branches(id),
      status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','submitted','approved','rejected')),
      created_by INTEGER NOT NULL REFERENCES users(id),
      submitted_by INTEGER REFERENCES users(id),
      reviewed_by INTEGER REFERENCES users(id),
      review_reason TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      submitted_at TEXT,
      reviewed_at TEXT
    );
    CREATE TABLE IF NOT EXISTS count_lines (
      id INTEGER PRIMARY KEY,
      session_id INTEGER NOT NULL REFERENCES count_sessions(id),
      item_id INTEGER NOT NULL REFERENCES items(id),
      recorded_quantity INTEGER NOT NULL CHECK(recorded_quantity>=0),
      counted_quantity INTEGER CHECK(counted_quantity>=0),
      reason TEXT NOT NULL DEFAULT '',
      stock_movement_id INTEGER UNIQUE REFERENCES stock_movements(id),
      UNIQUE(session_id,item_id)
    );
    CREATE TABLE IF NOT EXISTS count_events (
      id INTEGER PRIMARY KEY,
      session_id INTEGER NOT NULL REFERENCES count_sessions(id),
      company_id INTEGER NOT NULL REFERENCES companies(id),
      actor_id INTEGER NOT NULL REFERENCES users(id),
      action TEXT NOT NULL,
      details TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS reorder_proposals (
      id INTEGER PRIMARY KEY,
      company_id INTEGER NOT NULL REFERENCES companies(id),
      gstin_id INTEGER NOT NULL REFERENCES gstins(id),
      branch_id INTEGER NOT NULL REFERENCES branches(id),
      item_id INTEGER NOT NULL REFERENCES items(id),
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected')),
      metrics_json TEXT NOT NULL,
      created_by INTEGER NOT NULL REFERENCES users(id),
      reviewed_by INTEGER REFERENCES users(id),
      review_reason TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      reviewed_at TEXT
    );
    CREATE TABLE IF NOT EXISTS reorder_events (
      id INTEGER PRIMARY KEY,
      proposal_id INTEGER NOT NULL REFERENCES reorder_proposals(id),
      company_id INTEGER NOT NULL REFERENCES companies(id),
      actor_id INTEGER NOT NULL REFERENCES users(id),
      action TEXT NOT NULL,
      details TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_count_scope ON count_sessions(company_id,gstin_id,branch_id,id);
    CREATE INDEX IF NOT EXISTS idx_reorder_scope ON reorder_proposals(company_id,gstin_id,branch_id,id);
  `);
}

module.exports = { installCountsSchema };
