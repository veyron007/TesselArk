function installBudgetsSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS budget_centres (
      id INTEGER PRIMARY KEY,
      company_id INTEGER NOT NULL REFERENCES companies(id),
      gstin_id INTEGER NOT NULL REFERENCES gstins(id),
      branch_id INTEGER NOT NULL REFERENCES branches(id),
      code TEXT NOT NULL,
      name TEXT NOT NULL,
      purpose TEXT NOT NULL,
      created_by INTEGER NOT NULL REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(company_id, gstin_id, branch_id, code)
    );
    CREATE TABLE IF NOT EXISTS budget_plans (
      id INTEGER PRIMARY KEY,
      company_id INTEGER NOT NULL REFERENCES companies(id),
      centre_id INTEGER NOT NULL REFERENCES budget_centres(id),
      period TEXT NOT NULL,
      measure TEXT NOT NULL CHECK(measure IN ('expense','sales','collections')),
      amount_cents INTEGER NOT NULL CHECK(amount_cents >= 0),
      basis TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected')),
      client_reference TEXT NOT NULL,
      created_by INTEGER NOT NULL REFERENCES users(id),
      reviewed_by INTEGER REFERENCES users(id),
      review_reason TEXT,
      reviewed_at TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(company_id, client_reference)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS uq_budget_active_plan ON budget_plans(centre_id,period,measure) WHERE status IN ('pending','approved');
    CREATE TABLE IF NOT EXISTS budget_allocations (
      id INTEGER PRIMARY KEY,
      company_id INTEGER NOT NULL REFERENCES companies(id),
      centre_id INTEGER NOT NULL REFERENCES budget_centres(id),
      source_type TEXT NOT NULL CHECK(source_type IN ('purchase_line','sale_line','sale_receipt')),
      source_id INTEGER NOT NULL,
      source_date TEXT NOT NULL,
      amount_cents INTEGER NOT NULL CHECK(amount_cents > 0),
      basis TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected')),
      client_reference TEXT NOT NULL,
      created_by INTEGER NOT NULL REFERENCES users(id),
      reviewed_by INTEGER REFERENCES users(id),
      review_reason TEXT,
      reviewed_at TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(company_id, client_reference)
    );
    CREATE INDEX IF NOT EXISTS idx_budget_allocations_source ON budget_allocations(company_id, source_type, source_id, status);
    CREATE INDEX IF NOT EXISTS idx_budget_allocations_centre ON budget_allocations(centre_id, source_date, status);
    CREATE TABLE IF NOT EXISTS budget_events (
      id INTEGER PRIMARY KEY,
      company_id INTEGER NOT NULL REFERENCES companies(id),
      entity_type TEXT NOT NULL CHECK(entity_type IN ('centre','plan','allocation')),
      entity_id INTEGER NOT NULL,
      action TEXT NOT NULL,
      actor_id INTEGER NOT NULL REFERENCES users(id),
      details TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_budget_events_company ON budget_events(company_id, id);
  `);
}

function seedBudgetsDemo(db) {
  installBudgetsSchema(db);
  const sale = db.prepare("SELECT id,company_id,gstin_id,branch_id,invoice_date FROM invoices WHERE company_id=1 AND type='sale' AND status='approved' AND branch_id=1 ORDER BY id LIMIT 1").get();
  const purchase = db.prepare("SELECT id FROM invoices WHERE company_id=1 AND type='purchase' AND status='approved' AND branch_id=1 ORDER BY id LIMIT 1").get();
  if (!sale) return false;
  const existing = db.prepare("SELECT id FROM budget_centres WHERE company_id=1 AND gstin_id=? AND branch_id=? AND code='DEMO-OPS'").get(sale.gstin_id, sale.branch_id);
  if (existing) return false;
  const accountant = db.prepare("SELECT id FROM users WHERE company_id=1 AND role='accountant' ORDER BY id LIMIT 1").get();
  const staff = db.prepare("SELECT id FROM users WHERE company_id=1 AND role='staff' ORDER BY id LIMIT 1").get();
  if (!accountant || !staff) return false;
  db.exec('SAVEPOINT seed_budgets_demo');
  try {
    const centreId = Number(db.prepare("INSERT INTO budget_centres(company_id,gstin_id,branch_id,code,name,purpose,created_by) VALUES (1,?,?,'DEMO-OPS','Synthetic branch operations','Synthetic demo cost and target attribution',?)").run(sale.gstin_id,sale.branch_id,staff.id).lastInsertRowid);
    const period = sale.invoice_date.slice(0,7);
    for (const [measure,amount] of [['sales',500000],['collections',300000],['expense',250000]]) {
      const planId = Number(db.prepare("INSERT INTO budget_plans(company_id,centre_id,period,measure,amount_cents,basis,status,client_reference,created_by,reviewed_by,review_reason,reviewed_at) VALUES (1,?,?,?,?,?,'approved',?,?,?,'Synthetic demo review',CURRENT_TIMESTAMP)")
        .run(centreId,period,measure,amount,'Synthetic demo period amount, branch specific',`DEMO-BUDGET-${measure}-${period}`,staff.id,accountant.id).lastInsertRowid);
      db.prepare("INSERT INTO budget_events(company_id,entity_type,entity_id,action,actor_id,details) VALUES (1,'plan',?,'approved',?,'Synthetic demo plan review')").run(planId,accountant.id);
    }
    for (const [type,invoiceId] of [['sale_line',sale.id],['purchase_line',purchase?.id]]) {
      if (!invoiceId) continue;
      const line = db.prepare('SELECT id,subtotal_cents FROM invoice_lines WHERE invoice_id=? ORDER BY id LIMIT 1').get(invoiceId);
      if (!line || line.subtotal_cents <= 0) continue;
      const invoice = db.prepare('SELECT invoice_date FROM invoices WHERE id=?').get(invoiceId);
      const allocationId = Number(db.prepare("INSERT INTO budget_allocations(company_id,centre_id,source_type,source_id,source_date,amount_cents,basis,status,client_reference,created_by,reviewed_by,review_reason,reviewed_at) VALUES (1,?,?,?,?,?,?,'approved',?,?,?,'Synthetic demo source review',CURRENT_TIMESTAMP)")
        .run(centreId,type,line.id,invoice.invoice_date,line.subtotal_cents,'Whole synthetic invoice line attributed to branch operations',`DEMO-BUDGET-${type}-${line.id}`,staff.id,accountant.id).lastInsertRowid);
      db.prepare("INSERT INTO budget_events(company_id,entity_type,entity_id,action,actor_id,details) VALUES (1,'allocation',?,'approved',?,'Synthetic demo allocation review')").run(allocationId,accountant.id);
    }
    const receipt = db.prepare('SELECT p.id,p.amount_cents,p.payment_date FROM invoice_payments p JOIN invoices i ON i.id=p.invoice_id WHERE i.id=? AND i.status=\'approved\' AND p.amount_cents>0 ORDER BY p.id LIMIT 1').get(sale.id);
    if (receipt) {
      const allocationId = Number(db.prepare("INSERT INTO budget_allocations(company_id,centre_id,source_type,source_id,source_date,amount_cents,basis,status,client_reference,created_by,reviewed_by,review_reason,reviewed_at) VALUES (1,?,?,?,?,?,?,'approved',?,?,?,'Synthetic demo source review',CURRENT_TIMESTAMP)")
        .run(centreId,'sale_receipt',receipt.id,receipt.payment_date,receipt.amount_cents,'Whole recorded invoice payment attributed to branch operations',`DEMO-BUDGET-sale_receipt-${receipt.id}`,staff.id,accountant.id).lastInsertRowid);
      db.prepare("INSERT INTO budget_events(company_id,entity_type,entity_id,action,actor_id,details) VALUES (1,'allocation',?,'approved',?,'Synthetic demo allocation review')").run(allocationId,accountant.id);
    }
    db.exec('RELEASE seed_budgets_demo');
    return true;
  } catch (error) {
    db.exec('ROLLBACK TO seed_budgets_demo');
    db.exec('RELEASE seed_budgets_demo');
    throw error;
  }
}

module.exports = { installBudgetsSchema, seedBudgetsDemo };
