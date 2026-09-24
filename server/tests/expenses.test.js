import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require=createRequire(import.meta.url);
const { openDatabase }=require('../db.cjs');
const { createApp }=require('../api.cjs');
const { invoiceSettlementBalance }=require('../return-settlement.cjs');

async function setup(t) {
  const db=openDatabase(':memory:');
  const source=db.prepare("SELECT * FROM invoices WHERE number='DEMO-NS-501'").get();
  const documentId=Number(db.prepare("INSERT INTO evidence_documents(company_id,gstin_id,branch_id,title,audience,target_type,target_id,created_by) VALUES (1,1,1,'SYNTHETIC employee payment proof','internal','invoice',?,1)").run(source.id).lastInsertRowid);
  db.prepare("INSERT INTO evidence_versions(document_id,version,file_name,mime_type,byte_size,sha256,content,status,uploaded_by,reviewed_by,reviewed_at) VALUES (?,1,'synthetic-proof.txt','text/plain',20,?,'SYNTHETIC PROOF ONLY','approved',1,2,CURRENT_TIMESTAMP)").run(documentId,'a'.repeat(64));
  const server=createApp({db}).listen(0);
  t.after(()=>{server.close();db.close();});
  const base=`http://127.0.0.1:${server.address().port}`;
  const api=async(method,path,body,userId=1,companyId=1)=>{
    const result=await fetch(base+path,{method,headers:{'content-type':'application/json','x-company-id':String(companyId),'x-user-id':String(userId)},body:body===undefined?undefined:JSON.stringify(body)});
    return {status:result.status,data:await result.json()};
  };
  const createBody={invoiceId:source.id,claimantUserId:1,paidBy:'employee',purpose:'Synthetic branch supply paid by employee',evidenceDocumentId:documentId,evidenceVersion:1,proofReference:'SYNTHETIC-CARD-001'};
  const create=()=>api('POST','/api/expenses',createBody);
  const submit=claim=>api('POST',`/api/expenses/${claim.id}/submit`,{expectedVersion:claim.version});
  const approve=claim=>api('POST',`/api/expenses/${claim.id}/review`,{expectedVersion:claim.version,sourceFingerprint:claim.sourceFingerprint,decision:'approved'},2);
  return {db,api,source,documentId,createBody,create,submit,approve};
}

test('employee claim independently approves remaining AP once and posts balanced reclassification',async t=>{
  const {db,api,source,create,submit,approve}=await setup(t);
  const gstBefore=db.prepare('SELECT * FROM purchase_evidence WHERE invoice_id=?').get(source.id);
  const created=await create(); assert.equal(created.status,200); assert.equal(created.data.claim.status,'draft');
  const second=await create(); assert.equal(second.status,409);
  const submitted=await submit(created.data.claim); assert.equal(submitted.status,200); assert.equal(submitted.data.claim.version,2);
  const denied=await api('POST',`/api/expenses/${created.data.claim.id}/review`,{expectedVersion:2,sourceFingerprint:submitted.data.claim.sourceFingerprint,decision:'approved'},1); assert.equal(denied.status,403);
  const reviewed=await approve(submitted.data.claim); assert.equal(reviewed.status,200);
  assert.equal(reviewed.data.claim.status,'approved'); assert.equal(reviewed.data.claim.version,3);
  assert.equal(reviewed.data.claim.employeePaidCents,source.total_cents);
  assert.equal(reviewed.data.claim.reimbursementRemainingCents,source.total_cents);
  assert.equal((await approve(submitted.data.claim)).status,409);
  const balance=invoiceSettlementBalance(db,source.id,1);
  assert.equal(balance.outstandingCents,0); assert.equal(balance.paidCents,0); assert.equal(balance.employeeAllocatedCents,source.total_cents);
  const finance=await api('GET','/api/finance/open?type=purchase');
  const bill=finance.data.invoices.find(row=>row.id===source.id);
  assert.equal(bill.paidCents,0); assert.equal(bill.employeeAllocatedCents,source.total_cents); assert.equal(bill.outstandingCents,0);
  assert.equal((await api('POST','/api/finance/payments',{invoiceId:source.id,amountCents:100,method:'bank',reference:'DUP-SETTLEMENT',paymentDate:'2026-09-24'},2)).status,409);
  const journals=db.prepare("SELECT * FROM journals WHERE source_type='employee_expense_allocation'").all(); assert.equal(journals.length,1);
  const lines=db.prepare('SELECT a.code,l.debit_cents,l.credit_cents FROM journal_lines l JOIN ledger_accounts a ON a.id=l.account_id WHERE l.journal_id=? ORDER BY l.id').all(journals[0].id);
  assert.deepEqual(lines.map(row=>[row.code,row.debit_cents,row.credit_cents]),[['2100',source.total_cents,0],['2400',0,source.total_cents]]);
  assert.deepEqual(db.prepare('SELECT * FROM purchase_evidence WHERE invoice_id=?').get(source.id),gstBefore);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM expense_claim_events WHERE claim_id=?').get(created.data.claim.id).n,3);
});

test('reimbursements are bounded, unique, append-only, and never bank confirmations',async t=>{
  const {db,api,create,submit,approve,source}=await setup(t);
  const claim=(await approve((await submit((await create()).data.claim)).data.claim)).data.claim;
  const body={amountCents:10000,method:'upi',reference:'SYNTHETIC-UPI-1',paymentDate:'2026-09-24'};
  assert.equal((await api('POST',`/api/expenses/${claim.id}/reimbursements`,body)).status,403);
  const first=await api('POST',`/api/expenses/${claim.id}/reimbursements`,body,2);
  assert.equal(first.status,200); assert.equal(first.data.bankConfirmed,false);
  assert.equal(first.data.claim.reimbursedCents,10000); assert.equal(first.data.claim.version,3);
  assert.equal((await api('POST',`/api/expenses/${claim.id}/reimbursements`,body,2)).status,409);
  assert.equal((await api('POST',`/api/expenses/${claim.id}/reimbursements`,{...body,reference:'SYNTHETIC-UPI-2',amountCents:source.total_cents-9999},2)).status,409);
  const final=await api('POST',`/api/expenses/${claim.id}/reimbursements`,{...body,reference:'SYNTHETIC-UPI-3',amountCents:source.total_cents-10000},2);
  assert.equal(final.status,200); assert.equal(final.data.claim.reimbursementRemainingCents,0);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM journals WHERE source_type='expense_reimbursement'").get().n,2);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM invoice_payments WHERE invoice_id=?').get(source.id).n,0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM bank_statement_lines WHERE payment_id IS NOT NULL').get().n,0);
  assert.equal(invoiceSettlementBalance(db,source.id,1).outstandingCents,0);
});

test('reimbursement journal cannot predate the employee payable or source invoice',async t=>{
  const {db,api,create,submit,approve}=await setup(t);
  const claim=(await approve((await submit((await create()).data.claim)).data.claim)).data.claim;
  const allocation=db.prepare("SELECT journal_date FROM journals WHERE source_type='employee_expense_allocation' AND company_id=1 AND document_number=?").get(`EXP-${claim.id}`);
  const early='2000-01-01';
  const rejected=await api('POST',`/api/expenses/${claim.id}/reimbursements`,{amountCents:100,method:'upi',reference:'EARLY-REIMB',paymentDate:early},2);
  assert.equal(rejected.status,409);
  assert.match(rejected.data.error,/cannot precede/);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM expense_reimbursements').get().n,0);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM journals WHERE source_type='expense_reimbursement'").get().n,0);
  const accepted=await api('POST',`/api/expenses/${claim.id}/reimbursements`,{amountCents:100,method:'upi',reference:'VALID-REIMB',paymentDate:allocation.journal_date},2);
  assert.equal(accepted.status,200);
});

test('source change, source scope, proof, cost centre and overpayment guards',async t=>{
  const {db,api,createBody,create,submit,approve,source,documentId}=await setup(t);
  assert.equal((await api('POST','/api/expenses',{...createBody,invoiceId:1})).status,404);
  assert.equal((await api('POST','/api/expenses',{...createBody,evidenceDocumentId:9999})).status,409);
  assert.equal((await api('POST','/api/expenses',{...createBody,costCentre:'NONEXISTENT'})).status,409);
  assert.equal((await api('POST','/api/expenses',{...createBody,claimantUserId:4})).status,403);
  assert.equal((await api('POST','/api/expenses',createBody,4,2)).status,404);
  db.prepare("INSERT INTO budget_centres(company_id,gstin_id,branch_id,code,name,purpose,created_by) VALUES (1,1,1,'OPS','Operations','Synthetic',1)").run();
  const created=await api('POST','/api/expenses',{...createBody,costCentre:'OPS'}); assert.equal(created.status,200);
  const submitted=(await submit(created.data.claim)).data.claim;
  assert.equal((await api('POST',`/api/expenses/${submitted.id}/review`,{expectedVersion:2,sourceFingerprint:'wrong',decision:'approved'},2)).status,409);
  db.prepare("INSERT INTO invoice_payments(company_id,invoice_id,amount_cents,method,reference,payment_date,recorded_by) VALUES (1,?,100,'bank','INTERVENING','2026-09-24',2)").run(source.id);
  assert.equal((await approve(submitted)).status,409);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM employee_invoice_allocations').get().n,0);
  assert.equal(db.prepare('SELECT status FROM expense_claims WHERE id=?').get(submitted.id).status,'submitted');
  db.prepare('DELETE FROM invoice_payments WHERE reference=?').run('INTERVENING');
  db.prepare("INSERT INTO evidence_versions(document_id,version,file_name,mime_type,byte_size,sha256,content,status,uploaded_by) VALUES (?,2,'new.txt','text/plain',1,?,'X','pending',1)").run(documentId,'b'.repeat(64));
  assert.equal((await approve(submitted)).status,409);
});

test('claimant must have the purchase invoice GSTIN and branch grants',async t=>{
  const {db,api,createBody}=await setup(t);
  const before=await api('GET','/api/expenses/claimants?gstinId=1&branchId=1',undefined,2);
  assert.equal(before.status,200);
  assert.ok(before.data.users.some(user=>user.id===1));
  db.prepare('UPDATE user_branch_grants SET revoked_at=CURRENT_TIMESTAMP,revoked_by=3,revoked_reason=? WHERE company_id=1 AND user_id=1 AND branch_id=1 AND revoked_at IS NULL').run('Test revoked branch');
  const after=await api('GET','/api/expenses/claimants?gstinId=1&branchId=1',undefined,2);
  assert.equal(after.status,200);
  assert.equal(after.data.users.some(user=>user.id===1),false);
  const denied=await api('POST','/api/expenses',{...createBody,claimantUserId:1},2);
  assert.equal(denied.status,403);
  assert.match(denied.data.error,/Branch access/);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM expense_claims').get().n,0);
});

test('company-paid claims categorise without AP allocation or reimbursement; rejected claim allows replacement',async t=>{
  const {db,api,createBody,source,submit}=await setup(t);
  const first=(await api('POST','/api/expenses',{...createBody,paidBy:'company'})).data.claim;
  const submitted=(await submit(first)).data.claim;
  const rejected=await api('POST',`/api/expenses/${first.id}/review`,{expectedVersion:submitted.version,sourceFingerprint:submitted.sourceFingerprint,decision:'rejected',reason:'Synthetic review rejection'},2);
  assert.equal(rejected.status,200);
  const replacement=await api('POST','/api/expenses',{...createBody,paidBy:'company'});
  assert.equal(replacement.status,200);
  const review=await api('POST',`/api/expenses/${replacement.data.claim.id}/review`,{expectedVersion:2,sourceFingerprint:(await submit(replacement.data.claim)).data.claim.sourceFingerprint,decision:'approved'},2);
  assert.equal(review.status,200); assert.equal(review.data.claim.settlementStatus,'categorisation_only');
  assert.equal(review.data.claim.categorisedAmountCents,source.total_cents);
  assert.equal(review.data.claim.employeePaidCents,0);
  assert.equal((await api('POST',`/api/expenses/${replacement.data.claim.id}/reimbursements`,{amountCents:1,method:'bank',reference:'BAD',paymentDate:'2026-09-24'},2)).status,409);
  assert.equal(invoiceSettlementBalance(db,source.id,1).outstandingCents,source.total_cents);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM employee_invoice_allocations').get().n,0);
});

test('parallel approval requests serialize to one allocation and one journal',async t=>{
  const {db,create,submit,approve}=await setup(t);
  const submitted=(await submit((await create()).data.claim)).data.claim;
  const results=await Promise.all([approve(submitted),approve(submitted)]);
  assert.deepEqual(results.map(row=>row.status).sort(),[200,409]);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM employee_invoice_allocations').get().n,1);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM journals WHERE source_type='employee_expense_allocation'").get().n,1);
});

test('purchase return cannot unwind AP already allocated to employee',async t=>{
  const {db,api,source,create,submit,approve}=await setup(t);
  const claim=(await approve((await submit((await create()).data.claim)).data.claim)).data.claim;
  const line=db.prepare('SELECT id FROM invoice_lines WHERE invoice_id=? AND subtotal_cents>0 LIMIT 1').get(source.id);
  const created=await api('POST','/api/returns',{invoiceId:source.id,lines:[{invoiceLineId:line.id,quantity:1}],reason:'Synthetic returned item'},1);
  assert.equal(created.status,200);
  const approved=await api('POST',`/api/returns/${created.data.return.id}/approve`,{},2);
  assert.equal(approved.status,200);
  const attempted=await api('POST','/api/return-settlements',{returnId:created.data.return.id,settlementDate:'2026-09-24'},2);
  assert.equal(attempted.status,409);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM return_settlements WHERE invoice_id=?').get(source.id).n,0);
  assert.equal(invoiceSettlementBalance(db,source.id,1).employeeAllocatedCents,claim.employeePaidCents);
});

test('staff with the same branch grant cannot browse another claimant or reimbursement',async t=>{
  const {db,api,create,submit,approve}=await setup(t);
  const other=Number(db.prepare("INSERT INTO users(company_id,name,role) VALUES (1,'Synthetic Other Staff','staff')").run().lastInsertRowid);
  db.prepare("INSERT INTO user_gstin_grants(company_id,user_id,gstin_id,granted_by,reason) VALUES (1,?,1,3,'Synthetic test grant')").run(other);
  db.prepare("INSERT INTO user_branch_grants(company_id,user_id,branch_id,granted_by,reason) VALUES (1,?,1,3,'Synthetic test grant')").run(other);
  const claim=(await approve((await submit((await create()).data.claim)).data.claim)).data.claim;
  await api('POST',`/api/expenses/${claim.id}/reimbursements`,{amountCents:100,method:'bank',reference:'PRIVATE-REIMB',paymentDate:'2026-09-24'},2);
  const list=await api('GET','/api/expenses',undefined,other);
  assert.equal(list.status,200); assert.equal(list.data.claims.some(row=>row.id===claim.id),false);
  assert.equal((await api('GET',`/api/expenses/${claim.id}`,undefined,other)).status,403);
  assert.equal((await api('GET',`/api/expenses/${claim.id}`,undefined,1)).status,200);
});
