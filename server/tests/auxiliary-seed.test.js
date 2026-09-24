import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { openDatabase } = require('../db.cjs');
const { seedAuxiliaryDemo } = require('../auxiliary-seed.cjs');
const { seedOperatingHistory } = require('../operating-history.cjs');

test('auxiliary history is scoped, synthetic, auditable and idempotent', () => {
  const db = openDatabase(':memory:');
  try {
    seedAuxiliaryDemo(db, { today: '2026-09-24' });
    const counts = () => Object.fromEntries(['bank_accounts','bank_statement_imports','bank_statement_lines','bank_statement_import_rows','bank_review_events','cashier_sessions','cashier_payouts','cashier_events','catalogue_item_details','pricing_rules','credit_policies','count_sessions'].map(table => [table, db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n]));
    const first = counts();
    assert.ok(first.bank_accounts >= 5);
    assert.ok(first.bank_statement_lines >= 60);
    assert.ok(first.cashier_sessions >= 12);
    assert.ok(first.catalogue_item_details >= 5);
    assert.ok(first.pricing_rules >= 5);
    assert.ok(first.credit_policies >= 2);
    assert.ok(first.count_sessions >= 2);
    assert.equal(first.bank_statement_import_rows, first.bank_statement_lines);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM bank_statement_lines WHERE status='explained'").get().n > 0, true);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM bank_statement_lines WHERE status='pending'").get().n > 0, true);
    assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM bank_statement_imports WHERE source_name NOT LIKE 'SYNTHETIC DEMO%'").get().n, 0);
    seedAuxiliaryDemo(db, { today: '2026-09-24' });
    assert.deepEqual(counts(), first);
  } finally { db.close(); }
});

test('seeded bank matches have explicit assignments and correct signed amounts', () => {
  const db = openDatabase(':memory:');
  try {
    seedOperatingHistory(db, { today: '2026-09-24' });
    seedAuxiliaryDemo(db, { today: '2026-09-24' });
    const wrong = db.prepare(`SELECT l.id FROM bank_statement_lines l JOIN invoice_payments p ON p.id=l.payment_id
      JOIN invoices v ON v.id=p.invoice_id LEFT JOIN bank_payment_account_assignments a ON a.payment_id=p.id
      WHERE l.status='matched' AND (a.account_id<>l.account_id OR l.amount_cents<>CASE WHEN v.type='sale' THEN p.amount_cents ELSE -p.amount_cents END)`).all();
    assert.deepEqual(wrong, []);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM bank_statement_lines WHERE status='matched'").get().n > 0, true);
    assert.ok(db.prepare("SELECT COUNT(*) AS n FROM bank_statement_lines WHERE reference LIKE 'HIST-%' AND status='matched'").get().n >= 30);
    assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM bank_statement_lines l JOIN bank_statement_imports m ON m.id=l.import_id
      WHERE l.company_id<>m.company_id OR l.account_id<>m.account_id`).get().n, 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM bank_statement_lines WHERE reference LIKE 'SYN-DEMO-BANK-%' AND payment_id IS NOT NULL").get().n, 0);
  } finally { db.close(); }
});
