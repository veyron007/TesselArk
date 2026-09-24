const { installCreditSchema } = require('./credit-db.cjs');
const { assertScopeAccess, allowedScopes } = require('./access.cjs');

const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const camel = row => row ? Object.fromEntries(Object.entries(row).map(([key, value]) => [key.replace(/_([a-z])/g, (_,letter) => letter.toUpperCase()), value])) : null;
const integer = (value, name, min = 0) => {
  if (!Number.isSafeInteger(value) || value < min) throw fail(`${name} must be a safe integer of at least ${min}`);
  return value;
};
const id = (value, name) => integer(Number(value), name, 1);
const text = (value, name, max = 500) => {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max) throw fail(`${name} is required and must be at most ${max} characters`);
  return value.trim();
};
const date = (value, name) => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw fail(`${name} must be YYYY-MM-DD`);
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) throw fail(`${name} must be a real date`);
  return value;
};
const today = () => new Date().toISOString().slice(0, 10);
const add = (left, right, label) => {
  const result = left + right;
  if (!Number.isSafeInteger(result)) throw fail(`${label} exceeds safe integer paise`, 409);
  return result;
};
const subtract = (left, right, label) => add(left, -right, label);
const lineAmount = line => {
  const quantity = integer(line.quantity, 'quantity', 1);
  const price = integer(line.unit_price_cents, 'unitPriceCents');
  const rate = integer(line.gst_rate_bps, 'gstRateBps');
  const subtotal = BigInt(quantity) * BigInt(price);
  const gross = subtotal + (subtotal * BigInt(rate) + 5000n) / 10000n;
  if (gross > BigInt(Number.MAX_SAFE_INTEGER)) throw fail('Order amount exceeds safe integer paise', 409);
  return Number(gross);
};

function creditScope(db, companyId, userId, gstinId, branchId, partyId) {
  const branch = db.prepare('SELECT id FROM branches WHERE id=? AND company_id=? AND gstin_id=?').get(branchId, companyId, gstinId);
  if (!branch) throw fail('Branch and GSTIN must belong to the selected company and each other');
  assertScopeAccess(db, { companyId, userId, gstinId, branchId });
  const party = db.prepare("SELECT id,name,gstin FROM parties WHERE id=? AND company_id=? AND type IN ('customer','both')").get(partyId, companyId);
  if (!party) throw fail('Customer not found in selected company', 404);
  return party;
}

function exposure(db, { companyId, gstinId, branchId, partyId }) {
  const invoices = db.prepare(`SELECT id,number,status,invoice_date,total_cents FROM invoices
    WHERE company_id=? AND gstin_id=? AND branch_id=? AND party_id=? AND type='sale' AND status IN ('approved','submitted') ORDER BY id`)
    .all(companyId, gstinId, branchId, partyId);
  let approvedOutstandingCents = 0, submittedInvoiceCents = 0, unclearedChequeCents = 0;
  const invoiceDetails = invoices.map(invoice => {
    const total = integer(invoice.total_cents, 'invoice total');
    if (invoice.status === 'submitted') {
      submittedInvoiceCents = add(submittedInvoiceCents, total, 'Submitted invoice exposure');
      return { invoiceId: invoice.id, number: invoice.number, status: invoice.status, invoiceDate: invoice.invoice_date, exposureCents: total, unclearedChequeCents: 0 };
    }
    const payments = db.prepare('SELECT amount_cents,method FROM invoice_payments WHERE company_id=? AND invoice_id=?').all(companyId, invoice.id);
    const settlements = db.prepare('SELECT amount_cents FROM return_settlements WHERE company_id=? AND invoice_id=?').all(companyId, invoice.id);
    const paid = payments.reduce((sum, row) => add(sum, integer(row.amount_cents, 'payment amount', 1), 'Payments'), 0);
    const adjusted = settlements.reduce((sum, row) => add(sum, integer(row.amount_cents, 'settlement amount', 1), 'Settlements'), 0);
    const cheque = payments.filter(row => row.method === 'cheque').reduce((sum, row) => add(sum, row.amount_cents, 'Cheque exposure'), 0);
    const adjustedTotal = subtract(total, adjusted, 'Invoice balance');
    if (adjustedTotal < 0) throw fail('Commercial settlements exceed invoice total', 409);
    const net = Math.max(0, subtract(adjustedTotal, paid, 'Invoice balance'));
    const exposed = Math.max(0, subtract(adjustedTotal, subtract(paid, cheque, 'Cleared payments'), 'Approved invoice exposure'));
    const chequeRisk = subtract(exposed, net, 'Cheque exposure');
    approvedOutstandingCents = add(approvedOutstandingCents, net, 'Approved invoice exposure');
    unclearedChequeCents = add(unclearedChequeCents, chequeRisk, 'Cheque exposure');
    return { invoiceId: invoice.id, number: invoice.number, status: invoice.status, invoiceDate: invoice.invoice_date, exposureCents: exposed, unclearedChequeCents: chequeRisk };
  });

  const orders = db.prepare(`SELECT id,number,order_date FROM orders
    WHERE company_id=? AND gstin_id=? AND branch_id=? AND party_id=? AND type='sale' AND status='confirmed' ORDER BY id`)
    .all(companyId, gstinId, branchId, partyId);
  let openOrderCents = 0;
  const orderDetails = orders.map(order => {
    const lines = db.prepare('SELECT quantity,unit_price_cents,gst_rate_bps FROM order_lines WHERE order_id=?').all(order.id);
    const ordered = lines.reduce((sum, line) => add(sum, lineAmount(line), 'Order commitment'), 0);
    const linked = db.prepare(`SELECT v.total_cents FROM invoices v JOIN order_fulfillments f ON f.id=v.fulfillment_id
      WHERE f.order_id=? AND v.company_id=? AND v.type='sale' AND v.status IN ('submitted','approved')`).all(order.id, companyId)
      .reduce((sum, row) => add(sum, integer(row.total_cents, 'linked invoice total'), 'Linked invoices'), 0);
    const commitment = subtract(ordered, linked, 'Order commitment');
    if (commitment < 0) throw fail('Linked invoices exceed source order commitment', 409);
    openOrderCents = add(openOrderCents, commitment, 'Order commitment');
    return { orderId: order.id, number: order.number, orderDate: order.order_date, orderedCents: ordered, linkedInvoiceCents: linked, exposureCents: commitment };
  });
  const totalCents = add(add(add(approvedOutstandingCents, submittedInvoiceCents, 'Credit exposure'), unclearedChequeCents, 'Credit exposure'), openOrderCents, 'Credit exposure');
  return { approvedOutstandingCents, submittedInvoiceCents, unclearedChequeCents, openOrderCents, totalCents,
    invoices: invoiceDetails, orders: orderDetails,
    excluded: ['Draft invoices', 'Draft orders', 'Unposted documents', 'Overdue classification (no due date)', 'Cheque clearance (no clearance state)'] };
}

function assessment(db, scope, asOf = today()) {
  const policy = db.prepare('SELECT * FROM credit_policies WHERE company_id=? AND gstin_id=? AND branch_id=? AND party_id=?')
    .get(scope.companyId, scope.gstinId, scope.branchId, scope.partyId);
  const active = db.prepare(`SELECT * FROM credit_requests WHERE company_id=? AND gstin_id=? AND branch_id=? AND party_id=?
    AND status='approved' AND valid_from<=? AND valid_through>=? AND date(reviewed_at)<=? ORDER BY id DESC LIMIT 1`)
    .get(scope.companyId, scope.gstinId, scope.branchId, scope.partyId, asOf, asOf, asOf);
  const measured = exposure(db, scope);
  const effectiveLimitCents = policy ? add(integer(policy.base_limit_cents, 'base limit'), active?.additional_limit_cents || 0, 'Effective limit') : null;
  const availableCents = effectiveLimitCents === null ? null : subtract(effectiveLimitCents, measured.totalCents, 'Available credit');
  return { asOf, policy: camel(policy), activeTemporaryLimit: active ? { ...camel(active), effectiveFrom: active.valid_from > active.reviewed_at.slice(0,10) ? active.valid_from : active.reviewed_at.slice(0,10) } : null, exposure: measured,
    effectiveLimitCents, availableCents, overLimit: availableCents === null ? null : availableCents < 0,
    controlMode: policy?.mode || null, enforcement: policy?.mode === 'hold' ? 'hold_on_new_commitments' : 'advisory_only', exposureBasis:'current_records' };
}

function holdBaseline(db, scope) {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='credit_policies'").get()) return null;
  const policy = db.prepare('SELECT mode FROM credit_policies WHERE company_id=? AND gstin_id=? AND branch_id=? AND party_id=?')
    .get(scope.companyId,scope.gstinId,scope.branchId,scope.partyId);
  return policy?.mode === 'hold' ? exposure(db,scope).totalCents : null;
}

function assertCreditHold(db, scope, beforeCents) {
  if (beforeCents === null) return;
  const current = assessment(db,scope);
  if (current.overLimit && current.exposure.totalCents > beforeCents) {
    throw fail(`Customer credit limit exceeded by ${-current.availableCents} paise; request an independently reviewed temporary limit or change the policy`,409);
  }
}

function registerCreditRoutes(app, db) {
  installCreditSchema(db);
  const route = handler => (req, res, next) => { try { res.json(handler(req)); } catch (error) { next(error); } };
  const atomic = action => { db.exec('SAVEPOINT credit_operation'); try { const result = action(); db.exec('RELEASE credit_operation'); return result; } catch (error) { db.exec('ROLLBACK TO credit_operation'); db.exec('RELEASE credit_operation'); throw error; } };
  const scope = (req, input) => {
    const companyId = req.company.id, userId = req.user.id;
    const gstinId = id(input.gstinId, 'gstinId'), branchId = id(input.branchId, 'branchId'), partyId = id(input.partyId, 'partyId');
    const party = creditScope(db, companyId, userId, gstinId, branchId, partyId);
    return { companyId, userId, gstinId, branchId, partyId, party };
  };
  const event = (s, action, details, policyId = null, requestId = null) => db.prepare(`INSERT INTO credit_events
    (company_id,gstin_id,branch_id,party_id,policy_id,request_id,action,actor_id,details) VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(s.companyId,s.gstinId,s.branchId,s.partyId,policyId,requestId,action,s.userId,details);
  const requestById = (req, requestId) => {
    const row = db.prepare('SELECT * FROM credit_requests WHERE id=? AND company_id=?').get(requestId,req.company.id);
    if (!row) throw fail('Credit request not found in selected company',404);
    scope(req, { gstinId: row.gstin_id, branchId: row.branch_id, partyId: row.party_id });
    return row;
  };
  app.get('/api/credit/overview', route(req => {
    const gstinId = id(req.query.gstinId,'gstinId'), branchId = id(req.query.branchId,'branchId');
    const asOf = req.query.asOf ? date(req.query.asOf,'asOf') : today();
    const branch = db.prepare('SELECT id FROM branches WHERE id=? AND company_id=? AND gstin_id=?').get(branchId,req.company.id,gstinId);
    if (!branch) throw fail('Branch and GSTIN must belong to selected company and each other');
    assertScopeAccess(db,{companyId:req.company.id,userId:req.user.id,gstinId,branchId});
    const parties = db.prepare("SELECT id,name,gstin FROM parties WHERE company_id=? AND type IN ('customer','both') ORDER BY name,id").all(req.company.id);
    const policies = db.prepare('SELECT * FROM credit_policies WHERE company_id=? AND gstin_id=? AND branch_id=? ORDER BY id')
      .all(req.company.id,gstinId,branchId).map(camel);
    const requests = db.prepare('SELECT * FROM credit_requests WHERE company_id=? AND gstin_id=? AND branch_id=? ORDER BY id DESC')
      .all(req.company.id,gstinId,branchId).map(camel);
    return { asOf, parties: parties.map(camel), policies, requests };
  }));
  app.get('/api/credit/parties/:id/assessment', route(req => {
    const s = scope(req,{ gstinId:req.query.gstinId,branchId:req.query.branchId,partyId:req.params.id });
    return { party:camel(s.party), assessment:assessment(db,s,req.query.asOf ? date(req.query.asOf,'asOf') : today()) };
  }));
  app.get('/api/credit/parties/:id/events', route(req => {
    const s = scope(req,{ gstinId:req.query.gstinId,branchId:req.query.branchId,partyId:req.params.id });
    return { events:db.prepare('SELECT * FROM credit_events WHERE company_id=? AND gstin_id=? AND branch_id=? AND party_id=? ORDER BY id')
      .all(s.companyId,s.gstinId,s.branchId,s.partyId).map(camel) };
  }));
  app.put('/api/credit/policies', route(req => atomic(() => {
    if (req.user.role !== 'admin') throw fail('Company admin role required for credit policy',403);
    const body = req.body || {}, s = scope(req,body);
    const baseLimitCents = integer(body.baseLimitCents,'baseLimitCents');
    const expectedVersion = integer(body.expectedVersion,'expectedVersion');
    const mode = body.mode;
    if (!['warn','hold'].includes(mode)) throw fail('mode must be warn or hold');
    const reason = text(body.reason,'reason');
    const prior = db.prepare('SELECT * FROM credit_policies WHERE company_id=? AND gstin_id=? AND branch_id=? AND party_id=?')
      .get(s.companyId,s.gstinId,s.branchId,s.partyId);
    if (prior && prior.version !== expectedVersion || !prior && expectedVersion !== 0) throw fail('Credit policy changed; reload before saving',409);
    let policyId;
    if (prior) {
      policyId = prior.id;
      db.prepare(`UPDATE credit_policies SET base_limit_cents=?,mode=?,version=version+1,reason=?,updated_by=?,updated_at=CURRENT_TIMESTAMP WHERE id=?`)
        .run(baseLimitCents,mode,reason,s.userId,policyId);
    } else {
      policyId = Number(db.prepare(`INSERT INTO credit_policies
        (company_id,gstin_id,branch_id,party_id,base_limit_cents,mode,reason,updated_by) VALUES (?,?,?,?,?,?,?,?)`)
        .run(s.companyId,s.gstinId,s.branchId,s.partyId,baseLimitCents,mode,reason,s.userId).lastInsertRowid);
    }
    event(s,prior ? 'policy_updated' : 'policy_created',JSON.stringify({baseLimitCents,mode,reason,version:expectedVersion+1}),policyId);
    return { policy:camel(db.prepare('SELECT * FROM credit_policies WHERE id=?').get(policyId)), assessment:assessment(db,s) };
  })));
  app.post('/api/credit/requests', route(req => atomic(() => {
    const body = req.body || {}, s = scope(req,body);
    const additionalLimitCents = integer(body.additionalLimitCents,'additionalLimitCents',1);
    const validFrom = date(body.validFrom,'validFrom'), validThrough = date(body.validThrough,'validThrough');
    if (validFrom > validThrough) throw fail('validThrough must be on or after validFrom');
    const reason = text(body.reason,'reason'), clientReference = text(body.clientReference,'clientReference',100);
    const prior = db.prepare('SELECT * FROM credit_requests WHERE company_id=? AND client_reference=?').get(s.companyId,clientReference);
    if (prior) {
      if (prior.gstin_id !== s.gstinId || prior.branch_id !== s.branchId || prior.party_id !== s.partyId || prior.additional_limit_cents !== additionalLimitCents || prior.valid_from !== validFrom || prior.valid_through !== validThrough || prior.reason !== reason) throw fail('clientReference was used for a different credit request',409);
      return { request:camel(prior),replayed:true };
    }
    if (!db.prepare('SELECT 1 FROM credit_policies WHERE company_id=? AND gstin_id=? AND branch_id=? AND party_id=?').get(s.companyId,s.gstinId,s.branchId,s.partyId)) throw fail('Set a credit policy before requesting a temporary limit',409);
    const requestId = Number(db.prepare(`INSERT INTO credit_requests
      (company_id,gstin_id,branch_id,party_id,client_reference,additional_limit_cents,valid_from,valid_through,reason,requested_by)
      VALUES (?,?,?,?,?,?,?,?,?,?)`).run(s.companyId,s.gstinId,s.branchId,s.partyId,clientReference,additionalLimitCents,validFrom,validThrough,reason,s.userId).lastInsertRowid);
    event(s,'request_created',JSON.stringify({clientReference,additionalLimitCents,validFrom,validThrough,reason}),null,requestId);
    return { request:camel(db.prepare('SELECT * FROM credit_requests WHERE id=?').get(requestId)),replayed:false };
  })));
  app.post('/api/credit/requests/:id/review', route(req => atomic(() => {
    if (!['accountant','admin'].includes(req.user.role)) throw fail('Accountant or admin role required for credit review',403);
    const row = requestById(req,id(req.params.id,'id'));
    if (row.requested_by === req.user.id) throw fail('Requester cannot review their own temporary limit',403);
    const decision = req.body?.decision, reviewReason = text(req.body?.reason,'reason');
    if (!['approve','reject'].includes(decision)) throw fail('decision must be approve or reject');
    if (row.status !== 'pending') {
      if (row.status === (decision === 'approve' ? 'approved' : 'rejected') && row.review_reason === reviewReason) return { request:camel(row),replayed:true };
      throw fail('Credit request was already reviewed',409);
    }
    const s = scope(req,{gstinId:row.gstin_id,branchId:row.branch_id,partyId:row.party_id});
    const policy = db.prepare('SELECT * FROM credit_policies WHERE company_id=? AND gstin_id=? AND branch_id=? AND party_id=?')
      .get(s.companyId,s.gstinId,s.branchId,s.partyId);
    if (!policy) throw fail('Credit policy no longer exists',409);
    if (decision === 'approve') {
      if (row.valid_through < today()) throw fail('Expired temporary limits cannot be approved',409);
      add(integer(policy.base_limit_cents,'base limit'),integer(row.additional_limit_cents,'additional limit',1),'Effective limit');
      const overlap = db.prepare(`SELECT id FROM credit_requests WHERE company_id=? AND gstin_id=? AND branch_id=? AND party_id=?
        AND status='approved' AND valid_from<=? AND valid_through>=? LIMIT 1`)
        .get(s.companyId,s.gstinId,s.branchId,s.partyId,row.valid_through,row.valid_from);
      if (overlap) throw fail('Another approved temporary limit overlaps these dates',409);
    }
    const exposureCents = exposure(db,s).totalCents;
    db.prepare(`UPDATE credit_requests SET status=?,reviewed_by=?,reviewed_at=CURRENT_TIMESTAMP,review_reason=?,
      base_limit_snapshot_cents=?,exposure_snapshot_cents=? WHERE id=? AND status='pending'`)
      .run(decision === 'approve' ? 'approved' : 'rejected',s.userId,reviewReason,policy.base_limit_cents,exposureCents,row.id);
    event(s,decision === 'approve' ? 'request_approved' : 'request_rejected',JSON.stringify({reviewReason,baseLimitCents:policy.base_limit_cents,exposureCents}),null,row.id);
    return { request:camel(db.prepare('SELECT * FROM credit_requests WHERE id=?').get(row.id)),replayed:false };
  })));
}

module.exports = { registerCreditRoutes, assessment, exposure, holdBaseline, assertCreditHold };
