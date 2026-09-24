import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require=createRequire(import.meta.url);
const express=require('express');
const {openDatabase}=require('../db.cjs');
const {registerBundleRoutes,seedBundleDemo}=require('../bundles.cjs');
const {allowedScopes}=require('../access.cjs');

async function fixture(t) {
  const db=openDatabase(':memory:');
  const app=express(); app.use(express.json());
  app.use('/api',(req,res,next)=>{
    const companyId=Number(req.header('x-company-id')||1),userId=Number(req.header('x-user-id')||1);
    req.company=db.prepare('SELECT * FROM companies WHERE id=?').get(companyId);
    req.user=db.prepare('SELECT * FROM users WHERE id=? AND company_id=?').get(userId,companyId);
    if(!req.company||!req.user) return next(Object.assign(new Error('Invalid identity'),{status:403}));
    req.scopes=allowedScopes(db,{companyId,userId}); next();
  });
  registerBundleRoutes(app,db);
  app.use((error,_req,res,_next)=>res.status(error.status||500).json({error:error.message}));
  const server=app.listen(0); t.after(()=>{server.close();db.close();});
  const api=async(method,path,body,userId=1,companyId=1)=>{
    const result=await fetch(`http://127.0.0.1:${server.address().port}${path}`,{method,headers:{'content-type':'application/json','x-company-id':String(companyId),'x-user-id':String(userId)},body:body===undefined?undefined:JSON.stringify(body)});
    return {status:result.status,data:await result.json()};
  };
  return {db,api};
}
const bundle={branchId:1,gstinId:1,name:'Starter pack',components:[{itemId:1,quantity:2},{itemId:3,quantity:1}],reason:'Merchandising formula',clientReference:'B-1'};
const scheme={branchId:1,gstinId:1,name:'Clinic group offer',itemIds:[1,3],minQuantity:2,discountBps:500,freeItemId:3,freeQuantity:1,stackingPolicy:'exclusive',effectiveFrom:'2026-01-01',effectiveTo:'2026-12-31',sourceReference:'Signed circular',clientReference:'S-1'};

test('bundle versions preserve component snapshots, preview stock without posting and reject stale/replayed changes',async t=>{
  const {db,api}=await fixture(t);
  const before=db.prepare('SELECT COUNT(*) n FROM stock_movements').get().n;
  const made=await api('POST','/api/bundles',bundle);
  assert.equal(made.status,200,JSON.stringify(made.data));
  const id=made.data.bundle.id;
  assert.equal((await api('POST','/api/bundles',bundle)).data.replayed,true);
  assert.equal((await api('POST','/api/bundles',{...bundle,name:'Other'})).status,409);
  const preview=await api('GET',`/api/bundles/${id}/preview?quantity=2`);
  assert.equal(preview.status,200,JSON.stringify(preview.data));
  assert.deepEqual(preview.data.lines.map(x=>x.requiredQuantity),[4,2]);
  assert.equal(preview.data.posting,false); assert.equal(preview.data.taxCalculated,false);
  const revised={components:[{itemId:1,quantity:3}],reason:'Revised pack count',expectedVersion:1,clientReference:'B-2'};
  const update=await api('POST',`/api/bundles/${id}/versions`,revised);
  assert.equal(update.status,200,JSON.stringify(update.data));
  assert.equal(update.data.bundle.currentVersion,2);
  assert.deepEqual(update.data.bundle.versions.find(x=>x.version===1).components.map(x=>x.quantity),[2,1]);
  assert.equal((await api('POST',`/api/bundles/${id}/versions`,revised)).data.replayed,true);
  assert.equal((await api('POST',`/api/bundles/${id}/versions`,{...revised,clientReference:'B-3'})).status,409);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM stock_movements').get().n,before);
  assert.equal((await api('POST','/api/bundles',{...bundle,clientReference:'B-4',components:[{itemId:1,quantity:2},{itemId:1,quantity:1}]})).status,400);
});

test('schemes need an independent scoped review and show explicit non-posting benefits',async t=>{
  const {db,api}=await fixture(t);
  const beforeStock=db.prepare('SELECT COUNT(*) n FROM stock_movements').get().n;
  const beforeInvoice=db.prepare('SELECT COUNT(*) n FROM invoices').get().n;
  const made=await api('POST','/api/bundles/schemes',scheme);
  assert.equal(made.status,200,JSON.stringify(made.data));
  const id=made.data.scheme.id;
  assert.equal((await api('POST','/api/bundles/schemes',scheme)).data.replayed,true);
  assert.equal((await api('POST','/api/bundles/schemes',{...scheme,discountBps:600})).status,409);
  assert.equal((await api('POST',`/api/bundles/schemes/${id}/decision`,{decision:'approved',reason:'Reviewed policy'},1)).status,403);
  const approved=await api('POST',`/api/bundles/schemes/${id}/decision`,{decision:'approved',reason:'Reviewed policy'},2);
  assert.equal(approved.status,200,JSON.stringify(approved.data));
  assert.equal((await api('POST',`/api/bundles/schemes/${id}/decision`,{decision:'approved',reason:'Reviewed policy'},2)).data.replayed,true);
  assert.equal((await api('POST',`/api/bundles/schemes/${id}/decision`,{decision:'rejected',reason:'Changed'},2)).status,409);
  const preview=await api('GET','/api/bundles/schemes/preview?branchId=1&itemId=1&quantity=2&unitRateCents=101&date=2026-09-24');
  assert.equal(preview.status,200,JSON.stringify(preview.data));
  assert.equal(preview.data.candidates[0].discountCents,10);
  assert.equal(preview.data.candidates[0].freeGoods.quantity,1);
  assert.equal(preview.data.selectionRequired,true); assert.equal(preview.data.taxCalculated,false);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM stock_movements').get().n,beforeStock);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM invoices').get().n,beforeInvoice);
  assert.equal((await api('POST','/api/bundles/schemes',{...scheme,clientReference:'S-2',effectiveFrom:'2026-02-30'})).status,400);
  assert.equal((await api('POST','/api/bundles/schemes',{...scheme,clientReference:'S-3',freeItemId:null})).status,400);
});

test('deal history uses approved original invoice lines with date, party and branch scope',async t=>{
  const {db,api}=await fixture(t);
  const row=db.prepare("SELECT i.*,l.id AS line_id,l.unit_price_cents,l.gst_rate_bps FROM invoices i JOIN invoice_lines l ON l.invoice_id=i.id WHERE i.company_id=1 AND i.branch_id=1 AND i.type='sale' AND i.status='approved' AND l.item_id=3 LIMIT 1").get();
  assert.ok(row);
  const q=`/api/bundles/deals?branchId=1&type=sale&itemId=3&from=${row.invoice_date}&to=${row.invoice_date}`;
  const deals=await api('GET',q);
  assert.equal(deals.status,200,JSON.stringify(deals.data));
  const original=deals.data.deals.find(x=>x.invoiceLineId===row.line_id);
  assert.equal(original.unitPriceCents,row.unit_price_cents);
  assert.equal(original.gstRateBps,row.gst_rate_bps);
  assert.equal(original.invoiceId,row.id);
  db.prepare('UPDATE items SET gst_rate_bps=1800 WHERE id=3').run();
  assert.equal((await api('GET',q)).data.deals.find(x=>x.invoiceLineId===row.line_id).gstRateBps,row.gst_rate_bps);
  assert.equal((await api('GET',`${q}&partyId=2`)).data.deals.length,0);
  const purchase=db.prepare("SELECT i.id AS invoice_id,i.invoice_date,l.id AS line_id,l.unit_price_cents,l.gst_rate_bps FROM invoices i JOIN invoice_lines l ON l.invoice_id=i.id WHERE i.company_id=1 AND i.branch_id=1 AND i.type='purchase' AND i.status='approved' AND l.item_id=1 LIMIT 1").get();
  const purchaseDeals=await api('GET',`/api/bundles/deals?branchId=1&type=purchase&itemId=1&from=${purchase.invoice_date}&to=${purchase.invoice_date}`);
  assert.equal(purchaseDeals.status,200);
  const originalPurchase=purchaseDeals.data.deals.find(x=>x.invoiceLineId===purchase.line_id);
  assert.equal(originalPurchase.invoiceId,purchase.invoice_id);
  assert.equal(originalPurchase.unitPriceCents,purchase.unit_price_cents);
  assert.equal(originalPurchase.gstRateBps,purchase.gst_rate_bps);
  assert.equal((await api('GET',q.replace(`from=${row.invoice_date}`,`from=2030-01-01`))).status,400);
});

test('company and branch grants isolate bundles, schemes and history',async t=>{
  const {db,api}=await fixture(t);
  const made=await api('POST','/api/bundles',bundle);
  const id=made.data.bundle.id;
  assert.equal((await api('GET','/api/bundles?branchId=1',undefined,8,2)).status,404);
  assert.equal((await api('GET',`/api/bundles/${id}`,undefined,8,2)).status,404);
  assert.equal((await api('POST','/api/bundles',{...bundle,clientReference:'C-2'},2)).status,403);
  assert.equal((await api('POST','/api/bundles',{...bundle,clientReference:'C-3',gstinId:2})).status,400);
  db.prepare("UPDATE user_branch_grants SET revoked_at=CURRENT_TIMESTAMP,revoked_by=3,revoked_reason='Test' WHERE company_id=1 AND user_id=1 AND branch_id=1").run();
  assert.equal((await api('GET',`/api/bundles/${id}`)).status,403);
  assert.equal((await api('GET','/api/bundles/deals?branchId=1&type=sale&itemId=1&from=2026-01-01&to=2026-12-31')).status,403);
});

test('synthetic seed is idempotent and isolated from invoices',async t=>{
  const {db}=await fixture(t);
  const before=db.prepare('SELECT COUNT(*) n FROM invoices').get().n;
  seedBundleDemo(db); seedBundleDemo(db);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM trade_bundles WHERE client_reference='SYNTHETIC-BUNDLE-ERP014'").get().n,1);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM invoices').get().n,before);
});
