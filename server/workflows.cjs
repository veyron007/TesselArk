const features = require('../src/data/features.json');
const { allowedScopes, assertScopeAccess } = require('./access.cjs');
const featureMap = new Map(features.map(feature => [feature.id, feature]));
const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const camel = row => Object.fromEntries(Object.entries(row).map(([key, value]) => [key.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase()), value]));
const positiveId = (value, label) => {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id < 1) throw fail(`${label} must be a positive integer`);
  return id;
};
const string = (value, label, max, required = true) => {
  if (typeof value !== 'string' || value.length > max || (required && !value.trim())) throw fail(`${label} is invalid`);
  return value.trim();
};
const date = value => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`)) || new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value) throw fail('date must be a valid YYYY-MM-DD date');
  return value;
};
const fields = value => {
  if (value === undefined) return {};
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw fail('fields must be an object');
  const entries = Object.entries(value);
  if (entries.length > 20) throw fail('fields may contain at most 20 entries');
  for (const [key, item] of entries) {
    if (!/^[a-zA-Z][a-zA-Z0-9_]{0,49}$/.test(key)) throw fail(`Invalid field name: ${key}`);
    if (item !== null && typeof item !== 'string' && typeof item !== 'number' && typeof item !== 'boolean') throw fail(`Invalid value for field ${key}`);
    if (typeof item === 'string' && item.length > 500 || typeof item === 'number' && !Number.isFinite(item)) throw fail(`Invalid value for field ${key}`);
  }
  if (JSON.stringify(value).length > 4000) throw fail('fields are too large');
  return value;
};

function registerWorkflowRoutes(app, db) {
  const route = handler => (req, res, next) => { try { res.json(handler(req)); } catch (error) { next(error); } };
  const transact = action => { db.exec('BEGIN IMMEDIATE'); try { const result = action(); db.exec('COMMIT'); return result; } catch (error) { db.exec('ROLLBACK'); throw error; } };
  const caseRow = (id, companyId, userId) => {
    const row = db.prepare('SELECT * FROM workflow_cases WHERE id=? AND company_id=?').get(id, companyId);
    if (!row) throw fail('Workflow case not found in selected company', 404);
    if (userId) assertScopeAccess(db,{companyId,userId,gstinId:row.gstin_id,branchId:row.branch_id});
    return row;
  };
  const present = row => {
    const feature = featureMap.get(row.feature_id);
    const { recordDate, fieldsJson, ...rest } = camel(row);
    return { ...rest, date: recordDate, fields: JSON.parse(fieldsJson), featureDomain: feature?.domain || '', featureCapability: feature?.capability || '', prototype: true };
  };
  const event = (row, action, actorId, details = '') => {
    db.prepare('INSERT INTO workflow_case_events(case_id,company_id,action,actor_id,details,snapshot_json) VALUES (?,?,?,?,?,?)').run(row.id,row.company_id,action,actorId,details,JSON.stringify(present(row)));
  };
  const scope = (companyId, gstinId, branchId) => {
    const gstin = db.prepare('SELECT id FROM gstins WHERE id=? AND company_id=?').get(gstinId,companyId);
    const branch = db.prepare('SELECT id FROM branches WHERE id=? AND gstin_id=? AND company_id=?').get(branchId,gstinId,companyId);
    if (!gstin || !branch) throw fail('Branch and GSTIN must belong to the selected company and each other');
  };
  const input = (body, companyId, previous = {}) => {
    if (body === null || typeof body !== 'object' || Array.isArray(body)) throw fail('Body must be an object');
    const featureId = string(body.featureId ?? previous.feature_id,'featureId',20);
    if (!featureMap.has(featureId)) throw fail('Unknown featureId');
    const gstinId = positiveId(body.gstinId ?? previous.gstin_id,'gstinId');
    const branchId = positiveId(body.branchId ?? previous.branch_id,'branchId');
    scope(companyId,gstinId,branchId);
    const amountCents = body.amountCents ?? previous.amount_cents;
    if (!Number.isSafeInteger(amountCents) || amountCents < 0) throw fail('amountCents must be a non-negative integer');
    return { featureId,gstinId,branchId,title:string(body.title ?? previous.title,'title',200),reference:string(body.reference ?? previous.reference ?? '','reference',100,false),date:date(body.date ?? previous.record_date),amountCents,notes:string(body.notes ?? previous.notes ?? '','notes',2000,false),evidenceReference:string(body.evidenceReference ?? previous.evidence_reference ?? '','evidenceReference',300,false),fields:fields(body.fields ?? (previous.fields_json ? JSON.parse(previous.fields_json) : undefined)) };
  };
  const reviewer = req => { if (!['accountant','admin'].includes(req.user.role)) throw fail('Accountant or admin role required',403); };

  app.get('/api/workflows/cases', route(req => {
    const featureId = req.query.featureId === undefined ? null : string(req.query.featureId,'featureId',20);
    if (featureId && !featureMap.has(featureId)) throw fail('Unknown featureId');
    const gstinId = req.query.gstinId === undefined ? null : positiveId(req.query.gstinId,'gstinId');
    const branchId = req.query.branchId === undefined ? null : positiveId(req.query.branchId,'branchId');
    if (gstinId && !db.prepare('SELECT 1 FROM gstins WHERE id=? AND company_id=?').get(gstinId,req.company.id)) throw fail('GSTIN not found in selected company',404);
    if (branchId && !db.prepare('SELECT 1 FROM branches WHERE id=? AND company_id=?').get(branchId,req.company.id)) throw fail('Branch not found in selected company',404);
    if (gstinId || branchId) assertScopeAccess(db,{companyId:req.company.id,userId:req.user.id,
      ...(gstinId ? {gstinId} : {}),...(branchId ? {branchId} : {})});
    const allowed = allowedScopes(db,{companyId:req.company.id,userId:req.user.id});
    const cases = db.prepare('SELECT * FROM workflow_cases WHERE company_id=? AND (? IS NULL OR feature_id=?) AND (? IS NULL OR gstin_id=?) AND (? IS NULL OR branch_id=?) ORDER BY id DESC').all(req.company.id,featureId,featureId,gstinId,gstinId,branchId,branchId)
      .filter(row => allowed.gstinIds.includes(row.gstin_id) && allowed.branchIds.includes(row.branch_id)).map(present);
    return { prototype:true,cases };
  }));
  app.post('/api/workflows/cases', route(req => transact(() => {
    const value = input(req.body,req.company.id);
    assertScopeAccess(db,{companyId:req.company.id,userId:req.user.id,gstinId:value.gstinId,branchId:value.branchId});
    const id = Number(db.prepare('INSERT INTO workflow_cases(company_id,feature_id,gstin_id,branch_id,title,reference,record_date,amount_cents,notes,evidence_reference,fields_json,created_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)').run(req.company.id,value.featureId,value.gstinId,value.branchId,value.title,value.reference,value.date,value.amountCents,value.notes,value.evidenceReference,JSON.stringify(value.fields),req.user.id).lastInsertRowid);
    const row = caseRow(id,req.company.id); event(row,'create',req.user.id);
    return { prototype:true,case:present(row) };
  })));
  app.get('/api/workflows/cases/:id/events', route(req => {
    const row = caseRow(positiveId(req.params.id,'id'),req.company.id,req.user.id);
    const events = db.prepare('SELECT * FROM workflow_case_events WHERE case_id=? AND company_id=? ORDER BY id').all(row.id,req.company.id).map(item => {
      const { snapshotJson, ...rest } = camel(item);
      return { ...rest, snapshot:JSON.parse(snapshotJson) };
    });
    return { prototype:true,events };
  }));
  app.get('/api/workflows/cases/:id', route(req => ({ prototype:true,case:present(caseRow(positiveId(req.params.id,'id'),req.company.id,req.user.id)) })));
  app.put('/api/workflows/cases/:id', route(req => transact(() => {
    const row = caseRow(positiveId(req.params.id,'id'),req.company.id,req.user.id);
    if (row.status !== 'draft') throw fail('Only draft workflow cases can be edited',409);
    const value = input(req.body,req.company.id,row);
    assertScopeAccess(db,{companyId:req.company.id,userId:req.user.id,gstinId:value.gstinId,branchId:value.branchId});
    if ((value.gstinId !== row.gstin_id || value.branchId !== row.branch_id) &&
        db.prepare("SELECT 1 FROM evidence_documents WHERE company_id=? AND target_type='workflow_case' AND target_id=? LIMIT 1").get(req.company.id,row.id)) {
      throw fail('GSTIN and branch cannot change after evidence is linked',409);
    }
    db.prepare("UPDATE workflow_cases SET feature_id=?,gstin_id=?,branch_id=?,title=?,reference=?,record_date=?,amount_cents=?,notes=?,evidence_reference=?,fields_json=?,updated_at=CURRENT_TIMESTAMP WHERE id=?").run(value.featureId,value.gstinId,value.branchId,value.title,value.reference,value.date,value.amountCents,value.notes,value.evidenceReference,JSON.stringify(value.fields),row.id);
    const updated = caseRow(row.id,req.company.id); event(updated,'update',req.user.id);
    return { prototype:true,case:present(updated) };
  })));
  app.post('/api/workflows/cases/:id/submit', route(req => transact(() => {
    const row = caseRow(positiveId(req.params.id,'id'),req.company.id,req.user.id);
    if (row.status !== 'draft') throw fail('Only draft workflow cases can be submitted',409);
    db.prepare("UPDATE workflow_cases SET status='submitted',submitted_by=?,updated_at=CURRENT_TIMESTAMP WHERE id=?").run(req.user.id,row.id);
    const updated = caseRow(row.id,req.company.id); event(updated,'submit',req.user.id);
    return { prototype:true,case:present(updated) };
  })));
  const review = (action, status) => route(req => transact(() => {
    reviewer(req);
    const row = caseRow(positiveId(req.params.id,'id'),req.company.id,req.user.id);
    if (row.status !== 'submitted') throw fail('Only submitted workflow cases can be reviewed',409);
    const reason = string(req.body?.reason ?? '','reason',1000,false);
    db.prepare('UPDATE workflow_cases SET status=?,reviewed_by=?,review_reason=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(status,req.user.id,reason,row.id);
    const updated = caseRow(row.id,req.company.id); event(updated,action,req.user.id,reason);
    return { prototype:true,case:present(updated) };
  }));
  app.post('/api/workflows/cases/:id/approve', review('approve','approved'));
  app.post('/api/workflows/cases/:id/reject', review('reject','rejected'));
}

module.exports = { registerWorkflowRoutes };
