const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { installFinanceSchema } = require('./finance-db.cjs');
const { installReturnsSchema } = require('./returns-db.cjs');
const { installReturnTaxSchema } = require('./return-tax-db.cjs');
const { installWorkflowSchema } = require('./workflows-db.cjs');
const { installOrdersSchema } = require('./orders-db.cjs');
const { installQuotesSchema, seedQuoteDemo } = require('./quotes-db.cjs');
const { installBatchInventorySchema, seedBatchSpecimen } = require('./batch-inventory-db.cjs');
const { installEvidenceSchema } = require('./evidence-db.cjs');
const { installStatementImportSchema } = require('./statement-import-db.cjs');
const { installLedgerSchema } = require('./ledger-db.cjs');
const { syncLedgerSources } = require('./ledger.cjs');
const { installBankSchema } = require('./bank-db.cjs');
const { installCashierSchema } = require('./cashier-db.cjs');
const { installReturnSettlementSchema } = require('./return-settlement-db.cjs');
const { installReturnsQuarantineSchema, seedQuarantineSpecimen } = require('./returns-quarantine-db.cjs');
const { installStatutoryLifecycleSchema } = require('./statutory-lifecycle-db.cjs');
const { installAccessSchema, seedDemoGrants } = require('./access-db.cjs');
const { seedExpandedDemo } = require('./demo-fixtures.cjs');
const { seedConsignmentDemo } = require('./consignment-db.cjs');
const { seedPriceAdjustmentDemo } = require('./price-adjustment-db.cjs');
const { seedSupplierComparisonDemo } = require('./supplier-comparison.cjs');
const { seedOrderCrmDemo } = require('./order-crm-db.cjs');
const { seedBundleDemo } = require('./bundles.cjs');
const { seedBudgetsDemo } = require('./budgets-db.cjs');
const { installDocumentOutputSchema } = require('./document-output.cjs');
const { installDeliverySchema, seedDeliveryDemo } = require('./delivery.cjs');
const { installMasterImportSchema } = require('./master-import.cjs');
const { seedOperatingHistory } = require('./operating-history.cjs');
const { seedConsumerHealthDemo } = require('./consumer-health-seed.cjs');
const { seedAuxiliaryDemo } = require('./auxiliary-seed.cjs');
const { installGstInvoiceAssistantSchema, seedGstInvoiceCheckDemo } = require('./gst-invoice-assistant.cjs');
const { installGstPlaceOfSupplySchema } = require('./gst-place-of-supply-db.cjs');
const { seedGstPlaceOfSupplyDemo } = require('./gst-place-of-supply.cjs');

function openDatabase(file = process.env.ERP_DB_PATH || path.join(__dirname, 'erp.sqlite')) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;');
  db.exec(`
    CREATE TABLE IF NOT EXISTS companies (id INTEGER PRIMARY KEY, name TEXT NOT NULL, tax_regime TEXT NOT NULL DEFAULT 'regular');
    CREATE TABLE IF NOT EXISTS gstins (id INTEGER PRIMARY KEY, company_id INTEGER NOT NULL REFERENCES companies(id), gstin TEXT NOT NULL UNIQUE, state_code TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS branches (id INTEGER PRIMARY KEY, company_id INTEGER NOT NULL REFERENCES companies(id), gstin_id INTEGER NOT NULL REFERENCES gstins(id), name TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, company_id INTEGER NOT NULL REFERENCES companies(id), name TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('staff','accountant','admin')));
    CREATE TABLE IF NOT EXISTS items (id INTEGER PRIMARY KEY, company_id INTEGER NOT NULL REFERENCES companies(id), sku TEXT NOT NULL, name TEXT NOT NULL, hsn TEXT NOT NULL DEFAULT '', unit TEXT NOT NULL DEFAULT 'pcs', gst_rate_bps INTEGER NOT NULL DEFAULT 1800, reorder_level INTEGER NOT NULL DEFAULT 0, track_stock INTEGER NOT NULL DEFAULT 1, active INTEGER NOT NULL DEFAULT 1, UNIQUE(company_id,sku));
    CREATE TABLE IF NOT EXISTS parties (id INTEGER PRIMARY KEY, company_id INTEGER NOT NULL REFERENCES companies(id), name TEXT NOT NULL, type TEXT NOT NULL CHECK(type IN ('customer','supplier','both')), gstin TEXT NOT NULL DEFAULT '', state_code TEXT NOT NULL DEFAULT '', address TEXT NOT NULL DEFAULT '', phone TEXT NOT NULL DEFAULT '');
    CREATE TABLE IF NOT EXISTS stock_movements (id INTEGER PRIMARY KEY, company_id INTEGER NOT NULL REFERENCES companies(id), branch_id INTEGER NOT NULL REFERENCES branches(id), item_id INTEGER NOT NULL REFERENCES items(id), quantity_delta INTEGER NOT NULL, type TEXT NOT NULL, reason TEXT NOT NULL, client_reference TEXT, invoice_id INTEGER, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE IF NOT EXISTS invoices (id INTEGER PRIMARY KEY, company_id INTEGER NOT NULL REFERENCES companies(id), branch_id INTEGER NOT NULL REFERENCES branches(id), gstin_id INTEGER NOT NULL REFERENCES gstins(id), party_id INTEGER NOT NULL REFERENCES parties(id), fulfillment_id INTEGER REFERENCES order_fulfillments(id), number TEXT NOT NULL, supplier_invoice_number TEXT NOT NULL DEFAULT '', supplier_gstin_snapshot TEXT NOT NULL DEFAULT '', party_name_snapshot TEXT NOT NULL DEFAULT '', type TEXT NOT NULL CHECK(type IN ('sale','purchase')), status TEXT NOT NULL CHECK(status IN ('draft','submitted','approved')), invoice_date TEXT NOT NULL, notes TEXT NOT NULL DEFAULT '', subtotal_cents INTEGER NOT NULL, tax_cents INTEGER NOT NULL, total_cents INTEGER NOT NULL, created_by INTEGER NOT NULL REFERENCES users(id), submitted_by INTEGER REFERENCES users(id), approved_by INTEGER REFERENCES users(id), created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE(company_id,number));
    CREATE TABLE IF NOT EXISTS invoice_lines (id INTEGER PRIMARY KEY, invoice_id INTEGER NOT NULL REFERENCES invoices(id), item_id INTEGER NOT NULL REFERENCES items(id), fulfillment_line_id INTEGER REFERENCES order_fulfillment_lines(id), quantity INTEGER NOT NULL, unit_price_cents INTEGER NOT NULL, gst_rate_bps INTEGER NOT NULL, subtotal_cents INTEGER NOT NULL, tax_cents INTEGER NOT NULL, total_cents INTEGER NOT NULL, item_sku_snapshot TEXT NOT NULL DEFAULT '', item_name_snapshot TEXT NOT NULL DEFAULT '', item_hsn_snapshot TEXT NOT NULL DEFAULT '', item_unit_snapshot TEXT NOT NULL DEFAULT '', item_identity_source TEXT NOT NULL DEFAULT 'line_creation');
    CREATE TABLE IF NOT EXISTS gst_periods (id INTEGER PRIMARY KEY, company_id INTEGER NOT NULL REFERENCES companies(id), gstin_id INTEGER NOT NULL REFERENCES gstins(id), period TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('open','reviewed','approved')), review_notes TEXT NOT NULL DEFAULT '', reviewed_by INTEGER REFERENCES users(id), approved_by INTEGER REFERENCES users(id), UNIQUE(gstin_id,period));
    CREATE TABLE IF NOT EXISTS purchase_fixtures (id INTEGER PRIMARY KEY, company_id INTEGER NOT NULL REFERENCES companies(id), gstin_id INTEGER NOT NULL REFERENCES gstins(id), supplier_gstin TEXT NOT NULL, invoice_number TEXT NOT NULL, invoice_date TEXT NOT NULL, taxable_cents INTEGER NOT NULL, tax_cents INTEGER NOT NULL, source_period TEXT NOT NULL, source_name TEXT NOT NULL, imported_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE(company_id,gstin_id,supplier_gstin,invoice_number));
    CREATE TABLE IF NOT EXISTS purchase_evidence (invoice_id INTEGER PRIMARY KEY REFERENCES invoices(id), company_id INTEGER NOT NULL REFERENCES companies(id), fixture_id INTEGER REFERENCES purchase_fixtures(id), match_status TEXT NOT NULL DEFAULT 'unmatched' CHECK(match_status IN ('unmatched','matched','mismatch')), eligibility_status TEXT NOT NULL DEFAULT 'pending' CHECK(eligibility_status IN ('pending','eligible','blocked')), claim_period TEXT, review_reason TEXT NOT NULL DEFAULT '', matched_by INTEGER REFERENCES users(id), reviewed_by INTEGER REFERENCES users(id), matched_at TEXT, reviewed_at TEXT);
    CREATE TABLE IF NOT EXISTS purchase_evidence_events (id INTEGER PRIMARY KEY, invoice_id INTEGER NOT NULL REFERENCES invoices(id), action TEXT NOT NULL, details TEXT NOT NULL, actor_id INTEGER NOT NULL REFERENCES users(id), created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
    CREATE INDEX IF NOT EXISTS idx_invoices_scope ON invoices(company_id,invoice_date,status);
    CREATE INDEX IF NOT EXISTS idx_stock_scope ON stock_movements(company_id,branch_id,item_id);
    CREATE UNIQUE INDEX IF NOT EXISTS uq_eligible_fixture ON purchase_evidence(fixture_id) WHERE eligibility_status='eligible' AND fixture_id IS NOT NULL;
  `);
  if (!db.prepare('PRAGMA table_info(gst_periods)').all().some(row => row.name === 'review_notes')) db.exec("ALTER TABLE gst_periods ADD COLUMN review_notes TEXT NOT NULL DEFAULT ''");
  if (!db.prepare('PRAGMA table_info(invoices)').all().some(row => row.name === 'supplier_invoice_number')) db.exec("ALTER TABLE invoices ADD COLUMN supplier_invoice_number TEXT NOT NULL DEFAULT ''");
  if (!db.prepare('PRAGMA table_info(invoices)').all().some(row => row.name === 'supplier_gstin_snapshot')) db.exec("ALTER TABLE invoices ADD COLUMN supplier_gstin_snapshot TEXT NOT NULL DEFAULT ''");
  if (!db.prepare('PRAGMA table_info(invoices)').all().some(row => row.name === 'party_name_snapshot')) db.exec("ALTER TABLE invoices ADD COLUMN party_name_snapshot TEXT NOT NULL DEFAULT ''");
  if (!db.prepare('PRAGMA table_info(invoices)').all().some(row => row.name === 'fulfillment_id')) db.exec('ALTER TABLE invoices ADD COLUMN fulfillment_id INTEGER REFERENCES order_fulfillments(id)');
  if (!db.prepare('PRAGMA table_info(invoice_lines)').all().some(row => row.name === 'fulfillment_line_id')) db.exec('ALTER TABLE invoice_lines ADD COLUMN fulfillment_line_id INTEGER REFERENCES order_fulfillment_lines(id)');
  const invoiceLineColumns = new Set(db.prepare('PRAGMA table_info(invoice_lines)').all().map(row => row.name));
  for (const column of ['item_sku_snapshot', 'item_name_snapshot', 'item_hsn_snapshot', 'item_unit_snapshot']) {
    if (!invoiceLineColumns.has(column)) db.exec(`ALTER TABLE invoice_lines ADD COLUMN ${column} TEXT NOT NULL DEFAULT ''`);
  }
  if (!invoiceLineColumns.has('item_identity_source')) db.exec("ALTER TABLE invoice_lines ADD COLUMN item_identity_source TEXT NOT NULL DEFAULT 'legacy_master_backfill'");
  db.exec(`UPDATE invoice_lines SET
    item_sku_snapshot=(SELECT sku FROM items WHERE id=item_id),
    item_name_snapshot=(SELECT name FROM items WHERE id=item_id),
    item_hsn_snapshot=(SELECT hsn FROM items WHERE id=item_id),
    item_unit_snapshot=(SELECT unit FROM items WHERE id=item_id),
    item_identity_source='legacy_master_backfill'
    WHERE item_sku_snapshot='';
    CREATE TRIGGER IF NOT EXISTS invoice_lines_capture_item_identity AFTER INSERT ON invoice_lines
    BEGIN
      UPDATE invoice_lines SET
        item_sku_snapshot=(SELECT sku FROM items WHERE id=NEW.item_id),
        item_name_snapshot=(SELECT name FROM items WHERE id=NEW.item_id),
        item_hsn_snapshot=(SELECT hsn FROM items WHERE id=NEW.item_id),
        item_unit_snapshot=(SELECT unit FROM items WHERE id=NEW.item_id),
        item_identity_source='line_creation'
      WHERE id=NEW.id;
    END;`);
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS uq_invoice_fulfillment ON invoices(fulfillment_id) WHERE fulfillment_id IS NOT NULL; CREATE UNIQUE INDEX IF NOT EXISTS uq_invoice_fulfillment_line ON invoice_lines(fulfillment_line_id) WHERE fulfillment_line_id IS NOT NULL');
  if (!db.prepare('PRAGMA table_info(items)').all().some(row => row.name === 'track_stock')) db.exec('ALTER TABLE items ADD COLUMN track_stock INTEGER NOT NULL DEFAULT 1');
  db.exec("UPDATE items SET track_stock=0 WHERE sku='SVC-030' AND company_id=2");
  if (!db.prepare('PRAGMA table_info(purchase_evidence)').all().some(row => row.name === 'claim_period')) db.exec('ALTER TABLE purchase_evidence ADD COLUMN claim_period TEXT');
  if (!db.prepare('PRAGMA table_info(stock_movements)').all().some(row => row.name === 'client_reference')) db.exec('ALTER TABLE stock_movements ADD COLUMN client_reference TEXT');
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS uq_stock_client_reference ON stock_movements(company_id,client_reference) WHERE client_reference IS NOT NULL');
  db.exec("UPDATE invoices SET supplier_gstin_snapshot=(SELECT gstin FROM parties WHERE parties.id=invoices.party_id),party_name_snapshot=(SELECT name FROM parties WHERE parties.id=invoices.party_id) WHERE party_name_snapshot=''");
  db.exec("DROP INDEX IF EXISTS uq_approved_supplier_bill; CREATE UNIQUE INDEX uq_approved_supplier_bill ON invoices(company_id,gstin_id,party_id,supplier_invoice_number) WHERE type='purchase' AND status='approved' AND supplier_invoice_number<>''");
  installFinanceSchema(db);
  installReturnsSchema(db);
  installReturnTaxSchema(db);
  installWorkflowSchema(db);
  installOrdersSchema(db);
  installQuotesSchema(db);
  installBatchInventorySchema(db);
  installEvidenceSchema(db);
  installStatementImportSchema(db);
  installLedgerSchema(db);
  installBankSchema(db);
  installCashierSchema(db);
  installReturnSettlementSchema(db);
  installReturnsQuarantineSchema(db);
  installStatutoryLifecycleSchema(db);
  installAccessSchema(db);
  installDocumentOutputSchema(db);
  installDeliverySchema(db);
  installMasterImportSchema(db);
  installGstInvoiceAssistantSchema(db);
  installGstPlaceOfSupplySchema(db);
  if (!db.prepare('SELECT 1 FROM companies LIMIT 1').get()) seed(db);
  if (!db.prepare("SELECT 1 FROM users WHERE company_id=2 AND role='admin'").get()) {
    db.prepare("INSERT INTO users(company_id,name,role) VALUES (2,'Aarav Services Owner','admin')").run();
  }
  if (!db.prepare("SELECT 1 FROM users WHERE company_id=3 AND role='accountant'").get()) {
    db.prepare("INSERT INTO users(company_id,name,role) VALUES (3,'Nila Retail Accountant','accountant')").run();
  }
  if (!db.prepare('SELECT 1 FROM purchase_fixtures LIMIT 1').get()) seedPurchaseEvidence(db);
  seedFinanceReturns(db);
  seedMumbaiShowcase(db);
  seedOrderSpecimens(db);
  seedWorkflowSpecimens(db);
  seedEvidenceSpecimen(db);
  seedBatchSpecimen(db);
  seedExpandedDemo(db);
  if (file === path.join(__dirname, 'erp.sqlite')) seedQuarantineSpecimen(db);
  seedDemoGrants(db);
  if (file === path.join(__dirname, 'erp.sqlite')) {
    seedConsignmentDemo(db);
    seedPriceAdjustmentDemo(db);
    seedSupplierComparisonDemo(db);
    seedOrderCrmDemo(db);
    seedBundleDemo(db);
    seedBudgetsDemo(db);
    seedDeliveryDemo(db);
  }
  db.exec("UPDATE invoices SET supplier_gstin_snapshot=(SELECT gstin FROM parties WHERE parties.id=invoices.party_id),party_name_snapshot=(SELECT name FROM parties WHERE parties.id=invoices.party_id) WHERE party_name_snapshot=''");
  if (file === path.join(__dirname, 'erp.sqlite')) {
    seedOperatingHistory(db);
    seedConsumerHealthDemo(db);
    seedGstInvoiceCheckDemo(db);
    seedAuxiliaryDemo(db);
    seedQuoteDemo(db);
    seedGstPlaceOfSupplyDemo(db);
  }
  syncLedgerSources(db);
  return db;
}

function seedEvidenceSpecimen(db) {
  const target = db.prepare("SELECT id FROM workflow_cases WHERE company_id=1 AND gstin_id=1 AND branch_id=1 AND reference='DEMO-CASE-PHARM-036'").get();
  if (!target) return;
  const title = 'SYNTHETIC DEMO: Pharmacy receiving note';
  if (db.prepare("SELECT 1 FROM evidence_documents WHERE company_id=1 AND target_type='workflow_case' AND target_id=? AND title=?").get(target.id,title)) return;
  const versions = [
    { fileName:'synthetic-pharmacy-receipt-v1.txt', content:'SYNTHETIC DEMO ONLY. Sample pharmacy receiving note for interface review. No authentic supplier document or regulated verification.\n', status:'approved', reviewer:2, reason:'Reviewed as a synthetic presentation specimen only.' },
    { fileName:'synthetic-pharmacy-receipt-v2.txt', content:'SYNTHETIC DEMO ONLY. Revised sample pharmacy receiving note, awaiting local review. No authentic supplier document.\n', status:'pending', reviewer:null, reason:'' },
  ];
  db.exec('BEGIN IMMEDIATE');
  try {
    const id = Number(db.prepare("INSERT INTO evidence_documents(company_id,gstin_id,branch_id,title,audience,target_type,target_id,created_by) VALUES (1,1,1,?,'internal','workflow_case',?,1)").run(title,target.id).lastInsertRowid);
    versions.forEach((spec,index) => {
      const content = Buffer.from(spec.content,'utf8');
      db.prepare('INSERT INTO evidence_versions(document_id,version,file_name,mime_type,byte_size,sha256,content,status,uploaded_by,reviewed_by,reviewed_at,review_reason) VALUES (?,? ,?,\'text/plain\',?,?,?,?,1,?,CASE WHEN ? IS NULL THEN NULL ELSE CURRENT_TIMESTAMP END,?)')
        .run(id,index+1,spec.fileName,content.length,createHash('sha256').update(content).digest('hex'),content,spec.status,spec.reviewer,spec.reviewer,spec.reason);
    });
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}

function seedOrderSpecimens(db) {
  if (!db.prepare('SELECT 1 FROM companies WHERE id=1').get()) return;
  if (db.prepare("SELECT 1 FROM orders WHERE company_id=1 AND number='DEMO-SO-BLR-301'").get() && db.prepare("SELECT 1 FROM orders WHERE company_id=1 AND number='DEMO-PO-BLR-302'").get()) return;
  const sale = db.prepare("SELECT invoice_date FROM invoices WHERE company_id=1 AND number='DEMO-BLR-101'").get();
  if (!sale) return;
  const date = sale.invoice_date, period = date.slice(0,7);
  const periodStatus = db.prepare('SELECT status FROM gst_periods WHERE company_id=1 AND gstin_id=2 AND period=?').get(period)?.status;
  if (periodStatus !== 'open') return;
  const specs = [
    { type:'sale',orderNumber:'DEMO-SO-BLR-301',fulfillmentNumber:'DEMO-DISP-BLR-301',invoiceNumber:'DEMO-SAL-BLR-301',partyId:1,partyName:'Harbor Clinic',partyGstin:'27DEMOH0000A1Z4',itemId:1,ordered:10,fulfilled:4,price:4000,rate:1200,supplierReference:'' },
    { type:'purchase',orderNumber:'DEMO-PO-BLR-302',fulfillmentNumber:'DEMO-GRN-BLR-302',invoiceNumber:'DEMO-PUR-BLR-302',partyId:2,partyName:'Northstar Pharma',partyGstin:'27DEMOS0000A1Z2',itemId:2,ordered:12,fulfilled:5,price:1500,rate:1800,supplierReference:'DEMO-NS-BLR-302' },
  ];
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const spec of specs) {
      if (db.prepare('SELECT 1 FROM orders WHERE company_id=1 AND number=?').get(spec.orderNumber)) continue;
      const orderId = Number(db.prepare("INSERT INTO orders(company_id,gstin_id,branch_id,party_id,party_name_snapshot,type,number,status,order_date,notes,created_by,confirmed_by,confirmed_at) VALUES (1,2,3,?,?,?,?,'confirmed',?,'SYNTHETIC PARTIAL ORDER SHOWCASE',1,2,CURRENT_TIMESTAMP)")
        .run(spec.partyId,spec.partyName,spec.type,spec.orderNumber,date).lastInsertRowid);
      const orderLineId = Number(db.prepare('INSERT INTO order_lines(order_id,item_id,item_name_snapshot,quantity,unit_price_cents,gst_rate_bps) VALUES (?,?,?,?,?,?)')
        .run(orderId,spec.itemId,db.prepare('SELECT name FROM items WHERE id=?').get(spec.itemId).name,spec.ordered,spec.price,spec.rate).lastInsertRowid);
      const fulfillmentId = Number(db.prepare("INSERT INTO order_fulfillments(order_id,company_id,number,kind,status,event_date,notes,created_by,confirmed_by,confirmed_at) VALUES (?,1,?,?,'confirmed',?,'SYNTHETIC PARTIAL FULFILLMENT',1,2,CURRENT_TIMESTAMP)")
        .run(orderId,spec.fulfillmentNumber,spec.type === 'sale' ? 'dispatch' : 'receipt',date).lastInsertRowid);
      const delta = spec.type === 'sale' ? -spec.fulfilled : spec.fulfilled;
      const fulfillmentLineId = Number(db.prepare('INSERT INTO order_fulfillment_lines(fulfillment_id,order_line_id,quantity) VALUES (?,?,?)').run(fulfillmentId,orderLineId,spec.fulfilled).lastInsertRowid);
      const movementId = Number(db.prepare('INSERT INTO stock_movements(company_id,branch_id,item_id,quantity_delta,type,reason,client_reference) VALUES (1,3,?,?,?,?,?)')
        .run(spec.itemId,delta,spec.type === 'sale' ? 'sales_dispatch' : 'purchase_receipt',spec.fulfillmentNumber,`order-fulfillment:${fulfillmentId}:line:${fulfillmentLineId}`).lastInsertRowid);
      db.prepare('UPDATE order_fulfillment_lines SET stock_movement_id=? WHERE id=?').run(movementId,fulfillmentLineId);
      for (const action of ['create','confirm','create_fulfillment','confirm_fulfillment']) db.prepare('INSERT INTO order_events(company_id,order_id,fulfillment_id,action,actor_id,details) VALUES (1,?,?,?,?,?)')
        .run(orderId,action.includes('fulfillment') ? fulfillmentId : null,action,action === 'create' || action === 'create_fulfillment' ? 1 : 2,'Synthetic demo event');
      const subtotal = spec.fulfilled * spec.price, tax = Math.round(subtotal * spec.rate / 10000);
      const invoiceId = Number(db.prepare("INSERT INTO invoices(company_id,branch_id,gstin_id,party_id,fulfillment_id,number,supplier_invoice_number,supplier_gstin_snapshot,party_name_snapshot,type,status,invoice_date,notes,subtotal_cents,tax_cents,total_cents,created_by,submitted_by,approved_by) VALUES (1,3,2,?,?,?,?,?,?,?,'approved',?,'SYNTHETIC LINKED FULFILLMENT; stock posted only at confirmation',?,?,?,1,1,2)")
        .run(spec.partyId,fulfillmentId,spec.invoiceNumber,spec.supplierReference,spec.partyGstin,spec.partyName,spec.type,date,subtotal,tax,subtotal+tax).lastInsertRowid);
      db.prepare('INSERT INTO invoice_lines(invoice_id,item_id,fulfillment_line_id,quantity,unit_price_cents,gst_rate_bps,subtotal_cents,tax_cents,total_cents) VALUES (?,?,?,?,?,?,?,?,?)')
        .run(invoiceId,spec.itemId,fulfillmentLineId,spec.fulfilled,spec.price,spec.rate,subtotal,tax,subtotal+tax);
      if (spec.type === 'purchase') db.prepare('INSERT INTO purchase_evidence(invoice_id,company_id) VALUES (?,1)').run(invoiceId);
    }
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}

function seedWorkflowSpecimens(db) {
  if (!db.prepare('SELECT 1 FROM companies WHERE id=1').get()) return;
  const today = new Date().toISOString().slice(0,10);
  const featureMap = new Map(require('../src/data/features.json').map(feature => [feature.id, feature]));
  const specimens = [
    { featureId:'ERP-046',reference:'DEMO-CASE-MFG-046',title:'Demo batch quality hold intake',status:'draft',amountCents:120000,evidenceReference:'SYNTHETIC-BOM-QA-046',fields:{demoOnly:true,bomVersion:'DEMO-v1',qualityState:'hold'} },
    { featureId:'ERP-036',reference:'DEMO-CASE-PHARM-036',title:'Demo medicine register evidence review',status:'submitted',amountCents:0,evidenceReference:'SYNTHETIC-REGISTER-036',fields:{demoOnly:true,registerType:'training specimen',patientDataIncluded:false} },
    { featureId:'ERP-037',reference:'DEMO-CASE-PHARM-037',title:'Demo prescription follow-up intake',status:'draft',amountCents:0,evidenceReference:'SYNTHETIC-RX-037',fields:{demoOnly:true,patientDataIncluded:false,dispensingPosted:false} },
    { featureId:'ERP-047',reference:'DEMO-CASE-PAYROLL-047',title:'Demo payroll input review',status:'approved',amountCents:450000,evidenceReference:'SYNTHETIC-PAYROLL-047',fields:{demoOnly:true,employeeDataIncluded:false,payrollPosted:false} },
    { featureId:'TAX-19',reference:'DEMO-CASE-NOTICE-19',title:'Demo CA notice response draft',status:'submitted',amountCents:0,evidenceReference:'SYNTHETIC-NOTICE-19',fields:{demoOnly:true,officialSubmission:false,acknowledgementPresent:false} },
  ];
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const specimen of specimens) {
      if (db.prepare('SELECT 1 FROM workflow_cases WHERE company_id=1 AND reference=?').get(specimen.reference)) continue;
      const id = Number(db.prepare("INSERT INTO workflow_cases(company_id,feature_id,gstin_id,branch_id,title,reference,record_date,amount_cents,notes,evidence_reference,fields_json,status,created_by) VALUES (1,?,1,1,?,?,?,?,'SYNTHETIC PROTOTYPE ONLY. No specialist stock, pharmacy, payroll, or statutory effect.',?,?,'draft',1)")
        .run(specimen.featureId,specimen.title,specimen.reference,today,specimen.amountCents,specimen.evidenceReference,JSON.stringify(specimen.fields)).lastInsertRowid);
      const event = (action, actorId, details) => {
        const row = db.prepare('SELECT * FROM workflow_cases WHERE id=?').get(id);
        const feature = featureMap.get(row.feature_id);
        const snapshot = { id:row.id,companyId:row.company_id,featureId:row.feature_id,gstinId:row.gstin_id,branchId:row.branch_id,title:row.title,reference:row.reference,date:row.record_date,amountCents:row.amount_cents,notes:row.notes,evidenceReference:row.evidence_reference,fields:JSON.parse(row.fields_json),status:row.status,createdBy:row.created_by,submittedBy:row.submitted_by,reviewedBy:row.reviewed_by,reviewReason:row.review_reason,featureDomain:feature.domain,featureCapability:feature.capability,prototype:true };
        db.prepare('INSERT INTO workflow_case_events(case_id,company_id,action,actor_id,details,snapshot_json) VALUES (?,1,?,?,?,?)').run(id,action,actorId,details,JSON.stringify(snapshot));
      };
      event('create',1,'Synthetic prototype created for presentation');
      if (specimen.status !== 'draft') {
        db.prepare("UPDATE workflow_cases SET status='submitted',submitted_by=1,updated_at=CURRENT_TIMESTAMP WHERE id=?").run(id);
        event('submit',1,'Submitted for local prototype review');
      }
      if (specimen.status === 'approved') {
        db.prepare("UPDATE workflow_cases SET status='approved',reviewed_by=2,review_reason='Internal prototype review only; no specialist effect',updated_at=CURRENT_TIMESTAMP WHERE id=?").run(id);
        event('approve',2,'Internal prototype review only; no specialist effect');
      }
    }
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}

function seedMumbaiShowcase(db) {
  if (!db.prepare('SELECT 1 FROM companies WHERE id=1').get()) return;
  if (db.prepare("SELECT 1 FROM invoices WHERE company_id=1 AND number='DEMO-MUM-201'").get()) return;
  const previousMonth = new Date();
  previousMonth.setUTCDate(1);
  previousMonth.setUTCMonth(previousMonth.getUTCMonth() - 1);
  const invoiceDate = previousMonth.toISOString().slice(0,10);
  const period = invoiceDate.slice(0,7);
  const status = db.prepare('SELECT status FROM gst_periods WHERE company_id=1 AND gstin_id=1 AND period=?').get(period)?.status;
  if (status && status !== 'open') return;
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare("INSERT OR IGNORE INTO gst_periods(company_id,gstin_id,period,status) VALUES (1,1,?,'open')").run(period);
    const invoiceId = Number(db.prepare("INSERT INTO invoices(company_id,branch_id,gstin_id,party_id,number,supplier_gstin_snapshot,party_name_snapshot,type,status,invoice_date,notes,subtotal_cents,tax_cents,total_cents,created_by,submitted_by,approved_by) VALUES (1,1,1,1,'DEMO-MUM-201','27DEMOH0000A1Z4','Harbor Clinic','sale','approved',?,'Separate synthetic first-visit finance and returns example',12000,2160,14160,1,1,2)").run(invoiceDate).lastInsertRowid);
    const lineId = Number(db.prepare('INSERT INTO invoice_lines(invoice_id,item_id,quantity,unit_price_cents,gst_rate_bps,subtotal_cents,tax_cents,total_cents) VALUES (?,3,4,3000,1800,12000,2160,14160)').run(invoiceId).lastInsertRowid);
    db.prepare("INSERT INTO stock_movements(company_id,branch_id,item_id,quantity_delta,type,reason,invoice_id) VALUES (1,1,3,-4,'sale','DEMO-MUM-201',?)").run(invoiceId);
    db.prepare("INSERT INTO invoice_payments(company_id,invoice_id,amount_cents,method,reference,payment_date,recorded_by) VALUES (1,?,5000,'bank','DEMO-MUM-BANK-201',?,1)").run(invoiceId,invoiceDate);
    const returnId = Number(db.prepare("INSERT INTO returns(company_id,invoice_id,number,kind,status,reason,subtotal_cents,tax_proposal_cents,total_proposal_cents,created_by,approved_by,approved_at) VALUES (1,?,'DEMO-CRN-MUM-201','sales_return','approved','Synthetic sealed-box return; tax proposal unreviewed',3000,540,3540,1,2,CURRENT_TIMESTAMP)").run(invoiceId).lastInsertRowid);
    const movementId = Number(db.prepare("INSERT INTO stock_movements(company_id,branch_id,item_id,quantity_delta,type,reason,invoice_id) VALUES (1,1,3,1,'sales_return','DEMO-CRN-MUM-201',?)").run(invoiceId).lastInsertRowid);
    db.prepare('INSERT INTO return_lines(return_id,invoice_line_id,item_id,quantity,subtotal_cents,tax_proposal_cents,stock_movement_id) VALUES (?,?,3,1,3000,540,?)').run(returnId,lineId,movementId);
    db.prepare("UPDATE gst_periods SET status='approved',review_notes='INTERNAL DEMO REVIEW ONLY. No GST portal filing or acknowledgement.',reviewed_by=2,approved_by=2 WHERE company_id=1 AND gstin_id=1 AND period=?").run(period);
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}

function seedFinanceReturns(db) {
  if (!db.prepare('SELECT 1 FROM companies WHERE id=1').get()) return;
  const existingFirst = db.prepare("SELECT id,invoice_date FROM invoices WHERE company_id=1 AND number='DEMO-BLR-101'").get();
  const existingSecond = db.prepare("SELECT id FROM invoices WHERE company_id=1 AND number='DEMO-BLR-102'").get();
  if (existingFirst && existingSecond) return;
  const previousMonth = new Date();
  previousMonth.setUTCDate(1);
  previousMonth.setUTCMonth(previousMonth.getUTCMonth() - 1);
  const invoiceDate = existingFirst?.invoice_date || previousMonth.toISOString().slice(0, 10);
  const period = invoiceDate.slice(0, 7);
  const periodStatus = db.prepare('SELECT status FROM gst_periods WHERE company_id=1 AND gstin_id=2 AND period=?').get(period)?.status;
  if (periodStatus && periodStatus !== 'open') return;
  db.exec('BEGIN IMMEDIATE');
  try {
    let party = db.prepare("SELECT id,name,gstin FROM parties WHERE company_id=1 AND name='Mysuru Care (Demo)'").get();
    if (!party) {
      const id = Number(db.prepare("INSERT INTO parties(company_id,name,type,gstin,state_code,address,phone) VALUES (1,'Mysuru Care (Demo)','customer','29DEMOH0000A1Z8','29','Mysuru, Karnataka','9876543215')").run().lastInsertRowid);
      party = db.prepare('SELECT id,name,gstin FROM parties WHERE id=?').get(id);
    }
    db.prepare("INSERT OR IGNORE INTO gst_periods(company_id,gstin_id,period,status) VALUES (1,2,?,'open')").run(period);
    const rows = [
      { number:'DEMO-BLR-101', itemId:1, quantity:10, unitPrice:5000, rate:1200, subtotal:50000, tax:6000, returnQuantity:2, returnStatus:'approved' },
      { number:'DEMO-BLR-102', itemId:2, quantity:4, unitPrice:2500, rate:1800, subtotal:10000, tax:1800, returnQuantity:1, returnStatus:'draft' },
    ];
    for (const row of rows) {
      let invoice = db.prepare('SELECT id FROM invoices WHERE company_id=1 AND number=?').get(row.number);
      if (!invoice) {
        const id = Number(db.prepare("INSERT INTO invoices(company_id,branch_id,gstin_id,party_id,number,supplier_gstin_snapshot,party_name_snapshot,type,status,invoice_date,notes,subtotal_cents,tax_cents,total_cents,created_by,submitted_by,approved_by) VALUES (1,3,2,?,?,?,?,'sale','approved',?,'Synthetic Bengaluru finance and returns showcase; local approval only',?,?,?,1,1,2)")
          .run(party.id,row.number,party.gstin,party.name,invoiceDate,row.subtotal,row.tax,row.subtotal+row.tax).lastInsertRowid);
        db.prepare('INSERT INTO invoice_lines(invoice_id,item_id,quantity,unit_price_cents,gst_rate_bps,subtotal_cents,tax_cents,total_cents) VALUES (?,?,?,?,?,?,?,?)')
          .run(id,row.itemId,row.quantity,row.unitPrice,row.rate,row.subtotal,row.tax,row.subtotal+row.tax);
        db.prepare("INSERT INTO stock_movements(company_id,branch_id,item_id,quantity_delta,type,reason,invoice_id) VALUES (1,3,?,?,'sale',?,?)")
          .run(row.itemId,-row.quantity,row.number,id);
        invoice = { id };
      }
      const line = db.prepare('SELECT id FROM invoice_lines WHERE invoice_id=?').get(invoice.id);
      if (!line) throw new Error(`Missing demo invoice line for ${row.number}`);
      const returnNumber = row.returnStatus === 'approved' ? 'DEMO-CRN-BLR-101' : 'DEMO-CRN-BLR-102';
      if (!db.prepare('SELECT 1 FROM returns WHERE company_id=1 AND number=?').get(returnNumber)) {
        const returnSubtotal = row.returnQuantity * row.unitPrice;
        const returnTax = Math.round(returnSubtotal * row.rate / 10000);
        const returnId = Number(db.prepare("INSERT INTO returns(company_id,invoice_id,number,kind,status,reason,subtotal_cents,tax_proposal_cents,total_proposal_cents,created_by,approved_by,approved_at) VALUES (1,?,?,'sales_return',?,'Synthetic demo return; tax proposal unreviewed',?,?,?,1,?,CASE WHEN ?='approved' THEN CURRENT_TIMESTAMP ELSE NULL END)")
          .run(invoice.id,returnNumber,row.returnStatus,returnSubtotal,returnTax,returnSubtotal+returnTax,row.returnStatus === 'approved' ? 2 : null,row.returnStatus).lastInsertRowid);
        let movementId = null;
        if (row.returnStatus === 'approved') movementId = Number(db.prepare("INSERT INTO stock_movements(company_id,branch_id,item_id,quantity_delta,type,reason,invoice_id) VALUES (1,3,?,?,'sales_return',?,?)")
          .run(row.itemId,row.returnQuantity,returnNumber,invoice.id).lastInsertRowid);
        db.prepare('INSERT INTO return_lines(return_id,invoice_line_id,item_id,quantity,subtotal_cents,tax_proposal_cents,stock_movement_id) VALUES (?,?,?,?,?,?,?)')
          .run(returnId,line.id,row.itemId,row.returnQuantity,returnSubtotal,returnTax,movementId);
      }
    }
    const paidInvoice = db.prepare("SELECT id FROM invoices WHERE company_id=1 AND number='DEMO-BLR-101'").get();
    db.prepare("INSERT OR IGNORE INTO invoice_payments(company_id,invoice_id,amount_cents,method,reference,payment_date,recorded_by) VALUES (1,?,20000,'bank','DEMO-BLR-BANK-101',?,1)").run(paidInvoice.id,invoiceDate);
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}

function seedPurchaseEvidence(db) {
  const today = new Date().toISOString().slice(0, 10), period = today.slice(0, 7);
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const [supplierNumber, taxable, tax, fixtureTaxable, fixtureTax] of [
      ['NS-501', 30000, 3600, 30000, 3600],
      ['NS-502', 20000, 2400, 22000, 2640],
    ]) {
      const number = `DEMO-${supplierNumber}`;
      let invoice = db.prepare('SELECT id FROM invoices WHERE company_id=1 AND number=?').get(number);
      if (!invoice) {
        const id = Number(db.prepare("INSERT INTO invoices(company_id,branch_id,gstin_id,party_id,number,supplier_invoice_number,supplier_gstin_snapshot,party_name_snapshot,type,status,invoice_date,notes,subtotal_cents,tax_cents,total_cents,created_by,submitted_by,approved_by) VALUES (1,1,1,2,?,?,'27DEMOS0000A1Z2','Northstar Pharma','purchase','approved',?,'Synthetic purchase evidence; local approval only',?,?,?,1,1,2)").run(number,supplierNumber,today,taxable,tax,taxable+tax).lastInsertRowid);
        const quantity = taxable / 10000;
        db.prepare('INSERT INTO invoice_lines(invoice_id,item_id,quantity,unit_price_cents,gst_rate_bps,subtotal_cents,tax_cents,total_cents) VALUES (?,?,?,?,?,?,?,?)').run(id,1,quantity,10000,1200,taxable,tax,taxable+tax);
        db.prepare("INSERT INTO stock_movements(company_id,branch_id,item_id,quantity_delta,type,reason,invoice_id) VALUES (1,1,1,?,'purchase',?,?)").run(quantity,number,id);
        invoice = { id };
      }
      db.prepare("INSERT OR IGNORE INTO purchase_evidence(invoice_id,company_id) VALUES (?,1)").run(invoice.id);
      db.prepare("INSERT OR IGNORE INTO purchase_fixtures(company_id,gstin_id,supplier_gstin,invoice_number,invoice_date,taxable_cents,tax_cents,source_period,source_name) VALUES (1,1,'27DEMOS0000A1Z2',?,?,?,?,?,'Synthetic imported 2B fixture')").run(supplierNumber,today,fixtureTaxable,fixtureTax,period);
    }
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}

function seed(db) {
  db.exec(`
    INSERT INTO companies(id,name,tax_regime) VALUES (1,'Aster Medical Supplies Pvt Ltd (Demo)','regular'),(2,'Aster Services Pvt Ltd (Demo)','regular'),(3,'Nila Retail (Demo)','composition');
    INSERT INTO gstins(id,company_id,gstin,state_code) VALUES (1,1,'27DEMOA0000A1Z1','27'),(2,1,'29DEMOA0000A1Z7','29'),(3,2,'27DEMOA0000B1Z5','27'),(4,3,'27DEMON0000A1Z9','27');
    INSERT INTO branches(id,company_id,gstin_id,name) VALUES (1,1,1,'Mumbai Central'),(2,1,1,'Pune Depot'),(3,1,2,'Bengaluru Branch'),(4,2,3,'Mumbai Office'),(5,3,4,'Nashik Store');
    INSERT INTO users(id,company_id,name,role) VALUES (1,1,'Maya Staff','staff'),(2,1,'Dev Accountant','accountant'),(3,1,'Ravi Owner','admin'),(4,2,'Anika Staff','staff'),(5,2,'Dev Services Accountant','accountant'),(6,3,'Nila Staff','staff'),(7,3,'Ravi Retail Owner','admin');
    INSERT INTO items(id,company_id,sku,name,hsn,unit,gst_rate_bps,reorder_level,track_stock) VALUES (1,1,'MED-001','Glucose Strips','3822','box',1200,10,1),(2,1,'MED-002','Saline Pack','3004','pack',1200,20,1),(3,1,'SUP-010','Syringe Pack','9018','box',1200,5,1),(4,2,'SVC-030','Equipment Calibration','9987','service',1800,0,0),(5,3,'RET-100','Daily Essentials Pack','1905','pack',0,15,1);
    INSERT INTO parties(id,company_id,name,type,gstin,state_code,address,phone) VALUES (1,1,'Harbor Clinic','customer','27DEMOH0000A1Z4','27','Mumbai, Maharashtra','9876543210'),(2,1,'Northstar Pharma','supplier','27DEMOS0000A1Z2','27','Mumbai, Maharashtra','9876543211'),(3,1,'Walk-in Customer','customer','','27','',''),(4,2,'Aster Medical Supplies','customer','27DEMOA0000A1Z1','27','Mumbai','9876543212'),(5,2,'Bright Repairs','supplier','','27','Mumbai','9876543213'),(6,3,'Walk-in Customer','customer','','27','',''),(7,3,'Nila Wholesaler','supplier','27DEMOW0000A1Z2','27','Nashik','9876543214');
    INSERT INTO stock_movements(company_id,branch_id,item_id,quantity_delta,type,reason) VALUES (1,1,1,40,'opening','Demo opening balance'),(1,1,2,85,'opening','Demo opening balance'),(1,1,3,20,'opening','Demo opening balance'),(1,2,1,20,'opening','Demo opening balance'),(1,3,1,40,'opening','Demo opening balance'),(1,3,2,25,'opening','Demo opening balance'),(3,5,5,70,'opening','Demo opening balance');
  `);
  const period = new Date().toISOString().slice(0, 7);
  const today = new Date().toISOString().slice(0, 10);
  db.prepare("INSERT INTO invoices(id,company_id,branch_id,gstin_id,party_id,number,type,status,invoice_date,notes,subtotal_cents,tax_cents,total_cents,created_by,submitted_by,approved_by) VALUES (1,1,1,1,1,'SAL-01-00001','sale','approved',?,'Synthetic demo sale; locally approved',20000,2400,22400,1,1,2)").run(today);
  db.prepare('INSERT INTO invoice_lines(invoice_id,item_id,quantity,unit_price_cents,gst_rate_bps,subtotal_cents,tax_cents,total_cents) VALUES (1,1,2,10000,1200,20000,2400,22400)').run();
  db.prepare("INSERT INTO stock_movements(company_id,branch_id,item_id,quantity_delta,type,reason,invoice_id) VALUES (1,1,1,-2,'sale','SAL-01-00001',1)").run();
  for (const row of db.prepare('SELECT id,company_id FROM gstins').all()) {
    db.prepare('INSERT INTO gst_periods(company_id,gstin_id,period,status) VALUES (?,?,?,?)').run(row.company_id,row.id,period,'open');
  }
}

module.exports = { openDatabase };
