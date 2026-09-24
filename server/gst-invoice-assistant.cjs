const { createHash } = require('node:crypto');
const { assertScopeAccess } = require('./access.cjs');

const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const fields = row => row && Object.fromEntries(Object.entries(row).map(([key, value]) => [key.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase()), value]));
const integer = (value, name, min = 1, max = Number.MAX_SAFE_INTEGER) => {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw fail(`${name} must be an integer from ${min} to ${max}`);
  return value;
};
const words = (value, name, max = 500) => {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max) throw fail(`${name} must be 1 to ${max} characters`);
  return value.trim();
};
const day = (value, name) => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
      !Number.isFinite(Date.parse(`${value}T00:00:00Z`)) ||
      new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value) throw fail(`${name} must be a valid YYYY-MM-DD date`);
  return value;
};
const route = handler => (req, res, next) => { try { res.json(handler(req)); } catch (error) { next(error); } };
const atomic = (db, action) => {
  db.exec('BEGIN IMMEDIATE');
  try { const result = action(); db.exec('COMMIT'); return result; }
  catch (error) { db.exec('ROLLBACK'); throw error; }
};

function installGstInvoiceAssistantSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS gst_item_tax_policies (
      id INTEGER PRIMARY KEY,
      company_id INTEGER NOT NULL REFERENCES companies(id),
      item_id INTEGER NOT NULL REFERENCES items(id),
      hsn TEXT NOT NULL,
      rate_bps INTEGER NOT NULL CHECK(rate_bps BETWEEN 0 AND 10000),
      effective_from TEXT NOT NULL,
      effective_to TEXT,
      source_reference TEXT NOT NULL,
      reason TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected')),
      created_by INTEGER NOT NULL REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      reviewed_by INTEGER REFERENCES users(id),
      reviewed_at TEXT,
      review_reason TEXT NOT NULL DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS idx_gst_item_tax_policies ON gst_item_tax_policies(company_id,item_id,status,effective_from);
    CREATE TABLE IF NOT EXISTS gst_item_tax_policy_events (
      id INTEGER PRIMARY KEY,
      policy_id INTEGER NOT NULL REFERENCES gst_item_tax_policies(id),
      company_id INTEGER NOT NULL REFERENCES companies(id),
      action TEXT NOT NULL,
      reason TEXT NOT NULL,
      actor_id INTEGER NOT NULL REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS gst_invoice_check_reviews (
      id INTEGER PRIMARY KEY,
      invoice_id INTEGER NOT NULL REFERENCES invoices(id),
      company_id INTEGER NOT NULL REFERENCES companies(id),
      fingerprint TEXT NOT NULL,
      decision TEXT NOT NULL CHECK(decision IN ('accepted','rejected')),
      reason TEXT NOT NULL,
      actor_id INTEGER NOT NULL REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_gst_invoice_check_reviews ON gst_invoice_check_reviews(invoice_id,fingerprint,id);
  `);
}

function invoiceSource(db, companyId, invoiceId) {
  const invoice = db.prepare(`SELECT v.*,g.gstin AS issuer_gstin,g.state_code AS issuer_state_code,
    p.state_code AS party_state_code,p.address AS party_address,p.gstin AS current_party_gstin,
    COALESCE(NULLIF(v.party_name_snapshot,''),p.name) AS party_name
    FROM invoices v JOIN gstins g ON g.id=v.gstin_id AND g.company_id=v.company_id
    JOIN parties p ON p.id=v.party_id AND p.company_id=v.company_id
    WHERE v.id=? AND v.company_id=?`).get(invoiceId,companyId);
  if (!invoice) throw fail('Invoice not found in selected company',404);
  const lines = db.prepare(`SELECT l.*,i.sku AS current_sku,i.name AS current_item_name,i.hsn AS current_hsn
    FROM invoice_lines l JOIN items i ON i.id=l.item_id AND i.company_id=?
    WHERE l.invoice_id=? ORDER BY l.id`).all(companyId,invoiceId);
  return { invoice, lines };
}

function effectivePolicy(db, companyId, itemId, invoiceDate) {
  return db.prepare(`SELECT * FROM gst_item_tax_policies WHERE company_id=? AND item_id=? AND status='approved'
    AND effective_from<=? AND (effective_to IS NULL OR effective_to>=?)
    ORDER BY effective_from DESC,id DESC LIMIT 1`).get(companyId,itemId,invoiceDate,invoiceDate) || null;
}

function assessInvoice(db, { companyId, invoiceId }) {
  const { invoice, lines } = invoiceSource(db,companyId,invoiceId);
  const findings = [];
  const add = (severity,code,message,lineId) => findings.push({ severity,code,message,...(lineId ? {lineId} : {}) });
  if (!invoice.number?.trim()) add('blocker','INVOICE_NUMBER_MISSING','Invoice number is missing.');
  if (!invoice.invoice_date?.trim()) add('blocker','INVOICE_DATE_MISSING','Invoice date is missing.');
  if (!invoice.party_name?.trim()) add('blocker','PARTY_NAME_MISSING','Counterparty name is missing.');
  if (!invoice.issuer_gstin?.trim()) add('blocker','ISSUER_GSTIN_MISSING','Issuer GSTIN is missing.');
  if (!lines.length) add('blocker','NO_LINES','Invoice has no item lines.');
  if (invoice.type === 'purchase' && !invoice.supplier_invoice_number?.trim()) add('warning','SUPPLIER_REFERENCE_MISSING','Supplier invoice reference is missing.');
  if (invoice.type === 'purchase' && !invoice.supplier_gstin_snapshot?.trim()) add('warning','SUPPLIER_GSTIN_MISSING','Supplier GSTIN is missing; check whether this purchase is registered and what evidence is required.');
  if (invoice.type === 'sale' && !invoice.supplier_gstin_snapshot?.trim()) add('info','CUSTOMER_GSTIN_NOT_RECORDED','Customer GSTIN is not recorded; review the B2C/B2B treatment.');
  if (!/^\d{2}$/.test(invoice.party_state_code || '')) add('warning','PARTY_STATE_MISSING','Counterparty state code is missing; place-of-supply and tax-head treatment need review.');
  if (!invoice.party_address?.trim()) add('warning','PARTY_ADDRESS_MISSING','Counterparty address is missing from the current master.');

  const checkedLines = lines.map(line => {
    const policy = effectivePolicy(db,companyId,line.item_id,invoice.invoice_date);
    const hsn = line.item_hsn_snapshot || '';
    const label = line.item_name_snapshot || line.current_item_name || `Line ${line.id}`;
    if (!hsn.trim()) add('warning','HSN_MISSING',`${label}: HSN/SAC is missing.`,line.id);
    if (!policy) add('warning','NO_REVIEWED_POLICY',`${label}: no internally reviewed tax policy covers this invoice date.`,line.id);
    else {
      if (line.gst_rate_bps !== policy.rate_bps) add('blocker','RATE_POLICY_MISMATCH',`${label}: invoice rate ${line.gst_rate_bps} bps differs from internally reviewed policy ${policy.rate_bps} bps.`,line.id);
      if (hsn.trim() !== policy.hsn) add('blocker','HSN_POLICY_MISMATCH',`${label}: invoice HSN/SAC differs from the internally reviewed policy.`,line.id);
    }
    const subtotal = line.quantity * line.unit_price_cents;
    const tax = Math.round(subtotal * line.gst_rate_bps / 10000);
    if (!Number.isSafeInteger(subtotal) || subtotal !== line.subtotal_cents || tax !== line.tax_cents || subtotal + tax !== line.total_cents) {
      add('blocker','LINE_ARITHMETIC_MISMATCH',`${label}: saved line totals do not match quantity, price, and entered rate.`,line.id);
    }
    return { ...fields(line), itemName:label, sku:line.item_sku_snapshot || line.current_sku, hsn, policy:policy ? fields(policy) : null };
  });
  const subtotal = lines.reduce((sum,line) => sum + line.subtotal_cents,0);
  const tax = lines.reduce((sum,line) => sum + line.tax_cents,0);
  if (!Number.isSafeInteger(subtotal) || !Number.isSafeInteger(tax) || subtotal !== invoice.subtotal_cents || tax !== invoice.tax_cents || subtotal + tax !== invoice.total_cents) {
    add('blocker','INVOICE_ARITHMETIC_MISMATCH','Saved invoice totals do not match its lines.');
  }
  const fingerprint = createHash('sha256').update(JSON.stringify({
    invoice:[invoice.id,invoice.company_id,invoice.gstin_id,invoice.branch_id,invoice.party_id,invoice.number,invoice.type,invoice.invoice_date,invoice.party_name_snapshot,invoice.supplier_gstin_snapshot,invoice.supplier_invoice_number,invoice.subtotal_cents,invoice.tax_cents,invoice.total_cents],
    lines:checkedLines.map(line => [line.id,line.itemId,line.itemSkuSnapshot,line.itemNameSnapshot,line.itemHsnSnapshot,line.quantity,line.unitPriceCents,line.gstRateBps,line.subtotalCents,line.taxCents,line.totalCents,line.policy?.id || null]),
  })).digest('hex');
  const latestReview = db.prepare('SELECT * FROM gst_invoice_check_reviews WHERE invoice_id=? AND company_id=? AND fingerprint=? ORDER BY id DESC LIMIT 1').get(invoiceId,companyId,fingerprint) || null;
  const reviews = db.prepare(`SELECT r.*,u.name AS reviewer_name FROM gst_invoice_check_reviews r
    JOIN users u ON u.id=r.actor_id AND u.company_id=r.company_id
    WHERE r.invoice_id=? AND r.company_id=? ORDER BY r.id DESC LIMIT 200`).all(invoiceId,companyId).map(fields);
  const blockers = findings.filter(row => row.severity === 'blocker').length;
  const warnings = findings.filter(row => row.severity === 'warning').length;
  const nonOverridable = findings.some(row => row.severity === 'blocker' && !['RATE_POLICY_MISMATCH','HSN_POLICY_MISMATCH'].includes(row.code));
  const acceptedOverride = blockers > 0 && !nonOverridable && latestReview?.decision === 'accepted' ? fields(latestReview) : null;
  return { invoice:fields(invoice),lines:checkedLines,findings,blockers,warnings,fingerprint,
    latestReview:fields(latestReview),reviews,acceptedOverride,approvalReady:Boolean(blockers === 0 || acceptedOverride),nonOverridable,
    basis:'Internal recorded fields and independently reviewed local policy only',officialRateVerification:false,officialFiling:false };
}

function assertInvoiceTaxReady(db, { companyId, invoiceId }) {
  const assessment = assessInvoice(db,{companyId,invoiceId});
  if (!assessment.approvalReady) throw fail('Invoice has unresolved GST invoice checks; review the invoice findings before approval',409);
  return assessment;
}

function seedGstInvoiceCheckDemo(db) {
  installGstInvoiceAssistantSchema(db);
  const item = db.prepare("SELECT id FROM items WHERE company_id=1 AND sku='CHD-01-01'").get();
  if (!item) return { seeded:false,reason:'Consumer health demo item is not installed' };
  const sourceReference = 'Internal demo assumption CHD-01-01';
  const existing = db.prepare('SELECT id FROM gst_item_tax_policies WHERE company_id=1 AND item_id=? AND source_reference=?').get(item.id,sourceReference);
  if (existing) return { seeded:false,policyId:existing.id };
  const result = db.prepare(`INSERT INTO gst_item_tax_policies(company_id,item_id,hsn,rate_bps,effective_from,effective_to,source_reference,reason,created_by)
    VALUES (1,?,'0000',1200,'2026-01-01',NULL,?,'Synthetic example awaiting independent review; not a legal rate determination',1)`)
    .run(item.id,sourceReference);
  const policyId = Number(result.lastInsertRowid);
  db.prepare("INSERT INTO gst_item_tax_policy_events(policy_id,company_id,action,reason,actor_id) VALUES (?,1,'proposed','Synthetic example awaiting independent review',1)").run(policyId);
  return { seeded:true,policyId };
}

function registerGstInvoiceAssistantRoutes(app, db) {
  installGstInvoiceAssistantSchema(db);
  const accountant = req => { if (!['accountant','admin'].includes(req.user.role)) throw fail('Accountant or admin role required',403); };
  const masterAccess = req => { if (!req.scopes.branchIds.length) throw fail('A branch grant is required for company tax policies',403); };
  const scopedInvoice = (req, value) => {
    const id = integer(Number(value),'invoiceId');
    const invoice = db.prepare('SELECT id,gstin_id,branch_id,created_by,submitted_by,status FROM invoices WHERE id=? AND company_id=?').get(id,req.company.id);
    if (!invoice) throw fail('Invoice not found in selected company',404);
    assertScopeAccess(db,{companyId:req.company.id,userId:req.user.id,gstinId:invoice.gstin_id,branchId:invoice.branch_id});
    return invoice;
  };
  const policy = (req,value) => {
    masterAccess(req);
    const row = db.prepare('SELECT * FROM gst_item_tax_policies WHERE id=? AND company_id=?').get(integer(Number(value),'policyId'),req.company.id);
    if (!row) throw fail('Tax policy not found in selected company',404);
    return row;
  };
  const policyDetail = row => ({ ...fields(row),...fields(db.prepare('SELECT name AS item_name,sku FROM items WHERE id=? AND company_id=?').get(row.item_id,row.company_id)),
    events:db.prepare('SELECT * FROM gst_item_tax_policy_events WHERE policy_id=? ORDER BY id').all(row.id).map(fields) });

  app.get('/api/gst-invoice-checks/policies',route(req => {
    masterAccess(req);
    const itemId = req.query.itemId ? integer(Number(req.query.itemId),'itemId') : null;
    const rows = db.prepare(`SELECT p.*,i.name AS item_name,i.sku FROM gst_item_tax_policies p
      JOIN items i ON i.id=p.item_id AND i.company_id=p.company_id
      WHERE p.company_id=? AND (? IS NULL OR p.item_id=?) ORDER BY p.id DESC LIMIT 300`).all(req.company.id,itemId,itemId);
    return { policies:rows.map(fields),officialRateVerification:false };
  }));
  app.post('/api/gst-invoice-checks/policies',route(req => atomic(db,() => {
    masterAccess(req);
    const body = req.body || {};
    const itemId = integer(body.itemId,'itemId');
    const item = db.prepare('SELECT * FROM items WHERE id=? AND company_id=?').get(itemId,req.company.id);
    if (!item) throw fail('Item not found in selected company',404);
    const hsn = words(body.hsn,'hsn',16);
    if (!/^[A-Za-z0-9.\-/]{2,16}$/.test(hsn)) throw fail('hsn must contain only letters, digits, dots, hyphens or slashes');
    const rateBps = integer(body.rateBps,'rateBps',0,10000);
    const effectiveFrom = day(body.effectiveFrom,'effectiveFrom');
    const effectiveTo = body.effectiveTo == null || body.effectiveTo === '' ? null : day(body.effectiveTo,'effectiveTo');
    if (effectiveTo && effectiveTo < effectiveFrom) throw fail('effectiveTo must be on or after effectiveFrom');
    const sourceReference = words(body.sourceReference,'sourceReference',300);
    const reason = words(body.reason,'reason',500);
    const result = db.prepare(`INSERT INTO gst_item_tax_policies(company_id,item_id,hsn,rate_bps,effective_from,effective_to,source_reference,reason,created_by)
      VALUES (?,?,?,?,?,?,?,?,?)`).run(req.company.id,itemId,hsn,rateBps,effectiveFrom,effectiveTo,sourceReference,reason,req.user.id);
    const id = Number(result.lastInsertRowid);
    db.prepare("INSERT INTO gst_item_tax_policy_events(policy_id,company_id,action,reason,actor_id) VALUES (?,?,'proposed',?,?)").run(id,req.company.id,reason,req.user.id);
    return { policy:policyDetail(policy(req,id)) };
  })));
  app.post('/api/gst-invoice-checks/policies/:id/review',route(req => atomic(db,() => {
    accountant(req);
    const row = policy(req,req.params.id);
    const decision = req.body?.decision;
    if (!['approved','rejected'].includes(decision)) throw fail('decision must be approved or rejected');
    const reason = words(req.body?.reason,'reason',500);
    if (row.status !== 'pending') throw fail('Tax policy review is final',409);
    if (row.created_by === req.user.id) throw fail('A different accountant must review the tax policy',403);
    if (decision === 'approved') {
      const overlap = db.prepare(`SELECT id FROM gst_item_tax_policies WHERE company_id=? AND item_id=? AND status='approved'
        AND effective_from<=COALESCE(?, '9999-12-31') AND COALESCE(effective_to,'9999-12-31')>=? LIMIT 1`)
        .get(row.company_id,row.item_id,row.effective_to,row.effective_from);
      if (overlap) throw fail('Approved tax policy dates overlap an existing approved policy',409);
    }
    db.prepare('UPDATE gst_item_tax_policies SET status=?,review_reason=?,reviewed_by=?,reviewed_at=CURRENT_TIMESTAMP WHERE id=?')
      .run(decision,reason,req.user.id,row.id);
    db.prepare('INSERT INTO gst_item_tax_policy_events(policy_id,company_id,action,reason,actor_id) VALUES (?,?,?,?,?)')
      .run(row.id,req.company.id,decision,reason,req.user.id);
    return { policy:policyDetail(policy(req,row.id)) };
  })));
  app.get('/api/gst-invoice-checks/invoices/:id',route(req => {
    const invoice = scopedInvoice(req,req.params.id);
    return { assessment:assessInvoice(db,{companyId:req.company.id,invoiceId:invoice.id}) };
  }));
  app.post('/api/gst-invoice-checks/invoices/:id/reviews',route(req => atomic(db,() => {
    accountant(req);
    const invoice = scopedInvoice(req,req.params.id);
    if (invoice.status !== 'submitted') throw fail('Only submitted invoices can receive an invoice check decision',409);
    if (invoice.created_by === req.user.id || invoice.submitted_by === req.user.id) throw fail('A different accountant must review the invoice checks',403);
    const decision = req.body?.decision;
    if (!['accepted','rejected'].includes(decision)) throw fail('decision must be accepted or rejected');
    const reason = words(req.body?.reason,'reason',500);
    const assessment = assessInvoice(db,{companyId:req.company.id,invoiceId:invoice.id});
    if (!assessment.blockers) throw fail('Invoice has no blocking findings to review',409);
    if (decision === 'accepted' && assessment.nonOverridable) throw fail('Missing invoice fields or arithmetic discrepancies must be corrected before approval',409);
    const result = db.prepare('INSERT INTO gst_invoice_check_reviews(invoice_id,company_id,fingerprint,decision,reason,actor_id) VALUES (?,?,?,?,?,?)')
      .run(invoice.id,req.company.id,assessment.fingerprint,decision,reason,req.user.id);
    const review = db.prepare('SELECT * FROM gst_invoice_check_reviews WHERE id=?').get(Number(result.lastInsertRowid));
    return { review:fields(review),assessment:assessInvoice(db,{companyId:req.company.id,invoiceId:invoice.id}) };
  })));
}

module.exports = { installGstInvoiceAssistantSchema,registerGstInvoiceAssistantRoutes,assessInvoice,assertInvoiceTaxReady,seedGstInvoiceCheckDemo };
