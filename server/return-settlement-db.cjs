function installReturnSettlementSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS return_settlements (
      id INTEGER PRIMARY KEY,
      company_id INTEGER NOT NULL REFERENCES companies(id),
      invoice_id INTEGER NOT NULL REFERENCES invoices(id),
      return_id INTEGER NOT NULL UNIQUE REFERENCES returns(id),
      amount_cents INTEGER NOT NULL CHECK(amount_cents > 0),
      tax_proposal_cents INTEGER NOT NULL CHECK(tax_proposal_cents >= 0),
      settlement_date TEXT NOT NULL,
      posted_by INTEGER NOT NULL REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(company_id,return_id)
    );
    CREATE INDEX IF NOT EXISTS idx_return_settlements_invoice
      ON return_settlements(company_id,invoice_id,settlement_date,id);
  `);
}

module.exports = { installReturnSettlementSchema };
