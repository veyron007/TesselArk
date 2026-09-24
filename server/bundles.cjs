const { installBundleSchema } = require('./bundles-db.cjs');
const { assertScopeAccess, allowedScopes } = require('./access.cjs');
const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const int = (value, name, min = 0, max = 1000000000) => {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw fail(`${name} must be an integer from ${min} to ${max}`);
  return value;
};
const queryInt = (value, name, min = 1) => int(Number(value), name, min);
const str = (value, name, max = 200) => {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max) throw fail(`${name} must contain 1 to ${max} characters`);
  return value.trim();
};
const date = (value, name) => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`)) || new Date(`${value}T00:00:00Z`).toISOString().slice(0,10) !== value) throw fail(`${name} must be a valid YYYY-MM-DD date`);
  return value;
};
const camel = row => Object.fromEntries(Object.entries(row).map(([key,value]) => [key.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase()),value]));
const transaction = (db, fn) => {
  db.exec('SAVEPOINT trade_bundle_action');
  try { const value = fn(); db.exec('RELEASE trade_bundle_action'); return value; }
  catch (error) { db.exec('ROLLBACK TO trade_bundle_action'); db.exec('RELEASE trade_bundle_action'); throw error; }
};

function registerBundleRoutes(app, db) {
  installBundleSchema(db);
  const route = fn => (req,res,next) => { try { res.json(fn(req)); } catch (error) { next(error); } };
  const scope = (req, branchId, gstinId) => assertScopeAccess(db, { companyId:req.company.id,userId:req.user.id,branchId:int(branchId,'branchId',1),...(gstinId === undefined ? {} : {gstinId:int(gstinId,'gstinId',1)}) });
  const author = req => { if (!['staff','admin'].includes(req.user.role)) throw fail('Staff or admin role required',403); };
  const reviewer = req => { if (!['accountant','admin'].includes(req.user.role)) throw fail('Accountant or admin role required',403); };
  const item = (req, id, tracked = false) => {
    const row = db.prepare('SELECT * FROM items WHERE id=? AND company_id=?').get(int(id,'itemId',1),req.company.id);
    if (!row) throw fail('Item not found in selected company',404);
    if (!row.active || (tracked && !row.track_stock)) throw fail('An active, stock-tracked item is required',409);
    return row;
  };
  const event = (req, kind, targetId, action, detail) => db.prepare('INSERT INTO trade_bundle_events(company_id,kind,target_id,actor_id,action,detail_json) VALUES (?,?,?,?,?,?)')
    .run(req.company.id,kind,targetId,req.user.id,action,JSON.stringify(detail));
  const events = (req, kind, id) => db.prepare('SELECT id,actor_id,action,detail_json,created_at FROM trade_bundle_events WHERE company_id=? AND kind=? AND target_id=? ORDER BY id').all(req.company.id,kind,id)
    .map(row => ({id:row.id,actorId:row.actor_id,action:row.action,detail:JSON.parse(row.detail_json),createdAt:row.created_at}));
  const bundleRow = (req, id) => {
    const row = db.prepare('SELECT * FROM trade_bundles WHERE id=? AND company_id=?').get(queryInt(id,'bundleId'),req.company.id);
    if (!row) throw fail('Bundle not found in selected company',404);
    scope(req,row.branch_id,row.gstin_id);
    return row;
  };
  const versionRows = row => db.prepare('SELECT * FROM trade_bundle_versions WHERE bundle_id=? ORDER BY version DESC').all(row.id);
  const components = versionId => db.prepare('SELECT item_id,item_name_snapshot,item_sku_snapshot,unit_snapshot,quantity FROM trade_bundle_components WHERE version_id=? ORDER BY id').all(versionId).map(camel);
  const bundleView = (req,row) => ({ id:row.id,companyId:row.company_id,gstinId:row.gstin_id,branchId:row.branch_id,name:row.name,currentVersion:row.current_version,createdBy:row.created_by,createdAt:row.created_at,
    versions:versionRows(row).map(v => ({id:v.id,version:v.version,reason:v.reason,createdBy:v.created_by,createdAt:v.created_at,components:components(v.id)})),events:events(req,'bundle',row.id) });
  const componentInput = (req,value) => {
    if (!Array.isArray(value) || value.length < 1 || value.length > 30) throw fail('components must contain 1 to 30 rows');
    const seen = new Set();
    return value.map((line,index) => {
      const chosen = item(req,line?.itemId,true);
      if (seen.has(chosen.id)) throw fail('Each component item may appear once');
      seen.add(chosen.id);
      return {itemId:chosen.id,quantity:int(line.quantity,`components[${index}].quantity`,1,1000000)};
    });
  };
  const insertVersion = (req,row,version,reason,clientReference,payload) => {
    const versionId = Number(db.prepare('INSERT INTO trade_bundle_versions(bundle_id,version,reason,client_reference,payload_json,created_by) VALUES (?,?,?,?,?,?)')
      .run(row.id,version,reason,clientReference,JSON.stringify(payload),req.user.id).lastInsertRowid);
    for (const line of payload.components) {
      const chosen = item(req,line.itemId,true);
      db.prepare('INSERT INTO trade_bundle_components(version_id,item_id,item_name_snapshot,item_sku_snapshot,unit_snapshot,quantity) VALUES (?,?,?,?,?,?)')
        .run(versionId,chosen.id,chosen.name,chosen.sku,chosen.unit,line.quantity);
    }
    return versionId;
  };
  const stock = (req, branchId, itemId) => db.prepare('SELECT COALESCE(SUM(quantity_delta),0) AS quantity FROM stock_movements WHERE company_id=? AND branch_id=? AND item_id=?')
    .get(req.company.id,branchId,itemId).quantity;
  const schemeRow = (req,id) => {
    const row = db.prepare('SELECT * FROM trade_schemes WHERE id=? AND company_id=?').get(queryInt(id,'schemeId'),req.company.id);
    if (!row) throw fail('Scheme not found in selected company',404);
    scope(req,row.branch_id,row.gstin_id);
    return row;
  };
  const schemeView = (req,row) => ({...camel(Object.fromEntries(Object.entries(row).filter(([key]) => !['payload_json','item_ids_json'].includes(key)))),itemIds:JSON.parse(row.item_ids_json),events:events(req,'scheme',row.id)});
  const visible = (req,row) => { const granted = allowedScopes(db,{companyId:req.company.id,userId:req.user.id}); return granted.gstinIds.includes(row.gstin_id) && granted.branchIds.includes(row.branch_id); };

  app.get('/api/bundles/masters',route(req => {
    if (!allowedScopes(db,{companyId:req.company.id,userId:req.user.id}).branchIds.length) throw fail('A branch grant is required',403);
    return {items:db.prepare('SELECT id,sku,name,unit,track_stock,active FROM items WHERE company_id=? ORDER BY name').all(req.company.id).map(camel),
      parties:db.prepare('SELECT id,name,type FROM parties WHERE company_id=? ORDER BY name').all(req.company.id).map(camel)};
  }));
  app.get('/api/bundles/deals',route(req => {
    const branch = scope(req,queryInt(req.query.branchId,'branchId'));
    const type = req.query.type;
    if (!['sale','purchase'].includes(type)) throw fail('type must be sale or purchase');
    const itemId = queryInt(req.query.itemId,'itemId'); item(req,itemId);
    const from = date(req.query.from,'from'), to = date(req.query.to,'to');
    if (from > to) throw fail('from must be on or before to');
    const partyId = req.query.partyId ? queryInt(req.query.partyId,'partyId') : null;
    if (partyId && !db.prepare('SELECT 1 FROM parties WHERE company_id=? AND id=?').get(req.company.id,partyId)) throw fail('Party not found in selected company',404);
    const rows = db.prepare(`SELECT i.id AS invoice_id,i.number AS invoice_number,i.supplier_invoice_number,i.invoice_date,i.type,i.party_id,i.party_name_snapshot,i.gstin_id,i.branch_id,
      l.id AS invoice_line_id,l.item_id,l.quantity,l.unit_price_cents,l.gst_rate_bps,l.subtotal_cents,l.tax_cents,l.total_cents,t.name AS current_item_name,t.unit AS current_item_unit
      FROM invoices i JOIN invoice_lines l ON l.invoice_id=i.id JOIN items t ON t.id=l.item_id AND t.company_id=i.company_id
      WHERE i.company_id=? AND i.branch_id=? AND i.gstin_id=? AND i.status='approved' AND i.type=? AND l.item_id=?
      AND i.invoice_date BETWEEN ? AND ? AND (? IS NULL OR i.party_id=?) ORDER BY i.invoice_date DESC,i.id DESC,l.id DESC LIMIT 100`)
      .all(req.company.id,branch.id,branch.gstin_id,type,itemId,from,to,partyId,partyId).map(camel);
    return {deals:rows,source:'approved_invoice_lines',historicalTerms:true,limit:100};
  }));
  app.get('/api/bundles/schemes',route(req => {
    const branch = scope(req,queryInt(req.query.branchId,'branchId'));
    return {schemes:db.prepare('SELECT * FROM trade_schemes WHERE company_id=? AND branch_id=? ORDER BY id DESC').all(req.company.id,branch.id).filter(row => visible(req,row)).map(row => schemeView(req,row))};
  }));
  app.post('/api/bundles/schemes',route(req => {
    author(req); const b=req.body||{}; const branch=scope(req,b.branchId,b.gstinId);
    if (!Array.isArray(b.itemIds) || b.itemIds.length<1 || b.itemIds.length>50) throw fail('itemIds must contain 1 to 50 items');
    const ids=b.itemIds.map(id=>item(req,id).id);
    if (new Set(ids).size!==ids.length) throw fail('itemIds must be unique');
    ids.sort((a,c)=>a-c);
    const freeId=b.freeItemId == null ? null : item(req,b.freeItemId,true).id;
    const benefit={discountBps:int(b.discountBps,'discountBps',0,10000),freeQuantity:int(b.freeQuantity,'freeQuantity',0,100000),freeItemId:freeId};
    if (!benefit.discountBps && !benefit.freeQuantity) throw fail('At least one discount or free good is required');
    if (Boolean(freeId)!==Boolean(benefit.freeQuantity)) throw fail('freeItemId and freeQuantity must be supplied together');
    if (!['exclusive','stackable'].includes(b.stackingPolicy)) throw fail('stackingPolicy must be exclusive or stackable');
    const from=date(b.effectiveFrom,'effectiveFrom'),to=date(b.effectiveTo,'effectiveTo'); if(from>to) throw fail('effectiveFrom must be on or before effectiveTo');
    const payload={branchId:branch.id,gstinId:branch.gstin_id,name:str(b.name,'name',120),itemIds:ids,minQuantity:int(b.minQuantity,'minQuantity',1,1000000),...benefit,stackingPolicy:b.stackingPolicy,effectiveFrom:from,effectiveTo:to,sourceReference:str(b.sourceReference,'sourceReference',160)};
    const clientReference=str(b.clientReference,'clientReference',120);
    return transaction(db,()=>{
      const prior=db.prepare('SELECT * FROM trade_schemes WHERE company_id=? AND client_reference=?').get(req.company.id,clientReference);
      if(prior) { if(prior.payload_json!==JSON.stringify(payload)) throw fail('clientReference conflicts with an existing scheme',409); scope(req,prior.branch_id,prior.gstin_id); return {scheme:schemeView(req,prior),replayed:true}; }
      const id=Number(db.prepare(`INSERT INTO trade_schemes(company_id,gstin_id,branch_id,name,client_reference,payload_json,item_ids_json,min_quantity,discount_bps,free_item_id,free_quantity,stacking_policy,effective_from,effective_to,source_reference,created_by)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(req.company.id,branch.gstin_id,branch.id,payload.name,clientReference,JSON.stringify(payload),JSON.stringify(ids),payload.minQuantity,benefit.discountBps,freeId,benefit.freeQuantity,payload.stackingPolicy,from,to,payload.sourceReference,req.user.id).lastInsertRowid);
      event(req,'scheme',id,'proposed',{clientReference}); return {scheme:schemeView(req,schemeRow(req,id)),replayed:false};
    });
  }));
  app.post('/api/bundles/schemes/:id/decision',route(req => {
    reviewer(req); const b=req.body||{}; const decision=b.decision; if(!['approved','rejected'].includes(decision)) throw fail('decision must be approved or rejected');
    const reason=str(b.reason,'reason',500);
    return transaction(db,()=>{
      const row=schemeRow(req,req.params.id);
      if(row.status!=='pending') { if(row.status===decision && row.review_reason===reason) return {scheme:schemeView(req,row),replayed:true}; throw fail('Scheme already decided',409); }
      if(row.created_by===req.user.id) throw fail('An independent reviewer is required',403);
      db.prepare('UPDATE trade_schemes SET status=?,reviewed_by=?,reviewed_at=CURRENT_TIMESTAMP,review_reason=? WHERE id=?').run(decision,req.user.id,reason,row.id);
      event(req,'scheme',row.id,decision,{reason}); return {scheme:schemeView(req,schemeRow(req,row.id)),replayed:false};
    });
  }));
  app.get('/api/bundles/schemes/preview',route(req => {
    const branch=scope(req,queryInt(req.query.branchId,'branchId'));
    const itemId=queryInt(req.query.itemId,'itemId'); item(req,itemId);
    const quantity=queryInt(req.query.quantity,'quantity');
    const asOf=date(req.query.date,'date');
    const unitRateCents=queryInt(req.query.unitRateCents,'unitRateCents',0);
    const base=BigInt(quantity)*BigInt(unitRateCents);
    if(base>BigInt(Number.MAX_SAFE_INTEGER)) throw fail('Line value exceeds supported money range');
    const candidates=db.prepare(`SELECT * FROM trade_schemes WHERE company_id=? AND branch_id=? AND gstin_id=? AND status='approved' AND effective_from<=? AND effective_to>=? AND min_quantity<=? ORDER BY id DESC`)
      .all(req.company.id,branch.id,branch.gstin_id,asOf,asOf,quantity).filter(row=>JSON.parse(row.item_ids_json).includes(itemId))
      .map(row=>({scheme:schemeView(req,row),discountCents:Number((base*BigInt(row.discount_bps)+5000n)/10000n),freeGoods:row.free_item_id?{itemId:row.free_item_id,quantity:row.free_quantity,available:stock(req,branch.id,row.free_item_id)}:null}));
    return {candidates,baseCents:Number(base),selectionRequired:true,taxCalculated:false,posting:false,stackingRule:'Exclusive schemes cannot combine with any other scheme; stackable schemes may combine only after explicit selection and independent policy review.'};
  }));
  app.get('/api/bundles',route(req => {
    const branch=scope(req,queryInt(req.query.branchId,'branchId'));
    return {bundles:db.prepare('SELECT * FROM trade_bundles WHERE company_id=? AND branch_id=? ORDER BY id DESC').all(req.company.id,branch.id).map(row=>bundleView(req,row))};
  }));
  app.post('/api/bundles',route(req => {
    author(req); const b=req.body||{}; const branch=scope(req,b.branchId,b.gstinId);
    const payload={branchId:branch.id,gstinId:branch.gstin_id,name:str(b.name,'name',120),components:componentInput(req,b.components),reason:str(b.reason,'reason',500)};
    const clientReference=str(b.clientReference,'clientReference',120);
    return transaction(db,()=>{
      const prior=db.prepare('SELECT * FROM trade_bundles WHERE company_id=? AND client_reference=?').get(req.company.id,clientReference);
      if(prior) { if(prior.payload_json!==JSON.stringify(payload)) throw fail('clientReference conflicts with an existing bundle',409); scope(req,prior.branch_id,prior.gstin_id); return {bundle:bundleView(req,prior),replayed:true}; }
      const id=Number(db.prepare('INSERT INTO trade_bundles(company_id,gstin_id,branch_id,name,client_reference,payload_json,created_by) VALUES (?,?,?,?,?,?,?)').run(req.company.id,branch.gstin_id,branch.id,payload.name,clientReference,JSON.stringify(payload),req.user.id).lastInsertRowid);
      const row=bundleRow(req,id); insertVersion(req,row,1,payload.reason,clientReference,payload);
      event(req,'bundle',id,'created',{version:1,reason:payload.reason}); return {bundle:bundleView(req,row),replayed:false};
    });
  }));
  app.get('/api/bundles/:id/preview',route(req => {
    const row=bundleRow(req,req.params.id); const version=req.query.version?queryInt(req.query.version,'version'):row.current_version;
    const v=db.prepare('SELECT * FROM trade_bundle_versions WHERE bundle_id=? AND version=?').get(row.id,version);
    if(!v) throw fail('Bundle version not found',404);
    const bundleQuantity=queryInt(req.query.quantity,'quantity');
    const lines=components(v.id).map(line=>{
      const needed=BigInt(line.quantity)*BigInt(bundleQuantity);
      if(needed>BigInt(1000000000)) throw fail('Required quantity exceeds supported limit');
      const available=stock(req,row.branch_id,line.itemId);
      return {...line,requiredQuantity:Number(needed),availableQuantity:available,shortageQuantity:Math.max(0,Number(needed)-available)};
    });
    return {bundleId:row.id,version,bundleQuantity,branchId:row.branch_id,gstinId:row.gstin_id,lines,canFulfill:lines.every(line=>line.shortageQuantity===0),posting:false,taxCalculated:false};
  }));
  app.get('/api/bundles/:id',route(req=>({bundle:bundleView(req,bundleRow(req,req.params.id))})));
  app.post('/api/bundles/:id/versions',route(req=>{
    author(req); const b=req.body||{}; const row=bundleRow(req,req.params.id);
    const payload={components:componentInput(req,b.components),reason:str(b.reason,'reason',500),expectedVersion:int(b.expectedVersion,'expectedVersion',1)};
    const clientReference=str(b.clientReference,'clientReference',120);
    return transaction(db,()=>{
      const prior=db.prepare('SELECT * FROM trade_bundle_versions WHERE bundle_id=? AND client_reference=?').get(row.id,clientReference);
      if(prior) { if(prior.payload_json!==JSON.stringify(payload)) throw fail('clientReference conflicts with an existing version',409); return {bundle:bundleView(req,row),replayed:true}; }
      if(row.current_version!==payload.expectedVersion) throw fail('Bundle version changed; refresh before revising',409);
      const next=row.current_version+1; insertVersion(req,row,next,payload.reason,clientReference,payload);
      db.prepare('UPDATE trade_bundles SET current_version=? WHERE id=?').run(next,row.id);
      event(req,'bundle',row.id,'revised',{version:next,reason:payload.reason}); return {bundle:bundleView(req,bundleRow(req,row.id)),replayed:false};
    });
  }));
}

function seedBundleDemo(db) {
  installBundleSchema(db);
  if(!db.prepare('SELECT 1 FROM companies WHERE id=1').get() || !db.prepare('SELECT 1 FROM branches WHERE id=1 AND company_id=1 AND gstin_id=1').get()) return;
  if(db.prepare("SELECT 1 FROM trade_bundles WHERE company_id=1 AND client_reference='SYNTHETIC-BUNDLE-ERP014'").get()) return;
  transaction(db,()=>{
    const payload={branchId:1,gstinId:1,name:'Synthetic clinic starter pack',components:[{itemId:1,quantity:2},{itemId:3,quantity:1}],reason:'Synthetic display formula only'};
    const id=Number(db.prepare("INSERT INTO trade_bundles(company_id,gstin_id,branch_id,name,client_reference,payload_json,created_by) VALUES (1,1,1,?,'SYNTHETIC-BUNDLE-ERP014',?,1)").run(payload.name,JSON.stringify(payload)).lastInsertRowid);
    const versionId=Number(db.prepare("INSERT INTO trade_bundle_versions(bundle_id,version,reason,client_reference,payload_json,created_by) VALUES (?,1,?,'SYNTHETIC-BUNDLE-ERP014',?,1)").run(id,payload.reason,JSON.stringify(payload)).lastInsertRowid);
    for(const line of payload.components) { const chosen=db.prepare('SELECT * FROM items WHERE id=? AND company_id=1').get(line.itemId); if(chosen) db.prepare('INSERT INTO trade_bundle_components(version_id,item_id,item_name_snapshot,item_sku_snapshot,unit_snapshot,quantity) VALUES (?,?,?,?,?,?)').run(versionId,chosen.id,chosen.name,chosen.sku,chosen.unit,line.quantity); }
    db.prepare("INSERT INTO trade_bundle_events(company_id,kind,target_id,actor_id,action,detail_json) VALUES (1,'bundle',?,1,'created',?)").run(id,JSON.stringify({version:1,synthetic:true}));
  });
}
module.exports={registerBundleRoutes,seedBundleDemo};
