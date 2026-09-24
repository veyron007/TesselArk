function installFinanceSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS invoice_payments (
      id INTEGER PRIMARY KEY,
      company_id INTEGER NOT NULL REFERENCES companies(id),
      invoice_id INTEGER NOT NULL REFERENCES invoices(id),
      amount_cents INTEGER NOT NULL CHECK(amount_cents > 0),
      method TEXT NOT NULL CHECK(method IN ('bank','upi','cash','cheque','other')),
      reference TEXT NOT NULL,
      payment_date TEXT NOT NULL,
      recorded_by INTEGER NOT NULL REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(invoice_id,reference)
    );
    CREATE INDEX IF NOT EXISTS idx_invoice_payments_company_invoice ON invoice_payments(company_id,invoice_id);
  `);
}

module.exports = { installFinanceSchema };
