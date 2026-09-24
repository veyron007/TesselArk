function installStatementImportSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS statement_imports (
      id INTEGER PRIMARY KEY,
      company_id INTEGER NOT NULL REFERENCES companies(id),
      gstin_id INTEGER NOT NULL REFERENCES gstins(id),
      source_period TEXT NOT NULL,
      source_name TEXT NOT NULL,
      file_sha256 TEXT NOT NULL,
      payload_sha256 TEXT NOT NULL,
      row_count INTEGER NOT NULL,
      inserted_count INTEGER NOT NULL,
      skipped_count INTEGER NOT NULL,
      imported_by INTEGER NOT NULL REFERENCES users(id),
      imported_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(company_id,gstin_id,payload_sha256)
    );
    CREATE TABLE IF NOT EXISTS statement_import_rows (
      import_id INTEGER NOT NULL REFERENCES statement_imports(id),
      line_number INTEGER NOT NULL,
      fixture_id INTEGER NOT NULL REFERENCES purchase_fixtures(id),
      action TEXT NOT NULL CHECK(action IN ('inserted','repeat')),
      PRIMARY KEY(import_id,line_number)
    );
    CREATE INDEX IF NOT EXISTS idx_statement_import_scope ON statement_imports(company_id,gstin_id,imported_at);
  `);
}

module.exports = { installStatementImportSchema };
