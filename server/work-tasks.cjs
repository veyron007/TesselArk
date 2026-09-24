const {createHash}=require('node:crypto');
const {TextDecoder}=require('node:util');
const {assertScopeAccess,allowedScopes}=require('./access.cjs');
const {installWorkTasksSchema}=require('./work-tasks-db.cjs');

const fail=(message,status=400)=>Object.assign(new Error(message),{status});
const id=(value,name='id')=>{const n=Number(value);if(!Number.isSafeInteger(n)||n<1||!/^[1-9]\d*$/.test(String(value)))throw fail(`${name} must be a positive integer`);return n;};
const clean=(value,name,max=200)=>{if(typeof value!=='string'||!value.trim()||value.length>max||/[\x00-\x1f\x7f]/.test(value))throw fail(`${name} must be 1 to ${max} printable characters`);return value.trim();};
const date=(value,name)=>{if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value)||Number.isNaN(Date.parse(`${value}T00:00:00Z`))||new Date(`${value}T00:00:00Z`).toISOString().slice(0,10)!==value)throw fail(`${name} must be a real YYYY-MM-DD date`);return value;};
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const camel=row=>Object.fromEntries(Object.entries(row).map(([key,value])=>[key.replace(/_([a-z])/g,(_,x)=>x.toUpperCase()),value]));
const route=fn=>(req,res,next)=>{try{res.setHeader('Cache-Control','no-store');res.json(fn(req));}catch(error){if(error.overlaps)res.status(error.status||409).json({error:error.message,overlaps:error.overlaps});else next(error);}};
const atomic=(db,fn)=>{db.exec('SAVEPOINT work_task_action');try{const result=fn();db.exec('RELEASE work_task_action');return result;}catch(error){db.exec('ROLLBACK TO work_task_action');db.exec('RELEASE work_task_action');throw error;}};
const role=(req,roles)=>{if(!roles.includes(req.user.role))throw fail(`${roles.join(' or ')} role required`,403);};
const iso=value=>value?value.replace(' ','T')+'Z':null;

function scope(db,req,scopeType,gstinId,branchId) {
  if(!['gstin','branch'].includes(scopeType))throw fail('scopeType must be gstin or branch');
  const gid=id(gstinId,'gstinId');
  if(scopeType==='gstin') {
    if(branchId!==null&&branchId!==undefined)throw fail('GSTIN-wide scope requires branchId null');
    assertScopeAccess(db,{companyId:req.company.id,userId:req.user.id,gstinId:gid});
    const branches=db.prepare('SELECT id FROM branches WHERE company_id=? AND gstin_id=?').all(req.company.id,gid);
    const grants=allowedScopes(db,{companyId:req.company.id,userId:req.user.id});
    if(!branches.length||branches.some(row=>!grants.branchIds.includes(row.id)))throw fail('Full GSTIN branch scope is required',403);
    return {scopeType,gstinId:gid,branchId:null};
  }
  const bid=id(branchId,'branchId');
  assertScopeAccess(db,{companyId:req.company.id,userId:req.user.id,gstinId:gid,branchId:bid});
  return {scopeType,gstinId:gid,branchId:bid};
}

function userInScope(db,req,userId,scopeRow,roles) {
  const uid=id(userId,'userId');
  const user=db.prepare('SELECT id,name,role FROM users WHERE id=? AND company_id=?').get(uid,req.company.id);
  if(!user||!roles.includes(user.role))throw fail('Assignee must be a company user with the required role',403);
  scope(db,{company:req.company,user,},scopeRow.scope_type||scopeRow.scopeType,scopeRow.gstin_id||scopeRow.gstinId,scopeRow.branch_id??scopeRow.branchId??null);
  return user;
}

function checklist(value) {
  if(!Array.isArray(value)||!value.length||value.length>30)throw fail('checklist must contain 1 to 30 steps');
  const keys=new Set();
  return value.map(step=>{if(!step||typeof step!=='object')throw fail('Invalid checklist step');const key=clean(step.key,'checklist key',50);if(!/^[a-z][a-z0-9_-]*$/.test(key)||keys.has(key))throw fail('Checklist keys must be unique lowercase identifiers');keys.add(key);return {key,label:clean(step.label,'checklist label',180)};});
}

function dependencies(db,req,value,scopeRow,recurrence,selfId=null) {
  if(value===undefined)value=[];
  if(!Array.isArray(value)||value.length>20)throw fail('dependencyTemplateIds must be an array of at most 20 IDs');
  const ids=value.map(x=>id(x,'dependencyTemplateId'));
  if(new Set(ids).size!==ids.length||ids.includes(selfId))throw fail('Dependency templates must be distinct and cannot include self');
  for(const depId of ids){const dep=db.prepare('SELECT * FROM work_templates WHERE id=? AND company_id=?').get(depId,req.company.id);
    if(!dep||dep.gstin_id!==scopeRow.gstinId||dep.scope_type!==scopeRow.scopeType||dep.branch_id!==scopeRow.branchId)throw fail('Dependency template must have the same exact scope',409);
    const approved=db.prepare("SELECT recurrence FROM work_template_versions WHERE template_id=? AND status='approved' ORDER BY version DESC LIMIT 1").get(depId);
    if(!approved||approved.recurrence!==recurrence)throw fail('Dependency template must have an approved version with the same recurrence',409);
  }
  return ids;
}

function templateInput(db,req,body,base=null) {
  const selected=base?scope(db,req,base.scope_type,base.gstin_id,base.branch_id):scope(db,req,body.scopeType,body.gstinId,body.branchId);
  const title=clean(body.title,'title',180),obligationKey=clean(body.obligationKey,'obligationKey',80);
  if(!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(obligationKey))throw fail('obligationKey must be a stable code');
  const recurrence=body.recurrence;
  if(!['none','monthly','quarterly','annual'].includes(recurrence))throw fail('recurrence must be none, monthly, quarterly, or annual');
  if(selected.scopeType==='gstin'&&!['none','monthly'].includes(recurrence))
    throw fail('Registration-wide GST period work supports one-period or monthly recurrence until multi-month source binding is available',409);
  return {...selected,title,obligationKey,recurrence,checklist:checklist(body.checklist),dependencyTemplateIds:dependencies(db,req,body.dependencyTemplateIds,selected,recurrence,base?.id)};
}

function templateDetail(db,row,version=db.prepare('SELECT * FROM work_template_versions WHERE template_id=? ORDER BY version DESC LIMIT 1').get(row.id)) {
  const approved=db.prepare("SELECT * FROM work_template_versions WHERE template_id=? AND status='approved' ORDER BY version DESC LIMIT 1").get(row.id);
  const approvedVersion=approved?.version||null;
  const approvedSnapshot=approved?{version:approved.version,title:approved.title,obligationKey:approved.obligation_key,recurrence:approved.recurrence,
    checklist:JSON.parse(approved.checklist_json),dependencyTemplateIds:JSON.parse(approved.dependency_template_ids_json)}:null;
  return {id:row.id,companyId:row.company_id,gstinId:row.gstin_id,branchId:row.branch_id,scopeType:row.scope_type,
    title:version.title,obligationKey:version.obligation_key,recurrence:version.recurrence,checklist:JSON.parse(version.checklist_json),
    dependencyTemplateIds:JSON.parse(version.dependency_template_ids_json),version:version.version,status:version.status,
    approvedVersion,approvedSnapshot,createdBy:version.created_by,approvedBy:version.approved_by,approvedAt:iso(version.approved_at),createdAt:iso(version.created_at)};
}

function getTemplate(db,req,templateId) {
  const row=db.prepare('SELECT * FROM work_templates WHERE id=? AND company_id=?').get(id(templateId,'templateId'),req.company.id);
  if(!row)throw fail('Template not found in selected company',404);
  scope(db,req,row.scope_type,row.gstin_id,row.branch_id);
  return row;
}

function latestEvidence(db,taskId) {return db.prepare('SELECT * FROM work_task_evidence WHERE task_id=? ORDER BY version DESC LIMIT 1').get(taskId);}
function evidenceMetadata(row) {if(!row)return null;const {content,...rest}=row;return camel(rest);}
function taskDetail(db,req,row) {
  scope(db,req,row.scope_type,row.gstin_id,row.branch_id);
  if(req.user.role==='staff'&&![row.preparer_user_id,row.reviewer_user_id].includes(req.user.id))throw fail('Task not assigned to selected user',403);
  const period=row.scope_type==='gstin'?db.prepare('SELECT id,status,reviewed_by,approved_by FROM gst_periods WHERE company_id=? AND gstin_id=? AND period=? AND (? IS NULL OR id=?)').get(row.company_id,row.gstin_id,row.period,row.source_period_id,row.source_period_id):null;
  const events=db.prepare('SELECT id,action,details,actor_id,created_at FROM work_task_events WHERE task_id=? ORDER BY id').all(row.id).map(x=>({...camel(x),createdAt:iso(x.created_at)}));
  const depIds=JSON.parse(row.dependency_task_ids_json);
  const dependencies=depIds.map(depId=>db.prepare('SELECT id,title,status,period,version FROM work_tasks WHERE id=? AND company_id=?').get(depId,row.company_id)).filter(Boolean);
  const evidence=db.prepare('SELECT id,task_id,version,file_name,mime_type,byte_size,sha256,status,uploaded_by,uploaded_at,reviewed_by,reviewed_at,review_reason FROM work_task_evidence WHERE task_id=? ORDER BY version DESC').all(row.id).map(evidenceMetadata);
  return {id:row.id,companyId:row.company_id,gstinId:row.gstin_id,branchId:row.branch_id,scopeType:row.scope_type,
    templateId:row.template_id,templateVersion:row.template_version,sourcePeriodId:row.source_period_id,title:row.title,obligationKey:row.obligation_key,
    period:row.period,periodStart:row.period_start,periodEnd:row.period_end,status:row.status,version:row.version,
    preparerUserId:row.preparer_user_id,reviewerUserId:row.reviewer_user_id,internalTargetDate:row.internal_target_date,
    statutoryDueDate:row.statutory_due_date,statutoryBasis:row.statutory_basis_json?JSON.parse(row.statutory_basis_json):null,
    checklist:JSON.parse(row.checklist_json),completedChecklistKeys:JSON.parse(row.completed_checklist_keys_json),
    dependencies,evidence,events,createdBy:row.created_by,createdAt:iso(row.created_at),updatedAt:iso(row.updated_at),
    submittedBy:row.submitted_by,submittedAt:iso(row.submitted_at),closedBy:row.closed_by,closedAt:iso(row.closed_at),
    closureEvidenceId:row.closure_evidence_id,closureEvidenceVersion:row.closure_evidence_version,closureEvidenceSha256:row.closure_evidence_sha256,
    reopenEvidenceVersion:row.reopen_evidence_version,
    source:period?{type:'gst_period',id:period.id,period:row.period,status:period.status,reviewedBy:period.reviewed_by,approvedBy:period.approved_by}:null};
}

function getTask(db,req,taskId) {
  const row=db.prepare('SELECT * FROM work_tasks WHERE id=? AND company_id=?').get(id(taskId,'taskId'),req.company.id);
  if(!row)throw fail('Task not found in selected company',404);
  scope(db,req,row.scope_type,row.gstin_id,row.branch_id);
  if(req.user.role==='staff'&&![row.preparer_user_id,row.reviewer_user_id].includes(req.user.id))throw fail('Task not assigned to selected user',403);
  return row;
}

function event(db,taskId,action,details,actorId) {
  db.prepare('INSERT INTO work_task_events(task_id,action,details,actor_id) VALUES (?,?,?,?)').run(taskId,action,details,actorId);
}
function expectVersion(body,row) {if(!Number.isSafeInteger(body?.expectedVersion)||body.expectedVersion!==row.version)throw fail('Task changed; refresh before acting',409);}
function bump(db,taskId) {db.prepare('UPDATE work_tasks SET version=version+1,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(taskId);}
function assertDependenciesClosed(db,row) {
  for(const depId of JSON.parse(row.dependency_task_ids_json)){
    const dep=db.prepare('SELECT status FROM work_tasks WHERE id=? AND company_id=?').get(depId,row.company_id);
    if(!dep||dep.status!=='closed')throw fail('Dependency task must be closed before submission or closure',409);
  }
}

function periodRange(period,recurrence) {
  if(typeof period!=='string'||!/^\d{4}-(0[1-9]|1[0-2])$/.test(period))throw fail('period must be YYYY-MM');
  const [year,month]=period.split('-').map(Number);
  if(year<1900||year>9998)throw fail('period year must be between 1900 and 9998');
  const span=recurrence==='quarterly'?3:recurrence==='annual'?12:1;
  if(recurrence==='quarterly'&&(month-1)%3!==0)throw fail('Quarterly period must begin in January, April, July, or October');
  if(recurrence==='annual'&&month!==1)throw fail('Annual period must begin in January');
  const end=new Date(Date.UTC(year,month-1+span,0)).toISOString().slice(0,10);
  return {periodStart:`${period}-01`,periodEnd:end};
}

function statutory(body) {
  const due=body.statutoryDueDate===undefined||body.statutoryDueDate===null?null:date(body.statutoryDueDate,'statutoryDueDate');
  if(!due){if(body.statutoryBasis!==undefined&&body.statutoryBasis!==null)throw fail('statutoryBasis requires statutoryDueDate');return {due:null,basis:null};}
  const value=body.statutoryBasis;
  if(!value||typeof value!=='object'||Array.isArray(value))throw fail('Statutory due date requires a complete source basis');
  const basis={sourceTitle:clean(value.sourceTitle,'sourceTitle',180),sourceUrl:clean(value.sourceUrl,'sourceUrl',500),
    effectiveDate:date(value.effectiveDate,'effectiveDate'),verifiedAt:date(value.verifiedAt,'verifiedAt'),appliesTo:clean(value.appliesTo,'appliesTo',300)};
  if(!/^https:\/\/[^\s]+$/.test(basis.sourceUrl))throw fail('sourceUrl must be HTTPS');
  return {due,basis};
}

function fileInput(body) {
  const fileName=clean(body.fileName,'fileName',120),mimeType=clean(body.mimeType,'mimeType',80);
  const extensions={'text/plain':['.txt'],'application/pdf':['.pdf'],'image/png':['.png'],'image/jpeg':['.jpg','.jpeg']};
  if(fileName.includes('/')||fileName.includes('\\')||!extensions[mimeType]?.some(ext=>fileName.toLowerCase().endsWith(ext)))throw fail('File name or MIME type is invalid');
  const base64=body.contentBase64;
  if(typeof base64!=='string'||!base64||base64.length>Math.ceil(128*1024/3)*4||!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(base64))throw fail('contentBase64 must be valid and at most 128 KiB');
  const content=Buffer.from(base64,'base64');
  if(!content.length||content.length>128*1024||content.toString('base64')!==base64)throw fail('File encoding or size is invalid');
  if(mimeType==='text/plain'){if(content.includes(0))throw fail('Text file contains binary bytes');try{new TextDecoder('utf-8',{fatal:true}).decode(content);}catch{throw fail('Text file must be UTF-8');}}
  if(mimeType==='application/pdf'&&content.subarray(0,5).toString()!=='%PDF-')throw fail('PDF signature is invalid');
  if(mimeType==='image/png'&&!content.subarray(0,8).equals(Buffer.from('89504e470d0a1a0a','hex')))throw fail('PNG signature is invalid');
  if(mimeType==='image/jpeg'&&!(content[0]===0xff&&content[1]===0xd8&&content.at(-2)===0xff&&content.at(-1)===0xd9))throw fail('JPEG signature is invalid');
  return {fileName,mimeType,content,sha256:createHash('sha256').update(content).digest('hex')};
}

function registerWorkTaskRoutes(app,db) {
  installWorkTasksSchema(db);
  app.get('/api/work/assignees',route(req=>{
    const scopeType=req.query.scopeType;
    const gstinId=id(req.query.gstinId,'gstinId');
    const branchId=scopeType==='branch'?id(req.query.branchId,'branchId'):null;
    const selected=scope(db,req,scopeType,gstinId,branchId);
    const users=db.prepare('SELECT id,name,role FROM users WHERE company_id=? ORDER BY CASE role WHEN \'staff\' THEN 0 WHEN \'accountant\' THEN 1 ELSE 2 END,name,id').all(req.company.id);
    const granted=users.filter(user=>{try{scope(db,{company:req.company,user},selected.scopeType,selected.gstinId,selected.branchId);return true;}catch{return false;}});
    return {users:granted,preparers:granted,reviewers:granted.filter(user=>['accountant','admin'].includes(user.role))};
  }));
  app.get('/api/work/templates',route(req=>{
    const gstinId=req.query.gstinId===undefined?null:id(req.query.gstinId,'gstinId');
    const branchId=req.query.branchId===undefined?null:id(req.query.branchId,'branchId');
    if(gstinId||branchId)assertScopeAccess(db,{companyId:req.company.id,userId:req.user.id,...(gstinId?{gstinId}:{}),...(branchId?{branchId}:{})});
    const rows=db.prepare('SELECT * FROM work_templates WHERE company_id=? ORDER BY id DESC').all(req.company.id);
    return {templates:rows.filter(row=>(!gstinId||row.gstin_id===gstinId)&&(!branchId||row.branch_id===branchId||row.branch_id===null)).flatMap(row=>{
      try{scope(db,req,row.scope_type,row.gstin_id,row.branch_id);const detail=templateDetail(db,row);
        if(detail.status==='draft'&&req.user.role==='staff'&&detail.createdBy!==req.user.id)return [];
        return [detail];}catch{return [];}
    })};
  }));
  app.post('/api/work/templates',route(req=>{
    role(req,['accountant','admin']);
    const input=templateInput(db,req,req.body||{});
    return atomic(db,()=>{
      const templateId=Number(db.prepare('INSERT INTO work_templates(company_id,gstin_id,branch_id,scope_type,created_by) VALUES (?,?,?,?,?)')
        .run(req.company.id,input.gstinId,input.branchId,input.scopeType,req.user.id).lastInsertRowid);
      db.prepare(`INSERT INTO work_template_versions(template_id,version,title,obligation_key,recurrence,checklist_json,dependency_template_ids_json,status,created_by)
        VALUES (?,1,?,?,?,?,?,'draft',?)`).run(templateId,input.title,input.obligationKey,input.recurrence,JSON.stringify(input.checklist),JSON.stringify(input.dependencyTemplateIds),req.user.id);
      return {template:templateDetail(db,getTemplate(db,req,templateId))};
    });
  }));
  app.get('/api/work/templates/:id',route(req=>({template:templateDetail(db,getTemplate(db,req,req.params.id))})));
  app.post('/api/work/templates/:id/versions',route(req=>{
    role(req,['accountant','admin']);
    const row=getTemplate(db,req,req.params.id),current=templateDetail(db,row);
    if(req.body?.expectedVersion!==current.version)throw fail('Template changed; refresh before revising',409);
    if(current.status!=='approved')throw fail('Only an approved template can be revised',409);
    const input=templateInput(db,req,req.body||{},row);
    if(input.obligationKey!==current.obligationKey)throw fail('obligationKey is immutable across template versions; create a new template for a different obligation',409);
    return atomic(db,()=>{
      db.prepare(`INSERT INTO work_template_versions(template_id,version,title,obligation_key,recurrence,checklist_json,dependency_template_ids_json,status,created_by)
        VALUES (?,?,?,?,?,?,?,'draft',?)`).run(row.id,current.version+1,input.title,input.obligationKey,input.recurrence,JSON.stringify(input.checklist),JSON.stringify(input.dependencyTemplateIds),req.user.id);
      return {template:templateDetail(db,row)};
    });
  }));
  app.post('/api/work/templates/:id/approve',route(req=>{
    role(req,['admin']);
    const row=getTemplate(db,req,req.params.id),current=templateDetail(db,row);
    if(req.body?.expectedVersion!==current.version)throw fail('Template changed; refresh before approving',409);
    if(current.status!=='draft')throw fail('Latest template version is not a draft',409);
    if(current.createdBy===req.user.id)throw fail('Template creator cannot approve own version',403);
    const why=clean(req.body?.reason,'reason',500);
    return atomic(db,()=>{
      db.prepare("UPDATE work_template_versions SET status='approved',approved_by=?,approved_at=CURRENT_TIMESTAMP,approval_reason=? WHERE template_id=? AND version=? AND status='draft'")
        .run(req.user.id,why,row.id,current.version);
      return {template:templateDetail(db,row)};
    });
  }));
  app.get('/api/work/tasks',route(req=>{
    const gstinId=req.query.gstinId===undefined?null:id(req.query.gstinId,'gstinId');
    const branchId=req.query.branchId===undefined?null:id(req.query.branchId,'branchId');
    if(gstinId||branchId)assertScopeAccess(db,{companyId:req.company.id,userId:req.user.id,...(gstinId?{gstinId}:{}),...(branchId?{branchId}:{})});
    const rows=db.prepare('SELECT * FROM work_tasks WHERE company_id=? ORDER BY period_start DESC,id DESC').all(req.company.id);
    return {tasks:rows.filter(row=>(!gstinId||row.gstin_id===gstinId)&&(!branchId||row.branch_id===branchId||row.branch_id===null)).flatMap(row=>{
      try{return [taskDetail(db,req,row)];}catch{return [];}
    })};
  }));
  app.post('/api/work/tasks/generate',route(req=>{
    role(req,['accountant','admin']);
    const body=req.body||{},template=getTemplate(db,req,body.templateId);
    const approvedRow=db.prepare("SELECT * FROM work_template_versions WHERE template_id=? AND status='approved' ORDER BY version DESC LIMIT 1").get(template.id);
    const current=approvedRow?templateDetail(db,template,approvedRow):templateDetail(db,template);
    const existingCandidate=db.prepare('SELECT period_start,period_end FROM work_tasks WHERE template_id=? AND period=?').get(template.id,body.period);
    const range=existingCandidate?{periodStart:existingCandidate.period_start,periodEnd:existingCandidate.period_end}:periodRange(body.period,current.recurrence);
    const preparer=userInScope(db,req,body.preparerUserId,template,['staff','accountant','admin']);
    const reviewer=userInScope(db,req,body.reviewerUserId,template,['accountant','admin']);
    if(preparer.id===reviewer.id)throw fail('Preparer and reviewer must be independent',403);
    const internalTargetDate=date(body.internalTargetDate,'internalTargetDate');
    const {due,basis}=statutory(body);
    const sourcePeriod=template.scope_type==='gstin'?db.prepare('SELECT id FROM gst_periods WHERE company_id=? AND gstin_id=? AND period=?').get(req.company.id,template.gstin_id,body.period):null;
    if(template.scope_type==='gstin'&&!sourcePeriod)
      throw fail('Matching GST period source is required before generating registration-wide work',409);
    return atomic(db,()=>{
      const existing=db.prepare('SELECT * FROM work_tasks WHERE template_id=? AND period=?').get(template.id,body.period);
      const config={templateId:template.id,templateVersion:existing?.template_version||current.version,period:body.period,preparerUserId:preparer.id,reviewerUserId:reviewer.id,internalTargetDate,statutoryDueDate:due,statutoryBasis:basis};
      const generationHash=hash(config);
      if(existing){if(existing.generation_hash!==generationHash)throw fail('Task already generated for this template and period with different inputs',409);
        return {task:taskDetail(db,req,existing),replayed:true,overlaps:[]};}
      if(!approvedRow)throw fail('Approved template version is required',409);
      const overlaps=db.prepare(`SELECT id,title,period,status,scope_type AS scopeType,gstin_id AS gstinId,branch_id AS branchId FROM work_tasks
        WHERE company_id=? AND gstin_id=? AND obligation_key=? AND period_start<=? AND period_end>=?
        AND (branch_id IS NULL OR ? IS NULL OR branch_id=?) ORDER BY id`)
        .all(req.company.id,template.gstin_id,current.obligationKey,range.periodEnd,range.periodStart,template.branch_id,template.branch_id);
      if(overlaps.length){const error=fail('Overlapping obligation already has a period task',409);error.overlaps=overlaps.map(item=>{
        try{scope(db,req,item.scopeType,item.gstinId,item.branchId);return item;}catch{return {id:null,title:'Another scoped obligation',period:item.period,status:null,scopeType:item.scopeType,gstinId:item.gstinId,branchId:null};}
      });throw error;}
      const depIds=[];
      for(const depTemplateId of current.dependencyTemplateIds){
        const approvedDependency=db.prepare("SELECT recurrence FROM work_template_versions WHERE template_id=? AND status='approved' ORDER BY version DESC LIMIT 1").get(depTemplateId);
        if(!approvedDependency||approvedDependency.recurrence!==current.recurrence)throw fail('Dependency template recurrence changed; revise the parent template',409);
        const dependent=db.prepare('SELECT id,period_start,period_end FROM work_tasks WHERE company_id=? AND template_id=? AND period=?').get(req.company.id,depTemplateId,body.period);
        if(!dependent)throw fail(`Dependency template ${depTemplateId} has no task for this period`,409);
        if(dependent.period_start!==range.periodStart||dependent.period_end!==range.periodEnd)throw fail('Dependency task must cover the same period range',409);
        depIds.push(dependent.id);
      }
      const taskId=Number(db.prepare(`INSERT INTO work_tasks(company_id,gstin_id,branch_id,scope_type,template_id,source_period_id,template_version,title,obligation_key,
        period,period_start,period_end,preparer_user_id,reviewer_user_id,internal_target_date,statutory_due_date,statutory_basis_json,
        checklist_json,dependency_task_ids_json,generation_hash,created_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(req.company.id,template.gstin_id,template.branch_id,template.scope_type,template.id,sourcePeriod?.id||null,current.version,current.title,current.obligationKey,
          body.period,range.periodStart,range.periodEnd,preparer.id,reviewer.id,internalTargetDate,due,basis?JSON.stringify(basis):null,
          JSON.stringify(current.checklist),JSON.stringify(depIds),generationHash,req.user.id).lastInsertRowid);
      event(db,taskId,'generated',`Generated from approved template v${current.version} for ${body.period}${sourcePeriod?` and local GST period #${sourcePeriod.id}`:''}`,req.user.id);
      return {task:taskDetail(db,req,getTask(db,req,taskId)),replayed:false,overlaps:[]};
    });
  }));
  app.get('/api/work/tasks/:id',route(req=>({task:taskDetail(db,req,getTask(db,req,req.params.id))})));
  app.post('/api/work/tasks/:id/reassign',route(req=>{
    role(req,['accountant','admin']);
    const row=getTask(db,req,req.params.id),body=req.body||{};expectVersion(body,row);
    if(row.status==='closed')throw fail('Reopen closed work before reassigning',409);
    const preparer=userInScope(db,req,body.preparerUserId,row,['staff','accountant','admin']);
    const reviewer=userInScope(db,req,body.reviewerUserId,row,['accountant','admin']);
    if(preparer.id===reviewer.id)throw fail('Preparer and reviewer must be independent',403);
    const why=clean(body.reason,'reason',500);
    if(preparer.id===row.preparer_user_id&&reviewer.id===row.reviewer_user_id)throw fail('Assignment is unchanged',409);
    return atomic(db,()=>{
      db.prepare(`UPDATE work_tasks SET preparer_user_id=?,reviewer_user_id=?,status='open',submitted_by=NULL,submitted_at=NULL,
        reopen_evidence_version=?,completed_checklist_keys_json='[]',version=version+1,updated_at=CURRENT_TIMESTAMP WHERE id=?`)
        .run(preparer.id,reviewer.id,latestEvidence(db,row.id)?.version||0,row.id);
      event(db,row.id,'reassigned',`Preparer ${row.preparer_user_id} → ${preparer.id}; reviewer ${row.reviewer_user_id} → ${reviewer.id}. New evidence review required. ${why}`,req.user.id);
      return {task:taskDetail(db,req,getTask(db,req,row.id))};
    });
  }));
  app.post('/api/work/tasks/:id/submit',route(req=>{
    const row=getTask(db,req,req.params.id),body=req.body||{};expectVersion(body,row);
    if(req.user.id!==row.preparer_user_id)throw fail('Only assigned preparer can submit',403);
    if(row.status!=='open')throw fail('Only open work can be submitted',409);
    const required=JSON.parse(row.checklist_json).map(x=>x.key),completed=body.completedChecklistKeys;
    if(!Array.isArray(completed)||completed.length!==required.length||new Set(completed).size!==required.length||required.some(x=>!completed.includes(x)))
      throw fail('Every checklist step must be completed before submission',409);
    return atomic(db,()=>{
      assertDependenciesClosed(db,row);
      db.prepare("UPDATE work_tasks SET status='submitted',completed_checklist_keys_json=?,submitted_by=?,submitted_at=CURRENT_TIMESTAMP,version=version+1,updated_at=CURRENT_TIMESTAMP WHERE id=?")
        .run(JSON.stringify(required),req.user.id,row.id);
      event(db,row.id,'submitted','All checklist steps marked complete; internal review pending',req.user.id);
      return {task:taskDetail(db,req,getTask(db,req,row.id))};
    });
  }));
  app.post('/api/work/tasks/:id/evidence',route(req=>{
    const row=getTask(db,req,req.params.id);
    if(row.status==='closed')throw fail('Reopen closed work before adding evidence',409);
    if(req.user.id!==row.preparer_user_id)throw fail('Only assigned preparer can upload task evidence',403);
    const file=fileInput(req.body||{});
    return atomic(db,()=>{
      const version=(latestEvidence(db,row.id)?.version||0)+1;
      const evidenceId=Number(db.prepare(`INSERT INTO work_task_evidence(task_id,version,file_name,mime_type,byte_size,sha256,content,uploaded_by)
        VALUES (?,?,?,?,?,?,?,?)`).run(row.id,version,file.fileName,file.mimeType,file.content.length,file.sha256,file.content,req.user.id).lastInsertRowid);
      bump(db,row.id);event(db,row.id,'evidence_uploaded',`Task evidence v${version} uploaded; independent review pending`,req.user.id);
      return {task:taskDetail(db,req,getTask(db,req,row.id)),evidence:evidenceMetadata(db.prepare('SELECT * FROM work_task_evidence WHERE id=?').get(evidenceId))};
    });
  }));
  app.get('/api/work/tasks/:id/evidence/:evidenceId/download',route(req=>{
    const row=getTask(db,req,req.params.id),evidenceId=id(req.params.evidenceId,'evidenceId');
    const item=db.prepare('SELECT * FROM work_task_evidence WHERE id=? AND task_id=?').get(evidenceId,row.id);
    if(!item)throw fail('Task evidence not found',404);
    return {evidence:evidenceMetadata(item),contentBase64:item.content.toString('base64')};
  }));
  app.post('/api/work/tasks/:id/evidence/:evidenceId/review',route(req=>{
    const row=getTask(db,req,req.params.id),body=req.body||{};
    if(req.user.id!==row.reviewer_user_id||!['accountant','admin'].includes(req.user.role))throw fail('Only assigned independent reviewer can review task evidence',403);
    if(row.status==='closed')throw fail('Closed work evidence cannot be changed',409);
    const evidenceId=id(req.params.evidenceId,'evidenceId');
    const evidence=db.prepare('SELECT * FROM work_task_evidence WHERE id=? AND task_id=?').get(evidenceId,row.id);
    if(!evidence)throw fail('Task evidence not found',404);
    if(evidence.id!==latestEvidence(db,row.id).id||evidence.version!==body.expectedVersion||evidence.sha256!==body.expectedSha256)
      throw fail('Evidence changed; reload current version',409);
    if(evidence.status!=='pending')throw fail('Evidence already reviewed',409);
    if(evidence.uploaded_by===req.user.id||req.user.id===row.preparer_user_id)throw fail('Evidence review must be independent of preparer and uploader',403);
    if(!['approved','rejected'].includes(body.decision))throw fail('decision must be approved or rejected');
    const why=body.decision==='rejected'?clean(body.reason,'reason',500):(body.reason?clean(body.reason,'reason',500):'');
    return atomic(db,()=>{
      db.prepare('UPDATE work_task_evidence SET status=?,reviewed_by=?,reviewed_at=CURRENT_TIMESTAMP,review_reason=? WHERE id=? AND status=?')
        .run(body.decision,req.user.id,why,evidence.id,'pending');
      bump(db,row.id);event(db,row.id,`evidence_${body.decision}`,`Task evidence v${evidence.version} ${body.decision}${why?`: ${why}`:''}`,req.user.id);
      return {task:taskDetail(db,req,getTask(db,req,row.id)),evidence:evidenceMetadata(db.prepare('SELECT * FROM work_task_evidence WHERE id=?').get(evidence.id))};
    });
  }));
  app.post('/api/work/tasks/:id/close',route(req=>{
    const row=getTask(db,req,req.params.id),body=req.body||{};expectVersion(body,row);
    if(req.user.id!==row.reviewer_user_id||!['accountant','admin'].includes(req.user.role))throw fail('Only assigned independent reviewer can close task',403);
    if(req.user.id===row.preparer_user_id||req.user.id===row.submitted_by)throw fail('Task closure must be independent of preparation',403);
    if(row.status!=='submitted')throw fail('Only submitted work can close',409);
    const evidence=latestEvidence(db,row.id);
    if(!evidence||evidence.id!==body.evidenceId||evidence.version!==body.expectedEvidenceVersion||evidence.version<=row.reopen_evidence_version||evidence.sha256!==body.expectedEvidenceSha256||evidence.status!=='approved'||evidence.uploaded_by===req.user.id||evidence.reviewed_by!==req.user.id)
      throw fail('Exact latest independently approved task evidence is required',409);
    const why=clean(body.reason,'reason',500);
    return atomic(db,()=>{
      assertDependenciesClosed(db,row);
      db.prepare(`UPDATE work_tasks SET status='closed',closed_by=?,closed_at=CURRENT_TIMESTAMP,closure_evidence_id=?,closure_evidence_version=?,
        closure_evidence_sha256=?,version=version+1,updated_at=CURRENT_TIMESTAMP WHERE id=?`)
        .run(req.user.id,evidence.id,evidence.version,evidence.sha256,row.id);
      event(db,row.id,'closed',`Internal work closed against approved evidence v${evidence.version}/${evidence.sha256}: ${why}. No statutory filing recorded.`,req.user.id);
      return {task:taskDetail(db,req,getTask(db,req,row.id))};
    });
  }));
  app.post('/api/work/tasks/:id/reopen',route(req=>{
    role(req,['admin']);
    const row=getTask(db,req,req.params.id),body=req.body||{};expectVersion(body,row);
    if(row.status!=='closed')throw fail('Only closed work can be reopened',409);
    const why=clean(body.reason,'reason',500);
    return atomic(db,()=>{
      db.prepare(`UPDATE work_tasks SET status='open',submitted_by=NULL,submitted_at=NULL,closed_by=NULL,closed_at=NULL,
        closure_evidence_id=NULL,closure_evidence_version=NULL,closure_evidence_sha256=NULL,
        reopen_evidence_version=?,completed_checklist_keys_json='[]',version=version+1,updated_at=CURRENT_TIMESTAMP WHERE id=?`)
        .run(latestEvidence(db,row.id)?.version||0,row.id);
      event(db,row.id,'reopened',why,req.user.id);
      return {task:taskDetail(db,req,getTask(db,req,row.id))};
    });
  }));
}

module.exports={registerWorkTaskRoutes,installWorkTasksSchema};
