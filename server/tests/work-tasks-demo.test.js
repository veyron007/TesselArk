import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { openDatabase } = require('../db.cjs');
const { createApp } = require('../api.cjs');
const { seedWorkTasksDemo } = require('../work-tasks-demo.cjs');

const totals = (db) => ({
  invoices: db.prepare('SELECT COUNT(*) AS count, COALESCE(SUM(subtotal_cents),0) AS subtotal, COALESCE(SUM(tax_cents),0) AS tax, COALESCE(SUM(total_cents),0) AS total FROM invoices').get(),
  stock: db.prepare('SELECT COUNT(*) AS count, COALESCE(SUM(quantity_delta),0) AS quantity FROM stock_movements').get(),
  gstPeriods: db.prepare("SELECT group_concat(company_id||':'||gstin_id||':'||period||':'||status,'|') AS rows FROM gst_periods ORDER BY company_id,gstin_id,period").get().rows,
});

test('WORK-02 synthetic demo fixtures are idempotent and do not touch trading totals', () => {
  const db = openDatabase(':memory:');
  try {
    const before = totals(db);
    seedWorkTasksDemo(db);
    const afterFirst = {
      templates: db.prepare('SELECT COUNT(*) AS count FROM work_templates').get().count,
      versions: db.prepare('SELECT COUNT(*) AS count FROM work_template_versions').get().count,
      tasks: db.prepare('SELECT COUNT(*) AS count FROM work_tasks').get().count,
      evidence: db.prepare('SELECT COUNT(*) AS count FROM work_task_evidence').get().count,
      events: db.prepare('SELECT COUNT(*) AS count FROM work_task_events').get().count,
    };
    seedWorkTasksDemo(db);
    const afterSecond = {
      templates: db.prepare('SELECT COUNT(*) AS count FROM work_templates').get().count,
      versions: db.prepare('SELECT COUNT(*) AS count FROM work_template_versions').get().count,
      tasks: db.prepare('SELECT COUNT(*) AS count FROM work_tasks').get().count,
      evidence: db.prepare('SELECT COUNT(*) AS count FROM work_task_evidence').get().count,
      events: db.prepare('SELECT COUNT(*) AS count FROM work_task_events').get().count,
    };
    assert.deepEqual(afterSecond, afterFirst);
    assert.equal(afterFirst.templates, 3);
    assert.equal(afterFirst.versions, 3);
    assert.equal(afterFirst.tasks, 4);
    assert.equal(afterFirst.evidence, 3);
    assert.deepEqual(totals(db), before);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM work_template_versions WHERE status='approved'").get().count, 3);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM work_tasks WHERE statutory_due_date IS NOT NULL OR statutory_basis_json IS NOT NULL').get().count, 0);
    const augustClosed = db.prepare("SELECT scope_type,branch_id,obligation_key FROM work_tasks WHERE period='2026-08' AND status='closed'").get();
    assert.deepEqual({ ...augustClosed }, { scope_type:'branch', branch_id:2, obligation_key:'DEMO-WORK-CHD-PUNE-SUPPLY' });
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM work_tasks WHERE period='2026-08' AND scope_type='gstin'").get().count, 0);
    const pinned = db.prepare(`SELECT t.source_period_id AS sourcePeriodId,p.id AS expectedPeriodId,p.status AS periodStatus
      FROM work_tasks t JOIN gst_periods p ON p.company_id=t.company_id AND p.gstin_id=t.gstin_id AND p.period=t.period
      WHERE t.scope_type='gstin' AND t.period='2026-09' AND t.obligation_key='DEMO-WORK-GST-PREP'`).get();
    assert.ok(pinned);
    assert.equal(pinned.sourcePeriodId, pinned.expectedPeriodId);
    assert.equal(pinned.periodStatus, 'open');
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM work_tasks WHERE scope_type='branch' AND source_period_id IS NOT NULL").get().count, 0);
  } finally {
    db.close();
  }
});

test('WORK-02 fixtures cover open, submitted, closed and evidence-blocked task states', async (t) => {
  const db = openDatabase(':memory:');
  seedWorkTasksDemo(db);
  const server = createApp({ db }).listen(0);
  t.after(() => { server.close(); db.close(); });
  const statusCounts = db.prepare('SELECT status,COUNT(*) AS count FROM work_tasks GROUP BY status ORDER BY status').all();
  assert.deepEqual(statusCounts.map((row) => [row.status, row.count]), [['closed', 2], ['open', 1], ['submitted', 1]]);
  const submitted = db.prepare("SELECT id,closure_evidence_id FROM work_tasks WHERE status='submitted'").get();
  assert.equal(submitted.closure_evidence_id, null);
  const pending = db.prepare('SELECT status,reviewed_by FROM work_task_evidence WHERE task_id=? ORDER BY version DESC LIMIT 1').get(submitted.id);
  assert.deepEqual({ ...pending }, { status:'pending', reviewed_by:null });
  const closedMissingEvidence = db.prepare("SELECT COUNT(*) AS count FROM work_tasks WHERE status='closed' AND (closure_evidence_id IS NULL OR closure_evidence_sha256 IS NULL)").get().count;
  assert.equal(closedMissingEvidence, 0);

  const base = `http://127.0.0.1:${server.address().port}`;
  const response = await fetch(`${base}/api/inbox?gstinId=1&includeSnoozed=1`, {
    headers: { 'content-type':'application/json', 'x-company-id':'1', 'x-user-id':'2' },
  });
  assert.equal(response.status, 200);
  const inbox = await response.json();
  const task = inbox.items.find((item) => item.id === `work_task:${submitted.id}`);
  assert.ok(task);
  assert.match(task.blocker, /Approved task evidence is required for closure/);
  assert.equal(task.statutoryDueDate, null);
  assert.match(task.deepLink, /^\/work-tasks\?record=/);
});
