function installPriceAdjustmentSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS price_adjustments (
      id INTEGER PRIMARY KEY,
      company_id INTEGER NOT NULL REFERENCES companies(id),
      gstin_id INTEGER NOT NULL REFERENCES gstins(id),
      branch_id INTEGER NOT NULL REFERENCES branches(id),
      party_id INTEGER NOT NULL REFERENCES parties(id),
      invoice_type TEXT NOT NULL CHECK(invoice_type IN ('sale','purchase')),
      client_reference TEXT NOT NULL,
      reason TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected')),
      subtotal_delta_cents INTEGER NOT NULL,
      tax_proposal_cents INTEGER NOT NULL,
      created_by INTEGER NOT NULL REFERENCES users(id),
      reviewed_by INTEGER REFERENCES users(id),
      review_reason TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      reviewed_at TEXT,
      UNIQUE(company_id,client_reference)
    );
    CREATE TABLE IF NOT EXISTS price_adjustment_lines (
      id INTEGER PRIMARY KEY,
      adjustment_id INTEGER NOT NULL REFERENCES price_adjustments(id),
      invoice_id INTEGER NOT NULL REFERENCES invoices(id),
      invoice_line_id INTEGER NOT NULL REFERENCES invoice_lines(id),
      item_id INTEGER NOT NULL REFERENCES items(id),
      quantity INTEGER NOT NULL CHECK(quantity > 0),
      old_unit_price_cents INTEGER NOT NULL CHECK(old_unit_price_cents >= 0),
      new_unit_price_cents INTEGER NOT NULL CHECK(new_unit_price_cents >= 0),
      gst_rate_bps INTEGER NOT NULL CHECK(gst_rate_bps BETWEEN 0 AND 10000),
      subtotal_delta_cents INTEGER NOT NULL,
      tax_proposal_cents INTEGER NOT NULL,
      UNIQUE(adjustment_id,invoice_line_id)
    );
    CREATE TABLE IF NOT EXISTS price_adjustment_events (
      id INTEGER PRIMARY KEY,
      adjustment_id INTEGER NOT NULL REFERENCES price_adjustments(id),
      company_id INTEGER NOT NULL REFERENCES companies(id),
      action TEXT NOT NULL CHECK(action IN ('created','approved','rejected')),
      actor_id INTEGER NOT NULL REFERENCES users(id),
      details TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS price_adjustment_tax_reviews (
      adjustment_id INTEGER PRIMARY KEY REFERENCES price_adjustments(id),
      company_id INTEGER NOT NULL REFERENCES companies(id),
      gstin_id INTEGER NOT NULL REFERENCES gstins(id),
      period TEXT NOT NULL,
      decision TEXT NOT NULL CHECK(decision IN ('accepted','rejected','deferred')),
      reason TEXT NOT NULL,
      tax_proposal_cents INTEGER NOT NULL,
      reviewed_by INTEGER NOT NULL REFERENCES users(id),
      reviewed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS price_adjustment_tax_events (
      id INTEGER PRIMARY KEY,
      adjustment_id INTEGER NOT NULL REFERENCES price_adjustments(id),
      company_id INTEGER NOT NULL REFERENCES companies(id),
      gstin_id INTEGER NOT NULL REFERENCES gstins(id),
      period TEXT NOT NULL,
      decision TEXT NOT NULL CHECK(decision IN ('accepted','rejected','deferred')),
      reason TEXT NOT NULL,
      tax_proposal_cents INTEGER NOT NULL,
      actor_id INTEGER NOT NULL REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_price_adjustment_scope ON price_adjustments(company_id,branch_id,status);
    CREATE INDEX IF NOT EXISTS idx_price_adjustment_source ON price_adjustment_lines(invoice_line_id,adjustment_id);
    CREATE INDEX IF NOT EXISTS idx_price_adjustment_events ON price_adjustment_events(adjustment_id,id);
    CREATE INDEX IF NOT EXISTS idx_price_adjustment_tax_events ON price_adjustment_tax_events(adjustment_id,id);
  `);
}

function seedPriceAdjustmentDemo(db) {
  installPriceAdjustmentSchema(db);
  const reference = 'DEMO-PRICE-MUM-001';
  const existing = db.prepare('SELECT id FROM price_adjustments WHERE company_id=1 AND client_reference=?').get(reference);
  if (existing) return { seeded:false, adjustmentId:existing.id };
  const source = db.prepare(`SELECT l.*,v.company_id,v.gstin_id,v.branch_id,v.party_id,v.type,v.status
    FROM invoice_lines l JOIN invoices v ON v.id=l.invoice_id
    WHERE v.company_id=1 AND v.number='SAL-01-00001' AND l.item_id=1 LIMIT 1`).get();
  if (!source || source.gstin_id !== 1 || source.branch_id !== 1 || source.type !== 'sale' || source.status !== 'approved'
    || source.quantity < 2 || source.unit_price_cents !== 10000 || source.gst_rate_bps !== 1200) return { seeded:false, adjustmentId:null };
  const allocated = db.prepare(`SELECT COALESCE(SUM(l.quantity),0) AS quantity FROM price_adjustment_lines l
    JOIN price_adjustments a ON a.id=l.adjustment_id WHERE l.invoice_line_id=? AND a.status IN ('pending','approved')`).get(source.id).quantity;
  if (allocated >= source.quantity) return { seeded:false, adjustmentId:null };
  const newUnitPriceCents = 9850;
  const quantity = 1;
  const subtotalDeltaCents = (newUnitPriceCents - source.unit_price_cents) * quantity;
  const taxProposalCents = Math.round(newUnitPriceCents * quantity * source.gst_rate_bps / 10000)
    - Math.round(source.unit_price_cents * quantity * source.gst_rate_bps / 10000);
  const reason = 'Synthetic demo: customer rate letter corrected one unit; no statutory or ledger posting';
  const reviewReason = 'Synthetic independent accountant check of source invoice and customer rate letter';
  const payload = { clientReference:reference,reason,lines:[{invoiceLineId:source.id,quantity,newUnitPriceCents}] };
  db.exec('BEGIN IMMEDIATE');
  try {
    const id = Number(db.prepare(`INSERT INTO price_adjustments(company_id,gstin_id,branch_id,party_id,invoice_type,client_reference,reason,payload_json,status,subtotal_delta_cents,tax_proposal_cents,created_by,reviewed_by,review_reason,reviewed_at)
      VALUES (1,1,1,?,'sale',?,?,?,'approved',?,?,1,2,?,CURRENT_TIMESTAMP)`)
      .run(source.party_id,reference,reason,JSON.stringify(payload),subtotalDeltaCents,taxProposalCents,reviewReason).lastInsertRowid);
    db.prepare(`INSERT INTO price_adjustment_lines(adjustment_id,invoice_id,invoice_line_id,item_id,quantity,old_unit_price_cents,new_unit_price_cents,gst_rate_bps,subtotal_delta_cents,tax_proposal_cents)
      VALUES (?,?,?,?,?,?,?,?,?,?)`).run(id,source.invoice_id,source.id,source.item_id,quantity,source.unit_price_cents,newUnitPriceCents,source.gst_rate_bps,subtotalDeltaCents,taxProposalCents);
    db.prepare(`INSERT INTO price_adjustment_events(adjustment_id,company_id,action,actor_id,details) VALUES (?,?,?, ?,?)`)
      .run(id,1,'created',1,JSON.stringify({reference,reason,syntheticDemo:true}));
    db.prepare(`INSERT INTO price_adjustment_events(adjustment_id,company_id,action,actor_id,details) VALUES (?,?,?, ?,?)`)
      .run(id,1,'approved',2,JSON.stringify({reason:reviewReason,syntheticDemo:true}));
    db.exec('COMMIT');
    return { seeded:true, adjustmentId:id };
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}

module.exports = { installPriceAdjustmentSchema, seedPriceAdjustmentDemo };
