import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const express = require('express');
const { openDatabase } = require('../db.cjs');
const { installLocationsSchema } = require('../locations-db.cjs');
const { registerConversionRoutes } = require('../conversion.cjs');
const { allowedScopes } = require('../access.cjs');

async function fixture(t) {
  const db = openDatabase(':memory:');
  installLocationsSchema(db);
  const app = express();
  app.use(express.json());
  app.use('/api', (req,_res,next) => {
    const companyId=Number(req.header('x-company-id')||1), userId=Number(req.header('x-user-id')||1);
    req.company=db.prepare('SELECT * FROM companies WHERE id=?').get(companyId);
    req.user=db.prepare('SELECT * FROM users WHERE id=? AND company_id=?').get(userId,companyId);
    if (!req.company || !req.user) return next(Object.assign(new Error('Unknown identity'),{status:403}));
    req.scopes=allowedScopes(db,{companyId,userId}); next();
  });
  registerConversionRoutes(app,db);
  app.use((error,_req,res,_next) => { const status=error.status || (error.code?.startsWith('SQLITE_CONSTRAINT') || [1555,2067].includes(error.errcode) ? 409 : 500); res.status(status).json({error:error.message}); });
  const server=app.listen(0);
  t.after(() => { server.close(); db.close(); });
  const base=`http://127.0.0.1:${server.address().port}`;
  const api=async (method,path,body,userId=1,companyId=1) => {
    const response=await fetch(`${base}${path}`,{method,headers:{'content-type':'application/json','x-user-id':String(userId),'x-company-id':String(companyId)},body:body===undefined?undefined:JSON.stringify(body)});
    return {status:response.status,data:await response.json()};
  };
  return {db,api};
}
const payload = (reference='CONV-001') => ({branchId:1,gstinId:1,sourceItemId:1,targetItemId:3,sourceQuantity:4,ratioNumerator:3,ratioDenominator:2,allowedWastageQuantity:1,actualWastageQuantity:1,costBasisCents:2400,costBasisReference:'Supplier bill SB-17 / reviewed allocation',reason:'Repack four boxes into syringe packs',clientReference:reference});
const balance=(db,itemId)=>db.prepare('SELECT COALESCE(SUM(quantity_delta),0) q FROM stock_movements WHERE company_id=1 AND branch_id=1 AND item_id=?').get(itemId).q;

async function reviewed(api,body=payload()) {
  const draft=await api('POST','/api/conversions',body);
  assert.equal(draft.status,200,JSON.stringify(draft.data));
  const id=draft.data.conversion.id;
  assert.equal((await api('POST',`/api/conversions/${id}/submit`,{})).status,200);
  assert.equal((await api('POST',`/api/conversions/${id}/review`,{reviewNote:'Ratio and bill checked'},2)).status,200);
  return id;
}

test('preview uses exact rational whole units, wastage and documented cost basis',async t=>{
  const {db,api}=await fixture(t);
  const source=balance(db,1),target=balance(db,3);
  const result=await api('POST','/api/conversions/preview',payload());
  assert.equal(result.status,200);
  assert.equal(result.data.expectedTargetQuantity,6);
  assert.equal(result.data.targetQuantity,5);
  assert.deepEqual(result.data.targetCostPerUnit,{numeratorCents:2400,denominatorUnits:5});
  assert.deepEqual(result.data.quantityAfter,{sourceQuantity:source-4,targetQuantity:target+5});
  assert.match(result.data.costNotice,/No valuation/);
  assert.equal(balance(db,1),source);
  assert.equal((await api('POST','/api/conversions/preview',{...payload(),ratioNumerator:1,ratioDenominator:3})).status,400);
  assert.equal((await api('POST','/api/conversions/preview',{...payload(),actualWastageQuantity:2})).status,400);
  assert.equal((await api('POST','/api/conversions/preview',{...payload(),targetItemId:1})).status,400);
});

test('staff draft needs independent review; posting is atomic and idempotent',async t=>{
  const {db,api}=await fixture(t);
  const before=[balance(db,1),balance(db,3)];
  const draft=await api('POST','/api/conversions',payload());
  const id=draft.data.conversion.id;
  assert.equal(draft.data.conversion.status,'draft');
  assert.equal((await api('POST','/api/conversions',payload())).data.replayed,true);
  assert.equal((await api('POST','/api/conversions',{...payload(),sourceQuantity:6})).status,409);
  assert.equal((await api('POST',`/api/conversions/${id}/post`,{})).status,409);
  assert.equal((await api('POST',`/api/conversions/${id}/submit`,{},2)).status,403);
  assert.equal((await api('POST',`/api/conversions/${id}/submit`,{})).status,200);
  assert.equal((await api('POST',`/api/conversions/${id}/review`,{reviewNote:'Cannot self-review'})).status,403);
  assert.equal((await api('POST',`/api/conversions/${id}/review`,{reviewNote:'Checked source and cost document'},2)).status,200);
  assert.equal((await api('POST',`/api/conversions/${id}/review`,{reviewNote:'Checked source and cost document'},2)).data.replayed,true);
  assert.equal((await api('POST',`/api/conversions/${id}/review`,{reviewNote:'Different evidence'},2)).status,409);
  const posted=await api('POST',`/api/conversions/${id}/post`,{});
  assert.equal(posted.status,200,JSON.stringify(posted.data));
  assert.equal(posted.data.conversion.status,'posted');
  assert.equal(posted.data.conversion.sourceMovementIds.length>=1,true);
  assert.equal(balance(db,1),before[0]-4);
  assert.equal(balance(db,3),before[1]+5);
  assert.equal((await api('POST',`/api/conversions/${id}/post`,{})).data.replayed,true);
  assert.equal(balance(db,3),before[1]+5);
  assert.deepEqual(posted.data.events.map(event=>event.action),['create','submit','review','post']);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM stock_movements WHERE client_reference=?').get(`conversion:${id}:target`).n,1);
});

test('review and posting honor company, branch grant, item status and live stock',async t=>{
  const {db,api}=await fixture(t);
  assert.equal((await api('POST','/api/conversions',payload(),5,2)).status,403);
  assert.equal((await api('POST','/api/conversions/preview',{...payload(),branchId:4,gstinId:3},1,1)).status,404);
  assert.equal((await api('POST','/api/conversions/preview',{...payload(),gstinId:2})).status,400);
  const id=await reviewed(api,payload('CONV-SCOPE'));
  assert.equal((await api('GET',`/api/conversions/${id}`,undefined,5,2)).status,404);
  assert.equal((await api('POST',`/api/conversions/${id}/post`,{},2)).status,403);
  db.prepare('UPDATE items SET active=0 WHERE id=3').run();
  assert.equal((await api('POST',`/api/conversions/${id}/post`,{})).status,400);
  db.prepare('UPDATE items SET active=1 WHERE id=3').run();
  db.prepare("INSERT INTO stock_movements(company_id,branch_id,item_id,quantity_delta,type,reason) VALUES (1,1,1,-999,'manual','Synthetic concurrent depletion')").run();
  assert.equal((await api('POST',`/api/conversions/${id}/post`,{})).status,409);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM stock_movements WHERE client_reference LIKE ?').get(`conversion:${id}:%`).n,0);
});

test('batch source is allocated with linked movements; conversion preserves assigned location stock',async t=>{
  const {db,api}=await fixture(t);
  const expires='2099-12-31';
  const batch=Number(db.prepare("INSERT INTO batch_lots(company_id,item_id,batch_code,expires_on) VALUES (1,1,'CONV-BATCH',?)").run(expires).lastInsertRowid);
  const stockId=Number(db.prepare("INSERT INTO stock_movements(company_id,branch_id,item_id,quantity_delta,type,reason) VALUES (1,1,1,0,'batch_assignment','Synthetic assignment')").run().lastInsertRowid);
  db.prepare("INSERT INTO batch_movements(company_id,batch_id,branch_id,gstin_id,quantity_delta,type,is_allocation,reason,request_signature,operation_reference,stock_movement_id,recorded_by) VALUES (1,?,1,1,4,'receipt',1,'Synthetic assignment','{}','conversion:test:allocation',?,1)").run(batch,stockId);
  const id=await reviewed(api,payload('CONV-BATCH'));
  const posted=await api('POST',`/api/conversions/${id}/post`,{});
  assert.equal(posted.status,200,JSON.stringify(posted.data));
  const out=db.prepare("SELECT b.quantity_delta,s.quantity_delta AS physical FROM batch_movements b JOIN stock_movements s ON s.id=b.stock_movement_id WHERE b.batch_id=? AND b.quantity_delta<0").get(batch);
  assert.equal(out.quantity_delta,-4); assert.equal(out.physical,-4);
  const location=Number(db.prepare("INSERT INTO locations(company_id,gstin_id,branch_id,kind,name,created_by) VALUES (1,1,1,'warehouse','Conversion test rack',1)").run().lastInsertRowid);
  db.prepare("INSERT INTO location_movements(company_id,location_id,item_id,quantity_delta,type,reason,actor_id) VALUES (1,?,1,1,'assignment','Synthetic location allocation',1)").run(location);
  const free=await reviewed(api,{...payload('CONV-LOC-FREE'),sourceQuantity:1,ratioNumerator:1,ratioDenominator:1,allowedWastageQuantity:0,actualWastageQuantity:0});
  assert.equal((await api('POST',`/api/conversions/${free}/post`,{})).status,200);
  const blocked=await reviewed(api,{...payload('CONV-LOC'),sourceQuantity:balance(db,1),ratioNumerator:1,ratioDenominator:1,allowedWastageQuantity:0,actualWastageQuantity:0});
  assert.equal((await api('POST',`/api/conversions/${blocked}/post`,{})).status,409);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM stock_movements WHERE client_reference LIKE ?').get(`conversion:${blocked}:%`).n,0);
});

test('schema install is repeatable',async t=>{ const {db}=await fixture(t); registerConversionRoutes(express(),db); assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name='stock_conversions'").get().name,'stock_conversions'); });

test('a target receipt conflict rolls back the source batch issue and leaves review intact',async t=>{
  const {db,api}=await fixture(t);
  const id=await reviewed(api,payload('CONV-ROLLBACK'));
  const before=balance(db,1);
  db.prepare("INSERT INTO stock_movements(company_id,branch_id,item_id,quantity_delta,type,reason,client_reference) VALUES (1,1,3,0,'manual','Synthetic reference collision',?)").run(`conversion:${id}:target`);
  const attempted=await api('POST',`/api/conversions/${id}/post`,{});
  assert.equal(attempted.status,409);
  assert.equal(balance(db,1),before);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM stock_movements WHERE client_reference LIKE ?').get(`conversion:${id}:source:%`).n,0);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM batch_issue_operations WHERE source_reference=?').get(`conversion:${id}:source`).n,0);
  assert.equal((await api('GET',`/api/conversions/${id}`)).data.conversion.status,'reviewed');
});
