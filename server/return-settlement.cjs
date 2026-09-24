const { installReturnSettlementSchema } = require('./return-settlement-db.cjs');
const { writeJournal } = require('./ledger.cjs');
const { allowedScopes, assertScopeAccess } = require('./access.cjs');

const fail = (message,status=400) => Object.assign(new Error(message),{ status });
const camel = row => row && Object.fromEntries(Object.entries(row).map(([key,value])=>[key.replace(/_([a-z])/g,(_,letter)=>letter.toUpperCase()),value]));
const positive = (value,label) => {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) throw fail(`${label} must be a positive integer`);
  return number;
};
const date = value => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw fail('settlementDate must be YYYY-MM-DD');
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0,10) !== value) throw fail('settlementDate must be a valid YYYY-MM-DD date');
  return value;
};
const checked = (value,label) => {
  if (!Number.isSafeInteger(value) || value < 0) throw fail(`${label} must be nonnegative integer paise`,409);
  return value;
};

function invoiceSettlementBalance(db,invoiceId,companyId) {
  const id = positive(invoiceId,'invoiceId');
  const invoice = db.prepare('SELECT id,company_id,total_cents,subtotal_cents,status FROM invoices WHERE id=? AND company_id=?').get(id,companyId);
  if (!invoice) throw fail('Invoice not found in selected company',404);
  const paidCents = db.prepare('SELECT COALESCE(SUM(amount_cents),0) AS cents FROM invoice_payments WHERE company_id=? AND invoice_id=?').get(companyId,id).cents;
  const totals = db.prepare(`SELECT COALESCE(SUM(amount_cents),0) AS amount_cents,
    COALESCE(SUM(tax_proposal_cents),0) AS tax_proposal_cents
    FROM return_settlements WHERE company_id=? AND invoice_id=?`).get(companyId,id);
  const commercialAdjustmentCents = checked(totals.amount_cents,'commercialAdjustmentCents');
  const adjustedTotalCents = checked(invoice.total_cents,'totalCents')-commercialAdjustmentCents;
  if (!Number.isSafeInteger(adjustedTotalCents) || adjustedTotalCents < 0) throw fail('Commercial adjustments exceed source invoice total',409);
  const difference = adjustedTotalCents-checked(paidCents,'paidCents');
  return {
    invoiceId:id,totalCents:invoice.total_cents,paidCents,
    commercialAdjustmentCents,adjustedTotalCents,
    outstandingCents:Math.max(0,difference),refundableCents:Math.max(0,-difference),
    pendingTaxProposalCents:checked(totals.tax_proposal_cents,'taxProposalCents'),
  };
}

function sourceReturn(db,returnId,companyId) {
  const row = db.prepare(`SELECT r.*,v.status AS invoice_status,v.type AS invoice_type,
    v.number AS invoice_number,v.invoice_date,v.total_cents AS invoice_total_cents,
    v.subtotal_cents AS invoice_subtotal_cents,v.branch_id,v.gstin_id,v.party_id,
    COALESCE(NULLIF(v.party_name_snapshot,''),p.name) AS party_name
    FROM returns r JOIN invoices v ON v.id=r.invoice_id AND v.company_id=r.company_id
    JOIN parties p ON p.id=v.party_id AND p.company_id=v.company_id
    WHERE r.id=? AND r.company_id=?`).get(returnId,companyId);
  if (!row) throw fail('Return not found in selected company',404);
  if (row.status !== 'approved' || row.invoice_status !== 'approved') throw fail('Approved return and source invoice required',409);
  if ((row.invoice_type === 'sale' ? 'sales_return' : 'purchase_return') !== row.kind) throw fail('Return kind does not match source invoice',409);
  const totals = db.prepare(`SELECT COUNT(*) AS line_count,
    COALESCE(SUM(l.subtotal_cents),0) AS subtotal_cents,
    COALESCE(SUM(l.tax_proposal_cents),0) AS tax_cents,
    COALESCE(SUM(CASE WHEN il.invoice_id<>? OR il.item_id<>l.item_id OR l.quantity>il.quantity OR l.quantity<1 THEN 1 ELSE 0 END),0) AS invalid_lines
    FROM return_lines l JOIN invoice_lines il ON il.id=l.invoice_line_id
    WHERE l.return_id=?`).get(row.invoice_id,returnId);
  if (!totals.line_count || totals.invalid_lines || totals.subtotal_cents !== row.subtotal_cents || totals.tax_cents !== row.tax_proposal_cents || row.total_proposal_cents !== row.subtotal_cents+row.tax_proposal_cents) throw fail('Return amounts or source lines do not reconcile',409);
  if (checked(row.subtotal_cents,'subtotalCents') === 0) throw fail('Zero-value return has no commercial amount to settle',409);
  checked(row.tax_proposal_cents,'taxProposalCents');
  if (row.subtotal_cents > row.invoice_subtotal_cents) throw fail('Return exceeds source invoice subtotal',409);
  return row;
}

function settlementDetail(db,id,companyId) {
  const row = db.prepare(`SELECT s.*,r.number AS return_number,r.kind,v.number AS invoice_number,
    v.type AS invoice_type,v.branch_id,v.gstin_id,v.party_id,
    COALESCE(NULLIF(v.party_name_snapshot,''),p.name) AS party_name,
    j.id AS journal_id
    FROM return_settlements s JOIN returns r ON r.id=s.return_id
    JOIN invoices v ON v.id=s.invoice_id JOIN parties p ON p.id=v.party_id
    LEFT JOIN journals j ON j.company_id=s.company_id AND j.source_type='return_settlement' AND j.source_id=s.return_id
    WHERE s.id=? AND s.company_id=?`).get(id,companyId);
  if (!row) throw fail('Return settlement not found in selected company',404);
  return { ...camel(row),taxPostingStatus:'excluded_pending_review' };
}

function postReturnSettlement(db,returnId,settlementDate,companyId,userId) {
  installReturnSettlementSchema(db);
  const id = positive(returnId,'returnId'), day = date(settlementDate);
  const existing = db.prepare('SELECT id,settlement_date FROM return_settlements WHERE company_id=? AND return_id=?').get(companyId,id);
  if (existing) {
    if (existing.settlement_date !== day) throw fail('Return already settled on a different date',409);
    return { settlement:settlementDetail(db,existing.id,companyId),balance:invoiceSettlementBalance(db,db.prepare('SELECT invoice_id FROM return_settlements WHERE id=?').get(existing.id).invoice_id,companyId),alreadySettled:true };
  }
  const source = sourceReturn(db,id,companyId);
  if (day < source.invoice_date) throw fail('Settlement date cannot precede source invoice date',409);
  const balance = invoiceSettlementBalance(db,source.invoice_id,companyId);
  if (source.subtotal_cents > source.invoice_subtotal_cents-balance.commercialAdjustmentCents) throw fail('Cumulative commercial adjustments exceed source invoice subtotal',409);
  const inserted = db.prepare(`INSERT INTO return_settlements(company_id,invoice_id,return_id,amount_cents,tax_proposal_cents,settlement_date,posted_by)
    VALUES (?,?,?,?,?,?,?)`).run(companyId,source.invoice_id,id,source.subtotal_cents,source.tax_proposal_cents,day,userId);
  const sale = source.invoice_type === 'sale';
  writeJournal(db,{
    companyId,gstinId:source.gstin_id,branchId:source.branch_id,partyId:source.party_id,
    partyName:source.party_name,sourceType:'return_settlement',sourceId:id,
    documentNumber:source.number,journalDate:day,
    description:`Commercial ${sale ? 'sales' : 'purchase'} return ${source.number}; tax proposal excluded`,
  },sale
    ? [{code:'4100',debitCents:source.subtotal_cents,creditCents:0},{code:'1200',debitCents:0,creditCents:source.subtotal_cents}]
    : [{code:'2100',debitCents:source.subtotal_cents,creditCents:0},{code:'5100',debitCents:0,creditCents:source.subtotal_cents}]);
  return { settlement:settlementDetail(db,Number(inserted.lastInsertRowid),companyId),balance:invoiceSettlementBalance(db,source.invoice_id,companyId),alreadySettled:false };
}

function registerReturnSettlementRoutes(app,db) {
  installReturnSettlementSchema(db);
  const route = handler => (req,res,next) => { try { res.json(handler(req)); } catch (error) { next(error); } };
  const invoiceScope = (req,id) => {
    const row=db.prepare('SELECT gstin_id,branch_id FROM invoices WHERE id=? AND company_id=?').get(id,req.company.id);
    if (!row) throw fail('Invoice not found in selected company',404);
    assertScopeAccess(db,{companyId:req.company.id,userId:req.user.id,gstinId:row.gstin_id,branchId:row.branch_id});
  };
  const settlementScope = (req,id) => {
    const row=db.prepare('SELECT invoice_id FROM return_settlements WHERE id=? AND company_id=?').get(id,req.company.id);
    if (!row) throw fail('Return settlement not found in selected company',404);
    invoiceScope(req,row.invoice_id);
  };
  app.get('/api/return-settlements/balance',route(req => { const id=positive(req.query.invoiceId,'invoiceId'); invoiceScope(req,id); return { balance:invoiceSettlementBalance(db,id,req.company.id) }; }));
  app.get('/api/return-settlements',route(req => {
    const invoiceId = req.query.invoiceId === undefined ? null : positive(req.query.invoiceId,'invoiceId');
    if (invoiceId) invoiceScope(req,invoiceId);
    const branches=(req.scopes || allowedScopes(db,{companyId:req.company.id,userId:req.user.id})).branchIds;
    const rows = db.prepare(`SELECT s.id FROM return_settlements s JOIN invoices v ON v.id=s.invoice_id
      WHERE s.company_id=? AND v.branch_id IN (${branches.map(()=>'?').join(',') || 'NULL'}) AND (? IS NULL OR s.invoice_id=?) ORDER BY s.settlement_date DESC,s.id DESC LIMIT 200`)
      .all(req.company.id,...branches,invoiceId,invoiceId);
    return { settlements:rows.map(row=>settlementDetail(db,row.id,req.company.id)) };
  }));
  app.get('/api/return-settlements/:id',route(req => { const id=positive(req.params.id,'id'); settlementScope(req,id); return { settlement:settlementDetail(db,id,req.company.id) }; }));
  app.post('/api/return-settlements',route(req => {
    if (!['accountant','admin'].includes(req.user.role)) throw fail('Accountant or admin role required',403);
    const body = req.body || {};
    const source=db.prepare('SELECT invoice_id FROM returns WHERE id=? AND company_id=?').get(positive(body.returnId,'returnId'),req.company.id);
    if (!source) throw fail('Return not found in selected company',404);
    invoiceScope(req,source.invoice_id);
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = postReturnSettlement(db,body.returnId,body.settlementDate,req.company.id,req.user.id);
      db.exec('COMMIT');
      return result;
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  }));
}

module.exports = { installReturnSettlementSchema, registerReturnSettlementRoutes, postReturnSettlement, invoiceSettlementBalance, settlementDetail };
