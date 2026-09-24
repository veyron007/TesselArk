function installCatalogueSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS catalogue_categories (
      id INTEGER PRIMARY KEY, company_id INTEGER NOT NULL REFERENCES companies(id),
      name TEXT NOT NULL COLLATE NOCASE, source_reference TEXT NOT NULL,
      created_by INTEGER NOT NULL REFERENCES users(id), created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(company_id,name)
    );
    CREATE TABLE IF NOT EXISTS catalogue_item_details (
      item_id INTEGER PRIMARY KEY REFERENCES items(id), company_id INTEGER NOT NULL REFERENCES companies(id),
      category_id INTEGER REFERENCES catalogue_categories(id), product_kind TEXT NOT NULL CHECK(product_kind IN ('general','medicinal')),
      salt TEXT NOT NULL DEFAULT '', launched_on TEXT, source_reference TEXT NOT NULL,
      updated_by INTEGER NOT NULL REFERENCES users(id), updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS catalogue_item_tags (
      item_id INTEGER NOT NULL REFERENCES items(id), company_id INTEGER NOT NULL REFERENCES companies(id),
      tag TEXT NOT NULL COLLATE NOCASE, PRIMARY KEY(item_id,tag)
    );
    CREATE TABLE IF NOT EXISTS catalogue_item_parameters (
      item_id INTEGER NOT NULL REFERENCES items(id), company_id INTEGER NOT NULL REFERENCES companies(id),
      key TEXT NOT NULL COLLATE NOCASE, value TEXT NOT NULL, PRIMARY KEY(item_id,key)
    );
    CREATE TABLE IF NOT EXISTS catalogue_substitutes (
      id INTEGER PRIMARY KEY, company_id INTEGER NOT NULL REFERENCES companies(id),
      item_id INTEGER NOT NULL REFERENCES items(id), substitute_item_id INTEGER NOT NULL REFERENCES items(id),
      reason TEXT NOT NULL, source_reference TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
      updated_by INTEGER NOT NULL REFERENCES users(id), updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CHECK(item_id<>substitute_item_id), UNIQUE(company_id,item_id,substitute_item_id)
    );
    CREATE TABLE IF NOT EXISTS catalogue_item_events (
      id INTEGER PRIMARY KEY, company_id INTEGER NOT NULL REFERENCES companies(id), item_id INTEGER NOT NULL REFERENCES items(id),
      action TEXT NOT NULL, source_reference TEXT NOT NULL, change_reason TEXT NOT NULL,
      snapshot_json TEXT NOT NULL, actor_id INTEGER NOT NULL REFERENCES users(id), created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_catalogue_category ON catalogue_item_details(company_id,category_id);
    CREATE INDEX IF NOT EXISTS idx_catalogue_tag ON catalogue_item_tags(company_id,tag);
    CREATE INDEX IF NOT EXISTS idx_catalogue_substitute ON catalogue_substitutes(company_id,item_id,active);
  `);
}

module.exports = { installCatalogueSchema };
