function installBundleSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS trade_bundles (
      id INTEGER PRIMARY KEY, company_id INTEGER NOT NULL REFERENCES companies(id),
      gstin_id INTEGER NOT NULL REFERENCES gstins(id), branch_id INTEGER NOT NULL REFERENCES branches(id),
      name TEXT NOT NULL, client_reference TEXT NOT NULL, payload_json TEXT NOT NULL,
      current_version INTEGER NOT NULL DEFAULT 1, created_by INTEGER NOT NULL REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(company_id,client_reference)
    );
    CREATE TABLE IF NOT EXISTS trade_bundle_versions (
      id INTEGER PRIMARY KEY, bundle_id INTEGER NOT NULL REFERENCES trade_bundles(id),
      version INTEGER NOT NULL, reason TEXT NOT NULL, client_reference TEXT NOT NULL,
      payload_json TEXT NOT NULL, created_by INTEGER NOT NULL REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(bundle_id,version), UNIQUE(bundle_id,client_reference)
    );
    CREATE TABLE IF NOT EXISTS trade_bundle_components (
      id INTEGER PRIMARY KEY, version_id INTEGER NOT NULL REFERENCES trade_bundle_versions(id),
      item_id INTEGER NOT NULL REFERENCES items(id), item_name_snapshot TEXT NOT NULL,
      item_sku_snapshot TEXT NOT NULL, unit_snapshot TEXT NOT NULL,
      quantity INTEGER NOT NULL CHECK(quantity > 0), UNIQUE(version_id,item_id)
    );
    CREATE TABLE IF NOT EXISTS trade_schemes (
      id INTEGER PRIMARY KEY, company_id INTEGER NOT NULL REFERENCES companies(id),
      gstin_id INTEGER NOT NULL REFERENCES gstins(id), branch_id INTEGER NOT NULL REFERENCES branches(id),
      name TEXT NOT NULL, client_reference TEXT NOT NULL, payload_json TEXT NOT NULL,
      item_ids_json TEXT NOT NULL, min_quantity INTEGER NOT NULL CHECK(min_quantity > 0),
      discount_bps INTEGER NOT NULL CHECK(discount_bps BETWEEN 0 AND 10000),
      free_item_id INTEGER REFERENCES items(id), free_quantity INTEGER NOT NULL CHECK(free_quantity >= 0),
      stacking_policy TEXT NOT NULL CHECK(stacking_policy IN ('exclusive','stackable')),
      effective_from TEXT NOT NULL, effective_to TEXT NOT NULL, source_reference TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected')),
      created_by INTEGER NOT NULL REFERENCES users(id), created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      reviewed_by INTEGER REFERENCES users(id), reviewed_at TEXT, review_reason TEXT,
      UNIQUE(company_id,client_reference)
    );
    CREATE TABLE IF NOT EXISTS trade_bundle_events (
      id INTEGER PRIMARY KEY, company_id INTEGER NOT NULL REFERENCES companies(id),
      kind TEXT NOT NULL CHECK(kind IN ('bundle','scheme')),
      target_id INTEGER NOT NULL, actor_id INTEGER NOT NULL REFERENCES users(id),
      action TEXT NOT NULL, detail_json TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_trade_bundles_scope ON trade_bundles(company_id,branch_id,id);
    CREATE INDEX IF NOT EXISTS idx_trade_schemes_scope ON trade_schemes(company_id,branch_id,status,effective_from,effective_to);
  `);
}
module.exports = { installBundleSchema };
