const { installReturnsSchema } = require('./returns-db.cjs');
const { installReturnsQuarantineSchema } = require('./returns-quarantine-db.cjs');
const { allocateBatchIssue } = require('./batch-inventory.cjs');
const { allowedScopes, assertScopeAccess, assertGstinAccess } = require('./access.cjs');

const bad = (message, status = 400) => Object.assign(new Error(message), { status });
const positive = (value, name) => {
  if (!Number.isSafeInteger(value) || value < 1) throw bad(`${name} must be a positive integer`);
  return value;
};
const fields = row => Object.fromEntries(Object.entries(row).map(([key,value]) => [key.replace(/_([a-z])/g, (_,letter) => letter.toUpperCase()),value]));

function registerReturnsRoutes(app, db) {
  installReturnsSchema(db);
  installReturnsQuarantineSchema(db);
  const route = handler => (req,res,next) => { try { res.json(handler(req)); } catch (error) { next(error); } };
  const atomic = work => {
    db.exec('BEGIN IMMEDIATE');
    try { const result = work(); db.exec('COMMIT'); return result; }
    catch (error) { db.exec('ROLLBACK'); throw error; }
  };
  const scope = (req,row) => assertScopeAccess(db,{companyId:req.company.id,userId:req.user.id,gstinId:row.gstin_id,branchId:row.branch_id});
  const visible = req => (req.scopes || allowedScopes(db,{companyId:req.company.id,userId:req.user.id})).branchIds;
  const detail = (id, companyId) => {
    const row = db.prepare(`SELECT r.*,v.number AS invoice_number,v.type AS invoice_type,v.status AS invoice_status,v.invoice_date,v.branch_id,v.gstin_id,COALESCE(NULLIF(v.party_name_snapshot,''),p.name) AS party_name,b.name AS branch_name,g.gstin
      FROM returns r JOIN invoices v ON v.id=r.invoice_id JOIN parties p ON p.id=v.party_id JOIN branches b ON b.id=v.branch_id JOIN gstins g ON g.id=v.gstin_id
      WHERE r.id=? AND r.company_id=?`).get(id,companyId);
    if (!row) throw bad('Return not found in selected company',404);
    const period = db.prepare('SELECT status FROM gst_periods WHERE company_id=? AND gstin_id=? AND period=?').get(companyId,row.gstin_id,row.invoice_date.slice(0,7));
    return { ...fields(row), sourcePeriodStatus:period?.status || 'open', lines:db.prepare(`SELECT l.*,i.name AS item_name,i.sku,il.quantity AS source_quantity,il.unit_price_cents,il.tax_cents AS source_tax_cents
      FROM return_lines l JOIN items i ON i.id=l.item_id JOIN invoice_lines il ON il.id=l.invoice_line_id WHERE l.return_id=? ORDER BY l.id`).all(id).map(fields) };
  };
  const priorQuantity = lineId => db.prepare(`SELECT COALESCE(SUM(l.quantity),0) AS quantity FROM return_lines l JOIN returns r ON r.id=l.return_id WHERE l.invoice_line_id=? AND r.status='approved'`).get(lineId).quantity;
  const sourceLine = (invoiceId, lineId) => db.prepare('SELECT * FROM invoice_lines WHERE id=? AND invoice_id=?').get(lineId,invoiceId);
  const amountFor = (line, quantity, alreadyReturned) => {
    // Cumulative rounding ensures a full return reverses exactly the source line cents.
    const subtotal = Math.round(line.subtotal_cents * (alreadyReturned + quantity) / line.quantity) - Math.round(line.subtotal_cents * alreadyReturned / line.quantity);
    const tax = Math.round(line.tax_cents * (alreadyReturned + quantity) / line.quantity) - Math.round(line.tax_cents * alreadyReturned / line.quantity);
    return { subtotal, tax };
  };
  const quarantineDetail = row => ({ ...fields(row), events:db.prepare('SELECT action,actor_id,details,created_at FROM return_quarantine_events WHERE receipt_id=? ORDER BY id').all(row.id).map(fields) });
  const outboundLegs = (invoice, itemId) => {
    const fulfillment = invoice.fulfillment_id;
    const linked = fulfillment ? db.prepare(`SELECT m.id,m.quantity_delta,m.branch_id,m.item_id,b.batch_id
      FROM order_fulfillment_lines fl JOIN invoice_lines il ON il.fulfillment_line_id=fl.id
      JOIN stock_movements m ON (m.client_reference='order-fulfillment:' || fl.fulfillment_id || ':line:' || fl.id
        OR m.client_reference LIKE 'order-fulfillment:' || fl.fulfillment_id || ':line:' || fl.id || ':%')
      LEFT JOIN batch_movements b ON b.stock_movement_id=m.id
      WHERE il.invoice_id=? AND il.item_id=? AND m.company_id=? AND m.quantity_delta<0 AND m.branch_id=? ORDER BY m.id`)
      .all(invoice.id,itemId,invoice.company_id,invoice.branch_id) : [];
    if (linked.length) return linked;
    return db.prepare(`SELECT m.id,m.quantity_delta,m.branch_id,m.item_id,b.batch_id FROM stock_movements m
      LEFT JOIN batch_movements b ON b.stock_movement_id=m.id
      WHERE m.invoice_id=? AND m.company_id=? AND m.branch_id=? AND m.item_id=? AND m.quantity_delta<0
      AND m.type IN ('sale','sales_dispatch') ORDER BY m.id`).all(invoice.id,invoice.company_id,invoice.branch_id,itemId);
  };
  const quarantineReturn = (record, invoice, line, actorId, consumed) => {
    const legs = outboundLegs(invoice,line.item_id);
    if (!legs.length) throw bad('Sales return requires traceable outbound stock movement',409);
    let skip = consumed, remaining = line.quantity;
    for (const leg of legs) {
      const available = -leg.quantity_delta;
      const fromLeg = Math.min(Math.max(available-skip,0),remaining);
      skip = Math.max(skip-available,0);
      if (!fromLeg) continue;
      const receiptId = Number(db.prepare(`INSERT INTO return_quarantine_receipts(company_id,return_line_id,source_stock_movement_id,batch_id,branch_id,item_id,quantity)
        VALUES (?,?,?,?,?,?,?)`).run(invoice.company_id,line.id,leg.id,leg.batch_id,invoice.branch_id,line.item_id,fromLeg).lastInsertRowid);
      db.prepare(`INSERT INTO return_quarantine_events(company_id,receipt_id,action,actor_id,details) VALUES (?,?,'receive',?,?)`)
        .run(invoice.company_id,receiptId,actorId,`Approved return ${record.number}; physical receipt held outside saleable stock`);
      remaining -= fromLeg;
      if (!remaining) break;
    }
    if (remaining) throw bad('Returned quantity exceeds traceable outbound units',409);
  };

  app.get('/api/returns', route(req => {
    const companyId = req.company.id;
    const branchId = req.query.branchId ? positive(Number(req.query.branchId),'branchId') : null;
    const gstinId = req.query.gstinId ? positive(Number(req.query.gstinId),'gstinId') : null;
    if (branchId && !db.prepare('SELECT 1 FROM branches WHERE id=? AND company_id=?').get(branchId,companyId)) throw bad('Branch not found in selected company',404);
    if (gstinId && !db.prepare('SELECT 1 FROM gstins WHERE id=? AND company_id=?').get(gstinId,companyId)) throw bad('GSTIN not found in selected company',404);
    if (gstinId) assertGstinAccess(db,{companyId,userId:req.user.id,gstinId});
    if (branchId) scope(req,{gstin_id:gstinId ?? undefined,branch_id:branchId});
    const branches=visible(req);
    const rows = db.prepare(`SELECT r.id FROM returns r JOIN invoices v ON v.id=r.invoice_id WHERE r.company_id=? AND v.branch_id IN (${branches.map(()=>'?').join(',') || 'NULL'}) AND (? IS NULL OR v.branch_id=?) AND (? IS NULL OR v.gstin_id=?) ORDER BY r.id DESC`).all(companyId,...branches,branchId,branchId,gstinId,gstinId);
    return { returns:rows.map(row => detail(row.id,companyId)) };
  }));

  app.get('/api/returns/quarantine', route(req => {
    const companyId=req.company.id;
    const branchId=req.query.branchId ? positive(Number(req.query.branchId),'branchId') : null;
    if (branchId && !db.prepare('SELECT 1 FROM branches WHERE id=? AND company_id=?').get(branchId,companyId)) throw bad('Branch not found in selected company',404);
    if (branchId) scope(req,{branch_id:branchId});
    const branches=visible(req);
    const rows=db.prepare(`SELECT q.*,r.number AS return_number,v.number AS invoice_number,l.batch_code,i.name AS item_name,i.sku
      FROM return_quarantine_receipts q JOIN return_lines rl ON rl.id=q.return_line_id JOIN returns r ON r.id=rl.return_id
      JOIN invoices v ON v.id=r.invoice_id JOIN items i ON i.id=q.item_id LEFT JOIN batch_lots l ON l.id=q.batch_id
      WHERE q.company_id=? AND q.branch_id IN (${branches.map(()=>'?').join(',') || 'NULL'}) AND (? IS NULL OR q.branch_id=?) ORDER BY q.id DESC`).all(companyId,...branches,branchId,branchId);
    return { receipts:rows.map(quarantineDetail) };
  }));

  app.post('/api/returns/quarantine/:id/inspect', route(req => atomic(() => {
    if (!['accountant','admin'].includes(req.user.role)) throw bad('Accountant or admin role required',403);
    const id=positive(Number(req.params.id),'id'), companyId=req.company.id, body=req.body || {};
    const receipt=db.prepare(`SELECT q.*,r.number AS return_number,v.number AS invoice_number,l.batch_code,i.name AS item_name,i.sku
      FROM return_quarantine_receipts q JOIN return_lines rl ON rl.id=q.return_line_id JOIN returns r ON r.id=rl.return_id
      JOIN invoices v ON v.id=r.invoice_id JOIN items i ON i.id=q.item_id LEFT JOIN batch_lots l ON l.id=q.batch_id
      WHERE q.id=? AND q.company_id=?`).get(id,companyId);
    if (!receipt) throw bad('Quarantine receipt not found in selected company',404);
    scope(req,receipt);
    const disposition=body.disposition;
    if (!['release','reject'].includes(disposition)) throw bad('disposition must be release or reject');
    if (typeof body.reason !== 'string' || !body.reason.trim() || body.reason.length > 500) throw bad('Inspection reason is required (maximum 500 characters)');
    if (receipt.status!=='quarantined') throw bad('Quarantine receipt has already been inspected',409);
    let movementId=null;
    if (disposition==='release') {
      if (receipt.batch_id) {
        const expiry=db.prepare('SELECT expires_on FROM batch_lots WHERE id=? AND company_id=?').get(receipt.batch_id,companyId)?.expires_on;
        if (!expiry || expiry < new Date().toISOString().slice(0,10)) throw bad('Expired source lot cannot be released to stock; reject the receipt or retain it in quarantine',409);
      }
      movementId=Number(db.prepare(`INSERT INTO stock_movements(company_id,branch_id,item_id,quantity_delta,type,reason,client_reference)
        VALUES (?,?,?,?,'sales_return_release',?,?)`).run(companyId,receipt.branch_id,receipt.item_id,receipt.quantity,body.reason.trim(),`return:quarantine:${id}:release`).lastInsertRowid);
      if (receipt.batch_id) {
        const branch=db.prepare('SELECT gstin_id FROM branches WHERE id=? AND company_id=?').get(receipt.branch_id,companyId);
        db.prepare(`INSERT INTO batch_movements(company_id,batch_id,branch_id,gstin_id,quantity_delta,type,reason,request_signature,operation_reference,stock_movement_id,recorded_by)
          VALUES (?,?,?,?,?,'receipt',?,?,?,?,?)`).run(companyId,receipt.batch_id,receipt.branch_id,branch.gstin_id,receipt.quantity,body.reason.trim(),JSON.stringify({returnQuarantineId:id,disposition}),`return:quarantine:${id}:release`,movementId,req.user.id);
      }
    }
    db.prepare(`UPDATE return_quarantine_receipts SET status=?,reviewed_by=?,reviewed_at=CURRENT_TIMESTAMP,review_reason=?,release_stock_movement_id=? WHERE id=?`)
      .run(disposition==='release'?'released':'rejected',req.user.id,body.reason.trim(),movementId,id);
    db.prepare('INSERT INTO return_quarantine_events(company_id,receipt_id,action,actor_id,details) VALUES (?,?,?,?,?)')
      .run(companyId,id,disposition,req.user.id,body.reason.trim());
    return { receipt:quarantineDetail(db.prepare(`SELECT q.*,r.number AS return_number,v.number AS invoice_number,l.batch_code,i.name AS item_name,i.sku
      FROM return_quarantine_receipts q JOIN return_lines rl ON rl.id=q.return_line_id JOIN returns r ON r.id=rl.return_id
      JOIN invoices v ON v.id=r.invoice_id JOIN items i ON i.id=q.item_id LEFT JOIN batch_lots l ON l.id=q.batch_id WHERE q.id=?`).get(id)) };
  })));

  app.post('/api/returns', route(req => atomic(() => {
    const body = req.body || {}, companyId = req.company.id;
    const invoiceId = positive(body.invoiceId,'invoiceId');
    const invoice = db.prepare('SELECT * FROM invoices WHERE id=? AND company_id=?').get(invoiceId,companyId);
    if (!invoice) throw bad('Invoice not found in selected company',404);
    scope(req,invoice);
    if (invoice.status !== 'approved') throw bad('Only approved source invoices can be returned',409);
    if (!Array.isArray(body.lines) || body.lines.length < 1 || body.lines.length > 100) throw bad('Return requires 1 to 100 source lines');
    if (typeof body.reason !== 'string' || !body.reason.trim() || body.reason.length > 500) throw bad('Reason is required (maximum 500 characters)');
    const seen = new Set();
    const lines = body.lines.map(entry => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw bad('Each return line must be an object');
      const lineId = positive(entry.invoiceLineId,'invoiceLineId'), quantity = positive(entry.quantity,'quantity');
      if (seen.has(lineId)) throw bad('Duplicate source invoice line');
      seen.add(lineId);
      const source = sourceLine(invoiceId,lineId);
      if (!source) throw bad('Return line does not belong to source invoice',404);
      const alreadyReturned = priorQuantity(lineId);
      if (quantity + alreadyReturned > source.quantity) throw bad(`Return quantity exceeds remaining quantity for invoice line ${lineId}`,409);
      return { source, quantity, ...amountFor(source,quantity,alreadyReturned) };
    });
    const subtotal = lines.reduce((sum,line) => sum + line.subtotal,0), tax = lines.reduce((sum,line) => sum + line.tax,0);
    if (!Number.isSafeInteger(subtotal + tax)) throw bad('Return amount too large');
    const id = Number(db.prepare("INSERT INTO returns(company_id,invoice_id,number,kind,reason,subtotal_cents,tax_proposal_cents,total_proposal_cents,created_by) VALUES (?,?,'PENDING',?,?,?,?,?,?)")
      .run(companyId,invoiceId,invoice.type === 'sale' ? 'sales_return' : 'purchase_return',body.reason.trim(),subtotal,tax,subtotal+tax,req.user.id).lastInsertRowid);
    db.prepare('UPDATE returns SET number=? WHERE id=?').run(`${invoice.type === 'sale' ? 'CRN' : 'DBN'}-${String(companyId).padStart(2,'0')}-${String(id).padStart(5,'0')}`,id);
    const insert = db.prepare('INSERT INTO return_lines(return_id,invoice_line_id,item_id,quantity,subtotal_cents,tax_proposal_cents) VALUES (?,?,?,?,?,?)');
    for (const line of lines) insert.run(id,line.source.id,line.source.item_id,line.quantity,line.subtotal,line.tax);
    return { return:detail(id,companyId) };
  })));

  app.post('/api/returns/:id/approve', route(req => atomic(() => {
    if (!['accountant','admin'].includes(req.user.role)) throw bad('Accountant or admin role required',403);
    const id = positive(Number(req.params.id),'id'), companyId = req.company.id;
    const record = db.prepare('SELECT * FROM returns WHERE id=? AND company_id=?').get(id,companyId);
    if (!record) throw bad('Return not found in selected company',404);
    const invoiceScope=db.prepare('SELECT gstin_id,branch_id FROM invoices WHERE id=? AND company_id=?').get(record.invoice_id,companyId);
    if (!invoiceScope) throw bad('Invoice not found in selected company',404);
    scope(req,invoiceScope);
    if (record.status === 'approved') return { return:detail(id,companyId), alreadyApproved:true };
    if (record.created_by === req.user.id) throw bad('Return creator cannot approve their own return',403);
    const invoice = db.prepare('SELECT * FROM invoices WHERE id=? AND company_id=?').get(record.invoice_id,companyId);
    if (!invoice || invoice.status !== 'approved') throw bad('Approved source invoice required',409);
    const lines = db.prepare('SELECT * FROM return_lines WHERE return_id=? ORDER BY id').all(id);
    let subtotal = 0, tax = 0;
    const consumedByItem = new Map();
    for (const line of lines) {
      const source = sourceLine(invoice.id,line.invoice_line_id), prior = priorQuantity(source.id);
      if (prior + line.quantity > source.quantity) throw bad(`Return quantity exceeds remaining quantity for invoice line ${source.id}`,409);
      const amount = amountFor(source,line.quantity,prior);
      const tracked = db.prepare('SELECT track_stock FROM items WHERE id=? AND company_id=?').get(line.item_id,companyId)?.track_stock;
      let movementId = null;
      if (tracked) {
        const delta = invoice.type === 'sale' ? line.quantity : -line.quantity;
        if (delta < 0) {
          movementId = allocateBatchIssue(db,{ companyId,branchId:invoice.branch_id,itemId:line.item_id,quantity:line.quantity,
            reason:record.number,sourceReference:`return:${record.id}:line:${line.id}`,userId:req.user.id,invoiceId:invoice.id,movementType:'purchase_return',allowExpired:true }).firstStockMovementId;
        } else {
          const priorItem = consumedByItem.has(line.item_id) ? consumedByItem.get(line.item_id) : db.prepare(`SELECT COALESCE(SUM(rl.quantity),0) AS quantity FROM return_lines rl JOIN returns r ON r.id=rl.return_id
            WHERE r.invoice_id=? AND r.status='approved' AND rl.item_id=?`).get(invoice.id,line.item_id).quantity;
          quarantineReturn(record,invoice,line,req.user.id,priorItem);
          consumedByItem.set(line.item_id,priorItem+line.quantity);
        }
      }
      db.prepare('UPDATE return_lines SET subtotal_cents=?,tax_proposal_cents=?,stock_movement_id=? WHERE id=?').run(amount.subtotal,amount.tax,movementId,line.id);
      subtotal += amount.subtotal; tax += amount.tax;
    }
    db.prepare("UPDATE returns SET status='approved',subtotal_cents=?,tax_proposal_cents=?,total_proposal_cents=?,approved_by=?,approved_at=CURRENT_TIMESTAMP WHERE id=?")
      .run(subtotal,tax,subtotal+tax,req.user.id,id);
    return { return:detail(id,companyId), alreadyApproved:false };
  })));
}

module.exports = { registerReturnsRoutes };
