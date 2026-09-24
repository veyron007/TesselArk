function installConversionSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS stock_conversions (
      id INTEGER PRIMARY KEY,
      company_id INTEGER NOT NULL REFERENCES companies(id),
      gstin_id INTEGER NOT NULL REFERENCES gstins(id),
      branch_id INTEGER NOT NULL REFERENCES branches(id),
      source_item_id INTEGER NOT NULL REFERENCES items(id),
      target_item_id INTEGER NOT NULL REFERENCES items(id),
      source_quantity INTEGER NOT NULL CHECK(source_quantity>0),
      ratio_numerator INTEGER NOT NULL CHECK(ratio_numerator>0),
      ratio_denominator INTEGER NOT NULL CHECK(ratio_denominator>0),
      expected_target_quantity INTEGER NOT NULL CHECK(expected_target_quantity>0),
      allowed_wastage_quantity INTEGER NOT NULL CHECK(allowed_wastage_quantity>=0),
      actual_wastage_quantity INTEGER NOT NULL CHECK(actual_wastage_quantity>=0),
      target_quantity INTEGER NOT NULL CHECK(target_quantity>0),
      cost_basis_cents INTEGER NOT NULL CHECK(cost_basis_cents>=0),
      cost_basis_reference TEXT NOT NULL,
      reason TEXT NOT NULL,
      client_reference TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','submitted','reviewed','posted')),
      created_by INTEGER NOT NULL REFERENCES users(id),
      submitted_by INTEGER REFERENCES users(id),
      reviewed_by INTEGER REFERENCES users(id),
      posted_by INTEGER REFERENCES users(id),
      source_movement_ids_json TEXT,
      target_movement_id INTEGER UNIQUE REFERENCES stock_movements(id),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      submitted_at TEXT,
      reviewed_at TEXT,
      posted_at TEXT,
      UNIQUE(company_id,client_reference),
      CHECK(source_item_id<>target_item_id),
      CHECK(actual_wastage_quantity<=allowed_wastage_quantity),
      CHECK(target_quantity=expected_target_quantity-actual_wastage_quantity)
    );
    CREATE INDEX IF NOT EXISTS idx_stock_conversions_scope ON stock_conversions(company_id,branch_id,id);
    CREATE TABLE IF NOT EXISTS stock_conversion_events (
      id INTEGER PRIMARY KEY,
      conversion_id INTEGER NOT NULL REFERENCES stock_conversions(id),
      action TEXT NOT NULL CHECK(action IN ('create','submit','review','post')),
      actor_id INTEGER NOT NULL REFERENCES users(id),
      details TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_stock_conversion_events ON stock_conversion_events(conversion_id,id);
  `);
}
module.exports = { installConversionSchema };
