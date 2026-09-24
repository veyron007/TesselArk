const fail = (message,status=400) => Object.assign(new Error(message),{ status });
const { allowedScopes, assertBranchAccess, assertGstinAccess, assertCompanyWideAccess } = require('./access.cjs');
const camel = row => Object.fromEntries(Object.entries(row).map(([key,value]) => [key.replace(/_([a-z])/g,(_,letter) => letter.toUpperCase()),value]));
const date = (value,label) => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw fail(`${label} must be a valid YYYY-MM-DD date`);
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0,10) !== value) throw fail(`${label} must be a valid YYYY-MM-DD date`);
  return value;
};
const id = (value,label) => {
  if (value === undefined || value === '') return null;
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 1) throw fail(`${label} must be a positive integer`);
  return result;
};
const sum = (rows,predicate,field) => rows.filter(predicate).reduce((total,row) => total + row[field],0);

function registerReportingRoutes(app,db) {
  const route = handler => (req,res,next) => { try { res.json(handler(req)); } catch (error) { next(error); } };
  app.get('/api/reports/operations',route(req => {
    const from = date(req.query.from,'from');
    const to = date(req.query.to,'to');
    if (from > to) throw fail('from must be on or before to');
    const companyId = req.company.id;
    const gstinId = id(req.query.gstinId,'gstinId');
    const branchId = id(req.query.branchId,'branchId');
    const gstin = gstinId === null ? null : db.prepare('SELECT id,gstin FROM gstins WHERE id=? AND company_id=?').get(gstinId,companyId);
    if (gstinId !== null && !gstin) throw fail('GSTIN not found in selected company',404);
    const branch = branchId === null ? null : db.prepare('SELECT id,name,gstin_id FROM branches WHERE id=? AND company_id=?').get(branchId,companyId);
    if (branchId !== null && !branch) throw fail('Branch not found in selected company',404);
    if (branch && gstin && branch.gstin_id !== gstinId) throw fail('Branch does not belong to selected GSTIN');
    const effectiveGstin = gstinId ?? branch?.gstin_id ?? null;
    const userScope = allowedScopes(db,{companyId,userId:req.user.id});
    if (branchId !== null) assertBranchAccess(db,{companyId,userId:req.user.id,branchId});
    else if (effectiveGstin !== null) assertGstinAccess(db,{companyId,userId:req.user.id,gstinId:effectiveGstin});
    else assertCompanyWideAccess(db,{companyId,userId:req.user.id});
    const gstinBranches = effectiveGstin === null ? [] : db.prepare('SELECT id FROM branches WHERE company_id=? AND gstin_id=?').all(companyId,effectiveGstin);
    const completeGstin = effectiveGstin === null || gstinBranches.every(row => userScope.branchIds.includes(row.id));
    if (branchId === null && !completeGstin) throw fail('Full GSTIN branch scope is required for an unfiltered GSTIN report',403);
    const scope = [companyId,effectiveGstin,effectiveGstin,branchId,branchId];

    const invoices = db.prepare(`SELECT i.id,i.company_id,i.gstin_id,i.branch_id,i.number,i.type,i.status,i.invoice_date,
      i.subtotal_cents,i.tax_cents,i.total_cents,COALESCE(NULLIF(i.party_name_snapshot,''),p.name) AS party_name,
      b.name AS branch_name,g.gstin
      FROM invoices i JOIN parties p ON p.id=i.party_id JOIN branches b ON b.id=i.branch_id JOIN gstins g ON g.id=i.gstin_id
      WHERE i.company_id=? AND (? IS NULL OR i.gstin_id=?) AND (? IS NULL OR i.branch_id=?)
        AND i.invoice_date BETWEEN ? AND ? ORDER BY i.invoice_date DESC,i.id DESC`).all(...scope,from,to).map(camel);
    const payments = db.prepare(`SELECT pay.id,pay.company_id,i.gstin_id,i.branch_id,pay.invoice_id,
      i.number AS invoice_number,i.type AS invoice_type,pay.amount_cents,pay.method,pay.reference,pay.payment_date,
      b.name AS branch_name,g.gstin
      FROM invoice_payments pay JOIN invoices i ON i.id=pay.invoice_id AND i.company_id=pay.company_id
      JOIN branches b ON b.id=i.branch_id JOIN gstins g ON g.id=i.gstin_id
      WHERE pay.company_id=? AND (? IS NULL OR i.gstin_id=?) AND (? IS NULL OR i.branch_id=?)
        AND pay.payment_date BETWEEN ? AND ? ORDER BY pay.payment_date DESC,pay.id DESC`).all(...scope,from,to).map(camel);
    const returns = db.prepare(`SELECT r.id,r.company_id,i.gstin_id,i.branch_id,r.invoice_id,r.number,r.kind,r.status,
      r.subtotal_cents,r.tax_proposal_cents,r.total_proposal_cents,r.created_at,r.approved_at,
      COALESCE(q.decision,'unreviewed') AS tax_review_decision,q.period AS tax_review_period,
      i.number AS invoice_number,b.name AS branch_name,g.gstin
      FROM returns r JOIN invoices i ON i.id=r.invoice_id AND i.company_id=r.company_id
      JOIN branches b ON b.id=i.branch_id JOIN gstins g ON g.id=i.gstin_id
      LEFT JOIN return_tax_reviews q ON q.return_id=r.id AND q.company_id=r.company_id
      WHERE r.company_id=? AND (? IS NULL OR i.gstin_id=?) AND (? IS NULL OR i.branch_id=?)
        AND substr(r.created_at,1,10) BETWEEN ? AND ? ORDER BY r.created_at DESC,r.id DESC`).all(...scope,from,to).map(camel);
    const gstPeriods = completeGstin ? db.prepare(`SELECT p.id,p.company_id,p.gstin_id,p.period,p.status,p.review_notes,g.gstin
      FROM gst_periods p JOIN gstins g ON g.id=p.gstin_id
      WHERE p.company_id=? AND (? IS NULL OR p.gstin_id=?) AND p.period BETWEEN ? AND ?
      ORDER BY p.period DESC,p.id DESC`).all(companyId,effectiveGstin,effectiveGstin,from.slice(0,7),to.slice(0,7)).map(row => ({...camel(row),scopeBasis:'GSTIN'})) : [];
    const generatedAt = new Date().toISOString();
    return {
      generatedAt,currency:'INR',scope:{ companyId,companyName:req.company.name,gstinId:effectiveGstin,
        gstin:gstin?.gstin ?? (branch ? db.prepare('SELECT gstin FROM gstins WHERE id=?').get(branch.gstin_id).gstin : null),
        branchId,branchName:branch?.name ?? null,from,to,invoiceBasis:'invoice date',paymentBasis:'payment date',returnBasis:'return creation date',gstBasis:'GST period month; GSTIN wide' },
      metrics:{ approvedSalesCents:sum(invoices,row => row.type === 'sale' && row.status === 'approved','totalCents'),
        approvedPurchasesCents:sum(invoices,row => row.type === 'purchase' && row.status === 'approved','totalCents'),
        paymentReceiptsCents:sum(payments,row => row.invoiceType === 'sale','amountCents'),
        paymentDisbursementsCents:sum(payments,row => row.invoiceType === 'purchase','amountCents'),
        returnProposalCents:sum(returns,() => true,'totalProposalCents'),
        invoiceCount:invoices.length,paymentCount:payments.length,returnCount:returns.length,gstPeriodCount:gstPeriods.length },
      invoices,payments,returns,gstPeriods,
      notes:['Amounts are separate source measures. Return tax amounts are proposals, not posted GST adjustments.',
        'Payments are recorded allocations, not bank verified settlements.',
        'GST period statuses are internal review states, not official filing evidence.',
        completeGstin ? 'GST periods are GSTIN wide, even when a branch filter is selected.' : 'GST periods are hidden because this user does not have every branch in the GSTIN.'],
    };
  }));
}

module.exports = { registerReportingRoutes };
