import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createApp } = require('../api.cjs');
const { openDatabase } = require('../db.cjs');

async function fixture(t) {
  const db = openDatabase(':memory:');
  const server = createApp({ db }).listen(0);
  t.after(() => { server.close(); db.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const api = async (method, path, body, userId = 1) => {
    const response = await fetch(`${base}${path}`, { method, headers:{'content-type':'application/json','x-company-id':'1','x-user-id':String(userId)}, body:body === undefined ? undefined : JSON.stringify(body) });
    return { status:response.status,data:await response.json() };
  };
  return { db,api };
}

const today = () => new Date().toISOString().slice(0,10);
const balance = (db,itemId) => db.prepare('SELECT COALESCE(SUM(quantity_delta),0) AS quantity FROM stock_movements WHERE company_id=1 AND branch_id=1 AND item_id=?').get(itemId).quantity;

async function confirmedFulfillment(api,type,partyId,itemId,quantity,price,rate,reference) {
  const order = await api('POST','/api/orders',{type,partyId,branchId:1,gstinId:1,number:`ORD-${reference}`,orderDate:today(),lines:[{itemId,quantity,unitPriceCents:price,gstRateBps:rate}]});
  assert.equal(order.status,200);
  const orderId = order.data.order.id;
  assert.equal((await api('POST',`/api/orders/${orderId}/confirm`,{})).status,200);
  const draft = await api('POST',`/api/orders/${orderId}/fulfillments`,{number:`FUL-${reference}`,eventDate:today(),lines:[{orderLineId:order.data.order.lines[0].id,quantity}]});
  assert.equal(draft.status,200);
  const fulfillmentId = draft.data.fulfillment.id;
  assert.equal((await api('POST',`/api/orders/fulfillments/${fulfillmentId}/confirm`,{})).status,200);
  return { orderId,fulfillmentId };
}

test('linked sale invoice posts GST without issuing dispatched stock again', async t => {
  const { db,api } = await fixture(t);
  const initial = balance(db,1);
  const { fulfillmentId } = await confirmedFulfillment(api,'sale',1,1,3,10000,1200,'SALE-1');
  assert.equal(balance(db,1),initial-3);
  const input = {type:'sale',partyId:1,branchId:1,gstinId:1,fulfillmentId,invoiceDate:today(),lines:[{itemId:1,quantity:3,unitPriceCents:10000,gstRateBps:1200}]};
  const wrong = await api('POST','/api/invoices',{...input,lines:[{...input.lines[0],quantity:2}]});
  assert.equal(wrong.status,409);
  const draft = await api('POST','/api/invoices',input);
  assert.equal(draft.status,200);
  assert.equal(draft.data.invoice.fulfillmentId,fulfillmentId);
  assert.ok(draft.data.invoice.lines[0].fulfillmentLineId);
  assert.equal((await api('POST','/api/invoices',input)).status,409);
  await api('POST',`/api/invoices/${draft.data.invoice.id}/submit`,{});
  const approved = await api('POST',`/api/invoices/${draft.data.invoice.id}/approve`,{},2);
  assert.equal(approved.status,200);
  assert.equal(balance(db,1),initial-3);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM stock_movements WHERE invoice_id=?').get(draft.data.invoice.id).n,0);
  const period = (await api('GET','/api/gst/periods')).data.periods.find(x=>x.gstinId===1 && x.period===today().slice(0,7));
  assert.equal(period.salesTaxCents,6000);
});

test('linked purchase invoice does not receive stock twice', async t => {
  const { db,api } = await fixture(t);
  const initial = balance(db,2);
  const { fulfillmentId } = await confirmedFulfillment(api,'purchase',2,2,5,2000,1800,'PUR-1');
  assert.equal(balance(db,2),initial+5);
  const draft = await api('POST','/api/invoices',{type:'purchase',partyId:2,branchId:1,gstinId:1,fulfillmentId,supplierInvoiceNumber:'ORDER-PO-001',invoiceDate:today(),lines:[{itemId:2,quantity:5,unitPriceCents:2000,gstRateBps:1800}]});
  assert.equal(draft.status,200);
  await api('POST',`/api/invoices/${draft.data.invoice.id}/submit`,{});
  assert.equal((await api('POST',`/api/invoices/${draft.data.invoice.id}/approve`,{},2)).status,200);
  assert.equal(balance(db,2),initial+5);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM stock_movements WHERE invoice_id=?').get(draft.data.invoice.id).n,0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM purchase_evidence WHERE invoice_id=?').get(draft.data.invoice.id).n,1);
});
