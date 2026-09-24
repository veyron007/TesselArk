const { createHash } = require('node:crypto');
const { assertScopeAccess,assertCompanyWideAccess } = require('./access.cjs');
const { assessInvoice } = require('./gst-invoice-assistant.cjs');
const { sourceFingerprint } = require('./expenses.cjs');
const { installInboxSchema } = require('./inbox-db.cjs');

const fail = (message,status=400) => Object.assign(new Error(message),{status});
const sourceTypes = new Set(['crm','invoice','expense','cashier','work_task']);
const policySourceTypes = new Set(['crm','invoice','expense','cashier']);
const validId = (value,name) => { const n=Number(value); if (!Number.isSafeInteger(n) || n<1 || !/^\d+$/.test(String(value))) throw fail(`${name} must be a positive integer`); return n; };
const date = (value,name) => { const parsed=typeof value==='string' ? Date.parse(`${value}T00:00:00Z`) : NaN; if (typeof value!=='string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(parsed) || new Date(parsed).toISOString().slice(0,10)!==value) throw fail(`${name} must be a real YYYY-MM-DD date`); return value; };
const reason = value => { if (typeof value!=='string' || !value.trim() || value.trim().length>500 || /[\x00-\x1f\x7f]/.test(value)) throw fail('reason must be 1 to 500 printable characters'); return value.trim(); };
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const toIso = value => value && value.replace(' ','T') + (value.includes('Z') ? '' : 'Z');
const localLink = (page,row,id=null) => `/${page}${id ? `?record=${id}&` : '?'}gstin=${row.gstin_id}&branch=${row.branch_id}`;
const eventsFor = (db,sql,sourceId) => db.prepare(sql).all(sourceId).map(row => ({id:row.id,kind:row.kind,detail:row.detail,at:toIso(row.created_at),actorName:row.actor_name}));

function userState(db,req,item) {
  return item.sourceType==='work_task'
    ? db.prepare('SELECT * FROM inbox_work_task_user_state WHERE company_id=? AND user_id=? AND task_id=?').get(req.company.id,req.user.id,item.sourceId)
    : db.prepare('SELECT * FROM inbox_user_state WHERE company_id=? AND user_id=? AND source_type=? AND source_id=?')
      .get(req.company.id,req.user.id,item.sourceType,item.sourceId);
}

function writeUserState(db,req,item,kind,value) {
  const column=kind==='acknowledge'?'acknowledged_revision':'snoozed_revision';
  const other=kind==='acknowledge'?'acknowledged_at':'snoozed_until';
  const timestamp=kind==='acknowledge'?'CURRENT_TIMESTAMP':'?';
  if (item.sourceType==='work_task') {
    db.prepare(`INSERT INTO inbox_work_task_user_state(company_id,user_id,task_id,${column},${other})
      VALUES (?,?,?,?,${timestamp}) ON CONFLICT(company_id,user_id,task_id)
      DO UPDATE SET ${column}=excluded.${column},${other}=excluded.${other},updated_at=CURRENT_TIMESTAMP`)
      .run(req.company.id,req.user.id,item.sourceId,item.sourceRevision,...(kind==='snooze'?[value]:[]));
  } else {
    db.prepare(`INSERT INTO inbox_user_state(company_id,user_id,source_type,source_id,${column},${other})
      VALUES (?,?,?,?,?,${timestamp}) ON CONFLICT(company_id,user_id,source_type,source_id)
      DO UPDATE SET ${column}=excluded.${column},${other}=excluded.${other},updated_at=CURRENT_TIMESTAMP`)
      .run(req.company.id,req.user.id,item.sourceType,item.sourceId,item.sourceRevision,...(kind==='snooze'?[value]:[]));
  }
}

function targetUser(db,req,item) {
  const forbidden = new Set(item.participantIds.filter(Boolean));
  const roles = item.sourceType==='crm' ? ['admin'] : ['accountant','admin'];
  const candidates=db.prepare(`SELECT u.id,u.name,u.role FROM users u
    JOIN user_gstin_grants g ON g.company_id=u.company_id AND g.user_id=u.id AND g.gstin_id=? AND g.revoked_at IS NULL
    JOIN user_branch_grants b ON b.company_id=u.company_id AND b.user_id=u.id AND b.branch_id=? AND b.revoked_at IS NULL
    WHERE u.company_id=? ORDER BY CASE u.role WHEN 'accountant' THEN 0 ELSE 1 END,u.id`)
    .all(item.gstinId,item.branchId,req.company.id);
  return candidates.find(user => roles.includes(user.role) && !forbidden.has(user.id) && user.id!==req.user.id) || null;
}

function decorate(db,req,item) {
  const state=userState(db,req,item);
  const escalation=db.prepare('SELECT e.*,u.name AS target_name FROM inbox_escalations e JOIN users u ON u.id=e.target_user_id WHERE e.company_id=? AND e.source_type=? AND e.source_id=? AND e.source_revision=?')
    .get(req.company.id,item.sourceType,item.sourceId,item.sourceRevision);
  const policy=db.prepare('SELECT * FROM inbox_escalation_policies WHERE company_id=? AND source_type=? AND revoked_at IS NULL ORDER BY id DESC LIMIT 1')
    .get(req.company.id,item.sourceType);
  const target=policy ? targetUser(db,req,item) : null;
  const overdueDays=item.dueDate ? Math.floor((Date.now()-Date.parse(`${item.dueDate}T00:00:00Z`))/86400000) : -1;
  const trigger=Boolean(policy && ((policy.blocker_allowed && item.blocker) || overdueDays>=policy.overdue_days));
  const canEscalate=Boolean(policy && target && trigger && item.canEscalateSource && !escalation);
  const snoozedUntil=state?.snoozed_revision===item.sourceRevision && state.snoozed_until>=new Date().toISOString().slice(0,10) ? state.snoozed_until : null;
  const {participantIds,canEscalateSource,...publicItem}=item;
  const escalationUnavailableReason=item.sourceType==='work_task' ? 'Task escalation policy is not configured' : !policy ? 'No approved escalation policy' : !item.canEscalateSource ? 'Only the source owner can escalate' : !target ? 'No independent scoped reviewer is available' : !trigger ? 'Policy threshold has not been met' : escalation ? 'Already escalated for this source revision' : null;
  return {...publicItem,acknowledged:state?.acknowledged_revision===item.sourceRevision,
    acknowledgedRevision:state?.acknowledged_revision||null,snoozedUntil,canEscalate,
    escalationUnavailableReason,
    escalation:escalation ? {status:'requested',reason:escalation.reason,escalatedAt:toIso(escalation.escalated_at),target:{id:escalation.target_user_id,name:escalation.target_name}} : null};
}

function crmItems(db,req) {
  const rows=db.prepare(`SELECT c.*,u.name AS owner_name,o.number AS order_number,
    (SELECT COALESCE(SUM(l.quantity*l.unit_price_cents + ROUND(l.quantity*l.unit_price_cents*l.gst_rate_bps/10000.0)),0) FROM order_lines l WHERE l.order_id=c.order_id) AS order_amount_cents
    FROM order_crm_cases c JOIN users u ON u.id=c.owner_id AND u.company_id=c.company_id
    LEFT JOIN orders o ON o.id=c.order_id AND o.company_id=c.company_id
    WHERE c.company_id=? AND c.status='open' ORDER BY c.due_date,c.id`).all(req.company.id);
  return rows.filter(row => req.scopes.branchIds.includes(row.branch_id) && req.scopes.gstinIds.includes(row.gstin_id)
    && (req.user.role==='admin' || (req.user.role==='staff' && row.owner_id===req.user.id))).map(row => {
    const events=eventsFor(db,'SELECT e.id,e.kind,e.detail,e.created_at,u.name AS actor_name FROM order_crm_events e JOIN users u ON u.id=e.actor_id WHERE e.case_id=? ORDER BY e.id',row.id);
    const blockers=db.prepare("SELECT description FROM order_crm_blockers WHERE case_id=? AND status='open' ORDER BY id").all(row.id);
    return {id:`crm:${row.id}`,sourceType:'crm',sourceId:row.id,companyId:row.company_id,gstinId:row.gstin_id,branchId:row.branch_id,
      title:row.subject,summary:row.next_action,owner:{id:row.owner_id,name:row.owner_name},amountCents:row.order_id ? row.order_amount_cents : null,
      dueDate:row.due_date,blocker:blockers.map(x=>x.description).join('; ')||null,updatedAt:toIso(row.updated_at),
      sourceRevision:hash(['crm',row.id,row.status,row.owner_id,row.next_action,row.due_date,events.at(-1)?.id||0,blockers]),events,
      deepLink:localLink('order-crm',row),permittedAction:'Update customer follow-up',participantIds:[row.owner_id],canEscalateSource:row.owner_id===req.user.id};
  });
}

function invoiceItems(db,req) {
  const rows=db.prepare("SELECT v.*,u.name AS owner_name FROM invoices v JOIN users u ON u.id=v.created_by AND u.company_id=v.company_id WHERE v.company_id=? AND v.status='submitted' ORDER BY v.id DESC").all(req.company.id);
  const items=[];
  for (const row of rows) {
    if (!req.scopes.branchIds.includes(row.branch_id) || !req.scopes.gstinIds.includes(row.gstin_id)) continue;
    const own=row.created_by===req.user.id || row.submitted_by===req.user.id;
    if (req.user.role==='staff' && !own) continue;
    const assessment=assessInvoice(db,{companyId:req.company.id,invoiceId:row.id});
    const blockers=assessment.findings.filter(x=>x.severity==='blocker');
    const independent=['accountant','admin'].includes(req.user.role) && !own;
    const review=assessment.latestReview;
    items.push({id:`invoice:${row.id}`,sourceType:'invoice',sourceId:row.id,companyId:row.company_id,gstinId:row.gstin_id,branchId:row.branch_id,
      title:`${row.type==='purchase'?'Purchase':'Sale'} invoice ${row.number}`,summary:`${row.party_name_snapshot||'Counterparty'} · submitted for independent approval`,
      owner:{id:row.created_by,name:row.owner_name},amountCents:row.total_cents,dueDate:null,
      blocker:assessment.approvalReady?null:blockers.map(x=>x.message).join('; ')||null,updatedAt:null,
      sourceRevision:hash(['invoice',row.id,assessment.fingerprint,assessment.findings,review?.id||0]),
      events:[{id:row.id,kind:'submitted',detail:'Invoice submitted for independent approval',at:null,actorName:row.owner_name},
        ...assessment.findings.map((x,index)=>({id:`finding:${index}`,kind:x.severity,detail:x.message,at:null,actorName:'GST invoice assistant'}))],
      deepLink:localLink('invoice-checks',row,row.id),permittedAction:independent?'Review source invoice for approval':assessment.approvalReady?'Track submitted invoice':'Correct source invoice checks',
      participantIds:[row.created_by,row.submitted_by],canEscalateSource:own});
  }
  return items;
}

function expenseItems(db,req) {
  const rows=db.prepare(`SELECT c.*,u.name AS claimant_name,v.number AS invoice_number,v.total_cents
    FROM expense_claims c JOIN users u ON u.id=c.claimant_user_id AND u.company_id=c.company_id
    JOIN invoices v ON v.id=c.invoice_id AND v.company_id=c.company_id
    WHERE c.company_id=? AND c.status='submitted' ORDER BY c.id DESC`).all(req.company.id);
  return rows.filter(row => req.scopes.branchIds.includes(row.branch_id) && req.scopes.gstinIds.includes(row.gstin_id)
    && (req.user.role!=='staff' || row.claimant_user_id===req.user.id || row.created_by===req.user.id)).map(row => {
    const own=[row.claimant_user_id,row.created_by,row.submitted_by].includes(req.user.id);
    const independent=['accountant','admin'].includes(req.user.role) && !own;
    const events=eventsFor(db,'SELECT e.id,e.action AS kind,e.details AS detail,e.created_at,u.name AS actor_name FROM expense_claim_events e JOIN users u ON u.id=e.actor_id WHERE e.claim_id=? ORDER BY e.id',row.id);
    const source=db.prepare('SELECT * FROM invoices WHERE id=? AND company_id=?').get(row.invoice_id,row.company_id);
    const proof=db.prepare(`SELECT d.id AS document_id,d.company_id,d.gstin_id,d.branch_id,d.target_type,d.target_id,
      v.version,v.sha256,v.status FROM evidence_documents d JOIN evidence_versions v
      ON v.document_id=d.id AND v.version=? WHERE d.id=?`).get(row.evidence_version,row.evidence_document_id);
    const latestVersion=db.prepare('SELECT MAX(version) AS version FROM evidence_versions WHERE document_id=?').get(row.evidence_document_id)?.version;
    const liveFingerprint=source && proof ? sourceFingerprint(db,source,proof) : null;
    const evidenceValid=Boolean(source && proof && proof.company_id===source.company_id && proof.gstin_id===source.gstin_id
      && proof.branch_id===source.branch_id && proof.target_type==='invoice' && proof.target_id===source.id
      && latestVersion===row.evidence_version && proof.status==='approved' && proof.sha256===row.evidence_sha256);
    const sourceChanged=!evidenceValid || liveFingerprint!==row.source_fingerprint;
    return {id:`expense:${row.id}`,sourceType:'expense',sourceId:row.id,companyId:row.company_id,gstinId:row.gstin_id,branchId:row.branch_id,
      title:`Expense claim #${row.id}`,summary:`${row.purpose} · invoice ${row.invoice_number}`,owner:{id:row.claimant_user_id,name:row.claimant_name},
      amountCents:row.total_cents,dueDate:null,blocker:sourceChanged?'Claim source or evidence changed; fresh review is required':'Independent expense review pending',updatedAt:toIso(row.submitted_at||row.created_at),
      sourceChanged,sourceRevision:hash(['expense',row.id,row.version,row.status,events.at(-1)?.id||0,liveFingerprint,latestVersion,evidenceValid]),
      events:sourceChanged?[...events,{id:'source:changed',kind:'source_changed',detail:'The source invoice, settlement, or evidence changed after claim submission.',at:null,actorName:'Expense source check'}]:events,
      deepLink:localLink('expenses',row),permittedAction:independent?'Review expense claim':'Track submitted claim',
      participantIds:[row.claimant_user_id,row.created_by,row.submitted_by],canEscalateSource:own};
  });
}

function cashierItems(db,req) {
  const rows=db.prepare(`SELECT s.*,b.gstin_id,u.name AS closer_name FROM cashier_sessions s
    JOIN branches b ON b.id=s.branch_id AND b.company_id=s.company_id
    JOIN users u ON u.id=s.closed_by AND u.company_id=s.company_id
    WHERE s.company_id=? AND s.status='pending_review' ORDER BY s.id DESC`).all(req.company.id);
  return rows.filter(row => req.scopes.branchIds.includes(row.branch_id) && req.scopes.gstinIds.includes(row.gstin_id)
    && (req.user.role!=='staff' || row.closed_by===req.user.id)).map(row => {
    const own=row.closed_by===req.user.id;
    const independent=['accountant','admin'].includes(req.user.role) && !own;
    const events=eventsFor(db,'SELECT e.id,e.action AS kind,e.details AS detail,e.created_at,u.name AS actor_name FROM cashier_events e JOIN users u ON u.id=e.actor_id WHERE e.session_id=? ORDER BY e.id',row.id);
    return {id:`cashier:${row.id}`,sourceType:'cashier',sourceId:row.id,companyId:row.company_id,gstinId:row.gstin_id,branchId:row.branch_id,
      title:`Cash drawer ${row.business_date}`,summary:row.close_notes||'Cash count discrepancy awaiting review',owner:{id:row.closed_by,name:row.closer_name},
      amountCents:Math.abs(row.discrepancy_cents),dueDate:row.business_date,blocker:`Cash discrepancy ${row.discrepancy_cents} paise`,
      updatedAt:toIso(row.closed_at),sourceRevision:hash(['cashier',row.id,row.status,row.discrepancy_cents,events.at(-1)?.id||0]),events,
      deepLink:localLink('cashier',row),permittedAction:independent?'Review cashier discrepancy':'Track cashier discrepancy',
      participantIds:[row.closed_by,row.opened_by],canEscalateSource:own};
  });
}

function taskScopeVisible(db,req,row) {
  if (!req.scopes.gstinIds.includes(row.gstin_id)) return false;
  if (row.scope_type==='branch') return req.scopes.branchIds.includes(row.branch_id)
    && Boolean(db.prepare('SELECT 1 FROM branches WHERE id=? AND company_id=? AND gstin_id=?').get(row.branch_id,row.company_id,row.gstin_id));
  if (row.scope_type!=='gstin' || row.branch_id!==null) return false;
  const branchIds=db.prepare('SELECT id FROM branches WHERE company_id=? AND gstin_id=?').all(row.company_id,row.gstin_id).map(x=>x.id);
  return branchIds.length>0 && branchIds.every(id=>req.scopes.branchIds.includes(id));
}

function taskAssignmentGrants(db,row,userId) {
  const gstin=db.prepare('SELECT id FROM user_gstin_grants WHERE company_id=? AND user_id=? AND gstin_id=? AND revoked_at IS NULL')
    .get(row.company_id,userId,row.gstin_id)?.id||null;
  const branches=row.scope_type==='branch' ? [row.branch_id]
    : db.prepare('SELECT id FROM branches WHERE company_id=? AND gstin_id=? ORDER BY id').all(row.company_id,row.gstin_id).map(x=>x.id);
  const grants=branches.map(branchId=>db.prepare('SELECT id FROM user_branch_grants WHERE company_id=? AND user_id=? AND branch_id=? AND revoked_at IS NULL')
    .get(row.company_id,userId,branchId)?.id||null);
  return {gstin,branches:grants,valid:Boolean(gstin && branches.length && grants.every(Boolean))};
}

function taskItems(db,req) {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='work_tasks'").get()) return [];
  const rows=db.prepare(`SELECT t.*,p.name AS preparer_name,p.role AS preparer_role,r.name AS reviewer_name,r.role AS reviewer_role
    FROM work_tasks t JOIN users p ON p.id=t.preparer_user_id AND p.company_id=t.company_id
    JOIN users r ON r.id=t.reviewer_user_id AND r.company_id=t.company_id
    WHERE t.company_id=? AND t.status IN ('open','submitted') ORDER BY t.internal_target_date,t.id`).all(req.company.id);
  return rows.filter(row=>taskScopeVisible(db,req,row) && (req.user.role!=='staff'
    || row.preparer_user_id===req.user.id || row.reviewer_user_id===req.user.id)).map(row=>{
    const events=eventsFor(db,'SELECT e.id,e.action AS kind,e.details AS detail,e.created_at,u.name AS actor_name FROM work_task_events e JOIN users u ON u.id=e.actor_id WHERE e.task_id=? ORDER BY e.id',row.id);
    const evidence=db.prepare('SELECT id,version,sha256,status,uploaded_by,reviewed_by FROM work_task_evidence WHERE task_id=? ORDER BY version DESC LIMIT 1').get(row.id)||null;
    const template=db.prepare('SELECT id,version,status,title,checklist_json FROM work_template_versions WHERE template_id=? AND version=?')
      .get(row.template_id,row.template_version)||null;
    const source=row.scope_type==='gstin' ? db.prepare('SELECT id,status,reviewed_by,approved_by FROM gst_periods WHERE company_id=? AND gstin_id=? AND period=?')
      .get(row.company_id,row.gstin_id,row.period)||null : null;
    let dependencyIds;
    try { dependencyIds=JSON.parse(row.dependency_task_ids_json); } catch { dependencyIds=null; }
    if (!Array.isArray(dependencyIds) || dependencyIds.some(id=>!Number.isSafeInteger(id) || id<1)) dependencyIds=null;
    const dependencies=dependencyIds?.map(id=>db.prepare('SELECT id,status,version FROM work_tasks WHERE id=? AND company_id=?').get(id,row.company_id)||{id,status:'missing',version:null})||[];
    const preparerGrants=taskAssignmentGrants(db,row,row.preparer_user_id);
    const reviewerGrants=taskAssignmentGrants(db,row,row.reviewer_user_id);
    const blockers=[];
    if (!preparerGrants.valid || !reviewerGrants.valid) blockers.push('Assigned preparer or reviewer lacks current scope access');
    if (!dependencyIds) blockers.push('Task dependency list needs correction');
    else if (dependencies.some(x=>x.status!=='closed')) blockers.push('A dependency task remains open');
    if (!template || template.status!=='approved') blockers.push('Approved task template version is unavailable');
    if (row.status==='submitted' && evidence?.status!=='approved') blockers.push('Approved task evidence is required for closure');
    const assignedReviewer=row.reviewer_user_id===req.user.id && ['accountant','admin'].includes(req.user.role);
    const assignedPreparer=row.preparer_user_id===req.user.id;
    const deepLink=`/work-tasks?record=${row.id}&gstin=${row.gstin_id}${row.branch_id===null?'':`&branch=${row.branch_id}`}`;
    return {id:`work_task:${row.id}`,sourceType:'work_task',sourceId:row.id,companyId:row.company_id,gstinId:row.gstin_id,branchId:row.branch_id,
      title:row.title,summary:`${row.period} · ${row.status==='submitted'?'Awaiting independent review':'Preparation in progress'}`,
      owner:{id:row.preparer_user_id,name:row.preparer_name},reviewer:{id:row.reviewer_user_id,name:row.reviewer_name},
      amountCents:null,dueDate:row.internal_target_date,dueDateKind:'internal',statutoryDueDate:row.statutory_due_date||null,
      blocker:blockers.join('; ')||null,updatedAt:toIso(row.updated_at),status:row.status,
      evidence:evidence?{version:evidence.version,status:evidence.status}:null,
      source:source?{type:'gst_period',id:source.id,status:source.status}:null,
      sourceRevision:hash(['work_task',row,events.at(-1)?.id||0,evidence,template,source,dependencies,preparerGrants,reviewerGrants]),events,
      deepLink,permittedAction:row.status==='submitted' && assignedReviewer?'Review assigned work task'
        :row.status==='open' && assignedPreparer?'Prepare work task':'Open work task',
      participantIds:[row.preparer_user_id,row.reviewer_user_id],canEscalateSource:false};
  });
}

function list(db,req,{gstinId=null,branchId=null,includeSnoozed=false}={}) {
  if (gstinId!==null || branchId!==null) assertScopeAccess(db,{companyId:req.company.id,userId:req.user.id,
    ...(gstinId!==null?{gstinId}:{}),...(branchId!==null?{branchId}:{})});
  const selectedGstinId=gstinId??(branchId===null?null:db.prepare('SELECT gstin_id FROM branches WHERE id=? AND company_id=?').get(branchId,req.company.id)?.gstin_id);
  const rows=[...crmItems(db,req),...invoiceItems(db,req),...expenseItems(db,req),...cashierItems(db,req),...taskItems(db,req)]
    .filter(x=>(selectedGstinId===null || x.gstinId===selectedGstinId)
      && (branchId===null || x.branchId===branchId || (x.sourceType==='work_task' && x.branchId===null)))
    .map(x=>decorate(db,req,x)).sort((a,b)=>(a.dueDate||'9999').localeCompare(b.dueDate||'9999') || a.id.localeCompare(b.id));
  const counts={total:rows.length,unacknowledged:rows.filter(x=>!x.acknowledged).length,
    overdue:rows.filter(x=>x.dueDate && x.dueDate<new Date().toISOString().slice(0,10)).length,snoozed:rows.filter(x=>x.snoozedUntil).length};
  return {items:includeSnoozed?rows:rows.filter(x=>!x.snoozedUntil),counts};
}

function registerInboxRoutes(app,db) {
  installInboxSchema(db);
  const route=fn=>(req,res,next)=>{try {res.setHeader('Cache-Control','no-store');res.json(fn(req));}catch(error){next(error);}};
  const selected=(req)=>{
    const type=req.params.sourceType,id=validId(req.params.sourceId,'sourceId');
    if (!sourceTypes.has(type)) throw fail('Inbox source not found',404);
    const item=list(db,req,{includeSnoozed:true}).items.find(x=>x.sourceType===type && x.sourceId===id);
    if (!item) throw fail('Inbox source not found',404);
    return item;
  };
  const checkRevision=(req,item)=>{if (req.body?.expectedRevision!==item.sourceRevision) throw fail('Source changed; refresh inbox before acting',409);};
  app.get('/api/inbox',route(req=>list(db,req,{gstinId:req.query.gstinId?validId(req.query.gstinId,'gstinId'):null,
    branchId:req.query.branchId?validId(req.query.branchId,'branchId'):null,includeSnoozed:req.query.includeSnoozed==='1'})));
  app.get('/api/inbox/policies',route(req=>{
    if (req.user.role!=='admin') throw fail('Company admin role required to inspect inbox escalation policy',403);
    assertCompanyWideAccess(db,{companyId:req.company.id,userId:req.user.id});
    return {policies:db.prepare(`SELECT id,source_type AS sourceType,overdue_days AS overdueDays,blocker_allowed AS blockerAllowed,
      reason,approved_by AS approvedBy,approved_at AS approvedAt FROM inbox_escalation_policies
      WHERE company_id=? AND revoked_at IS NULL ORDER BY source_type`).all(req.company.id)
      .map(row=>({...row,blockerAllowed:Boolean(row.blockerAllowed),approvedAt:toIso(row.approvedAt)}))};
  }));
  app.post('/api/inbox/:sourceType/:sourceId/acknowledge',route(req=>{
    const item=selected(req);checkRevision(req,item);
    writeUserState(db,req,item,'acknowledge');
    return {item:selected(req)};
  }));
  app.post('/api/inbox/:sourceType/:sourceId/snooze',route(req=>{
    const item=selected(req);checkRevision(req,item);
    const until=date(req.body?.until,'until'),today=new Date().toISOString().slice(0,10);
    if (until<=today || until>new Date(Date.now()+30*86400000).toISOString().slice(0,10)) throw fail('Snooze date must be within the next 30 days');
    writeUserState(db,req,item,'snooze',until);
    return {item:selected(req)};
  }));
  app.post('/api/inbox/policies',route(req=>{
    if (req.user.role!=='admin') throw fail('Company admin role required to approve inbox escalation policy',403);
    assertCompanyWideAccess(db,{companyId:req.company.id,userId:req.user.id});
    const type=req.body?.sourceType,days=req.body?.overdueDays,allowed=req.body?.blockerAllowed;
    if (!policySourceTypes.has(type) || !Number.isSafeInteger(days) || days<0 || days>365 || typeof allowed!=='boolean') throw fail('Valid sourceType, overdueDays, and blockerAllowed required');
    const why=reason(req.body?.reason);
    db.exec('SAVEPOINT inbox_policy');
    try {
      db.prepare('UPDATE inbox_escalation_policies SET revoked_by=?,revoked_at=CURRENT_TIMESTAMP WHERE company_id=? AND source_type=? AND revoked_at IS NULL').run(req.user.id,req.company.id,type);
      const id=Number(db.prepare('INSERT INTO inbox_escalation_policies(company_id,source_type,overdue_days,blocker_allowed,reason,approved_by) VALUES (?,?,?,?,?,?)')
        .run(req.company.id,type,days,allowed?1:0,why,req.user.id).lastInsertRowid);
      db.exec('RELEASE inbox_policy');
      return {policy:{id,sourceType:type,overdueDays:days,blockerAllowed:allowed,reason:why,approvedBy:req.user.id,
        approvedAt:toIso(db.prepare('SELECT approved_at FROM inbox_escalation_policies WHERE id=?').get(id).approved_at)}};
    }catch(error){db.exec('ROLLBACK TO inbox_policy');db.exec('RELEASE inbox_policy');throw error;}
  }));
  app.post('/api/inbox/:sourceType/:sourceId/escalate',route(req=>{
    const item=selected(req);checkRevision(req,item);
    if (!item.canEscalate) throw fail('No approved escalation policy, trigger, or independent reviewer for this source',403);
    const why=reason(req.body?.reason);
    const policy=db.prepare('SELECT * FROM inbox_escalation_policies WHERE company_id=? AND source_type=? AND revoked_at IS NULL ORDER BY id DESC LIMIT 1').get(req.company.id,item.sourceType);
    const target=targetUser(db,req,{...item,participantIds:sourceParticipants(db,item),canEscalateSource:true});
    if (!policy || !target) throw fail('Escalation policy or independent reviewer changed',409);
    db.prepare('INSERT INTO inbox_escalations(company_id,source_type,source_id,source_revision,policy_id,target_user_id,reason,escalated_by) VALUES (?,?,?,?,?,?,?,?)')
      .run(req.company.id,item.sourceType,item.sourceId,item.sourceRevision,policy.id,target.id,why,req.user.id);
    return {item:selected(req)};
  }));
}

function sourceParticipants(db,item) {
  if (item.sourceType==='crm') {const x=db.prepare('SELECT owner_id FROM order_crm_cases WHERE id=?').get(item.sourceId);return [x?.owner_id];}
  if (item.sourceType==='invoice') {const x=db.prepare('SELECT created_by,submitted_by FROM invoices WHERE id=?').get(item.sourceId);return [x?.created_by,x?.submitted_by];}
  if (item.sourceType==='expense') {const x=db.prepare('SELECT claimant_user_id,created_by,submitted_by FROM expense_claims WHERE id=?').get(item.sourceId);return [x?.claimant_user_id,x?.created_by,x?.submitted_by];}
  const x=db.prepare('SELECT opened_by,closed_by FROM cashier_sessions WHERE id=?').get(item.sourceId);return [x?.opened_by,x?.closed_by];
}

module.exports={registerInboxRoutes,list};
