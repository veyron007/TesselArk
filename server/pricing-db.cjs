function installPricingSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS pricing_rules (
      id INTEGER PRIMARY KEY,
      company_id INTEGER NOT NULL REFERENCES companies(id),
      scope TEXT NOT NULL CHECK(scope IN ('company','item','party','party_item')),
      item_id INTEGER REFERENCES items(id), party_id INTEGER REFERENCES parties(id),
      rate_cents INTEGER NOT NULL CHECK(rate_cents>0),
      default_discount_bps INTEGER NOT NULL CHECK(default_discount_bps BETWEEN 0 AND 10000),
      min_discount_bps INTEGER NOT NULL CHECK(min_discount_bps BETWEEN 0 AND 10000),
      max_discount_bps INTEGER NOT NULL CHECK(max_discount_bps BETWEEN 0 AND 10000),
      effective_from TEXT NOT NULL, effective_to TEXT,
      source_reference TEXT NOT NULL, reason TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
      created_by INTEGER NOT NULL REFERENCES users(id), created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      retired_by INTEGER REFERENCES users(id), retired_at TEXT,
      CHECK(min_discount_bps<=default_discount_bps AND default_discount_bps<=max_discount_bps),
      CHECK(effective_to IS NULL OR effective_to>=effective_from),
      CHECK((scope='company' AND item_id IS NULL AND party_id IS NULL) OR
            (scope='item' AND item_id IS NOT NULL AND party_id IS NULL) OR
            (scope='party' AND item_id IS NULL AND party_id IS NOT NULL) OR
            (scope='party_item' AND item_id IS NOT NULL AND party_id IS NOT NULL))
    );
    CREATE INDEX IF NOT EXISTS idx_pricing_rules_match ON pricing_rules(company_id,active,scope,item_id,party_id,effective_from,effective_to);
    CREATE TABLE IF NOT EXISTS pricing_rule_events (
      id INTEGER PRIMARY KEY, company_id INTEGER NOT NULL REFERENCES companies(id),
      rule_id INTEGER NOT NULL REFERENCES pricing_rules(id), action TEXT NOT NULL,
      actor_id INTEGER NOT NULL REFERENCES users(id), detail_json TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS pricing_exceptions (
      id INTEGER PRIMARY KEY, company_id INTEGER NOT NULL REFERENCES companies(id),
      gstin_id INTEGER NOT NULL REFERENCES gstins(id), branch_id INTEGER NOT NULL REFERENCES branches(id),
      party_id INTEGER NOT NULL REFERENCES parties(id), item_id INTEGER NOT NULL REFERENCES items(id),
      price_date TEXT NOT NULL, rule_id INTEGER NOT NULL REFERENCES pricing_rules(id),
      proposed_rate_cents INTEGER NOT NULL CHECK(proposed_rate_cents>0),
      proposed_discount_bps INTEGER NOT NULL CHECK(proposed_discount_bps BETWEEN 0 AND 10000),
      baseline_json TEXT NOT NULL, reason TEXT NOT NULL,
      client_reference TEXT NOT NULL, payload_json TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected')),
      requested_by INTEGER NOT NULL REFERENCES users(id), requested_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      decided_by INTEGER REFERENCES users(id), decided_at TEXT, decision_reason TEXT,
      UNIQUE(company_id,client_reference)
    );
    CREATE INDEX IF NOT EXISTS idx_pricing_exceptions_scope ON pricing_exceptions(company_id,branch_id,status);
    CREATE TABLE IF NOT EXISTS pricing_exception_events (
      id INTEGER PRIMARY KEY, company_id INTEGER NOT NULL REFERENCES companies(id),
      exception_id INTEGER NOT NULL REFERENCES pricing_exceptions(id), action TEXT NOT NULL,
      actor_id INTEGER NOT NULL REFERENCES users(id), detail_json TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);
}

module.exports = { installPricingSchema };
