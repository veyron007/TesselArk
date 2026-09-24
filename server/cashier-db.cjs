function installCashierSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS cashier_sessions (
      id INTEGER PRIMARY KEY,
      company_id INTEGER NOT NULL REFERENCES companies(id),
      branch_id INTEGER NOT NULL REFERENCES branches(id),
      business_date TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','pending_review','closed')),
      opening_cash_cents INTEGER NOT NULL CHECK(opening_cash_cents >= 0),
      counted_cash_cents INTEGER CHECK(counted_cash_cents >= 0),
      discrepancy_cents INTEGER,
      close_notes TEXT NOT NULL DEFAULT '',
      review_note TEXT NOT NULL DEFAULT '',
      opened_by INTEGER NOT NULL REFERENCES users(id),
      closed_by INTEGER REFERENCES users(id),
      reviewed_by INTEGER REFERENCES users(id),
      opened_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      closed_at TEXT,
      reviewed_at TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS uq_cashier_active_branch ON cashier_sessions(company_id,branch_id)
      WHERE status IN ('open','pending_review');
    CREATE UNIQUE INDEX IF NOT EXISTS uq_cashier_branch_business_date ON cashier_sessions(company_id,branch_id,business_date);
    CREATE INDEX IF NOT EXISTS idx_cashier_sessions_scope ON cashier_sessions(company_id,branch_id,business_date);
    CREATE TABLE IF NOT EXISTS cashier_assignments (
      id INTEGER PRIMARY KEY,
      company_id INTEGER NOT NULL REFERENCES companies(id),
      session_id INTEGER NOT NULL REFERENCES cashier_sessions(id),
      payment_id INTEGER NOT NULL UNIQUE REFERENCES invoice_payments(id),
      assigned_by INTEGER NOT NULL REFERENCES users(id),
      assigned_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_cashier_assignments_session ON cashier_assignments(session_id);
    CREATE TABLE IF NOT EXISTS cashier_payouts (
      id INTEGER PRIMARY KEY,
      company_id INTEGER NOT NULL REFERENCES companies(id),
      session_id INTEGER NOT NULL REFERENCES cashier_sessions(id),
      kind TEXT NOT NULL CHECK(kind IN ('expense','refund','transfer')),
      amount_cents INTEGER NOT NULL CHECK(amount_cents > 0),
      reference TEXT NOT NULL,
      notes TEXT NOT NULL DEFAULT '',
      recorded_by INTEGER NOT NULL REFERENCES users(id),
      recorded_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(session_id,reference)
    );
    CREATE INDEX IF NOT EXISTS idx_cashier_payouts_session ON cashier_payouts(session_id);
    CREATE TABLE IF NOT EXISTS cashier_events (
      id INTEGER PRIMARY KEY,
      company_id INTEGER NOT NULL REFERENCES companies(id),
      session_id INTEGER NOT NULL REFERENCES cashier_sessions(id),
      action TEXT NOT NULL,
      details TEXT NOT NULL,
      actor_id INTEGER NOT NULL REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_cashier_events_session ON cashier_events(session_id,id);
  `);
}

module.exports = { installCashierSchema };
