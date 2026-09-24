const { installLocationsSchema } = require('./locations-db.cjs');

function seedLocationsDemo(db) {
  installLocationsSchema(db);
  const companyId = 1;
  const actorId = 1;
  if (!db.prepare('SELECT 1 FROM users WHERE id=? AND company_id=?').get(actorId, companyId)) return;
  const places = [
    { key: 'mumbai', branchId: 1, gstinId: 1, kind: 'warehouse', name: 'DEMO Mumbai medical godown' },
    { key: 'dispatch', branchId: 1, gstinId: 1, kind: 'store', name: 'DEMO Dispatch store', parent: 'mumbai' },
    { key: 'rack', branchId: 1, gstinId: 1, kind: 'rack', name: 'DEMO Rack A-01', parent: 'dispatch' },
    { key: 'pune', branchId: 2, gstinId: 1, kind: 'warehouse', name: 'DEMO Pune receiving godown' },
  ];
  db.exec('SAVEPOINT locations_demo');
  try {
    const ids = {};
    for (const place of places) {
      const parentId = place.parent ? ids[place.parent] : null;
      let row = db.prepare('SELECT id FROM locations WHERE company_id=? AND branch_id=? AND kind=? AND name=? AND parent_id IS ?')
        .get(companyId, place.branchId, place.kind, place.name, parentId);
      if (!row) {
        const id = Number(db.prepare('INSERT INTO locations(company_id,gstin_id,branch_id,parent_id,kind,name,created_by) VALUES (?,?,?,?,?,?,?)')
          .run(companyId, place.gstinId, place.branchId, parentId, place.kind, place.name, actorId).lastInsertRowid);
        row = { id };
      }
      ids[place.key] = row.id;
    }

    const assignmentRef = 'DEMO-LOC-COUNT-001';
    const itemId = 1, quantity = 6;
    if (!db.prepare('SELECT 1 FROM location_assignments WHERE company_id=? AND client_reference=?').get(companyId, assignmentRef)) {
      const physical = db.prepare('SELECT COALESCE(SUM(quantity_delta),0) AS q FROM stock_movements WHERE company_id=? AND branch_id=? AND item_id=?')
        .get(companyId, 1, itemId).q;
      const allocated = db.prepare('SELECT COALESCE(SUM(m.quantity_delta),0) AS q FROM location_movements m JOIN locations l ON l.id=m.location_id WHERE m.company_id=? AND l.branch_id=? AND m.item_id=?')
        .get(companyId, 1, itemId).q;
      const batched = db.prepare('SELECT COALESCE(SUM(m.quantity_delta),0) AS q FROM batch_movements m JOIN batch_lots l ON l.id=m.batch_id WHERE m.company_id=? AND m.branch_id=? AND l.item_id=?')
        .get(companyId, 1, itemId).q;
      if (physical - allocated - batched >= quantity) {
        const reason = 'SYNTHETIC DEMO count of existing unbatched branch stock; no new receipt';
        const movementId = Number(db.prepare('INSERT INTO location_movements(company_id,location_id,item_id,quantity_delta,type,reason,actor_id) VALUES (?,?,?,?,?,?,?)')
          .run(companyId, ids.rack, itemId, quantity, 'assignment', reason, actorId).lastInsertRowid);
        const signature = JSON.stringify({ locationId: ids.rack, itemId, quantity, reason });
        db.prepare('INSERT INTO location_assignments(company_id,location_id,item_id,quantity,reason,client_reference,signature,movement_id,created_by) VALUES (?,?,?,?,?,?,?,?,?)')
          .run(companyId, ids.rack, itemId, quantity, reason, assignmentRef, signature, movementId, actorId);
      }
    }

    const transferRef = 'DEMO-LOC-XFER-001';
    if (!db.prepare('SELECT 1 FROM location_transfers WHERE company_id=? AND client_reference=?').get(companyId, transferRef)) {
      const atRack = db.prepare('SELECT COALESCE(SUM(quantity_delta),0) AS q FROM location_movements WHERE location_id=? AND item_id=?').get(ids.rack, itemId).q;
      if (atRack >= 3) {
        const reason = 'SYNTHETIC DEMO replenishment draft; no dispatch or statutory document';
        const signature = JSON.stringify({ sourceLocationId: ids.rack, destinationLocationId: ids.pune, itemId, quantity: 3, reason });
        const transferId = Number(db.prepare('INSERT INTO location_transfers(company_id,source_location_id,destination_location_id,item_id,quantity,reason,client_reference,signature,created_by) VALUES (?,?,?,?,?,?,?,?,?)')
          .run(companyId, ids.rack, ids.pune, itemId, 3, reason, transferRef, signature, actorId).lastInsertRowid);
        db.prepare("INSERT INTO location_events(company_id,transfer_id,action,actor_id,quantity,evidence_reference) VALUES (?,?,'create',?,3,NULL)")
          .run(companyId, transferId, actorId);
      }
    }
    db.exec('RELEASE locations_demo');
  } catch (error) {
    db.exec('ROLLBACK TO locations_demo');
    db.exec('RELEASE locations_demo');
    throw error;
  }
}

module.exports = { seedLocationsDemo };
