const { createHash } = require('node:crypto');
const { sourceFingerprint } = require('./expenses.cjs');
const { invoiceSettlementBalance } = require('./return-settlement.cjs');
const { postInvoice, postPayment, writeJournal } = require('./ledger.cjs');

const SPECS = Object.freeze([
  {
    invoiceNumber: 'DEMO-NS-501', branchName: 'Mumbai Central', paidBy: 'employee',
    purpose: 'Glucose strip restock paid personally during the synthetic Mumbai buying run.',
    costCentre: 'DEMO-OPS', proofReference: 'SYNTH-EMP-UPI-501',
    firstNote: 'Initial synthetic receipt transcription; superseded after amount check.',
    finalNote: 'Synthetic employee UPI debit note and supplier receipt; no bank verification.',
    reimbursement: { amountCents: 12000, method: 'upi', reference: 'SYNTH-REIMB-501' },
  },
  {
    invoiceNumber: 'DEMO-PUR-BLR-302', branchName: 'Bengaluru Branch', paidBy: 'employee',
    purpose: 'Saline pack receipt for the Bengaluru branch paid by the buyer.',
    costCentre: null, proofReference: 'SYNTH-EMP-UPI-BLR-302',
    firstNote: 'Synthetic receipt scan transcription awaiting line check.',
    finalNote: 'Synthetic employee UPI debit note and goods receipt reference; no bank verification.',
  },
  {
    invoiceNumber: 'DEMO-NS-502', branchName: 'Mumbai Central', paidBy: 'company',
    purpose: 'Company bank payment for the second glucose strip restock.',
    costCentre: 'DEMO-OPS', proofReference: 'SYNTH-COMPANY-BANK-502',
    firstNote: 'Synthetic company payment advice draft; superseded by reviewed copy.',
    finalNote: 'Synthetic company bank payment advice; locally recorded, not bank confirmed.',
    supplierPaymentReference: 'SYNTH-SUPPLIER-PAY-NS-502',
  },
]);

function sha256(content) { return createHash('sha256').update(content).digest('hex'); }

function addProof(db, source, spec, actorId, reviewerId) {
  const title = `SYNTHETIC EXPENSE PROOF · ${source.number}`;
  const existing = db.prepare("SELECT id FROM evidence_documents WHERE company_id=? AND target_type='invoice' AND target_id=? AND title=?")
    .get(source.company_id, source.id, title);
  if (existing) {
    const latest = db.prepare('SELECT * FROM evidence_versions WHERE document_id=? ORDER BY version DESC LIMIT 1').get(existing.id);
    if (!latest || latest.status !== 'approved') throw new Error(`Expense demo proof is incomplete for ${source.number}`);
    return { documentId: existing.id, version: latest.version, sha256: latest.sha256, status: latest.status };
  }
  const documentId = Number(db.prepare(`INSERT INTO evidence_documents
    (company_id,gstin_id,branch_id,title,audience,target_type,target_id,created_by)
    VALUES (?,?,?,?, 'internal','invoice',?,?)`)
    .run(source.company_id,source.gstin_id,source.branch_id,title,source.id,actorId).lastInsertRowid);
  const insert = db.prepare(`INSERT INTO evidence_versions
    (document_id,version,file_name,mime_type,byte_size,sha256,content,status,uploaded_by,reviewed_by,reviewed_at,review_reason)
    VALUES (?,?,?,'text/plain',?,?,?,?,?,?,CURRENT_TIMESTAMP,?)`);
  for (const version of [1,2]) {
    const content = Buffer.from([
      'SYNTHETIC DEMO DOCUMENT — NOT AN AUTHENTIC INVOICE OR BANK RECORD',
      `Source purchase invoice: ${source.number}`,
      `Supplier invoice reference: ${source.supplier_invoice_number}`,
      `Supplier: ${source.party_name_snapshot}`,
      `Invoice date: ${source.invoice_date}`,
      `Invoice amount (paise): ${source.total_cents}`,
      `Proof reference: ${spec.proofReference}`,
      `Paid by: ${spec.paidBy}`,
      version === 1 ? spec.firstNote : spec.finalNote,
      '',
    ].join('\n'),'utf8');
    insert.run(documentId,version,`synthetic-expense-${source.number.toLowerCase()}-v${version}.txt`,
      content.length,sha256(content),content,version === 1 ? 'rejected' : 'approved',actorId,reviewerId,
      version === 1 ? 'Superseded synthetic draft.' : 'Approved as local synthetic evidence only.');
  }
  const latest = db.prepare('SELECT version,sha256,status FROM evidence_versions WHERE document_id=? ORDER BY version DESC LIMIT 1').get(documentId);
  return { documentId, ...latest };
}

function addCompanyPayment(db, source, spec, reviewerId, day) {
  if (!spec.supplierPaymentReference) return;
  const existing = db.prepare('SELECT id FROM invoice_payments WHERE company_id=? AND invoice_id=? AND reference=?')
    .get(source.company_id,source.id,spec.supplierPaymentReference);
  if (existing) return;
  const balance = invoiceSettlementBalance(db,source.id,source.company_id);
  if (balance.outstandingCents !== source.total_cents) throw new Error(`Expense demo supplier bill ${source.number} has changed settlement`);
  const paymentId = Number(db.prepare(`INSERT INTO invoice_payments
    (company_id,invoice_id,amount_cents,method,reference,payment_date,recorded_by)
    VALUES (?,?,?,'bank',?,?,?)`)
    .run(source.company_id,source.id,source.total_cents,spec.supplierPaymentReference,day,reviewerId).lastInsertRowid);
  postPayment(db,paymentId);
}

function addClaim(db, source, spec, proof, actorId, reviewerId, day) {
  const balance = invoiceSettlementBalance(db,source.id,source.company_id);
  const approvedCents = spec.paidBy === 'employee' ? balance.outstandingCents : balance.adjustedTotalCents;
  if (approvedCents <= 0) throw new Error(`Expense demo invoice ${source.number} has no claimable balance`);
  const fingerprint = sourceFingerprint(db,source,{
    document_id:proof.documentId,version:proof.version,sha256:proof.sha256,status:proof.status,
  });
  const claimId = Number(db.prepare(`INSERT INTO expense_claims
    (company_id,gstin_id,branch_id,invoice_id,claimant_user_id,created_by,paid_by,purpose,cost_centre,
     evidence_document_id,evidence_version,evidence_sha256,proof_reference,status,version,source_fingerprint,
     approved_amount_cents,submitted_by,reviewed_by,submitted_at,reviewed_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,'approved',3,?,?,?,?,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`)
    .run(source.company_id,source.gstin_id,source.branch_id,source.id,actorId,actorId,spec.paidBy,spec.purpose,
      spec.costCentre,proof.documentId,proof.version,proof.sha256,spec.proofReference,fingerprint,
      approvedCents,actorId,reviewerId).lastInsertRowid);
  const event = db.prepare(`INSERT INTO expense_claim_events
    (claim_id,action,from_status,to_status,version,details,actor_id) VALUES (?,?,?,?,?,?,?)`);
  event.run(claimId,'created',null,'draft',1,'Synthetic draft linked to the exact approved purchase invoice.',actorId);
  event.run(claimId,'submitted','draft','submitted',2,'Synthetic proof version 2 submitted for independent local review.',actorId);
  event.run(claimId,'approved','submitted','approved',3,'Independent local review of synthetic evidence; no bank or GST verification.',reviewerId);
  if (spec.paidBy === 'employee') {
    const allocationId = Number(db.prepare(`INSERT INTO employee_invoice_allocations
      (company_id,invoice_id,claim_id,amount_cents,allocated_by) VALUES (?,?,?,?,?)`)
      .run(source.company_id,source.id,claimId,approvedCents,reviewerId).lastInsertRowid);
    postInvoice(db,source.id);
    writeJournal(db,{
      companyId:source.company_id,gstinId:source.gstin_id,branchId:source.branch_id,partyId:source.party_id,
      partyName:source.party_name_snapshot,sourceType:'employee_expense_allocation',sourceId:allocationId,
      documentNumber:`EXP-${claimId}`,journalDate:day,
      description:`Synthetic employee payment allocated to supplier invoice ${source.number}; claim ${claimId}`,
    },[{code:'2100',debitCents:approvedCents,creditCents:0},{code:'2400',debitCents:0,creditCents:approvedCents}]);
  }
  return claimId;
}

function addReimbursement(db, source, claimId, spec, reviewerId, day) {
  if (!spec.reimbursement) return;
  const { amountCents, method, reference } = spec.reimbursement;
  const paymentId = Number(db.prepare(`INSERT INTO expense_reimbursements
    (company_id,claim_id,amount_cents,method,reference,payment_date,recorded_by)
    VALUES (?,?,?,?,?,?,?)`)
    .run(source.company_id,claimId,amountCents,method,reference,day,reviewerId).lastInsertRowid);
  writeJournal(db,{
    companyId:source.company_id,gstinId:source.gstin_id,branchId:source.branch_id,partyId:null,partyName:'',
    sourceType:'expense_reimbursement',sourceId:paymentId,documentNumber:reference,journalDate:day,
    description:`Synthetic partial employee reimbursement for expense claim ${claimId}; provider unconfirmed`,
  },[{code:'2400',debitCents:amountCents,creditCents:0},{code:'1100',debitCents:0,creditCents:amountCents}]);
}

function seedExpensesDemo(db) {
  const company = db.prepare("SELECT id FROM companies WHERE name='Aster Medical Supplies Pvt Ltd (Demo)'").get();
  if (!company) return { created:0, skipped:SPECS.length };
  const actors = db.prepare("SELECT id,role FROM users WHERE company_id=? AND name IN ('Maya Staff','Dev Accountant')").all(company.id);
  const actorId = actors.find(row => row.role === 'staff')?.id;
  const reviewerId = actors.find(row => row.role === 'accountant')?.id;
  if (!actorId || !reviewerId) throw new Error('Expense demo actors are missing');
  const day = new Date().toISOString().slice(0,10);
  let created = 0, skipped = 0;
  for (const spec of SPECS) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const source = db.prepare(`SELECT v.* FROM invoices v JOIN branches b ON b.id=v.branch_id
        WHERE v.company_id=? AND v.number=? AND v.type='purchase' AND v.status='approved' AND b.name=?`)
        .get(company.id,spec.invoiceNumber,spec.branchName);
      if (!source) { skipped++; db.exec('COMMIT'); continue; }
      if (db.prepare('SELECT id FROM expense_claims WHERE company_id=? AND invoice_id=?').get(company.id,source.id)) {
        skipped++; db.exec('COMMIT'); continue;
      }
      addCompanyPayment(db,source,spec,reviewerId,day);
      const proof = addProof(db,source,spec,actorId,reviewerId);
      const claimId = addClaim(db,source,spec,proof,actorId,reviewerId,day);
      addReimbursement(db,source,claimId,spec,reviewerId,day);
      db.exec('COMMIT');
      created++;
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  }
  return { created, skipped };
}

module.exports = { seedExpensesDemo };
