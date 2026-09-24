const { installLocationsSchema } = require('./locations-db.cjs');
const { seedLocationsDemo } = require('./locations-demo.cjs');
const { assertScopeAccess } = require('./access.cjs');

const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const positive = (value, name) => {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) throw fail(`${name} must be a positive integer`);
  return number;
};
const words = (value, name, max = 200) => {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw fail(`${name} is invalid`);
  return value.trim();
};
const camel = row => Object.fromEntries(Object.entries(row).map(([key, value]) =>
  [key.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase()), value]));
const atomic = (db, action) => {
  db.exec('SAVEPOINT locations_action');
  try { const result = action(); db.exec('RELEASE locations_action'); return result; }
  catch (error) { db.exec('ROLLBACK TO locations_action'); db.exec('RELEASE locations_action'); throw error; }
};

function registerLocationsRoutes(app, db) {
  installLocationsSchema(db);
  seedLocationsDemo(db);
  const route = handler => (req, res, next) => { try { res.json(handler(req)); } catch (error) { next(error); } };
  const actor = req => {
    if (!['staff', 'admin'].includes(req.user.role)) throw fail('Storekeeper or company admin role required', 403);
  };
  const locationRow = (req, id) => {
    const row = db.prepare('SELECT * FROM locations WHERE id=? AND company_id=?').get(positive(id, 'locationId'), req.company.id);
    if (!row) throw fail('Location not found in selected company', 404);
    assertScopeAccess(db, { companyId: req.company.id, userId: req.user.id, gstinId: row.gstin_id, branchId: row.branch_id });
    return row;
  };
  const itemRow = (req, id) => {
    const row = db.prepare('SELECT * FROM items WHERE id=? AND company_id=?').get(positive(id, 'itemId'), req.company.id);
    if (!row) throw fail('Item not found in selected company', 404);
    if (!row.track_stock) throw fail('Service items cannot be assigned to locations');
    return row;
  };
  const physical = (companyId, branchId, itemId) => db.prepare('SELECT COALESCE(SUM(quantity_delta),0) AS quantity FROM stock_movements WHERE company_id=? AND branch_id=? AND item_id=?').get(companyId, branchId, itemId).quantity;
  const allocated = (companyId, branchId, itemId) => db.prepare(`SELECT COALESCE(SUM(m.quantity_delta),0) AS quantity FROM location_movements m
    JOIN locations l ON l.id=m.location_id WHERE m.company_id=? AND l.branch_id=? AND m.item_id=?`).get(companyId, branchId, itemId).quantity;
  const atLocation = (id, itemId) => db.prepare('SELECT COALESCE(SUM(quantity_delta),0) AS quantity FROM location_movements WHERE location_id=? AND item_id=?').get(id, itemId).quantity;
  const unbatched = (companyId, branchId, itemId) => physical(companyId, branchId, itemId) - db.prepare(`SELECT COALESCE(SUM(m.quantity_delta),0) AS quantity FROM batch_movements m
    JOIN batch_lots l ON l.id=m.batch_id WHERE m.company_id=? AND m.branch_id=? AND l.item_id=?`).get(companyId, branchId, itemId).quantity;
  const movement = (req, location, itemId, quantity, type, transferId, reason) => Number(db.prepare(`INSERT INTO location_movements
    (company_id,location_id,item_id,quantity_delta,type,transfer_id,reason,actor_id) VALUES (?,?,?,?,?,?,?,?)`)
    .run(req.company.id, location.id, itemId, quantity, type, transferId, reason, req.user.id).lastInsertRowid);
  const physicalMovement = (req, location, itemId, quantity, type, reference) => db.prepare(`INSERT INTO stock_movements
    (company_id,branch_id,item_id,quantity_delta,type,reason,client_reference) VALUES (?,?,?,?,?,?,?)`)
    .run(req.company.id, location.branch_id, itemId, quantity, type, reference, `location:${type}:${reference}`);
  const transferRow = (req, id) => {
    const row = db.prepare('SELECT * FROM location_transfers WHERE id=? AND company_id=?').get(positive(id, 'transferId'), req.company.id);
    if (!row) throw fail('Transfer not found in selected company', 404);
    const source = locationRow(req, row.source_location_id);
    const destination = locationRow(req, row.destination_location_id);
    return { row, source, destination };
  };
  const detail = row => {
    const source = db.prepare('SELECT branch_id,gstin_id,name FROM locations WHERE id=?').get(row.source_location_id);
    const destination = db.prepare('SELECT branch_id,gstin_id,name FROM locations WHERE id=?').get(row.destination_location_id);
    return { ...camel(row), sourceLocationName: source.name, destinationLocationName: destination.name,
      sourceBranchId: source.branch_id, destinationBranchId: destination.branch_id,
      sourceGstinId: source.gstin_id, destinationGstinId: destination.gstin_id,
      taxBoundary: source.gstin_id === destination.gstin_id ? 'same_gstin' : 'inter_gstin',
      inTransitQuantity: row.status === 'draft' ? 0 : row.quantity - row.received_quantity,
      documentLimit: source.gstin_id === destination.gstin_id ? 'Internal transfer note; transport requirements require separate review.' :
        'Distinct GST registrations: tax invoice, valuation and transport document review are not implemented. Dispatch is blocked.' };
  };
  const event = (req, transferId, action, quantity, evidenceReference = null) => db.prepare(`INSERT INTO location_events
    (company_id,transfer_id,action,actor_id,quantity,evidence_reference) VALUES (?,?,?,?,?,?)`)
    .run(req.company.id, transferId, action, req.user.id, quantity, evidenceReference);

  app.get('/api/locations', route(req => {
    const branchId = req.query.branchId === undefined ? null : positive(req.query.branchId, 'branchId');
    if (branchId !== null) {
      const branch = db.prepare('SELECT gstin_id FROM branches WHERE id=? AND company_id=?').get(branchId, req.company.id);
      if (!branch) throw fail('Branch not found in selected company', 404);
      assertScopeAccess(db, { companyId: req.company.id, userId: req.user.id, gstinId: branch.gstin_id, branchId });
    }
    const visible = req.scopes.branchIds;
    const rows = db.prepare(`SELECT * FROM locations WHERE company_id=? AND branch_id IN (${visible.map(() => '?').join(',') || 'NULL'})
      AND (? IS NULL OR branch_id=?) ORDER BY branch_id,parent_id,id`).all(req.company.id, ...visible, branchId, branchId);
    return { locations: rows.map(camel) };
  }));
  app.get('/api/locations/availability', route(req => {
    const branchId = req.query.branchId === undefined ? null : positive(req.query.branchId, 'branchId');
    if (branchId !== null) {
      const branch = db.prepare('SELECT gstin_id FROM branches WHERE id=? AND company_id=?').get(branchId, req.company.id);
      if (!branch) throw fail('Branch not found in selected company', 404);
      assertScopeAccess(db, { companyId: req.company.id, userId: req.user.id, gstinId: branch.gstin_id, branchId });
    }
    const visible = req.scopes.branchIds;
    const rows = db.prepare(`SELECT l.id AS location_id,l.name AS location_name,l.kind,l.branch_id,l.gstin_id,
      i.id AS item_id,i.sku,i.name AS item_name,SUM(m.quantity_delta) AS quantity
      FROM location_movements m JOIN locations l ON l.id=m.location_id JOIN items i ON i.id=m.item_id
      WHERE m.company_id=? AND l.branch_id IN (${visible.map(() => '?').join(',') || 'NULL'})
      AND (? IS NULL OR l.branch_id=?) GROUP BY l.id,i.id HAVING quantity<>0 ORDER BY l.branch_id,l.id,i.name`)
      .all(req.company.id, ...visible, branchId, branchId);
    return { availability: rows.map(row => {
      const assignedBranchQuantity = allocated(req.company.id, row.branch_id, row.item_id);
      const unbatchedPhysicalQuantity = unbatched(req.company.id, row.branch_id, row.item_id);
      return { ...camel(row), assignedBranchQuantity, unbatchedPhysicalQuantity,
        reconciliationRequired: assignedBranchQuantity > unbatchedPhysicalQuantity };
    }) };
  }));
  app.get('/api/locations/:id', route(req => {
    const row = locationRow(req, req.params.id);
    const balances = db.prepare(`SELECT i.id AS item_id,i.sku,i.name AS item_name,SUM(m.quantity_delta) AS quantity
      FROM location_movements m JOIN items i ON i.id=m.item_id WHERE m.location_id=? GROUP BY i.id HAVING quantity<>0 ORDER BY i.name`).all(row.id);
    return { location: camel(row), balances: balances.map(camel) };
  }));
  app.post('/api/locations', route(req => atomic(db, () => {
    actor(req);
    const body = req.body || {};
    const branchId = positive(body.branchId, 'branchId');
    const branch = db.prepare('SELECT * FROM branches WHERE id=? AND company_id=?').get(branchId, req.company.id);
    if (!branch) throw fail('Branch not found in selected company', 404);
    assertScopeAccess(db, { companyId: req.company.id, userId: req.user.id, gstinId: branch.gstin_id, branchId });
    const kind = words(body.kind, 'kind', 20);
    if (!['warehouse', 'store', 'rack'].includes(kind)) throw fail('kind must be warehouse, store or rack');
    const name = words(body.name, 'name', 100);
    const parentId = body.parentId === undefined || body.parentId === null ? null : positive(body.parentId, 'parentId');
    if (kind === 'warehouse' && parentId !== null) throw fail('A warehouse must be a root location');
    if (kind !== 'warehouse' && parentId === null) throw fail('Stores need a warehouse; racks need a store');
    if (parentId !== null) {
      const parent = locationRow(req, parentId);
      if (parent.branch_id !== branchId) throw fail('Parent must belong to the same branch');
      if (!parent.active) throw fail('Parent location is inactive', 409);
      if (parent.kind !== (kind === 'store' ? 'warehouse' : 'store')) throw fail('Location hierarchy must be warehouse → store → rack');
    }
    const id = Number(db.prepare(`INSERT INTO locations(company_id,gstin_id,branch_id,parent_id,kind,name,created_by)
      VALUES (?,?,?,?,?,?,?)`).run(req.company.id, branch.gstin_id, branchId, parentId, kind, name, req.user.id).lastInsertRowid);
    return { location: camel(db.prepare('SELECT * FROM locations WHERE id=?').get(id)) };
  })));
  app.post('/api/location-assignments', route(req => atomic(db, () => {
    actor(req);
    const body = req.body || {};
    const location = locationRow(req, body.locationId);
    if (!location.active) throw fail('Location is inactive', 409);
    const item = itemRow(req, body.itemId);
    const quantity = positive(body.quantity, 'quantity');
    const reason = words(body.reason, 'reason', 500);
    const clientReference = words(body.clientReference, 'clientReference', 100);
    const signature = JSON.stringify({ locationId: location.id, itemId: item.id, quantity, reason });
    const existing = db.prepare('SELECT * FROM location_assignments WHERE company_id=? AND client_reference=?').get(req.company.id, clientReference);
    if (existing) {
      if (existing.signature !== signature) throw fail('Reference already used for a different assignment', 409);
      return { assignment: camel(existing), replayed: true };
    }
    const unallocated = unbatched(req.company.id, location.branch_id, item.id) - allocated(req.company.id, location.branch_id, item.id);
    if (quantity > unallocated) throw fail('Insufficient unbatched stock that is not already assigned to a location', 409);
    const movementId = movement(req, location, item.id, quantity, 'assignment', null, reason);
    const id = Number(db.prepare(`INSERT INTO location_assignments
      (company_id,location_id,item_id,quantity,reason,client_reference,signature,movement_id,created_by)
      VALUES (?,?,?,?,?,?,?,?,?)`).run(req.company.id, location.id, item.id, quantity, reason, clientReference, signature, movementId, req.user.id).lastInsertRowid);
    return { assignment: camel(db.prepare('SELECT * FROM location_assignments WHERE id=?').get(id)), replayed: false };
  })));
  app.get('/api/location-transfers', route(req => {
    const visible = req.scopes.branchIds;
    const rows = db.prepare(`SELECT t.* FROM location_transfers t
      JOIN locations s ON s.id=t.source_location_id JOIN locations d ON d.id=t.destination_location_id
      WHERE t.company_id=? AND s.branch_id IN (${visible.map(() => '?').join(',') || 'NULL'})
      AND d.branch_id IN (${visible.map(() => '?').join(',') || 'NULL'}) ORDER BY t.id DESC LIMIT 200`)
      .all(req.company.id, ...visible, ...visible);
    return { transfers: rows.map(detail) };
  }));
  app.get('/api/location-transfers/:id', route(req => {
    const { row } = transferRow(req, req.params.id);
    return { transfer: detail(row), receipts: db.prepare('SELECT * FROM location_receipts WHERE transfer_id=? ORDER BY id').all(row.id).map(camel),
      events: db.prepare('SELECT * FROM location_events WHERE transfer_id=? ORDER BY id').all(row.id).map(camel) };
  }));
  app.post('/api/location-transfers', route(req => atomic(db, () => {
    actor(req);
    const body = req.body || {};
    const source = locationRow(req, body.sourceLocationId);
    const destination = locationRow(req, body.destinationLocationId);
    if (!source.active || !destination.active) throw fail('Both locations must be active', 409);
    if (source.id === destination.id) throw fail('Source and destination must differ');
    const item = itemRow(req, body.itemId);
    const quantity = positive(body.quantity, 'quantity');
    const reason = words(body.reason, 'reason', 500);
    const clientReference = words(body.clientReference, 'clientReference', 100);
    const signature = JSON.stringify({ sourceLocationId: source.id, destinationLocationId: destination.id, itemId: item.id, quantity, reason });
    const existing = db.prepare('SELECT * FROM location_transfers WHERE company_id=? AND client_reference=?').get(req.company.id, clientReference);
    if (existing) {
      if (existing.signature !== signature) throw fail('Reference already used for a different transfer', 409);
      return { transfer: detail(existing), replayed: true };
    }
    if (atLocation(source.id, item.id) < quantity) throw fail('Insufficient source location stock', 409);
    const id = Number(db.prepare(`INSERT INTO location_transfers
      (company_id,source_location_id,destination_location_id,item_id,quantity,reason,client_reference,signature,created_by)
      VALUES (?,?,?,?,?,?,?,?,?)`).run(req.company.id, source.id, destination.id, item.id, quantity, reason, clientReference, signature, req.user.id).lastInsertRowid);
    event(req, id, 'create', quantity);
    return { transfer: detail(db.prepare('SELECT * FROM location_transfers WHERE id=?').get(id)), replayed: false };
  })));
  app.post('/api/location-transfers/:id/dispatch', route(req => atomic(db, () => {
    actor(req);
    const { row, source, destination } = transferRow(req, req.params.id);
    const evidenceReference = words((req.body || {}).evidenceReference, 'evidenceReference', 160);
    if (row.status !== 'draft') {
      if (row.dispatch_evidence_reference !== evidenceReference) throw fail('Dispatch already recorded with different evidence', 409);
      return { transfer: detail(row), replayed: true };
    }
    if (source.gstin_id !== destination.gstin_id) throw fail('Inter-GSTIN dispatch requires a reviewed tax invoice, valuation and transport document workflow that is not implemented', 409);
    if (atLocation(source.id, row.item_id) < row.quantity) throw fail('Insufficient source location stock', 409);
    if (physical(req.company.id, source.branch_id, row.item_id) < row.quantity) throw fail('Insufficient physical branch stock', 409);
    if (unbatched(req.company.id, source.branch_id, row.item_id) < row.quantity) throw fail('Location transfer currently requires enough unbatched stock; batch-specific dispatch is not implemented', 409);
    movement(req, source, row.item_id, -row.quantity, 'transfer_dispatch', row.id, row.reason);
    physicalMovement(req, source, row.item_id, -row.quantity, 'location_dispatch', `transfer:${row.id}:dispatch`);
    db.prepare(`UPDATE location_transfers SET status='dispatched',dispatch_evidence_reference=?,dispatched_by=?,dispatched_at=CURRENT_TIMESTAMP WHERE id=?`)
      .run(evidenceReference, req.user.id, row.id);
    event(req, row.id, 'dispatch', row.quantity, evidenceReference);
    return { transfer: detail(db.prepare('SELECT * FROM location_transfers WHERE id=?').get(row.id)), replayed: false };
  })));
  app.post('/api/location-transfers/:id/receive', route(req => atomic(db, () => {
    actor(req);
    const { row, destination } = transferRow(req, req.params.id);
    const body = req.body || {};
    const quantity = positive(body.quantity, 'quantity');
    const evidenceReference = words(body.evidenceReference, 'evidenceReference', 160);
    const clientReference = words(body.clientReference, 'clientReference', 100);
    const signature = JSON.stringify({ quantity, evidenceReference });
    const existing = db.prepare('SELECT * FROM location_receipts WHERE company_id=? AND transfer_id=? AND client_reference=?').get(req.company.id, row.id, clientReference);
    if (existing) {
      if (existing.signature !== signature) throw fail('Reference already used for a different receipt', 409);
      return { transfer: detail(row), receipt: camel(existing), replayed: true };
    }
    if (!['dispatched', 'partial_received'].includes(row.status)) throw fail('Transfer must be dispatched with quantity in transit', 409);
    if (quantity > row.quantity - row.received_quantity) throw fail('Receipt exceeds in-transit quantity', 409);
    const movementId = movement(req, destination, row.item_id, quantity, 'transfer_receive', row.id, row.reason);
    physicalMovement(req, destination, row.item_id, quantity, 'location_receipt', `transfer:${row.id}:receipt:${clientReference}`);
    const id = Number(db.prepare(`INSERT INTO location_receipts
      (company_id,transfer_id,quantity,evidence_reference,client_reference,signature,movement_id,received_by)
      VALUES (?,?,?,?,?,?,?,?)`).run(req.company.id, row.id, quantity, evidenceReference, clientReference, signature, movementId, req.user.id).lastInsertRowid);
    const totalReceived = row.received_quantity + quantity;
    db.prepare('UPDATE location_transfers SET received_quantity=?,status=? WHERE id=?')
      .run(totalReceived, totalReceived === row.quantity ? 'received' : 'partial_received', row.id);
    event(req, row.id, 'receive', quantity, evidenceReference);
    return { transfer: detail(db.prepare('SELECT * FROM location_transfers WHERE id=?').get(row.id)),
      receipt: camel(db.prepare('SELECT * FROM location_receipts WHERE id=?').get(id)), replayed: false };
  })));
}

module.exports = { registerLocationsRoutes };
