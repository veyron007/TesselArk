import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { openDatabase } = require('../db.cjs');
const { seedLocationsDemo } = require('../locations-demo.cjs');

test('synthetic locations are idempotent classifications, not extra physical receipts', () => {
  const db = openDatabase(':memory:');
  try {
    const physical = () => db.prepare('SELECT COALESCE(SUM(quantity_delta),0) AS q FROM stock_movements WHERE company_id=1 AND branch_id=1 AND item_id=1').get().q;
    const before = physical();
    seedLocationsDemo(db);
    const places = db.prepare("SELECT kind,name FROM locations WHERE company_id=1 AND name LIKE 'DEMO %'").all();
    const assignment = db.prepare("SELECT a.quantity,l.branch_id,l.kind,t.type FROM location_assignments a JOIN locations l ON l.id=a.location_id JOIN location_movements t ON t.id=a.movement_id WHERE a.company_id=1 AND a.client_reference='DEMO-LOC-COUNT-001'").get();
    const transfer = db.prepare("SELECT status,quantity,received_quantity FROM location_transfers WHERE company_id=1 AND client_reference='DEMO-LOC-XFER-001'").get();
    assert.equal(places.length, 4);
    assert.deepEqual({ ...assignment }, { quantity: 6, branch_id: 1, kind: 'rack', type: 'assignment' });
    assert.deepEqual({ ...transfer }, { status: 'draft', quantity: 3, received_quantity: 0 });
    assert.equal(physical(), before);
    seedLocationsDemo(db);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM location_assignments WHERE company_id=1').get().n, 1);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM location_transfers WHERE company_id=1').get().n, 1);
    assert.equal(physical(), before);
  } finally {
    db.close();
  }
});
