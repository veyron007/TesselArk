const { assertScopeAccess } = require('./access.cjs');
const { allocateBatchIssue } = require('./batch-inventory.cjs');
const { installConversionSchema } = require('./conversion-db.cjs');

const bad = (message, status = 400) => Object.assign(new Error(message), { status });
const integer = (value, name, min = 0) => {
  if (!Number.isSafeInteger(value) || value < min) throw bad(`${name} must be an integer of at least ${min}`);
  return value;
};
const string = (value, name, max = 200) => {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max) throw bad(`${name} is required (up to ${max} characters)`);
  return value.trim();
};
const fields = row => Object.fromEntries(Object.entries(row).map(([key, value]) => [key.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase()), value]));
const atomic = (db, action) => {
  db.exec('SAVEPOINT conversion_action');
  try { const result = action(); db.exec('RELEASE conversion_action'); return result; }
  catch (error) { db.exec('ROLLBACK TO conversion_action'); db.exec('RELEASE conversion_action'); throw error; }
};

function registerConversionRoutes(app, db) {
  installConversionSchema(db);
  const route = handler => (req, res, next) => { try { res.json(handler(req)); } catch (error) { next(error); } };
  const scope = (req, branch) => assertScopeAccess(db, { companyId:req.company.id, userId:req.user.id, gstinId:branch.gstin_id, branchId:branch.id });
  const branchFor = (req, id) => {
    const branch = db.prepare('SELECT * FROM branches WHERE company_id=? AND id=?').get(req.company.id,integer(id,'branchId',1));
    if (!branch) throw bad('Branch not found in selected company',404);
    scope(req,branch);
    return branch;
  };
  const itemFor = (req, id, name) => {
    const item = db.prepare('SELECT * FROM items WHERE company_id=? AND id=?').get(req.company.id,integer(id,name,1));
    if (!item) throw bad(`${name} not found in selected company`,404);
    if (!item.active || !item.track_stock) throw bad(`${name} must be active and stock tracked`);
    return item;
  };
  const rowFor = (req, id) => {
    const row = db.prepare('SELECT * FROM stock_conversions WHERE company_id=? AND id=?').get(req.company.id,integer(id,'conversionId',1));
    if (!row) throw bad('Conversion not found in selected company',404);
    branchFor(req,row.branch_id);
    return row;
  };
  const event = (row, action, req, details = '') => db.prepare('INSERT INTO stock_conversion_events(conversion_id,action,actor_id,details) VALUES (?,?,?,?)').run(row.id,action,req.user.id,details);
  const stock = (companyId, branchId, itemId) => db.prepare('SELECT COALESCE(SUM(quantity_delta),0) AS quantity FROM stock_movements WHERE company_id=? AND branch_id=? AND item_id=?').get(companyId,branchId,itemId).quantity;
  const assigned = (companyId, branchId, itemId) => db.prepare(`SELECT COALESCE(SUM(m.quantity_delta),0) AS quantity FROM location_movements m JOIN locations l ON l.id=m.location_id
    WHERE m.company_id=? AND l.branch_id=? AND m.item_id=?`).get(companyId,branchId,itemId).quantity;
  const availability = (req, branchId, sourceId, targetId) => {
    const sourceQuantity = stock(req.company.id,branchId,sourceId);
    const targetQuantity = stock(req.company.id,branchId,targetId);
    const locationAssignedQuantity = assigned(req.company.id,branchId,sourceId);
    const batchAssignedQuantity = db.prepare(`SELECT COALESCE(SUM(m.quantity_delta),0) AS quantity FROM batch_movements m
      JOIN batch_lots l ON l.id=m.batch_id WHERE m.company_id=? AND m.branch_id=? AND l.item_id=?`).get(req.company.id,branchId,sourceId).quantity;
    return { sourceQuantity, targetQuantity, locationAssignedQuantity, batchAssignedQuantity,
      unbatchedQuantity:sourceQuantity-batchAssignedQuantity };
  };
  const input = (req, body) => {
    const branch = branchFor(req,body.branchId);
    if (body.gstinId !== undefined && integer(body.gstinId,'gstinId',1) !== branch.gstin_id) throw bad('GSTIN does not match branch');
    const source = itemFor(req,body.sourceItemId,'sourceItemId');
    const target = itemFor(req,body.targetItemId,'targetItemId');
    if (source.id === target.id) throw bad('Source and target items must differ');
    const sourceQuantity = integer(body.sourceQuantity,'sourceQuantity',1);
    const ratioNumerator = integer(body.ratioNumerator,'ratioNumerator',1);
    const ratioDenominator = integer(body.ratioDenominator,'ratioDenominator',1);
    const numerator = BigInt(sourceQuantity)*BigInt(ratioNumerator);
    if (numerator % BigInt(ratioDenominator) !== 0n) throw bad('Ratio must yield a whole target quantity');
    const expected = numerator/BigInt(ratioDenominator);
    if (expected < 1n || expected > BigInt(Number.MAX_SAFE_INTEGER)) throw bad('Expected target quantity is outside safe range');
    const expectedTargetQuantity = Number(expected);
    const allowedWastageQuantity = integer(body.allowedWastageQuantity,'allowedWastageQuantity');
    const actualWastageQuantity = integer(body.actualWastageQuantity,'actualWastageQuantity');
    if (actualWastageQuantity > allowedWastageQuantity || actualWastageQuantity >= expectedTargetQuantity) throw bad('Wastage exceeds allowance or leaves no target quantity');
    const targetQuantity = expectedTargetQuantity-actualWastageQuantity;
    return { branch,source,target,sourceQuantity,ratioNumerator,ratioDenominator,expectedTargetQuantity,
      allowedWastageQuantity,actualWastageQuantity,targetQuantity,
      costBasisCents:integer(body.costBasisCents,'costBasisCents'),
      costBasisReference:string(body.costBasisReference,'costBasisReference',200),
      reason:string(body.reason,'reason',400),clientReference:body.clientReference === undefined ? null : string(body.clientReference,'clientReference',100) };
  };
  const preview = (req, data) => ({
    branchId:data.branch.id,gstinId:data.branch.gstin_id,
    sourceItem:{id:data.source.id,sku:data.source.sku,name:data.source.name,unit:data.source.unit},
    targetItem:{id:data.target.id,sku:data.target.sku,name:data.target.name,unit:data.target.unit},
    sourceQuantity:data.sourceQuantity,ratioNumerator:data.ratioNumerator,ratioDenominator:data.ratioDenominator,
    expectedTargetQuantity:data.expectedTargetQuantity,allowedWastageQuantity:data.allowedWastageQuantity,
    actualWastageQuantity:data.actualWastageQuantity,targetQuantity:data.targetQuantity,
    costBasisCents:data.costBasisCents,costBasisReference:data.costBasisReference,
    targetCostPerUnit:{numeratorCents:data.costBasisCents,denominatorUnits:data.targetQuantity},
    quantityBefore:availability(req,data.branch.id,data.source.id,data.target.id),
    quantityAfter:(() => { const before = availability(req,data.branch.id,data.source.id,data.target.id); return { sourceQuantity:before.sourceQuantity-data.sourceQuantity, targetQuantity:before.targetQuantity+data.targetQuantity }; })(),
    costNotice:'User-entered documented cost basis only. No valuation, accounting, tax or filing entry is posted.'
  });
  const read = (req, row) => ({ conversion:{...fields(row),sourceMovementIds:row.source_movement_ids_json ? JSON.parse(row.source_movement_ids_json) : [],
    targetCostPerUnit:{numeratorCents:row.cost_basis_cents,denominatorUnits:row.target_quantity}},
    availability:availability(req,row.branch_id,row.source_item_id,row.target_item_id),
    events:db.prepare('SELECT * FROM stock_conversion_events WHERE conversion_id=? ORDER BY id').all(row.id).map(fields) });
  const requireRole = (req, roles) => { if (!roles.includes(req.user.role)) throw bad(`${roles.join(' or ')} role required`,403); };

  app.post('/api/conversions/preview',route(req => preview(req,input(req,req.body || {}))));
  app.get('/api/conversions',route(req => {
    const branchId = req.query.branchId === undefined ? null : integer(Number(req.query.branchId),'branchId',1);
    if (branchId) branchFor(req,branchId);
    const rows = db.prepare('SELECT * FROM stock_conversions WHERE company_id=? AND (? IS NULL OR branch_id=?) ORDER BY id DESC').all(req.company.id,branchId,branchId)
      .filter(row => req.scopes.branchIds.includes(row.branch_id) && req.scopes.gstinIds.includes(row.gstin_id));
    return { conversions:rows.map(row => read(req,row).conversion) };
  }));
  app.get('/api/conversions/:id',route(req => read(req,rowFor(req,Number(req.params.id)))));
  app.post('/api/conversions',route(req => atomic(db,() => {
    requireRole(req,['staff','admin']);
    const data = input(req,req.body || {});
    if (!data.clientReference) throw bad('clientReference is required');
    const existing = db.prepare('SELECT * FROM stock_conversions WHERE company_id=? AND client_reference=?').get(req.company.id,data.clientReference);
    if (existing) {
      const same = existing.branch_id === data.branch.id && existing.source_item_id === data.source.id && existing.target_item_id === data.target.id &&
        existing.source_quantity === data.sourceQuantity && existing.ratio_numerator === data.ratioNumerator && existing.ratio_denominator === data.ratioDenominator &&
        existing.allowed_wastage_quantity === data.allowedWastageQuantity && existing.actual_wastage_quantity === data.actualWastageQuantity &&
        existing.cost_basis_cents === data.costBasisCents && existing.cost_basis_reference === data.costBasisReference && existing.reason === data.reason;
      if (!same) throw bad('Reference already used for a different conversion',409);
      return { ...read(req,existing),replayed:true };
    }
    const result = db.prepare(`INSERT INTO stock_conversions(company_id,gstin_id,branch_id,source_item_id,target_item_id,source_quantity,
      ratio_numerator,ratio_denominator,expected_target_quantity,allowed_wastage_quantity,actual_wastage_quantity,target_quantity,
      cost_basis_cents,cost_basis_reference,reason,client_reference,created_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      req.company.id,data.branch.gstin_id,data.branch.id,data.source.id,data.target.id,data.sourceQuantity,data.ratioNumerator,
      data.ratioDenominator,data.expectedTargetQuantity,data.allowedWastageQuantity,data.actualWastageQuantity,data.targetQuantity,
      data.costBasisCents,data.costBasisReference,data.reason,data.clientReference,req.user.id);
    const row = rowFor(req,Number(result.lastInsertRowid));
    event(row,'create',req,'Draft prepared with documented cost basis');
    return read(req,row);
  })));
  app.post('/api/conversions/:id/submit',route(req => atomic(db,() => {
    requireRole(req,['staff','admin']);
    const row = rowFor(req,Number(req.params.id));
    if (row.status === 'submitted') return { ...read(req,row),replayed:true };
    if (row.status !== 'draft') throw bad('Only a draft can be submitted',409);
    if (row.created_by !== req.user.id) throw bad('Only the draft creator can submit',403);
    db.prepare("UPDATE stock_conversions SET status='submitted',submitted_by=?,submitted_at=CURRENT_TIMESTAMP WHERE id=?").run(req.user.id,row.id);
    event(row,'submit',req);
    return read(req,rowFor(req,row.id));
  })));
  app.post('/api/conversions/:id/review',route(req => atomic(db,() => {
    requireRole(req,['accountant','admin']);
    const row = rowFor(req,Number(req.params.id));
    if (row.created_by === req.user.id) throw bad('An independent reviewer is required',403);
    if (row.status === 'reviewed') {
      const reviewNote = string(req.body?.reviewNote,'reviewNote',500);
      const original = db.prepare("SELECT actor_id,details FROM stock_conversion_events WHERE conversion_id=? AND action='review' ORDER BY id LIMIT 1").get(row.id);
      if (!original || original.actor_id !== req.user.id || original.details !== reviewNote) throw bad('Review replay differs from the recorded decision',409);
      return { ...read(req,row),replayed:true };
    }
    if (row.status !== 'submitted') throw bad('Only a submitted conversion can be reviewed',409);
    const reviewNote = string(req.body?.reviewNote,'reviewNote',500);
    db.prepare("UPDATE stock_conversions SET status='reviewed',reviewed_by=?,reviewed_at=CURRENT_TIMESTAMP WHERE id=?").run(req.user.id,row.id);
    event(row,'review',req,reviewNote);
    return read(req,rowFor(req,row.id));
  })));
  app.post('/api/conversions/:id/post',route(req => atomic(db,() => {
    requireRole(req,['staff','admin']);
    const row = rowFor(req,Number(req.params.id));
    if (row.status === 'posted') return { ...read(req,row),replayed:true };
    if (row.status !== 'reviewed' || !row.reviewed_by || row.reviewed_by === row.created_by) throw bad('Independent review is required before posting',409);
    itemFor(req,row.source_item_id,'sourceItemId'); itemFor(req,row.target_item_id,'targetItemId');
    const current = availability(req,row.branch_id,row.source_item_id,row.target_item_id);
    if (current.sourceQuantity - row.source_quantity < current.locationAssignedQuantity) throw bad('Insufficient source stock outside assigned locations',409);
    if (current.sourceQuantity < row.source_quantity) throw bad('Insufficient source stock',409);
    const reason = `Conversion ${row.client_reference}: ${row.reason}`;
    const issue = allocateBatchIssue(db,{companyId:req.company.id,branchId:row.branch_id,itemId:row.source_item_id,
      quantity:row.source_quantity,userId:req.user.id,reason,sourceReference:`conversion:${row.id}:source`,movementType:'conversion_out'});
    const receipt = db.prepare('INSERT INTO stock_movements(company_id,branch_id,item_id,quantity_delta,type,reason,client_reference) VALUES (?,?,?,?,?,?,?)')
      .run(req.company.id,row.branch_id,row.target_item_id,row.target_quantity,'conversion_in',reason,`conversion:${row.id}:target`);
    db.prepare("UPDATE stock_conversions SET status='posted',posted_by=?,posted_at=CURRENT_TIMESTAMP,source_movement_ids_json=?,target_movement_id=? WHERE id=?")
      .run(req.user.id,JSON.stringify(issue.stockMovementIds),Number(receipt.lastInsertRowid),row.id);
    event(row,'post',req,`Source ${row.source_quantity}; target ${row.target_quantity}; wastage ${row.actual_wastage_quantity}`);
    return read(req,rowFor(req,row.id));
  })));
}
module.exports = { registerConversionRoutes };
