import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require=createRequire(import.meta.url);
const { openDatabase }=require('../db.cjs');
const { createApp }=require('../api.cjs');
const { sourceFingerprint }=require('../expenses.cjs');
const { installInboxSchema }=require('../inbox-db.cjs');
const { installWorkTasksSchema }=require('../work-tasks-db.cjs');

async function fixture(t) {
  const db=openDatabase(':memory:');
  const server=createApp({db}).listen(0);
  t.after(()=>{server.close();db.close();});
  const base=`http://127.0.0.1:${server.address().port}`;
  const api=async(method,path,body,userId=1,companyId=1)=>{
    const response=await fetch(base+path,{method,headers:{'content-type':'application/json','x-company-id':String(companyId),'x-user-id':String(userId)},body:body===undefined?undefined:JSON.stringify(body)});
    return {status:response.status,data:await response.json()};
  };
  return {db,api};
}

function caseWithEvents(db,count=10) {
  const id=Number(db.prepare(`INSERT INTO order_crm_cases(company_id,gstin_id,branch_id,party_id,order_id,client_reference,subject,customer_request,owner_id,next_action,due_date,created_by,payload_json)
    VALUES (1,2,3,1,1,'INBOX-CRM-1','Remaining delivery','Customer called',1,'Call customer','2020-01-01',1,'{}')`).run().lastInsertRowid);
  for (let n=0;n<count;n++) db.prepare(`INSERT INTO order_crm_events(case_id,client_reference,kind,detail,actor_id,payload_json)
    VALUES (?,?,'follow_up',?,1,'{}')`).run(id,`INBOX-EVENT-${n}`,`Change ${n+1}`);
  return id;
}

function workTaskWithEvents(db,{scopeType='branch',branchId=1,gstinId=1,period='2026-09',count=10}={}) {
  installWorkTasksSchema(db);
  const templateId=Number(db.prepare('INSERT INTO work_templates(company_id,gstin_id,branch_id,scope_type,created_by) VALUES (1,?,?,?,3)')
    .run(gstinId,branchId,scopeType).lastInsertRowid);
  db.prepare(`INSERT INTO work_template_versions(template_id,version,title,obligation_key,recurrence,checklist_json,dependency_template_ids_json,status,created_by,approved_by,approved_at)
    VALUES (?,1,'Local month close','MONTH-CLOSE','monthly','[{"key":"prepare","label":"Prepare work"}]','[]','approved',3,2,CURRENT_TIMESTAMP)`).run(templateId);
  const id=Number(db.prepare(`INSERT INTO work_tasks(company_id,gstin_id,branch_id,scope_type,template_id,template_version,title,obligation_key,period,period_start,period_end,
    preparer_user_id,reviewer_user_id,internal_target_date,checklist_json,generation_hash,created_by)
    VALUES (1,?,?,?, ?,1,'Local month close','MONTH-CLOSE',?,'2026-09-01','2026-09-30',1,2,'2026-10-05','[{"key":"prepare","label":"Prepare work"}]','test-source',3)`)
    .run(gstinId,branchId,scopeType,templateId,period).lastInsertRowid);
  for(let n=0;n<count;n++) db.prepare('INSERT INTO work_task_events(task_id,action,details,actor_id) VALUES (?,\'checklist\',?,1)')
    .run(id,`Task change ${n+1}`);
  return id;
}

test('ten source changes remain one scoped CRM thread; new revision reopens acknowledgement and snooze',async t=>{
  const {db,api}=await fixture(t),id=caseWithEvents(db);
  const first=await api('GET','/api/inbox?gstinId=2&branchId=3');
  assert.equal(first.status,200);
  const thread=first.data.items.find(x=>x.id===`crm:${id}`);
  assert.ok(thread);
  assert.equal(thread.events.length,10);
  assert.deepEqual(thread.events.map(x=>x.detail),Array.from({length:10},(_,i)=>`Change ${i+1}`));
  assert.equal(first.data.items.filter(x=>x.id===`crm:${id}`).length,1);
  assert.equal(thread.owner.id,1);
  assert.equal(thread.dueDate,'2020-01-01');
  assert.match(thread.deepLink,/^\/order-crm\?gstin=2&branch=3$/);
  assert.equal((await api('GET','/api/inbox?branchId=3&gstinId=1')).status,400);
  assert.equal((await api('GET','/api/inbox?branchId=abc')).status,400);
  assert.equal((await api('POST',`/api/inbox/crm/${id}/acknowledge`,{expectedRevision:'old'})).status,409);
  const ack=await api('POST',`/api/inbox/crm/${id}/acknowledge`,{expectedRevision:thread.sourceRevision});
  assert.equal(ack.status,200);assert.equal(ack.data.item.acknowledged,true);
  const tomorrow=new Date(Date.now()+86400000).toISOString().slice(0,10);
  assert.equal((await api('POST',`/api/inbox/crm/${id}/snooze`,{expectedRevision:thread.sourceRevision,until:'2026-99-99'})).status,400);
  const snoozed=await api('POST',`/api/inbox/crm/${id}/snooze`,{expectedRevision:thread.sourceRevision,until:tomorrow});
  assert.equal(snoozed.status,200);assert.equal(snoozed.data.item.snoozedUntil,tomorrow);
  assert.equal((await api('GET','/api/inbox?branchId=3')).data.items.some(x=>x.id===`crm:${id}`),false);
  db.prepare("INSERT INTO order_crm_events(case_id,client_reference,kind,detail,actor_id,payload_json) VALUES (?,'INBOX-EVENT-NEW','commitment','New customer promise',1,'{}')").run(id);
  const changed=(await api('GET','/api/inbox?branchId=3')).data.items.find(x=>x.id===`crm:${id}`);
  assert.equal(changed.events.length,11);
  assert.notEqual(changed.sourceRevision,thread.sourceRevision);
  assert.equal(changed.acknowledged,false);
  assert.equal(changed.snoozedUntil,null);
  assert.equal((await api('POST',`/api/inbox/crm/${id}/acknowledge`,{expectedRevision:thread.sourceRevision})).status,409);
  assert.equal(db.prepare('SELECT status FROM order_crm_cases WHERE id=?').get(id).status,'open');
});

test('ordinary submitted invoice appears for independent review; scope and reviewer segregation hold',async t=>{
  const {db,api}=await fixture(t);
  db.prepare("UPDATE invoices SET status='submitted',submitted_by=1 WHERE id=9").run();
  const reviewer=(await api('GET','/api/inbox',undefined,2)).data.items.find(x=>x.id==='invoice:9');
  assert.ok(reviewer);
  assert.equal(reviewer.blocker,null);
  assert.match(reviewer.permittedAction,/Review source invoice/);
  assert.match(reviewer.deepLink,/^\/invoice-checks\?record=9&gstin=1&branch=1$/);
  const owner=(await api('GET','/api/inbox',undefined,1)).data.items.find(x=>x.id==='invoice:9');
  assert.ok(owner);
  assert.doesNotMatch(owner.permittedAction,/^Review/);
  assert.equal((await api('GET','/api/inbox',undefined,4,2)).data.items.some(x=>x.id==='invoice:9'),false);
  assert.equal((await api('POST','/api/inbox/invoice/9/acknowledge',{expectedRevision:reviewer.sourceRevision},4,2)).status,404);
  db.prepare("UPDATE invoices SET created_by=2,submitted_by=2 WHERE id=9").run();
  const self=(await api('GET','/api/inbox',undefined,2)).data.items.find(x=>x.id==='invoice:9');
  assert.ok(self);assert.doesNotMatch(self.permittedAction,/^Review/);
  db.prepare("UPDATE user_branch_grants SET revoked_at=CURRENT_TIMESTAMP,revoked_by=3,revoked_reason='Test access revocation' WHERE company_id=1 AND user_id=2 AND branch_id=1 AND revoked_at IS NULL").run();
  assert.equal((await api('GET','/api/inbox',undefined,2)).data.items.some(x=>x.id==='invoice:9'),false);
  assert.equal((await api('POST','/api/inbox/invoice/9/acknowledge',{expectedRevision:self.sourceRevision},2)).status,404);
});

test('escalation requires an admin-approved policy, trigger, and independent scoped target',async t=>{
  const {db,api}=await fixture(t),id=caseWithEvents(db,1);
  const path=`/api/inbox/crm/${id}`;
  const initial=(await api('GET','/api/inbox?branchId=3')).data.items.find(x=>x.id===`crm:${id}`);
  assert.equal(initial.canEscalate,false);
  assert.match(initial.escalationUnavailableReason,/No approved/);
  assert.equal((await api('POST',`${path}/escalate`,{expectedRevision:initial.sourceRevision,reason:'Past due'})).status,403);
  assert.equal((await api('GET','/api/inbox/policies',undefined,1)).status,403);
  assert.equal((await api('POST','/api/inbox/policies',{sourceType:'crm',overdueDays:0,blockerAllowed:false,reason:'Overdue customer follow-ups require supervisor review'},1)).status,403);
  const approved=await api('POST','/api/inbox/policies',{sourceType:'crm',overdueDays:0,blockerAllowed:false,reason:'Overdue customer follow-ups require supervisor review'},3);
  assert.equal(approved.status,200);
  assert.equal(approved.data.policy.approvedBy,3);
  assert.equal((await api('GET','/api/inbox/policies',undefined,3)).data.policies[0].sourceType,'crm');
  const available=(await api('GET','/api/inbox?branchId=3')).data.items.find(x=>x.id===`crm:${id}`);
  assert.equal(available.canEscalate,true);
  const escalated=await api('POST',`${path}/escalate`,{expectedRevision:available.sourceRevision,reason:'Customer promise overdue'});
  assert.equal(escalated.status,200);
  assert.equal(escalated.data.item.escalation.target.id,3);
  assert.equal(escalated.data.item.canEscalate,false);
  assert.equal((await api('POST',`${path}/escalate`,{expectedRevision:available.sourceRevision,reason:'Again'})).status,403);
  assert.equal(db.prepare('SELECT status FROM order_crm_cases WHERE id=?').get(id).status,'open');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM inbox_escalations').get().n,1);
});

test('staff see only their claims and assigned cases; reviewer cannot review own claim through inbox',async t=>{
  const {db,api}=await fixture(t),caseId=caseWithEvents(db,1);
  const evidenceId=Number(db.prepare("INSERT INTO evidence_documents(company_id,gstin_id,branch_id,title,audience,target_type,target_id,created_by) VALUES (1,1,1,'synthetic','internal','invoice',2,1)").run().lastInsertRowid);
  db.prepare("INSERT INTO evidence_versions(document_id,version,file_name,mime_type,byte_size,sha256,content,status,uploaded_by) VALUES (?,1,'synthetic.txt','text/plain',1,?,'x','approved',1)").run(evidenceId,'a'.repeat(64));
  const claimId=Number(db.prepare(`INSERT INTO expense_claims(company_id,gstin_id,branch_id,invoice_id,claimant_user_id,created_by,paid_by,purpose,evidence_document_id,evidence_version,evidence_sha256,proof_reference,status,submitted_by,submitted_at)
    VALUES (1,1,1,2,1,1,'employee','Travel cost',?,1,?,'LOCAL','submitted',1,CURRENT_TIMESTAMP)`).run(evidenceId,'a'.repeat(64)).lastInsertRowid);
  db.prepare("INSERT INTO expense_claim_events(claim_id,action,to_status,version,details,actor_id) VALUES (?,'submitted','submitted',1,'Sent for review',1)").run(claimId);
  const staff=(await api('GET','/api/inbox',undefined,1)).data.items;
  assert.ok(staff.some(x=>x.id===`crm:${caseId}`));
  assert.ok(staff.some(x=>x.id===`expense:${claimId}`));
  const reviewer=(await api('GET','/api/inbox',undefined,2)).data.items.find(x=>x.id===`expense:${claimId}`);
  assert.ok(reviewer);assert.match(reviewer.permittedAction,/Review expense/);
  db.prepare('UPDATE expense_claims SET claimant_user_id=2,created_by=2,submitted_by=2 WHERE id=?').run(claimId);
  const self=(await api('GET','/api/inbox',undefined,2)).data.items.find(x=>x.id===`expense:${claimId}`);
  assert.ok(self);assert.doesNotMatch(self.permittedAction,/^Review/);
  assert.equal((await api('GET','/api/inbox',undefined,1)).data.items.some(x=>x.id===`expense:${claimId}`),false);
  assert.equal((await api('POST',`/api/inbox/expense/${claimId}/acknowledge`,{expectedRevision:self.sourceRevision},1)).status,404);
});

test('supplier payment and newer evidence reopen acknowledged and snoozed expense attention',async t=>{
  const {db,api}=await fixture(t);
  const invoice=db.prepare('SELECT * FROM invoices WHERE id=2').get();
  const evidenceId=Number(db.prepare("INSERT INTO evidence_documents(company_id,gstin_id,branch_id,title,audience,target_type,target_id,created_by) VALUES (1,1,1,'synthetic expense proof','internal','invoice',2,1)").run().lastInsertRowid);
  const digest='b'.repeat(64);
  db.prepare("INSERT INTO evidence_versions(document_id,version,file_name,mime_type,byte_size,sha256,content,status,uploaded_by) VALUES (?,1,'proof-v1.txt','text/plain',1,?,'x','approved',1)").run(evidenceId,digest);
  const fingerprint=sourceFingerprint(db,invoice,{document_id:evidenceId,version:1,sha256:digest,status:'approved'});
  const id=Number(db.prepare(`INSERT INTO expense_claims(company_id,gstin_id,branch_id,invoice_id,claimant_user_id,created_by,paid_by,purpose,evidence_document_id,evidence_version,evidence_sha256,proof_reference,status,submitted_by,submitted_at,source_fingerprint)
    VALUES (1,1,1,2,1,1,'employee','Travel cost',?,1,?,'LOCAL','submitted',1,CURRENT_TIMESTAMP,?)`).run(evidenceId,digest,fingerprint).lastInsertRowid);
  db.prepare("INSERT INTO expense_claim_events(claim_id,action,to_status,version,details,actor_id) VALUES (?,'submitted','submitted',1,'Sent for review',1)").run(id);
  const path=`/api/inbox/expense/${id}`;
  const initial=(await api('GET','/api/inbox')).data.items.find(x=>x.id===`expense:${id}`);
  assert.ok(initial);assert.equal(initial.sourceChanged,false);
  assert.equal((await api('POST',`${path}/acknowledge`,{expectedRevision:initial.sourceRevision})).data.item.acknowledged,true);
  const tomorrow=new Date(Date.now()+86400000).toISOString().slice(0,10);
  assert.equal((await api('POST',`${path}/snooze`,{expectedRevision:initial.sourceRevision,until:tomorrow})).data.item.snoozedUntil,tomorrow);
  db.prepare("INSERT INTO invoice_payments(company_id,invoice_id,amount_cents,method,reference,payment_date,recorded_by) VALUES (1,2,100,'bank','INBOX-SOURCE-PAYMENT','2026-09-24',2)").run();
  const changed=(await api('GET','/api/inbox')).data.items.find(x=>x.id===`expense:${id}`);
  assert.ok(changed);
  assert.notEqual(changed.sourceRevision,initial.sourceRevision);
  assert.equal(changed.acknowledged,false);
  assert.equal(changed.snoozedUntil,null);
  assert.equal(changed.sourceChanged,true);
  assert.match(changed.blocker,/source or evidence changed/);
  assert.equal(changed.events.at(-1).kind,'source_changed');
  assert.equal((await api('POST',`${path}/acknowledge`,{expectedRevision:initial.sourceRevision})).status,409);
  assert.equal((await api('POST',`${path}/acknowledge`,{expectedRevision:changed.sourceRevision})).status,200);
  db.prepare("INSERT INTO evidence_versions(document_id,version,file_name,mime_type,byte_size,sha256,content,status,uploaded_by) VALUES (?,2,'proof-v2.txt','text/plain',1,?,'y','pending',1)").run(evidenceId,'c'.repeat(64));
  const newer=(await api('GET','/api/inbox')).data.items.find(x=>x.id===`expense:${id}`);
  assert.notEqual(newer.sourceRevision,changed.sourceRevision);
  assert.equal(newer.acknowledged,false);
  assert.equal(db.prepare('SELECT status FROM expense_claims WHERE id=?').get(id).status,'submitted');
});

test('cashier discrepancy is one scoped review item and never closes through inbox actions',async t=>{
  const {db,api}=await fixture(t);
  const id=Number(db.prepare(`INSERT INTO cashier_sessions(company_id,branch_id,business_date,status,opening_cash_cents,counted_cash_cents,discrepancy_cents,close_notes,opened_by,closed_by,closed_at)
    VALUES (1,1,'2026-09-24','pending_review',10000,9500,-500,'Count short',1,1,CURRENT_TIMESTAMP)`).run().lastInsertRowid);
  db.prepare("INSERT INTO cashier_events(company_id,session_id,action,details,actor_id) VALUES (1,?,'discrepancy_submitted','Count short by 500 paise',1)").run(id);
  const review=(await api('GET','/api/inbox?branchId=1',undefined,2)).data.items.find(x=>x.id===`cashier:${id}`);
  assert.ok(review);
  assert.equal(review.amountCents,500);
  assert.equal(review.events.length,1);
  assert.match(review.permittedAction,/Review cashier/);
  const own=(await api('GET','/api/inbox?branchId=1',undefined,1)).data.items.find(x=>x.id===`cashier:${id}`);
  assert.ok(own);assert.doesNotMatch(own.permittedAction,/^Review/);
  assert.equal((await api('POST',`/api/inbox/cashier/${id}/acknowledge`,{expectedRevision:review.sourceRevision},2)).status,200);
  assert.equal(db.prepare('SELECT status FROM cashier_sessions WHERE id=?').get(id).status,'pending_review');
  assert.equal((await api('GET','/api/inbox?branchId=3',undefined,2)).data.items.some(x=>x.id===`cashier:${id}`),false);
});

test('work task source events, evidence and GST period changes stay one thread and reopen attention',async t=>{
  const {db,api}=await fixture(t),id=workTaskWithEvents(db,{scopeType:'gstin',branchId:null});
  const path=`/api/inbox/work_task/${id}`;
  const first=(await api('GET','/api/inbox?gstinId=1&branchId=1')).data.items.find(x=>x.id===`work_task:${id}`);
  assert.ok(first);
  assert.equal(first.events.length,10);
  assert.equal(first.dueDate,'2026-10-05');
  assert.equal(first.statutoryDueDate,null);
  assert.match(first.deepLink,/^\/work-tasks\?record=\d+&gstin=1$/);
  assert.equal(first.permittedAction,'Prepare work task');
  assert.equal(first.canEscalate,false);
  assert.match(first.escalationUnavailableReason,/not configured/);
  assert.equal((await api('POST','/api/inbox/policies',{sourceType:'work_task',overdueDays:0,blockerAllowed:true,reason:'No policy yet'},3)).status,400);
  const original=db.prepare('SELECT status,version FROM work_tasks WHERE id=?').get(id);
  assert.equal((await api('POST',`${path}/acknowledge`,{expectedRevision:first.sourceRevision})).data.item.acknowledged,true);
  const tomorrow=new Date(Date.now()+86400000).toISOString().slice(0,10);
  assert.equal((await api('POST',`${path}/snooze`,{expectedRevision:first.sourceRevision,until:tomorrow})).data.item.snoozedUntil,tomorrow);
  assert.equal(db.prepare('SELECT status,version FROM work_tasks WHERE id=?').get(id).status,original.status);
  assert.equal(db.prepare('SELECT status,version FROM work_tasks WHERE id=?').get(id).version,original.version);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM work_task_events WHERE task_id=?').get(id).n,10);
  db.prepare("INSERT INTO work_task_events(task_id,action,details,actor_id) VALUES (?,'checklist','Eleventh change',1)").run(id);
  const changed=(await api('GET','/api/inbox?branchId=1')).data.items.find(x=>x.id===`work_task:${id}`);
  assert.equal(changed.events.length,11);
  assert.notEqual(changed.sourceRevision,first.sourceRevision);
  assert.equal(changed.acknowledged,false);
  assert.equal(changed.snoozedUntil,null);
  assert.equal((await api('POST',`${path}/acknowledge`,{expectedRevision:first.sourceRevision})).status,409);
  db.prepare("INSERT INTO work_task_evidence(task_id,version,file_name,mime_type,byte_size,sha256,content,status,uploaded_by) VALUES (?,1,'proof.txt','text/plain',1,?,'x','pending',1)").run(id,'a'.repeat(64));
  const proof=(await api('GET','/api/inbox')).data.items.find(x=>x.id===`work_task:${id}`);
  assert.notEqual(proof.sourceRevision,changed.sourceRevision);
  assert.deepEqual(proof.evidence,{version:1,status:'pending'});
  db.prepare("INSERT OR IGNORE INTO gst_periods(company_id,gstin_id,period,status) VALUES (1,1,'2026-09','open')").run();
  const withSource=(await api('GET','/api/inbox')).data.items.find(x=>x.id===`work_task:${id}`);
  assert.ok(withSource.source);
  db.prepare("UPDATE gst_periods SET status='reviewed',reviewed_by=2 WHERE company_id=1 AND gstin_id=1 AND period='2026-09'").run();
  const sourceChanged=(await api('GET','/api/inbox')).data.items.find(x=>x.id===`work_task:${id}`);
  assert.notEqual(sourceChanged.sourceRevision,withSource.sourceRevision);
  assert.equal(sourceChanged.source.status,'reviewed');
  db.prepare("UPDATE work_tasks SET status='submitted',version=version+1,submitted_by=1,submitted_at=CURRENT_TIMESTAMP WHERE id=?").run(id);
  const reviewer=(await api('GET','/api/inbox',undefined,2)).data.items.find(x=>x.id===`work_task:${id}`);
  assert.equal(reviewer.permittedAction,'Review assigned work task');
  assert.match(reviewer.blocker,/Approved task evidence/);
  assert.equal((await api('POST',`${path}/acknowledge`,{expectedRevision:reviewer.sourceRevision},2)).status,200);
  assert.equal(db.prepare('SELECT status FROM work_tasks WHERE id=?').get(id).status,'submitted');
});

test('work task scope requires assignment or reviewer role and full GSTIN branch grants',async t=>{
  const {db,api}=await fixture(t),id=workTaskWithEvents(db,{scopeType:'gstin',branchId:null,count:1});
  const branchTaskId=workTaskWithEvents(db,{scopeType:'branch',branchId:1,count:1});
  const staff=(await api('GET','/api/inbox',undefined,1)).data.items.find(x=>x.id===`work_task:${id}`);
  assert.ok(staff);
  assert.match(staff.deepLink,/^\/work-tasks\?record=\d+&gstin=1$/);
  assert.ok((await api('GET','/api/inbox?gstinId=1&branchId=1',undefined,1)).data.items.some(x=>x.id===`work_task:${id}`));
  const branchTask=(await api('GET','/api/inbox?branchId=1',undefined,1)).data.items.find(x=>x.id===`work_task:${branchTaskId}`);
  assert.ok(branchTask);
  assert.equal(branchTask.source,null);
  assert.equal((await api('GET','/api/inbox?branchId=3',undefined,1)).data.items.some(x=>x.id===`work_task:${branchTaskId}`),false);
  assert.equal((await api('GET','/api/inbox',undefined,4,2)).data.items.some(x=>x.id===`work_task:${id}`),false);
  assert.equal((await api('POST',`/api/inbox/work_task/${id}/acknowledge`,{expectedRevision:staff.sourceRevision},4,2)).status,404);
  const reviewer=(await api('GET','/api/inbox',undefined,2)).data.items.find(x=>x.id===`work_task:${id}`);
  assert.ok(reviewer);
  db.prepare("UPDATE user_branch_grants SET revoked_at=CURRENT_TIMESTAMP,revoked_by=3,revoked_reason='Test partial GSTIN scope' WHERE company_id=1 AND user_id=2 AND branch_id=2 AND revoked_at IS NULL").run();
  assert.equal((await api('GET','/api/inbox',undefined,2)).data.items.some(x=>x.id===`work_task:${id}`),false);
  assert.equal((await api('POST',`/api/inbox/work_task/${id}/acknowledge`,{expectedRevision:reviewer.sourceRevision},2)).status,404);
  const admin=(await api('GET','/api/inbox',undefined,3)).data.items.find(x=>x.id===`work_task:${id}`);
  assert.ok(admin);
  assert.match(admin.blocker,/reviewer lacks current scope/);
  assert.notEqual(admin.sourceRevision,staff.sourceRevision);
});

test('work task state upgrades legacy rows, rejects orphans and cascades deletion across startup',t=>{
  const directory=mkdtempSync(join(tmpdir(),'inbox-task-state-'));
  t.after(()=>rmSync(directory,{recursive:true,force:true}));
  const path=join(directory,'erp.sqlite');
  let db=openDatabase(path);
  const taskId=workTaskWithEvents(db,{count:0});
  db.prepare("INSERT INTO inbox_user_state(company_id,user_id,source_type,source_id,acknowledged_revision) VALUES (1,1,'crm',42,'old-revision')").run();
  db.exec(`DROP TABLE inbox_work_task_user_state;
    CREATE TABLE inbox_work_task_user_state (
      company_id INTEGER NOT NULL REFERENCES companies(id),
      user_id INTEGER NOT NULL REFERENCES users(id),
      task_id INTEGER NOT NULL,
      acknowledged_revision TEXT,
      acknowledged_at TEXT,
      snoozed_revision TEXT,
      snoozed_until TEXT,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY(company_id,user_id,task_id)
    );`);
  db.prepare("INSERT INTO inbox_work_task_user_state(company_id,user_id,task_id,acknowledged_revision) VALUES (1,1,?,'task-revision')").run(taskId);
  db.prepare("INSERT INTO inbox_work_task_user_state(company_id,user_id,task_id,acknowledged_revision) VALUES (1,1,999999,'orphan')").run();
  db.close();
  db=openDatabase(path);
  installInboxSchema(db);
  assert.equal(db.prepare("SELECT acknowledged_revision FROM inbox_user_state WHERE company_id=1 AND user_id=1 AND source_type='crm' AND source_id=42").get().acknowledged_revision,'old-revision');
  assert.equal(db.prepare('SELECT acknowledged_revision FROM inbox_work_task_user_state WHERE company_id=1 AND user_id=1 AND task_id=?').get(taskId).acknowledged_revision,'task-revision');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM inbox_work_task_user_state WHERE task_id=999999').get().n,0);
  assert.ok(db.prepare('PRAGMA foreign_key_list(inbox_work_task_user_state)').all().some(row=>row.table==='work_tasks' && row.from==='task_id' && row.on_delete==='CASCADE'));
  assert.ok(db.prepare('PRAGMA index_list(inbox_work_task_user_state)').all().some(row=>row.origin==='pk'));
  assert.throws(()=>db.prepare("INSERT INTO inbox_work_task_user_state(company_id,user_id,task_id) VALUES (1,1,999999)").run(),/FOREIGN KEY/);
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='index' AND tbl_name='inbox_user_state'").get().n,1);
  db.prepare('DELETE FROM work_tasks WHERE id=?').run(taskId);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM inbox_work_task_user_state WHERE task_id=?').get(taskId).n,0);
  db.close();
});
