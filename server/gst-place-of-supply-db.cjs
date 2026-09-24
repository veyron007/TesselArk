function installGstPlaceOfSupplySchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS gst_pos_proposals (
      id INTEGER PRIMARY KEY,
      company_id INTEGER NOT NULL REFERENCES companies(id),
      invoice_id INTEGER NOT NULL REFERENCES invoices(id),
      version INTEGER NOT NULL CHECK(version > 0),
      invoice_fingerprint TEXT NOT NULL,
      supply_kind TEXT NOT NULL CHECK(supply_kind IN ('goods_movement','domestic_service_default','specialist_review')),
      pos_state_code TEXT,
      declaration_json TEXT NOT NULL,
      basis_reference TEXT NOT NULL,
      reason TEXT NOT NULL,
      outcome TEXT NOT NULL CHECK(outcome IN ('proposed_split','requires_specialist_review')),
      tax_head TEXT,
      line_split_json TEXT,
      reasons_json TEXT NOT NULL,
      warnings_json TEXT NOT NULL,
      proposed_by INTEGER NOT NULL REFERENCES users(id),
      proposed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(company_id, invoice_id, version)
    );
    CREATE INDEX IF NOT EXISTS idx_gst_pos_proposals_invoice ON gst_pos_proposals(company_id,invoice_id,id DESC);
    CREATE TABLE IF NOT EXISTS gst_pos_reviews (
      id INTEGER PRIMARY KEY,
      company_id INTEGER NOT NULL REFERENCES companies(id),
      proposal_id INTEGER NOT NULL UNIQUE REFERENCES gst_pos_proposals(id),
      decision TEXT NOT NULL CHECK(decision IN ('approved','rejected')),
      reason TEXT NOT NULL,
      reviewed_by INTEGER NOT NULL REFERENCES users(id),
      reviewed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TRIGGER IF NOT EXISTS gst_pos_proposals_immutable_update BEFORE UPDATE ON gst_pos_proposals
      BEGIN SELECT RAISE(ABORT,'GST POS proposals are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS gst_pos_proposals_immutable_delete BEFORE DELETE ON gst_pos_proposals
      BEGIN SELECT RAISE(ABORT,'GST POS proposals are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS gst_pos_reviews_immutable_update BEFORE UPDATE ON gst_pos_reviews
      BEGIN SELECT RAISE(ABORT,'GST POS reviews are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS gst_pos_reviews_immutable_delete BEFORE DELETE ON gst_pos_reviews
      BEGIN SELECT RAISE(ABORT,'GST POS reviews are immutable'); END;
  `);
}

module.exports = { installGstPlaceOfSupplySchema };
