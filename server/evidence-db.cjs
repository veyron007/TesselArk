function installEvidenceSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS evidence_documents (
      id INTEGER PRIMARY KEY,
      company_id INTEGER NOT NULL REFERENCES companies(id),
      gstin_id INTEGER NOT NULL REFERENCES gstins(id),
      branch_id INTEGER NOT NULL REFERENCES branches(id),
      title TEXT NOT NULL,
      audience TEXT NOT NULL CHECK(audience IN ('internal','client')),
      target_type TEXT NOT NULL CHECK(target_type IN ('invoice','workflow_case')),
      target_id INTEGER NOT NULL,
      created_by INTEGER NOT NULL REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_evidence_documents_scope ON evidence_documents(company_id,gstin_id,branch_id,target_type,target_id);
    CREATE TABLE IF NOT EXISTS evidence_versions (
      id INTEGER PRIMARY KEY,
      document_id INTEGER NOT NULL REFERENCES evidence_documents(id),
      version INTEGER NOT NULL CHECK(version > 0),
      file_name TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      byte_size INTEGER NOT NULL CHECK(byte_size > 0),
      sha256 TEXT NOT NULL,
      content BLOB NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected')),
      uploaded_by INTEGER NOT NULL REFERENCES users(id),
      uploaded_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      reviewed_by INTEGER REFERENCES users(id),
      reviewed_at TEXT,
      review_reason TEXT NOT NULL DEFAULT '',
      UNIQUE(document_id,version)
    );
    CREATE INDEX IF NOT EXISTS idx_evidence_versions_document ON evidence_versions(document_id,version);
  `);
}
module.exports = { installEvidenceSchema };
