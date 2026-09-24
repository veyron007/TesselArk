const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const { allowedScopes, assertBranchAccess } = require('./access.cjs');
const toCamel = row => Object.fromEntries(Object.entries(row).map(([key, value]) => [key.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase()), value]));
const id = (value, name) => {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw fail(`${name} must be a positive integer`);
  return parsed;
};
const cents = (value, name, minimum = 0) => {
  if (!Number.isSafeInteger(value) || value < minimum) throw fail(`${name} must be an integer of at least ${minimum}`);
  return value;
};
const date = (value, name = 'businessDate') => {
  const parsed = typeof value === 'string' ? Date.parse(`${value}T00:00:00Z`) : NaN;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(parsed) || new Date(parsed).toISOString().slice(0, 10) !== value) throw fail(`${name} must be a valid YYYY-MM-DD date`);
  return value;
};
const limitedText = (value, name, maximum, required = false) => {
  if (typeof value !== 'string' || value.length > maximum || (required && !value.trim())) throw fail(`${name} is invalid`);
  return value.trim();
};
const route = handler => (req, res, next) => { try { res.json(handler(req)); } catch (error) { next(error); } };
const transaction = (db, action) => {
  db.exec('BEGIN IMMEDIATE');
  try { const result = action(); db.exec('COMMIT'); return result; }
  catch (error) { db.exec('ROLLBACK'); throw error; }
};

function registerCashierRoutes(app, db) {
  const permitBranch = (req, branchId) => assertBranchAccess(db,{companyId:req.company.id,userId:req.user.id,branchId});
  const event = (session, action, actorId, details) => db.prepare(
    'INSERT INTO cashier_events(company_id,session_id,action,details,actor_id) VALUES (?,?,?,?,?)'
  ).run(session.company_id, session.id, action, details, actorId);
  const branch = (companyId, branchId) => {
    const row = db.prepare('SELECT * FROM branches WHERE id=? AND company_id=?').get(branchId, companyId);
    if (!row) throw fail('Branch not found in selected company', 404);
    return row;
  };
  const rawSession = (companyId, sessionId) => {
    const row = db.prepare('SELECT * FROM cashier_sessions WHERE id=? AND company_id=?').get(sessionId, companyId);
    if (!row) throw fail('Cashier session not found in selected company', 404);
    return row;
  };
  const sessionFor = (req, sessionId) => {
    const session = rawSession(req.company.id,sessionId);
    permitBranch(req,session.branch_id);
    return session;
  };
  const cashTotals = sessionId => {
    const collectionsCents = db.prepare(`SELECT COALESCE(SUM(p.amount_cents),0) AS cents
      FROM cashier_assignments a JOIN invoice_payments p ON p.id=a.payment_id WHERE a.session_id=?`).get(sessionId).cents;
    const payoutsCents = db.prepare('SELECT COALESCE(SUM(amount_cents),0) AS cents FROM cashier_payouts WHERE session_id=?').get(sessionId).cents;
    return { collectionsCents, payoutsCents };
  };
  const present = session => {
    const totals = cashTotals(session.id);
    const branchName = db.prepare('SELECT name FROM branches WHERE id=?').get(session.branch_id).name;
    return { ...toCamel(session), branchName, ...totals,
      expectedCashCents: session.opening_cash_cents + totals.collectionsCents - totals.payoutsCents };
  };
  const requireOpen = session => {
    if (session.status !== 'open') throw fail('Cashier session is not open', 409);
  };

  app.get('/api/cashier/sessions', route(req => {
    const branchId = req.query.branchId === undefined ? null : id(req.query.branchId, 'branchId');
    if (branchId) permitBranch(req,branchId);
    const permitted = branchId ? [branchId] : allowedScopes(db,{companyId:req.company.id,userId:req.user.id}).branchIds;
    const rows = db.prepare(`SELECT * FROM cashier_sessions WHERE company_id=? AND branch_id IN (${permitted.map(() => '?').join(',') || 'NULL'})
      ORDER BY business_date DESC,id DESC LIMIT 200`).all(req.company.id,...permitted);
    return { sessions: rows.map(present) };
  }));

  app.get('/api/cashier/eligible-payments', route(req => {
    const branchId = id(req.query.branchId, 'branchId');
    permitBranch(req,branchId);
    const businessDate = date(req.query.businessDate);
    const payments = db.prepare(`SELECT p.id,p.invoice_id,v.number AS invoice_number,
        COALESCE(NULLIF(v.party_name_snapshot,''),party.name) AS party_name,
        p.amount_cents,p.reference,p.payment_date
      FROM invoice_payments p JOIN invoices v ON v.id=p.invoice_id AND v.company_id=p.company_id
      JOIN parties party ON party.id=v.party_id
      LEFT JOIN cashier_assignments a ON a.payment_id=p.id
      WHERE p.company_id=? AND v.branch_id=? AND p.payment_date=? AND p.method='cash'
        AND v.type='sale' AND v.status='approved' AND a.id IS NULL
      ORDER BY p.id DESC`).all(req.company.id, branchId, businessDate).map(toCamel);
    return { payments };
  }));

  app.get('/api/cashier/sessions/:id', route(req => {
    const session = sessionFor(req, id(req.params.id, 'sessionId'));
    const assignments = db.prepare(`SELECT a.id,a.payment_id,a.assigned_by,a.assigned_at,
        p.amount_cents,p.reference,p.payment_date,v.id AS invoice_id,v.number AS invoice_number
      FROM cashier_assignments a JOIN invoice_payments p ON p.id=a.payment_id
      JOIN invoices v ON v.id=p.invoice_id WHERE a.company_id=? AND a.session_id=? ORDER BY a.id`)
      .all(req.company.id, session.id).map(toCamel);
    const payouts = db.prepare('SELECT * FROM cashier_payouts WHERE company_id=? AND session_id=? ORDER BY id')
      .all(req.company.id, session.id).map(toCamel);
    const events = db.prepare('SELECT * FROM cashier_events WHERE company_id=? AND session_id=? ORDER BY id')
      .all(req.company.id, session.id).map(toCamel);
    return { session: present(session), assignments, payouts, events };
  }));

  app.post('/api/cashier/sessions', route(req => transaction(db, () => {
    const body = req.body || {};
    const branchId = id(body.branchId, 'branchId');
    permitBranch(req,branchId);
    const businessDate = date(body.businessDate);
    const openingCashCents = cents(body.openingCashCents, 'openingCashCents');
    if (db.prepare("SELECT id FROM cashier_sessions WHERE company_id=? AND branch_id=? AND status IN ('open','pending_review')")
      .get(req.company.id, branchId)) throw fail('An active cashier session already exists for this branch', 409);
    if (db.prepare('SELECT id FROM cashier_sessions WHERE company_id=? AND branch_id=? AND business_date=?')
      .get(req.company.id, branchId, businessDate)) throw fail('A cashier session already exists for this branch and business date', 409);
    const sessionId = Number(db.prepare(`INSERT INTO cashier_sessions
      (company_id,branch_id,business_date,opening_cash_cents,opened_by) VALUES (?,?,?,?,?)`)
      .run(req.company.id, branchId, businessDate, openingCashCents, req.user.id).lastInsertRowid);
    const session = rawSession(req.company.id, sessionId);
    event(session, 'opened', req.user.id, `Opening cash ${openingCashCents} paise on ${businessDate}`);
    return { session: present(session) };
  })));

  app.post('/api/cashier/sessions/:id/assignments', route(req => transaction(db, () => {
    const session = sessionFor(req, id(req.params.id, 'sessionId'));
    requireOpen(session);
    const paymentId = id(req.body?.paymentId, 'paymentId');
    const payment = db.prepare(`SELECT p.*,v.branch_id,v.type AS invoice_type,v.status AS invoice_status
      FROM invoice_payments p JOIN invoices v ON v.id=p.invoice_id AND v.company_id=p.company_id
      WHERE p.id=? AND p.company_id=?`).get(paymentId, req.company.id);
    if (!payment) throw fail('Payment not found in selected company', 404);
    if (payment.method !== 'cash' || payment.invoice_type !== 'sale' || payment.invoice_status !== 'approved')
      throw fail('Only cash payments for approved sales can be assigned', 409);
    if (payment.branch_id !== session.branch_id || payment.payment_date !== session.business_date)
      throw fail('Payment branch and date must match cashier session', 409);
    if (db.prepare('SELECT id FROM cashier_assignments WHERE payment_id=?').get(paymentId))
      throw fail('Cash payment already assigned to a cashier session', 409);
    db.prepare('INSERT INTO cashier_assignments(company_id,session_id,payment_id,assigned_by) VALUES (?,?,?,?)')
      .run(req.company.id, session.id, paymentId, req.user.id);
    event(session, 'payment_assigned', req.user.id, `Payment ${paymentId}, ${payment.amount_cents} paise, reference ${payment.reference}`);
    return { session: present(session) };
  })));

  app.post('/api/cashier/sessions/:id/payouts', route(req => transaction(db, () => {
    const session = sessionFor(req, id(req.params.id, 'sessionId'));
    requireOpen(session);
    const body = req.body || {};
    if (!['expense', 'refund', 'transfer'].includes(body.kind)) throw fail('kind must be expense, refund, or transfer');
    const amountCents = cents(body.amountCents, 'amountCents', 1);
    const reference = limitedText(body.reference, 'reference', 100, true);
    const notes = limitedText(body.notes ?? '', 'notes', 500);
    if (db.prepare('SELECT id FROM cashier_payouts WHERE session_id=? AND reference=?').get(session.id, reference))
      throw fail('Payout reference already recorded for this session', 409);
    if (amountCents > present(session).expectedCashCents) throw fail('Payout exceeds expected drawer cash', 409);
    const payoutId = Number(db.prepare(`INSERT INTO cashier_payouts
      (company_id,session_id,kind,amount_cents,reference,notes,recorded_by) VALUES (?,?,?,?,?,?,?)`)
      .run(req.company.id, session.id, body.kind, amountCents, reference, notes, req.user.id).lastInsertRowid);
    event(session, 'payout_recorded', req.user.id, `${body.kind} ${amountCents} paise, reference ${reference}`);
    return { payout: toCamel(db.prepare('SELECT * FROM cashier_payouts WHERE id=?').get(payoutId)), session: present(session) };
  })));

  app.post('/api/cashier/sessions/:id/close', route(req => transaction(db, () => {
    const session = sessionFor(req, id(req.params.id, 'sessionId'));
    requireOpen(session);
    const unassigned = db.prepare(`SELECT p.id FROM invoice_payments p
      JOIN invoices v ON v.id=p.invoice_id AND v.company_id=p.company_id
      LEFT JOIN cashier_assignments a ON a.payment_id=p.id
      WHERE p.company_id=? AND v.branch_id=? AND p.payment_date=? AND p.method='cash'
        AND v.type='sale' AND v.status='approved' AND a.id IS NULL LIMIT 1`)
      .get(req.company.id, session.branch_id, session.business_date);
    if (unassigned) throw fail('Assign all eligible cash payments before closing the session', 409);
    const countedCashCents = cents(req.body?.countedCashCents, 'countedCashCents');
    const notes = limitedText(req.body?.notes ?? '', 'notes', 500);
    const discrepancyCents = countedCashCents - present(session).expectedCashCents;
    if (discrepancyCents !== 0 && !notes) throw fail('notes are required when cash count differs', 400);
    const status = discrepancyCents === 0 ? 'closed' : 'pending_review';
    db.prepare(`UPDATE cashier_sessions SET status=?,counted_cash_cents=?,discrepancy_cents=?,
      close_notes=?,closed_by=?,closed_at=CURRENT_TIMESTAMP,review_note='',reviewed_by=NULL,reviewed_at=NULL WHERE id=?`)
      .run(status, countedCashCents, discrepancyCents, notes, req.user.id, session.id);
    event(session, discrepancyCents === 0 ? 'closed_balanced' : 'discrepancy_submitted',
      req.user.id, `Counted ${countedCashCents} paise; discrepancy ${discrepancyCents} paise. ${notes}`);
    return { session: present(rawSession(req.company.id, session.id)) };
  })));

  app.post('/api/cashier/sessions/:id/review', route(req => transaction(db, () => {
    if (!['accountant', 'admin'].includes(req.user.role)) throw fail('Accountant or admin role required', 403);
    const session = sessionFor(req, id(req.params.id, 'sessionId'));
    if (session.status !== 'pending_review') throw fail('No cashier discrepancy is pending review', 409);
    if (session.closed_by === req.user.id) throw fail('A different user must review the discrepancy', 403);
    const decision = req.body?.decision;
    if (!['approve', 'reject'].includes(decision)) throw fail('decision must be approve or reject');
    const reason = limitedText(req.body?.reason, 'reason', 500, true);
    const approved = decision === 'approve';
    db.prepare(`UPDATE cashier_sessions SET status=?,review_note=?,reviewed_by=?,reviewed_at=CURRENT_TIMESTAMP,
      counted_cash_cents=CASE WHEN ? THEN counted_cash_cents ELSE NULL END,
      discrepancy_cents=CASE WHEN ? THEN discrepancy_cents ELSE NULL END,
      closed_by=CASE WHEN ? THEN closed_by ELSE NULL END,
      closed_at=CASE WHEN ? THEN closed_at ELSE NULL END WHERE id=?`)
      .run(approved ? 'closed' : 'open', reason, req.user.id, Number(approved), Number(approved), Number(approved), Number(approved), session.id);
    event(session, approved ? 'discrepancy_approved' : 'discrepancy_rejected', req.user.id, reason);
    return { session: present(rawSession(req.company.id, session.id)) };
  })));
}

module.exports = { registerCashierRoutes };
