const { randomUUID } = require('node:crypto');
const { installStatutoryLifecycleSchema } = require('./statutory-lifecycle-db.cjs');
const { assertGstinAccess, assertScopeAccess, allowedScopes } = require('./access.cjs');

const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const route = handler => (req, res, next) => { try { res.json(handler(req)); } catch (error) { next(error); } };
const transaction = (db, action) => {
  db.exec('BEGIN IMMEDIATE');
  try { const value = action(); db.exec('COMMIT'); return value; }
  catch (error) { db.exec('ROLLBACK'); throw error; }
};
const positive = (value, name) => {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) throw fail(`${name} must be a positive integer`);
  return number;
};
const string = (value, name, max = 128) => {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw fail(`${name} must be 1-${max} characters`);
  return value.trim();
};
const scenario = value => {
  if (!['success', 'rejection', 'timeout'].includes(value ?? 'success')) throw fail('scenario is invalid');
  return value ?? 'success';
};
const reference = kind => `SIM-${kind.toUpperCase().replaceAll('_', '-')}-${randomUUID().slice(0, 12).toUpperCase()}`;
const asJson = value => JSON.stringify(value);
const parse = value => value ? JSON.parse(value) : null;
const document = row => row && ({ id:row.id, companyId:row.company_id, gstinId:row.gstin_id, kind:row.kind,
  sourceId:row.source_id, status:row.status, reference:row.reference, acknowledgement:row.acknowledgement,
  vehicleNumber:row.vehicle_number, savedBy:row.saved_by, reviewedBy:row.reviewed_by,
  signedBy:row.signed_by, filedBy:row.filed_by, createdAt:row.created_at, updatedAt:row.updated_at,
  simulation:true });
const event = row => ({ id:row.id, companyId:row.company_id, gstinId:row.gstin_id, kind:row.kind,
  sourceId:row.source_id, action:row.action, outcome:row.outcome, idempotencyKey:row.idempotency_key,
  request:parse(row.request_json), response:parse(row.response_json), sourceSnapshot:parse(row.source_snapshot_json),
  actorId:row.actor_id, createdAt:row.created_at, simulation:true });

function registerStatutoryLifecycleRoutes(app, db) {
  installStatutoryLifecycleSchema(db);
  const requireReviewer = req => {
    if (!['accountant','admin'].includes(req.user.role)) throw fail('Accountant or admin role required', 403);
  };
  const gstinRow = (id, companyId) => {
    const row = db.prepare('SELECT * FROM gstins WHERE id=? AND company_id=?').get(id, companyId);
    if (!row) throw fail('GSTIN not found in selected company', 404);
    return row;
  };
  const fullGstinAccess = (req, gstinId) => {
    assertGstinAccess(db,{companyId:req.company.id,userId:req.user.id,gstinId});
    const allowed = allowedScopes(db,{companyId:req.company.id,userId:req.user.id});
    const branches = db.prepare('SELECT id FROM branches WHERE company_id=? AND gstin_id=?').all(req.company.id,gstinId);
    return branches.every(branch => allowed.branchIds.includes(branch.id));
  };
  const requireFullGstinAccess = (req,gstinId) => {
    if (!fullGstinAccess(req,gstinId)) throw fail('All branches for this GSTIN are required',403);
  };
  const sourceRow = (kind, id, companyId, gstinId) => {
    if (kind === 'gst_return') {
      const row = db.prepare('SELECT * FROM gst_periods WHERE id=? AND company_id=? AND gstin_id=?').get(id,companyId,gstinId);
      if (!row) throw fail('GST period not found for selected GSTIN', 404);
      if (row.status !== 'approved') throw fail('Internally approved GST period required', 409);
      return { ...row, simulation:true, noOfficialFiling:true };
    }
    const row = db.prepare('SELECT * FROM invoices WHERE id=? AND company_id=? AND gstin_id=?').get(id,companyId,gstinId);
    if (!row) throw fail('Invoice not found for selected GSTIN', 404);
    if (row.status !== 'approved' || row.type !== 'sale') throw fail('Approved sales invoice required', 409);
    const lines = db.prepare('SELECT item_id,quantity,unit_price_cents,gst_rate_bps,subtotal_cents,tax_cents,total_cents FROM invoice_lines WHERE invoice_id=? ORDER BY id').all(id);
    return { ...row, lines, simulation:true, noOfficialRegistration:true };
  };
  const lookupDocument = (companyId, gstinId, kind, sourceId) => db.prepare('SELECT * FROM statutory_lifecycle_documents WHERE company_id=? AND gstin_id=? AND kind=? AND source_id=?').get(companyId,gstinId,kind,sourceId);
  const lookupEvent = (companyId, key, requestJson) => {
    const row = db.prepare('SELECT * FROM statutory_lifecycle_events WHERE company_id=? AND idempotency_key=?').get(companyId,key);
    if (!row) return null;
    if (row.request_json !== requestJson) throw fail('Idempotency key already used for a different request', 409);
    return row;
  };
  const insertEvent = ({companyId,gstinId,kind,sourceId,action,outcome,key,requestJson,response,snapshot,actorId}) => {
    const id = Number(db.prepare(`INSERT INTO statutory_lifecycle_events
      (company_id,gstin_id,kind,source_id,action,outcome,idempotency_key,request_json,response_json,source_snapshot_json,actor_id)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(companyId,gstinId,kind,sourceId,action,outcome,key,requestJson,asJson(response),snapshot ? asJson(snapshot) : null,actorId).lastInsertRowid);
    return db.prepare('SELECT * FROM statutory_lifecycle_events WHERE id=?').get(id);
  };
  const actions = { irn:['generate','get','cancel'], eway:['generate','get','update_part_b','cancel'],
    gst_return:['save','review','sign','file','status'] };

  app.post('/api/statutory/auth', route(req => {
    requireReviewer(req);
    const body = req.body || {}, companyId = req.company.id;
    const gstinId = positive(body.gstinId,'gstinId');
    const service = string(body.service,'service',20);
    if (!Object.hasOwn(actions,service)) throw fail('service is invalid');
    const outcome = scenario(body.scenario);
    const key = string(body.idempotencyKey,'idempotencyKey');
    const request = {gstinId,service,scenario:outcome};
    const requestJson = asJson(request);
    return transaction(db, () => {
      gstinRow(gstinId,companyId);
      assertGstinAccess(db,{companyId,userId:req.user.id,gstinId});
      if (service === 'gst_return') requireFullGstinAccess(req,gstinId);
      const replay = lookupEvent(companyId,key,requestJson);
      if (replay) return { event:event(replay), token:replay.outcome === 'success' ? db.prepare('SELECT * FROM statutory_lifecycle_sessions WHERE token_reference=?').get(parse(replay.response_json).tokenReference) : null, replayed:true, simulation:true };
      const tokenReference = outcome === 'success' ? reference('token') : null;
      let token = null;
      if (tokenReference) {
        const tokenId = Number(db.prepare(`INSERT INTO statutory_lifecycle_sessions(company_id,gstin_id,service,token_reference,actor_id,expires_at)
          VALUES (?,?,?,?,?,datetime('now','+15 minutes'))`).run(companyId,gstinId,service,tokenReference,req.user.id).lastInsertRowid);
        token = db.prepare('SELECT * FROM statutory_lifecycle_sessions WHERE id=?').get(tokenId);
      }
      const response = {simulation:true,outcome,tokenReference,expiresAt:token?.expires_at ?? null,
        message:outcome === 'success' ? 'Simulated token issued for 15 minutes' : outcome === 'timeout' ? 'Simulated authentication timeout' : 'Simulated authentication rejection'};
      const record = insertEvent({companyId,gstinId,kind:service,sourceId:null,action:'auth',outcome,key,requestJson,response,snapshot:null,actorId:req.user.id});
      return {event:event(record),token,replayed:false,simulation:true};
    });
  }));

  app.post('/api/statutory/:kind/:action', route(req => {
    const {kind,action} = req.params;
    if (!Object.hasOwn(actions,kind) || !actions[kind].includes(action)) throw fail('Unsupported simulated statutory action', 404);
    const body = req.body || {}, companyId = req.company.id;
    const gstinId = positive(body.gstinId,'gstinId'), sourceId = positive(body.sourceId,'sourceId');
    const outcome = scenario(body.scenario), key = string(body.idempotencyKey,'idempotencyKey');
    const tokenId = positive(body.tokenId,'tokenId');
    const vehicleNumber = body.vehicleNumber === undefined ? null : string(body.vehicleNumber,'vehicleNumber',20).toUpperCase();
    const reason = body.reason === undefined ? null : string(body.reason,'reason',200);
    if (action === 'update_part_b' && !vehicleNumber) throw fail('vehicleNumber required for Part B update');
    if (action === 'cancel' && !reason) throw fail('reason required for cancellation');
    requireReviewer(req);
    const request = {kind,action,gstinId,sourceId,scenario:outcome,tokenId,vehicleNumber,reason};
    const requestJson = asJson(request);
    return transaction(db, () => {
      gstinRow(gstinId,companyId);
      assertGstinAccess(db,{companyId,userId:req.user.id,gstinId});
      if (kind === 'gst_return') requireFullGstinAccess(req,gstinId);
      const token = db.prepare('SELECT * FROM statutory_lifecycle_sessions WHERE id=? AND company_id=? AND gstin_id=? AND service=?').get(tokenId,companyId,gstinId,kind);
      if (!token) throw fail('Simulated token not found for this company, GSTIN and service', 403);
      if (kind !== 'gst_return' && token.actor_id !== req.user.id) throw fail('Simulated token belongs to another reviewer',403);
      const snapshot = sourceRow(kind,sourceId,companyId,gstinId);
      if (kind !== 'gst_return') assertScopeAccess(db,{companyId,userId:req.user.id,gstinId,branchId:snapshot.branch_id});
      const replay = lookupEvent(companyId,key,requestJson);
      if (replay) return {event:event(replay),document:document(lookupDocument(companyId,gstinId,kind,sourceId)) || null,replayed:true,simulation:true};
      if (db.prepare("SELECT datetime('now') >= datetime(?) AS expired").get(token.expires_at).expired) throw fail('Simulated token expired; authenticate again', 401);
      const current = lookupDocument(companyId,gstinId,kind,sourceId);
      validateTransition(kind,action,current,req.user.id);
      const newReference = outcome === 'success' && ['generate','save'].includes(action) ? reference(kind) : null;
      const acknowledgement = outcome === 'success' && action === 'file' ? reference('arn') : null;
      const response = { simulation:true,outcome,action,reference:newReference || current?.reference || null,
        acknowledgement:acknowledgement || current?.acknowledgement || null,
        message:outcome === 'success' ? `Simulated ${action} accepted locally` : outcome === 'timeout' ? `Simulated ${action} timed out; source state unchanged` : `Simulated ${action} rejected; source state unchanged`,
        officialSubmission:false, officialSignature:false };
      if (outcome === 'success' && !['get','status'].includes(action)) applyTransition(db,{companyId,gstinId,kind,sourceId,action,current,actorId:req.user.id,reference:newReference,acknowledgement,vehicleNumber});
      const record = insertEvent({companyId,gstinId,kind,sourceId,action,outcome,key,requestJson,response,snapshot,actorId:req.user.id});
      return {event:event(record),document:document(lookupDocument(companyId,gstinId,kind,sourceId)) || null,replayed:false,simulation:true};
    });
  }));

  app.get('/api/statutory/documents', route(req => {
    const companyId=req.company.id, gstinId=positive(req.query.gstinId,'gstinId');
    gstinRow(gstinId,companyId);
    assertGstinAccess(db,{companyId,userId:req.user.id,gstinId});
    const full = fullGstinAccess(req,gstinId);
    const rows=db.prepare('SELECT * FROM statutory_lifecycle_documents WHERE company_id=? AND gstin_id=? ORDER BY id DESC').all(companyId,gstinId);
    const allowed = allowedScopes(db,{companyId,userId:req.user.id});
    return {documents:rows.filter(row => {
      if (row.kind === 'gst_return') return full;
      const source = db.prepare('SELECT branch_id FROM invoices WHERE id=? AND company_id=? AND gstin_id=?').get(row.source_id,companyId,gstinId);
      return source && allowed.branchIds.includes(source.branch_id);
    }).map(document),simulation:true};
  }));
  app.get('/api/statutory/events', route(req => {
    const companyId=req.company.id, gstinId=positive(req.query.gstinId,'gstinId');
    gstinRow(gstinId,companyId);
    assertGstinAccess(db,{companyId,userId:req.user.id,gstinId});
    const full = fullGstinAccess(req,gstinId);
    const allowed = allowedScopes(db,{companyId,userId:req.user.id});
    const slots = allowed.branchIds.map(() => '?').join(',') || 'NULL';
    const rows=db.prepare(`SELECT e.* FROM statutory_lifecycle_events e WHERE e.company_id=? AND e.gstin_id=?
      AND ((e.action='auth' AND (?=1 OR e.actor_id=?) AND (e.kind!='gst_return' OR ?=1))
        OR (e.kind='gst_return' AND ?=1) OR (e.kind IN ('irn','eway') AND EXISTS
        (SELECT 1 FROM invoices i WHERE i.id=e.source_id AND i.company_id=e.company_id AND i.gstin_id=e.gstin_id AND i.branch_id IN (${slots}))))
      ORDER BY e.id DESC LIMIT 200`).all(companyId,gstinId,Number(full),req.user.id,Number(full),Number(full),...allowed.branchIds);
    return {events:rows.map(event),simulation:true};
  }));
}

function validateTransition(kind, action, current, actorId) {
  const status = current?.status || null;
  const allowed = {
    irn:{generate:[null],get:['generated','cancelled'],cancel:['generated']},
    eway:{generate:[null],get:['generated','cancelled'],update_part_b:['generated'],cancel:['generated']},
    gst_return:{save:[null],review:['saved'],sign:['reviewed'],file:['signed'],status:['saved','reviewed','signed','filed']},
  };
  if (!allowed[kind]?.[action]?.includes(status)) throw fail(`Cannot ${action} ${kind} from ${status || 'new'} state`,409);
  if (kind === 'gst_return' && action === 'review' && current.saved_by === actorId) throw fail('Saver cannot review the same simulated return',403);
  if (kind === 'gst_return' && action === 'sign' && current.reviewed_by === actorId) throw fail('Reviewer cannot simulate signing the same return',403);
}

function applyTransition(db,{companyId,gstinId,kind,sourceId,action,current,actorId,reference:ref,acknowledgement,vehicleNumber}) {
  if (!current) {
    const status = kind === 'gst_return' ? 'saved' : 'generated';
    db.prepare(`INSERT INTO statutory_lifecycle_documents(company_id,gstin_id,kind,source_id,status,reference,vehicle_number,saved_by)
      VALUES (?,?,?,?,?,?,?,?)`).run(companyId,gstinId,kind,sourceId,status,ref,vehicleNumber,kind === 'gst_return' ? actorId : null);
    return;
  }
  const next = {cancel:'cancelled',update_part_b:'generated',review:'reviewed',sign:'signed',file:'filed'}[action];
  db.prepare(`UPDATE statutory_lifecycle_documents SET status=?,vehicle_number=COALESCE(?,vehicle_number),
    reviewed_by=CASE WHEN ?='review' THEN ? ELSE reviewed_by END,
    signed_by=CASE WHEN ?='sign' THEN ? ELSE signed_by END,
    filed_by=CASE WHEN ?='file' THEN ? ELSE filed_by END,
    acknowledgement=COALESCE(?,acknowledgement),updated_at=CURRENT_TIMESTAMP WHERE id=?`)
    .run(next,vehicleNumber,action,actorId,action,actorId,action,actorId,acknowledgement,current.id);
}

module.exports = { registerStatutoryLifecycleRoutes };
