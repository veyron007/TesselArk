import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require=createRequire(import.meta.url);
const { openDatabase }=require('../db.cjs');
const { createApp }=require('../api.cjs');
const { grantGstin,grantBranch }=require('../access.cjs');

test('one-branch grant filters operational lists and rejects source ID actions',async t=>{
  const db=openDatabase(':memory:');
  const userId=Number(db.prepare("INSERT INTO users(company_id,name,role) VALUES (1,'Restricted Accountant','accountant')").run().lastInsertRowid);
  grantGstin(db,{companyId:1,actorId:3,userId,gstinId:1,reason:'Operational scope test'});
  grantBranch(db,{companyId:1,actorId:3,userId,branchId:1,reason:'Operational scope test'});
  const server=createApp({db}).listen(0);
  t.after(()=>{server.close();db.close();});
  const base=`http://127.0.0.1:${server.address().port}`;
  const api=async(method,path,body)=>{
    const response=await fetch(base+path,{method,headers:{'content-type':'application/json','x-company-id':'1','x-user-id':String(userId)},body:body===undefined?undefined:JSON.stringify(body)});
    return {status:response.status,data:await response.json()};
  };
  const [orders,returns,tax,batches,settlements]=await Promise.all([
    api('GET','/api/orders'),api('GET','/api/returns'),api('GET','/api/return-tax/reviews'),
    api('GET','/api/batches'),api('GET','/api/return-settlements')
  ]);
  assert.equal(orders.status,200);
  assert.deepEqual(orders.data.orders,[]);
  assert.equal(returns.status,200);
  assert.ok(returns.data.returns.length>0);
  assert.ok(returns.data.returns.every(row=>row.branchId===1));
  assert.equal(tax.status,200);
  assert.ok(tax.data.reviews.every(row=>row.branchId===1));
  assert.equal(batches.status,200);
  assert.ok(batches.data.batches.every(row=>row.branchId===1));
  assert.ok(batches.data.ledger.every(row=>row.branchId===1));
  assert.equal(settlements.status,200);

  const forbidden=[
    ['GET','/api/orders/1'],['GET','/api/orders/1/events'],['POST','/api/orders/1/confirm',{}],
    ['GET','/api/returns?branchId=3'],['POST','/api/returns/2/approve',{}],
    ['GET','/api/return-tax/reviews/1'],['POST','/api/return-tax/reviews/1/decision',{decision:'eligible',period:'2026-08',reason:'Denied'}],
    ['POST','/api/return-settlements',{returnId:1,settlementDate:'2026-09-24'}],
    ['GET','/api/batches?branchId=3'],['GET','/api/return-tax/preview?gstinId=1&period=2026-08']
  ];
  for (const [method,path,body] of forbidden) assert.equal((await api(method,path,body)).status,403,`${method} ${path}`);

  assert.equal((await api('GET','/api/returns?branchId=1')).status,200);
  const orderBody={type:'sale',number:'RESTRICTED-SO-1',orderDate:'2026-09-24',gstinId:1,branchId:1,partyId:1,
    lines:[{itemId:1,quantity:1,unitPriceCents:1000}]};
  const allowedOrder=await api('POST','/api/orders',orderBody);
  assert.equal(allowedOrder.status,200);
  assert.equal((await api('GET',`/api/orders/${allowedOrder.data.order.id}`)).status,200);
  assert.equal((await api('POST','/api/orders',{...orderBody,number:'RESTRICTED-SO-2',gstinId:2,branchId:3})).status,403);
  const receipt=await api('POST','/api/batches/receive',{
    itemId:1,branchId:3,batchCode:'DENIED-LOT',expiresOn:'2028-01-01',quantity:1,reason:'Denied'
  });
  assert.equal(receipt.status,403);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM batch_lots WHERE batch_code='DENIED-LOT'").get().count,0);
});
