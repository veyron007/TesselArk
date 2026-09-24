import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require=createRequire(import.meta.url);
const express=require('express');
const { openDatabase }=require('../db.cjs');
const { registerCountsRoutes }=require('../counts.cjs');
const { installLocationsSchema }=require('../locations-db.cjs');
const { allowedScopes }=require('../access.cjs');

async function fixture(t) {
  const db=openDatabase(':memory:'), app=express();
  app.use(express.json());
  app.use('/api',(req,_res,next) => {
    const companyId=Number(req.header('x-company-id') || 1),userId=Number(req.header('x-user-id') || 1);
    req.company=db.prepare('SELECT * FROM companies WHERE id=?').get(companyId);
    req.user=db.prepare('SELECT * FROM users WHERE id=? AND company_id=?').get(userId,companyId);
    if (!req.company || !req.user) return next(Object.assign(new Error('Invalid identity'),{status:403}));
    req.scopes=allowedScopes(db,{companyId,userId}); next();
  });
  registerCountsRoutes(app,db);
  registerCountsRoutes(app,db); // schema installation can repeat on startup
  app.use((error,_req,res,_next) => res.status(error.status || 500).json({error:error.message}));
  const server=app.listen(0);
  t.after(() => {server.close(); db.close();});
  const base=`http://127.0.0.1:${server.address().port}`;
  const api=async(method,path,body,companyId=1,userId=1) => {
    const response=await fetch(base+path,{method,headers:{'content-type':'application/json','x-company-id':String(companyId),'x-user-id':String(userId)},body:body===undefined?undefined:JSON.stringify(body)});
    return {status:response.status,data:await response.json()};
  };
  return {db,api};
}
const physical=(db,branchId,itemId) => db.prepare('SELECT COALESCE(SUM(quantity_delta),0) quantity FROM stock_movements WHERE company_id=1 AND branch_id=? AND item_id=?').get(branchId,itemId).quantity;
const create=async(api,branchId,itemId) => {
  const result=await api('POST','/api/counts',{gstinId:branchId===3?2:1,branchId,itemIds:[itemId]});
  assert.equal(result.status,200,JSON.stringify(result.data));
  return result.data.session;
};

test('count difference needs reason and independent approval posts one audited physical adjustment',async t => {
  const {db,api}=await fixture(t);
  const before=physical(db,1,3), created=await create(api,1,3),line=created.lines[0];
  assert.equal(line.recordedQuantity,before);
  assert.equal((await api('POST',`/api/counts/${created.id}/submit`,{})).status,400);
  assert.equal((await api('PUT',`/api/counts/${created.id}/lines/${line.id}`,{countedQuantity:before-2,reason:''})).status,400);
  assert.equal((await api('PUT',`/api/counts/${created.id}/lines/${line.id}`,{countedQuantity:before-2,reason:'Shelf shortage investigated'})).status,200);
  assert.equal((await api('POST',`/api/counts/${created.id}/submit`,{})).status,200);
  assert.equal((await api('POST',`/api/counts/${created.id}/review`,{decision:'approve',reason:'Checked evidence'})).status,403);
  const approved=await api('POST',`/api/counts/${created.id}/review`,{decision:'approve',reason:'Checked evidence'},1,2);
  assert.equal(approved.status,200,JSON.stringify(approved.data));
  assert.equal(approved.data.session.status,'approved');
  assert.equal(physical(db,1,3),before-2);
  assert.ok(approved.data.session.lines[0].stockMovementId);
  assert.deepEqual(approved.data.session.events.map(event=>event.action),['create','record_line','submit','approved']);
  const replay=await api('POST',`/api/counts/${created.id}/review`,{decision:'approve',reason:'Checked evidence'},1,2);
  assert.equal(replay.data.replayed,true);
  assert.equal(physical(db,1,3),before-2);
  assert.equal(db.prepare("SELECT COUNT(*) count FROM stock_movements WHERE client_reference LIKE 'count:%'").get().count,1);
});

test('stale snapshots and batch allocations block posting atomically',async t => {
  const {db,api}=await fixture(t);
  const stale=await create(api,1,3),line=stale.lines[0];
  await api('PUT',`/api/counts/${stale.id}/lines/${line.id}`,{countedQuantity:line.recordedQuantity-1,reason:'Missing unit'});
  await api('POST',`/api/counts/${stale.id}/submit`,{});
  db.prepare("INSERT INTO stock_movements(company_id,branch_id,item_id,quantity_delta,type,reason) VALUES (1,1,3,1,'purchase','Concurrent receipt')").run();
  assert.equal((await api('POST',`/api/counts/${stale.id}/review`,{decision:'approve'},1,2)).status,409);
  assert.equal(physical(db,1,3),line.recordedQuantity+1);
  const batch=await create(api,2,1),batchLine=batch.lines[0];
  await api('PUT',`/api/counts/${batch.id}/lines/${batchLine.id}`,{countedQuantity:9,reason:'Shortage below lot allocation'});
  await api('POST',`/api/counts/${batch.id}/submit`,{});
  assert.equal((await api('POST',`/api/counts/${batch.id}/review`,{decision:'approve'},1,2)).status,409);
  assert.equal(physical(db,2,1),batchLine.recordedQuantity);
  assert.equal(db.prepare("SELECT COUNT(*) count FROM stock_movements WHERE client_reference LIKE 'count:%'").get().count,0);
});

test('count cannot write off stock classified across both batches and locations',async t => {
  const {db,api}=await fixture(t);
  installLocationsSchema(db);
  const locationId=Number(db.prepare("INSERT INTO locations(company_id,gstin_id,branch_id,kind,name,created_by) VALUES (1,1,2,'warehouse','Count test shelf',1)").run().lastInsertRowid);
  db.prepare("INSERT INTO location_movements(company_id,location_id,item_id,quantity_delta,type,reason,actor_id) VALUES (1,?,1,5,'assignment','Existing unbatched shelf stock',1)").run(locationId);
  const created=await create(api,2,1),line=created.lines[0];
  assert.equal(line.recordedQuantity,20);
  await api('PUT',`/api/counts/${created.id}/lines/${line.id}`,{countedQuantity:12,reason:'Shelf shortage under investigation'});
  await api('POST',`/api/counts/${created.id}/submit`,{});
  assert.equal((await api('POST',`/api/counts/${created.id}/review`,{decision:'approve'},1,2)).status,409);
  assert.equal(physical(db,2,1),20);
});

test('company, GSTIN, branch grants and roles gate count and proposal access',async t => {
  const {db,api}=await fixture(t);
  const created=await create(api,1,3);
  assert.equal((await api('GET',`/api/counts/${created.id}`,undefined,2,4)).status,404);
  assert.equal((await api('POST','/api/counts',{gstinId:2,branchId:1,itemIds:[3]})).status,400);
  assert.equal((await api('POST','/api/counts',{gstinId:1,branchId:1,itemIds:[3]},1,2)).status,403);
  assert.equal((await api('POST','/api/counts',{gstinId:1,branchId:1,itemIds:[6]})).status,404);
  db.prepare("UPDATE user_branch_grants SET revoked_at=CURRENT_TIMESTAMP,revoked_by=3,revoked_reason='Test' WHERE company_id=1 AND user_id=1 AND branch_id=1 AND revoked_at IS NULL").run();
  assert.equal((await api('GET',`/api/counts/${created.id}`)).status,403);
  assert.equal((await api('GET','/api/replenishment?branchId=1')).status,403);
});

test('replenishment arithmetic separates posted sales from unfulfilled commitments and reviews a saved proposal',async t => {
  const {db,api}=await fixture(t);
  db.prepare("UPDATE items SET reorder_level=60 WHERE id=3 AND company_id=1").run();
  const row=(await api('GET','/api/replenishment?branchId=1&gstinId=1&lookbackDays=90&coverDays=30')).data.rows.find(item=>item.itemId===3);
  assert.equal(row.onHandUnits,physical(db,1,3));
  assert.equal(row.targetUnits,60);
  assert.equal(row.proposedUnits,Math.max(0,row.targetUnits-(row.onHandUnits+row.pendingSupplyUnits-row.openSalesUnits)));
  const submitted=await api('POST','/api/replenishment/proposals',{gstinId:1,branchId:1,itemId:3,lookbackDays:90,coverDays:30});
  assert.equal(submitted.status,200,JSON.stringify(submitted.data));
  const id=submitted.data.proposal.id;
  assert.equal((await api('POST',`/api/replenishment/proposals/${id}/review`,{decision:'approve'})).status,403);
  const approved=await api('POST',`/api/replenishment/proposals/${id}/review`,{decision:'approve',reason:'Buyer may prepare a PO'},1,2);
  assert.equal(approved.status,200,JSON.stringify(approved.data));
  assert.equal(approved.data.proposal.status,'approved');
  assert.equal((await api('POST',`/api/replenishment/proposals/${id}/review`,{decision:'approve',reason:'Buyer may prepare a PO'},1,2)).data.replayed,true);
  assert.equal(db.prepare('SELECT COUNT(*) count FROM orders WHERE company_id=1 AND number LIKE ?',).get('count:%').count,0);
});

test('confirmed partial dispatch contributes once to sales pace and only its remaining order quantity to open demand',async t => {
  const {db,api}=await fixture(t);
  const before=(await api('GET','/api/replenishment?branchId=1')).data.rows.find(row=>row.itemId===3);
  const customer=db.prepare("SELECT id FROM parties WHERE company_id=1 AND type IN ('customer','both') LIMIT 1").get().id;
  const supplier=db.prepare("SELECT id FROM parties WHERE company_id=1 AND type IN ('supplier','both') LIMIT 1").get().id;
  const saleId=Number(db.prepare("INSERT INTO orders(company_id,gstin_id,branch_id,party_id,party_name_snapshot,type,number,status,order_date,created_by) VALUES (1,1,1,?,'Test customer','sale','COUNT-SALE','confirmed',date('now'),1)").run(customer).lastInsertRowid);
  const purchaseId=Number(db.prepare("INSERT INTO orders(company_id,gstin_id,branch_id,party_id,party_name_snapshot,type,number,status,order_date,created_by) VALUES (1,1,1,?,'Test supplier','purchase','COUNT-PURCHASE','confirmed',date('now'),1)").run(supplier).lastInsertRowid);
  const saleLineId=Number(db.prepare("INSERT INTO order_lines(order_id,item_id,item_name_snapshot,quantity,unit_price_cents,gst_rate_bps) VALUES (?,3,'Test item',7,100,1800)").run(saleId).lastInsertRowid);
  db.prepare("INSERT INTO order_lines(order_id,item_id,item_name_snapshot,quantity,unit_price_cents,gst_rate_bps) VALUES (?,3,'Test item',5,100,1800)").run(purchaseId);
  const fulfillmentId=Number(db.prepare("INSERT INTO order_fulfillments(order_id,company_id,number,kind,status,event_date,created_by) VALUES (?,1,'COUNT-DISPATCH','dispatch','confirmed',date('now'),1)").run(saleId).lastInsertRowid);
  db.prepare('INSERT INTO order_fulfillment_lines(fulfillment_id,order_line_id,quantity) VALUES (?,?,2)').run(fulfillmentId,saleLineId);
  db.prepare("INSERT INTO stock_movements(company_id,branch_id,item_id,quantity_delta,type,reason) VALUES (1,1,3,-2,'sales_dispatch','Test dispatch')").run();
  const after=(await api('GET','/api/replenishment?branchId=1')).data.rows.find(row=>row.itemId===3);
  assert.equal(after.actualSalesUnits,before.actualSalesUnits+2);
  assert.equal(after.openSalesUnits,before.openSalesUnits+5);
  assert.equal(after.pendingSupplyUnits,before.pendingSupplyUnits+5);
  assert.equal(after.onHandUnits,before.onHandUnits-2);
});

test('review refuses a replenishment proposal when its stock snapshot has changed',async t => {
  const {db,api}=await fixture(t);
  db.prepare('UPDATE items SET reorder_level=100 WHERE id=3 AND company_id=1').run();
  const saved=await api('POST','/api/replenishment/proposals',{gstinId:1,branchId:1,itemId:3});
  assert.equal(saved.status,200);
  db.prepare("INSERT INTO stock_movements(company_id,branch_id,item_id,quantity_delta,type,reason) VALUES (1,1,3,1,'purchase','New receipt')").run();
  const review=await api('POST',`/api/replenishment/proposals/${saved.data.proposal.id}/review`,{decision:'approve'},1,2);
  assert.equal(review.status,409);
  assert.equal(db.prepare('SELECT status FROM reorder_proposals WHERE id=?').get(saved.data.proposal.id).status,'pending');
});
