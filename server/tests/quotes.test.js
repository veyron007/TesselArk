import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const require=createRequire(import.meta.url);
const express=require('express');
const {openDatabase}=require('../db.cjs');
const {registerQuotesRoutes}=require('../quotes.cjs');
const {seedQuoteDemo}=require('../quotes-db.cjs');

async function fixture(t) {
  const db=openDatabase(':memory:');
  const app=express();app.use(express.json());
  app.use('/api',(req,_res,next)=>{
    const companyId=Number(req.header('x-company-id')||1),userId=Number(req.header('x-user-id')||1);
    req.company=db.prepare('SELECT * FROM companies WHERE id=?').get(companyId);
    req.user=db.prepare('SELECT * FROM users WHERE id=? AND company_id=?').get(userId,companyId);
    if(!req.company||!req.user)return next(Object.assign(new Error('Unknown company or user'),{status:403}));
    next();
  });
  registerQuotesRoutes(app,db);
  app.use((error,_req,res,_next)=>res.status(error.status||(error.code?.startsWith('SQLITE_CONSTRAINT')?409:500)).json({error:error.message}));
  const server=app.listen(0);
  t.after(()=>{server.close();db.close();});
  const base=`http://127.0.0.1:${server.address().port}`;
  const api=async(method,url,body,user=1,company=1)=>{
    const response=await fetch(base+url,{method,headers:{'content-type':'application/json','x-company-id':String(company),'x-user-id':String(user)},body:body===undefined?undefined:JSON.stringify(body)});
    return {status:response.status,data:await response.json()};
  };
  return {db,api};
}
const today=()=>new Date().toISOString().slice(0,10);
const future=()=>new Date(Date.now()+30*86400000).toISOString().slice(0,10);
const past=()=>new Date(Date.now()-86400000).toISOString().slice(0,10);
const body=(number='Q-TEST-1')=>({number,quoteDate:today(),expiryDate:future(),gstinId:1,branchId:1,partyId:1,notes:'Valid for thirty days',lines:[{itemId:1,quantity:3,unitPriceCents:12345,gstRateBps:1200},{itemId:2,quantity:2,unitPriceCents:5000,gstRateBps:1200}]});

test('quotation terms snapshot, independent review and replay-safe conversion to draft sales order without posting',async t=>{
  const {db,api}=await fixture(t);
  const stockBefore=db.prepare('SELECT COUNT(*) AS n FROM stock_movements').get().n;
  const invoiceBefore=db.prepare('SELECT COUNT(*) AS n FROM invoices').get().n;
  const created=await api('POST','/api/quotes',body());
  assert.equal(created.status,200);
  const quoteId=created.data.quote.id;
  assert.equal(created.data.quote.status,'draft');
  assert.equal(created.data.quote.subtotalCents,47035);
  assert.equal(created.data.quote.taxCents,5644);
  assert.equal(created.data.quote.totalCents,52679);
  assert.equal(created.data.quote.lines[0].itemNameSnapshot,'Glucose Strips');
  const edited=await api('PUT',`/api/quotes/${quoteId}`,{...body(),notes:'Updated customer terms',lines:[{itemId:1,quantity:2,unitPriceCents:12000}]});
  assert.equal(edited.status,200);
  assert.equal(edited.data.quote.lines.length,1);
  assert.equal(edited.data.quote.totalCents,26880);
  assert.equal((await api('POST',`/api/quotes/${quoteId}/submit`,{})).status,200);
  assert.equal((await api('PUT',`/api/quotes/${quoteId}`,body())).status,409);
  assert.equal((await api('POST',`/api/quotes/${quoteId}/approve`,{reviewReason:'Looks correct'},1)).status,403);
  const approved=await api('POST',`/api/quotes/${quoteId}/approve`,{reviewReason:'Commercial terms approved'},2);
  assert.equal(approved.status,200);
  assert.equal(approved.data.quote.status,'approved');
  const converted=await api('POST',`/api/quotes/${quoteId}/convert`,{orderNumber:'SO-FROM-Q-1'});
  assert.equal(converted.status,200);
  assert.equal(converted.data.quote.status,'converted');
  assert.equal(converted.data.order.status,'draft');
  assert.equal(converted.data.order.sourceQuoteId,quoteId);
  assert.deepEqual(converted.data.order.lines.map(line=>[line.itemId,line.quantity,line.unitPriceCents,line.gstRateBps]),[[1,2,12000,1200]]);
  const replay=await api('POST',`/api/quotes/${quoteId}/convert`,{orderNumber:'SO-FROM-Q-1'});
  assert.equal(replay.status,200);assert.equal(replay.data.replayed,true);
  assert.equal(replay.data.order.id,converted.data.order.id);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM orders WHERE source_quote_id=?').get(quoteId).n,1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM stock_movements').get().n,stockBefore);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM invoices').get().n,invoiceBefore);
  assert.deepEqual(converted.data.quote.events.map(event=>event.action),['create','edit','submit','approve','convert']);
  const editAudit=JSON.parse(converted.data.quote.events[1].details);
  assert.equal(editAudit.before.lines.length,2);
  assert.equal(editAudit.after.lines.length,1);
  db.prepare("UPDATE parties SET name='Changed Customer' WHERE id=1").run();
  db.prepare("UPDATE items SET name='Changed Item' WHERE id=1").run();
  const historic=await api('GET',`/api/quotes/${quoteId}`);
  assert.equal(historic.data.quote.partyNameSnapshot,'Harbor Clinic');
  assert.equal(historic.data.quote.lines[0].itemNameSnapshot,'Glucose Strips');
});

test('expired quotations and rejection cannot become sales orders',async t=>{
  const {api,db}=await fixture(t);
  const expired=await api('POST','/api/quotes',{...body('Q-EXPIRED'),quoteDate:past(),expiryDate:past()});
  assert.equal(expired.status,200);
  assert.equal((await api('POST',`/api/quotes/${expired.data.quote.id}/submit`,{})).status,409);
  assert.equal((await api('POST','/api/quotes',{...body('Q-BAD-DATE'),expiryDate:past()})).status,400);
  const aged=await api('POST','/api/quotes',body('Q-AGED'));
  await api('POST',`/api/quotes/${aged.data.quote.id}/submit`,{});
  db.prepare('UPDATE quotes SET expiry_date=? WHERE id=?').run(past(),aged.data.quote.id);
  assert.equal((await api('POST',`/api/quotes/${aged.data.quote.id}/approve`,{},2)).status,409);
  assert.equal((await api('POST',`/api/quotes/${aged.data.quote.id}/reject`,{reviewReason:'Expired before decision'},2)).status,200);
  const created=await api('POST','/api/quotes',body('Q-REJECT'));
  await api('POST',`/api/quotes/${created.data.quote.id}/submit`,{});
  assert.equal((await api('POST',`/api/quotes/${created.data.quote.id}/reject`,{},2)).status,400);
  const rejected=await api('POST',`/api/quotes/${created.data.quote.id}/reject`,{reviewReason:'Customer changed scope'},2);
  assert.equal(rejected.status,200);
  assert.equal(rejected.data.quote.reviewReason,'Customer changed scope');
  assert.equal((await api('POST',`/api/quotes/${created.data.quote.id}/convert`,{orderNumber:'SO-REJECTED'})).status,409);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM orders WHERE number='SO-REJECTED'").get().n,0);
});

test('conversion rechecks the customer and quoted items after approval',async t=>{
  const {api,db}=await fixture(t);
  const first=await api('POST','/api/quotes',body('Q-STALE-CUSTOMER'));
  await api('POST',`/api/quotes/${first.data.quote.id}/submit`,{});
  await api('POST',`/api/quotes/${first.data.quote.id}/approve`,{},2);
  db.prepare("UPDATE parties SET type='supplier' WHERE id=1").run();
  assert.equal((await api('POST',`/api/quotes/${first.data.quote.id}/convert`,{orderNumber:'SO-STALE-CUSTOMER'})).status,409);
  db.prepare("UPDATE parties SET type='customer' WHERE id=1").run();
  db.prepare('UPDATE items SET active=0 WHERE id=1').run();
  assert.equal((await api('POST',`/api/quotes/${first.data.quote.id}/convert`,{orderNumber:'SO-STALE-ITEM'})).status,409);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM orders WHERE source_quote_id=?').get(first.data.quote.id).n,0);
});

test('quotes enforce company, GSTIN, branch, customer and role boundaries',async t=>{
  const {api,db}=await fixture(t);
  assert.equal((await api('POST','/api/quotes',{...body(),branchId:3})).status,400);
  assert.equal((await api('POST','/api/quotes',{...body(),partyId:2})).status,400);
  assert.equal((await api('POST','/api/quotes',{...body(),lines:[{itemId:4,quantity:1,unitPriceCents:100}]})).status,400);
  assert.equal((await api('POST','/api/quotes',{...body(),lines:[{itemId:1,quantity:true,unitPriceCents:100}]})).status,400);
  assert.equal((await api('POST','/api/quotes',{...body(),lines:[{itemId:1,quantity:1,unitPriceCents:null}]})).status,400);
  const created=await api('POST','/api/quotes',body());
  const id=created.data.quote.id;
  assert.equal((await api('GET',`/api/quotes/${id}`,undefined,4,2)).status,404);
  await api('POST',`/api/quotes/${id}/submit`,{});
  assert.equal((await api('POST',`/api/quotes/${id}/approve`,{reviewReason:'Fine'},1)).status,403);
  db.prepare("UPDATE user_branch_grants SET revoked_at=CURRENT_TIMESTAMP,revoked_by=3,revoked_reason='Quote access test' WHERE company_id=1 AND user_id=2 AND branch_id=1").run();
  assert.equal((await api('POST',`/api/quotes/${id}/approve`,{reviewReason:'Fine'},2)).status,403);
  assert.equal((await api('GET',`/api/quotes/${id}`,undefined,2)).status,403);
  assert.equal((await api('GET','/api/quotes?branchId=1',undefined,2)).status,403);
  assert.equal((await api('GET','/api/quotes',undefined,2)).data.quotes.some(quote=>quote.id===id),false);
});

test('synthetic quotation history is idempotent across database reopen',()=>{
  const dir=mkdtempSync(path.join(tmpdir(),'tesselark-quote-'));
  const file=path.join(dir,'demo.sqlite');
  try {
    let db=openDatabase(file);seedQuoteDemo(db);
    assert.deepEqual(db.prepare('SELECT status,COUNT(*) AS n FROM quotes GROUP BY status ORDER BY status').all().map(row=>[row.status,row.n]),[['approved',1],['converted',1],['draft',1],['rejected',1],['submitted',1]]);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM orders WHERE source_quote_id IS NOT NULL').get().n,1);
    db.close();
    db=openDatabase(file);seedQuoteDemo(db);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM quotes').get().n,5);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM quote_events').get().n,13);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM orders WHERE source_quote_id IS NOT NULL').get().n,1);
    db.close();
  } finally {rmSync(dir,{recursive:true,force:true});}
});
