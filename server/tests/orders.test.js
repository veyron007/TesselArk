import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require=createRequire(import.meta.url);
const { openDatabase }=require('../db.cjs');
const express=require('express');
const { registerOrdersRoutes }=require('../orders.cjs');
const { registerBatchInventoryRoutes }=require('../batch-inventory.cjs');

async function fixture(t) {
  const db=openDatabase(':memory:');
  const app=express();
  app.use(express.json());
  app.use('/api',(req,_res,next)=>{
    const companyId=Number(req.header('x-company-id')||1),userId=Number(req.header('x-user-id')||1);
    req.company=db.prepare('SELECT * FROM companies WHERE id=?').get(companyId);
    req.user=db.prepare('SELECT * FROM users WHERE id=? AND company_id=?').get(userId,companyId);
    if (!req.company || !req.user) return next(Object.assign(new Error('Unknown company or user'),{status:403}));
    next();
  });
  registerOrdersRoutes(app,db);
  registerBatchInventoryRoutes(app,db);
  app.use((error,_req,res,_next)=>res.status(error.status||(error.code?.startsWith('SQLITE_CONSTRAINT')?409:500)).json({error:error.message}));
  const server=app.listen(0);
  t.after(()=>{server.close();db.close();});
  const base=`http://127.0.0.1:${server.address().port}`;
  const api=async(method,path,body,company=1,user=1)=>{
    const response=await fetch(base+path,{method,headers:{'content-type':'application/json','x-company-id':String(company),'x-user-id':String(user)},body:body===undefined?undefined:JSON.stringify(body)});
    return {status:response.status,data:await response.json()};
  };
  return {db,api};
}

const orderBody=(type='sale')=>({type,number:`${type==='sale'?'SO':'PO'}-TEST-1`,orderDate:new Date().toISOString().slice(0,10),gstinId:1,branchId:1,partyId:type==='sale'?1:2,lines:[{itemId:1,quantity:5,unitPriceCents:12000}]});

test('sales order dispatch is partial, stock posts on confirm exactly once, and over-dispatch fails',async t=>{
  const {api,db}=await fixture(t);
  const stock=()=>db.prepare('SELECT COALESCE(SUM(quantity_delta),0) AS quantity FROM stock_movements WHERE branch_id=1 AND item_id=1').get().quantity;
  const before=stock();
  const created=await api('POST','/api/orders',orderBody());
  assert.equal(created.status,200);
  const id=created.data.order.id;
  assert.equal(created.data.order.status,'draft');
  assert.equal((await api('POST',`/api/orders/${id}/fulfillments`,{number:'DC-1',eventDate:new Date().toISOString().slice(0,10),lines:[{orderLineId:created.data.order.lines[0].id,quantity:2}]})).status,409);
  assert.equal((await api('POST',`/api/orders/${id}/confirm`,{})).status,200);
  const lineId=created.data.order.lines[0].id;
  const draft=await api('POST',`/api/orders/${id}/fulfillments`,{number:'DC-1',eventDate:new Date().toISOString().slice(0,10),lines:[{orderLineId:lineId,quantity:2}]});
  assert.equal(draft.status,200);
  assert.equal(stock(),before);
  const fulfillmentId=draft.data.fulfillment.id;
  const confirmed=await api('POST',`/api/orders/fulfillments/${fulfillmentId}/confirm`,{});
  assert.equal(confirmed.status,200);
  assert.equal(confirmed.data.order.remainingQuantity,3);
  assert.equal(stock(),before-2);
  assert.equal((await api('POST',`/api/orders/fulfillments/${fulfillmentId}/confirm`,{})).data.replayed,true);
  assert.equal(stock(),before-2);
  assert.equal((await api('POST',`/api/orders/${id}/fulfillments`,{number:'DC-2',eventDate:new Date().toISOString().slice(0,10),lines:[{orderLineId:lineId,quantity:4}]})).status,409);
  const events=(await api('GET',`/api/orders/${id}/events`)).data.events;
  assert.deepEqual(events.map(event=>event.action),['create','confirm','create_fulfillment','confirm_fulfillment']);
});

test('competing draft dispatches are rechecked atomically at confirmation',async t=>{
  const {api,db}=await fixture(t);
  const created=(await api('POST','/api/orders',orderBody())).data.order;
  await api('POST',`/api/orders/${created.id}/confirm`,{});
  const make=number=>api('POST',`/api/orders/${created.id}/fulfillments`,{number,eventDate:new Date().toISOString().slice(0,10),lines:[{orderLineId:created.lines[0].id,quantity:4}]});
  const first=await make('DC-A'),second=await make('DC-B');
  assert.equal(first.status,200); assert.equal(second.status,200);
  assert.equal((await api('POST',`/api/orders/fulfillments/${first.data.fulfillment.id}/confirm`,{})).status,200);
  assert.equal((await api('POST',`/api/orders/fulfillments/${second.data.fulfillment.id}/confirm`,{})).status,409);
  assert.equal(db.prepare('SELECT status FROM order_fulfillments WHERE id=?').get(second.data.fulfillment.id).status,'draft');
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM stock_movements WHERE client_reference LIKE ?').get(`order-fulfillment:${first.data.fulfillment.id}:%`).count,1);
});

test('purchase receipt increases stock and company, GSTIN, party validation is enforced',async t=>{
  const {api,db}=await fixture(t);
  const badScope={...orderBody('purchase'),branchId:3};
  assert.equal((await api('POST','/api/orders',badScope)).status,400);
  assert.equal((await api('POST','/api/orders',{...orderBody('purchase'),partyId:1})).status,400);
  const created=(await api('POST','/api/orders',orderBody('purchase'))).data.order;
  const before=db.prepare('SELECT COALESCE(SUM(quantity_delta),0) AS quantity FROM stock_movements WHERE branch_id=1 AND item_id=1').get().quantity;
  await api('POST',`/api/orders/${created.id}/confirm`,{});
  const receipt=(await api('POST',`/api/orders/${created.id}/fulfillments`,{number:'GRN-A',eventDate:new Date().toISOString().slice(0,10),lines:[{orderLineId:created.lines[0].id,quantity:5}]})).data.fulfillment;
  assert.equal((await api('POST',`/api/orders/fulfillments/${receipt.id}/confirm`,{})).status,200);
  assert.equal(db.prepare('SELECT COALESCE(SUM(quantity_delta),0) AS quantity FROM stock_movements WHERE branch_id=1 AND item_id=1').get().quantity,before+5);
  assert.equal((await api('GET',`/api/orders/${created.id}`,undefined,2,4)).status,404);
  assert.equal((await api('GET','/api/orders',undefined,2,4)).data.orders.length,0);
});

test('insufficient dispatch stock rolls back and service fulfillment never posts physical stock',async t=>{
  const {api,db}=await fixture(t);
  const tooLarge={...orderBody(),number:'SO-HUGE',lines:[{itemId:1,quantity:9999,unitPriceCents:100}]};
  const created=(await api('POST','/api/orders',tooLarge)).data.order;
  await api('POST',`/api/orders/${created.id}/confirm`,{});
  const dispatch=(await api('POST',`/api/orders/${created.id}/fulfillments`,{number:'DC-HUGE',eventDate:today(),lines:[{orderLineId:created.lines[0].id,quantity:9999}]})).data.fulfillment;
  const countBefore=db.prepare('SELECT COUNT(*) AS n FROM stock_movements').get().n;
  assert.equal((await api('POST',`/api/orders/fulfillments/${dispatch.id}/confirm`,{})).status,409);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM stock_movements').get().n,countBefore);
  assert.equal(db.prepare('SELECT status FROM order_fulfillments WHERE id=?').get(dispatch.id).status,'draft');

  const service=(await api('POST','/api/orders',{type:'sale',number:'SO-SERVICE',orderDate:today(),gstinId:3,branchId:4,partyId:4,lines:[{itemId:4,quantity:2,unitPriceCents:15000}]},2,4)).data.order;
  await api('POST',`/api/orders/${service.id}/confirm`,{},2,4);
  const serviceDispatch=(await api('POST',`/api/orders/${service.id}/fulfillments`,{number:'DC-SERVICE',eventDate:today(),lines:[{orderLineId:service.lines[0].id,quantity:2}]},2,4)).data.fulfillment;
  const done=await api('POST',`/api/orders/fulfillments/${serviceDispatch.id}/confirm`,{},2,4);
  assert.equal(done.status,200);
  assert.equal(done.data.fulfillment.lines[0].stockMovementId,null);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM stock_movements').get().n,countBefore);
});

test('order references are unique per company and counterparty identity is snapshotted',async t=>{
  const {api,db}=await fixture(t);
  const first=await api('POST','/api/orders',orderBody());
  assert.equal(first.status,200);
  assert.equal((await api('POST','/api/orders',orderBody())).status,409);
  db.prepare("UPDATE parties SET name='Renamed customer' WHERE id=1").run();
  const historic=(await api('GET',`/api/orders/${first.data.order.id}`)).data.order;
  assert.equal(historic.partyNameSnapshot,'Harbor Clinic');
  assert.equal((await api('POST','/api/orders',{...orderBody(),number:'SO-TEST-OTHER'},2,4)).status,400);
});

test('sale dispatch allocates batch stock once and keeps physical and batch ledgers aligned',async t=>{
  const {api,db}=await fixture(t);
  const receive=await api('POST','/api/batches/receive',{itemId:1,branchId:1,gstinId:1,batchCode:'LOT-ORDER-TEST',expiresOn:'2028-12-31',quantity:2,reason:'Order dispatch test',clientReference:'LOT-ORDER-TEST'});
  assert.equal(receive.status,200);
  const batchId=receive.data.batch.id;
  const beforeStock=db.prepare('SELECT COALESCE(SUM(quantity_delta),0) AS q FROM stock_movements WHERE company_id=1 AND branch_id=1 AND item_id=1').get().q;
  const created=(await api('POST','/api/orders',{...orderBody(),number:'SO-BATCH-TEST',lines:[{itemId:1,quantity:2,unitPriceCents:12000}]})).data.order;
  await api('POST',`/api/orders/${created.id}/confirm`,{});
  const fulfillment=(await api('POST',`/api/orders/${created.id}/fulfillments`,{number:'DC-BATCH-TEST',eventDate:today(),lines:[{orderLineId:created.lines[0].id,quantity:2}]})).data.fulfillment;
  const result=await api('POST',`/api/orders/fulfillments/${fulfillment.id}/confirm`,{});
  assert.equal(result.status,200);
  assert.ok(result.data.fulfillment.lines[0].stockMovementId);
  assert.deepEqual(result.data.fulfillment.lines[0].allocation.batchLegs.map(leg=>[leg.batchId,leg.quantity]),[[batchId,2]]);
  assert.equal(db.prepare('SELECT COALESCE(SUM(quantity_delta),0) AS q FROM batch_movements WHERE batch_id=? AND branch_id=1').get(batchId).q,0);
  assert.equal(db.prepare('SELECT COALESCE(SUM(quantity_delta),0) AS q FROM stock_movements WHERE company_id=1 AND branch_id=1 AND item_id=1').get().q,beforeStock-2);
  assert.equal((await api('POST',`/api/orders/fulfillments/${fulfillment.id}/confirm`,{})).data.replayed,true);
  assert.equal(db.prepare('SELECT COALESCE(SUM(quantity_delta),0) AS q FROM batch_movements WHERE batch_id=? AND branch_id=1').get(batchId).q,0);
});

test('orders reject composition GST and money values too large for linked invoicing',async t=>{
  const {api}=await fixture(t);
  const composition={type:'sale',number:'SO-COMP-TEST',orderDate:today(),gstinId:4,branchId:5,partyId:6,lines:[{itemId:5,quantity:1,unitPriceCents:10000,gstRateBps:1200}]};
  assert.equal((await api('POST','/api/orders',composition,3,6)).status,400);
  assert.equal((await api('POST','/api/orders',{...composition,lines:[{...composition.lines[0],gstRateBps:0}]},3,6)).status,200);
  assert.equal((await api('POST','/api/orders',{...orderBody(),number:'SO-OVERFLOW-LINE',lines:[{itemId:1,quantity:Number.MAX_SAFE_INTEGER,unitPriceCents:2}]})).status,400);
  const large=Math.floor(Number.MAX_SAFE_INTEGER/2);
  assert.equal((await api('POST','/api/orders',{...orderBody(),number:'SO-OVERFLOW-TOTAL',lines:[{itemId:1,quantity:1,unitPriceCents:large,gstRateBps:0},{itemId:2,quantity:1,unitPriceCents:large,gstRateBps:0},{itemId:3,quantity:1,unitPriceCents:large,gstRateBps:0}]})).status,400);
});

function today(){return new Date().toISOString().slice(0,10);}
