function installConsignmentSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS consignments (
      id INTEGER PRIMARY KEY,
      company_id INTEGER NOT NULL REFERENCES companies(id),
      gstin_id INTEGER NOT NULL REFERENCES gstins(id),
      branch_id INTEGER NOT NULL REFERENCES branches(id),
      party_id INTEGER NOT NULL REFERENCES parties(id),
      item_id INTEGER NOT NULL REFERENCES items(id),
      direction TEXT NOT NULL CHECK(direction IN ('outgoing','incoming')),
      reference TEXT NOT NULL,
      quantity INTEGER NOT NULL CHECK(quantity>0),
      status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','active')),
      owner_kind TEXT NOT NULL CHECK(owner_kind IN ('company','party')),
      party_name_snapshot TEXT NOT NULL,
      item_name_snapshot TEXT NOT NULL,
      reason TEXT NOT NULL,
      created_by INTEGER NOT NULL REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      activated_by INTEGER REFERENCES users(id),
      activated_at TEXT,
      activation_evidence TEXT,
      UNIQUE(company_id,reference)
    );
    CREATE INDEX IF NOT EXISTS idx_consignments_scope ON consignments(company_id,gstin_id,branch_id,id);
    CREATE TABLE IF NOT EXISTS consignment_returns (
      id INTEGER PRIMARY KEY,
      consignment_id INTEGER NOT NULL REFERENCES consignments(id),
      company_id INTEGER NOT NULL REFERENCES companies(id),
      quantity INTEGER NOT NULL CHECK(quantity>0),
      evidence_reference TEXT NOT NULL,
      client_reference TEXT NOT NULL,
      signature TEXT NOT NULL,
      created_by INTEGER NOT NULL REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(company_id,client_reference)
    );
    CREATE TABLE IF NOT EXISTS consignment_settlements (
      id INTEGER PRIMARY KEY,
      consignment_id INTEGER NOT NULL REFERENCES consignments(id),
      company_id INTEGER NOT NULL REFERENCES companies(id),
      quantity INTEGER NOT NULL CHECK(quantity>0),
      proposed_unit_price_cents INTEGER NOT NULL CHECK(proposed_unit_price_cents>=0),
      reason TEXT NOT NULL,
      client_reference TEXT NOT NULL,
      signature TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','reviewed_pending_document','rejected')),
      proposed_by INTEGER NOT NULL REFERENCES users(id),
      proposed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      reviewed_by INTEGER REFERENCES users(id),
      reviewed_at TEXT,
      review_reason TEXT,
      UNIQUE(company_id,client_reference)
    );
    CREATE TABLE IF NOT EXISTS consignment_events (
      id INTEGER PRIMARY KEY,
      consignment_id INTEGER NOT NULL REFERENCES consignments(id),
      company_id INTEGER NOT NULL REFERENCES companies(id),
      action TEXT NOT NULL CHECK(action IN ('create','activate','unsold_return','settlement_propose','settlement_review')),
      actor_id INTEGER NOT NULL REFERENCES users(id),
      quantity INTEGER NOT NULL DEFAULT 0,
      details TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_consignment_events ON consignment_events(consignment_id,id);
  `);
}

function seedConsignmentDemo(db) {
  installConsignmentSchema(db);
  require('./locations-db.cjs').installLocationsSchema(db);
  const ids = {
    branch: db.prepare('SELECT id FROM branches WHERE id=1 AND company_id=1 AND gstin_id=1').get()?.id,
    staff: db.prepare("SELECT id FROM users WHERE company_id=1 AND role='staff' ORDER BY id LIMIT 1").get()?.id,
    accountant: db.prepare("SELECT id FROM users WHERE company_id=1 AND role='accountant' ORDER BY id LIMIT 1").get()?.id,
    customer: db.prepare("SELECT id FROM parties WHERE company_id=1 AND name='Harbor Clinic' AND type IN ('customer','both')").get()?.id,
    supplier: db.prepare("SELECT id FROM parties WHERE company_id=1 AND name='Northstar Pharma' AND type IN ('supplier','both')").get()?.id,
    incomingItem: db.prepare("SELECT id FROM items WHERE company_id=1 AND sku='MED-001' AND track_stock=1 AND active=1").get()?.id,
    outgoingItem: db.prepare("SELECT id FROM items WHERE company_id=1 AND sku='SUP-010' AND track_stock=1 AND active=1").get()?.id,
  };
  if (Object.values(ids).some(value => !value)) return { seeded: false, reason: 'synthetic_fixture_scope_missing' };

  db.exec('SAVEPOINT consignment_demo_seed');
  try {
    const event = (recordId, action, actorId, quantity, details) => db.prepare(`INSERT INTO consignment_events
      (consignment_id,company_id,action,actor_id,quantity,details) VALUES (?,1,?,?,?,?)`)
      .run(recordId, action, actorId, quantity, details);
    const insert = ({ reference, direction, partyId, itemId, itemName, partyName, quantity, evidence }) => {
      const existing = db.prepare('SELECT id FROM consignments WHERE company_id=1 AND reference=?').get(reference);
      if (existing) return { id: existing.id, inserted: false };
      const result = db.prepare(`INSERT INTO consignments
        (company_id,gstin_id,branch_id,party_id,item_id,direction,reference,quantity,status,owner_kind,
         party_name_snapshot,item_name_snapshot,reason,created_by,activated_by,activated_at,activation_evidence)
        VALUES (1,1,1,?,?,?,?,?,'active',?,?,?,?,?, ?,CURRENT_TIMESTAMP,?)`)
        .run(partyId, itemId, direction, reference, quantity,
          direction === 'outgoing' ? 'company' : 'party', partyName, itemName,
          'SYNTHETIC DEMO ONLY: consignment custody example', ids.staff, ids.staff, evidence);
      const recordId = Number(result.lastInsertRowid);
      event(recordId, 'create', ids.staff, quantity, 'SYNTHETIC DEMO ONLY: custody record created');
      event(recordId, 'activate', ids.staff, quantity, `SYNTHETIC DEMO ONLY: ${direction === 'outgoing' ? 'dispatch' : 'receipt'} evidence ${evidence}`);
      return { id: recordId, inserted: true };
    };
    const incoming = insert({ reference: 'SYNTHETIC-DEMO-CONSIGN-IN-001', direction: 'incoming',
      partyId: ids.supplier, itemId: ids.incomingItem, partyName: 'Northstar Pharma', itemName: 'Glucose Strips',
      quantity: 8, evidence: 'SYNTHETIC-GRN-CONSIGN-IN-001' });
    if (incoming.inserted) {
      const clientReference = 'SYNTHETIC-CONSIGN-IN-RETURN-001';
      const evidence = 'SYNTHETIC-SUPPLIER-RETURN-001';
      db.prepare(`INSERT INTO consignment_returns
        (consignment_id,company_id,quantity,evidence_reference,client_reference,signature,created_by)
        VALUES (?,1,2,?,?,?,?)`).run(incoming.id, evidence, clientReference,
        JSON.stringify({ consignmentId: incoming.id, quantity: 2, evidence }), ids.staff);
      event(incoming.id, 'unsold_return', ids.staff, 2, `SYNTHETIC DEMO ONLY: ${evidence}`);
      const reason = 'SYNTHETIC DEMO ONLY: proposed use of three supplier-owned units';
      db.prepare(`INSERT INTO consignment_settlements
        (consignment_id,company_id,quantity,proposed_unit_price_cents,reason,client_reference,signature,
         status,proposed_by,reviewed_by,reviewed_at,review_reason)
        VALUES (?,1,3,12500,?,?,?,'reviewed_pending_document',?,?,CURRENT_TIMESTAMP,?)`)
        .run(incoming.id, reason, 'SYNTHETIC-CONSIGN-SETTLEMENT-001',
          JSON.stringify({ consignmentId: incoming.id, quantity: 3, price: 12500, reason }),
          ids.staff, ids.accountant, 'SYNTHETIC DEMO ONLY: internally reviewed; invoice, tax, ledger and ownership transfer pending');
      event(incoming.id, 'settlement_propose', ids.staff, 3, reason);
      event(incoming.id, 'settlement_review', ids.accountant, 3,
        'SYNTHETIC DEMO ONLY: reviewed pending commercial and tax documents; no ownership or ledger posting');
    }
    const outgoingReference = 'SYNTHETIC-DEMO-CONSIGN-OUT-001';
    const outgoingExisting = db.prepare('SELECT id FROM consignments WHERE company_id=1 AND reference=?').get(outgoingReference);
    let outgoing = { id: outgoingExisting?.id, inserted: false };
    if (!outgoingExisting) {
      const physical = db.prepare('SELECT COALESCE(SUM(quantity_delta),0) AS n FROM stock_movements WHERE company_id=1 AND branch_id=1 AND item_id=?').get(ids.outgoingItem).n;
      const batch = db.prepare(`SELECT COALESCE(SUM(m.quantity_delta),0) AS n FROM batch_movements m
        JOIN batch_lots l ON l.id=m.batch_id WHERE m.company_id=1 AND m.branch_id=1 AND l.item_id=?`).get(ids.outgoingItem).n;
      const allocated = db.prepare(`SELECT COALESCE(SUM(m.quantity_delta),0) AS n FROM location_movements m
        JOIN locations l ON l.id=m.location_id WHERE m.company_id=1 AND l.branch_id=1 AND m.item_id=?`).get(ids.outgoingItem).n;
      if (physical - batch - allocated >= 3) {
        outgoing = insert({ reference: outgoingReference, direction: 'outgoing', partyId: ids.customer,
          itemId: ids.outgoingItem, partyName: 'Harbor Clinic', itemName: 'Syringe Pack', quantity: 3,
          evidence: 'SYNTHETIC-DISPATCH-CONSIGN-OUT-001' });
        db.prepare(`INSERT INTO stock_movements(company_id,branch_id,item_id,quantity_delta,type,reason,client_reference)
          VALUES (1,1,?,-3,'consignment_out_dispatch',?,?)`)
          .run(ids.outgoingItem, 'SYNTHETIC DEMO ONLY: company retains ownership; physical custody dispatched',
            `consignment:${outgoing.id}:dispatch`);
        const evidence = 'SYNTHETIC-UNSOLD-RETURN-001';
        const clientReference = 'SYNTHETIC-CONSIGN-OUT-RETURN-001';
        db.prepare(`INSERT INTO consignment_returns
          (consignment_id,company_id,quantity,evidence_reference,client_reference,signature,created_by)
          VALUES (?,1,1,?,?,?,?)`).run(outgoing.id, evidence, clientReference,
          JSON.stringify({ consignmentId: outgoing.id, quantity: 1, evidence }), ids.staff);
        db.prepare(`INSERT INTO stock_movements(company_id,branch_id,item_id,quantity_delta,type,reason,client_reference)
          VALUES (1,1,?,1,'consignment_out_unsold_return',?,?)`)
          .run(ids.outgoingItem, 'SYNTHETIC DEMO ONLY: unsold company-owned goods returned to physical custody',
            `consignment:${outgoing.id}:return:${clientReference}`);
        event(outgoing.id, 'unsold_return', ids.staff, 1, `SYNTHETIC DEMO ONLY: ${evidence}`);
      }
    }
    db.exec('RELEASE consignment_demo_seed');
    return { seeded: incoming.inserted || outgoing.inserted, incomingId: incoming.id, outgoingId: outgoing.id || null };
  } catch (error) {
    db.exec('ROLLBACK TO consignment_demo_seed');
    db.exec('RELEASE consignment_demo_seed');
    throw error;
  }
}

module.exports = { installConsignmentSchema, seedConsignmentDemo };
