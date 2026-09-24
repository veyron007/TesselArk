const { assertScopeAccess, allowedScopes } = require('./access.cjs');

const fail = (message,status=400) => Object.assign(new Error(message),{status});
const positive = (value,name) => { const n=Number(value); if (!Number.isSafeInteger(n) || n<1) throw fail(`${name} must be a positive integer`); return n; };
const cents = (value,name) => { const n=Number(value); if (!Number.isSafeInteger(n) || n<1) throw fail(`${name} must be a positive integer`); return n; };
const str = (value,name,max,required=true) => { if (typeof value!=='string' || value.trim().length>max || (required && !value.trim())) throw fail(`${name} must be ${required?'1':'0'} to ${max} characters`); return value.trim(); };
const day = (value,name) => { const s=str(value,name,10); const time=Date.parse(`${s}T00:00:00Z`); if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || Number.isNaN(time) || new Date(time).toISOString().slice(0,10)!==s) throw fail(`${name} must be a real YYYY-MM-DD date`); return s; };
const camel = row => row && Object.fromEntries(Object.entries(row).map(([key,value])=>[key.replace(/_([a-z])/g,(_,letter)=>letter.toUpperCase()),value]));

function installDeliverySchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS delivery_jobs (
      id INTEGER PRIMARY KEY,
      company_id INTEGER NOT NULL REFERENCES companies(id),
      gstin_id INTEGER NOT NULL REFERENCES gstins(id),
      branch_id INTEGER NOT NULL REFERENCES branches(id),
      order_id INTEGER NOT NULL REFERENCES orders(id),
      fulfillment_id INTEGER NOT NULL UNIQUE REFERENCES order_fulfillments(id),
      assignee_id INTEGER NOT NULL REFERENCES users(id),
      address TEXT NOT NULL,
      client_reference TEXT NOT NULL,
      created_by INTEGER NOT NULL REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      payload_json TEXT NOT NULL,
      UNIQUE(company_id,client_reference)
    );
    CREATE INDEX IF NOT EXISTS idx_delivery_scope ON delivery_jobs(company_id,gstin_id,branch_id,id);
    CREATE TABLE IF NOT EXISTS delivery_attempts (
      id INTEGER PRIMARY KEY,
      delivery_id INTEGER NOT NULL REFERENCES delivery_jobs(id),
      client_reference TEXT NOT NULL,
      outcome TEXT NOT NULL CHECK(outcome IN ('failed','partial','delivered')),
      attempt_date TEXT NOT NULL,
      reason TEXT NOT NULL DEFAULT '',
      note TEXT NOT NULL DEFAULT '',
      proof_method TEXT NOT NULL CHECK(proof_method IN ('none','recipient_name','reference_code')),
      recipient_name TEXT NOT NULL DEFAULT '',
      proof_reference TEXT NOT NULL DEFAULT '',
      proof_source TEXT NOT NULL DEFAULT 'staff_reported' CHECK(proof_source='staff_reported'),
      actor_id INTEGER NOT NULL REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      payload_json TEXT NOT NULL,
      UNIQUE(delivery_id,client_reference)
    );
    CREATE TABLE IF NOT EXISTS delivery_attempt_lines (
      attempt_id INTEGER NOT NULL REFERENCES delivery_attempts(id),
      order_line_id INTEGER NOT NULL REFERENCES order_lines(id),
      quantity INTEGER NOT NULL CHECK(quantity>0),
      PRIMARY KEY(attempt_id,order_line_id)
    );
    CREATE TABLE IF NOT EXISTS delivery_collections (
      id INTEGER PRIMARY KEY,
      delivery_id INTEGER NOT NULL REFERENCES delivery_jobs(id),
      client_reference TEXT NOT NULL,
      reported_amount_cents INTEGER NOT NULL CHECK(reported_amount_cents>0),
      method TEXT NOT NULL CHECK(method IN ('cash','upi','bank','other')),
      reference TEXT NOT NULL,
      note TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'reported_unallocated' CHECK(status='reported_unallocated'),
      actor_id INTEGER NOT NULL REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      payload_json TEXT NOT NULL,
      UNIQUE(delivery_id,client_reference)
    );
  `);
}

function seedDeliveryDemo(db) {
  installDeliverySchema(db);
  const fulfillment=db.prepare(`SELECT f.id,f.order_id,o.gstin_id,o.branch_id,p.address,fl.order_line_id
    FROM order_fulfillments f JOIN orders o ON o.id=f.order_id JOIN parties p ON p.id=o.party_id
    JOIN order_fulfillment_lines fl ON fl.fulfillment_id=f.id
    WHERE o.company_id=1 AND f.number='DEMO-DISP-BLR-301' AND f.kind='dispatch' AND f.status='confirmed'`).get();
  if (!fulfillment || db.prepare("SELECT 1 FROM delivery_jobs WHERE company_id=1 AND client_reference='DEMO-DELIVERY-BLR-030'").get()) return false;
  db.exec('SAVEPOINT seed_delivery');
  try {
    const payload={fulfillmentId:fulfillment.id,assigneeId:1,address:fulfillment.address || 'Synthetic Bengaluru delivery address',clientReference:'DEMO-DELIVERY-BLR-030'};
    const deliveryId=Number(db.prepare(`INSERT INTO delivery_jobs(company_id,gstin_id,branch_id,order_id,fulfillment_id,assignee_id,address,client_reference,created_by,payload_json)
      VALUES (1,?,?,?,?,?,?,?,1,?)`).run(fulfillment.gstin_id,fulfillment.branch_id,fulfillment.order_id,fulfillment.id,1,payload.address,payload.clientReference,JSON.stringify(payload)).lastInsertRowid);
    const event={clientReference:'DEMO-DELIVERY-ATTEMPT-030',outcome:'partial',attemptDate:new Date().toISOString().slice(0,10),lines:[{orderLineId:fulfillment.order_line_id,quantity:2}],proofMethod:'recipient_name',recipientName:'Demo recipient (staff report)',proofReference:'',reason:'',note:'SYNTHETIC DEMO ONLY. Staff reported partial handover; no customer signature or photo captured.'};
    const attemptId=Number(db.prepare(`INSERT INTO delivery_attempts(delivery_id,client_reference,outcome,attempt_date,reason,note,proof_method,recipient_name,proof_reference,actor_id,payload_json)
      VALUES (?,?,?,?,?,?,?,?,?,1,?)`).run(deliveryId,event.clientReference,event.outcome,event.attemptDate,event.reason,event.note,event.proofMethod,event.recipientName,event.proofReference,JSON.stringify(event)).lastInsertRowid);
    db.prepare('INSERT INTO delivery_attempt_lines(attempt_id,order_line_id,quantity) VALUES (?,?,?)').run(attemptId,fulfillment.order_line_id,2);
    db.exec('RELEASE seed_delivery'); return true;
  } catch(error) { db.exec('ROLLBACK TO seed_delivery'); db.exec('RELEASE seed_delivery'); throw error; }
}

function registerDeliveryRoutes(app,db) {
  installDeliverySchema(db);
  const route=handler=>(req,res,next)=>{ try { res.json(handler(req)); } catch(error) { next(error); } };
  const atomic=action=>{ db.exec('SAVEPOINT delivery_action'); try { const result=action(); db.exec('RELEASE delivery_action'); return result; } catch(error) { db.exec('ROLLBACK TO delivery_action'); db.exec('RELEASE delivery_action'); throw error; } };
  const scope=(req,row)=>assertScopeAccess(db,{companyId:req.company.id,userId:req.user.id,gstinId:row.gstin_id,branchId:row.branch_id});
  const writer=req=>{ if (!['staff','admin'].includes(req.user.role)) throw fail('Staff or admin role required for delivery',403); };
  const job=(req,idValue)=>{ const row=db.prepare('SELECT * FROM delivery_jobs WHERE id=? AND company_id=?').get(positive(idValue,'id'),req.company.id); if (!row) throw fail('Delivery not found in selected company',404); scope(req,row); return row; };
  const assignee=(req,idValue,scopeRow)=>{
    const id=positive(idValue,'assigneeId');
    const user=db.prepare("SELECT id,name,role FROM users WHERE id=? AND company_id=? AND role IN ('staff','admin')").get(id,req.company.id);
    if (!user) throw fail('Assignee must be staff or admin in selected company',404);
    const grants=allowedScopes(db,{companyId:req.company.id,userId:id});
    if (!grants.gstinIds.includes(scopeRow.gstin_id) || !grants.branchIds.includes(scopeRow.branch_id)) throw fail('Assignee lacks this GSTIN or branch grant',403);
    if (req.user.role!=='admin' && id!==req.user.id) throw fail('Only admin may assign another user',403);
    return user;
  };
  const editor=(req,row)=>{ writer(req); if (req.user.role!=='admin' && row.assignee_id!==req.user.id) throw fail('Only assigned staff or admin may record delivery activity',403); };
  const source=(req,fulfillmentId)=>{
    const row=db.prepare(`SELECT f.*,o.company_id,o.gstin_id,o.branch_id,o.party_id,o.number AS order_number,o.type AS order_type,o.status AS order_status
      FROM order_fulfillments f JOIN orders o ON o.id=f.order_id WHERE f.id=? AND o.company_id=?`).get(fulfillmentId,req.company.id);
    if (!row) throw fail('Dispatch not found in selected company',404);
    scope(req,row);
    if (row.kind!=='dispatch' || row.status!=='confirmed' || row.order_type!=='sale' || row.order_status!=='confirmed') throw fail('A confirmed sales dispatch is required',409);
    return row;
  };
  const detail=row=>{
    const sourceRow=db.prepare(`SELECT f.number AS fulfillment_number,f.event_date,o.number AS order_number,o.party_name_snapshot,p.phone,
      u.name AS assignee_name FROM delivery_jobs d JOIN order_fulfillments f ON f.id=d.fulfillment_id
      JOIN orders o ON o.id=d.order_id JOIN parties p ON p.id=o.party_id JOIN users u ON u.id=d.assignee_id WHERE d.id=?`).get(row.id);
    const lines=db.prepare(`SELECT fl.order_line_id,ol.item_name_snapshot,ol.quantity AS order_quantity,fl.quantity AS dispatched_quantity,
      COALESCE((SELECT SUM(al.quantity) FROM delivery_attempt_lines al JOIN delivery_attempts a ON a.id=al.attempt_id
        WHERE a.delivery_id=? AND al.order_line_id=fl.order_line_id),0) AS delivered_quantity
      FROM order_fulfillment_lines fl JOIN order_lines ol ON ol.id=fl.order_line_id WHERE fl.fulfillment_id=? ORDER BY fl.id`).all(row.id,row.fulfillment_id)
      .map(entry=>({...camel(entry),remainingQuantity:entry.dispatched_quantity-entry.delivered_quantity}));
    const attempts=db.prepare('SELECT * FROM delivery_attempts WHERE delivery_id=? ORDER BY id').all(row.id).map(entry=>({
      ...camel(entry),lines:db.prepare('SELECT order_line_id AS orderLineId,quantity FROM delivery_attempt_lines WHERE attempt_id=? ORDER BY order_line_id').all(entry.id)
    }));
    const collections=db.prepare('SELECT * FROM delivery_collections WHERE delivery_id=? ORDER BY id').all(row.id).map(camel);
    const delivered=lines.reduce((sum,line)=>sum+line.deliveredQuantity,0);
    const remaining=lines.reduce((sum,line)=>sum+line.remainingQuantity,0);
    const status=remaining===0?'delivered':delivered>0?'partial':attempts.some(item=>item.outcome==='failed')?'failed_attempt':'assigned';
    return {...camel(row),...camel(sourceRow),lines,attempts,collections,status,deliveredQuantity:delivered,remainingQuantity:remaining,
      collectionStatus:collections.length?'reported_unallocated':'none'};
  };

  app.get('/api/delivery',route(req=>{
    const gstinId=positive(req.query.gstinId,'gstinId'),branchId=positive(req.query.branchId,'branchId');
    assertScopeAccess(db,{companyId:req.company.id,userId:req.user.id,gstinId,branchId});
    const jobs=db.prepare('SELECT * FROM delivery_jobs WHERE company_id=? AND gstin_id=? AND branch_id=? ORDER BY id DESC').all(req.company.id,gstinId,branchId).map(detail);
    const dispatches=db.prepare(`SELECT f.id,f.number,f.event_date,o.id AS order_id,o.number AS order_number,o.party_name_snapshot,
      p.address,COALESCE(SUM(fl.quantity),0) AS quantity FROM order_fulfillments f JOIN orders o ON o.id=f.order_id
      JOIN parties p ON p.id=o.party_id JOIN order_fulfillment_lines fl ON fl.fulfillment_id=f.id
      LEFT JOIN delivery_jobs d ON d.fulfillment_id=f.id
      WHERE o.company_id=? AND o.gstin_id=? AND o.branch_id=? AND o.type='sale' AND f.kind='dispatch' AND f.status='confirmed' AND d.id IS NULL
      GROUP BY f.id ORDER BY f.id DESC`).all(req.company.id,gstinId,branchId).map(camel);
    const users=db.prepare("SELECT id,name,role FROM users WHERE company_id=? AND role IN ('staff','admin') ORDER BY name").all(req.company.id)
      .filter(user=>{ const grants=allowedScopes(db,{companyId:req.company.id,userId:user.id}); return grants.gstinIds.includes(gstinId)&&grants.branchIds.includes(branchId); });
    return {deliveries:jobs,dispatches,users};
  }));
  app.get('/api/delivery/:id',route(req=>({delivery:detail(job(req,req.params.id))})));
  app.post('/api/delivery',route(req=>atomic(()=>{
    writer(req);
    const body=req.body||{}; const fulfillmentId=positive(body.fulfillmentId,'fulfillmentId');
    const sourceRow=source(req,fulfillmentId); const user=assignee(req,body.assigneeId??req.user.id,sourceRow);
    const payload={fulfillmentId,assigneeId:user.id,address:str(body.address,'address',500),clientReference:str(body.clientReference,'clientReference',100)};
    const existing=db.prepare('SELECT * FROM delivery_jobs WHERE company_id=? AND client_reference=?').get(req.company.id,payload.clientReference);
    if (existing) { scope(req,existing); if (existing.payload_json!==JSON.stringify(payload)) throw fail('clientReference already belongs to a different delivery',409); return {delivery:detail(existing),replayed:true}; }
    if (db.prepare('SELECT 1 FROM delivery_jobs WHERE fulfillment_id=?').get(fulfillmentId)) throw fail('This dispatch already has a delivery assignment',409);
    const id=Number(db.prepare(`INSERT INTO delivery_jobs(company_id,gstin_id,branch_id,order_id,fulfillment_id,assignee_id,address,client_reference,created_by,payload_json)
      VALUES (?,?,?,?,?,?,?,?,?,?)`).run(req.company.id,sourceRow.gstin_id,sourceRow.branch_id,sourceRow.order_id,fulfillmentId,user.id,payload.address,payload.clientReference,req.user.id,JSON.stringify(payload)).lastInsertRowid);
    return {delivery:detail(job(req,id)),replayed:false};
  })));
  app.post('/api/delivery/:id/attempts',route(req=>atomic(()=>{
    const row=job(req,req.params.id); editor(req,row);
    const body=req.body||{}, clientReference=str(body.clientReference,'clientReference',100);
    const outcome=str(body.outcome,'outcome',20);
    if (!['failed','partial','delivered'].includes(outcome)) throw fail('Invalid delivery outcome');
    const proofMethod=str(body.proofMethod,'proofMethod',30);
    if (!['none','recipient_name','reference_code'].includes(proofMethod)) throw fail('Invalid proof method');
    const raw=body.lines;
    if (!Array.isArray(raw) || raw.length>100) throw fail('lines must be an array of at most 100 entries');
    const seen=new Set();
    const lines=raw.map(entry=>{ const orderLineId=positive(entry.orderLineId,'orderLineId'),quantity=positive(entry.quantity,'quantity'); if (seen.has(orderLineId)) throw fail('Duplicate order line'); seen.add(orderLineId); return {orderLineId,quantity}; });
    const payload={clientReference,outcome,attemptDate:day(body.attemptDate,'attemptDate'),lines,proofMethod,
      recipientName:str(body.recipientName??'','recipientName',120,false),proofReference:str(body.proofReference??'','proofReference',120,false),
      reason:str(body.reason??'','reason',300,false),note:str(body.note??'','note',500,false)};
    const existing=db.prepare('SELECT * FROM delivery_attempts WHERE delivery_id=? AND client_reference=?').get(row.id,clientReference);
    if (existing) { if (existing.payload_json!==JSON.stringify(payload)) throw fail('clientReference already belongs to a different attempt',409); return {delivery:detail(row),attempt:camel(existing),replayed:true}; }
    const current=detail(row);
    if (current.remainingQuantity===0) throw fail('All dispatched quantities are already delivered',409);
    if (outcome==='failed') { if (lines.length || !payload.reason || proofMethod!=='none') throw fail('Failed attempt needs a reason, no delivered lines and no proof'); }
    else {
      if (!lines.length) throw fail('Delivered quantities are required');
      if (proofMethod==='none' || (proofMethod==='recipient_name'&&!payload.recipientName) || (proofMethod==='reference_code'&&!payload.proofReference)) throw fail('A staff reported recipient name or reference is required for handover');
      for (const entry of lines) { const sourceLine=current.lines.find(line=>line.orderLineId===entry.orderLineId); if (!sourceLine) throw fail('Line is outside this dispatch',409); if (entry.quantity>sourceLine.remainingQuantity) throw fail('Quantity exceeds remaining dispatch quantity',409); }
      const remaining=current.remainingQuantity-lines.reduce((sum,line)=>sum+line.quantity,0);
      if (outcome==='delivered' && remaining!==0) throw fail('Delivered outcome requires all dispatch quantities',409);
      if (outcome==='partial' && remaining===0) throw fail('Use delivered outcome when all dispatch quantities are handed over',409);
    }
    const attemptId=Number(db.prepare(`INSERT INTO delivery_attempts(delivery_id,client_reference,outcome,attempt_date,reason,note,proof_method,recipient_name,proof_reference,actor_id,payload_json)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(row.id,clientReference,outcome,payload.attemptDate,payload.reason,payload.note,proofMethod,payload.recipientName,payload.proofReference,req.user.id,JSON.stringify(payload)).lastInsertRowid);
    for (const entry of lines) db.prepare('INSERT INTO delivery_attempt_lines(attempt_id,order_line_id,quantity) VALUES (?,?,?)').run(attemptId,entry.orderLineId,entry.quantity);
    return {delivery:detail(row),attempt:camel(db.prepare('SELECT * FROM delivery_attempts WHERE id=?').get(attemptId)),replayed:false};
  })));
  app.post('/api/delivery/:id/collections',route(req=>atomic(()=>{
    const row=job(req,req.params.id); editor(req,row); const body=req.body||{};
    const method=str(body.method,'method',20); if (!['cash','upi','bank','other'].includes(method)) throw fail('Invalid collection method');
    const payload={clientReference:str(body.clientReference,'clientReference',100),reportedAmountCents:cents(body.reportedAmountCents,'reportedAmountCents'),method,
      reference:str(body.reference,'reference',120),note:str(body.note,'note',500)};
    const existing=db.prepare('SELECT * FROM delivery_collections WHERE delivery_id=? AND client_reference=?').get(row.id,payload.clientReference);
    if (existing) { if (existing.payload_json!==JSON.stringify(payload)) throw fail('clientReference already belongs to a different collection report',409); return {delivery:detail(row),collection:camel(existing),replayed:true}; }
    const id=Number(db.prepare(`INSERT INTO delivery_collections(delivery_id,client_reference,reported_amount_cents,method,reference,note,actor_id,payload_json)
      VALUES (?,?,?,?,?,?,?,?)`).run(row.id,payload.clientReference,payload.reportedAmountCents,method,payload.reference,payload.note,req.user.id,JSON.stringify(payload)).lastInsertRowid);
    return {delivery:detail(row),collection:camel(db.prepare('SELECT * FROM delivery_collections WHERE id=?').get(id)),replayed:false};
  })));
}

module.exports={installDeliverySchema,seedDeliveryDemo,registerDeliveryRoutes};
