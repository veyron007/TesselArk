const { createHash } = require('node:crypto');
const { installBankSchema } = require('./bank-db.cjs');
const { installCashierSchema } = require('./cashier-db.cjs');
const { installCatalogueSchema } = require('./catalogue-db.cjs');
const { installPricingSchema } = require('./pricing-db.cjs');
const { installCreditSchema } = require('./credit-db.cjs');
const { installCountsSchema } = require('./counts-db.cjs');

const hash = value => createHash('sha256').update(value).digest('hex');
const monthDay = (today, monthsAgo, day) => {
  const date = new Date(`${today.slice(0, 7)}-01T00:00:00Z`);
  date.setUTCMonth(date.getUTCMonth() - monthsAgo);
  date.setUTCDate(day);
  return date.toISOString().slice(0, 10);
};
const ACCOUNT_NAMES = new Map([
  [1, 'SYNTHETIC DEMO · Mumbai operating'], [2, 'SYNTHETIC DEMO · Pune collections'],
  [3, 'SYNTHETIC DEMO · Bengaluru operating'], [4, 'SYNTHETIC DEMO · Services operating'],
  [5, 'SYNTHETIC DEMO · Nashik retail'],
]);
const STAFF = new Map([[1, 1], [2, 1], [3, 1], [4, 4], [5, 6]]);
const REVIEWER = new Map([[1, 2], [2, 2], [3, 2], [4, 5], [5, 7]]);

function seedBank(db, today) {
  const accounts = new Map();
  for (const [branchId, name] of ACCOUNT_NAMES) {
    const branch = db.prepare('SELECT id,company_id FROM branches WHERE id=?').get(branchId);
    if (!branch) continue;
    let row = db.prepare('SELECT id FROM bank_accounts WHERE company_id=? AND name=?').get(branch.company_id, name);
    if (!row) {
      const id = Number(db.prepare('INSERT INTO bank_accounts(company_id,name,masked_account,created_by) VALUES (?,?,?,?)')
        .run(branch.company_id, name, `SYNTHETIC •••• ${String(branchId).padStart(4, '0')}`, REVIEWER.get(branchId)).lastInsertRowid);
      row = { id };
    }
    accounts.set(branchId, { ...branch, accountId: row.id });
  }

  const groups = new Map();
  const append = (branchId, row) => {
    const account = accounts.get(branchId);
    if (!account) return;
    const key = `${branchId}:${row.date.slice(0, 7)}`;
    const group = groups.get(key) || { account, month: row.date.slice(0, 7), rows: [] };
    group.rows.push(row);
    groups.set(key, group);
  };
  for (const branchId of accounts.keys()) for (let offset = 1; offset <= 6; offset += 1) {
    const date = monthDay(today, offset, 23), month = date.slice(0, 7);
    append(branchId, { date, reference: `SYN-DEMO-BANK-FEE-${branchId}-${month}`, description: 'SYNTHETIC DEMO bank processing fee; locally explained, not posted to ledger', amountCents: -1250, outcome: 'explained' });
    append(branchId, { date: monthDay(today, offset, 18), reference: `SYN-DEMO-BANK-OPEN-${branchId}-${month}`, description: 'SYNTHETIC DEMO customer credit awaiting source allocation', amountCents: 12500 + branchId * 250, outcome: 'pending' });
  }
  const payments = db.prepare(`SELECT p.id,p.company_id,p.amount_cents,p.method,p.reference,p.payment_date,
      v.branch_id,v.type,v.number AS invoice_number,v.status AS invoice_status
    FROM invoice_payments p JOIN invoices v ON v.id=p.invoice_id AND v.company_id=p.company_id
    WHERE p.method IN ('bank','upi') AND v.status='approved' ORDER BY p.id`).all();
  for (const payment of payments) {
    if (!/^(?:HIST|DEMO)-/.test(payment.reference) || !accounts.has(payment.branch_id)) continue;
    const account = accounts.get(payment.branch_id);
    const assignment = db.prepare('SELECT account_id FROM bank_payment_account_assignments WHERE payment_id=?').get(payment.id);
    if (assignment && assignment.account_id !== account.accountId) continue;
    if (!assignment) db.prepare('INSERT INTO bank_payment_account_assignments(payment_id,company_id,account_id,reason,assigned_by) VALUES (?,?,?,?,?)')
      .run(payment.id, payment.company_id, account.accountId, 'SYNTHETIC DEMO account mapping for local statement review', REVIEWER.get(payment.branch_id));
    append(payment.branch_id, { date: payment.payment_date, reference: payment.reference,
      description: `SYNTHETIC DEMO ${payment.type === 'sale' ? 'customer receipt' : 'supplier remittance'} · ${payment.invoice_number}`,
      amountCents: (payment.type === 'sale' ? 1 : -1) * payment.amount_cents,
      paymentId: payment.id, outcome: payment.id % 3 === 0 ? 'pending' : 'matched' });
  }

  for (const group of groups.values()) {
    const { account, month } = group;
    const rows = group.rows.filter(row => !db.prepare('SELECT 1 FROM bank_statement_lines WHERE account_id=? AND reference=?').get(account.accountId, row.reference));
    if (!rows.length) continue;
    const payload = JSON.stringify({ accountId: account.accountId, month, rows });
    const csv = ['date,reference,description,amount', ...rows.map(row => `${row.date},${row.reference},${row.description},${(row.amountCents / 100).toFixed(2)}`)].join('\n');
    const importId = Number(db.prepare(`INSERT INTO bank_statement_imports
      (company_id,account_id,source_name,file_sha256,payload_sha256,row_count,inserted_count,skipped_count,imported_by)
      VALUES (?,?,?,?,?,?,?,?,?)`).run(account.company_id, account.accountId, `SYNTHETIC DEMO · ${month} local bank statement`, hash(csv), hash(payload), rows.length, rows.length, 0, REVIEWER.get(account.id)).lastInsertRowid);
    for (const [index, row] of rows.entries()) {
      const canMatch = row.outcome === 'matched' && !db.prepare('SELECT 1 FROM bank_statement_lines WHERE payment_id=?').get(row.paymentId);
      const outcome = canMatch ? 'matched' : row.outcome === 'explained' ? 'explained' : 'pending';
      const reason = outcome === 'explained' ? 'Synthetic training fee classified for review; no ledger entry was posted' : null;
      const lineId = Number(db.prepare(`INSERT INTO bank_statement_lines
        (company_id,account_id,import_id,line_number,transaction_date,reference,description,amount_cents,status,payment_id,explanation,reviewed_by,reviewed_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(account.company_id, account.accountId, importId, index + 2, row.date, row.reference, row.description, row.amountCents,
        outcome, outcome === 'matched' ? row.paymentId : null, reason, outcome === 'pending' ? null : REVIEWER.get(account.id), outcome === 'pending' ? null : `${row.date} 15:00:00`).lastInsertRowid);
      db.prepare("INSERT INTO bank_statement_import_rows(import_id,line_number,statement_line_id,action) VALUES (?,?,?,'inserted')")
        .run(importId, index + 2, lineId);
      if (outcome !== 'pending') db.prepare('INSERT INTO bank_review_events(company_id,line_id,action,payment_id,reason,actor_id,created_at) VALUES (?,?,?,?,?,?,?)')
        .run(account.company_id, lineId, outcome === 'matched' ? 'match' : 'explain', outcome === 'matched' ? row.paymentId : null,
          outcome === 'matched' ? 'SYNTHETIC DEMO amount, direction and source account reviewed' : reason, REVIEWER.get(account.id), `${row.date} 15:00:00`);
    }
  }
}

function seedCashier(db, today) {
  for (const branchId of [1, 3, 5]) {
    const branch = db.prepare('SELECT company_id FROM branches WHERE id=?').get(branchId);
    if (!branch) continue;
    for (let offset = 1; offset <= 6; offset += 1) {
      const date = monthDay(today, offset, 12);
      if (db.prepare('SELECT 1 FROM cashier_sessions WHERE company_id=? AND branch_id=? AND business_date=?').get(branch.company_id, branchId, date)) continue;
      const opening = 25000 + branchId * 1000, payout = 750 + offset * 25, expected = opening - payout;
      const hasDiscrepancy = branchId === 3 && offset === 3;
      const counted = expected - (hasDiscrepancy ? 100 : 0);
      const id = Number(db.prepare(`INSERT INTO cashier_sessions
        (company_id,branch_id,business_date,status,opening_cash_cents,counted_cash_cents,discrepancy_cents,close_notes,review_note,opened_by,closed_by,reviewed_by,opened_at,closed_at,reviewed_at)
        VALUES (?,?,?,'closed',?,?,?,?,?,?,?,?,?,?,?)`).run(branch.company_id, branchId, date, opening, counted, counted - expected,
          'SYNTHETIC DEMO cash drawer specimen; no customer payment assigned', hasDiscrepancy ? 'SYNTHETIC DEMO variance independently reviewed' : '',
          STAFF.get(branchId), STAFF.get(branchId), hasDiscrepancy ? REVIEWER.get(branchId) : null,
          `${date} 09:00:00`, `${date} 19:00:00`, hasDiscrepancy ? `${date} 20:00:00` : null).lastInsertRowid);
      db.prepare(`INSERT INTO cashier_payouts(company_id,session_id,kind,amount_cents,reference,notes,recorded_by,recorded_at)
        VALUES (?,?,'expense',?,?,?, ?,?)`).run(branch.company_id, id, payout, `SYN-DEMO-DRAWER-${branchId}-${date}`,
        'SYNTHETIC DEMO petty cash expense; documentary drawer movement only', STAFF.get(branchId), `${date} 14:00:00`);
      const event = (action, details, actor, hour) => db.prepare('INSERT INTO cashier_events(company_id,session_id,action,details,actor_id,created_at) VALUES (?,?,?,?,?,?)')
        .run(branch.company_id, id, action, details, actor, `${date} ${hour}:00:00`);
      event('opened', `SYNTHETIC DEMO opening cash ${opening} paise`, STAFF.get(branchId), '09');
      event('payout_recorded', `SYNTHETIC DEMO petty cash ${payout} paise`, STAFF.get(branchId), '14');
      event(hasDiscrepancy ? 'discrepancy_submitted' : 'closed_balanced', `SYNTHETIC DEMO counted ${counted} paise`, STAFF.get(branchId), '19');
      if (hasDiscrepancy) event('discrepancy_approved', 'SYNTHETIC DEMO variance independently reviewed', REVIEWER.get(branchId), '20');
    }
  }
}

function seedCataloguePricing(db, today) {
  const items = db.prepare('SELECT * FROM items WHERE active=1 ORDER BY id').all();
  for (const item of items) {
    const actor = db.prepare("SELECT id FROM users WHERE company_id=? AND role='admin' ORDER BY id LIMIT 1").get(item.company_id)?.id;
    if (!actor) continue;
    const categoryName = item.track_stock ? 'SYNTHETIC DEMO · Stocked merchandise' : 'SYNTHETIC DEMO · Services';
    let category = db.prepare('SELECT id FROM catalogue_categories WHERE company_id=? AND name=?').get(item.company_id, categoryName);
    if (!category) category = { id: Number(db.prepare('INSERT INTO catalogue_categories(company_id,name,source_reference,created_by) VALUES (?,?,?,?)')
      .run(item.company_id, categoryName, 'SYNTHETIC DEMO internal catalogue', actor).lastInsertRowid) };
    if (!db.prepare('SELECT 1 FROM catalogue_item_details WHERE item_id=?').get(item.id)) {
      db.prepare(`INSERT INTO catalogue_item_details(item_id,company_id,category_id,product_kind,salt,launched_on,source_reference,updated_by)
        VALUES (?,?,?,'general','',?,'SYNTHETIC DEMO internal item curation',?)`).run(item.id, item.company_id, category.id, monthDay(today, 4, 1), actor);
      db.prepare('INSERT INTO catalogue_item_tags(item_id,company_id,tag) VALUES (?,?,?)').run(item.id, item.company_id, item.track_stock ? 'stocked' : 'service');
      db.prepare('INSERT INTO catalogue_item_parameters(item_id,company_id,key,value) VALUES (?,?,?,?)').run(item.id, item.company_id, 'unit', item.unit);
      db.prepare('INSERT INTO catalogue_item_events(company_id,item_id,action,source_reference,change_reason,snapshot_json,actor_id) VALUES (?,?,?,?,?,?,?)')
        .run(item.company_id, item.id, 'metadata_updated', 'SYNTHETIC DEMO internal item curation', 'Initial synthetic catalogue curation',
          JSON.stringify({ itemId: item.id, categoryId: category.id, productKind: 'general', tags: [item.track_stock ? 'stocked' : 'service'], syntheticDemo: true }), actor);
    }
    const reference = `SYN-DEMO-PRICE-${item.id}`;
    if (!db.prepare('SELECT 1 FROM pricing_rules WHERE company_id=? AND item_id=?').get(item.company_id, item.id)) {
      const sale = db.prepare(`SELECT l.unit_price_cents AS cents FROM invoice_lines l JOIN invoices v ON v.id=l.invoice_id
        WHERE v.company_id=? AND l.item_id=? AND v.type='sale' AND v.status='approved' ORDER BY v.invoice_date DESC,v.id DESC LIMIT 1`).get(item.company_id, item.id);
      if (!sale) continue;
      const id = Number(db.prepare(`INSERT INTO pricing_rules(company_id,scope,item_id,party_id,rate_cents,default_discount_bps,min_discount_bps,max_discount_bps,effective_from,source_reference,reason,created_by)
        VALUES (?,'item',?,NULL,?,0,0,500,?,?,?,?)`).run(item.company_id, item.id, sale.cents, monthDay(today, 2, 1), reference,
          'SYNTHETIC DEMO advisory price derived from latest approved sale; does not change invoices', actor).lastInsertRowid);
      db.prepare('INSERT INTO pricing_rule_events(company_id,rule_id,action,actor_id,detail_json) VALUES (?,?,?,?,?)')
        .run(item.company_id, id, 'create', actor, JSON.stringify({ sourceReference: reference, syntheticDemo: true }));
    }
  }
}

function seedCreditCounts(db, today) {
  const pairs = db.prepare(`SELECT DISTINCT v.company_id,v.gstin_id,v.branch_id,v.party_id FROM invoices v JOIN parties p ON p.id=v.party_id
    WHERE v.type='sale' AND v.status='approved' AND p.type IN ('customer','both') ORDER BY v.company_id,v.branch_id,v.party_id`).all();
  for (const pair of pairs) {
    if (db.prepare('SELECT 1 FROM credit_policies WHERE company_id=? AND gstin_id=? AND branch_id=? AND party_id=?')
      .get(pair.company_id, pair.gstin_id, pair.branch_id, pair.party_id)) continue;
    const actor = REVIEWER.get(pair.branch_id) || 2;
    const id = Number(db.prepare(`INSERT INTO credit_policies(company_id,gstin_id,branch_id,party_id,base_limit_cents,mode,reason,updated_by)
      VALUES (?,?,?,?,50000000,'warn','SYNTHETIC DEMO advisory limit; no real credit underwriting',?)`).run(pair.company_id, pair.gstin_id, pair.branch_id, pair.party_id, actor).lastInsertRowid);
    db.prepare('INSERT INTO credit_events(company_id,gstin_id,branch_id,party_id,policy_id,action,actor_id,details) VALUES (?,?,?,?,?,?,?,?)')
      .run(pair.company_id, pair.gstin_id, pair.branch_id, pair.party_id, id, 'policy_set', actor, 'SYNTHETIC DEMO advisory credit policy');
  }
  for (const branchId of [1, 3, 5]) {
    const branch = db.prepare('SELECT company_id,gstin_id FROM branches WHERE id=?').get(branchId);
    if (!branch || db.prepare('SELECT 1 FROM count_events e JOIN count_sessions s ON s.id=e.session_id WHERE s.company_id=? AND s.branch_id=? AND e.details=?')
      .get(branch.company_id, branchId, 'SYNTHETIC DEMO current stock count snapshot')) continue;
    const items = db.prepare('SELECT id FROM items WHERE company_id=? AND active=1 AND track_stock=1 ORDER BY id LIMIT 12').all(branch.company_id);
    if (!items.length) continue;
    const actor = STAFF.get(branchId);
    const id = Number(db.prepare('INSERT INTO count_sessions(company_id,gstin_id,branch_id,created_by) VALUES (?,?,?,?)')
      .run(branch.company_id, branch.gstin_id, branchId, actor).lastInsertRowid);
    for (const item of items) {
      const recorded = db.prepare('SELECT COALESCE(SUM(quantity_delta),0) AS q FROM stock_movements WHERE company_id=? AND branch_id=? AND item_id=?')
        .get(branch.company_id, branchId, item.id).q;
      if (recorded < 0) continue;
      db.prepare('INSERT INTO count_lines(session_id,item_id,recorded_quantity) VALUES (?,?,?)').run(id, item.id, recorded);
    }
    db.prepare('INSERT INTO count_events(session_id,company_id,actor_id,action,details) VALUES (?,?,?,?,?)')
      .run(id, branch.company_id, actor, 'create', 'SYNTHETIC DEMO current stock count snapshot');
  }
}

function seedAuxiliaryDemo(db, { today = '2026-09-24' } = {}) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(today)) throw new Error('today must be YYYY-MM-DD');
  for (const install of [installBankSchema, installCashierSchema, installCatalogueSchema, installPricingSchema, installCreditSchema, installCountsSchema]) install(db);
  if (!db.prepare('SELECT 1 FROM companies WHERE id=3').get()) return;
  db.exec('BEGIN IMMEDIATE');
  try {
    seedBank(db, today);
    seedCashier(db, today);
    seedCataloguePricing(db, today);
    seedCreditCounts(db, today);
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}

module.exports = { seedAuxiliaryDemo };
