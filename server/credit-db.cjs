function installCreditSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS credit_policies (
      id INTEGER PRIMARY KEY,
      company_id INTEGER NOT NULL REFERENCES companies(id),
      gstin_id INTEGER NOT NULL REFERENCES gstins(id),
      branch_id INTEGER NOT NULL REFERENCES branches(id),
      party_id INTEGER NOT NULL REFERENCES parties(id),
      base_limit_cents INTEGER NOT NULL CHECK(base_limit_cents >= 0),
      mode TEXT NOT NULL CHECK(mode IN ('warn','hold')),
      version INTEGER NOT NULL DEFAULT 1 CHECK(version >= 1),
      reason TEXT NOT NULL,
      updated_by INTEGER NOT NULL REFERENCES users(id),
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(company_id,gstin_id,branch_id,party_id)
    );
    CREATE TABLE IF NOT EXISTS credit_requests (
      id INTEGER PRIMARY KEY,
      company_id INTEGER NOT NULL REFERENCES companies(id),
      gstin_id INTEGER NOT NULL REFERENCES gstins(id),
      branch_id INTEGER NOT NULL REFERENCES branches(id),
      party_id INTEGER NOT NULL REFERENCES parties(id),
      client_reference TEXT NOT NULL,
      additional_limit_cents INTEGER NOT NULL CHECK(additional_limit_cents > 0),
      valid_from TEXT NOT NULL,
      valid_through TEXT NOT NULL,
      reason TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected')),
      requested_by INTEGER NOT NULL REFERENCES users(id),
      requested_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      reviewed_by INTEGER REFERENCES users(id),
      reviewed_at TEXT,
      review_reason TEXT,
      base_limit_snapshot_cents INTEGER,
      exposure_snapshot_cents INTEGER,
      CHECK(valid_from <= valid_through),
      UNIQUE(company_id,client_reference)
    );
    CREATE TABLE IF NOT EXISTS credit_events (
      id INTEGER PRIMARY KEY,
      company_id INTEGER NOT NULL REFERENCES companies(id),
      gstin_id INTEGER NOT NULL REFERENCES gstins(id),
      branch_id INTEGER NOT NULL REFERENCES branches(id),
      party_id INTEGER NOT NULL REFERENCES parties(id),
      policy_id INTEGER REFERENCES credit_policies(id),
      request_id INTEGER REFERENCES credit_requests(id),
      action TEXT NOT NULL,
      actor_id INTEGER NOT NULL REFERENCES users(id),
      details TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_credit_requests_scope ON credit_requests(company_id,gstin_id,branch_id,party_id,status,valid_from,valid_through);
    CREATE INDEX IF NOT EXISTS idx_credit_events_scope ON credit_events(company_id,gstin_id,branch_id,party_id,id);
    CREATE TRIGGER IF NOT EXISTS credit_no_overlapping_approval
    BEFORE UPDATE OF status ON credit_requests
    WHEN NEW.status='approved'
    BEGIN
      SELECT RAISE(ABORT,'Another approved temporary limit overlaps these dates')
      WHERE EXISTS (
        SELECT 1 FROM credit_requests prior
        WHERE prior.id<>NEW.id AND prior.company_id=NEW.company_id
          AND prior.gstin_id=NEW.gstin_id AND prior.branch_id=NEW.branch_id AND prior.party_id=NEW.party_id
          AND prior.status='approved' AND prior.valid_from<=NEW.valid_through AND prior.valid_through>=NEW.valid_from
      );
    END;
  `);
}

module.exports = { installCreditSchema };
