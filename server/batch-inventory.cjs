const crypto = require('node:crypto');
const { allowedScopes, assertScopeAccess, assertGstinAccess } = require('./access.cjs');
const { installLocationsSchema } = require('./locations-db.cjs');

const bad = (message, status = 400) => Object.assign(new Error(message), { status });
const integer = (value, name, min = 1) => {
  if (!Number.isSafeInteger(value) || value < min) throw bad(`${name} must be an integer of at least ${min}`);
  return value;
};
const string = (value, name, max = 200) => {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw bad(`${name} is invalid`);
  return value.trim();
};
const isoDate = (value, name, optional = false) => {
  if (optional && (value === undefined || value === null || value === '')) return null;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
      Number.isNaN(Date.parse(`${value}T00:00:00Z`)) ||
      new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value) throw bad(`${name} must be a valid YYYY-MM-DD date`);
  return value;
};
const fields = row => Object.fromEntries(Object.entries(row).map(([key, value]) => [key.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase()), value]));
const transaction = (db, action) => {
  db.exec('BEGIN IMMEDIATE');
  try { const result = action(); db.exec('COMMIT'); return result; }
  catch (error) { db.exec('ROLLBACK'); throw error; }
};

function allocateBatchIssue(db, input) {
  const execute = () => {
    const companyId = integer(input.companyId,'companyId');
    const branchId = integer(input.branchId,'branchId');
    const itemId = integer(input.itemId,'itemId');
    const quantity = integer(input.quantity,'quantity');
    const userId = integer(input.userId,'userId');
    const reason = string(input.reason,'reason',500);
    const sourceReference = string(input.sourceReference,'sourceReference',160);
    const movementType = string(input.movementType || 'sale','movementType',60);
    const allowExpired = input.allowExpired === true;
    const invoiceId = input.invoiceId === undefined || input.invoiceId === null ? null : integer(input.invoiceId,'invoiceId');
    const signature = JSON.stringify({ branchId,itemId,quantity,userId,reason,movementType,invoiceId,allowExpired });
    const existing = db.prepare('SELECT * FROM batch_issue_operations WHERE company_id=? AND source_reference=?').get(companyId,sourceReference);
    if (existing) {
      if (existing.request_signature !== signature) throw bad('Source reference already used for a different stock issue',409);
      return { ...JSON.parse(existing.result_json), replayed:true };
    }
    const branch = db.prepare('SELECT id,gstin_id FROM branches WHERE company_id=? AND id=?').get(companyId,branchId);
    const item = db.prepare('SELECT id,track_stock FROM items WHERE company_id=? AND id=?').get(companyId,itemId);
    const user = db.prepare('SELECT id FROM users WHERE company_id=? AND id=?').get(companyId,userId);
    if (!branch || !item || !user) throw bad('Company, branch, item, or user scope is invalid',404);
    if (!item.track_stock) throw bad('Service items cannot issue stock');
    const total = db.prepare('SELECT COALESCE(SUM(quantity_delta),0) AS quantity FROM stock_movements WHERE company_id=? AND branch_id=? AND item_id=?').get(companyId,branchId,itemId).quantity;
    if (total < quantity) throw bad('Insufficient branch stock',409);
    const lots = db.prepare(`SELECT l.id,l.batch_code,l.expires_on,COALESCE(SUM(m.quantity_delta),0) AS quantity
      FROM batch_lots l LEFT JOIN batch_movements m ON m.batch_id=l.id AND m.branch_id=?
      WHERE l.company_id=? AND l.item_id=? GROUP BY l.id HAVING quantity>0 ORDER BY l.expires_on,l.id`).all(branchId,companyId,itemId);
    const allBatchQuantity = lots.reduce((sum,row) => sum + row.quantity,0);
    const unbatchedAvailable = Math.max(0,total-allBatchQuantity);
    const today = new Date().toISOString().slice(0,10);
    const eligible = allowExpired ? lots : lots.filter(row => row.expires_on >= today);
    if (eligible.reduce((sum,row) => sum + row.quantity,unbatchedAvailable) < quantity) throw bad('Insufficient unexpired allocated or unbatched stock',409);
    let remaining = quantity;
    const stockMovementIds = [];
    const batchLegs = [];
    for (const lot of eligible) {
      if (!remaining) break;
      const units = Math.min(remaining,lot.quantity);
      const stockReference = `${sourceReference}:batch:${lot.id}`;
      const stockMovementId = Number(db.prepare('INSERT INTO stock_movements(company_id,branch_id,item_id,quantity_delta,type,reason,client_reference,invoice_id) VALUES (?,?,?,?,?,?,?,?)')
        .run(companyId,branchId,itemId,-units,movementType,reason,stockReference,invoiceId).lastInsertRowid);
      db.prepare('INSERT INTO batch_movements(company_id,batch_id,branch_id,gstin_id,quantity_delta,type,reason,request_signature,operation_reference,stock_movement_id,recorded_by) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
        .run(companyId,lot.id,branchId,branch.gstin_id,-units,'issue',reason,signature,`batch:auto:${sourceReference}:${lot.id}`,stockMovementId,userId);
      stockMovementIds.push(stockMovementId);
      batchLegs.push({ batchId:lot.id,batchCode:lot.batch_code,quantity:units,stockMovementId });
      remaining -= units;
    }
    if (remaining > unbatchedAvailable) throw bad('Insufficient unbatched stock after batch allocation',409);
    if (remaining) {
      const stockMovementId = Number(db.prepare('INSERT INTO stock_movements(company_id,branch_id,item_id,quantity_delta,type,reason,client_reference,invoice_id) VALUES (?,?,?,?,?,?,?,?)')
        .run(companyId,branchId,itemId,-remaining,movementType,reason,`${sourceReference}:unbatched`,invoiceId).lastInsertRowid);
      stockMovementIds.push(stockMovementId);
    }
    const result = { stockMovementIds,firstStockMovementId:stockMovementIds[0],batchAllocated:quantity-remaining,unbatched:remaining,batchLegs,sourceReference };
    db.prepare('INSERT INTO batch_issue_operations(company_id,source_reference,request_signature,result_json) VALUES (?,?,?,?)')
      .run(companyId,sourceReference,signature,JSON.stringify(result));
    return { ...result,replayed:false };
  };
  return db.isTransaction ? execute() : transaction(db,execute);
}

function registerBatchInventoryRoutes(app, db) {
  installLocationsSchema(db);
  const route = handler => (req, res, next) => { try { res.json(handler(req)); } catch (error) { next(error); } };
  const scope = (req,row) => assertScopeAccess(db,{companyId:req.company.id,userId:req.user.id,gstinId:row.gstin_id,branchId:row.id});
  const visible = req => (req.scopes || allowedScopes(db,{companyId:req.company.id,userId:req.user.id})).branchIds;
  const branch = (companyId, id) => {
    const row = db.prepare('SELECT * FROM branches WHERE company_id=? AND id=?').get(companyId, integer(id, 'branchId'));
    if (!row) throw bad('Branch not found in selected company', 404);
    return row;
  };
  const item = (companyId, id) => {
    const row = db.prepare('SELECT * FROM items WHERE company_id=? AND id=?').get(companyId, integer(id, 'itemId'));
    if (!row) throw bad('Item not found in selected company', 404);
    if (!row.track_stock) throw bad('Service items cannot have batches');
    return row;
  };
  const lot = (companyId, id) => {
    const row = db.prepare('SELECT * FROM batch_lots WHERE company_id=? AND id=?').get(companyId, integer(id, 'batchId'));
    if (!row) throw bad('Batch not found in selected company', 404);
    return row;
  };
  const stock = (companyId, branchId, itemId) => db.prepare('SELECT COALESCE(SUM(quantity_delta),0) AS quantity FROM stock_movements WHERE company_id=? AND branch_id=? AND item_id=?').get(companyId, branchId, itemId).quantity;
  const batchStock = (batchId, branchId) => db.prepare('SELECT COALESCE(SUM(quantity_delta),0) AS quantity FROM batch_movements WHERE batch_id=? AND branch_id=?').get(batchId, branchId).quantity;
  const clientReference = value => value === undefined || value === '' ? null : string(value, 'clientReference', 100);
  const opReference = (kind, reference) => reference ? `batch:${kind}:${reference}` : `batch:${kind}:${crypto.randomUUID()}`;
  const replay = (companyId, op, signature) => {
    const row = db.prepare('SELECT * FROM batch_movements WHERE company_id=? AND operation_reference=? LIMIT 1').get(companyId, op);
    if (!row) return null;
    if (row.request_signature !== signature) throw bad('Client reference already used for a different batch operation', 409);
    return { operationReference: op, replayed: true };
  };
  const postMovement = ({ companyId, batchId, branchRow, itemId, delta, type, reason, sig, op, userId, leg }) => {
    const stockReference = `${op}:${leg}`;
    const movementId = Number(db.prepare('INSERT INTO stock_movements(company_id,branch_id,item_id,quantity_delta,type,reason,client_reference) VALUES (?,?,?,?,?,?,?)')
      .run(companyId, branchRow.id, itemId, delta, `batch_${type}`, reason, stockReference).lastInsertRowid);
    const id = Number(db.prepare('INSERT INTO batch_movements(company_id,batch_id,branch_id,gstin_id,quantity_delta,type,reason,request_signature,operation_reference,stock_movement_id,recorded_by) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
      .run(companyId, batchId, branchRow.id, branchRow.gstin_id, delta, type, reason, sig, op, movementId, userId).lastInsertRowid);
    return { batchMovementId: id, stockMovementId: movementId };
  };
  const signature = (...values) => JSON.stringify(values);

  const receiveInput = (body, companyId) => {
    const itemRow = item(companyId, body.itemId), branchRow = branch(companyId, body.branchId);
    if (body.gstinId !== undefined && integer(body.gstinId, 'gstinId') !== branchRow.gstin_id) throw bad('GSTIN does not match branch');
    const batchCode = string(body.batchCode, 'batchCode', 80);
    const manufacturedOn = isoDate(body.manufacturedOn, 'manufacturedOn', true);
    const expiresOn = isoDate(body.expiresOn, 'expiresOn');
    if (manufacturedOn && manufacturedOn > expiresOn) throw bad('Manufacture date cannot follow expiry date');
    const quantity = integer(body.quantity, 'quantity'), reason = string(body.reason, 'reason', 500);
    return { itemRow,branchRow,batchCode,manufacturedOn,expiresOn,quantity,reason,reference:clientReference(body.clientReference) };
  };
  const resolveLot = (companyId, value) => {
    let batch = db.prepare('SELECT * FROM batch_lots WHERE company_id=? AND item_id=? AND batch_code=?').get(companyId,value.itemRow.id,value.batchCode);
    if (batch && (batch.manufactured_on !== value.manufacturedOn || batch.expires_on !== value.expiresOn)) throw bad('Batch identifier already exists with different dates', 409);
    if (!batch) {
      const id = Number(db.prepare('INSERT INTO batch_lots(company_id,item_id,batch_code,manufactured_on,expires_on) VALUES (?,?,?,?,?)')
        .run(companyId,value.itemRow.id,value.batchCode,value.manufacturedOn,value.expiresOn).lastInsertRowid);
      batch = lot(companyId,id);
    }
    return batch;
  };

  app.get('/api/batches', route(req => {
    const companyId = req.company.id;
    const branchId = req.query.branchId === undefined ? null : integer(Number(req.query.branchId), 'branchId');
    if (branchId !== null) scope(req,branch(companyId, branchId));
    const gstinId = req.query.gstinId === undefined ? null : integer(Number(req.query.gstinId), 'gstinId');
    if (gstinId !== null && !db.prepare('SELECT 1 FROM gstins WHERE company_id=? AND id=?').get(companyId,gstinId)) throw bad('GSTIN not found in selected company', 404);
    if (gstinId !== null) assertGstinAccess(db,{companyId,userId:req.user.id,gstinId});
    const branches=visible(req);
    const days = req.query.expiringWithinDays === undefined ? 30 : integer(Number(req.query.expiringWithinDays), 'expiringWithinDays', 0);
    if (days > 3650) throw bad('expiringWithinDays must be at most 3650');
    const rows = db.prepare(`SELECT l.id,l.company_id,l.item_id,i.sku,i.name AS item_name,l.batch_code,l.manufactured_on,l.expires_on,
      b.id AS branch_id,b.name AS branch_name,b.gstin_id,g.gstin,COALESCE(SUM(m.quantity_delta),0) AS quantity
      FROM batch_lots l JOIN items i ON i.id=l.item_id JOIN branches b ON b.company_id=l.company_id
      JOIN gstins g ON g.id=b.gstin_id LEFT JOIN batch_movements m ON m.batch_id=l.id AND m.branch_id=b.id
      WHERE l.company_id=? AND b.id IN (${branches.map(()=>'?').join(',') || 'NULL'}) AND (? IS NULL OR b.id=?) AND (? IS NULL OR b.gstin_id=?)
      GROUP BY l.id,b.id HAVING quantity<>0 ORDER BY l.expires_on,l.batch_code,b.name`).all(companyId,...branches,branchId,branchId,gstinId,gstinId).map(fields);
    const cutoff = new Date(Date.now() + days * 86400000).toISOString().slice(0,10);
    const expiring = rows.filter(row => row.quantity > 0 && row.expiresOn <= cutoff);
    const ledger = db.prepare(`SELECT m.*,l.batch_code,l.expires_on,i.sku,i.name AS item_name,b.name AS branch_name,g.gstin
      FROM batch_movements m JOIN batch_lots l ON l.id=m.batch_id JOIN items i ON i.id=l.item_id
      JOIN branches b ON b.id=m.branch_id JOIN gstins g ON g.id=m.gstin_id
      WHERE m.company_id=? AND m.branch_id IN (${branches.map(()=>'?').join(',') || 'NULL'}) AND (? IS NULL OR m.branch_id=?) AND (? IS NULL OR m.gstin_id=?)
      ORDER BY m.id DESC LIMIT 200`).all(companyId,...branches,branchId,branchId,gstinId,gstinId).map(fields);
    return { batches: rows, expiring, ledger, expiringWithinDays: days };
  }));

  app.post('/api/batches/receive', route(req => transaction(db, () => {
    const body = req.body || {}, companyId = req.company.id;
    const value = receiveInput(body,companyId);
    const { itemRow,branchRow,batchCode,manufacturedOn,expiresOn,quantity,reason,reference } = value;
    scope(req,branchRow);
    const op = opReference('receipt', reference);
    const sig = signature(itemRow.id,branchRow.id,batchCode,manufacturedOn,expiresOn,quantity,reason);
    if (reference) { const existing = replay(companyId,op,sig); if (existing) return existing; }
    const batch = resolveLot(companyId,value);
    const movement = postMovement({ companyId,batchId:batch.id,branchRow,itemId:itemRow.id,delta:quantity,type:'receipt',reason,sig,op,userId:req.user.id,leg:'receipt' });
    return { operationReference:op,batch:fields(batch),movement,quantity:batchStock(batch.id,branchRow.id),branchStock:stock(companyId,branchRow.id,itemRow.id),replayed:false };
  })));

  app.post('/api/batches/assign', route(req => transaction(db, () => {
    const companyId = req.company.id, value = receiveInput(req.body || {},companyId);
    const { itemRow,branchRow,batchCode,manufacturedOn,expiresOn,quantity,reason,reference } = value;
    scope(req,branchRow);
    const op = opReference('assign',reference);
    const sig = signature(itemRow.id,branchRow.id,batchCode,manufacturedOn,expiresOn,quantity,reason);
    if (reference) { const existing = replay(companyId,op,sig); if (existing) return existing; }
    const allocated = db.prepare(`SELECT COALESCE(SUM(m.quantity_delta),0) AS quantity FROM batch_movements m
      JOIN batch_lots l ON l.id=m.batch_id WHERE m.company_id=? AND m.branch_id=? AND l.item_id=?`).get(companyId,branchRow.id,itemRow.id).quantity;
    const located = db.prepare(`SELECT COALESCE(SUM(m.quantity_delta),0) AS quantity FROM location_movements m
      JOIN locations l ON l.id=m.location_id WHERE m.company_id=? AND l.branch_id=? AND m.item_id=?`).get(companyId,branchRow.id,itemRow.id).quantity;
    const unbatched = stock(companyId,branchRow.id,itemRow.id)-allocated-located;
    if (unbatched < quantity) throw bad('Insufficient existing unbatched stock to assign',409);
    const batch = resolveLot(companyId,value);
    const stockMovementId = Number(db.prepare('INSERT INTO stock_movements(company_id,branch_id,item_id,quantity_delta,type,reason,client_reference) VALUES (?,?,?,?,?,?,?)')
      .run(companyId,branchRow.id,itemRow.id,0,'batch_assignment',reason,`${op}:allocation`).lastInsertRowid);
    const batchMovementId = Number(db.prepare('INSERT INTO batch_movements(company_id,batch_id,branch_id,gstin_id,quantity_delta,type,is_allocation,reason,request_signature,operation_reference,stock_movement_id,recorded_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(companyId,batch.id,branchRow.id,branchRow.gstin_id,quantity,'receipt',1,reason,sig,op,stockMovementId,req.user.id).lastInsertRowid);
    return { operationReference:op,batch:fields(batch),movement:{ batchMovementId,stockMovementId },quantity:batchStock(batch.id,branchRow.id),branchStock:stock(companyId,branchRow.id,itemRow.id),unbatchedStock:unbatched-quantity,replayed:false };
  })));

  app.post('/api/batches/:id/issue', route(req => transaction(db, () => {
    const body = req.body || {}, companyId = req.company.id, batch = lot(companyId,Number(req.params.id));
    const branchRow = branch(companyId,body.branchId), quantity = integer(body.quantity,'quantity'), reason = string(body.reason,'reason',500);
    scope(req,branchRow);
    const reference = clientReference(body.clientReference), op = opReference('issue',reference);
    const sig = signature(batch.id,branchRow.id,quantity,reason);
    if (reference) { const existing = replay(companyId,op,sig); if (existing) return existing; }
    const today = new Date().toISOString().slice(0,10);
    if (batch.expires_on < today) throw bad('Expired batch cannot be issued',409);
    if (batchStock(batch.id,branchRow.id) < quantity || stock(companyId,branchRow.id,batch.item_id) < quantity) throw bad('Insufficient batch or branch stock',409);
    const movement = postMovement({ companyId,batchId:batch.id,branchRow,itemId:batch.item_id,delta:-quantity,type:'issue',reason,sig,op,userId:req.user.id,leg:'issue' });
    return { operationReference:op,movement,quantity:batchStock(batch.id,branchRow.id),branchStock:stock(companyId,branchRow.id,batch.item_id),replayed:false };
  })));

  app.post('/api/batches/:id/transfer', route(req => transaction(db, () => {
    const body = req.body || {}, companyId = req.company.id, batch = lot(companyId,Number(req.params.id));
    const from = branch(companyId,body.fromBranchId), to = branch(companyId,body.toBranchId);
    scope(req,from); scope(req,to);
    if (from.id === to.id) throw bad('Transfer branches must differ');
    const quantity = integer(body.quantity,'quantity'), reason = string(body.reason,'reason',500);
    const reference = clientReference(body.clientReference), op = opReference('transfer',reference);
    const sig = signature(batch.id,from.id,to.id,quantity,reason);
    if (reference) { const existing = replay(companyId,op,sig); if (existing) return existing; }
    if (batchStock(batch.id,from.id) < quantity || stock(companyId,from.id,batch.item_id) < quantity) throw bad('Insufficient batch or branch stock',409);
    const source = postMovement({ companyId,batchId:batch.id,branchRow:from,itemId:batch.item_id,delta:-quantity,type:'transfer_out',reason,sig,op,userId:req.user.id,leg:'out' });
    const destination = postMovement({ companyId,batchId:batch.id,branchRow:to,itemId:batch.item_id,delta:quantity,type:'transfer_in',reason,sig,op,userId:req.user.id,leg:'in' });
    return { operationReference:op,source,destination,sourceQuantity:batchStock(batch.id,from.id),destinationQuantity:batchStock(batch.id,to.id),replayed:false };
  })));
}

module.exports = { registerBatchInventoryRoutes, allocateBatchIssue };
