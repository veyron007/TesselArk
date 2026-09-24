function installReturnsQuarantineSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS return_quarantine_receipts (
      id INTEGER PRIMARY KEY,
      company_id INTEGER NOT NULL REFERENCES companies(id),
      return_line_id INTEGER NOT NULL REFERENCES return_lines(id),
      source_stock_movement_id INTEGER NOT NULL REFERENCES stock_movements(id),
      batch_id INTEGER REFERENCES batch_lots(id),
      branch_id INTEGER NOT NULL REFERENCES branches(id),
      item_id INTEGER NOT NULL REFERENCES items(id),
      quantity INTEGER NOT NULL CHECK(quantity > 0),
      status TEXT NOT NULL DEFAULT 'quarantined' CHECK(status IN ('quarantined','released','rejected')),
      reviewed_by INTEGER REFERENCES users(id),
      reviewed_at TEXT,
      review_reason TEXT,
      release_stock_movement_id INTEGER UNIQUE REFERENCES stock_movements(id),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(return_line_id,source_stock_movement_id)
    );
    CREATE TABLE IF NOT EXISTS return_quarantine_events (
      id INTEGER PRIMARY KEY,
      company_id INTEGER NOT NULL REFERENCES companies(id),
      receipt_id INTEGER NOT NULL REFERENCES return_quarantine_receipts(id),
      action TEXT NOT NULL CHECK(action IN ('receive','release','reject')),
      actor_id INTEGER NOT NULL REFERENCES users(id),
      details TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_return_quarantine_scope ON return_quarantine_receipts(company_id,branch_id,status);
    CREATE INDEX IF NOT EXISTS idx_return_quarantine_source ON return_quarantine_receipts(source_stock_movement_id);
  `);
}

function seedQuarantineSpecimen(db) {
  const number='DEMO-CRN-MUM-QA-001';
  if (db.prepare('SELECT 1 FROM returns WHERE company_id=1 AND number=?').get(number)) return;
  const invoice=db.prepare("SELECT id,branch_id FROM invoices WHERE company_id=1 AND type='sale' AND status='approved' AND number='DEMO-MUM-201'").get();
  if (!invoice) return;
  const line=db.prepare('SELECT id,item_id,quantity,subtotal_cents,tax_cents FROM invoice_lines WHERE invoice_id=? ORDER BY id LIMIT 1').get(invoice.id);
  if (!line) return;
  const already=db.prepare("SELECT COALESCE(SUM(rl.quantity),0) AS quantity FROM return_lines rl JOIN returns r ON r.id=rl.return_id WHERE r.invoice_id=? AND r.status='approved'").get(invoice.id).quantity;
  const source=db.prepare("SELECT id,quantity_delta FROM stock_movements WHERE invoice_id=? AND item_id=? AND branch_id=? AND quantity_delta<0 AND type='sale' ORDER BY id LIMIT 1").get(invoice.id,line.item_id,invoice.branch_id);
  if (!source || already >= line.quantity || -source.quantity_delta < already+1) return;
  const subtotal=Math.round(line.subtotal_cents*(already+1)/line.quantity)-Math.round(line.subtotal_cents*already/line.quantity);
  const tax=Math.round(line.tax_cents*(already+1)/line.quantity)-Math.round(line.tax_cents*already/line.quantity);
  db.exec('BEGIN IMMEDIATE');
  try {
    const returnId=Number(db.prepare("INSERT INTO returns(company_id,invoice_id,number,kind,status,reason,subtotal_cents,tax_proposal_cents,total_proposal_cents,created_by,approved_by,approved_at) VALUES (1,?,?,'sales_return','approved','Synthetic customer return awaiting inspection',?,?,?,1,2,CURRENT_TIMESTAMP)")
      .run(invoice.id,number,subtotal,tax,subtotal+tax).lastInsertRowid);
    const lineId=Number(db.prepare('INSERT INTO return_lines(return_id,invoice_line_id,item_id,quantity,subtotal_cents,tax_proposal_cents) VALUES (?,?,?,1,?,?)')
      .run(returnId,line.id,line.item_id,subtotal,tax).lastInsertRowid);
    const receiptId=Number(db.prepare('INSERT INTO return_quarantine_receipts(company_id,return_line_id,source_stock_movement_id,branch_id,item_id,quantity) VALUES (1,?,?,?,?,1)')
      .run(lineId,source.id,invoice.branch_id,line.item_id).lastInsertRowid);
    db.prepare("INSERT INTO return_quarantine_events(company_id,receipt_id,action,actor_id,details) VALUES (1,?,'receive',2,?)")
      .run(receiptId,`Approved synthetic return ${number}; stock held for inspection`);
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}

module.exports = { installReturnsQuarantineSchema, seedQuarantineSpecimen };
