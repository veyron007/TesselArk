const { installReturnTaxSchema } = require('./return-tax-db.cjs');
const { allowedScopes, assertScopeAccess, assertGstinAccess } = require('./access.cjs');

const bad = (message, status = 400) => Object.assign(new Error(message), { status });
const camel = row => row && Object.fromEntries(Object.entries(row).map(([key, value]) => [key.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase()), value]));
const positive = (value, name) => {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) throw bad(`${name} must be a positive integer`);
  return number;
};
const month = value => {
  if (typeof value !== 'string' || !/^\d{4}-(0[1-9]|1[0-2])$/.test(value)) throw bad('period must be YYYY-MM');
  return value;
};
const optional = (value, name) => value === undefined || value === '' ? null : positive(value, name);
const route = handler => (req, res, next) => { try { res.json(handler(req)); } catch (error) { next(error); } };

function registerReturnTaxRoutes(app, db) {
  installReturnTaxSchema(db);
  const scope = (req,row) => assertScopeAccess(db,{companyId:req.company.id,userId:req.user.id,gstinId:row.gstin_id,branchId:row.branch_id});
  const visible = req => (req.scopes || allowedScopes(db,{companyId:req.company.id,userId:req.user.id})).branchIds;
  const companyRow = (table, id, companyId) => {
    if (id && !db.prepare(`SELECT 1 FROM ${table} WHERE id=? AND company_id=?`).get(id, companyId)) throw bad(`${table} not found in selected company`, 404);
  };
  const returnRow = (id, companyId) => {
    const row = db.prepare(`SELECT r.*,v.number AS invoice_number,v.type AS invoice_type,v.status AS invoice_status,v.invoice_date,v.branch_id,v.gstin_id,v.tax_cents AS invoice_tax_cents,
      COALESCE(NULLIF(v.party_name_snapshot,''),p.name) AS party_name,g.gstin,b.name AS branch_name,
      q.period AS review_period,q.decision AS review_decision,q.reason AS review_reason,q.decided_by,q.decided_at,
      u.name AS reviewer_name
      FROM returns r JOIN invoices v ON v.id=r.invoice_id JOIN parties p ON p.id=v.party_id
      JOIN gstins g ON g.id=v.gstin_id JOIN branches b ON b.id=v.branch_id
      LEFT JOIN return_tax_reviews q ON q.return_id=r.id LEFT JOIN users u ON u.id=q.decided_by
      WHERE r.id=? AND r.company_id=? AND v.company_id=?`).get(id, companyId, companyId);
    if (!row) throw bad('Return not found in selected company', 404);
    return row;
  };
  const detail = (id, companyId) => {
    const row = returnRow(id, companyId);
    const lines = db.prepare(`SELECT l.*,i.name AS item_name,il.quantity AS source_quantity,il.tax_cents AS source_tax_cents
      FROM return_lines l JOIN invoice_lines il ON il.id=l.invoice_line_id AND il.invoice_id=?
      JOIN items i ON i.id=l.item_id AND i.company_id=? WHERE l.return_id=? ORDER BY l.id`).all(row.invoice_id, companyId, id);
    const events = db.prepare(`SELECT e.*,u.name AS reviewer_name FROM return_tax_review_events e JOIN users u ON u.id=e.decided_by
      WHERE e.return_id=? AND e.company_id=? ORDER BY e.id`).all(id, companyId).map(camel);
    return { ...camel(row), lines:lines.map(camel), events, localPreviewOnly:true };
  };
  const validateSource = row => {
    if (row.status !== 'approved' || row.invoice_status !== 'approved') throw bad('Approved return and source invoice required', 409);
    if ((row.invoice_type === 'sale' ? 'sales_return' : 'purchase_return') !== row.kind) throw bad('Return kind does not match source invoice', 409);
    const lines = db.prepare(`SELECT l.*,il.invoice_id,il.quantity AS source_quantity,il.tax_cents AS source_tax_cents
      FROM return_lines l JOIN invoice_lines il ON il.id=l.invoice_line_id WHERE l.return_id=?`).all(row.id);
    if (!lines.length || lines.some(line => line.invoice_id !== row.invoice_id || line.quantity > line.source_quantity || line.tax_proposal_cents > line.source_tax_cents || line.tax_proposal_cents < 0)) throw bad('Return lines do not reconcile to source invoice', 409);
    const amount = lines.reduce((sum, line) => sum + line.tax_proposal_cents, 0);
    if (!Number.isSafeInteger(amount) || amount !== row.tax_proposal_cents || amount > row.invoice_tax_cents) throw bad('Return tax proposal does not reconcile', 409);
    return amount;
  };
  const preview = (companyId, gstinId, period) => {
    const rows = db.prepare(`SELECT r.id,r.number,r.kind,r.invoice_id,r.tax_proposal_cents,q.tax_cents
      FROM return_tax_reviews q JOIN returns r ON r.id=q.return_id AND r.company_id=q.company_id
      JOIN invoices v ON v.id=r.invoice_id AND v.company_id=r.company_id
      WHERE q.company_id=? AND q.gstin_id=? AND q.period=? AND q.decision='eligible'
      AND r.status='approved' AND v.status='approved' AND v.gstin_id=q.gstin_id ORDER BY r.id`).all(companyId, gstinId, period);
    const salesCreditTaxCents = rows.filter(row => row.kind === 'sales_return').reduce((sum, row) => sum + row.tax_cents, 0);
    const purchaseDebitTaxCents = rows.filter(row => row.kind === 'purchase_return').reduce((sum, row) => sum + row.tax_cents, 0);
    const gst = db.prepare('SELECT status FROM gst_periods WHERE company_id=? AND gstin_id=? AND period=?').get(companyId, gstinId, period);
    return { companyId, gstinId, period, periodStatus:gst?.status ?? 'not_created', localPreviewOnly:true,
      excludedFromRecordedGstTotals:true, salesCreditTaxCents, purchaseDebitTaxCents,
      indicativeNetAdjustmentCents:purchaseDebitTaxCents-salesCreditTaxCents,
      documentCount:rows.length, documents:rows.map(camel),
      note:'Local reviewed return-note arithmetic only. Recorded GST period totals, filing, and eligible ITC are unchanged.' };
  };

  app.get('/api/return-tax/reviews', route(req => {
    const companyId = req.company.id, gstinId = optional(req.query.gstinId,'gstinId'), branchId = optional(req.query.branchId,'branchId');
    const period = req.query.period === undefined || req.query.period === '' ? null : month(req.query.period);
    companyRow('gstins', gstinId, companyId); companyRow('branches', branchId, companyId);
    if (gstinId) assertGstinAccess(db,{companyId,userId:req.user.id,gstinId});
    if (branchId) scope(req,{gstin_id:gstinId ?? undefined,branch_id:branchId});
    const branches=visible(req);
    const rows = db.prepare(`SELECT r.id FROM returns r JOIN invoices v ON v.id=r.invoice_id AND v.company_id=r.company_id
      LEFT JOIN return_tax_reviews q ON q.return_id=r.id WHERE r.company_id=? AND v.branch_id IN (${branches.map(()=>'?').join(',') || 'NULL'}) AND (? IS NULL OR v.gstin_id=?)
      AND (? IS NULL OR v.branch_id=?) AND (? IS NULL OR q.period=? OR (q.period IS NULL AND substr(r.approved_at,1,7)=?))
      ORDER BY CASE WHEN q.decision IS NULL THEN 0 ELSE 1 END,r.id DESC`).all(companyId,...branches,gstinId,gstinId,branchId,branchId,period,period,period);
    return { reviews:rows.map(row => detail(row.id,companyId)), localPreviewOnly:true };
  }));

  app.get('/api/return-tax/reviews/:returnId', route(req => { const id=positive(req.params.returnId,'returnId'); const row=returnRow(id,req.company.id); scope(req,row); return { review:detail(id,req.company.id) }; }));

  app.post('/api/return-tax/reviews/:returnId/decision', route(req => {
    if (!['accountant','admin'].includes(req.user.role)) throw bad('Accountant or admin role required', 403);
    const id = positive(req.params.returnId,'returnId'), body = req.body || {};
    if (!['eligible','rejected','deferred'].includes(body.decision)) throw bad('decision must be eligible, rejected, or deferred');
    const period = month(body.period);
    if (typeof body.reason !== 'string' || !body.reason.trim() || body.reason.length > 1000) throw bad('Reason is required (maximum 1000 characters)');
    const reason = body.reason.trim();
    db.exec('BEGIN IMMEDIATE');
    try {
      const row = returnRow(id, req.company.id), amount = validateSource(row);
      scope(req,row);
      const periodRow = db.prepare('SELECT * FROM gst_periods WHERE company_id=? AND gstin_id=? AND period=?').get(req.company.id,row.gstin_id,period);
      if (!periodRow) throw bad('Selected GSTIN period does not exist locally', 404);
      const current = db.prepare('SELECT * FROM return_tax_reviews WHERE return_id=? AND company_id=?').get(id,req.company.id);
      const same = current && current.decision === body.decision && current.period === period && current.reason === reason;
      if (same) { db.exec('COMMIT'); return { review:detail(id,req.company.id), replayed:true }; }
      if (body.decision === 'eligible' && periodRow.status !== 'open') throw bad('Only an open local period can receive an eligible review', 409);
      if (current && current.decision !== 'deferred') throw bad('Final tax review cannot be changed; create a separate correction workflow', 409);
      const values = [req.company.id,row.gstin_id,period,body.decision,reason,amount,req.user.id];
      if (current) db.prepare(`UPDATE return_tax_reviews SET company_id=?,gstin_id=?,period=?,decision=?,reason=?,tax_cents=?,decided_by=?,decided_at=CURRENT_TIMESTAMP WHERE return_id=?`).run(...values,id);
      else db.prepare(`INSERT INTO return_tax_reviews(return_id,company_id,gstin_id,period,decision,reason,tax_cents,decided_by) VALUES (?,?,?,?,?,?,?,?)`).run(id,...values);
      db.prepare(`INSERT INTO return_tax_review_events(return_id,company_id,gstin_id,period,decision,reason,tax_cents,decided_by) VALUES (?,?,?,?,?,?,?,?)`).run(id,...values);
      db.exec('COMMIT');
      return { review:detail(id,req.company.id), replayed:false };
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  }));

  app.get('/api/return-tax/preview', route(req => {
    const gstinId = positive(req.query.gstinId,'gstinId'), period = month(req.query.period);
    companyRow('gstins',gstinId,req.company.id);
    assertGstinAccess(db,{companyId:req.company.id,userId:req.user.id,gstinId});
    const branches=db.prepare('SELECT id FROM branches WHERE company_id=? AND gstin_id=?').all(req.company.id,gstinId).map(row=>row.id);
    const granted=new Set(visible(req));
    if (branches.some(id=>!granted.has(id))) throw bad('All branches in GSTIN scope are required for period preview',403);
    return { preview:preview(req.company.id,gstinId,period) };
  }));
}

module.exports = { registerReturnTaxRoutes };
