function installReturnTaxSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS return_tax_reviews (
      return_id INTEGER PRIMARY KEY REFERENCES returns(id),
      company_id INTEGER NOT NULL REFERENCES companies(id),
      gstin_id INTEGER NOT NULL REFERENCES gstins(id),
      period TEXT NOT NULL,
      decision TEXT NOT NULL CHECK(decision IN ('eligible','rejected','deferred')),
      reason TEXT NOT NULL,
      tax_cents INTEGER NOT NULL CHECK(tax_cents >= 0),
      decided_by INTEGER NOT NULL REFERENCES users(id),
      decided_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS return_tax_review_events (
      id INTEGER PRIMARY KEY,
      return_id INTEGER NOT NULL REFERENCES returns(id),
      company_id INTEGER NOT NULL REFERENCES companies(id),
      gstin_id INTEGER NOT NULL REFERENCES gstins(id),
      period TEXT NOT NULL,
      decision TEXT NOT NULL CHECK(decision IN ('eligible','rejected','deferred')),
      reason TEXT NOT NULL,
      tax_cents INTEGER NOT NULL CHECK(tax_cents >= 0),
      decided_by INTEGER NOT NULL REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_return_tax_scope ON return_tax_reviews(company_id,gstin_id,period,decision);
    CREATE INDEX IF NOT EXISTS idx_return_tax_events ON return_tax_review_events(return_id,id);
  `);
}

module.exports = { installReturnTaxSchema };
