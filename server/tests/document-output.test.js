import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const express = require('express');
const { openDatabase } = require('../db.cjs');
const { allowedScopes } = require('../access.cjs');
const { registerDocumentOutputRoutes } = require('../document-output.cjs');

async function fixture(t) {
  const db = openDatabase(':memory:');
  const app = express();
  app.use(express.json());
  app.use('/api', (req, _res, next) => {
    const companyId = Number(req.header('x-company-id') || 1);
    const userId = Number(req.header('x-user-id') || 1);
    req.company = db.prepare('SELECT * FROM companies WHERE id=?').get(companyId);
    req.user = db.prepare('SELECT * FROM users WHERE id=? AND company_id=?').get(userId, companyId);
    if (!req.company || !req.user) return next(Object.assign(new Error('Invalid identity'), { status:403 }));
    req.scopes = allowedScopes(db, { companyId, userId });
    next();
  });
  registerDocumentOutputRoutes(app, db);
  app.use((error, _req, res, _next) => res.status(error.status || 500).json({ error:error.message }));
  const server = app.listen(0);
  t.after(() => { server.close(); db.close(); });
  const api = async (method, path, body, companyId = 1, userId = 1) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`, {
      method,
      headers:{ 'content-type':'application/json', 'x-company-id':String(companyId), 'x-user-id':String(userId) },
      body:body === undefined ? undefined : JSON.stringify(body),
    });
    return { status:response.status, data:await response.json() };
  };
  return { db, api };
}

function draft(db) {
  const source = db.prepare('SELECT * FROM invoices WHERE id=1').get();
  const id = Number(db.prepare(`INSERT INTO invoices(company_id,branch_id,gstin_id,party_id,number,type,status,invoice_date,notes,subtotal_cents,tax_cents,total_cents,created_by,party_name_snapshot,supplier_gstin_snapshot)
    VALUES (1,1,1,1,'DOC-DRAFT-1','sale','draft',?, 'Internal draft',?,?,?,?,?,?)`)
    .run(source.invoice_date,source.subtotal_cents,source.tax_cents,source.total_cents,1,'Harbor Clinic','27DEMOH0000A1Z4').lastInsertRowid);
  db.prepare('INSERT INTO invoice_lines(invoice_id,item_id,quantity,unit_price_cents,gst_rate_bps,subtotal_cents,tax_cents,total_cents) VALUES (?,?,?,?,?,?,?,?)')
    .run(id,1,2,10000,1200,20000,2400,22400);
  return id;
}

test('version snapshots retain exact source state, template, language and item identity', async t => {
  const { db, api } = await fixture(t);
  const id = draft(db);
  const first = await api('POST', `/api/document-output/invoices/${id}/versions`, { templateId:'invoice-standard', language:'hi' });
  assert.equal(first.status, 200, JSON.stringify(first.data));
  assert.equal(first.data.document.version, 1);
  assert.equal(first.data.document.templateId, 'invoice-standard');
  assert.equal(first.data.document.templateVersion, 1);
  assert.equal(first.data.document.language, 'hi');
  assert.equal(first.data.document.sourceStatus, 'draft');
  assert.equal(first.data.document.snapshot.lines[0].itemId, 1);
  assert.equal(first.data.document.snapshot.lines[0].barcodePayload, 'TA-1-1');
  assert.equal(first.data.document.snapshot.lines[0].sku, 'MED-001');
  assert.equal(first.data.document.labels.item, 'वस्तु');
  const replay = await api('POST', `/api/document-output/invoices/${id}/versions`, { templateId:'invoice-standard', language:'hi' });
  assert.equal(replay.status, 200);
  assert.equal(replay.data.replayed, true);
  assert.equal(replay.data.document.version, 1);

  db.prepare("UPDATE items SET name='Renamed item',sku='NEW-001' WHERE id=1").run();
  db.prepare("UPDATE invoices SET status='approved' WHERE id=?").run(id);
  const second = await api('POST', `/api/document-output/invoices/${id}/versions`, { templateId:'invoice-standard', language:'hi' });
  assert.equal(second.status, 200, JSON.stringify(second.data));
  assert.equal(second.data.document.version, 2);
  assert.equal(second.data.document.sourceStatus, 'approved');
  assert.equal(second.data.document.snapshot.lines[0].sku, 'MED-001');
  assert.equal(second.data.document.snapshot.lines[0].name, 'Glucose Strips');
  assert.equal(second.data.document.snapshot.lines[0].barcodePayload, 'TA-1-1');
  const history = await api('GET', `/api/document-output/invoices/${id}/versions/1`);
  assert.equal(history.data.document.sourceStatus, 'draft');
  assert.equal(history.data.document.snapshot.lines[0].name, 'Glucose Strips');
  assert.equal(history.data.document.snapshot.lines[0].sku, 'MED-001');
  assert.equal(history.data.document.sourceHash, first.data.document.sourceHash);
  const versions = await api('GET', `/api/document-output/invoices/${id}/versions`);
  assert.deepEqual(versions.data.versions.map(row => row.version), [2,1]);
  assert.throws(() => db.prepare('UPDATE document_output_versions SET template_version=99 WHERE invoice_id=?').run(id));
  assert.throws(() => db.prepare('DELETE FROM document_output_versions WHERE invoice_id=?').run(id));
});

test('first document version after an item rename retains invoice line identity', async t => {
  const { db, api } = await fixture(t);
  const id = draft(db);
  db.prepare("UPDATE items SET name='Renamed master item',sku='AFTER-001',hsn='999999',unit='case' WHERE id=1").run();
  db.prepare("UPDATE invoices SET status='approved' WHERE id=?").run(id);
  const result = await api('POST', `/api/document-output/invoices/${id}/versions`, { templateId:'invoice-standard', language:'en' });
  assert.equal(result.status, 200, JSON.stringify(result.data));
  assert.deepEqual(
    Object.fromEntries(['sku','name','hsn','unit','itemIdentitySource'].map(key => [key,result.data.document.snapshot.lines[0][key]])),
    { sku:'MED-001', name:'Glucose Strips', hsn:'3822', unit:'box', itemIdentitySource:'line_creation' },
  );
});

test('invoice list and document reads enforce company, GSTIN and branch grants', async t => {
  const { db, api } = await fixture(t);
  const id = draft(db);
  assert.equal((await api('GET', '/api/document-output/invoices?branchId=1&gstinId=2')).status, 400);
  assert.equal((await api('GET', `/api/document-output/invoices/${id}/versions`, undefined, 2, 4)).status, 404);
  const created = await api('POST', `/api/document-output/invoices/${id}/versions`, { templateId:'invoice-standard', language:'en' });
  assert.equal(created.status, 200);
  db.prepare("UPDATE user_branch_grants SET revoked_at=CURRENT_TIMESTAMP,revoked_by=3,revoked_reason='Test revoked' WHERE company_id=1 AND user_id=1 AND branch_id=1").run();
  assert.equal((await api('GET', `/api/document-output/invoices/${id}/versions/1`)).status, 403);
  assert.equal((await api('POST', `/api/document-output/invoices/${id}/versions`, { templateId:'invoice-standard', language:'en' })).status, 403);
  const listing = await api('GET', '/api/document-output/invoices');
  assert.equal(listing.status, 200);
  assert.ok(listing.data.invoices.every(row => row.branchId !== 1));
});

test('unsupported render options and malformed IDs do not create versions', async t => {
  const { db, api } = await fixture(t);
  const id = draft(db);
  assert.equal((await api('POST', `/api/document-output/invoices/${id}/versions`, { templateId:'government-filing', language:'en' })).status, 400);
  assert.equal((await api('POST', `/api/document-output/invoices/${id}/versions`, { templateId:'invoice-standard', language:'xx' })).status, 400);
  assert.equal((await api('GET', '/api/document-output/invoices/1oops/versions')).status, 400);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM document_output_versions').get().n, 0);
});
