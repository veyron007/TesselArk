import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createApp } = require('../api.cjs');
const { openDatabase } = require('../db.cjs');

async function fixture(t) {
  const db = openDatabase(':memory:');
  const server = createApp({ db, authMode: 'demo' }).listen(0);
  t.after(() => { server.close(); db.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const api = async (method, path, body, companyId = 1, userId = 1) => {
    const response = await fetch(base + path, {
      method,
      headers: { 'content-type': 'application/json', 'x-company-id': String(companyId), 'x-user-id': String(userId) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, data: await response.json() };
  };
  return { db, api };
}

function physical(db, branchId, itemId) {
  return db.prepare('SELECT COALESCE(SUM(quantity_delta),0) AS quantity FROM stock_movements WHERE company_id=1 AND branch_id=? AND item_id=?').get(branchId, itemId).quantity;
}

async function ok(api, method, path, body, companyId = 1, userId = 1) {
  const result = await api(method, path, body, companyId, userId);
  assert.equal(result.status, 200, `${method} ${path}: ${JSON.stringify(result.data)}`);
  return result.data;
}

test('catalogue curation, transfer, conversion, order and count keep distinct stock effects', async t => {
  const { db, api } = await fixture(t);
  const sourceBefore = physical(db, 1, 1);
  const conversionSourceBefore = physical(db, 1, 2);
  const destinationBefore = physical(db, 2, 1);
  const targetBefore = physical(db, 1, 3);
  const movementCountBefore = db.prepare('SELECT COUNT(*) AS count FROM stock_movements').get().count;

  const category = (await ok(api, 'POST', '/api/catalogue/categories', { name: 'Test supplies', sourceReference: 'integration:category' }, 1, 3)).category;
  await ok(api, 'PUT', '/api/catalogue/items/1', { categoryId: category.id, productKind: 'general', tags: ['Stocked'], parameters: [{ key: 'size', value: 'standard' }], sourceReference: 'integration:item', changeReason: 'Cross-flow test' }, 1, 3);
  const discovered = await ok(api, 'GET', `/api/catalogue/items?categoryId=${category.id}&tag=stocked`);
  assert.equal(discovered.items.some(item => item.id === 1), true);
  assert.equal(physical(db, 1, 1), sourceBefore);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM stock_movements').get().count, movementCountBefore);

  const source = (await ok(api, 'POST', '/api/locations', { branchId: 1, kind: 'warehouse', name: 'Integration source' })).location.id;
  const destination = (await ok(api, 'POST', '/api/locations', { branchId: 2, kind: 'warehouse', name: 'Integration destination' })).location.id;
  await ok(api, 'POST', '/api/location-assignments', { locationId: source, itemId: 1, quantity: 4, reason: 'Shelf count', clientReference: 'integration-assignment' });
  assert.equal(physical(db, 1, 1), sourceBefore);
  const transfer = (await ok(api, 'POST', '/api/location-transfers', { sourceLocationId: source, destinationLocationId: destination, itemId: 1, quantity: 4, reason: 'Branch restock', clientReference: 'integration-transfer' })).transfer;
  await ok(api, 'POST', `/api/location-transfers/${transfer.id}/dispatch`, { evidenceReference: 'DC-INTEGRATION' });
  assert.equal(physical(db, 1, 1), sourceBefore - 4);
  assert.equal(physical(db, 2, 1), destinationBefore);
  let transferState = (await ok(api, 'GET', `/api/location-transfers/${transfer.id}`)).transfer;
  assert.equal(physical(db, 1, 1) + physical(db, 2, 1) + transferState.inTransitQuantity, sourceBefore + destinationBefore);
  await ok(api, 'POST', `/api/location-transfers/${transfer.id}/receive`, { quantity: 2, evidenceReference: 'GRN-INTEGRATION-1', clientReference: 'integration-receive-1' });
  transferState = (await ok(api, 'GET', `/api/location-transfers/${transfer.id}`)).transfer;
  assert.equal(transferState.inTransitQuantity, 2);
  assert.equal(physical(db, 1, 1) + physical(db, 2, 1) + transferState.inTransitQuantity, sourceBefore + destinationBefore);
  await ok(api, 'POST', `/api/location-transfers/${transfer.id}/receive`, { quantity: 2, evidenceReference: 'GRN-INTEGRATION-2', clientReference: 'integration-receive-2' });
  assert.equal(physical(db, 1, 1) + physical(db, 2, 1), sourceBefore + destinationBefore);

  const conversionBody = { branchId: 1, gstinId: 1, sourceItemId: 2, targetItemId: 3, sourceQuantity: 2, ratioNumerator: 1, ratioDenominator: 1, allowedWastageQuantity: 0, actualWastageQuantity: 0, costBasisCents: 1000, costBasisReference: 'Integration source cost', reason: 'Pack conversion', clientReference: 'integration-conversion' };
  const conversion = (await ok(api, 'POST', '/api/conversions', conversionBody)).conversion;
  await ok(api, 'POST', `/api/conversions/${conversion.id}/submit`, {});
  await ok(api, 'POST', `/api/conversions/${conversion.id}/review`, { reviewNote: 'Ratio and stock checked' }, 1, 2);
  await ok(api, 'POST', `/api/conversions/${conversion.id}/post`, {});
  assert.equal(physical(db, 1, 1), sourceBefore - 4);
  assert.equal(physical(db, 1, 2), conversionSourceBefore - 2);
  assert.equal(physical(db, 1, 3), targetBefore + 2);
  assert.equal((await ok(api, 'POST', `/api/conversions/${conversion.id}/post`, {})).replayed, true);
  assert.equal(physical(db, 1, 3), targetBefore + 2);

  const today = new Date().toISOString().slice(0, 10);
  const beforeDemand = (await ok(api, 'GET', '/api/replenishment?branchId=1&gstinId=1')).rows.find(row => row.itemId === 3);
  const order = (await ok(api, 'POST', '/api/orders', { type: 'sale', number: 'SO-INTEGRATION', orderDate: today, gstinId: 1, branchId: 1, partyId: 1, lines: [{ itemId: 3, quantity: 3, unitPriceCents: 1000 }] })).order;
  await ok(api, 'POST', `/api/orders/${order.id}/confirm`, {});
  const committedDemand = (await ok(api, 'GET', '/api/replenishment?branchId=1&gstinId=1')).rows.find(row => row.itemId === 3);
  assert.equal(committedDemand.openSalesUnits, beforeDemand.openSalesUnits + 3);
  assert.equal(committedDemand.onHandUnits, targetBefore + 2);
  const dispatch = (await ok(api, 'POST', `/api/orders/${order.id}/fulfillments`, { number: 'DC-INTEGRATION-ORDER', eventDate: today, lines: [{ orderLineId: order.lines[0].id, quantity: 1 }] })).fulfillment;
  await ok(api, 'POST', `/api/orders/fulfillments/${dispatch.id}/confirm`, {});
  const dispatchedDemand = (await ok(api, 'GET', '/api/replenishment?branchId=1&gstinId=1')).rows.find(row => row.itemId === 3);
  assert.equal(dispatchedDemand.openSalesUnits, beforeDemand.openSalesUnits + 2);
  assert.equal(dispatchedDemand.actualSalesUnits, committedDemand.actualSalesUnits + 1);
  assert.equal(dispatchedDemand.onHandUnits, targetBefore + 1);

  const count = (await ok(api, 'POST', '/api/counts', { gstinId: 1, branchId: 1, itemIds: [3] })).session;
  assert.equal(count.lines[0].recordedQuantity, targetBefore + 1);
  await ok(api, 'PUT', `/api/counts/${count.id}/lines/${count.lines[0].id}`, { countedQuantity: targetBefore, reason: 'One unit missing on shelf' });
  await ok(api, 'POST', `/api/counts/${count.id}/submit`, {});
  await ok(api, 'POST', `/api/counts/${count.id}/review`, { decision: 'approve', reason: 'Checked shelf variance' }, 1, 2);
  assert.equal((await ok(api, 'POST', `/api/counts/${count.id}/review`, { decision: 'approve', reason: 'Checked shelf variance' }, 1, 2)).replayed, true);
  assert.equal(physical(db, 1, 3), targetBefore);
  const finalStock = (await ok(api, 'GET', '/api/stock?branchId=1')).stock.find(row => row.itemId === 3);
  assert.equal(finalStock.quantity, targetBefore);
  assert.equal((await ok(api, 'GET', '/api/replenishment?branchId=1&gstinId=1')).rows.find(row => row.itemId === 3).onHandUnits, targetBefore);
});

test('cross-company IDs and revoked branch grants cannot expose or post new-flow records', async t => {
  const { db, api } = await fixture(t);
  const source = (await ok(api, 'POST', '/api/locations', { branchId: 1, kind: 'warehouse', name: 'Scoped source' })).location.id;
  const count = (await ok(api, 'POST', '/api/counts', { gstinId: 1, branchId: 1, itemIds: [3] })).session;
  const conversion = (await ok(api, 'POST', '/api/conversions', { branchId: 1, gstinId: 1, sourceItemId: 1, targetItemId: 3, sourceQuantity: 1, ratioNumerator: 1, ratioDenominator: 1, allowedWastageQuantity: 0, actualWastageQuantity: 0, costBasisCents: 100, costBasisReference: 'Scoped cost', reason: 'Scoped conversion', clientReference: 'scope-conversion' })).conversion;
  assert.equal((await api('GET', `/api/locations/${source}`, undefined, 2, 4)).status, 404);
  assert.equal((await api('GET', `/api/counts/${count.id}`, undefined, 2, 4)).status, 404);
  assert.equal((await api('GET', `/api/conversions/${conversion.id}`, undefined, 2, 4)).status, 404);
  assert.equal((await api('GET', '/api/catalogue/items/1', undefined, 2, 4)).status, 404);
  const before = physical(db, 1, 1);
  db.prepare("UPDATE user_branch_grants SET revoked_at=CURRENT_TIMESTAMP,revoked_by=3,revoked_reason='Integration scope test' WHERE company_id=1 AND user_id=1 AND branch_id=1 AND revoked_at IS NULL").run();
  assert.equal((await api('GET', `/api/locations/${source}`)).status, 403);
  assert.equal((await api('GET', `/api/counts/${count.id}`)).status, 403);
  assert.equal((await api('GET', `/api/conversions/${conversion.id}`)).status, 403);
  assert.equal((await api('POST', `/api/conversions/${conversion.id}/submit`, {})).status, 403);
  assert.equal(physical(db, 1, 1), before);
});
