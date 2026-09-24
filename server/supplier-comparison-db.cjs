function installSupplierComparisonSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS supplier_comparisons (
      id INTEGER PRIMARY KEY,
      company_id INTEGER NOT NULL REFERENCES companies(id),
      gstin_id INTEGER NOT NULL REFERENCES gstins(id),
      branch_id INTEGER NOT NULL REFERENCES branches(id),
      item_id INTEGER NOT NULL REFERENCES items(id),
      item_unit_snapshot TEXT NOT NULL,
      title TEXT NOT NULL,
      client_reference TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','submitted','approved','rejected')),
      selected_quote_id INTEGER,
      selection_reason TEXT,
      history_fingerprint TEXT,
      created_by INTEGER NOT NULL REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      submitted_at TEXT,
      reviewed_by INTEGER REFERENCES users(id),
      reviewed_at TEXT,
      review_reason TEXT,
      UNIQUE(company_id,client_reference)
    );
    CREATE INDEX IF NOT EXISTS idx_supplier_comparisons_scope ON supplier_comparisons(company_id,branch_id,item_id,id);
    CREATE TABLE IF NOT EXISTS supplier_comparison_quotes (
      id INTEGER PRIMARY KEY,
      comparison_id INTEGER NOT NULL REFERENCES supplier_comparisons(id),
      company_id INTEGER NOT NULL REFERENCES companies(id),
      supplier_id INTEGER NOT NULL REFERENCES parties(id),
      quote_date TEXT NOT NULL,
      valid_until TEXT NOT NULL,
      source_reference TEXT NOT NULL,
      payment_terms TEXT NOT NULL,
      paid_pack_quantity INTEGER NOT NULL CHECK(paid_pack_quantity>0),
      free_pack_quantity INTEGER NOT NULL CHECK(free_pack_quantity>=0),
      units_per_pack_numerator INTEGER NOT NULL CHECK(units_per_pack_numerator>0),
      units_per_pack_denominator INTEGER NOT NULL CHECK(units_per_pack_denominator>0),
      price_cents_per_pack INTEGER NOT NULL CHECK(price_cents_per_pack>0),
      tax_rate_bps INTEGER NOT NULL CHECK(tax_rate_bps BETWEEN 0 AND 10000),
      freight_cents INTEGER NOT NULL CHECK(freight_cents>=0),
      tax_treatment TEXT NOT NULL CHECK(tax_treatment IN ('include','exclude')),
      client_reference TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_by INTEGER NOT NULL REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(comparison_id,client_reference)
    );
    CREATE TABLE IF NOT EXISTS supplier_comparison_events (
      id INTEGER PRIMARY KEY,
      comparison_id INTEGER NOT NULL REFERENCES supplier_comparisons(id),
      company_id INTEGER NOT NULL REFERENCES companies(id),
      actor_id INTEGER NOT NULL REFERENCES users(id),
      action TEXT NOT NULL,
      detail_json TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);
}
module.exports = { installSupplierComparisonSchema };
