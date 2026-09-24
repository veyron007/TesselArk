const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const { postPayment } = require('./ledger.cjs');
const { invoiceSettlementBalance } = require('./return-settlement.cjs');
const { allowedScopes, assertBranchAccess } = require('./access.cjs');
const safeId = (value, label) => {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id < 1) throw fail(`${label} must be a positive integer`);
  return id;
};
const toCamel = row => Object.fromEntries(Object.entries(row).map(([key, value]) => [key.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase()), value]));
const validDate = value => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`)) || new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value) throw fail('paymentDate must be a valid YYYY-MM-DD date');
  return value;
};

function registerFinanceRoutes(app, db) {
  const route = handler => (req, res, next) => { try { res.json(handler(req)); } catch (error) { next(error); } };
  const invoiceById = (id, companyId) => {
    const invoice = db.prepare(`SELECT v.*,COALESCE(NULLIF(v.party_name_snapshot,''),p.name) AS party_name,b.name AS branch_name,g.gstin FROM invoices v JOIN parties p ON p.id=v.party_id JOIN branches b ON b.id=v.branch_id JOIN gstins g ON g.id=v.gstin_id WHERE v.id=? AND v.company_id=?`).get(id, companyId);
    if (!invoice) throw fail('Invoice not found in selected company', 404);
    return invoice;
  };
  const invoiceBalance = invoice => {
    const balance = invoiceSettlementBalance(db, invoice.id, invoice.company_id);
    return { ...toCamel(invoice), ...balance };
  };

  app.get('/api/finance/open', route(req => {
    const type = req.query.type;
    if (type !== 'sale' && type !== 'purchase') throw fail('type must be sale or purchase');
    const permittedBranches = allowedScopes(db,{companyId:req.company.id,userId:req.user.id}).branchIds;
    const invoices = db.prepare(`
      SELECT v.id,v.company_id,v.branch_id,v.gstin_id,v.party_id,v.number,v.type,v.status,v.invoice_date,v.total_cents,
        COALESCE(NULLIF(v.party_name_snapshot,''),p.name) AS party_name,b.name AS branch_name,g.gstin,
        COALESCE(pay.paid_cents,0) AS paid_cents,
        COALESCE(emp.employee_allocated_cents,0) AS employee_allocated_cents,
        COALESCE(adj.commercial_adjustment_cents,0) AS commercial_adjustment_cents
      FROM invoices v
      JOIN parties p ON p.id=v.party_id
      JOIN branches b ON b.id=v.branch_id
      JOIN gstins g ON g.id=v.gstin_id
      LEFT JOIN (SELECT company_id,invoice_id,SUM(amount_cents) AS paid_cents FROM invoice_payments GROUP BY company_id,invoice_id) pay ON pay.invoice_id=v.id AND pay.company_id=v.company_id
      LEFT JOIN (SELECT company_id,invoice_id,SUM(amount_cents) AS employee_allocated_cents FROM employee_invoice_allocations GROUP BY company_id,invoice_id) emp ON emp.invoice_id=v.id AND emp.company_id=v.company_id
      LEFT JOIN (SELECT company_id,invoice_id,SUM(amount_cents) AS commercial_adjustment_cents FROM return_settlements GROUP BY company_id,invoice_id) adj ON adj.invoice_id=v.id AND adj.company_id=v.company_id
      WHERE v.company_id=? AND v.type=? AND v.status='approved' AND v.branch_id IN (${permittedBranches.map(() => '?').join(',') || 'NULL'})
      ORDER BY v.invoice_date DESC,v.id DESC
    `).all(req.company.id, type, ...permittedBranches).map(row => {
      const difference = row.total_cents - row.commercial_adjustment_cents - row.paid_cents - row.employee_allocated_cents;
      return { ...toCamel(row), adjustedTotalCents: row.total_cents - row.commercial_adjustment_cents,
        outstandingCents: Math.max(0,difference), refundableCents: Math.max(0,-difference) };
    });
    return { invoices, totals: invoices.reduce((acc, invoice) => ({
      invoicedCents: acc.invoicedCents + invoice.totalCents,
      paidCents: acc.paidCents + invoice.paidCents,
      employeeAllocatedCents: acc.employeeAllocatedCents + invoice.employeeAllocatedCents,
      commercialAdjustmentCents: acc.commercialAdjustmentCents + invoice.commercialAdjustmentCents,
      outstandingCents: acc.outstandingCents + invoice.outstandingCents,
      refundableCents: acc.refundableCents + invoice.refundableCents,
    }), { invoicedCents: 0, paidCents: 0, employeeAllocatedCents:0, commercialAdjustmentCents: 0, outstandingCents: 0, refundableCents: 0 }) };
  }));

  app.get('/api/finance/payments', route(req => {
    const invoiceId = safeId(req.query.invoiceId, 'invoiceId');
    const invoice = invoiceById(invoiceId, req.company.id);
    assertBranchAccess(db,{companyId:req.company.id,userId:req.user.id,branchId:invoice.branch_id});
    const payments = db.prepare('SELECT * FROM invoice_payments WHERE company_id=? AND invoice_id=? ORDER BY payment_date DESC,id DESC').all(req.company.id, invoiceId).map(toCamel);
    return { invoice: invoiceBalance(invoice), payments };
  }));

  app.post('/api/finance/payments', route(req => {
    if (!['accountant', 'admin'].includes(req.user.role)) throw fail('Accountant or admin role required', 403);
    const body = req.body || {};
    const invoiceId = safeId(body.invoiceId, 'invoiceId');
    if (!Number.isSafeInteger(body.amountCents) || body.amountCents <= 0) throw fail('amountCents must be a positive integer');
    if (!['bank', 'upi', 'cash', 'cheque', 'other'].includes(body.method)) throw fail('Invalid payment method');
    if (typeof body.reference !== 'string' || !body.reference.trim() || body.reference.length > 100) throw fail('reference is required and must be at most 100 characters');
    const reference = body.reference.trim();
    const paymentDate = validDate(body.paymentDate);
    db.exec('BEGIN IMMEDIATE');
    try {
      const invoice = invoiceById(invoiceId, req.company.id);
      assertBranchAccess(db,{companyId:req.company.id,userId:req.user.id,branchId:invoice.branch_id});
      if (invoice.status !== 'approved') throw fail('Only approved invoices can receive payments', 409);
      if (db.prepare('SELECT 1 FROM invoice_payments WHERE invoice_id=? AND reference=?').get(invoiceId, reference)) throw fail('Reference already recorded for this invoice', 409);
      const outstandingCents = invoiceSettlementBalance(db,invoiceId,req.company.id).outstandingCents;
      if (body.amountCents > outstandingCents) throw fail('Payment exceeds outstanding balance', 409);
      let cashSession = null;
      if (body.method === 'cash') {
        if (invoice.type !== 'sale') throw fail('Cash supplier payments require a linked cashier payout workflow', 409);
        cashSession = db.prepare("SELECT id FROM cashier_sessions WHERE company_id=? AND branch_id=? AND business_date=? AND status='open'")
          .get(req.company.id, invoice.branch_id, paymentDate);
        if (!cashSession) throw fail('Open a cashier session for this branch and payment date before recording cash', 409);
      }
      const result = db.prepare('INSERT INTO invoice_payments(company_id,invoice_id,amount_cents,method,reference,payment_date,recorded_by) VALUES (?,?,?,?,?,?,?)').run(req.company.id,invoiceId,body.amountCents,body.method,reference,paymentDate,req.user.id);
      postPayment(db,Number(result.lastInsertRowid));
      if (cashSession) {
        db.prepare('INSERT INTO cashier_assignments(company_id,session_id,payment_id,assigned_by) VALUES (?,?,?,?)')
          .run(req.company.id,cashSession.id,result.lastInsertRowid,req.user.id);
        db.prepare('INSERT INTO cashier_events(company_id,session_id,action,details,actor_id) VALUES (?,?,?,?,?)')
          .run(req.company.id,cashSession.id,'payment_assigned',
            `Payment ${result.lastInsertRowid}, ${body.amountCents} paise, reference ${reference}`,req.user.id);
      }
      const payment = toCamel(db.prepare('SELECT * FROM invoice_payments WHERE id=?').get(result.lastInsertRowid));
      db.exec('COMMIT');
      return { payment, invoice: invoiceBalance(invoice) };
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  }));
}

module.exports = { registerFinanceRoutes };
