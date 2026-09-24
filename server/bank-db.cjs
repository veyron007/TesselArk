function installBankSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS bank_accounts (
      id INTEGER PRIMARY KEY,
      company_id INTEGER NOT NULL REFERENCES companies(id),
      name TEXT NOT NULL,
      masked_account TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 1,
      created_by INTEGER NOT NULL REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(company_id,name)
    );
    CREATE TABLE IF NOT EXISTS bank_statement_imports (
      id INTEGER PRIMARY KEY,
      company_id INTEGER NOT NULL REFERENCES companies(id),
      account_id INTEGER NOT NULL REFERENCES bank_accounts(id),
      source_name TEXT NOT NULL,
      file_sha256 TEXT NOT NULL,
      payload_sha256 TEXT NOT NULL,
      row_count INTEGER NOT NULL,
      inserted_count INTEGER NOT NULL,
      skipped_count INTEGER NOT NULL,
      imported_by INTEGER NOT NULL REFERENCES users(id),
      imported_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(company_id,account_id,payload_sha256)
    );
    CREATE TABLE IF NOT EXISTS bank_statement_lines (
      id INTEGER PRIMARY KEY,
      company_id INTEGER NOT NULL REFERENCES companies(id),
      account_id INTEGER NOT NULL REFERENCES bank_accounts(id),
      import_id INTEGER NOT NULL REFERENCES bank_statement_imports(id),
      line_number INTEGER NOT NULL,
      transaction_date TEXT NOT NULL,
      reference TEXT NOT NULL,
      description TEXT NOT NULL,
      amount_cents INTEGER NOT NULL CHECK(amount_cents != 0),
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','matched','explained')),
      payment_id INTEGER REFERENCES invoice_payments(id),
      explanation TEXT,
      reviewed_by INTEGER REFERENCES users(id),
      reviewed_at TEXT,
      UNIQUE(account_id,reference),
      UNIQUE(payment_id)
    );
    CREATE TABLE IF NOT EXISTS bank_statement_import_rows (
      import_id INTEGER NOT NULL REFERENCES bank_statement_imports(id),
      line_number INTEGER NOT NULL,
      statement_line_id INTEGER NOT NULL REFERENCES bank_statement_lines(id),
      action TEXT NOT NULL CHECK(action IN ('inserted','repeat')),
      PRIMARY KEY(import_id,line_number)
    );
    CREATE TABLE IF NOT EXISTS bank_payment_account_assignments (
      payment_id INTEGER PRIMARY KEY REFERENCES invoice_payments(id),
      company_id INTEGER NOT NULL REFERENCES companies(id),
      account_id INTEGER NOT NULL REFERENCES bank_accounts(id),
      reason TEXT NOT NULL,
      assigned_by INTEGER NOT NULL REFERENCES users(id),
      assigned_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS bank_review_events (
      id INTEGER PRIMARY KEY,
      company_id INTEGER NOT NULL REFERENCES companies(id),
      line_id INTEGER NOT NULL REFERENCES bank_statement_lines(id),
      action TEXT NOT NULL CHECK(action IN ('match','explain','reopen')),
      payment_id INTEGER REFERENCES invoice_payments(id),
      reason TEXT NOT NULL,
      actor_id INTEGER NOT NULL REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_bank_lines_scope ON bank_statement_lines(company_id,account_id,status);
    CREATE INDEX IF NOT EXISTS idx_bank_imports_scope ON bank_statement_imports(company_id,account_id,imported_at);
    CREATE INDEX IF NOT EXISTS idx_bank_payment_account_scope ON bank_payment_account_assignments(company_id,account_id);
  `);
}

module.exports = { installBankSchema };
