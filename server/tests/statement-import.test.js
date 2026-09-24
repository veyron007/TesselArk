import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const express = require('express');
const { openDatabase } = require('../db.cjs');
const { registerStatementImportRoutes } = require('../statement-import.cjs');

async function fixture(t) {
  const db = openDatabase(':memory:');
  const app = express();
  app.use(express.json({ limit:'200kb' }));
  app.use('/api',(req,_res,next) => {
    const company = Number(req.header('x-company-id') || 1), user = Number(req.header('x-user-id') || 1);
    req.company = db.prepare('SELECT * FROM companies WHERE id=?').get(company);
    req.user = db.prepare('SELECT * FROM users WHERE id=? AND company_id=?').get(user,company);
    if (!req.company || !req.user) return next(Object.assign(new Error('Unknown company or user'),{status:403}));
    next();
  });
  registerStatementImportRoutes(app,db);
  app.use((error,_req,res,_next) => res.status(error.status || 500).json({error:error.message}));
  const server = app.listen(0,'127.0.0.1');
  await new Promise(resolve => server.once('listening',resolve));
  t.after(() => { server.close(); db.close(); });
  const api = async (method,path,body,company=1,user=1) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`,{method,headers:{'content-type':'application/json','x-company-id':String(company),'x-user-id':String(user)},body:body === undefined ? undefined : JSON.stringify(body)});
    return { status:response.status,data:await response.json() };
  };
  return { db,api };
}

const header = 'supplier_gstin,invoice_number,invoice_date,taxable_amount,tax_amount\n';
const base = (csv,extras={}) => ({ gstinId:1,period:new Date().toISOString().slice(0,7),sourceName:'Local supplier statement.csv',csv:header+csv,...extras });
const preview = (api,body,user=1) => api('POST','/api/gst/statement-imports/preview',body,1,user);
const commit = (api,body,hash,user=2) => api('POST','/api/gst/statement-imports/commit',{...body,expectedSha256:hash},1,user);

test('quoted CSV previews, commits once, preserves source audit and exact replays',async t => {
  const { db,api } = await fixture(t);
  const input = base('27DEMOS0000A1Z2,"INV, 42",2026-08-12,1000.50,180.09\n');
  const before = db.prepare('SELECT COUNT(*) AS n FROM purchase_fixtures').get().n;
  const draft = await preview(api,input);
  assert.equal(draft.status,200);
  assert.equal(draft.data.preview.newCount,1);
  assert.equal(draft.data.preview.rows[0].invoiceNumber,'INV, 42');
  assert.equal(draft.data.preview.rows[0].taxableCents,100050);
  assert.equal(draft.data.preview.rows[0].taxCents,18009);
  assert.equal((await commit(api,input,draft.data.preview.sha256,1)).status,403);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM purchase_fixtures').get().n,before);
  const saved = await commit(api,input,draft.data.preview.sha256);
  assert.equal(saved.status,200);
  assert.equal(saved.data.inserted,1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM purchase_fixtures').get().n,before+1);
  assert.equal(saved.data.import.importedBy,2);
  assert.equal(saved.data.import.sourceName,input.sourceName);
  assert.match(saved.data.import.fileSha256,/^[a-f0-9]{64}$/);
  assert.equal((await preview(api,input)).data.preview.repeatCount,1);
  const repeat = await commit(api,input,draft.data.preview.sha256);
  assert.equal(repeat.data.replayed,true);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM purchase_fixtures').get().n,before+1);
  assert.equal((await api('GET','/api/gst/statement-imports?gstinId=1')).data.imports[0].id,saved.data.import.id);
});

test('changed duplicates and invalid rows block atomic commit',async t => {
  const { db,api } = await fixture(t);
  const input = base('27DEMOS0000A1Z2,NEW-42,2026-08-12,1000.00,180.00\n');
  const first = await preview(api,input);
  assert.equal((await commit(api,input,first.data.preview.sha256)).status,200);
  const before = db.prepare('SELECT COUNT(*) AS n FROM purchase_fixtures').get().n;
  const changed = base('27DEMOS0000A1Z2,NEW-42,2026-08-12,900.00,180.00\n27DEMOS0000A1Z2,NEW-43,2026-08-12,100.00,18.00\n');
  const draft = await preview(api,changed);
  assert.equal(draft.data.preview.conflictCount,1);
  assert.equal(draft.data.preview.newCount,1);
  assert.equal(draft.data.preview.canCommit,false);
  assert.equal((await commit(api,changed,draft.data.preview.sha256)).status,409);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM purchase_fixtures').get().n,before);
  const invalid = base('27DEMOS0000A1Z2,NEW-44,2026-02-30,100.00,18.00\n27DEMOS0000A1Z2,NEW-45,2026-08-12,1.001,0\n');
  const errors = await preview(api,invalid);
  assert.equal(errors.data.preview.invalidCount,2);
  assert.equal((await commit(api,invalid,errors.data.preview.sha256)).status,409);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM purchase_fixtures').get().n,before);
});

test('company, GSTIN, preview hash, closed period and CSV limits are enforced',async t => {
  const { db,api } = await fixture(t);
  const body = base('27DEMOS0000A1Z2,NEW-99,2026-08-12,100.00,18.00\n');
  assert.equal((await preview(api,{...body,gstinId:3})).status,404);
  const draft = await preview(api,body);
  assert.equal((await commit(api,{...body,sourceName:'changed.csv'},draft.data.preview.sha256)).status,409);
  const period = body.period;
  db.prepare("UPDATE gst_periods SET status='reviewed' WHERE company_id=1 AND gstin_id=1 AND period=?").run(period);
  const closed = await preview(api,body);
  assert.equal(closed.data.preview.canCommit,false);
  assert.equal((await commit(api,body,closed.data.preview.sha256)).status,409);
  assert.equal((await preview(api,base('27DEMOS0000A1Z2,BAD,2026-08-12,1,0\n'.repeat(501)))).status,400);
  assert.equal((await preview(api,base('27DEMOS0000A1Z2,BAD,2026-08-12,1,0\n',{csv:'x'.repeat(129*1024)}))).status,400);
  assert.equal((await api('GET','/api/gst/statement-imports?gstinId=1',undefined,2,4)).status,404);
});
