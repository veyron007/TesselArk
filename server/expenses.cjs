const { createHash } = require('node:crypto');
const { allowedScopes, assertScopeAccess } = require('./access.cjs');
const { invoiceSettlementBalance } = require('./return-settlement.cjs');
const { postInvoice, writeJournal } = require('./ledger.cjs');

const fail = (message,status=400) => Object.assign(new Error(message),{status});
const camel = row => row && Object.fromEntries(Object.entries(row).map(([key,value])=>[key.replace(/_([a-z])/g,(_,letter)=>letter.toUpperCase()),value]));
const id = (value,label) => { const number=Number(value); if (!Number.isSafeInteger(number) || number<1) throw fail(`${label} must be a positive integer`); return number; };
const exactId = (value,label) => { if (!Number.isSafeInteger(value) || value<1) throw fail(`${label} must be a positive integer`); return value; };
const string = (value,label,max,required=true) => { if (typeof value!=='string' || value.length>max || (required && !value.trim()) || /[\x00-\x1f\x7f]/.test(value)) throw fail(`${label} is invalid`); return value.trim(); };
const validDate = value => { if (typeof value!=='string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`)) || new Date(`${value}T00:00:00Z`).toISOString().slice(0,10)!==value) throw fail('paymentDate must be YYYY-MM-DD'); return value; };
const transact = (db,fn) => { db.exec('BEGIN IMMEDIATE'); try { const result=fn(); db.exec('COMMIT'); return result; } catch (error) { db.exec('ROLLBACK'); throw error; } };
const requireReviewer = req => { if (!['accountant','admin'].includes(req.user.role)) throw fail('Accountant or admin role required',403); };

function invoice(db,req,invoiceId) {
  const row=db.prepare("SELECT * FROM invoices WHERE id=? AND company_id=? AND type='purchase' AND status='approved'").get(invoiceId,req.company.id);
  if (!row) throw fail('Approved purchase invoice not found in selected company',404);
  assertScopeAccess(db,{companyId:req.company.id,userId:req.user.id,gstinId:row.gstin_id,branchId:row.branch_id});
  return row;
}
function evidence(db,source,documentId,version) {
  const row=db.prepare(`SELECT d.id AS document_id,d.company_id,d.gstin_id,d.branch_id,d.target_type,d.target_id,
    v.version,v.sha256,v.status,v.file_name,v.reviewed_by
    FROM evidence_documents d JOIN evidence_versions v ON v.document_id=d.id AND v.version=?
    WHERE d.id=?`).get(version,documentId);
  if (!row || row.company_id!==source.company_id || row.gstin_id!==source.gstin_id || row.branch_id!==source.branch_id || row.target_type!=='invoice' || row.target_id!==source.id) throw fail('Evidence must be linked to this exact approved purchase invoice and scope',409);
  const latest=db.prepare('SELECT MAX(version) AS version FROM evidence_versions WHERE document_id=?').get(documentId).version;
  if (latest!==version || row.status!=='approved') throw fail('Latest evidence version must be approved',409);
  return row;
}
function sourceFingerprint(db,source,proof) {
  const balance=invoiceSettlementBalance(db,source.id,source.company_id);
  const lines=db.prepare('SELECT id,item_id,quantity,unit_price_cents,gst_rate_bps,subtotal_cents,tax_cents,total_cents FROM invoice_lines WHERE invoice_id=? ORDER BY id').all(source.id);
  const stable={invoice:{id:source.id,companyId:source.company_id,gstinId:source.gstin_id,branchId:source.branch_id,partyId:source.party_id,number:source.number,supplierInvoiceNumber:source.supplier_invoice_number,supplierGstin:source.supplier_gstin_snapshot,invoiceDate:source.invoice_date,totalCents:source.total_cents,subtotalCents:source.subtotal_cents,taxCents:source.tax_cents,status:source.status},lines,balance:{paidCents:balance.paidCents,commercialAdjustmentCents:balance.commercialAdjustmentCents,outstandingCents:balance.outstandingCents},proof:{documentId:proof.document_id,version:proof.version,sha256:proof.sha256,status:proof.status}};
  return createHash('sha256').update(JSON.stringify(stable)).digest('hex');
}
function claimRow(db,req,claimId) {
  const row=db.prepare('SELECT * FROM expense_claims WHERE id=? AND company_id=?').get(claimId,req.company.id);
  if (!row) throw fail('Expense claim not found in selected company',404);
  assertScopeAccess(db,{companyId:req.company.id,userId:req.user.id,gstinId:row.gstin_id,branchId:row.branch_id});
  return row;
}
function detail(db,row) {
  const source=db.prepare('SELECT id,number,supplier_invoice_number,party_name_snapshot,invoice_date,total_cents,subtotal_cents,tax_cents FROM invoices WHERE id=?').get(row.invoice_id);
  const proof=db.prepare('SELECT d.title,v.file_name,v.status,v.sha256 FROM evidence_documents d JOIN evidence_versions v ON v.document_id=d.id AND v.version=? WHERE d.id=?').get(row.evidence_version,row.evidence_document_id);
  const events=db.prepare('SELECT * FROM expense_claim_events WHERE claim_id=? ORDER BY id').all(row.id).map(camel);
  const reimbursements=db.prepare('SELECT * FROM expense_reimbursements WHERE claim_id=? ORDER BY id').all(row.id).map(camel);
  const allocation=db.prepare('SELECT id,amount_cents,allocated_at FROM employee_invoice_allocations WHERE claim_id=?').get(row.id);
  const reimbursedCents=reimbursements.reduce((sum,item)=>sum+item.amountCents,0);
  const employeePaidCents=allocation?.amount_cents || 0;
  return {...camel(row),invoice:camel(source),evidence:{documentId:row.evidence_document_id,version:row.evidence_version,title:proof?.title,fileName:proof?.file_name,status:proof?.status,sha256:proof?.sha256},employeePaidCents,reimbursedCents,reimbursementRemainingCents:employeePaidCents-reimbursedCents,categorisedAmountCents:row.paid_by==='company'?row.approved_amount_cents:0,settlementStatus:row.paid_by==='company'?'categorisation_only':allocation?'employee_payable_recorded':'unposted',bankConfirmed:false,allocation:camel(allocation),events,reimbursements};
}
function event(db,row,action,from,actor,details) {
  db.prepare('INSERT INTO expense_claim_events(claim_id,action,from_status,to_status,version,details,actor_id) VALUES (?,?,?,?,?,?,?)').run(row.id,action,from,row.status,row.version,details,actor);
}
function registerExpenseRoutes(app,db) {
  const route=fn=>(req,res,next)=>{try { res.json(fn(req)); } catch(error) { next(error); }};
  app.get('/api/expenses',route(req=>{
    const gstinId=req.query.gstinId===undefined?null:id(req.query.gstinId,'gstinId');
    const branchId=req.query.branchId===undefined?null:id(req.query.branchId,'branchId');
    if (gstinId || branchId) assertScopeAccess(db,{companyId:req.company.id,userId:req.user.id,...(gstinId?{gstinId}:{}),...(branchId?{branchId}:{})});
    const permitted=allowedScopes(db,{companyId:req.company.id,userId:req.user.id});
    const rows=db.prepare(`SELECT * FROM expense_claims WHERE company_id=? AND (? IS NULL OR gstin_id=?) AND (? IS NULL OR branch_id=?) AND branch_id IN (${permitted.branchIds.map(()=>'?').join(',')||'NULL'}) AND (?<>'staff' OR claimant_user_id=? OR created_by=?) ORDER BY id DESC`).all(req.company.id,gstinId,gstinId,branchId,branchId,...permitted.branchIds,req.user.role,req.user.id,req.user.id);
    return {claims:rows.map(row=>detail(db,row))};
  }));
  app.get('/api/expenses/claimants',route(req=>{
    const gstinId=id(req.query.gstinId,'gstinId'), branchId=id(req.query.branchId,'branchId');
    assertScopeAccess(db,{companyId:req.company.id,userId:req.user.id,gstinId,branchId});
    const users=db.prepare(`SELECT u.id,u.company_id,u.name,u.role FROM users u
      JOIN user_gstin_grants g ON g.company_id=u.company_id AND g.user_id=u.id AND g.gstin_id=? AND g.revoked_at IS NULL
      JOIN user_branch_grants b ON b.company_id=u.company_id AND b.user_id=u.id AND b.branch_id=? AND b.revoked_at IS NULL
      WHERE u.company_id=? AND (?<>'staff' OR u.id=?) ORDER BY u.name,u.id`)
      .all(gstinId,branchId,req.company.id,req.user.role,req.user.id);
    return {users:users.map(camel)};
  }));
  app.get('/api/expenses/:id',route(req=>{ const row=claimRow(db,req,id(req.params.id,'id')); if (req.user.role==='staff' && row.claimant_user_id!==req.user.id && row.created_by!==req.user.id) throw fail('Claim is not visible to this staff member',403); return {claim:detail(db,row)}; }));
  app.post('/api/expenses',route(req=>transact(db,()=>{
    const body=req.body||{};
    const source=invoice(db,req,exactId(body.invoiceId,'invoiceId'));
    const claimant= db.prepare('SELECT id FROM users WHERE id=? AND company_id=?').get(exactId(body.claimantUserId,'claimantUserId'),req.company.id);
    if (!claimant) throw fail('Claimant must belong to selected company',403);
    assertScopeAccess(db,{companyId:req.company.id,userId:claimant.id,gstinId:source.gstin_id,branchId:source.branch_id});
    if (req.user.role==='staff' && claimant.id!==req.user.id) throw fail('Staff may claim only for themselves',403);
    if (!['employee','company'].includes(body.paidBy)) throw fail('paidBy must be employee or company');
    const purpose=string(body.purpose,'purpose',500), costCentre=body.costCentre===undefined || body.costCentre===null || body.costCentre===''?null:string(body.costCentre,'costCentre',80);
    if (costCentre && !db.prepare('SELECT 1 FROM budget_centres WHERE company_id=? AND gstin_id=? AND branch_id=? AND code=?').get(req.company.id,source.gstin_id,source.branch_id,costCentre)) throw fail('Cost centre must exist in the invoice GSTIN and branch',409);
    const proofReference=string(body.proofReference,'proofReference',120);
    const documentId=exactId(body.evidenceDocumentId,'evidenceDocumentId'), version=exactId(body.evidenceVersion,'evidenceVersion');
    const proof=evidence(db,source,documentId,version);
    if (db.prepare("SELECT 1 FROM expense_claims WHERE company_id=? AND invoice_id=? AND status<>'rejected'").get(req.company.id,source.id)) throw fail('An active claim already exists for this invoice',409);
    const result=db.prepare(`INSERT INTO expense_claims(company_id,gstin_id,branch_id,invoice_id,claimant_user_id,created_by,paid_by,purpose,cost_centre,evidence_document_id,evidence_version,evidence_sha256,proof_reference) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(req.company.id,source.gstin_id,source.branch_id,source.id,claimant.id,req.user.id,body.paidBy,purpose,costCentre,documentId,version,proof.sha256,proofReference);
    const row=db.prepare('SELECT * FROM expense_claims WHERE id=?').get(result.lastInsertRowid);
    event(db,row,'created',null,req.user.id,'Draft claim linked to approved purchase invoice and evidence version');
    return {claim:detail(db,row)};
  })));
  app.post('/api/expenses/:id/submit',route(req=>transact(db,()=>{
    const row=claimRow(db,req,id(req.params.id,'id'));
    if (row.status!=='draft') throw fail('Only draft claims can be submitted',409);
    if (req.user.id!==row.created_by && req.user.id!==row.claimant_user_id) throw fail('Only creator or claimant can submit',403);
    if (req.body?.expectedVersion!==row.version) throw fail('Claim version has changed',409);
    const source=invoice(db,req,row.invoice_id), proof=evidence(db,source,row.evidence_document_id,row.evidence_version);
    if (proof.sha256!==row.evidence_sha256) throw fail('Evidence has changed',409);
    const balance=invoiceSettlementBalance(db,source.id,source.company_id);
    if (row.paid_by==='employee' && balance.outstandingCents<=0) throw fail('No supplier payable remains to allocate',409);
    const fingerprint=sourceFingerprint(db,source,proof);
    db.prepare("UPDATE expense_claims SET status='submitted',version=version+1,source_fingerprint=?,submitted_by=?,submitted_at=CURRENT_TIMESTAMP WHERE id=?").run(fingerprint,req.user.id,row.id);
    const updated=db.prepare('SELECT * FROM expense_claims WHERE id=?').get(row.id);
    event(db,updated,'submitted','draft',req.user.id,'Submitted for independent review');
    return {claim:detail(db,updated)};
  })));
  app.post('/api/expenses/:id/review',route(req=>transact(db,()=>{
    requireReviewer(req);
    const row=claimRow(db,req,id(req.params.id,'id'));
    if (row.status!=='submitted') throw fail('Only submitted claims can be reviewed',409);
    const body=req.body||{};
    if (body.expectedVersion!==row.version) throw fail('Claim version has changed',409);
    if (body.sourceFingerprint!==row.source_fingerprint) throw fail('Source fingerprint has changed',409);
    if (req.user.id===row.created_by || req.user.id===row.claimant_user_id || req.user.id===row.submitted_by) throw fail('Independent accountant or admin review required',403);
    if (!['approved','rejected'].includes(body.decision)) throw fail('decision must be approved or rejected');
    const reason=string(body.reason??'','reason',500,false);
    if (body.decision==='rejected' && !reason) throw fail('Rejection reason required');
    const source=invoice(db,req,row.invoice_id), proof=evidence(db,source,row.evidence_document_id,row.evidence_version);
    if (proof.sha256!==row.evidence_sha256 || sourceFingerprint(db,source,proof)!==row.source_fingerprint) throw fail('Source or settlement changed; resubmit a fresh claim',409);
    const balance=invoiceSettlementBalance(db,source.id,source.company_id);
    if (body.decision==='approved' && row.paid_by==='employee' && balance.outstandingCents<=0) throw fail('No supplier payable remains to allocate',409);
    const approved=body.decision==='approved'?row.paid_by==='employee'?balance.outstandingCents:balance.adjustedTotalCents:0;
    if (body.decision==='approved' && approved<=0) throw fail('No eligible amount remains',409);
    db.prepare('UPDATE expense_claims SET status=?,version=version+1,approved_amount_cents=?,reviewed_by=?,reviewed_at=CURRENT_TIMESTAMP WHERE id=?').run(body.decision,approved,req.user.id,row.id);
    const updated=db.prepare('SELECT * FROM expense_claims WHERE id=?').get(row.id);
    if (body.decision==='approved' && row.paid_by==='employee') {
      const allocation=db.prepare('INSERT INTO employee_invoice_allocations(company_id,invoice_id,claim_id,amount_cents,allocated_by) VALUES (?,?,?,?,?)').run(req.company.id,source.id,row.id,approved,req.user.id);
      postInvoice(db,source.id);
      writeJournal(db,{companyId:req.company.id,gstinId:source.gstin_id,branchId:source.branch_id,partyId:source.party_id,partyName:source.party_name_snapshot,sourceType:'employee_expense_allocation',sourceId:Number(allocation.lastInsertRowid),documentNumber:`EXP-${row.id}`,journalDate:new Date().toISOString().slice(0,10),description:`Employee payment allocated to supplier invoice ${source.number}; claim ${row.id}`},[{code:'2100',debitCents:approved,creditCents:0},{code:'2400',debitCents:0,creditCents:approved}]);
    }
    event(db,updated,body.decision,'submitted',req.user.id,reason||`Independent ${body.decision} review`);
    return {claim:detail(db,updated)};
  })));
  app.post('/api/expenses/:id/reimbursements',route(req=>transact(db,()=>{
    requireReviewer(req);
    const row=claimRow(db,req,id(req.params.id,'id'));
    if (row.status!=='approved' || row.paid_by!=='employee') throw fail('Approved employee-paid claim required',409);
    const body=req.body||{};
    if (!Number.isSafeInteger(body.amountCents) || body.amountCents<=0) throw fail('amountCents must be positive integer paise');
    if (!['bank','upi'].includes(body.method)) throw fail('method must be bank or upi');
    const reference=string(body.reference,'reference',100), paymentDate=validDate(body.paymentDate);
    if (db.prepare('SELECT 1 FROM expense_reimbursements WHERE company_id=? AND reference=?').get(req.company.id,reference)) throw fail('Reimbursement reference already recorded',409);
    const spent=db.prepare('SELECT COALESCE(SUM(amount_cents),0) AS cents FROM expense_reimbursements WHERE claim_id=?').get(row.id).cents;
    const allocation=db.prepare('SELECT id,amount_cents FROM employee_invoice_allocations WHERE claim_id=?').get(row.id);
    if (!allocation || body.amountCents>allocation.amount_cents-spent) throw fail('Reimbursement exceeds remaining employee payable',409);
    const allocationJournal=db.prepare("SELECT journal_date FROM journals WHERE company_id=? AND source_type='employee_expense_allocation' AND source_id=?").get(req.company.id,allocation.id);
    const invoiceDate=db.prepare('SELECT invoice_date FROM invoices WHERE id=? AND company_id=?').get(row.invoice_id,req.company.id)?.invoice_date;
    if (!allocationJournal || !invoiceDate) throw fail('Employee payable source is incomplete',409);
    if (paymentDate<allocationJournal.journal_date || paymentDate<invoiceDate) throw fail('Reimbursement date cannot precede the employee payable or source invoice',409);
    const inserted=db.prepare('INSERT INTO expense_reimbursements(company_id,claim_id,amount_cents,method,reference,payment_date,recorded_by) VALUES (?,?,?,?,?,?,?)').run(req.company.id,row.id,body.amountCents,body.method,reference,paymentDate,req.user.id);
    const reimbursementId=Number(inserted.lastInsertRowid);
    writeJournal(db,{companyId:req.company.id,gstinId:row.gstin_id,branchId:row.branch_id,partyId:null,partyName:'',sourceType:'expense_reimbursement',sourceId:reimbursementId,documentNumber:reference,journalDate:paymentDate,description:`Recorded employee reimbursement against expense claim ${row.id}; local bank or UPI record, unconfirmed`},[{code:'2400',debitCents:body.amountCents,creditCents:0},{code:'1100',debitCents:0,creditCents:body.amountCents}]);
    return {claim:detail(db,row),reimbursement:camel(db.prepare('SELECT * FROM expense_reimbursements WHERE id=?').get(reimbursementId)),bankConfirmed:false};
  })));
}
module.exports={ registerExpenseRoutes, sourceFingerprint };
