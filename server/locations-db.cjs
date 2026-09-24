function installLocationsSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS locations (
      id INTEGER PRIMARY KEY,
      company_id INTEGER NOT NULL REFERENCES companies(id),
      gstin_id INTEGER NOT NULL REFERENCES gstins(id),
      branch_id INTEGER NOT NULL REFERENCES branches(id),
      parent_id INTEGER REFERENCES locations(id),
      kind TEXT NOT NULL CHECK(kind IN ('warehouse','store','rack')),
      name TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
      created_by INTEGER NOT NULL REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE UNIQUE INDEX IF NOT EXISTS uq_location_child ON locations(company_id,branch_id,parent_id,kind,name) WHERE parent_id IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS uq_location_root ON locations(company_id,branch_id,kind,name) WHERE parent_id IS NULL;
    CREATE INDEX IF NOT EXISTS idx_locations_branch ON locations(company_id,branch_id,parent_id);
    CREATE TABLE IF NOT EXISTS location_movements (
      id INTEGER PRIMARY KEY,
      company_id INTEGER NOT NULL REFERENCES companies(id),
      location_id INTEGER NOT NULL REFERENCES locations(id),
      item_id INTEGER NOT NULL REFERENCES items(id),
      quantity_delta INTEGER NOT NULL CHECK(quantity_delta<>0),
      type TEXT NOT NULL CHECK(type IN ('assignment','transfer_dispatch','transfer_receive')),
      transfer_id INTEGER REFERENCES location_transfers(id),
      reason TEXT NOT NULL,
      actor_id INTEGER NOT NULL REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_location_movements_stock ON location_movements(company_id,location_id,item_id);
    CREATE TABLE IF NOT EXISTS location_assignments (
      id INTEGER PRIMARY KEY,
      company_id INTEGER NOT NULL REFERENCES companies(id),
      location_id INTEGER NOT NULL REFERENCES locations(id),
      item_id INTEGER NOT NULL REFERENCES items(id),
      quantity INTEGER NOT NULL CHECK(quantity>0),
      reason TEXT NOT NULL,
      client_reference TEXT,
      signature TEXT NOT NULL,
      movement_id INTEGER NOT NULL UNIQUE REFERENCES location_movements(id),
      created_by INTEGER NOT NULL REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(company_id,client_reference)
    );
    CREATE TABLE IF NOT EXISTS location_transfers (
      id INTEGER PRIMARY KEY,
      company_id INTEGER NOT NULL REFERENCES companies(id),
      source_location_id INTEGER NOT NULL REFERENCES locations(id),
      destination_location_id INTEGER NOT NULL REFERENCES locations(id),
      item_id INTEGER NOT NULL REFERENCES items(id),
      quantity INTEGER NOT NULL CHECK(quantity>0),
      received_quantity INTEGER NOT NULL DEFAULT 0 CHECK(received_quantity>=0 AND received_quantity<=quantity),
      status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','dispatched','partial_received','received')),
      reason TEXT NOT NULL,
      client_reference TEXT NOT NULL,
      signature TEXT NOT NULL,
      dispatch_evidence_reference TEXT,
      dispatched_by INTEGER REFERENCES users(id),
      dispatched_at TEXT,
      created_by INTEGER NOT NULL REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(company_id,client_reference),
      CHECK(source_location_id<>destination_location_id)
    );
    CREATE TABLE IF NOT EXISTS location_receipts (
      id INTEGER PRIMARY KEY,
      company_id INTEGER NOT NULL REFERENCES companies(id),
      transfer_id INTEGER NOT NULL REFERENCES location_transfers(id),
      quantity INTEGER NOT NULL CHECK(quantity>0),
      evidence_reference TEXT NOT NULL,
      client_reference TEXT NOT NULL,
      signature TEXT NOT NULL,
      movement_id INTEGER NOT NULL UNIQUE REFERENCES location_movements(id),
      received_by INTEGER NOT NULL REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(company_id,transfer_id,client_reference)
    );
    CREATE TABLE IF NOT EXISTS location_events (
      id INTEGER PRIMARY KEY,
      company_id INTEGER NOT NULL REFERENCES companies(id),
      transfer_id INTEGER NOT NULL REFERENCES location_transfers(id),
      action TEXT NOT NULL CHECK(action IN ('create','dispatch','receive')),
      actor_id INTEGER NOT NULL REFERENCES users(id),
      quantity INTEGER NOT NULL,
      evidence_reference TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_location_events_transfer ON location_events(transfer_id,id);
  `);
}

module.exports = { installLocationsSchema };
