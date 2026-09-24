const express = require('express');
const { openDatabase } = require('./db.cjs');
const { registerFinanceRoutes } = require('./finance.cjs');
const { registerReturnsRoutes } = require('./returns.cjs');
const { registerReturnTaxRoutes } = require('./return-tax.cjs');
const { registerWorkflowRoutes } = require('./workflows.cjs');
const { registerStatutoryMockRoutes } = require('./statutory-mock.cjs');
const { registerOrdersRoutes } = require('./orders.cjs');
const { registerBatchInventoryRoutes, allocateBatchIssue } = require('./batch-inventory.cjs');
const { registerEvidenceRoutes } = require('./evidence.cjs');
const { registerStatementImportRoutes } = require('./statement-import.cjs');
const { registerLedgerRoutes, postInvoice } = require('./ledger.cjs');
const { registerBankRoutes } = require('./bank.cjs');
const { registerCashierRoutes } = require('./cashier.cjs');
const { registerReportingRoutes } = require('./reporting.cjs');
const { registerReturnSettlementRoutes } = require('./return-settlement.cjs');
const { registerStatutoryLifecycleRoutes } = require('./statutory-lifecycle.cjs');
const { allowedScopes, assertScopeAccess } = require('./access.cjs');
const { registerAccessRoutes } = require('./access-routes.cjs');
const { registerLocationsRoutes } = require('./locations.cjs');
const { registerConversionRoutes } = require('./conversion.cjs');
const { registerCatalogueRoutes } = require('./catalogue.cjs');
const { registerCountsRoutes } = require('./counts.cjs');
const { registerPricingRoutes } = require('./pricing.cjs');
const { registerCreditRoutes, holdBaseline, assertCreditHold } = require('./credit.cjs');
const { registerConsignmentRoutes } = require('./consignment.cjs');
const { registerPriceAdjustmentRoutes } = require('./price-adjustments.cjs');
const { registerSupplierComparisonRoutes } = require('./supplier-comparison.cjs');
const { registerOrderCrmRoutes } = require('./order-crm.cjs');
const { registerBundleRoutes } = require('./bundles.cjs');
const { registerBudgetsRoutes } = require('./budgets.cjs');
const { registerDocumentOutputRoutes } = require('./document-output.cjs');
const { registerDeliveryRoutes } = require('./delivery.cjs');
const { registerMasterImportRoutes } = require('./master-import.cjs');
const { registerGstInvoiceAssistantRoutes, assertInvoiceTaxReady } = require('./gst-invoice-assistant.cjs');
const { registerWorkspaceMenuRoutes } = require('./workspace-menu.cjs');
const { createAuth } = require('./auth.cjs');

const fields = (row) => Object.fromEntries(Object.entries(row).map(([key, value]) => [key.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase()), value]));
const supplierKey = (value) => String(value || '').replace(/\s+/g, '').toUpperCase();
const bad = (message, status = 400) => Object.assign(new Error(message), { status });
const integer = (value, name, min = 0) => {
  if (!Number.isSafeInteger(value) || value < min) throw bad(`${name} must be an integer of at least ${min}`);
  return value;
};
const text = (value, name, max = 200, required = true) => {
  if (typeof value !== 'string' || (required && !value.trim()) || value.length > max) throw bad(`${name} is invalid`);
  return value.trim();
};
const date = (value) => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`)) || new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value) throw bad('invoiceDate must be a valid YYYY-MM-DD date');
  return value;
};
const requireRow = (db, table, id, companyId) => {
  const row = db.prepare(`SELECT * FROM ${table} WHERE id=? AND company_id=?`).get(id, companyId);
  if (!row) throw bad(`${table.slice(0, -1)} not found in selected company`, 404);
  return row;
};
const transaction = (db, action) => {
  db.exec('BEGIN IMMEDIATE');
  try { const result = action(); db.exec('COMMIT'); return result; }
  catch (error) { db.exec('ROLLBACK'); throw error; }
};

function createApp({ db = openDatabase(), authMode = process.env.ERP_AUTH_MODE || 'demo', authOptions } = {}) {
  if (!['demo', 'production'].includes(authMode)) throw new Error('ERP_AUTH_MODE must be demo or production');
  const app = express();
  app.disable('x-powered-by');
  if (authMode === 'production') app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Strict-Transport-Security', 'max-age=31536000');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'");
    next();
  });
  const auth = authMode === 'production' ? createAuth(db, authOptions) : null;
  if (auth) app.use('/api', auth.apiLimiter);
  app.use(express.json({ limit: '200kb' }));
  if (auth) {
    auth.registerRoutes(app);
    app.use('/api', auth.authenticate);
  }
  app.use('/api', (req, _res, next) => {
    try {
      const companyId = auth ? req.authIdentity.companyId : Number(req.header('x-company-id') || req.query.companyId || 1);
      const userId = auth ? req.authIdentity.userId : Number(req.header('x-user-id') || 1);
      integer(companyId, 'companyId', 1); integer(userId, 'userId', 1);
      req.company = db.prepare('SELECT * FROM companies WHERE id=?').get(companyId);
      req.user = db.prepare('SELECT * FROM users WHERE id=? AND company_id=?').get(userId, companyId);
      if (!req.company || !req.user) throw bad('Unknown company or user for this company', 403);
      req.db = db;
      req.scopes = allowedScopes(db,{companyId,userId});
      next();
    } catch (error) { next(error); }
  });
  const route = (handler) => (req, res, next) => { try { res.json(handler(req)); } catch (error) { next(error); } };
  const accountant = (req) => { if (!['accountant', 'admin'].includes(req.user.role)) throw bad('Accountant or admin role required', 403); };
  const scope = (req, gstinId, branchId) => assertScopeAccess(db,{ companyId:req.company.id,userId:req.user.id,
    ...(gstinId === undefined ? {} : { gstinId }), ...(branchId === undefined ? {} : { branchId }) });
  const scopedRows = (req, rows, gstin = 'gstin_id', branch = 'branch_id') => rows.filter(row =>
    (gstin === null || req.scopes.gstinIds.includes(row[gstin])) &&
    (branch === null || req.scopes.branchIds.includes(row[branch])));
  const invoiceRow = (req, id) => {
    const row = requireRow(db,'invoices',id,req.company.id);
    scope(req,row.gstin_id,row.branch_id);
    return row;
  };
  const fullGstinScope = (req,gstinId) => {
    scope(req,gstinId);
    const branches = db.prepare('SELECT id FROM branches WHERE company_id=? AND gstin_id=?').all(req.company.id,gstinId);
    if (branches.some(branch => !req.scopes.branchIds.includes(branch.id))) throw bad('All branches for this GSTIN are required to access its period',403);
  };
  const periodRow = (req,id) => {
    const row = requireRow(db,'gst_periods',id,req.company.id);
    fullGstinScope(req,row.gstin_id);
    return row;
  };
  const masterAccess = req => { if (!req.scopes.branchIds.length) throw bad('A branch grant is required for company master data',403); };

  app.get('/api/bootstrap', route((req) => {
    const companies = db.prepare(auth ? 'SELECT * FROM companies WHERE id=?' : 'SELECT * FROM companies ORDER BY id').all(...(auth ? [req.company.id] : [])).map(row => ({ ...fields(row),
      gstins: row.id === req.company.id ? db.prepare('SELECT id,gstin,state_code FROM gstins WHERE company_id=? ORDER BY id').all(row.id).filter(x => req.scopes.gstinIds.includes(x.id)).map(fields) : [],
      branches: row.id === req.company.id ? db.prepare('SELECT id,name,gstin_id FROM branches WHERE company_id=? ORDER BY id').all(row.id).filter(x => req.scopes.branchIds.includes(x.id)).map(fields) : [] }));
    return { demoMode: !auth, companies, users: db.prepare(auth ? 'SELECT id,company_id,name,role FROM users WHERE id=?' : 'SELECT id,company_id,name,role FROM users ORDER BY id').all(...(auth ? [req.user.id] : [])).map(fields), currentCompanyId: req.company.id, currentUserId: req.user.id };
  }));

  app.get('/api/items', route(req => { masterAccess(req); return { items: db.prepare('SELECT id,company_id,sku,name,hsn,unit,gst_rate_bps,reorder_level,track_stock,active FROM items WHERE company_id=? ORDER BY name').all(req.company.id).map(fields) }; }));
  app.post('/api/items', route(req => {
    masterAccess(req);
    const body = req.body || {};
    const sku = text(body.sku, 'sku', 50), name = text(body.name, 'name');
    const hsn = text(body.hsn ?? '', 'hsn', 12, false), unit = text(body.unit ?? 'pcs', 'unit', 20);
    const gstRateBps = integer(body.gstRateBps ?? 1800, 'gstRateBps');
    if (gstRateBps > 10000) throw bad('gstRateBps must be at most 10000');
    const reorderLevel = integer(body.reorderLevel ?? 0, 'reorderLevel');
    const trackStock = body.trackStock === false ? 0 : 1;
    const id = Number(db.prepare('INSERT INTO items(company_id,sku,name,hsn,unit,gst_rate_bps,reorder_level,track_stock) VALUES (?,?,?,?,?,?,?,?)').run(req.company.id, sku, name, hsn, unit, gstRateBps, reorderLevel, trackStock).lastInsertRowid);
    return { item: fields(requireRow(db, 'items', id, req.company.id)) };
  }));
  app.put('/api/items/:id', route(req => {
    masterAccess(req);
    const id = integer(Number(req.params.id), 'id', 1), old = requireRow(db, 'items', id, req.company.id), body = req.body || {};
    const next = { sku: text(body.sku ?? old.sku, 'sku', 50), name: text(body.name ?? old.name, 'name'), hsn: text(body.hsn ?? old.hsn, 'hsn', 12, false), unit: text(body.unit ?? old.unit, 'unit', 20), gstRateBps: integer(body.gstRateBps ?? old.gst_rate_bps, 'gstRateBps'), reorderLevel: integer(body.reorderLevel ?? old.reorder_level, 'reorderLevel'), trackStock: body.trackStock === undefined ? old.track_stock : body.trackStock === false ? 0 : 1 };
    if (next.gstRateBps > 10000) throw bad('gstRateBps must be at most 10000');
    if (next.trackStock !== old.track_stock) {
      const history = db.prepare(`SELECT 1 FROM stock_movements WHERE item_id=? UNION ALL
        SELECT 1 FROM order_lines WHERE item_id=? UNION ALL
        SELECT 1 FROM invoice_lines WHERE item_id=? LIMIT 1`).get(id,id,id);
      if (history) throw bad('Stock tracking cannot change after item transaction history exists',409);
    }
    db.prepare('UPDATE items SET sku=?,name=?,hsn=?,unit=?,gst_rate_bps=?,reorder_level=?,track_stock=? WHERE id=?').run(next.sku,next.name,next.hsn,next.unit,next.gstRateBps,next.reorderLevel,next.trackStock,id);
    return { item: fields(requireRow(db, 'items', id, req.company.id)) };
  }));

  app.get('/api/parties', route(req => { masterAccess(req); return { parties: db.prepare('SELECT * FROM parties WHERE company_id=? ORDER BY name').all(req.company.id).map(fields) }; }));
  app.post('/api/parties', route(req => {
    masterAccess(req);
    const body = req.body || {}, type = body.type ?? 'customer';
    if (!['customer','supplier','both'].includes(type)) throw bad('Invalid party type');
    const values = [text(body.name,'name'),type,text(body.gstin ?? '','gstin',15,false),text(body.stateCode ?? '','stateCode',2,false),text(body.address ?? '','address',500,false),text(body.phone ?? '','phone',30,false)];
    const id = Number(db.prepare('INSERT INTO parties(company_id,name,type,gstin,state_code,address,phone) VALUES (?,?,?,?,?,?,?)').run(req.company.id,...values).lastInsertRowid);
    return { party: fields(requireRow(db, 'parties', id, req.company.id)) };
  }));
  app.put('/api/parties/:id', route(req => {
    masterAccess(req);
    const id = integer(Number(req.params.id),'id',1), old = requireRow(db,'parties',id,req.company.id), body = req.body || {};
    const type = body.type ?? old.type;
    if (!['customer','supplier','both'].includes(type)) throw bad('Invalid party type');
    const values = [text(body.name ?? old.name,'name'),type,text(body.gstin ?? old.gstin,'gstin',15,false),text(body.stateCode ?? old.state_code,'stateCode',2,false),text(body.address ?? old.address,'address',500,false),text(body.phone ?? old.phone,'phone',30,false),id];
    db.prepare('UPDATE parties SET name=?,type=?,gstin=?,state_code=?,address=?,phone=? WHERE id=?').run(...values);
    return { party: fields(requireRow(db,'parties',id,req.company.id)) };
  }));

  const stockRows = (companyId, branchId) => db.prepare(`SELECT i.id AS item_id,i.name AS item_name,i.sku,i.reorder_level,b.id AS branch_id,b.name AS branch_name,COALESCE(SUM(m.quantity_delta),0) AS quantity FROM items i JOIN branches b ON b.company_id=i.company_id LEFT JOIN stock_movements m ON m.item_id=i.id AND m.branch_id=b.id WHERE i.company_id=? AND (? IS NULL OR b.id=?) GROUP BY i.id,b.id ORDER BY b.name,i.name`).all(companyId, branchId, branchId).map(fields);
  app.get('/api/stock', route(req => {
    const branchId = req.query.branchId ? integer(Number(req.query.branchId),'branchId',1) : null;
    if (branchId) scope(req,undefined,branchId);
    return { stock: stockRows(req.company.id, branchId).filter(row => req.scopes.branchIds.includes(row.branchId)) };
  }));
  app.post('/api/stock/movements', route(req => transaction(db, () => {
    const body = req.body || {}, itemId = integer(body.itemId,'itemId',1), branchId = integer(body.branchId,'branchId',1);
    const item = requireRow(db,'items',itemId,req.company.id); scope(req,undefined,branchId);
    if (!item.track_stock) throw bad('Service items do not use stock movements');
    const type = body.type, quantity = integer(Math.abs(body.quantity),'quantity',1);
    if (!['receipt','issue','adjustment'].includes(type) || !Number.isSafeInteger(body.quantity)) throw bad('Invalid movement type or quantity');
    const delta = type === 'issue' ? -quantity : type === 'receipt' ? quantity : body.quantity;
    const reason = text(body.reason,'reason',500);
    const clientReference = body.clientReference === undefined || body.clientReference === '' ? null : text(body.clientReference,'clientReference',100);
    if (delta < 0) {
      const allocation = allocateBatchIssue(db,{companyId:req.company.id,branchId,itemId,quantity:-delta,reason,
        sourceReference:`manual:${clientReference || crypto.randomUUID()}`,userId:req.user.id,movementType:type});
      const movement = db.prepare('SELECT * FROM stock_movements WHERE id=?').get(allocation.firstStockMovementId);
      const quantityNow = db.prepare('SELECT COALESCE(SUM(quantity_delta),0) AS quantity FROM stock_movements WHERE item_id=? AND branch_id=?').get(itemId,branchId).quantity;
      return { movement:fields(movement),quantity:quantityNow,replayed:allocation.replayed,batchAllocation:allocation };
    }
    if (clientReference) {
      const existing = db.prepare('SELECT * FROM stock_movements WHERE company_id=? AND client_reference=?').get(req.company.id,clientReference);
      if (existing) {
        if (existing.item_id !== itemId || existing.branch_id !== branchId || existing.quantity_delta !== delta || existing.type !== type || existing.reason !== reason) throw bad('Client reference already used for a different movement',409);
        const quantityNow = db.prepare('SELECT COALESCE(SUM(quantity_delta),0) AS quantity FROM stock_movements WHERE item_id=? AND branch_id=?').get(itemId,branchId).quantity;
        return { movement:fields(existing),quantity:quantityNow,replayed:true };
      }
    }
    const current = db.prepare('SELECT COALESCE(SUM(quantity_delta),0) AS quantity FROM stock_movements WHERE item_id=? AND branch_id=?').get(itemId,branchId).quantity;
    if (current + delta < 0) throw bad('Insufficient stock',409);
    const id = Number(db.prepare('INSERT INTO stock_movements(company_id,branch_id,item_id,quantity_delta,type,reason,client_reference) VALUES (?,?,?,?,?,?,?)').run(req.company.id,branchId,itemId,delta,type,reason,clientReference).lastInsertRowid);
    return { movement: fields(db.prepare('SELECT * FROM stock_movements WHERE id=?').get(id)), quantity: current + delta };
  })));

  const invoiceSql = `SELECT v.*,COALESCE(NULLIF(v.party_name_snapshot,''),p.name) AS party_name,b.name AS branch_name,g.gstin FROM invoices v JOIN parties p ON p.id=v.party_id JOIN branches b ON b.id=v.branch_id JOIN gstins g ON g.id=v.gstin_id`;
  const invoiceDetail = (id, companyId, req) => {
    const row = db.prepare(`${invoiceSql} WHERE v.id=? AND v.company_id=?`).get(id,companyId);
    if (!row) throw bad('Invoice not found in selected company',404);
    if (req) scope(req,row.gstin_id,row.branch_id);
    return { ...fields(row), lines: db.prepare('SELECT l.*,l.item_name_snapshot AS item_name,l.item_sku_snapshot AS sku FROM invoice_lines l WHERE l.invoice_id=? ORDER BY l.id').all(id).map(fields) };
  };
  app.get('/api/invoices', route(req => {
    if (req.query.branchId) scope(req,undefined,integer(Number(req.query.branchId),'branchId',1));
    if (req.query.gstinId) scope(req,integer(Number(req.query.gstinId),'gstinId',1));
    const rows = db.prepare(`${invoiceSql} WHERE v.company_id=? AND (? IS NULL OR v.branch_id=?) AND (? IS NULL OR v.gstin_id=?) ORDER BY v.id DESC`).all(req.company.id, req.query.branchId ? Number(req.query.branchId) : null, req.query.branchId ? Number(req.query.branchId) : null, req.query.gstinId ? Number(req.query.gstinId) : null, req.query.gstinId ? Number(req.query.gstinId) : null);
    return { invoices: scopedRows(req,rows).map(fields) };
  }));
  app.get('/api/invoices/:id', route(req => ({ invoice: invoiceDetail(integer(Number(req.params.id),'id',1),req.company.id,req) })));
  const fulfillmentSource = (fulfillmentId, companyId) => {
    const source = db.prepare(`SELECT f.id,f.status,f.kind,f.order_id,o.company_id,o.type,o.status AS order_status,o.party_id,o.branch_id,o.gstin_id
      FROM order_fulfillments f JOIN orders o ON o.id=f.order_id WHERE f.id=? AND f.company_id=? AND o.company_id=?`).get(fulfillmentId,companyId,companyId);
    if (!source) throw bad('Fulfillment not found in selected company',404);
    if (source.status !== 'confirmed' || source.order_status !== 'confirmed') throw bad('Only confirmed order fulfillments can be invoiced',409);
    const lines = db.prepare(`SELECT fl.id,fl.quantity,fl.stock_movement_id,ol.item_id,ol.unit_price_cents,ol.gst_rate_bps,i.track_stock
      FROM order_fulfillment_lines fl JOIN order_lines ol ON ol.id=fl.order_line_id JOIN items i ON i.id=ol.item_id WHERE fl.fulfillment_id=? ORDER BY fl.id`).all(fulfillmentId);
    if (!lines.length || lines.some(line => line.track_stock && !line.stock_movement_id)) throw bad('Fulfillment stock posting is incomplete',409);
    return { ...source, lines };
  };
  app.post('/api/invoices', route(req => transaction(db, () => {
    const body = req.body || {}, companyId = req.company.id;
    if (!['sale','purchase'].includes(body.type)) throw bad('type must be sale or purchase');
    const party = requireRow(db,'parties',integer(body.partyId,'partyId',1),companyId);
    if (body.type === 'sale' && party.type === 'supplier' || body.type === 'purchase' && party.type === 'customer') throw bad('Party type does not match invoice type');
    const branch = requireRow(db,'branches',integer(body.branchId,'branchId',1),companyId);
    const gstin = db.prepare('SELECT * FROM gstins WHERE id=? AND company_id=?').get(integer(body.gstinId,'gstinId',1),companyId);
    if (!gstin || branch.gstin_id !== gstin.id) throw bad('GSTIN must belong to the selected branch');
    scope(req,gstin.id,branch.id);
    const invoiceDate = date(body.invoiceDate);
    if (!Array.isArray(body.lines) || body.lines.length === 0 || body.lines.length > 100) throw bad('Invoice requires 1 to 100 lines');
    let subtotal = 0, tax = 0;
    const lines = body.lines.map(line => {
      if (!line || typeof line !== 'object' || Array.isArray(line)) throw bad('Each invoice line must be an object');
      const item = requireRow(db,'items',integer(line.itemId,'itemId',1),companyId);
      const quantity = integer(line.quantity,'quantity',1), price = integer(line.unitPriceCents,'unitPriceCents');
      const rate = integer(line.gstRateBps ?? item.gst_rate_bps,'gstRateBps');
      if (req.company.tax_regime === 'composition' && rate !== 0) throw bad('Composition demo company cannot collect ordinary GST or claim purchase ITC');
      if (rate > 10000) throw bad('gstRateBps must be at most 10000');
      const lineSubtotal = quantity * price, lineTax = Math.round(lineSubtotal * rate / 10000);
      if (!Number.isSafeInteger(lineSubtotal) || !Number.isSafeInteger(lineTax)) throw bad('Invoice amount too large');
      subtotal += lineSubtotal; tax += lineTax;
      return { itemId:item.id, quantity, price, rate, subtotal:lineSubtotal, tax:lineTax };
    });
    if (!Number.isSafeInteger(subtotal + tax)) throw bad('Invoice amount too large');
    const fulfillmentId = body.fulfillmentId === undefined || body.fulfillmentId === null ? null : integer(body.fulfillmentId,'fulfillmentId',1);
    if (fulfillmentId) {
      const source = fulfillmentSource(fulfillmentId,companyId);
      if (source.type !== body.type || source.kind !== (body.type === 'sale' ? 'dispatch' : 'receipt') || source.party_id !== party.id || source.branch_id !== branch.id || source.gstin_id !== gstin.id) throw bad('Fulfillment type, party, branch, or GSTIN does not match invoice',409);
      if (db.prepare('SELECT 1 FROM invoices WHERE fulfillment_id=?').get(fulfillmentId)) throw bad('Fulfillment is already linked to an invoice',409);
      if (source.lines.length !== lines.length || new Set(lines.map(line => line.itemId)).size !== lines.length) throw bad('Invoice lines must exactly match fulfillment lines',409);
      for (const line of lines) {
        const linked = source.lines.find(entry => entry.item_id === line.itemId);
        if (!linked || linked.quantity !== line.quantity || linked.unit_price_cents !== line.price || linked.gst_rate_bps !== line.rate) throw bad('Invoice lines must exactly match fulfillment lines',409);
        line.fulfillmentLineId = linked.id;
      }
    }
    const notes = text(body.notes ?? '','notes',1000,false);
    const supplierInvoiceNumber = text(body.supplierInvoiceNumber ?? '', 'supplierInvoiceNumber', 80, false);
    const id = Number(db.prepare('INSERT INTO invoices(company_id,branch_id,gstin_id,party_id,fulfillment_id,number,supplier_invoice_number,supplier_gstin_snapshot,party_name_snapshot,type,status,invoice_date,notes,subtotal_cents,tax_cents,total_cents,created_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(companyId,branch.id,gstin.id,party.id,fulfillmentId,`TEMP-${crypto.randomUUID()}`,supplierInvoiceNumber,party.gstin,party.name,body.type,'draft',invoiceDate,notes,subtotal,tax,subtotal+tax,req.user.id).lastInsertRowid);
    db.prepare('UPDATE invoices SET number=? WHERE id=?').run(`${body.type === 'sale' ? 'SAL' : 'PUR'}-${String(companyId).padStart(2,'0')}-${String(id).padStart(5,'0')}`,id);
    for (const line of lines) db.prepare('INSERT INTO invoice_lines(invoice_id,item_id,fulfillment_line_id,quantity,unit_price_cents,gst_rate_bps,subtotal_cents,tax_cents,total_cents) VALUES (?,?,?,?,?,?,?,?,?)').run(id,line.itemId,line.fulfillmentLineId || null,line.quantity,line.price,line.rate,line.subtotal,line.tax,line.subtotal+line.tax);
    return { invoice: invoiceDetail(id,companyId,req) };
  })));
  app.post('/api/invoices/:id/submit', route(req => transaction(db, () => {
    const id = integer(Number(req.params.id),'id',1), invoice = invoiceRow(req,id);
    if (invoice.status !== 'draft') throw bad('Only draft invoices can be submitted',409);
    const creditScope={companyId:req.company.id,gstinId:invoice.gstin_id,branchId:invoice.branch_id,partyId:invoice.party_id};
    const before=invoice.type==='sale' ? holdBaseline(db,creditScope) : null;
    db.prepare("UPDATE invoices SET status='submitted',submitted_by=? WHERE id=?").run(req.user.id,id);
    assertCreditHold(db,creditScope,before);
    return { invoice: invoiceDetail(id,req.company.id,req) };
  })));
  app.post('/api/invoices/:id/approve', route(req => transaction(db, () => {
    accountant(req);
    const id = integer(Number(req.params.id),'id',1), invoice = invoiceRow(req,id);
    if (invoice.status !== 'submitted') throw bad('Only submitted invoices can be approved',409);
    if (invoice.created_by === req.user.id || invoice.submitted_by === req.user.id) throw bad('Invoice creator or submitter cannot approve the same invoice',403);
    assertInvoiceTaxReady(db,{ companyId:req.company.id, invoiceId:id });
    const party = db.prepare('SELECT name,gstin FROM parties WHERE id=?').get(invoice.party_id);
    if (invoice.type === 'purchase' && supplierKey(invoice.supplier_invoice_number)) {
      const reference = supplierKey(invoice.supplier_invoice_number);
      const supplierGstin = supplierKey(invoice.supplier_gstin_snapshot || party.gstin);
      const approvedBills = db.prepare(`SELECT v.party_id,v.supplier_invoice_number,v.supplier_gstin_snapshot,p.gstin AS party_gstin
        FROM invoices v JOIN parties p ON p.id=v.party_id
        WHERE v.company_id=? AND v.gstin_id=? AND v.type='purchase' AND v.status='approved' AND v.id<>?`)
        .all(req.company.id,invoice.gstin_id,id);
      const duplicate = approvedBills.some((bill) => supplierKey(bill.supplier_invoice_number) === reference &&
        (supplierGstin ? supplierKey(bill.supplier_gstin_snapshot || bill.party_gstin) === supplierGstin : bill.party_id === invoice.party_id));
      if (duplicate) throw bad('Duplicate approved supplier invoice reference',409);
    }
    const period = invoice.invoice_date.slice(0,7);
    db.prepare("INSERT OR IGNORE INTO gst_periods(company_id,gstin_id,period,status) VALUES (?,?,?,'open')").run(req.company.id,invoice.gstin_id,period);
    const gstPeriod = db.prepare('SELECT * FROM gst_periods WHERE gstin_id=? AND period=?').get(invoice.gstin_id,period);
    if (gstPeriod.status !== 'open') throw bad('GST period has been reviewed or approved',409);
    if (invoice.fulfillment_id) {
      const source = fulfillmentSource(invoice.fulfillment_id,req.company.id);
      if (source.type !== invoice.type || source.party_id !== invoice.party_id || source.branch_id !== invoice.branch_id || source.gstin_id !== invoice.gstin_id) throw bad('Linked fulfillment no longer matches invoice scope',409);
      const invoiceLines = db.prepare('SELECT * FROM invoice_lines WHERE invoice_id=?').all(id);
      if (invoiceLines.length !== source.lines.length || invoiceLines.some(line => {
        const linked = source.lines.find(entry => entry.id === line.fulfillment_line_id);
        return !linked || linked.item_id !== line.item_id || linked.quantity !== line.quantity || linked.unit_price_cents !== line.unit_price_cents || linked.gst_rate_bps !== line.gst_rate_bps;
      })) throw bad('Linked invoice lines no longer match fulfillment',409);
    }
    const lines = db.prepare('SELECT l.item_id,SUM(l.quantity) AS quantity,i.track_stock FROM invoice_lines l JOIN items i ON i.id=l.item_id WHERE l.invoice_id=? GROUP BY l.item_id').all(id);
    for (const line of lines) {
      if (invoice.fulfillment_id) continue;
      if (!line.track_stock) continue;
      const delta = invoice.type === 'sale' ? -line.quantity : line.quantity;
      if (invoice.type === 'sale') {
        allocateBatchIssue(db,{companyId:req.company.id,branchId:invoice.branch_id,itemId:line.item_id,quantity:line.quantity,
          reason:invoice.number,sourceReference:`invoice:${id}:item:${line.item_id}`,userId:req.user.id,invoiceId:id,movementType:'sale'});
        continue;
      }
      const current = db.prepare('SELECT COALESCE(SUM(quantity_delta),0) AS quantity FROM stock_movements WHERE item_id=? AND branch_id=?').get(line.item_id,invoice.branch_id).quantity;
      if (current + delta < 0) throw bad('Insufficient stock for invoice approval',409);
      db.prepare('INSERT INTO stock_movements(company_id,branch_id,item_id,quantity_delta,type,reason,invoice_id) VALUES (?,?,?,?,?,?,?)').run(req.company.id,invoice.branch_id,line.item_id,delta,invoice.type,invoice.number,id);
    }
    db.prepare("UPDATE invoices SET status='approved',approved_by=?,party_name_snapshot=COALESCE(NULLIF(party_name_snapshot,''),?),supplier_gstin_snapshot=COALESCE(NULLIF(supplier_gstin_snapshot,''),?) WHERE id=?").run(req.user.id,party.name,party.gstin,id);
    if (invoice.type === 'purchase') db.prepare('INSERT INTO purchase_evidence(invoice_id,company_id) VALUES (?,?)').run(id,req.company.id);
    postInvoice(db,id);
    return { invoice: invoiceDetail(id,req.company.id,req) };
  })));

  const evidenceDetail = (invoice) => {
    const evidence = db.prepare('SELECT * FROM purchase_evidence WHERE invoice_id=? AND company_id=?').get(invoice.id,invoice.company_id);
    const fixture = evidence?.fixture_id ? db.prepare('SELECT * FROM purchase_fixtures WHERE id=? AND company_id=?').get(evidence.fixture_id,invoice.company_id) : null;
    const party = db.prepare('SELECT name,gstin FROM parties WHERE id=?').get(invoice.party_id);
    const gstin = db.prepare('SELECT gstin FROM gstins WHERE id=?').get(invoice.gstin_id).gstin;
    const supplierGstin = invoice.supplier_gstin_snapshot || party.gstin;
    const candidate = supplierGstin && invoice.supplier_invoice_number ? db.prepare('SELECT * FROM purchase_fixtures WHERE company_id=? AND gstin_id=? AND supplier_gstin=? AND invoice_number=?').get(invoice.company_id,invoice.gstin_id,supplierGstin,invoice.supplier_invoice_number) : null;
    const source = row => row ? { fixtureId:row.id,sourceName:row.source_name,sourcePeriod:row.source_period,importedAt:row.imported_at,invoiceNumber:row.invoice_number,supplierGstin:row.supplier_gstin,taxableCents:row.taxable_cents,taxCents:row.tax_cents } : null;
    return { invoiceId:invoice.id,number:invoice.number,supplierInvoiceNumber:invoice.supplier_invoice_number,invoiceDate:invoice.invoice_date,period:invoice.invoice_date.slice(0,7),claimPeriod:evidence?.claim_period || null,gstinId:invoice.gstin_id,gstin,partyName:invoice.party_name_snapshot || party.name,supplierGstin,subtotalCents:invoice.subtotal_cents,taxCents:invoice.tax_cents,totalCents:invoice.total_cents,matchStatus:evidence?.match_status || 'unmatched',eligibilityStatus:evidence?.eligibility_status || 'pending',reviewReason:evidence?.review_reason || '',source:source(fixture),candidateSource:source(candidate),matchedBy:evidence?.matched_by || null,reviewedBy:evidence?.reviewed_by || null,events:db.prepare('SELECT id,action,details,actor_id,created_at FROM purchase_evidence_events WHERE invoice_id=? ORDER BY id').all(invoice.id).map(fields) };
  };
  const purchaseInvoice = (req) => {
    const invoice = invoiceRow(req,integer(Number(req.params.invoiceId),'invoiceId',1));
    if (invoice.type !== 'purchase' || invoice.status !== 'approved') throw bad('Approved purchase invoice required',409);
    return invoice;
  };
  const closedClaimPeriod = (companyId,gstinId,period) => period && db.prepare('SELECT status FROM gst_periods WHERE company_id=? AND gstin_id=? AND period=?').get(companyId,gstinId,period)?.status !== 'open';
  app.get('/api/gst/purchase-evidence', route(req => {
    const gstinId = req.query.gstinId ? integer(Number(req.query.gstinId),'gstinId',1) : null;
    const period = req.query.period ? text(req.query.period,'period',7) : null;
    if (period && !/^\d{4}-\d{2}$/.test(period)) throw bad('period must be YYYY-MM');
    if (gstinId && !db.prepare('SELECT 1 FROM gstins WHERE id=? AND company_id=?').get(gstinId,req.company.id)) throw bad('GSTIN not found in selected company',404);
    if (gstinId) scope(req,gstinId);
    const invoices = db.prepare("SELECT v.* FROM invoices v LEFT JOIN purchase_evidence e ON e.invoice_id=v.id WHERE v.company_id=? AND v.type='purchase' AND v.status='approved' AND (? IS NULL OR v.gstin_id=?) AND (? IS NULL OR substr(v.invoice_date,1,7)=? OR e.claim_period=? OR EXISTS (SELECT 1 FROM purchase_fixtures f WHERE f.company_id=v.company_id AND f.gstin_id=v.gstin_id AND f.supplier_gstin=v.supplier_gstin_snapshot AND f.invoice_number=v.supplier_invoice_number AND f.source_period=?)) ORDER BY v.invoice_date DESC,v.id DESC").all(req.company.id,gstinId,gstinId,period,period,period,period);
    return { evidence: scopedRows(req,invoices).map(evidenceDetail) };
  }));
  app.post('/api/gst/purchase-evidence/:invoiceId/match', route(req => transaction(db, () => {
    accountant(req);
    const invoice = purchaseInvoice(req);
    db.prepare('INSERT OR IGNORE INTO purchase_evidence(invoice_id,company_id) VALUES (?,?)').run(invoice.id,req.company.id);
    const fixture = invoice.supplier_gstin_snapshot && invoice.supplier_invoice_number ? db.prepare('SELECT * FROM purchase_fixtures WHERE company_id=? AND gstin_id=? AND supplier_gstin=? AND invoice_number=?').get(req.company.id,invoice.gstin_id,invoice.supplier_gstin_snapshot,invoice.supplier_invoice_number) : null;
    const status = !fixture ? 'unmatched' : fixture.taxable_cents === invoice.subtotal_cents && fixture.tax_cents === invoice.tax_cents ? 'matched' : 'mismatch';
    const old = db.prepare('SELECT * FROM purchase_evidence WHERE invoice_id=?').get(invoice.id);
    if (old.match_status !== status || old.fixture_id !== (fixture?.id || null)) {
      if (closedClaimPeriod(req.company.id,invoice.gstin_id,old.claim_period)) throw bad('Prior claim period is reviewed or approved',409);
      const sourcePeriod = fixture && db.prepare('SELECT status FROM gst_periods WHERE company_id=? AND gstin_id=? AND period=?').get(req.company.id,invoice.gstin_id,fixture.source_period);
      const invoicePeriod = db.prepare('SELECT status FROM gst_periods WHERE company_id=? AND gstin_id=? AND period=?').get(req.company.id,invoice.gstin_id,invoice.invoice_date.slice(0,7));
      if (invoicePeriod?.status !== 'open' && (sourcePeriod?.status !== 'open' || old.eligibility_status !== 'pending')) throw bad('Historical invoice period is closed; a new open source period and pending review are required',409);
      db.prepare("UPDATE purchase_evidence SET fixture_id=?,match_status=?,eligibility_status='pending',claim_period=NULL,review_reason='',reviewed_by=NULL,reviewed_at=NULL,matched_by=?,matched_at=CURRENT_TIMESTAMP WHERE invoice_id=?").run(fixture?.id || null,status,req.user.id,invoice.id);
      db.prepare('INSERT INTO purchase_evidence_events(invoice_id,action,details,actor_id) VALUES (?,?,?,?)').run(invoice.id,'match',`Local statement match: ${status}`,req.user.id);
    }
    return { evidence:evidenceDetail(invoice) };
  })));
  app.post('/api/gst/purchase-evidence/:invoiceId/eligibility', route(req => transaction(db, () => {
    accountant(req);
    const invoice = purchaseInvoice(req);
    const decision = req.body?.decision;
    if (!['eligible','blocked'].includes(decision)) throw bad('decision must be eligible or blocked');
    const reason = text(req.body?.reason,'reason',1000);
    db.prepare('INSERT OR IGNORE INTO purchase_evidence(invoice_id,company_id) VALUES (?,?)').run(invoice.id,req.company.id);
    const old = db.prepare('SELECT * FROM purchase_evidence WHERE invoice_id=?').get(invoice.id);
    if (decision === 'eligible' && old.match_status !== 'matched') throw bad('Only matched purchase evidence can be marked eligible',409);
    const fixture = old.fixture_id ? db.prepare('SELECT * FROM purchase_fixtures WHERE id=?').get(old.fixture_id) : null;
    const invoicePeriod = db.prepare('SELECT status FROM gst_periods WHERE company_id=? AND gstin_id=? AND period=?').get(req.company.id,invoice.gstin_id,invoice.invoice_date.slice(0,7));
    if (invoicePeriod?.status !== 'open' && old.eligibility_status !== 'pending') throw bad('Historical eligibility decision is locked with its invoice period',409);
    if (decision === 'eligible' && db.prepare("SELECT 1 FROM purchase_evidence WHERE fixture_id=? AND eligibility_status='eligible' AND invoice_id<>?").get(old.fixture_id,invoice.id)) throw bad('Imported fixture already has an eligible claim',409);
    const claimPeriod = decision === 'eligible' ? fixture.source_period : null;
    const changed = old.eligibility_status !== decision || old.review_reason !== reason || old.claim_period !== claimPeriod;
    if (changed && closedClaimPeriod(req.company.id,invoice.gstin_id,old.claim_period)) throw bad('Prior claim period is reviewed or approved',409);
    if (claimPeriod) {
      db.prepare("INSERT OR IGNORE INTO gst_periods(company_id,gstin_id,period,status) VALUES (?,?,?,'open')").run(req.company.id,invoice.gstin_id,claimPeriod);
      const target = db.prepare('SELECT status FROM gst_periods WHERE gstin_id=? AND period=?').get(invoice.gstin_id,claimPeriod);
      if (target.status !== 'open') throw bad('Claim period is reviewed or approved',409);
    }
    if (decision === 'blocked' && invoicePeriod?.status !== 'open') {
      const sourceStatus = fixture && db.prepare('SELECT status FROM gst_periods WHERE company_id=? AND gstin_id=? AND period=?').get(req.company.id,invoice.gstin_id,fixture.source_period);
      if (sourceStatus?.status !== 'open') throw bad('Historical invoice period is closed; block review requires an open source period',409);
    }
    if (changed) {
      db.prepare('UPDATE purchase_evidence SET eligibility_status=?,claim_period=?,review_reason=?,reviewed_by=?,reviewed_at=CURRENT_TIMESTAMP WHERE invoice_id=?').run(decision,claimPeriod,reason,req.user.id,invoice.id);
      db.prepare('INSERT INTO purchase_evidence_events(invoice_id,action,details,actor_id) VALUES (?,?,?,?)').run(invoice.id,'eligibility',`${decision}: ${reason}`,req.user.id);
    }
    return { evidence:evidenceDetail(invoice) };
  })));

  const gstSummary = (companyId, gstinId, period, branchIds) => {
    if (!branchIds.length) return { salesTaxableCents:0,salesTaxCents:0,purchaseTaxableCents:0,purchaseTaxCents:0,eligibleItcCents:0,localEstimateCents:0,payableEstimateCents:0,surplusReviewedCreditCents:0,indicativeDifferenceCents:0 };
    const branchSql = branchIds.map(() => '?').join(',');
    const rows = db.prepare(`SELECT type,COALESCE(SUM(subtotal_cents),0) AS taxable,COALESCE(SUM(tax_cents),0) AS tax FROM invoices WHERE company_id=? AND gstin_id=? AND branch_id IN (${branchSql}) AND status='approved' AND substr(invoice_date,1,7)=? GROUP BY type`).all(companyId,gstinId,...branchIds,period);
    const sales = rows.find(x => x.type === 'sale') || { taxable:0,tax:0 }, purchases = rows.find(x => x.type === 'purchase') || { taxable:0,tax:0 };
    const eligibleItcCents = db.prepare(`SELECT COALESCE(SUM(v.tax_cents),0) AS total FROM invoices v JOIN purchase_evidence e ON e.invoice_id=v.id WHERE v.company_id=? AND v.gstin_id=? AND v.branch_id IN (${branchSql}) AND v.status='approved' AND v.type='purchase' AND e.claim_period=? AND e.match_status='matched' AND e.eligibility_status='eligible'`).get(companyId,gstinId,...branchIds,period).total;
    const localEstimateCents = sales.tax - eligibleItcCents;
    return { salesTaxableCents:sales.taxable,salesTaxCents:sales.tax,purchaseTaxableCents:purchases.taxable,purchaseTaxCents:purchases.tax,eligibleItcCents,localEstimateCents,payableEstimateCents:Math.max(0,localEstimateCents),surplusReviewedCreditCents:Math.max(0,-localEstimateCents),indicativeDifferenceCents:localEstimateCents };
  };
  const periodDetail = (req, row, includeTransactions = false) => {
    const branchIds = req.scopes.branchIds.filter(id => db.prepare('SELECT 1 FROM branches WHERE id=? AND company_id=? AND gstin_id=?').get(id,row.company_id,row.gstin_id));
    const result = { ...fields(row), ...gstSummary(row.company_id,row.gstin_id,row.period,branchIds) };
    if (includeTransactions) result.transactions = scopedRows(req,db.prepare(`${invoiceSql} WHERE v.company_id=? AND v.gstin_id=? AND v.status='approved' AND substr(v.invoice_date,1,7)=? ORDER BY v.invoice_date,v.id`).all(row.company_id,row.gstin_id,row.period)).map(fields);
    return result;
  };
  app.get('/api/gst/periods', route(req => {
    const gstinId = req.query.gstinId ? integer(Number(req.query.gstinId),'gstinId',1) : null;
    if (gstinId) fullGstinScope(req,gstinId);
    return { periods: db.prepare('SELECT p.*,g.gstin FROM gst_periods p JOIN gstins g ON g.id=p.gstin_id WHERE p.company_id=? AND (? IS NULL OR p.gstin_id=?) ORDER BY p.period DESC,p.gstin_id').all(req.company.id,gstinId,gstinId)
      .filter(row => req.scopes.gstinIds.includes(row.gstin_id) && db.prepare('SELECT id FROM branches WHERE company_id=? AND gstin_id=?').all(req.company.id,row.gstin_id)
        .every(branch => req.scopes.branchIds.includes(branch.id))).map(row => periodDetail(req,row)) };
  }));
  app.get('/api/gst/periods/:id', route(req => {
    const row = periodRow(req,integer(Number(req.params.id),'id',1));
    const gstin = db.prepare('SELECT gstin FROM gstins WHERE id=?').get(row.gstin_id).gstin;
    return { period: periodDetail(req,{ ...row,gstin },true) };
  }));
  app.post('/api/gst/periods/:id/review', route(req => {
    accountant(req);
    const row = periodRow(req,integer(Number(req.params.id),'id',1));
    if (row.status !== 'open') throw bad('Only open periods can be reviewed',409);
    const pending = db.prepare(`SELECT COUNT(*) AS total FROM invoices v LEFT JOIN purchase_evidence e ON e.invoice_id=v.id
      WHERE v.company_id=? AND v.gstin_id=? AND v.type='purchase' AND v.status='approved'
      AND (substr(v.invoice_date,1,7)=? OR e.claim_period=? OR EXISTS (
        SELECT 1 FROM purchase_fixtures f WHERE f.company_id=v.company_id AND f.gstin_id=v.gstin_id
        AND f.supplier_gstin=v.supplier_gstin_snapshot AND f.invoice_number=v.supplier_invoice_number AND f.source_period=?))
      AND COALESCE(e.eligibility_status,'pending')='pending'`).get(req.company.id,row.gstin_id,row.period,row.period,row.period).total;
    if (pending) throw bad(`${pending} purchase evidence record(s) still need an eligibility decision`,409);
    const submitted = db.prepare("SELECT COUNT(*) AS total FROM invoices WHERE company_id=? AND gstin_id=? AND status='submitted' AND substr(invoice_date,1,7)=?").get(req.company.id,row.gstin_id,row.period).total;
    if (submitted) throw bad(`${submitted} submitted invoice(s) still need approval or correction`,409);
    const notes = text(req.body?.notes ?? '', 'notes', 1000, false);
    db.prepare("UPDATE gst_periods SET status='reviewed',review_notes=?,reviewed_by=? WHERE id=?").run(notes,req.user.id,row.id);
    return { period: periodDetail(req,{ ...db.prepare('SELECT * FROM gst_periods WHERE id=?').get(row.id),gstin:db.prepare('SELECT gstin FROM gstins WHERE id=?').get(row.gstin_id).gstin },true) };
  }));
  app.post('/api/gst/periods/:id/approve', route(req => {
    accountant(req);
    const row = periodRow(req,integer(Number(req.params.id),'id',1));
    if (row.status !== 'reviewed') throw bad('Only reviewed periods can be approved',409);
    if (row.reviewed_by === req.user.id) throw bad('GST period reviewer cannot approve the same period',403);
    db.prepare("UPDATE gst_periods SET status='approved',approved_by=? WHERE id=?").run(req.user.id,row.id);
    return { period: periodDetail(req,{ ...db.prepare('SELECT * FROM gst_periods WHERE id=?').get(row.id),gstin:db.prepare('SELECT gstin FROM gstins WHERE id=?').get(row.gstin_id).gstin },true) };
  }));

  app.get('/api/dashboard', route(req => {
    const companyId = req.company.id, branchId = req.query.branchId ? integer(Number(req.query.branchId),'branchId',1) : null,
      gstinId = req.query.gstinId ? integer(Number(req.query.gstinId),'gstinId',1) : null;
    if (branchId) scope(req,undefined,branchId);
    if (gstinId) scope(req,gstinId);
    const count = table => db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE company_id=?`).get(companyId).n;
    const invoices = scopedRows(req,db.prepare(`SELECT status,type,subtotal_cents,tax_cents,gstin_id,branch_id FROM invoices WHERE company_id=? AND (? IS NULL OR branch_id=?) AND (? IS NULL OR gstin_id=?)`).all(companyId,branchId,branchId,gstinId,gstinId));
    const lowStockItems = stockRows(companyId,branchId).filter(x => req.scopes.branchIds.includes(x.branchId) && (!gstinId || db.prepare('SELECT 1 FROM branches WHERE id=? AND gstin_id=?').get(x.branchId,gstinId)) && x.quantity <= x.reorderLevel).length;
    const recentActivity = scopedRows(req,db.prepare(`${invoiceSql} WHERE v.company_id=? AND (? IS NULL OR v.branch_id=?) AND (? IS NULL OR v.gstin_id=?) ORDER BY v.id DESC`).all(companyId,branchId,branchId,gstinId,gstinId)).slice(0,8).map(fields);
    const approved = invoices.filter(x => x.status === 'approved');
    return { stats:{ items:req.scopes.branchIds.length ? count('items') : 0,parties:req.scopes.branchIds.length ? count('parties') : 0,invoices:invoices.length,draftInvoices:invoices.filter(x=>x.status==='draft').length,submittedInvoices:invoices.filter(x=>x.status==='submitted').length,approvedInvoices:approved.length,lowStockItems },salesCents:approved.filter(x=>x.type==='sale').reduce((a,x)=>a+x.subtotal_cents,0),purchasesCents:approved.filter(x=>x.type==='purchase').reduce((a,x)=>a+x.subtotal_cents,0),outputGstCents:approved.filter(x=>x.type==='sale').reduce((a,x)=>a+x.tax_cents,0),purchaseTaxCents:approved.filter(x=>x.type==='purchase').reduce((a,x)=>a+x.tax_cents,0),recentActivity };
  }));

  registerFinanceRoutes(app, db);
  registerReturnsRoutes(app, db);
  registerReturnTaxRoutes(app, db);
  registerWorkflowRoutes(app, db);
  registerStatutoryMockRoutes(app, db);
  registerOrdersRoutes(app, db);
  registerBatchInventoryRoutes(app, db);
  registerEvidenceRoutes(app, db);
  registerStatementImportRoutes(app, db);
  registerLedgerRoutes(app, db);
  registerBankRoutes(app, db);
  registerCashierRoutes(app, db);
  registerReportingRoutes(app, db);
  registerReturnSettlementRoutes(app, db);
  registerStatutoryLifecycleRoutes(app, db);
  registerAccessRoutes(app, db);
  registerLocationsRoutes(app, db);
  registerConversionRoutes(app, db);
  registerCatalogueRoutes(app, db);
  registerCountsRoutes(app, db);
  registerPricingRoutes(app, db);
  registerCreditRoutes(app, db);
  registerConsignmentRoutes(app, db);
  registerPriceAdjustmentRoutes(app, db);
  registerSupplierComparisonRoutes(app, db);
  registerOrderCrmRoutes(app, db);
  registerBundleRoutes(app, db);
  registerBudgetsRoutes(app, db);
  registerDocumentOutputRoutes(app, db);
  registerDeliveryRoutes(app, db);
  registerMasterImportRoutes(app, db);
  registerGstInvoiceAssistantRoutes(app, db);
  registerWorkspaceMenuRoutes(app, db);
  app.use((error, _req, res, _next) => {
    const status = error.status || (error.code?.startsWith('SQLITE_CONSTRAINT') || [1555,2067].includes(error.errcode) ? 409 : 500);
    res.status(status).json({ error: status === 500 ? 'Internal server error' : error.message });
    if (status === 500) console.error(error);
  });
  return app;
}

module.exports = { createApp };
