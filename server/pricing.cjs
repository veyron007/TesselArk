const { installPricingSchema } = require('./pricing-db.cjs');
const { assertCompanyWideAccess, assertBranchAccess } = require('./access.cjs');

const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const camel = row => Object.fromEntries(Object.entries(row).map(([key, value]) => [key.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase()), value]));
const integer = (value, name, min, max = Number.MAX_SAFE_INTEGER) => {
  if (typeof value === 'boolean' || value === '' || value === null || value === undefined || !Number.isSafeInteger(Number(value)) || Number(value) < min || Number(value) > max) throw fail(`${name} must be an integer from ${min} to ${max}`);
  return Number(value);
};
const words = (value, name, max = 300) => {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw fail(`${name} is required and must be at most ${max} characters`);
  return value.trim();
};
const date = (value, name) => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw fail(`${name} must be a valid YYYY-MM-DD date`);
  const timestamp = Date.parse(`${value}T00:00:00Z`);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString().slice(0, 10) !== value) throw fail(`${name} must be a valid YYYY-MM-DD date`);
  return value;
};
const atomic = (db, work) => {
  db.exec('SAVEPOINT pricing_action');
  try { const result = work(); db.exec('RELEASE pricing_action'); return result; }
  catch (error) { db.exec('ROLLBACK TO pricing_action'); db.exec('RELEASE pricing_action'); throw error; }
};
const policy = row => ({ ...camel(row), active: Boolean(row.active) });
const exception = row => ({ ...camel(row), baseline: JSON.parse(row.baseline_json), baselineJson: undefined, payloadJson: undefined });

function registerPricingRoutes(app, db) {
  installPricingSchema(db);
  const route = handler => (req, res, next) => { try { res.json(handler(req)); } catch (error) { next(error); } };
  const reader = req => { if (!req.scopes.branchIds.length) throw fail('A branch grant is required for pricing data', 403); };
  const manager = req => {
    reader(req);
    if (req.user.role !== 'admin') throw fail('Company admin role required for pricing policy or exception decisions', 403);
    assertCompanyWideAccess(db, { companyId: req.company.id, userId: req.user.id });
  };
  const master = (req, table, value, name) => {
    const row = db.prepare(`SELECT * FROM ${table} WHERE id=? AND company_id=?`).get(integer(value, name, 1), req.company.id);
    if (!row) throw fail(`${name} not found in selected company`, 404);
    return row;
  };
  const customer = (req, value) => {
    const row = master(req, 'parties', value, 'partyId');
    if (!['customer', 'both'].includes(row.type)) throw fail('Pricing requires a customer party');
    return row;
  };
  const branch = (req, value) => {
    const row = assertBranchAccess(db, { companyId: req.company.id, userId: req.user.id, branchId: integer(value, 'branchId', 1) });
    return row;
  };
  const ruleById = (req, value) => {
    const row = db.prepare('SELECT * FROM pricing_rules WHERE id=? AND company_id=?').get(integer(value, 'ruleId', 1), req.company.id);
    if (!row) throw fail('Pricing rule not found in selected company', 404);
    return row;
  };
  const exceptionById = (req, value) => {
    const row = db.prepare('SELECT * FROM pricing_exceptions WHERE id=? AND company_id=?').get(integer(value, 'exceptionId', 1), req.company.id);
    if (!row) throw fail('Pricing exception not found in selected company', 404);
    if (!req.scopes.branchIds.includes(row.branch_id)) throw fail('Branch access is not granted', 403);
    return row;
  };
  const event = (table, req, id, action, detail) => db.prepare(`INSERT INTO ${table}(company_id,${table === 'pricing_rule_events' ? 'rule_id' : 'exception_id'},action,actor_id,detail_json) VALUES (?,?,?,?,?)`)
    .run(req.company.id, id, action, req.user.id, JSON.stringify(detail));
  const quote = (req, itemId, partyId, priceDate) => {
    const item = master(req, 'items', itemId, 'itemId');
    if (!item.active) throw fail('Inactive items cannot receive a pricing quote', 409);
    const party = customer(req, partyId);
    const day = date(priceDate, 'priceDate');
    const rows = db.prepare(`SELECT * FROM pricing_rules WHERE company_id=? AND active=1
      AND effective_from<=? AND (effective_to IS NULL OR effective_to>=?)
      AND (item_id IS NULL OR item_id=?) AND (party_id IS NULL OR party_id=?)
      ORDER BY CASE scope WHEN 'party_item' THEN 4 WHEN 'party' THEN 3 WHEN 'item' THEN 2 ELSE 1 END DESC,id DESC`)
      .all(req.company.id, day, day, item.id, party.id);
    const chosen = rows[0];
    if (!chosen) return { itemId: item.id, partyId: party.id, priceDate: day, hasPolicy: false, rule: null, rateCents: null, discountBps: null, netRateCents: null, approvalRequired: null };
    return { itemId: item.id, partyId: party.id, priceDate: day, hasPolicy: true, rule: policy(chosen), rateCents: chosen.rate_cents,
      discountBps: chosen.default_discount_bps, netRateCents: Math.round(chosen.rate_cents * (10000 - chosen.default_discount_bps) / 10000), approvalRequired: false };
  };
  const parseProposal = (req, body) => {
    const scope = body.scope;
    if (!['company', 'item', 'party', 'party_item'].includes(scope)) throw fail('scope must be company, item, party, or party_item');
    const item = ['item', 'party_item'].includes(scope) ? master(req, 'items', body.itemId, 'itemId') : null;
    if (item && !item.active) throw fail('Inactive items cannot receive a pricing rule', 409);
    const itemId = item?.id ?? null;
    const partyId = ['party', 'party_item'].includes(scope) ? customer(req, body.partyId).id : null;
    if (itemId === null && body.itemId != null && body.itemId !== '') throw fail('itemId is not allowed for this scope');
    if (partyId === null && body.partyId != null && body.partyId !== '') throw fail('partyId is not allowed for this scope');
    const from = date(body.effectiveFrom, 'effectiveFrom');
    const to = body.effectiveTo == null || body.effectiveTo === '' ? null : date(body.effectiveTo, 'effectiveTo');
    if (to && to < from) throw fail('effectiveTo must be on or after effectiveFrom');
    const rate = integer(body.rateCents, 'rateCents', 1, 1000000000);
    const min = integer(body.minDiscountBps, 'minDiscountBps', 0, 10000);
    const def = integer(body.defaultDiscountBps, 'defaultDiscountBps', 0, 10000);
    const max = integer(body.maxDiscountBps, 'maxDiscountBps', 0, 10000);
    if (min > def || def > max) throw fail('Discount limits must enclose the default discount');
    return { scope, itemId, partyId, from, to, rate, min, def, max, sourceReference: words(body.sourceReference, 'sourceReference', 160), reason: words(body.reason, 'reason', 500) };
  };

  app.get('/api/pricing/masters', route(req => {
    reader(req);
    return { items: db.prepare('SELECT id,sku,name,active FROM items WHERE company_id=? ORDER BY name').all(req.company.id).map(camel),
      parties: db.prepare("SELECT id,name,type FROM parties WHERE company_id=? AND type IN ('customer','both') ORDER BY name").all(req.company.id).map(camel) };
  }));
  app.get('/api/pricing/rules', route(req => {
    reader(req);
    return { rules: db.prepare('SELECT * FROM pricing_rules WHERE company_id=? ORDER BY active DESC,effective_from DESC,id DESC LIMIT 200').all(req.company.id).map(policy),
      precedence: ['party_item', 'party', 'item', 'company'] };
  }));
  app.post('/api/pricing/rules', route(req => {
    manager(req);
    const data = parseProposal(req, req.body || {});
    return atomic(db, () => {
      const overlap = db.prepare(`SELECT id FROM pricing_rules WHERE company_id=? AND active=1 AND scope=?
        AND item_id IS ? AND party_id IS ? AND effective_from<=COALESCE(?,'9999-12-31')
        AND COALESCE(effective_to,'9999-12-31')>=? LIMIT 1`).get(req.company.id, data.scope, data.itemId, data.partyId, data.to, data.from);
      if (overlap) throw fail(`An active rule already covers this scope and date range (rule #${overlap.id})`, 409);
      const result = db.prepare(`INSERT INTO pricing_rules(company_id,scope,item_id,party_id,rate_cents,default_discount_bps,min_discount_bps,max_discount_bps,effective_from,effective_to,source_reference,reason,created_by)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(req.company.id, data.scope, data.itemId, data.partyId, data.rate, data.def, data.min, data.max, data.from, data.to, data.sourceReference, data.reason, req.user.id);
      const rule = policy(ruleById(req, result.lastInsertRowid));
      event('pricing_rule_events', req, rule.id, 'created', rule);
      return { rule };
    });
  }));
  app.post('/api/pricing/rules/:id/retire', route(req => {
    manager(req);
    const row = ruleById(req, req.params.id);
    const reason = words(req.body?.reason, 'reason', 500);
    if (!row.active) throw fail('Rule is already retired', 409);
    return atomic(db, () => {
      db.prepare('UPDATE pricing_rules SET active=0,retired_by=?,retired_at=CURRENT_TIMESTAMP WHERE id=? AND company_id=?').run(req.user.id, row.id, req.company.id);
      const rule = policy(ruleById(req, row.id));
      event('pricing_rule_events', req, row.id, 'retired', { reason, rule });
      return { rule };
    });
  }));
  app.get('/api/pricing/quote', route(req => {
    reader(req);
    branch(req, req.query.branchId);
    return { quote: quote(req, req.query.itemId, req.query.partyId, req.query.priceDate) };
  }));
  app.get('/api/pricing/exceptions', route(req => {
    reader(req);
    return { exceptions: db.prepare('SELECT * FROM pricing_exceptions WHERE company_id=? ORDER BY id DESC LIMIT 200').all(req.company.id)
      .filter(row => req.scopes.branchIds.includes(row.branch_id)).map(exception) };
  }));
  app.post('/api/pricing/exceptions', route(req => {
    reader(req);
    const body = req.body || {};
    const scopedBranch = branch(req, body.branchId);
    const item = master(req, 'items', body.itemId, 'itemId');
    if (!item.active) throw fail('Inactive items cannot receive a pricing exception', 409);
    const party = customer(req, body.partyId);
    const priceDate = date(body.priceDate, 'priceDate');
    const proposedRateCents = integer(body.proposedRateCents, 'proposedRateCents', 1, 1000000000);
    const proposedDiscountBps = integer(body.proposedDiscountBps, 'proposedDiscountBps', 0, 10000);
    const reason = words(body.reason, 'reason', 500);
    const clientReference = words(body.clientReference, 'clientReference', 120);
    const payload = { branchId: scopedBranch.id, itemId: item.id, partyId: party.id, priceDate, proposedRateCents, proposedDiscountBps, reason };
    return atomic(db, () => {
      const existing = db.prepare('SELECT * FROM pricing_exceptions WHERE company_id=? AND client_reference=?').get(req.company.id, clientReference);
      if (existing) {
        if (existing.payload_json !== JSON.stringify(payload)) throw fail('clientReference was used for a different proposal', 409);
        return { exception: exception(existing), replayed: true };
      }
      const baseline = quote(req, item.id, party.id, priceDate);
      if (!baseline.hasPolicy) throw fail('No active pricing rule applies; create a policy before requesting an exception', 409);
      if (proposedRateCents === baseline.rateCents && proposedDiscountBps >= baseline.rule.minDiscountBps && proposedDiscountBps <= baseline.rule.maxDiscountBps) throw fail('Proposal is already within the policy limits');
      const result = db.prepare(`INSERT INTO pricing_exceptions(company_id,gstin_id,branch_id,party_id,item_id,price_date,rule_id,proposed_rate_cents,proposed_discount_bps,baseline_json,reason,client_reference,payload_json,requested_by)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(req.company.id, scopedBranch.gstin_id, scopedBranch.id, baseline.partyId, baseline.itemId, baseline.priceDate, baseline.rule.id,
        proposedRateCents, proposedDiscountBps, JSON.stringify(baseline), reason, clientReference, JSON.stringify(payload), req.user.id);
      const row = exceptionById(req, result.lastInsertRowid);
      event('pricing_exception_events', req, row.id, 'requested', { baseline, proposedRateCents, proposedDiscountBps, reason });
      return { exception: exception(row), replayed: false };
    });
  }));
  app.post('/api/pricing/exceptions/:id/decision', route(req => {
    manager(req);
    const row = exceptionById(req, req.params.id);
    const decision = req.body?.decision;
    if (!['approved', 'rejected'].includes(decision)) throw fail('decision must be approved or rejected');
    const reason = words(req.body?.reason, 'reason', 500);
    if (row.status !== 'pending') {
      if (row.status === decision && row.decision_reason === reason) return { exception: exception(row), replayed: true };
      throw fail('Exception already decided', 409);
    }
    if (decision === 'approved') {
      if (row.price_date < new Date().toISOString().slice(0, 10)) throw fail('Past price dates cannot receive a new approval', 409);
      const current = quote(req, row.item_id, row.party_id, row.price_date);
      if (!current.hasPolicy || current.rule.id !== row.rule_id) throw fail('Applicable pricing policy changed; request a new exception', 409);
      if (row.requested_by === req.user.id) throw fail('Requester cannot approve their own exception', 403);
    }
    return atomic(db, () => {
      db.prepare('UPDATE pricing_exceptions SET status=?,decided_by=?,decided_at=CURRENT_TIMESTAMP,decision_reason=? WHERE id=? AND company_id=?')
        .run(decision, req.user.id, reason, row.id, req.company.id);
      const updated = exceptionById(req, row.id);
      event('pricing_exception_events', req, row.id, decision, { reason, proposedRateCents: row.proposed_rate_cents, proposedDiscountBps: row.proposed_discount_bps });
      return { exception: exception(updated), replayed: false };
    });
  }));
  app.get('/api/pricing/audit', route(req => {
    manager(req);
    return { ruleEvents: db.prepare('SELECT * FROM pricing_rule_events WHERE company_id=? ORDER BY id DESC LIMIT 100').all(req.company.id).map(row => ({ ...camel(row), detail: JSON.parse(row.detail_json), detailJson: undefined })),
      exceptionEvents: db.prepare('SELECT * FROM pricing_exception_events WHERE company_id=? ORDER BY id DESC LIMIT 100').all(req.company.id).map(row => ({ ...camel(row), detail: JSON.parse(row.detail_json), detailJson: undefined })) };
  }));
}

module.exports = { registerPricingRoutes };
