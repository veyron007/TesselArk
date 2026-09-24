import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const { createApp } = require('../api.cjs');
const { openDatabase } = require('../db.cjs');
const { allocateBatchIssue } = require('../batch-inventory.cjs');
const { seedBatchSpecimen } = require('../batch-inventory-db.cjs');

async function fixture(t, file = ':memory:') {
  const db = openDatabase(file);
  const server = createApp({ db }).listen(0);
  t.after(() => { server.close(); db.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const api = async (method, path, body, companyId = 1, userId = 1) => {
    const response = await fetch(`${base}${path}`, { method,
      headers: { 'content-type': 'application/json', 'x-company-id': String(companyId), 'x-user-id': String(userId) },
      body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, data: await response.json() };
  };
  return { db, api };
}

const receipt = (reference = 'GRN-001') => ({ itemId: 1, branchId: 1, gstinId: 1, batchCode: 'LOT-A-2027', manufacturedOn: '2026-01-01', expiresOn: '2027-12-31', quantity: 10, reason: 'Supplier GRN 001', clientReference: reference });
const stock = (db, branchId) => db.prepare('SELECT COALESCE(SUM(quantity_delta),0) AS quantity FROM stock_movements WHERE company_id=1 AND branch_id=? AND item_id=1').get(branchId).quantity;

test('receipt and issue post linked stock movements exactly once and protect both balances', async t => {
  const { db, api } = await fixture(t);
  const before = stock(db,1);
  const first = await api('POST','/api/batches/receive',receipt());
  assert.equal(first.status,200);
  assert.equal(first.data.quantity,10);
  assert.equal(stock(db,1),before+10);
  const same = await api('POST','/api/batches/receive',receipt());
  assert.equal(same.status,200);
  assert.equal(same.data.replayed,true);
  assert.equal(stock(db,1),before+10);
  assert.equal((await api('POST','/api/batches/receive',{ ...receipt(), quantity: 11 })).status,409);
  const batchId = first.data.batch.id;
  const issue = await api('POST',`/api/batches/${batchId}/issue`,{ branchId:1,quantity:4,reason:'Dispensed',clientReference:'DSP-001' });
  assert.equal(issue.status,200);
  assert.equal(issue.data.quantity,6);
  assert.equal(stock(db,1),before+6);
  assert.equal((await api('POST',`/api/batches/${batchId}/issue`,{ branchId:1,quantity:7,reason:'Too many' })).status,409);
  const movements = db.prepare('SELECT m.*,s.quantity_delta AS stock_delta FROM batch_movements m JOIN stock_movements s ON s.id=m.stock_movement_id WHERE m.batch_id=? ORDER BY m.id').all(batchId);
  assert.deepEqual(movements.map(row => row.quantity_delta),[10,-4]);
  assert.ok(movements.every(row => row.quantity_delta === row.stock_delta));
});

test('transfer conserves total, records both branches and GSTIN context, and is idempotent', async t => {
  const { db, api } = await fixture(t);
  const received = await api('POST','/api/batches/receive',receipt('GRN-002'));
  const id = received.data.batch.id;
  const before = stock(db,1)+stock(db,3);
  const body = { fromBranchId:1,toBranchId:3,quantity:3,reason:'Bengaluru replenishment',clientReference:'TR-001' };
  const moved = await api('POST',`/api/batches/${id}/transfer`,body);
  assert.equal(moved.status,200);
  assert.equal(moved.data.sourceQuantity,7);
  assert.equal(moved.data.destinationQuantity,3);
  assert.equal(stock(db,1)+stock(db,3),before);
  const legs = db.prepare("SELECT branch_id,gstin_id,quantity_delta,type FROM batch_movements WHERE operation_reference='batch:transfer:TR-001' ORDER BY id").all();
  assert.deepEqual(legs.map(leg => [leg.branch_id,leg.quantity_delta,leg.type]),[[1,-3,'transfer_out'],[3,3,'transfer_in']]);
  assert.equal(legs[0].gstin_id,1);
  assert.equal(legs[1].gstin_id,2);
  assert.equal((await api('POST',`/api/batches/${id}/transfer`,body)).data.replayed,true);
  assert.equal((await api('POST',`/api/batches/${id}/transfer`,{ ...body, quantity: 4 })).status,409);
  assert.equal((await api('POST',`/api/batches/${id}/transfer`,{ ...body, toBranchId:5,clientReference:'TR-OTHER' })).status,404);
});

test('expired issues, malformed dates, service stock, and cross-company access are rejected', async t => {
  const { api } = await fixture(t);
  assert.equal((await api('POST','/api/batches/receive',{ ...receipt('BAD-DATE'), expiresOn:'2026-02-30' })).status,400);
  assert.equal((await api('POST','/api/batches/receive',{ ...receipt('BAD-SERVICE'), itemId:4,branchId:4,gstinId:3 },2,5)).status,400);
  const old = await api('POST','/api/batches/receive',{ ...receipt('OLD'), batchCode:'OLD-LOT', expiresOn:'2026-01-31', manufacturedOn:'2025-01-01' });
  assert.equal(old.status,200);
  assert.equal((await api('POST',`/api/batches/${old.data.batch.id}/issue`,{ branchId:1,quantity:1,reason:'Expired' })).status,409);
  assert.equal((await api('GET','/api/batches',undefined,2,5)).data.batches.some(row => row.id === old.data.batch.id),false);
  assert.equal((await api('POST',`/api/batches/${old.data.batch.id}/issue`,{ branchId:4,quantity:1,reason:'Cross company' },2,5)).status,404);
  const list = await api('GET','/api/batches?branchId=1&expiringWithinDays=30');
  assert.equal(list.status,200);
  assert.ok(list.data.expiring.some(row => row.id === old.data.batch.id));
});

test('batch stock remains persisted when SQLite database reopens', async t => {
  const directory = mkdtempSync(join(tmpdir(),'tesselark-batches-'));
  t.after(() => rmSync(directory,{ recursive:true,force:true }));
  const file = join(directory,'erp.sqlite');
  const { api } = await fixture(t,file);
  const first = await api('POST','/api/batches/receive',receipt('PERSIST-1'));
  assert.equal(first.status,200);
  const reopened = openDatabase(file);
  t.after(() => reopened.close());
  assert.equal(reopened.prepare('SELECT SUM(quantity_delta) AS quantity FROM batch_movements WHERE batch_id=?').get(first.data.batch.id).quantity,10);
});

test('unbatched issue cannot let a later batch issue or transfer make branch stock negative', async t => {
  const { db, api } = await fixture(t);
  const received = await api('POST','/api/batches/receive',receipt('GLOBAL-1'));
  const batchId = received.data.batch.id;
  const total = stock(db,1);
  const generic = await api('POST','/api/stock/movements',{ itemId:1,branchId:1,type:'issue',quantity:total-2,reason:'Generic dispatch' });
  assert.equal(generic.status,200);
  assert.equal(stock(db,1),2);
  assert.equal((await api('POST',`/api/batches/${batchId}/issue`,{ branchId:1,quantity:3,reason:'Would overissue' })).status,409);
  assert.equal((await api('POST',`/api/batches/${batchId}/transfer`,{ fromBranchId:1,toBranchId:3,quantity:3,reason:'Would overtransfer' })).status,409);
  assert.equal(stock(db,1),2);
});

test('FEFO allocation splits batch and unbatched stock exactly once for ordinary dispatches', async t => {
  const { db,api } = await fixture(t);
  const first = await api('POST','/api/batches/receive',{ ...receipt('FEFO-1'),batchCode:'FEFO-EARLY',expiresOn:'2027-01-01',quantity:2 });
  const second = await api('POST','/api/batches/receive',{ ...receipt('FEFO-2'),batchCode:'FEFO-LATE',expiresOn:'2027-12-31',quantity:3 });
  assert.equal(first.status,200); assert.equal(second.status,200);
  const before = stock(db,1);
  const input = { companyId:1,branchId:1,itemId:1,quantity:6,reason:'Sale dispatch FEFO',sourceReference:'test:fefo:1',userId:1,movementType:'sales_dispatch' };
  const result = allocateBatchIssue(db,input);
  assert.equal(result.batchAllocated,5);
  assert.equal(result.unbatched,1);
  assert.deepEqual(result.batchLegs.map(leg => [leg.batchCode,leg.quantity]),[['FEFO-EARLY',2],['FEFO-LATE',3]]);
  assert.equal(stock(db,1),before-6);
  assert.equal(result.stockMovementIds.length,3);
  assert.equal(allocateBatchIssue(db,input).replayed,true);
  assert.equal(stock(db,1),before-6);
  assert.throws(() => allocateBatchIssue(db,{ ...input,quantity:7 }),/Source reference already used/);
  const linked = db.prepare('SELECT SUM(m.quantity_delta) AS batch_delta FROM batch_movements m WHERE m.operation_reference LIKE ?').get('batch:auto:test:fefo:1:%').batch_delta;
  assert.equal(linked,-5);
});

test('ordinary dispatch never allocates expired lots', async t => {
  const { db,api } = await fixture(t);
  const old = await api('POST','/api/batches/receive',{ ...receipt('FEFO-OLD'),batchCode:'FEFO-EXPIRED',manufacturedOn:'2025-01-01',expiresOn:'2026-01-01',quantity:3 });
  assert.equal(old.status,200);
  const result = allocateBatchIssue(db,{ companyId:1,branchId:1,itemId:1,quantity:1,reason:'Unbatched sale',sourceReference:'test:expired:1',userId:1 });
  assert.equal(result.batchAllocated,0);
  assert.equal(result.unbatched,1);
  assert.equal(db.prepare('SELECT SUM(quantity_delta) AS quantity FROM batch_movements WHERE batch_id=?').get(old.data.batch.id).quantity,3);
});

test('approved purchase return issues from allocated batch and preserves return audit link', async t => {
  const { db,api } = await fixture(t);
  const purchases = (await api('GET','/api/invoices')).data.invoices.filter(row => row.type === 'purchase' && row.status === 'approved' && row.branchId === 1);
  const source = (await api('GET',`/api/invoices/${purchases[0].id}`)).data.invoice;
  const line = source.lines[0];
  const receipt = await api('POST','/api/batches/receive',{ itemId:line.itemId,branchId:1,gstinId:1,batchCode:'RETURN-LOT-001',expiresOn:'2028-01-01',quantity:1,reason:'Supplier receipt with lot',clientReference:'RETURN-LOT-001' });
  assert.equal(receipt.status,200);
  const batchId = receipt.data.batch.id;
  const before = db.prepare('SELECT COALESCE(SUM(quantity_delta),0) AS q FROM stock_movements WHERE company_id=1 AND branch_id=1 AND item_id=?').get(line.itemId).q;
  const created = await api('POST','/api/returns',{ invoiceId:source.id,lines:[{ invoiceLineId:line.id,quantity:1 }],reason:'Supplier lot rejected' });
  assert.equal(created.status,200);
  const approved = await api('POST',`/api/returns/${created.data.return.id}/approve`,{},1,2);
  assert.equal(approved.status,200);
  const movementId = approved.data.return.lines[0].stockMovementId;
  assert.ok(movementId);
  assert.equal(db.prepare('SELECT COALESCE(SUM(quantity_delta),0) AS q FROM batch_movements WHERE batch_id=?').get(batchId).q,0);
  assert.equal(db.prepare('SELECT quantity_delta AS q FROM stock_movements WHERE id=?').get(movementId).q,-1);
  assert.equal(db.prepare('SELECT COALESCE(SUM(quantity_delta),0) AS q FROM stock_movements WHERE company_id=1 AND branch_id=1 AND item_id=?').get(line.itemId).q,before-1);
  assert.equal((await api('POST',`/api/returns/${created.data.return.id}/approve`,{},1,2)).data.alreadyApproved,true);
});

test('supplier return can remove an expired lot that cannot be sold', async t => {
  const { db,api } = await fixture(t);
  const purchases = (await api('GET','/api/invoices')).data.invoices.filter(row => row.type === 'purchase' && row.status === 'approved' && row.branchId === 1);
  const source = (await api('GET',`/api/invoices/${purchases[0].id}`)).data.invoice;
  const line = source.lines[0];
  const received = await api('POST','/api/batches/receive',{ itemId:line.itemId,branchId:1,gstinId:1,batchCode:'EXPIRED-SUPPLIER-RETURN',manufacturedOn:'2025-01-01',expiresOn:'2026-01-01',quantity:1,reason:'Supplier lot later rejected',clientReference:'EXPIRED-SUPPLIER-RETURN' });
  assert.equal(received.status,200);
  const created = await api('POST','/api/returns',{ invoiceId:source.id,lines:[{ invoiceLineId:line.id,quantity:1 }],reason:'Expired supplier lot' });
  assert.equal(created.status,200);
  assert.equal((await api('POST',`/api/returns/${created.data.return.id}/approve`,{},1,2)).status,200);
  assert.equal(db.prepare('SELECT SUM(quantity_delta) AS q FROM batch_movements WHERE batch_id=?').get(received.data.batch.id).q,0);
});

test('assigning an approved purchase quantity to a lot does not double count stock and sale consumes it', async t => {
  const { db,api } = await fixture(t);
  const purchases = (await api('GET','/api/invoices')).data.invoices.filter(row => row.type === 'purchase' && row.status === 'approved' && row.branchId === 1);
  const purchase = (await api('GET',`/api/invoices/${purchases[0].id}`)).data.invoice;
  const itemId = purchase.lines[0].itemId;
  const before = db.prepare('SELECT COALESCE(SUM(quantity_delta),0) AS q FROM stock_movements WHERE company_id=1 AND branch_id=1 AND item_id=?').get(itemId).q;
  const assignBody = { itemId,branchId:1,gstinId:1,batchCode:'ALLOCATED-PURCHASE-LOT',manufacturedOn:'2026-01-01',expiresOn:'2028-01-01',quantity:2,reason:`Approved purchase ${purchase.number}`,clientReference:'ALLOCATED-PURCHASE-LOT' };
  const assigned = await api('POST','/api/batches/assign',assignBody);
  assert.equal(assigned.status,200);
  assert.equal(assigned.data.branchStock,before);
  assert.equal(assigned.data.quantity,2);
  assert.equal(db.prepare('SELECT quantity_delta AS q FROM stock_movements WHERE id=?').get(assigned.data.movement.stockMovementId).q,0);
  assert.equal(db.prepare('SELECT is_allocation AS flag FROM batch_movements WHERE id=?').get(assigned.data.movement.batchMovementId).flag,1);
  assert.equal((await api('POST','/api/batches/assign',assignBody)).data.replayed,true);
  assert.equal((await api('POST','/api/batches/assign',{ ...assignBody,quantity:before })).status,409);
  const date = new Date().toISOString().slice(0,10);
  const sale = await api('POST','/api/invoices',{ type:'sale',partyId:1,branchId:1,gstinId:1,invoiceDate:date,lines:[{ itemId,quantity:2,unitPriceCents:1000 }] });
  assert.equal(sale.status,200);
  assert.equal((await api('POST',`/api/invoices/${sale.data.invoice.id}/submit`,{})).status,200);
  assert.equal((await api('POST',`/api/invoices/${sale.data.invoice.id}/approve`,{},1,2)).status,200);
  assert.equal(db.prepare('SELECT COALESCE(SUM(quantity_delta),0) AS q FROM batch_movements WHERE batch_id=?').get(assigned.data.batch.id).q,0);
  assert.equal(db.prepare('SELECT COALESCE(SUM(quantity_delta),0) AS q FROM stock_movements WHERE company_id=1 AND branch_id=1 AND item_id=?').get(itemId).q,before-2);
});

test('batch assignment cannot reuse stock already classified at a location', async t => {
  const { db,api } = await fixture(t);
  const physical = stock(db,1);
  const batched = db.prepare(`SELECT COALESCE(SUM(m.quantity_delta),0) AS q FROM batch_movements m
    JOIN batch_lots l ON l.id=m.batch_id WHERE m.company_id=1 AND m.branch_id=1 AND l.item_id=1`).get().q;
  const located = db.prepare(`SELECT COALESCE(SUM(m.quantity_delta),0) AS q FROM location_movements m
    JOIN locations l ON l.id=m.location_id WHERE m.company_id=1 AND l.branch_id=1 AND m.item_id=1`).get().q;
  assert.ok(located > 0);
  const free = physical - batched - located;
  const request = { itemId:1,branchId:1,gstinId:1,batchCode:'NO-DOUBLE-CLASSIFY',expiresOn:'2099-12-31',
    quantity:free+1,reason:'Synthetic assignment boundary',clientReference:'NO-DOUBLE-CLASSIFY' };
  assert.equal((await api('POST','/api/batches/assign',request)).status,409);
  assert.equal(stock(db,1),physical);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM batch_lots WHERE batch_code='NO-DOUBLE-CLASSIFY'").get().n,0);
});

test('synthetic near-expiry lot seeds once from existing stock without changing branch stock', async t => {
  const { db,api } = await fixture(t);
  const before = db.prepare('SELECT COALESCE(SUM(quantity_delta),0) AS q FROM stock_movements WHERE company_id=1 AND branch_id=1 AND item_id=2').get().q;
  seedBatchSpecimen(db);
  seedBatchSpecimen(db);
  const after = db.prepare('SELECT COALESCE(SUM(quantity_delta),0) AS q FROM stock_movements WHERE company_id=1 AND branch_id=1 AND item_id=2').get().q;
  assert.equal(after,before);
  const lot = db.prepare("SELECT id FROM batch_lots WHERE company_id=1 AND item_id=2 AND batch_code='DEMO-SALINE-NEAR-EXPIRY'").get();
  assert.ok(lot);
  assert.equal(db.prepare('SELECT COUNT(*) AS n,SUM(quantity_delta) AS q FROM batch_movements WHERE batch_id=?').get(lot.id).n,1);
  const result = await api('GET','/api/batches?branchId=1&expiringWithinDays=30');
  assert.ok(result.data.expiring.some(row => row.id === lot.id && row.quantity === 6));
});
