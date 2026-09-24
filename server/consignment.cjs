const { installConsignmentSchema, seedConsignmentDemo } = require('./consignment-db.cjs');
const { installLocationsSchema } = require('./locations-db.cjs');
const { assertScopeAccess } = require('./access.cjs');

const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const id = (value, name) => {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) throw fail(`${name} must be a positive integer`);
  return number;
};
const nonnegative = (value, name) => {
  if (!Number.isSafeInteger(value) || value < 0) throw fail(`${name} must be a nonnegative integer`);
  return value;
};
const words = (value, name, max = 500) => {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw fail(`${name} is invalid`);
  return value.trim();
};
const camel = row => Object.fromEntries(Object.entries(row).map(([key, value]) =>
  [key.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase()), value]));
const atomic = (db, action) => {
  db.exec('SAVEPOINT consignment_action');
  try { const result = action(); db.exec('RELEASE consignment_action'); return result; }
  catch (error) { db.exec('ROLLBACK TO consignment_action'); db.exec('RELEASE consignment_action'); throw error; }
};

function registerConsignmentRoutes(app, db) {
  installConsignmentSchema(db);
  installLocationsSchema(db);
  const route = handler => (req, res, next) => { try { res.json(handler(req)); } catch (error) { next(error); } };
  const storekeeper = req => {
    if (!['staff', 'admin'].includes(req.user.role)) throw fail('Storekeeper or company admin role required', 403);
  };
  const reviewer = req => {
    if (!['accountant', 'admin'].includes(req.user.role)) throw fail('Accountant or company admin role required', 403);
  };
  const scope = (req, gstinId, branchId) => assertScopeAccess(db, {
    companyId: req.company.id, userId: req.user.id, gstinId, branchId,
  });
  const record = (req, value) => {
    const row = db.prepare('SELECT * FROM consignments WHERE id=? AND company_id=?')
      .get(id(value, 'consignmentId'), req.company.id);
    if (!row) throw fail('Consignment not found in selected company', 404);
    scope(req, row.gstin_id, row.branch_id);
    return row;
  };
  const event = (req, row, action, quantity, details) => db.prepare(`INSERT INTO consignment_events
    (consignment_id,company_id,action,actor_id,quantity,details) VALUES (?,?,?,?,?,?)`)
    .run(row.id, req.company.id, action, req.user.id, quantity, details);
  const totals = row => {
    const returned = db.prepare('SELECT COALESCE(SUM(quantity),0) AS n FROM consignment_returns WHERE consignment_id=?').get(row.id).n;
    const reserved = db.prepare(`SELECT COALESCE(SUM(quantity),0) AS n FROM consignment_settlements
      WHERE consignment_id=? AND status IN ('pending','reviewed_pending_document')`).get(row.id).n;
    const custody = row.status === 'draft' ? 0 : row.quantity - returned;
    return { returnedQuantity: returned, custodyQuantity: custody, settlementReservedQuantity: reserved,
      returnableQuantity: custody - reserved };
  };
  const detail = row => ({ ...camel(row), ...totals(row),
    custodian: row.status === 'draft' ? 'not_transferred' : row.direction === 'outgoing' ? 'party' : 'company',
    settlementEffect: 'reviewed_proposal_only_pending_commercial_tax_and_ledger_documents',
    ownershipEffect: 'none_until_separate_documented_transaction',
    stockEffect: row.direction === 'outgoing' ? 'unbatched_saleable_physical_stock_only' : 'custody_only_no_owned_stock',
  });
  const stock = (companyId, branchId, itemId) => db.prepare(`SELECT COALESCE(SUM(quantity_delta),0) AS n FROM stock_movements
    WHERE company_id=? AND branch_id=? AND item_id=?`).get(companyId, branchId, itemId).n;
  const unbatched = (companyId, branchId, itemId) => stock(companyId, branchId, itemId) -
    db.prepare(`SELECT COALESCE(SUM(m.quantity_delta),0) AS n FROM batch_movements m JOIN batch_lots l ON l.id=m.batch_id
      WHERE m.company_id=? AND m.branch_id=? AND l.item_id=?`).get(companyId, branchId, itemId).n;
  const allocated = (companyId, branchId, itemId) => db.prepare(`SELECT COALESCE(SUM(m.quantity_delta),0) AS n
    FROM location_movements m JOIN locations l ON l.id=m.location_id
    WHERE m.company_id=? AND l.branch_id=? AND m.item_id=?`).get(companyId, branchId, itemId).n;
  const physicalMovement = (req, row, quantity, type, reference) => db.prepare(`INSERT INTO stock_movements
    (company_id,branch_id,item_id,quantity_delta,type,reason,client_reference) VALUES (?,?,?,?,?,?,?)`)
    .run(req.company.id, row.branch_id, row.item_id, quantity, type,
      `Consignment ${row.reference}; owner remains company; no invoice or tax posted`, reference);

  app.get('/api/consignments', route(req => {
    const branchId = req.query.branchId === undefined ? null : id(req.query.branchId, 'branchId');
    if (branchId !== null) {
      const branch = db.prepare('SELECT * FROM branches WHERE id=? AND company_id=?').get(branchId, req.company.id);
      if (!branch) throw fail('Branch not found in selected company', 404);
      scope(req, branch.gstin_id, branchId);
    }
    const visible = req.scopes.branchIds;
    const rows = db.prepare(`SELECT * FROM consignments WHERE company_id=? AND branch_id IN (${visible.map(() => '?').join(',') || 'NULL'})
      AND (? IS NULL OR branch_id=?) ORDER BY id DESC LIMIT 200`).all(req.company.id, ...visible, branchId, branchId);
    return { consignments: rows.map(detail) };
  }));

  app.get('/api/consignments/:id', route(req => {
    const row = record(req, req.params.id);
    return { consignment: detail(row),
      returns: db.prepare('SELECT * FROM consignment_returns WHERE consignment_id=? ORDER BY id').all(row.id).map(camel),
      settlements: db.prepare('SELECT * FROM consignment_settlements WHERE consignment_id=? ORDER BY id').all(row.id).map(camel),
      events: db.prepare('SELECT * FROM consignment_events WHERE consignment_id=? ORDER BY id').all(row.id).map(camel) };
  }));

  app.post('/api/consignments', route(req => atomic(db, () => {
    storekeeper(req);
    const body = req.body || {};
    const gstinId = id(body.gstinId, 'gstinId');
    const branchId = id(body.branchId, 'branchId');
    scope(req, gstinId, branchId);
    const partyId = id(body.partyId, 'partyId');
    const itemId = id(body.itemId, 'itemId');
    const party = db.prepare('SELECT * FROM parties WHERE id=? AND company_id=?').get(partyId, req.company.id);
    const item = db.prepare('SELECT * FROM items WHERE id=? AND company_id=?').get(itemId, req.company.id);
    if (!party || !item || !item.active || !item.track_stock) throw fail('Active tracked item and party in selected company required', 404);
    const direction = words(body.direction, 'direction', 12);
    if (!['incoming', 'outgoing'].includes(direction)) throw fail('direction must be incoming or outgoing');
    if (direction === 'incoming' && !['supplier','both'].includes(party.type)) throw fail('Incoming consignment requires a supplier party');
    if (direction === 'outgoing' && !['customer','both'].includes(party.type)) throw fail('Outgoing consignment requires a customer party');
    const reference = words(body.reference, 'reference', 100);
    const quantity = id(body.quantity, 'quantity');
    const reason = words(body.reason, 'reason');
    const existing = db.prepare('SELECT * FROM consignments WHERE company_id=? AND reference=?').get(req.company.id, reference);
    if (existing) throw fail('Consignment reference already exists', 409);
    const ownerKind = direction === 'outgoing' ? 'company' : 'party';
    const result = db.prepare(`INSERT INTO consignments(company_id,gstin_id,branch_id,party_id,item_id,direction,reference,
      quantity,owner_kind,party_name_snapshot,item_name_snapshot,reason,created_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(req.company.id, gstinId, branchId, partyId, itemId, direction, reference, quantity, ownerKind,
        party.name, item.name, reason, req.user.id);
    const row = record(req, Number(result.lastInsertRowid));
    event(req, row, 'create', quantity, reason);
    return { consignment: detail(row) };
  })));

  app.post('/api/consignments/:id/activate', route(req => atomic(db, () => {
    storekeeper(req);
    const row = record(req, req.params.id);
    const evidence = words(req.body?.evidenceReference, 'evidenceReference', 150);
    if (row.status === 'active') {
      if (row.activation_evidence !== evidence) throw fail('Activation already recorded with different evidence', 409);
      return { consignment: detail(row), replayed: true };
    }
    if (row.direction === 'outgoing') {
      const available = unbatched(req.company.id, row.branch_id, row.item_id) - allocated(req.company.id, row.branch_id, row.item_id);
      if (row.quantity > available) throw fail('Insufficient unbatched, unallocated saleable stock for consignment dispatch', 409);
      physicalMovement(req, row, -row.quantity, 'consignment_out_dispatch', `consignment:${row.id}:dispatch`);
    }
    db.prepare(`UPDATE consignments SET status='active',activated_by=?,activated_at=CURRENT_TIMESTAMP,activation_evidence=? WHERE id=?`)
      .run(req.user.id, evidence, row.id);
    event(req, row, 'activate', row.quantity, `${row.direction === 'outgoing' ? 'Dispatch' : 'Receipt'} evidence: ${evidence}`);
    return { consignment: detail(record(req, row.id)), replayed: false };
  })));

  app.post('/api/consignments/:id/returns', route(req => atomic(db, () => {
    storekeeper(req);
    const row = record(req, req.params.id);
    const body = req.body || {};
    const quantity = id(body.quantity, 'quantity');
    const evidence = words(body.evidenceReference, 'evidenceReference', 150);
    const clientReference = words(body.clientReference, 'clientReference', 100);
    const signature = JSON.stringify({ consignmentId: row.id, quantity, evidence });
    const existing = db.prepare('SELECT * FROM consignment_returns WHERE company_id=? AND client_reference=?').get(req.company.id, clientReference);
    if (existing) {
      if (existing.signature !== signature) throw fail('Return reference already used with different details', 409);
      return { return: camel(existing), consignment: detail(row), replayed: true };
    }
    if (row.status !== 'active') throw fail('Activate dispatch or receipt before recording a return', 409);
    if (quantity > totals(row).returnableQuantity) throw fail('Return exceeds unreserved consignment custody', 409);
    if (row.direction === 'outgoing') physicalMovement(req, row, quantity, 'consignment_out_unsold_return', `consignment:${row.id}:return:${clientReference}`);
    const result = db.prepare(`INSERT INTO consignment_returns
      (consignment_id,company_id,quantity,evidence_reference,client_reference,signature,created_by) VALUES (?,?,?,?,?,?,?)`)
      .run(row.id, req.company.id, quantity, evidence, clientReference, signature, req.user.id);
    event(req, row, 'unsold_return', quantity, evidence);
    return { return: camel(db.prepare('SELECT * FROM consignment_returns WHERE id=?').get(Number(result.lastInsertRowid))),
      consignment: detail(row), replayed: false };
  })));

  app.post('/api/consignments/:id/settlements', route(req => atomic(db, () => {
    storekeeper(req);
    const row = record(req, req.params.id);
    const body = req.body || {};
    const quantity = id(body.quantity, 'quantity');
    const price = nonnegative(body.proposedUnitPriceCents, 'proposedUnitPriceCents');
    if (!Number.isSafeInteger(quantity * price)) throw fail('Proposed amount exceeds supported limit');
    const reason = words(body.reason, 'reason');
    const clientReference = words(body.clientReference, 'clientReference', 100);
    const signature = JSON.stringify({ consignmentId: row.id, quantity, price, reason });
    const existing = db.prepare('SELECT * FROM consignment_settlements WHERE company_id=? AND client_reference=?').get(req.company.id, clientReference);
    if (existing) {
      if (existing.signature !== signature) throw fail('Settlement reference already used with different details', 409);
      return { settlement: camel(existing), consignment: detail(row), replayed: true };
    }
    if (row.status !== 'active') throw fail('Activate dispatch or receipt before settlement proposal', 409);
    if (quantity > totals(row).returnableQuantity) throw fail('Proposal exceeds unreserved consignment custody', 409);
    const result = db.prepare(`INSERT INTO consignment_settlements
      (consignment_id,company_id,quantity,proposed_unit_price_cents,reason,client_reference,signature,proposed_by)
      VALUES (?,?,?,?,?,?,?,?)`).run(row.id, req.company.id, quantity, price, reason, clientReference, signature, req.user.id);
    event(req, row, 'settlement_propose', quantity, reason);
    return { settlement: camel(db.prepare('SELECT * FROM consignment_settlements WHERE id=?').get(Number(result.lastInsertRowid))),
      consignment: detail(row), replayed: false };
  })));

  app.post('/api/consignments/:id/settlements/:settlementId/review', route(req => atomic(db, () => {
    reviewer(req);
    const row = record(req, req.params.id);
    const settlement = db.prepare('SELECT * FROM consignment_settlements WHERE id=? AND company_id=? AND consignment_id=?')
      .get(id(req.params.settlementId, 'settlementId'), req.company.id, row.id);
    if (!settlement) throw fail('Settlement not found in selected consignment', 404);
    const decision = words(req.body?.decision, 'decision', 10);
    if (!['approve', 'reject'].includes(decision)) throw fail('decision must be approve or reject');
    const reason = words(req.body?.reason, 'reason');
    const status = decision === 'approve' ? 'reviewed_pending_document' : 'rejected';
    if (settlement.status !== 'pending') {
      if (settlement.status !== status || settlement.review_reason !== reason) throw fail('Settlement already reviewed with a different decision', 409);
      return { settlement: camel(settlement), consignment: detail(row), replayed: true };
    }
    if (settlement.proposed_by === req.user.id) throw fail('Settlement proposer cannot review their own proposal', 403);
    db.prepare(`UPDATE consignment_settlements SET status=?,reviewed_by=?,reviewed_at=CURRENT_TIMESTAMP,review_reason=? WHERE id=?`)
      .run(status, req.user.id, reason, settlement.id);
    event(req, row, 'settlement_review', settlement.quantity, `${decision}: ${reason}; no invoice, tax, ledger or ownership transfer posted`);
    return { settlement: camel(db.prepare('SELECT * FROM consignment_settlements WHERE id=?').get(settlement.id)),
      consignment: detail(row), replayed: false };
  })));
}

module.exports = { registerConsignmentRoutes, seedConsignmentDemo };
