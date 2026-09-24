function installExpensesSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS expense_claims (
      id INTEGER PRIMARY KEY,
      company_id INTEGER NOT NULL REFERENCES companies(id),
      gstin_id INTEGER NOT NULL REFERENCES gstins(id),
      branch_id INTEGER NOT NULL REFERENCES branches(id),
      invoice_id INTEGER NOT NULL REFERENCES invoices(id),
      claimant_user_id INTEGER NOT NULL REFERENCES users(id),
      created_by INTEGER NOT NULL REFERENCES users(id),
      paid_by TEXT NOT NULL CHECK(paid_by IN ('employee','company')),
      purpose TEXT NOT NULL,
      cost_centre TEXT,
      evidence_document_id INTEGER NOT NULL REFERENCES evidence_documents(id),
      evidence_version INTEGER NOT NULL,
      evidence_sha256 TEXT NOT NULL,
      proof_reference TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','submitted','rejected','approved')),
      version INTEGER NOT NULL DEFAULT 1 CHECK(version > 0),
      source_fingerprint TEXT,
      approved_amount_cents INTEGER NOT NULL DEFAULT 0 CHECK(approved_amount_cents >= 0),
      submitted_by INTEGER REFERENCES users(id),
      reviewed_by INTEGER REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      submitted_at TEXT,
      reviewed_at TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS uq_expense_active_invoice ON expense_claims(company_id,invoice_id) WHERE status<>'rejected';
    CREATE INDEX IF NOT EXISTS idx_expense_claim_scope ON expense_claims(company_id,gstin_id,branch_id,id);
    CREATE TABLE IF NOT EXISTS expense_claim_events (
      id INTEGER PRIMARY KEY,
      claim_id INTEGER NOT NULL REFERENCES expense_claims(id),
      action TEXT NOT NULL CHECK(action IN ('created','submitted','approved','rejected')),
      from_status TEXT,
      to_status TEXT NOT NULL,
      version INTEGER NOT NULL,
      details TEXT NOT NULL,
      actor_id INTEGER NOT NULL REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS employee_invoice_allocations (
      id INTEGER PRIMARY KEY,
      company_id INTEGER NOT NULL REFERENCES companies(id),
      invoice_id INTEGER NOT NULL REFERENCES invoices(id),
      claim_id INTEGER NOT NULL UNIQUE REFERENCES expense_claims(id),
      amount_cents INTEGER NOT NULL CHECK(amount_cents > 0),
      allocated_by INTEGER NOT NULL REFERENCES users(id),
      allocated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_employee_allocations_invoice ON employee_invoice_allocations(company_id,invoice_id);
    CREATE TABLE IF NOT EXISTS expense_reimbursements (
      id INTEGER PRIMARY KEY,
      company_id INTEGER NOT NULL REFERENCES companies(id),
      claim_id INTEGER NOT NULL REFERENCES expense_claims(id),
      amount_cents INTEGER NOT NULL CHECK(amount_cents > 0),
      method TEXT NOT NULL CHECK(method IN ('bank','upi')),
      reference TEXT NOT NULL,
      payment_date TEXT NOT NULL,
      recorded_by INTEGER NOT NULL REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(company_id,reference)
    );
    CREATE INDEX IF NOT EXISTS idx_expense_reimbursements_claim ON expense_reimbursements(claim_id,id);
  `);
}
module.exports = { installExpensesSchema };
