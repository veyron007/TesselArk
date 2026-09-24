import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createApp } = require('../api.cjs');
const { openDatabase } = require('../db.cjs');
const { seedQuarantineSpecimen } = require('../returns-quarantine-db.cjs');

async function fixture(t) {
  const db = openDatabase(':memory:');
  const server = createApp({ db }).listen(0);
  t.after(() => { server.close(); db.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const api = async (method,path,body,companyId=1,userId=1) => {
    const response = await fetch(base+path,{ method,headers:{ 'content-type':'application/json','x-company-id':String(companyId),'x-user-id':String(userId) },body:body===undefined?undefined:JSON.stringify(body) });
    return { status:response.status,data:await response.json() };
  };
  return { db,api };
}

test('sale return stays quarantined until inspected release and leaves an unreviewed tax proposal', async t => {
  const { api } = await fixture(t);
  const source = (await api('GET','/api/invoices/1')).data.invoice;
  const stockBefore = (await api('GET','/api/stock?branchId=1')).data.stock.find(row=>row.itemId===1).quantity;
  const created = await api('POST','/api/returns',{ invoiceId:1,lines:[{invoiceLineId:source.lines[0].id,quantity:1}],reason:'Customer returned one sealed box' });
  assert.equal(created.status,200);
  assert.equal(created.data.return.kind,'sales_return');
  assert.equal(created.data.return.taxProposalCents,1200);
  assert.equal(created.data.return.taxProposalStatus,'unreviewed');
  assert.match(created.data.return.number,/^CRN-/);
  const id = created.data.return.id;
  assert.equal((await api('POST',`/api/returns/${id}/approve`,{},1,1)).status,403);
  assert.equal((await api('GET','/api/stock?branchId=1')).data.stock.find(row=>row.itemId===1).quantity,stockBefore);
  const approved = await api('POST',`/api/returns/${id}/approve`,{},1,2);
  assert.equal(approved.status,200);
  assert.equal(approved.data.return.status,'approved');
  assert.equal(approved.data.return.lines[0].stockMovementId,null);
  assert.equal((await api('GET','/api/stock?branchId=1')).data.stock.find(row=>row.itemId===1).quantity,stockBefore);
  const held=(await api('GET','/api/returns/quarantine?branchId=1')).data.receipts.find(row=>row.returnLineId===approved.data.return.lines[0].id);
  assert.equal(held.status,'quarantined');
  assert.equal(held.quantity,1);
  assert.ok(held.sourceStockMovementId);
  assert.equal((await api('POST',`/api/returns/quarantine/${held.id}/inspect`,{disposition:'release',reason:'Seal and expiry verified'},1,1)).status,403);
  const released=await api('POST',`/api/returns/quarantine/${held.id}/inspect`,{disposition:'release',reason:'Seal and expiry verified'},1,2);
  assert.equal(released.status,200);
  assert.equal(released.data.receipt.status,'released');
  assert.equal(released.data.receipt.events.length,2);
  assert.ok(released.data.receipt.releaseStockMovementId);
  assert.equal((await api('GET','/api/stock?branchId=1')).data.stock.find(row=>row.itemId===1).quantity,stockBefore+1);
  assert.equal((await api('POST',`/api/returns/quarantine/${held.id}/inspect`,{disposition:'release',reason:'Retry'},1,2)).status,409);
  assert.equal((await api('POST',`/api/returns/${id}/approve`,{},1,2)).data.alreadyApproved,true);
  assert.equal((await api('GET','/api/stock?branchId=1')).data.stock.find(row=>row.itemId===1).quantity,stockBefore+1);
  assert.equal((await api('GET','/api/gst/periods')).data.periods.find(row=>row.gstinId===1).salesTaxCents,2400);
});

test('returned allocated lot is held from FEFO until release; rejected units never become saleable', async t => {
  const {db,api}=await fixture(t);
  const lot=await api('POST','/api/batches/receive',{itemId:1,branchId:1,gstinId:1,batchCode:'CUSTOMER-RETURN-LOT',expiresOn:'2028-12-31',quantity:2,reason:'Fresh lot receipt',clientReference:'CUSTOMER-RETURN-LOT'});
  assert.equal(lot.status,200);
  const input={type:'sale',partyId:1,branchId:1,gstinId:1,invoiceDate:new Date().toISOString().slice(0,10),lines:[{itemId:1,quantity:2,unitPriceCents:1000,gstRateBps:1200}]};
  const invoice=(await api('POST','/api/invoices',input)).data.invoice;
  assert.equal((await api('POST',`/api/invoices/${invoice.id}/submit`,{})).status,200);
  assert.equal((await api('POST',`/api/invoices/${invoice.id}/approve`,{},1,2)).status,200);
  const before=db.prepare('SELECT COALESCE(SUM(quantity_delta),0) AS q FROM batch_movements WHERE batch_id=?').get(lot.data.batch.id).q;
  assert.equal(before,0);
  const returned=await api('POST','/api/returns',{invoiceId:invoice.id,lines:[{invoiceLineId:invoice.lines[0].id,quantity:2}],reason:'Two customer boxes returned'});
  assert.equal((await api('POST',`/api/returns/${returned.data.return.id}/approve`,{},1,2)).status,200);
  const held=(await api('GET','/api/returns/quarantine')).data.receipts.filter(row=>row.returnNumber===returned.data.return.number);
  assert.equal(held.length,1);
  assert.equal(held[0].batchId,lot.data.batch.id);
  assert.equal(held[0].quantity,2);
  assert.equal(db.prepare('SELECT COALESCE(SUM(quantity_delta),0) AS q FROM batch_movements WHERE batch_id=?').get(lot.data.batch.id).q,0);
  assert.equal((await api('POST',`/api/returns/quarantine/${held[0].id}/inspect`,{disposition:'reject',reason:'Seal tampered'},1,2)).status,200);
  assert.equal((await api('POST',`/api/returns/quarantine/${held[0].id}/inspect`,{disposition:'release',reason:'Changed mind'},1,2)).status,409);
  assert.equal(db.prepare('SELECT COALESCE(SUM(quantity_delta),0) AS q FROM batch_movements WHERE batch_id=?').get(lot.data.batch.id).q,0);
});

test('one return crossing two outbound lots retains each source lot and releases only inspected units', async t => {
  const {db,api}=await fixture(t);
  const lotInput=(code,expiresOn)=>({itemId:1,branchId:1,gstinId:1,batchCode:code,expiresOn,quantity:1,reason:'Two source lots',clientReference:code});
  const early=await api('POST','/api/batches/receive',lotInput('RETURN-SPLIT-EARLY','2028-01-01'));
  const late=await api('POST','/api/batches/receive',lotInput('RETURN-SPLIT-LATE','2028-12-31'));
  assert.equal(early.status,200); assert.equal(late.status,200);
  const source=(await api('POST','/api/invoices',{type:'sale',partyId:1,branchId:1,gstinId:1,invoiceDate:new Date().toISOString().slice(0,10),lines:[{itemId:1,quantity:2,unitPriceCents:1000,gstRateBps:1200}]})).data.invoice;
  await api('POST',`/api/invoices/${source.id}/submit`,{});
  assert.equal((await api('POST',`/api/invoices/${source.id}/approve`,{},1,2)).status,200);
  const returned=(await api('POST','/api/returns',{invoiceId:source.id,lines:[{invoiceLineId:source.lines[0].id,quantity:2}],reason:'Both lots recalled'})).data.return;
  assert.equal((await api('POST',`/api/returns/${returned.id}/approve`,{},1,2)).status,200);
  const held=(await api('GET','/api/returns/quarantine')).data.receipts.filter(row=>row.returnNumber===returned.number);
  assert.equal(held.length,2);
  assert.deepEqual(new Set(held.map(row=>row.batchId)),new Set([early.data.batch.id,late.data.batch.id]));
  assert.equal(new Set(held.map(row=>row.sourceStockMovementId)).size,2);
  assert.equal(held.reduce((sum,row)=>sum+row.quantity,0),2);
  assert.equal((await api('POST',`/api/returns/quarantine/${held[0].id}/inspect`,{disposition:'release',reason:'Inspected one lot'},1,2)).status,200);
  assert.equal(db.prepare('SELECT COALESCE(SUM(quantity_delta),0) AS q FROM batch_movements WHERE batch_id=?').get(held[0].batchId).q,1);
  assert.equal(db.prepare('SELECT COALESCE(SUM(quantity_delta),0) AS q FROM batch_movements WHERE batch_id=?').get(held[1].batchId).q,0);
});

test('expired returned lot cannot be released and stays quarantined for rejection', async t => {
  const {db,api}=await fixture(t);
  const lot=await api('POST','/api/batches/receive',{itemId:1,branchId:1,gstinId:1,batchCode:'RETURN-EXPIRY-CHECK',expiresOn:'2028-01-01',quantity:1,reason:'Expiry test receipt',clientReference:'RETURN-EXPIRY-CHECK'});
  const source=(await api('POST','/api/invoices',{type:'sale',partyId:1,branchId:1,gstinId:1,invoiceDate:new Date().toISOString().slice(0,10),lines:[{itemId:1,quantity:1,unitPriceCents:1000,gstRateBps:1200}]})).data.invoice;
  await api('POST',`/api/invoices/${source.id}/submit`,{});
  assert.equal((await api('POST',`/api/invoices/${source.id}/approve`,{},1,2)).status,200);
  const returned=(await api('POST','/api/returns',{invoiceId:source.id,lines:[{invoiceLineId:source.lines[0].id,quantity:1}],reason:'Expired on return'})).data.return;
  assert.equal((await api('POST',`/api/returns/${returned.id}/approve`,{},1,2)).status,200);
  const held=(await api('GET','/api/returns/quarantine')).data.receipts.find(row=>row.returnNumber===returned.number);
  assert.equal(held.batchId,lot.data.batch.id);
  db.prepare("UPDATE batch_lots SET expires_on='2025-01-01' WHERE id=?").run(lot.data.batch.id);
  assert.equal((await api('POST',`/api/returns/quarantine/${held.id}/inspect`,{disposition:'release',reason:'Too late'},1,2)).status,409);
  assert.equal((await api('GET','/api/returns/quarantine')).data.receipts.find(row=>row.id===held.id).status,'quarantined');
  assert.equal((await api('POST',`/api/returns/quarantine/${held.id}/inspect`,{disposition:'reject',reason:'Expired at inspection'},1,2)).status,200);
});

test('linked order fulfillment sale return traces the original dispatch instead of posting a second issue', async t => {
  const {db,api}=await fixture(t);
  const source=db.prepare("SELECT i.id,i.number,il.id AS line_id FROM invoices i JOIN invoice_lines il ON il.invoice_id=i.id WHERE i.company_id=1 AND i.type='sale' AND i.fulfillment_id IS NOT NULL LIMIT 1").get();
  assert.ok(source);
  const created=await api('POST','/api/returns',{invoiceId:source.id,lines:[{invoiceLineId:source.line_id,quantity:1}],reason:'Order linked customer return'});
  assert.equal(created.status,200);
  assert.equal((await api('POST',`/api/returns/${created.data.return.id}/approve`,{},1,2)).status,200);
  const held=(await api('GET','/api/returns/quarantine')).data.receipts.find(row=>row.returnNumber===created.data.return.number);
  assert.ok(held);
  const original=db.prepare('SELECT client_reference,quantity_delta FROM stock_movements WHERE id=?').get(held.sourceStockMovementId);
  assert.match(original.client_reference,/^order-fulfillment:/);
  assert.ok(original.quantity_delta<0);
});

test('return creator cannot approve their own return and quarantine is company scoped', async t => {
  const {api}=await fixture(t);
  const lineId=(await api('GET','/api/invoices/1')).data.invoice.lines[0].id;
  const created=await api('POST','/api/returns',{invoiceId:1,lines:[{invoiceLineId:lineId,quantity:1}],reason:'Maker checker test'},1,2);
  assert.equal(created.status,200);
  assert.equal((await api('POST',`/api/returns/${created.data.return.id}/approve`,{},1,2)).status,403);
  assert.equal((await api('POST',`/api/returns/${created.data.return.id}/approve`,{},1,3)).status,200);
  const held=(await api('GET','/api/returns/quarantine',undefined,1,2)).data.receipts.find(row=>row.returnNumber===created.data.return.number);
  assert.equal((await api('GET','/api/returns/quarantine',undefined,2,4)).data.receipts.length,0);
  assert.equal((await api('POST',`/api/returns/quarantine/${held.id}/inspect`,{disposition:'release',reason:'Cross company'},2,5)).status,404);
});

test('approved quantities cap further returns, and company/user boundaries hold', async t => {
  const { api } = await fixture(t);
  const lineId = (await api('GET','/api/invoices/1')).data.invoice.lines[0].id;
  const create = quantity => api('POST','/api/returns',{invoiceId:1,lines:[{invoiceLineId:lineId,quantity}],reason:'Damaged box'});
  assert.equal((await create(3)).status,409);
  const one = await create(1);
  const other = await create(2);
  assert.equal(other.status,200); // Competing drafts are checked again on approval.
  await api('POST',`/api/returns/${one.data.return.id}/approve`,{},1,2);
  assert.equal((await api('POST',`/api/returns/${other.data.return.id}/approve`,{},1,2)).status,409);
  assert.equal((await create(2)).status,409);
  assert.equal((await api('GET','/api/returns',undefined,2,4)).data.returns.length,0);
  assert.equal((await api('POST','/api/returns',{invoiceId:1,lines:[{invoiceLineId:lineId,quantity:1}],reason:'Cross company'},2,4)).status,404);
  assert.equal((await api('GET','/api/returns',undefined,2,1)).status,403);
});

test('purchase return creates debit note proposal and outbound stock movement', async t => {
  const { api } = await fixture(t);
  const purchases = (await api('GET','/api/invoices')).data.invoices.filter(row=>row.type==='purchase' && row.status==='approved' && row.branchId===1);
  const source = (await api('GET',`/api/invoices/${purchases[0].id}`)).data.invoice;
  const itemId = source.lines[0].itemId;
  const before = (await api('GET','/api/stock?branchId=1')).data.stock.find(row=>row.itemId===itemId).quantity;
  const created = await api('POST','/api/returns',{invoiceId:source.id,lines:[{invoiceLineId:source.lines[0].id,quantity:1}],reason:'Supplier batch rejected'});
  assert.equal(created.status,200);
  assert.match(created.data.return.number,/^DBN-/);
  assert.equal(created.data.return.kind,'purchase_return');
  assert.equal((await api('POST',`/api/returns/${created.data.return.id}/approve`,{},1,2)).status,200);
  assert.equal((await api('GET','/api/stock?branchId=1')).data.stock.find(row=>row.itemId===itemId).quantity,before-1);
});

test('reviewed source GST period permits physical return but leaves tax proposal outside GST', async t => {
  const { db,api } = await fixture(t);
  const lineId = (await api('GET','/api/invoices/1')).data.invoice.lines[0].id;
  const body = { invoiceId:1,lines:[{invoiceLineId:lineId,quantity:1}],reason:'Returned in source period' };
  db.prepare("UPDATE gst_periods SET status='reviewed' WHERE company_id=1 AND gstin_id=1 AND period=?").run(new Date().toISOString().slice(0,7));
  const created = await api('POST','/api/returns',body);
  assert.equal(created.status,200);
  assert.equal(created.data.return.sourcePeriodStatus,'reviewed');
  const approved = await api('POST',`/api/returns/${created.data.return.id}/approve`,{},1,2);
  assert.equal(approved.status,200);
  assert.equal(approved.data.return.sourcePeriodStatus,'reviewed');
  assert.equal(approved.data.return.taxProposalStatus,'unreviewed');
  assert.equal((await api('GET','/api/gst/periods')).data.periods.find(row=>row.gstinId===1).salesTaxCents,2400);
});

test('service return records commercial note without physical stock movement', async t => {
  const { api } = await fixture(t);
  const today = new Date().toISOString().slice(0,10);
  const input = {type:'sale',partyId:4,branchId:4,gstinId:3,invoiceDate:today,lines:[{itemId:4,quantity:1,unitPriceCents:10000,gstRateBps:1800}]};
  const invoice = (await api('POST','/api/invoices',input,2,4)).data.invoice;
  assert.equal((await api('POST',`/api/invoices/${invoice.id}/submit`,{},2,4)).status,200);
  assert.equal((await api('POST',`/api/invoices/${invoice.id}/approve`,{},2,5)).status,200);
  const created = await api('POST','/api/returns',{invoiceId:invoice.id,lines:[{invoiceLineId:invoice.lines[0].id,quantity:1}],reason:'Calibration service reversed'},2,4);
  assert.equal(created.status,200);
  const approved = await api('POST',`/api/returns/${created.data.return.id}/approve`,{},2,5);
  assert.equal(approved.status,200);
  assert.equal(approved.data.return.lines[0].stockMovementId,null);
  assert.equal((await api('GET','/api/stock?branchId=4',undefined,2,5)).data.stock.find(row=>row.itemId===4).quantity,0);
});

test('synthetic quarantine specimen seeds once from a traceable remaining sale unit without stock posting', async t => {
  const {db,api}=await fixture(t);
  const before=db.prepare('SELECT COALESCE(SUM(quantity_delta),0) AS q FROM stock_movements WHERE company_id=1 AND branch_id=1 AND item_id=3').get().q;
  seedQuarantineSpecimen(db);
  seedQuarantineSpecimen(db);
  const record=db.prepare("SELECT id,status FROM returns WHERE company_id=1 AND number='DEMO-CRN-MUM-QA-001'").get();
  assert.equal(record.status,'approved');
  const rows=(await api('GET','/api/returns/quarantine?branchId=1')).data.receipts.filter(row=>row.returnNumber==='DEMO-CRN-MUM-QA-001');
  assert.equal(rows.length,1);
  assert.equal(rows[0].status,'quarantined');
  assert.equal(rows[0].quantity,1);
  assert.equal(db.prepare('SELECT COALESCE(SUM(quantity_delta),0) AS q FROM stock_movements WHERE company_id=1 AND branch_id=1 AND item_id=3').get().q,before);
});
