import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { openDatabase } = require('../db.cjs');
const { registerReportingRoutes } = require('../reporting.cjs');

async function fixture(t) {
  const db = openDatabase(':memory:');
  const app = express();
  app.use('/api', (req, _res, next) => {
    const companyId = Number(req.header('x-company-id') || 1);
    const userId = Number(req.header('x-user-id') || 1);
    req.company = db.prepare('SELECT * FROM companies WHERE id=?').get(companyId);
    req.user = db.prepare('SELECT * FROM users WHERE id=? AND company_id=?').get(userId,companyId);
    if (!req.company || !req.user) return next(Object.assign(new Error('Unknown scope'),{status:403}));
    next();
  });
  registerReportingRoutes(app, db);
  app.use((error, _req, res, _next) => res.status(error.status || 500).json({ error:error.message }));
  const server = app.listen(0);
  t.after(() => { server.close(); db.close(); });
  return (path,companyId=1,userId=1) => fetch(`http://127.0.0.1:${server.address().port}${path}`,{ headers:{'x-company-id':String(companyId),'x-user-id':String(userId)} }).then(async response => ({ status:response.status,data:await response.json() }));
}

test('report keeps source classes and scope distinct with traceable totals', async t => {
  const get = await fixture(t);
  const report = await get('/api/reports/operations?from=2020-01-01&to=2030-12-31&gstinId=1&branchId=1');
  assert.equal(report.status,200);
  assert.equal(report.data.scope.companyId,1);
  assert.equal(report.data.scope.gstinId,1);
  assert.equal(report.data.scope.branchId,1);
  assert.equal(report.data.currency,'INR');
  assert.ok(report.data.generatedAt);
  assert.ok(report.data.invoices.every(row => row.gstinId === 1 && row.branchId === 1 && row.id));
  assert.ok(report.data.payments.every(row => row.gstinId === 1 && row.branchId === 1 && row.invoiceId && row.id));
  assert.ok(report.data.returns.every(row => row.gstinId === 1 && row.branchId === 1 && row.invoiceId && row.id));
  assert.ok(report.data.gstPeriods.every(row => row.gstinId === 1));
  assert.equal(report.data.metrics.approvedSalesCents,report.data.invoices.filter(row => row.type === 'sale' && row.status === 'approved').reduce((sum,row) => sum+row.totalCents,0));
  assert.equal(report.data.metrics.paymentReceiptsCents,report.data.payments.filter(row => row.invoiceType === 'sale').reduce((sum,row) => sum+row.amountCents,0));
  assert.equal(report.data.metrics.returnProposalCents,report.data.returns.reduce((sum,row) => sum+row.totalProposalCents,0));
});

test('company, GSTIN, branch and date boundaries are enforced', async t => {
  const get = await fixture(t);
  assert.equal((await get('/api/reports/operations?from=2026-01-01&to=2026-12-31&gstinId=2&branchId=1')).status,400);
  assert.equal((await get('/api/reports/operations?from=2026-12-31&to=2026-01-01')).status,400);
  assert.equal((await get('/api/reports/operations?from=2026-02-30&to=2026-12-31')).status,400);
  assert.equal((await get('/api/reports/operations?from=2026-13-01&to=2026-12-31')).status,400);
  assert.equal((await get('/api/reports/operations?from=2026-99-99&to=2026-12-31')).status,400);
  assert.equal((await get('/api/reports/operations?from=2020-01-01&to=2030-12-31&gstinId=1',2,5)).status,404);
  const second = await get('/api/reports/operations?from=2020-01-01&to=2030-12-31',2,5);
  assert.equal(second.status,200);
  assert.ok(second.data.invoices.every(row => row.companyId === 2));
});
