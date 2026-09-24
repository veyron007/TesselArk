import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const express = require('express');
const { openDatabase } = require('../db.cjs');
const { createApp } = require('../api.cjs');
const { registerMasterImportRoutes } = require('../master-import.cjs');

async function fixture(t) {
  const db = openDatabase(':memory:');
  const app = express();
  app.use(express.json({ limit:'200kb' }));
  app.use('/api',(req,_res,next) => {
    const companyId = Number(req.header('x-company-id') || 1);
    const userId = Number(req.header('x-user-id') || 3);
    req.company = db.prepare('SELECT * FROM companies WHERE id=?').get(companyId);
    req.user = db.prepare('SELECT * FROM users WHERE id=? AND company_id=?').get(userId,companyId);
    if (!req.company || !req.user) return next(Object.assign(new Error('Unknown company or user'),{status:403}));
    next();
  });
  registerMasterImportRoutes(app,db);
  app.use((error,_req,res,_next) => res.status(error.status || 500).json({error:error.message}));
  const server = app.listen(0,'127.0.0.1');
  await new Promise(resolve => server.once('listening',resolve));
  t.after(() => { server.close(); db.close(); });
  const api = async (method,path,body,user=3,company=1) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`,{method,headers:{'content-type':'application/json','x-company-id':String(company),'x-user-id':String(user)},body:body === undefined ? undefined : JSON.stringify(body)});
    return {status:response.status,data:await response.json()};
  };
  return {db,api,base:`http://127.0.0.1:${server.address().port}`};
}

const csv = 'sku,name,hsn,unit,gst_rate_bps,reorder_level,track_stock\n';
const input = (rows,overrides={}) => ({gstinId:1,branchId:1,sourceName:'Local items.csv',csv:csv+rows,...overrides});
const preview = (api,body,user=3) => api('POST','/api/master-imports/preview',body,user);
const commit = (api,body,hash,user=3) => api('POST','/api/master-imports/commit',{...body,expectedSha256:hash},user);

test('item CSV previews and commits accepted and rejected rows with durable source links and exact replay',async t => {
  const {db,api,base} = await fixture(t);
  const body = input('NEW-ITEM-1,"Gloves, sterile",300590,box,1200,6,true\nNEW-ITEM-1,Duplicate,300590,box,1200,6,true\nBAD-ITEM,Bad rate,300590,box,10001,0,true\n');
  const beforeItems = db.prepare('SELECT COUNT(*) AS n FROM items').get().n;
  const beforeMovements = db.prepare('SELECT COUNT(*) AS n FROM stock_movements').get().n;
  const draft = await preview(api,body);
  assert.equal(draft.status,200);
  assert.equal(draft.data.preview.readyCount,1);
  assert.equal(draft.data.preview.rejectedCount,2);
  assert.equal(draft.data.preview.rows[0].name,'Gloves, sterile');
  assert.match(draft.data.preview.rows[1].reason,/duplicate/i);
  assert.match(draft.data.preview.rows[2].reason,/gst_rate_bps/i);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM items').get().n,beforeItems);
  assert.equal((await commit(api,body,draft.data.preview.sha256,1)).status,403);
  const saved = await commit(api,body,draft.data.preview.sha256);
  assert.equal(saved.status,200);
  assert.equal(saved.data.accepted,1);
  assert.equal(saved.data.rejected,2);
  assert.equal(saved.data.replayed,false);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM items').get().n,beforeItems+1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM stock_movements').get().n,beforeMovements);
  const item = db.prepare("SELECT * FROM items WHERE company_id=1 AND sku='NEW-ITEM-1'").get();
  assert.equal(item.name,'Gloves, sterile');
  assert.equal(item.gst_rate_bps,1200);
  const detail = await api('GET',`/api/master-imports/${saved.data.import.id}`);
  assert.equal(detail.status,200);
  assert.equal(detail.data.import.sourceName,'Local items.csv');
  assert.match(detail.data.import.fileSha256,/^[a-f0-9]{64}$/);
  assert.equal(detail.data.rows.length,3);
  assert.equal(detail.data.rows[0].itemId,item.id);
  assert.equal(detail.data.rows[0].sourceLine,2);
  assert.match(detail.data.rows[1].reason,/duplicate/i);
  assert.equal(detail.data.rows[2].status,'rejected');
  const source = await fetch(`${base}/api/master-imports/${saved.data.import.id}/source`,{headers:{'x-company-id':'1','x-user-id':'3'}});
  assert.equal(source.status,200);
  assert.equal(await source.text(),body.csv);
  const replay = await commit(api,body,draft.data.preview.sha256);
  assert.equal(replay.status,200);
  assert.equal(replay.data.replayed,true);
  assert.equal(replay.data.import.id,saved.data.import.id);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM items').get().n,beforeItems+1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM master_imports').get().n,1);
  const repeatPreview = await preview(api,body);
  assert.equal(repeatPreview.data.preview.replayOf,saved.data.import.id);
  assert.equal(repeatPreview.data.preview.rows[0].status,'accepted');
});

test('existing SKU, changed source, tampered preview and invalid structure are distinguished',async t => {
  const {db,api} = await fixture(t);
  const existing = db.prepare('SELECT sku FROM items WHERE company_id=1 LIMIT 1').get().sku;
  const body = input(`${existing},Overwrite,300590,box,1200,6,true\nNEW-ITEM-2,Second,300590,box,1200,6,false\n`);
  const draft = await preview(api,body);
  assert.equal(draft.data.preview.readyCount,1);
  assert.equal(draft.data.preview.rejectedCount,1);
  assert.match(draft.data.preview.rows[0].reason,/existing/i);
  assert.equal((await commit(api,{...body,sourceName:'changed.csv'},draft.data.preview.sha256)).status,409);
  assert.equal((await commit(api,{...body,csv:body.csv+'\n'},draft.data.preview.sha256)).status,409);
  assert.equal((await commit(api,body,draft.data.preview.sha256)).status,200);
  const second = await preview(api,input('NEW-ITEM-2,Second,300590,box,1200,6,false\n',{sourceName:'Another file.csv'}));
  assert.equal(second.data.preview.rejectedCount,1);
  assert.equal((await preview(api,input('x'.repeat(130*1024)))).status,400);
  assert.equal((await preview(api,input('',{csv:'bad,header\n'}))).status,400);
  assert.equal((await preview(api,input('NEW-ITEM-3,"Unclosed,300590,box,1200,6,true\n'))).status,400);
});

test('spreadsheet formula-like item fields are rejected and never committed',async t => {
  const {db,api} = await fixture(t);
  const body = input('FORMULA-1,"=HYPERLINK(\"\"https://example.test\"\")",300590,box,1200,6,true\nFORMULA-2,Ordinary item,300590,@SUM(1),1200,6,true\n');
  const result = await preview(api,body);
  assert.equal(result.status,200);
  assert.equal(result.data.preview.readyCount,0);
  assert.equal(result.data.preview.rejectedCount,2);
  assert.match(result.data.preview.rows[0].reason,/formula operator/);
  assert.match(result.data.preview.rows[1].reason,/formula operator/);
  const saved = await commit(api,body,result.data.preview.sha256);
  assert.equal(saved.status,200);
  assert.equal(saved.data.accepted,0);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM items WHERE sku LIKE 'FORMULA-%'").get().n,0);
});

test('item master imports require company-wide grants plus selected GSTIN and branch access',async t => {
  const {db,api} = await fixture(t);
  const body = input('NEW-ITEM-4,Fourth,300590,box,1200,6,true\n');
  assert.equal((await preview(api,{...body,gstinId:3})).status,404);
  assert.equal((await preview(api,{...body,branchId:3})).status,400);
  assert.equal((await api('GET','/api/master-imports/999')).status,404);
  const draft = await preview(api,body);
  db.prepare("UPDATE user_branch_grants SET revoked_at=CURRENT_TIMESTAMP,revoked_by=3,revoked_reason='Scope test' WHERE company_id=1 AND user_id=3 AND branch_id=2").run();
  assert.equal((await preview(api,body)).status,403);
  assert.equal((await commit(api,body,draft.data.preview.sha256)).status,403);
  assert.equal((await api('GET','/api/master-imports')).status,403);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM items WHERE sku='NEW-ITEM-4'").get().n,0);
});

test('commit rejects a preview when the item master changes before commit',async t => {
  const {db,api} = await fixture(t);
  const body = input('NEW-ITEM-5,Fifth,300590,box,1200,6,true\n');
  const draft = await preview(api,body);
  db.prepare("INSERT INTO items(company_id,sku,name) VALUES (1,'NEW-ITEM-5','Added separately')").run();
  const saved = await commit(api,body,draft.data.preview.sha256);
  assert.equal(saved.status,409);
  assert.match(saved.data.error,/changed since preview/i);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM master_imports').get().n,0);
  const again = await preview(api,body);
  assert.equal(again.data.preview.rejectedCount,1);
  assert.equal((await commit(api,body,again.data.preview.sha256)).status,200);
});

test('registered app exposes item import under its normal company and user middleware',async t => {
  const db = openDatabase(':memory:');
  const server = createApp({db,authMode:'demo'}).listen(0,'127.0.0.1');
  await new Promise(resolve => server.once('listening',resolve));
  t.after(() => { server.close(); db.close(); });
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/master-imports`,{headers:{'x-company-id':'1','x-user-id':'3'}});
  assert.equal(response.status,200);
  assert.deepEqual((await response.json()).imports,[]);
  const denied = await fetch(`http://127.0.0.1:${server.address().port}/api/master-imports`,{headers:{'x-company-id':'2','x-user-id':'3'}});
  assert.equal(denied.status,403);
});
