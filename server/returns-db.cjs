function installReturnsSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS returns (
      id INTEGER PRIMARY KEY,
      company_id INTEGER NOT NULL REFERENCES companies(id),
      invoice_id INTEGER NOT NULL REFERENCES invoices(id),
      number TEXT NOT NULL,
      kind TEXT NOT NULL CHECK(kind IN ('sales_return','purchase_return')),
      status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','approved')),
      reason TEXT NOT NULL,
      subtotal_cents INTEGER NOT NULL DEFAULT 0,
      tax_proposal_cents INTEGER NOT NULL DEFAULT 0,
      total_proposal_cents INTEGER NOT NULL DEFAULT 0,
      tax_proposal_status TEXT NOT NULL DEFAULT 'unreviewed' CHECK(tax_proposal_status='unreviewed'),
      created_by INTEGER NOT NULL REFERENCES users(id),
      approved_by INTEGER REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      approved_at TEXT,
      UNIQUE(company_id,number)
    );
    CREATE TABLE IF NOT EXISTS return_lines (
      id INTEGER PRIMARY KEY,
      return_id INTEGER NOT NULL REFERENCES returns(id),
      invoice_line_id INTEGER NOT NULL REFERENCES invoice_lines(id),
      item_id INTEGER NOT NULL REFERENCES items(id),
      quantity INTEGER NOT NULL CHECK(quantity > 0),
      subtotal_cents INTEGER NOT NULL,
      tax_proposal_cents INTEGER NOT NULL,
      stock_movement_id INTEGER UNIQUE REFERENCES stock_movements(id),
      UNIQUE(return_id,invoice_line_id)
    );
    CREATE INDEX IF NOT EXISTS idx_returns_company ON returns(company_id,id);
    CREATE INDEX IF NOT EXISTS idx_return_lines_source ON return_lines(invoice_line_id,return_id);
  `);
}

module.exports = { installReturnsSchema };
