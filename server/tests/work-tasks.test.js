import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require=createRequire(import.meta.url);
const {openDatabase}=require('../db.cjs');
const {createApp}=require('../api.cjs');

function setup(t) {
  const db=openDatabase(':memory:');
  const server=createApp({db}).listen(0);
  t.after(()=>{server.close();db.close();});
  const base=`http://127.0.0.1:${server.address().port}`;
  const api=async(method,path,body,userId=3,companyId=1)=>{
    const response=await fetch(base+path,{method,headers:{'content-type':'application/json','x-company-id':String(companyId),'x-user-id':String(userId)},body:body===undefined?undefined:JSON.stringify(body)});
    return {status:response.status,data:await response.json()};
  };
  return {db,api};
}

test('approved period task generates exactly once, detects overlapping engagement and keeps GST state local',async t=>{
  const {api}=setup(t);
  const body={scopeType:'gstin',gstinId:1,branchId:null,title:'Synthetic GSTR-3B preparation',obligationKey:'GST-3B',recurrence:'monthly',checklist:[{key:'reconcile',label:'Reconcile local period totals'}],dependencyTemplateIds:[]};
  const created=await api('POST','/api/work/templates',body,2); assert.equal(created.status,200);
  const template=created.data.template;
  assert.equal(template.status,'draft');
  assert.equal((await api('POST','/api/work/tasks/generate',{templateId:template.id,period:'2026-08',preparerUserId:1,reviewerUserId:2,internalTargetDate:'2026-09-10'})).status,409);
  const approved=await api('POST',`/api/work/templates/${template.id}/approve`,{expectedVersion:1,reason:'Synthetic internal checklist'},3); assert.equal(approved.status,200);
  const request={templateId:template.id,period:'2026-08',preparerUserId:1,reviewerUserId:2,internalTargetDate:'2026-09-10'};
  const generated=await api('POST','/api/work/tasks/generate',request); assert.equal(generated.status,200);
  assert.equal(generated.data.replayed,false); assert.equal(generated.data.task.scopeType,'gstin'); assert.equal(generated.data.task.branchId,null);
  assert.equal(generated.data.task.statutoryDueDate,null);
  assert.equal(generated.data.task.source.type,'gst_period');
  assert.equal((await api('POST','/api/work/tasks/generate',request)).data.replayed,true);
  assert.equal((await api('POST','/api/work/tasks/generate',{...request,reviewerUserId:3})).status,409);
  const second=(await api('POST','/api/work/templates',{...body,title:'Second engagement'},2)).data.template;
  await api('POST',`/api/work/templates/${second.id}/approve`,{expectedVersion:1,reason:'Approved'},3);
  const overlap=await api('POST','/api/work/tasks/generate',{...request,templateId:second.id});
  assert.equal(overlap.status,409); assert.equal(overlap.data.overlaps[0].id,generated.data.task.id);
});

test('submission and closure require completed checklist, fresh independently approved evidence, and live grants',async t=>{
  const {api,db}=setup(t);
  const template=(await api('POST','/api/work/templates',{scopeType:'branch',gstinId:1,branchId:1,title:'Synthetic branch review',obligationKey:'BRANCH-REVIEW',recurrence:'monthly',checklist:[{key:'check',label:'Check source'}]},2)).data.template;
  await api('POST',`/api/work/templates/${template.id}/approve`,{expectedVersion:1,reason:'Approved'},3);
  const task=(await api('POST','/api/work/tasks/generate',{templateId:template.id,period:'2026-08',preparerUserId:1,reviewerUserId:2,internalTargetDate:'2026-09-10'})).data.task;
  assert.equal((await api('POST',`/api/work/tasks/${task.id}/submit`,{expectedVersion:1,completedChecklistKeys:[]},1)).status,409);
  const submitted=await api('POST',`/api/work/tasks/${task.id}/submit`,{expectedVersion:1,completedChecklistKeys:['check']},1); assert.equal(submitted.status,200);
  assert.equal((await api('POST',`/api/work/tasks/${task.id}/close`,{expectedVersion:2,evidenceId:1,expectedEvidenceVersion:1,expectedEvidenceSha256:'a'.repeat(64),reason:'Done'},2)).status,409);
  const uploaded=await api('POST',`/api/work/tasks/${task.id}/evidence`,{fileName:'proof.txt',mimeType:'text/plain',contentBase64:Buffer.from('SYNTHETIC PROOF').toString('base64')},1); assert.equal(uploaded.status,200);
  const evidence=uploaded.data.evidence;
  assert.equal((await api('POST',`/api/work/tasks/${task.id}/evidence/${evidence.id}/review`,{expectedVersion:1,expectedSha256:evidence.sha256,decision:'approved',reason:'Checked'},1)).status,403);
  assert.equal((await api('POST',`/api/work/tasks/${task.id}/evidence/${evidence.id}/review`,{expectedVersion:1,expectedSha256:evidence.sha256,decision:'approved',reason:'Checked'},2)).status,200);
  const refreshed=(await api('GET',`/api/work/tasks/${task.id}`,undefined,2)).data.task;
  const closed=await api('POST',`/api/work/tasks/${task.id}/close`,{expectedVersion:refreshed.version,evidenceId:evidence.id,expectedEvidenceVersion:1,expectedEvidenceSha256:evidence.sha256,reason:'Internal work complete'},2);
  assert.equal(closed.status,200); assert.equal(closed.data.task.status,'closed');
  assert.equal((await api('POST',`/api/work/tasks/${task.id}/reopen`,{expectedVersion:closed.data.task.version,reason:'Correct source'},3)).status,200);
  db.prepare('UPDATE user_branch_grants SET revoked_at=CURRENT_TIMESTAMP,revoked_by=3,revoked_reason=? WHERE company_id=1 AND user_id=1 AND branch_id=1 AND revoked_at IS NULL').run('Test');
  assert.equal((await api('POST',`/api/work/tasks/${task.id}/submit`,{expectedVersion:closed.data.task.version+1,completedChecklistKeys:['check']},1)).status,403);
});

test('statutory dates require a complete source basis and template versions stay pinned',async t=>{
  const {api}=setup(t);
  const template=(await api('POST','/api/work/templates',{scopeType:'branch',gstinId:1,branchId:1,title:'Synthetic compliance check',obligationKey:'SYN-CHECK',recurrence:'monthly',checklist:[{key:'verify',label:'Verify'}]},2)).data.template;
  await api('POST',`/api/work/templates/${template.id}/approve`,{expectedVersion:1,reason:'Approved'},3);
  const request={templateId:template.id,period:'2026-08',preparerUserId:1,reviewerUserId:2,internalTargetDate:'2026-09-10',statutoryDueDate:'2026-09-20'};
  assert.equal((await api('POST','/api/work/tasks/generate',request)).status,400);
  const version=await api('POST',`/api/work/templates/${template.id}/versions`,{expectedVersion:1,title:'Synthetic compliance check v2',obligationKey:'SYN-CHECK',recurrence:'monthly',checklist:[{key:'verify',label:'Verify'}]},2);
  assert.equal(version.status,200); assert.equal(version.data.template.version,2); assert.equal(version.data.template.status,'draft');
  const pendingVersion=await api('POST','/api/work/tasks/generate',{...request,statutoryDueDate:null});
  assert.equal(pendingVersion.status,200); assert.equal(pendingVersion.data.task.templateVersion,1);
});

test('a generated task replays exactly after the template enters a new draft version',async t=>{
  const {api}=setup(t);
  const template=(await api('POST','/api/work/templates',{scopeType:'branch',gstinId:1,branchId:1,title:'Monthly branch check',obligationKey:'BR-REPLAY',recurrence:'monthly',checklist:[{key:'one',label:'One'}]},2)).data.template;
  await api('POST',`/api/work/templates/${template.id}/approve`,{expectedVersion:1,reason:'Approved'},3);
  const request={templateId:template.id,period:'2026-08',preparerUserId:1,reviewerUserId:2,internalTargetDate:'2026-09-10'};
  const original=(await api('POST','/api/work/tasks/generate',request)).data.task;
  await api('POST',`/api/work/templates/${template.id}/versions`,{expectedVersion:1,title:'Monthly branch check revised',obligationKey:'BR-REPLAY',recurrence:'annual',checklist:[{key:'one',label:'One'}]},2);
  const replay=await api('POST','/api/work/tasks/generate',request);
  assert.equal(replay.status,200); assert.equal(replay.data.replayed,true); assert.equal(replay.data.task.id,original.id); assert.equal(replay.data.task.templateVersion,1);
  const next=await api('POST','/api/work/tasks/generate',{...request,period:'2026-09'});
  assert.equal(next.status,200); assert.equal(next.data.task.templateVersion,1);
});

test('registration-wide tasks require every branch grant and never cross companies',async t=>{
  const {api,db}=setup(t);
  const period=db.prepare('SELECT period FROM gst_periods WHERE company_id=1 AND gstin_id=1 ORDER BY period DESC LIMIT 1').get().period;
  const template=(await api('POST','/api/work/templates',{scopeType:'gstin',gstinId:1,branchId:null,title:'Whole registration',obligationKey:'GST-SCOPE',recurrence:'monthly',checklist:[{key:'one',label:'One'}]},2)).data.template;
  await api('POST',`/api/work/templates/${template.id}/approve`,{expectedVersion:1,reason:'Approved'},3);
  const request={templateId:template.id,period,preparerUserId:1,reviewerUserId:2,internalTargetDate:'2026-09-30'};
  const task=(await api('POST','/api/work/tasks/generate',request)).data.task;
  assert.equal((await api('GET',`/api/work/tasks/${task.id}`,undefined,4,2)).status,404);
  db.prepare("UPDATE user_branch_grants SET revoked_at=CURRENT_TIMESTAMP,revoked_by=3,revoked_reason='scope test' WHERE company_id=1 AND user_id=1 AND branch_id=2 AND revoked_at IS NULL").run();
  assert.equal((await api('GET',`/api/work/tasks/${task.id}`,undefined,1)).status,403);
  assert.equal((await api('GET','/api/work/tasks?gstinId=1',undefined,1)).data.tasks.some(item=>item.id===task.id),false);
  assert.equal((await api('POST','/api/work/tasks/generate',{...request,period:'2026-10'},3)).status,403);
});

test('reopened work needs a newly reviewed evidence version, and stale review cannot close',async t=>{
  const {api}=setup(t);
  const template=(await api('POST','/api/work/templates',{scopeType:'branch',gstinId:1,branchId:1,title:'Evidence renewal',obligationKey:'BR-EVIDENCE',recurrence:'monthly',checklist:[{key:'one',label:'One'}]},2)).data.template;
  await api('POST',`/api/work/templates/${template.id}/approve`,{expectedVersion:1,reason:'Approved'},3);
  let task=(await api('POST','/api/work/tasks/generate',{templateId:template.id,period:'2026-08',preparerUserId:1,reviewerUserId:2,internalTargetDate:'2026-09-10'})).data.task;
  task=(await api('POST',`/api/work/tasks/${task.id}/submit`,{expectedVersion:task.version,completedChecklistKeys:['one']},1)).data.task;
  const upload=async content=>api('POST',`/api/work/tasks/${task.id}/evidence`,{fileName:'proof.txt',mimeType:'text/plain',contentBase64:Buffer.from(content).toString('base64')},1);
  const first=(await upload('SYNTHETIC FIRST')).data.evidence;
  const review=async evidence=>api('POST',`/api/work/tasks/${task.id}/evidence/${evidence.id}/review`,{expectedVersion:evidence.version,expectedSha256:evidence.sha256,decision:'approved'},2);
  await review(first);
  const second=(await upload('SYNTHETIC SECOND')).data.evidence;
  task=(await api('GET',`/api/work/tasks/${task.id}`,undefined,2)).data.task;
  assert.equal((await api('POST',`/api/work/tasks/${task.id}/close`,{expectedVersion:task.version,evidenceId:first.id,expectedEvidenceVersion:1,expectedEvidenceSha256:first.sha256,reason:'Old proof'},2)).status,409);
  await review(second);
  task=(await api('GET',`/api/work/tasks/${task.id}`,undefined,2)).data.task;
  task=(await api('POST',`/api/work/tasks/${task.id}/close`,{expectedVersion:task.version,evidenceId:second.id,expectedEvidenceVersion:2,expectedEvidenceSha256:second.sha256,reason:'Reviewed'},2)).data.task;
  task=(await api('POST',`/api/work/tasks/${task.id}/reopen`,{expectedVersion:task.version,reason:'Recheck'},3)).data.task;
  task=(await api('POST',`/api/work/tasks/${task.id}/submit`,{expectedVersion:task.version,completedChecklistKeys:['one']},1)).data.task;
  assert.equal((await api('POST',`/api/work/tasks/${task.id}/close`,{expectedVersion:task.version,evidenceId:second.id,expectedEvidenceVersion:2,expectedEvidenceSha256:second.sha256,reason:'Old proof'},2)).status,409);
  const third=(await upload('SYNTHETIC THIRD')).data.evidence;
  await review(third);
  task=(await api('GET',`/api/work/tasks/${task.id}`,undefined,2)).data.task;
  assert.equal((await api('POST',`/api/work/tasks/${task.id}/close`,{expectedVersion:task.version,evidenceId:third.id,expectedEvidenceVersion:3,expectedEvidenceSha256:third.sha256,reason:'New proof'},2)).status,200);
});

test('recurrence spans detect overlap and dependency tasks must close before submission',async t=>{
  const {api,db}=setup(t);
  const make=async(body)=>{
    const template=(await api('POST','/api/work/templates',{scopeType:'branch',gstinId:1,branchId:1,checklist:[{key:'one',label:'One'}],...body},2)).data.template;
    assert.equal((await api('POST',`/api/work/templates/${template.id}/approve`,{expectedVersion:1,reason:'Approved'},3)).status,200);
    return template;
  };
  const quarter=await make({title:'Quarterly obligation',obligationKey:'SAME-OBLIGATION',recurrence:'quarterly'});
  const month=await make({title:'Monthly overlapping obligation',obligationKey:'SAME-OBLIGATION',recurrence:'monthly'});
  const generate=async(templateId,period)=>api('POST','/api/work/tasks/generate',{templateId,period,preparerUserId:1,reviewerUserId:2,internalTargetDate:'2026-04-20'});
  assert.equal((await generate(quarter.id,'2026-02')).status,400);
  assert.equal((await generate(quarter.id,'2026-01')).status,200);
  const overlap=await generate(month.id,'2026-02');assert.equal(overlap.status,409);assert.equal(overlap.data.overlaps.length,1);
  const prerequisite=await make({title:'Source prerequisite',obligationKey:'SOURCE-PREREQ',recurrence:'monthly'});
  const dependent=await make({title:'Dependent review',obligationKey:'DEPENDENT-REVIEW',recurrence:'monthly',dependencyTemplateIds:[prerequisite.id]});
  assert.equal((await generate(dependent.id,'2026-08')).status,409);
  const first=(await generate(prerequisite.id,'2026-08')).data.task;
  const second=(await generate(dependent.id,'2026-08')).data.task;
  assert.deepEqual(second.dependencies.map(item=>item.id),[first.id]);
  assert.equal((await api('POST',`/api/work/tasks/${second.id}/submit`,{expectedVersion:second.version,completedChecklistKeys:['one']},1)).status,409);
  db.prepare("UPDATE work_tasks SET status='closed' WHERE id=?").run(first.id);
  assert.equal((await api('POST',`/api/work/tasks/${second.id}/submit`,{expectedVersion:second.version,completedChecklistKeys:['one']},1)).status,200);
});

test('reassignment is audited, versioned, and checks new owners live scope',async t=>{
  const {api,db}=setup(t);
  const template=(await api('POST','/api/work/templates',{scopeType:'branch',gstinId:1,branchId:1,title:'Reassignment check',obligationKey:'REASSIGN-CHECK',recurrence:'monthly',checklist:[{key:'one',label:'One'}]},2)).data.template;
  await api('POST',`/api/work/templates/${template.id}/approve`,{expectedVersion:1,reason:'Approved'},3);
  const task=(await api('POST','/api/work/tasks/generate',{templateId:template.id,period:'2026-08',preparerUserId:1,reviewerUserId:2,internalTargetDate:'2026-09-10'})).data.task;
  const body={expectedVersion:task.version,preparerUserId:2,reviewerUserId:3,reason:'Independent owner transfer'};
  db.prepare("UPDATE user_branch_grants SET revoked_at=CURRENT_TIMESTAMP,revoked_by=3,revoked_reason='test' WHERE company_id=1 AND user_id=2 AND branch_id=1 AND revoked_at IS NULL").run();
  assert.equal((await api('POST',`/api/work/tasks/${task.id}/reassign`,body,3)).status,403);
  db.prepare("UPDATE user_branch_grants SET revoked_at=NULL,revoked_by=NULL,revoked_reason=NULL WHERE company_id=1 AND user_id=2 AND branch_id=1").run();
  const assigned=await api('POST',`/api/work/tasks/${task.id}/reassign`,body,3);
  assert.equal(assigned.status,200);assert.equal(assigned.data.task.version,task.version+1);assert.equal(assigned.data.task.preparerUserId,2);
  assert.equal(assigned.data.task.events.at(-1).action,'reassigned');
  assert.equal((await api('POST',`/api/work/tasks/${task.id}/submit`,{expectedVersion:assigned.data.task.version,completedChecklistKeys:['one']},1)).status,403);
  assert.equal((await api('POST',`/api/work/tasks/${task.id}/submit`,{expectedVersion:assigned.data.task.version,completedChecklistKeys:['one']},2)).status,200);
});

test('GSTIN source range and obligation identity stay honest across template revisions',async t=>{
  const {api}=setup(t);
  const base={scopeType:'gstin',gstinId:1,branchId:null,title:'Monthly local GST period work',obligationKey:'GST-IDENTITY',recurrence:'monthly',checklist:[{key:'one',label:'One'}]};
  assert.equal((await api('POST','/api/work/templates',{...base,recurrence:'annual'},2)).status,409);
  const template=(await api('POST','/api/work/templates',base,2)).data.template;
  await api('POST',`/api/work/templates/${template.id}/approve`,{expectedVersion:1,reason:'Approved'},3);
  assert.equal((await api('POST',`/api/work/templates/${template.id}/versions`,{expectedVersion:1,title:'Rename',obligationKey:'DIFFERENT-KEY',recurrence:'monthly',checklist:base.checklist},2)).status,409);
  const listing=await api('GET','/api/work/templates?gstinId=1',undefined,2);
  const actual=listing.data.templates.find(item=>item.id===template.id);
  assert.equal(actual.approvedSnapshot.obligationKey,'GST-IDENTITY');
});

test('dependency recurrence must match and closure rechecks a reopened prerequisite',async t=>{
  const {api}=setup(t);
  const create=async(title,key,recurrence,dependencyTemplateIds=[])=>{
    const result=await api('POST','/api/work/templates',{scopeType:'branch',gstinId:1,branchId:1,title,obligationKey:key,recurrence,checklist:[{key:'one',label:'One'}],dependencyTemplateIds},2);
    if(result.status!==200)return result;
    const template=result.data.template;
    assert.equal((await api('POST',`/api/work/templates/${template.id}/approve`,{expectedVersion:1,reason:'Approved'},3)).status,200);
    return {status:200,template};
  };
  const prerequisite=(await create('Monthly source','MONTH-SOURCE','monthly')).template;
  assert.equal((await create('Quarterly mismatch','QUARTER-MISMATCH','quarterly',[prerequisite.id])).status,409);
  const quarterly=(await create('Quarterly source','QUARTER-SOURCE','quarterly')).template;
  assert.equal((await create('Monthly mismatch','MONTH-MISMATCH','monthly',[quarterly.id])).status,409);
  const dependent=(await create('Monthly dependent','MONTH-DEPENDENT','monthly',[prerequisite.id])).template;
  const generate=async(templateId)=>api('POST','/api/work/tasks/generate',{templateId,period:'2026-08',preparerUserId:1,reviewerUserId:2,internalTargetDate:'2026-09-10'});
  const source=(await generate(prerequisite.id)).data.task;
  const target=(await generate(dependent.id)).data.task;
  const prepare=async(taskId,version)=>{
    const submitted=(await api('POST',`/api/work/tasks/${taskId}/submit`,{expectedVersion:version,completedChecklistKeys:['one']},1)).data.task;
    const uploaded=(await api('POST',`/api/work/tasks/${taskId}/evidence`,{fileName:'proof.txt',mimeType:'text/plain',contentBase64:Buffer.from('SYNTHETIC PROOF').toString('base64')},1)).data.evidence;
    await api('POST',`/api/work/tasks/${taskId}/evidence/${uploaded.id}/review`,{expectedVersion:uploaded.version,expectedSha256:uploaded.sha256,decision:'approved'},2);
    const current=(await api('GET',`/api/work/tasks/${taskId}`,undefined,2)).data.task;
    return {task:current,evidence:uploaded,submitted};
  };
  const sourceReady=await prepare(source.id,source.version);
  const close=async({task,evidence})=>api('POST',`/api/work/tasks/${task.id}/close`,{expectedVersion:task.version,evidenceId:evidence.id,expectedEvidenceVersion:evidence.version,expectedEvidenceSha256:evidence.sha256,reason:'Internal check complete'},2);
  const closedSource=(await close(sourceReady)).data.task;
  const targetReady=await prepare(target.id,target.version);
  assert.equal((await api('POST',`/api/work/tasks/${source.id}/reopen`,{expectedVersion:closedSource.version,reason:'New source issue'},3)).status,200);
  const blocked=await close(targetReady);
  assert.equal(blocked.status,409);assert.match(blocked.data.error,/Dependency task must be closed/);
  assert.equal((await api('GET',`/api/work/tasks/${target.id}`,undefined,2)).data.task.status,'submitted');
});

test('assignee lookup returns only live-granted own-company users for the requested scope',async t=>{
  const {api,db}=setup(t);
  const branch=await api('GET','/api/work/assignees?scopeType=branch&gstinId=1&branchId=1',undefined,2);
  assert.equal(branch.status,200);assert.ok(branch.data.users.some(user=>user.id===1));
  assert.deepEqual(branch.data.preparers,branch.data.users);
  assert.ok(branch.data.reviewers.every(user=>['accountant','admin'].includes(user.role)));
  assert.ok(branch.data.users.every(user=>['id','name','role'].every(key=>Object.hasOwn(user,key))&&Object.keys(user).length===3));
  assert.equal(branch.data.users.some(user=>user.id===4),false);
  db.prepare("UPDATE user_branch_grants SET revoked_at=CURRENT_TIMESTAMP,revoked_by=3,revoked_reason='test' WHERE company_id=1 AND user_id=1 AND branch_id=2 AND revoked_at IS NULL").run();
  const gstin=await api('GET','/api/work/assignees?scopeType=gstin&gstinId=1',undefined,2);
  assert.equal(gstin.status,200);assert.equal(gstin.data.users.some(user=>user.id===1),false);
  const stillBranch=await api('GET','/api/work/assignees?scopeType=branch&gstinId=1&branchId=1',undefined,2);
  assert.equal(stillBranch.data.users.some(user=>user.id===1),true);
  assert.equal((await api('GET','/api/work/assignees?scopeType=branch&gstinId=1&branchId=3',undefined,2)).status,400);
});
