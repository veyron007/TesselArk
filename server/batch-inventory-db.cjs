function installBatchInventorySchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS batch_lots (
      id INTEGER PRIMARY KEY,
      company_id INTEGER NOT NULL REFERENCES companies(id),
      item_id INTEGER NOT NULL REFERENCES items(id),
      batch_code TEXT NOT NULL,
      manufactured_on TEXT,
      expires_on TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(company_id,item_id,batch_code)
    );
    CREATE TABLE IF NOT EXISTS batch_movements (
      id INTEGER PRIMARY KEY,
      company_id INTEGER NOT NULL REFERENCES companies(id),
      batch_id INTEGER NOT NULL REFERENCES batch_lots(id),
      branch_id INTEGER NOT NULL REFERENCES branches(id),
      gstin_id INTEGER NOT NULL REFERENCES gstins(id),
      quantity_delta INTEGER NOT NULL CHECK(quantity_delta<>0),
      type TEXT NOT NULL CHECK(type IN ('receipt','issue','transfer_in','transfer_out')),
      is_allocation INTEGER NOT NULL DEFAULT 0 CHECK(is_allocation IN (0,1)),
      reason TEXT NOT NULL,
      request_signature TEXT NOT NULL,
      operation_reference TEXT NOT NULL,
      stock_movement_id INTEGER NOT NULL UNIQUE REFERENCES stock_movements(id),
      recorded_by INTEGER NOT NULL REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_batch_movements_scope ON batch_movements(company_id,batch_id,branch_id);
    CREATE INDEX IF NOT EXISTS idx_batch_lots_expiry ON batch_lots(company_id,expires_on);
    CREATE UNIQUE INDEX IF NOT EXISTS uq_batch_operation_leg ON batch_movements(company_id,operation_reference,type);
    CREATE TABLE IF NOT EXISTS batch_issue_operations (
      id INTEGER PRIMARY KEY,
      company_id INTEGER NOT NULL REFERENCES companies(id),
      source_reference TEXT NOT NULL,
      request_signature TEXT NOT NULL,
      result_json TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(company_id,source_reference)
    );
  `);
  if (!db.prepare('PRAGMA table_info(batch_movements)').all().some(row => row.name === 'request_signature')) db.exec("ALTER TABLE batch_movements ADD COLUMN request_signature TEXT NOT NULL DEFAULT ''");
  if (!db.prepare('PRAGMA table_info(batch_movements)').all().some(row => row.name === 'is_allocation')) db.exec('ALTER TABLE batch_movements ADD COLUMN is_allocation INTEGER NOT NULL DEFAULT 0 CHECK(is_allocation IN (0,1))');
}

function seedBatchSpecimen(db) {
  const companyId = 1, branchId = 1, itemId = 2, quantity = 6;
  const batchCode = 'DEMO-SALINE-NEAR-EXPIRY';
  if (db.prepare('SELECT 1 FROM batch_lots WHERE company_id=? AND item_id=? AND batch_code=?').get(companyId,itemId,batchCode)) return;
  const branch = db.prepare('SELECT gstin_id FROM branches WHERE id=? AND company_id=?').get(branchId,companyId);
  const user = db.prepare('SELECT id FROM users WHERE id=1 AND company_id=?').get(companyId);
  if (!branch || !user) return;
  const total = db.prepare('SELECT COALESCE(SUM(quantity_delta),0) AS q FROM stock_movements WHERE company_id=? AND branch_id=? AND item_id=?').get(companyId,branchId,itemId).q;
  const allocated = db.prepare('SELECT COALESCE(SUM(m.quantity_delta),0) AS q FROM batch_movements m JOIN batch_lots l ON l.id=m.batch_id WHERE m.company_id=? AND m.branch_id=? AND l.item_id=?').get(companyId,branchId,itemId).q;
  if (total-allocated < quantity) return;
  const expiresOn = new Date(Date.now()+14*86400000).toISOString().slice(0,10);
  const reason = 'Synthetic demo allocation from existing stock; no new physical receipt';
  const op = 'batch:assign:DEMO-SALINE-NEAR-EXPIRY';
  db.exec('BEGIN IMMEDIATE');
  try {
    const batchId = Number(db.prepare('INSERT INTO batch_lots(company_id,item_id,batch_code,expires_on) VALUES (?,?,?,?)').run(companyId,itemId,batchCode,expiresOn).lastInsertRowid);
    const stockMovementId = Number(db.prepare('INSERT INTO stock_movements(company_id,branch_id,item_id,quantity_delta,type,reason,client_reference) VALUES (?,?,?,?,?,?,?)')
      .run(companyId,branchId,itemId,0,'batch_assignment',reason,`${op}:allocation`).lastInsertRowid);
    db.prepare('INSERT INTO batch_movements(company_id,batch_id,branch_id,gstin_id,quantity_delta,type,is_allocation,reason,request_signature,operation_reference,stock_movement_id,recorded_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(companyId,batchId,branchId,branch.gstin_id,quantity,'receipt',1,reason,JSON.stringify({ syntheticDemo:true }),op,stockMovementId,user.id);
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}

module.exports = { installBatchInventorySchema, seedBatchSpecimen };
