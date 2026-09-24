const { createHash } = require('node:crypto');
const { installSupplierComparisonSchema } = require('./supplier-comparison-db.cjs');
const { assertScopeAccess } = require('./access.cjs');

const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const integer = (value, name, min = 0, max = 1000000000) => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) throw fail(`${name} must be an integer from ${min} to ${max}`);
  return value;
};
const text = (value, name, max = 200) => {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw fail(`${name} is required and must be at most ${max} characters`);
  return value.trim();
};
const date = (value, name) => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) throw fail(`${name} must be a valid YYYY-MM-DD date`);
  if (new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value) throw fail(`${name} must be a valid YYYY-MM-DD date`);
  return value;
};
const camel = row => Object.fromEntries(Object.entries(row).map(([key, value]) => [key.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase()), value]));
const halfUp = (numerator, denominator) => (numerator * 2n + denominator) / (2n * denominator);
const moneyDisplay = (numerator, denominator) => {
  const scaled = halfUp(numerator * 10000n, denominator * 100n);
  return `${scaled / 10000n}.${String(scaled % 10000n).padStart(4, '0')}`;
};
const ratio = (numerator, denominator) => ({ numerator: String(numerator), denominator: String(denominator), rupeesPerBaseUnit: moneyDisplay(numerator, denominator) });

function quoteCost(row) {
  const paid = BigInt(row.paid_pack_quantity);
  const free = BigInt(row.free_pack_quantity);
  const price = BigInt(row.price_cents_per_pack);
  const subtotal = paid * price;
  const tax = halfUp(subtotal * BigInt(row.tax_rate_bps), 10000n);
  const freight = BigInt(row.freight_cents);
  const includedTax = row.tax_treatment === 'include' ? tax : 0n;
  const landed = subtotal + includedTax + freight;
  const equivalentNumerator = (paid + free) * BigInt(row.units_per_pack_numerator);
  const equivalentDenominator = BigInt(row.units_per_pack_denominator);
  return {
    subtotalCents: String(subtotal), quotedTaxCents: String(tax), includedTaxCents: String(includedTax), freightCents: String(freight), landedTotalCents: String(landed),
    equivalentBaseUnits: { numerator: String(equivalentNumerator), denominator: String(equivalentDenominator) },
    landedUnitCost: ratio(landed * equivalentDenominator, equivalentNumerator),
  };
}
const quoteView = row => {
  const { payload_json: _payload, ...safe } = row;
  return { ...camel(safe), cost: quoteCost(row) };
};
const historyView = row => ({
  invoiceId: row.invoice_id, invoiceLineId: row.id, invoiceNumber: row.number, supplierInvoiceNumber: row.supplier_invoice_number,
  invoiceDate: row.invoice_date, supplierId: row.party_id, supplierName: row.party_name_snapshot || row.party_name,
  branchId: row.branch_id, gstinId: row.gstin_id, quantityBaseUnits: row.quantity,
  subtotalCents: row.subtotal_cents, taxCents: row.tax_cents, totalCents: row.total_cents,
  unitCostExcludingTax: ratio(BigInt(row.subtotal_cents), BigInt(row.quantity)),
  unitCostIncludingTax: ratio(BigInt(row.total_cents), BigInt(row.quantity)),
  freightIncluded: false,
});
const purchaseHistoryRows = (db, companyId, branchId, itemId) => db.prepare(`SELECT l.*,i.id AS invoice_id,i.number,i.supplier_invoice_number,i.invoice_date,i.party_id,i.party_name_snapshot,i.branch_id,i.gstin_id,p.name AS party_name
    FROM invoice_lines l JOIN invoices i ON i.id=l.invoice_id AND i.company_id=? JOIN parties p ON p.id=i.party_id AND p.company_id=i.company_id
    WHERE i.type='purchase' AND i.status='approved' AND i.branch_id=? AND l.item_id=? AND l.quantity>0
    ORDER BY i.invoice_date DESC,i.id DESC,l.id DESC LIMIT 30`).all(companyId, branchId, itemId);
const historyFingerprint = rows => createHash('sha256').update(JSON.stringify(rows.map(x => [x.id, x.invoice_id, x.quantity, x.subtotal_cents, x.tax_cents, x.total_cents]))).digest('hex');

function registerSupplierComparisonRoutes(app, db) {
  installSupplierComparisonSchema(db);
  const route = handler => (req, res, next) => { try { res.json(handler(req)); } catch (error) { next(error); } };
  const atomic = work => {
    db.exec('SAVEPOINT supplier_comparison_action');
    try { const result = work(); db.exec('RELEASE supplier_comparison_action'); return result; }
    catch (error) { db.exec('ROLLBACK TO supplier_comparison_action'); db.exec('RELEASE supplier_comparison_action'); throw error; }
  };
  const scopedBranch = (req, branchId, gstinId) => {
    const row = assertScopeAccess(db, { companyId: req.company.id, userId: req.user.id, branchId: integer(branchId, 'branchId', 1), gstinId: integer(gstinId, 'gstinId', 1) });
    return row;
  };
  const author = req => { if (!['staff', 'admin'].includes(req.user.role)) throw fail('Staff or admin role required', 403); };
  const reviewer = req => { if (!['accountant', 'admin'].includes(req.user.role)) throw fail('Accountant or admin reviewer required', 403); };
  const item = (req, id) => {
    const row = db.prepare('SELECT * FROM items WHERE id=? AND company_id=?').get(integer(id, 'itemId', 1), req.company.id);
    if (!row) throw fail('Item not found in selected company', 404);
    return row;
  };
  const supplier = (req, id) => {
    const row = db.prepare('SELECT * FROM parties WHERE id=? AND company_id=?').get(integer(id, 'supplierId', 1), req.company.id);
    if (!row || !['supplier', 'both'].includes(row.type)) throw fail('Supplier not found in selected company', 404);
    return row;
  };
  const comparison = (req, id) => {
    const row = db.prepare('SELECT * FROM supplier_comparisons WHERE id=? AND company_id=?').get(integer(Number(id), 'comparisonId', 1), req.company.id);
    if (!row) throw fail('Comparison not found in selected company', 404);
    scopedBranch(req, row.branch_id, row.gstin_id);
    return row;
  };
  const quotes = row => db.prepare('SELECT q.*,p.name AS supplier_name FROM supplier_comparison_quotes q JOIN parties p ON p.id=q.supplier_id AND p.company_id=q.company_id WHERE q.comparison_id=? AND q.company_id=? ORDER BY q.id').all(row.id, row.company_id).map(quoteView);
  const events = row => db.prepare('SELECT id,actor_id,action,detail_json,created_at FROM supplier_comparison_events WHERE comparison_id=? AND company_id=? ORDER BY id').all(row.id, row.company_id).map(event => ({ id: event.id, actorId: event.actor_id, action: event.action, detail: JSON.parse(event.detail_json), createdAt: event.created_at }));
  const event = (req, row, action, detail) => db.prepare('INSERT INTO supplier_comparison_events(comparison_id,company_id,actor_id,action,detail_json) VALUES (?,?,?,?,?)').run(row.id, req.company.id, req.user.id, action, JSON.stringify(detail));
  const history = (req, row) => purchaseHistoryRows(db, req.company.id, row.branch_id, row.item_id);
  const fingerprint = (req, row) => historyFingerprint(history(req, row));
  const view = (req, row) => {
    const { payload_json: _payload, history_fingerprint: _fingerprint, ...safe } = row;
    return { ...camel(safe), quotes: quotes(row), purchaseHistory: history(req, row).map(historyView), events: events(row), historyChangedSinceSubmit: row.history_fingerprint ? row.history_fingerprint !== fingerprint(req, row) : false };
  };
  const list = req => db.prepare('SELECT * FROM supplier_comparisons WHERE company_id=? ORDER BY id DESC LIMIT 200').all(req.company.id).filter(row => req.scopes.branchIds.includes(row.branch_id) && req.scopes.gstinIds.includes(row.gstin_id)).map(row => view(req, row));

  app.get('/api/supplier-comparisons/masters', route(req => {
    if (!req.scopes.branchIds.length) throw fail('A branch grant is required', 403);
    return { items: db.prepare('SELECT id,sku,name,unit,active FROM items WHERE company_id=? ORDER BY name').all(req.company.id).map(camel),
      suppliers: db.prepare("SELECT id,name,gstin FROM parties WHERE company_id=? AND type IN ('supplier','both') ORDER BY name").all(req.company.id).map(camel) };
  }));
  app.get('/api/supplier-comparisons', route(req => ({ comparisons: list(req) })));
  app.get('/api/supplier-comparisons/:id', route(req => ({ comparison: view(req, comparison(req, req.params.id)) })));
  app.post('/api/supplier-comparisons', route(req => {
    author(req);
    const body = req.body || {};
    const branch = scopedBranch(req, body.branchId, body.gstinId);
    const chosenItem = item(req, body.itemId);
    if (!chosenItem.active) throw fail('Inactive items cannot be compared', 409);
    const payload = { branchId: branch.id, gstinId: branch.gstin_id, itemId: chosenItem.id, title: text(body.title, 'title', 160) };
    const clientReference = text(body.clientReference, 'clientReference', 120);
    return atomic(() => {
      const existing = db.prepare('SELECT * FROM supplier_comparisons WHERE company_id=? AND client_reference=?').get(req.company.id, clientReference);
      if (existing) {
        if (existing.payload_json !== JSON.stringify(payload)) throw fail('clientReference was used for a different comparison', 409);
        scopedBranch(req, existing.branch_id, existing.gstin_id);
        return { comparison: view(req, existing), replayed: true };
      }
      const id = Number(db.prepare(`INSERT INTO supplier_comparisons(company_id,gstin_id,branch_id,item_id,item_unit_snapshot,title,client_reference,payload_json,created_by)
        VALUES (?,?,?,?,?,?,?,?,?)`).run(req.company.id, branch.gstin_id, branch.id, chosenItem.id, chosenItem.unit, payload.title, clientReference, JSON.stringify(payload), req.user.id).lastInsertRowid);
      const row = comparison(req, id);
      event(req, row, 'created', { ...payload, clientReference, itemUnit: chosenItem.unit });
      return { comparison: view(req, row), replayed: false };
    });
  }));
  app.post('/api/supplier-comparisons/:id/quotes', route(req => {
    author(req);
    const row = comparison(req, req.params.id);
    const body = req.body || {};
    const chosenSupplier = supplier(req, body.supplierId);
    const quoteDate = date(body.quoteDate, 'quoteDate');
    const validUntil = date(body.validUntil, 'validUntil');
    if (validUntil < quoteDate) throw fail('validUntil must be on or after quoteDate');
    const payload = {
      supplierId: chosenSupplier.id, quoteDate, validUntil, sourceReference: text(body.sourceReference, 'sourceReference', 160), paymentTerms: text(body.paymentTerms, 'paymentTerms', 160),
      paidPackQuantity: integer(body.paidPackQuantity, 'paidPackQuantity', 1, 1000000), freePackQuantity: integer(body.freePackQuantity, 'freePackQuantity', 0, 1000000),
      unitsPerPackNumerator: integer(body.unitsPerPackNumerator, 'unitsPerPackNumerator', 1, 1000000), unitsPerPackDenominator: integer(body.unitsPerPackDenominator, 'unitsPerPackDenominator', 1, 1000000),
      priceCentsPerPack: integer(body.priceCentsPerPack, 'priceCentsPerPack', 1, 1000000000), taxRateBps: integer(body.taxRateBps, 'taxRateBps', 0, 10000),
      freightCents: integer(body.freightCents, 'freightCents', 0, 1000000000), taxTreatment: body.taxTreatment,
    };
    if (!['include', 'exclude'].includes(payload.taxTreatment)) throw fail('taxTreatment must be include or exclude');
    const clientReference = text(body.clientReference, 'clientReference', 120);
    return atomic(() => {
      const existing = db.prepare('SELECT * FROM supplier_comparison_quotes WHERE comparison_id=? AND client_reference=?').get(row.id, clientReference);
      if (existing) {
        if (existing.payload_json !== JSON.stringify(payload)) throw fail('clientReference was used for different quote terms', 409);
        return { quote: quoteView({ ...existing, supplier_name: chosenSupplier.name }), comparison: view(req, comparison(req, row.id)), replayed: true };
      }
      if (row.status !== 'draft') throw fail('Only a draft comparison accepts quotes', 409);
      if (row.created_by !== req.user.id) throw fail('Only the comparison creator can add quotes', 403);
      const id = Number(db.prepare(`INSERT INTO supplier_comparison_quotes(comparison_id,company_id,supplier_id,quote_date,valid_until,source_reference,payment_terms,paid_pack_quantity,free_pack_quantity,units_per_pack_numerator,units_per_pack_denominator,price_cents_per_pack,tax_rate_bps,freight_cents,tax_treatment,client_reference,payload_json,created_by)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(row.id, req.company.id, payload.supplierId, payload.quoteDate, payload.validUntil, payload.sourceReference, payload.paymentTerms,
        payload.paidPackQuantity, payload.freePackQuantity, payload.unitsPerPackNumerator, payload.unitsPerPackDenominator, payload.priceCentsPerPack, payload.taxRateBps, payload.freightCents, payload.taxTreatment, clientReference, JSON.stringify(payload), req.user.id).lastInsertRowid);
      const quote = db.prepare('SELECT q.*,p.name AS supplier_name FROM supplier_comparison_quotes q JOIN parties p ON p.id=q.supplier_id WHERE q.id=?').get(id);
      event(req, row, 'quote_added', { quoteId: id, supplierId: chosenSupplier.id, sourceReference: payload.sourceReference, cost: quoteCost(quote) });
      return { quote: quoteView(quote), comparison: view(req, comparison(req, row.id)), replayed: false };
    });
  }));
  app.post('/api/supplier-comparisons/:id/submit', route(req => {
    author(req);
    const row = comparison(req, req.params.id);
    const quoteId = integer(req.body?.selectedQuoteId, 'selectedQuoteId', 1);
    const reason = text(req.body?.reason, 'reason', 500);
    if (row.status !== 'draft') {
      if (row.status === 'submitted' && row.selected_quote_id === quoteId && row.selection_reason === reason) return { comparison: view(req, row), replayed: true };
      throw fail('Comparison is already submitted or reviewed', 409);
    }
    if (row.created_by !== req.user.id) throw fail('Only the comparison creator can submit', 403);
    const allQuotes = quotes(row);
    if (allQuotes.length < 2 || new Set(allQuotes.map(q => q.supplierId)).size < 2) throw fail('At least two different supplier quotes are required');
    const selected = allQuotes.find(q => q.id === quoteId);
    if (!selected) throw fail('Selected quote is not part of this comparison', 404);
    if (selected.validUntil < new Date().toISOString().slice(0, 10)) throw fail('Selected quote has expired', 409);
    return atomic(() => {
      db.prepare("UPDATE supplier_comparisons SET status='submitted',selected_quote_id=?,selection_reason=?,history_fingerprint=?,submitted_at=CURRENT_TIMESTAMP WHERE id=? AND company_id=?")
        .run(quoteId, reason, fingerprint(req, row), row.id, req.company.id);
      event(req, row, 'submitted', { selectedQuoteId: quoteId, reason, historyFingerprint: fingerprint(req, row) });
      return { comparison: view(req, comparison(req, row.id)), replayed: false };
    });
  }));
  app.post('/api/supplier-comparisons/:id/review', route(req => {
    reviewer(req);
    const row = comparison(req, req.params.id);
    const decision = req.body?.decision;
    if (!['approve', 'reject'].includes(decision)) throw fail('decision must be approve or reject');
    const reason = text(req.body?.reason, 'reason', 500);
    const status = decision === 'approve' ? 'approved' : 'rejected';
    if (row.status !== 'submitted') {
      if (row.status === status && row.reviewed_by === req.user.id && row.review_reason === reason) return { comparison: view(req, row), replayed: true };
      throw fail('Comparison is not awaiting review', 409);
    }
    if (row.created_by === req.user.id) throw fail('Creator cannot review their own comparison', 403);
    if (decision === 'approve') {
      const selected = quotes(row).find(q => q.id === row.selected_quote_id);
      if (!selected || selected.validUntil < new Date().toISOString().slice(0, 10)) throw fail('Selected quote expired; create a new comparison', 409);
      const currentSupplier = db.prepare("SELECT id FROM parties WHERE id=? AND company_id=? AND type IN ('supplier','both')")
        .get(selected.supplierId, req.company.id);
      if (!currentSupplier) throw fail('Selected party is no longer an active supplier; create a new comparison', 409);
      if (row.history_fingerprint !== fingerprint(req, row)) throw fail('Approved purchase history changed; create a new comparison', 409);
      const currentItem = item(req, row.item_id);
      if (!currentItem.active || currentItem.unit !== row.item_unit_snapshot) throw fail('Item unit or status changed; create a new comparison', 409);
    }
    return atomic(() => {
      db.prepare('UPDATE supplier_comparisons SET status=?,reviewed_by=?,reviewed_at=CURRENT_TIMESTAMP,review_reason=? WHERE id=? AND company_id=?').run(status, req.user.id, reason, row.id, req.company.id);
      event(req, row, status, { selectedQuoteId: row.selected_quote_id, reason });
      return { comparison: view(req, comparison(req, row.id)), replayed: false };
    });
  }));
}

function seedSupplierComparisonDemo(db) {
  installSupplierComparisonSchema(db);
  const clientReference = 'SYNTHETIC-DEMO-ERP-015-001';
  const existing = db.prepare('SELECT id FROM supplier_comparisons WHERE company_id=1 AND client_reference=?').get(clientReference);
  if (existing) return { created: false, comparisonId: existing.id };
  const branch = db.prepare('SELECT id,gstin_id FROM branches WHERE id=1 AND company_id=1 AND gstin_id=1').get();
  const item = db.prepare('SELECT id,unit FROM items WHERE id=1 AND company_id=1 AND active=1').get();
  const northstar = db.prepare("SELECT id FROM parties WHERE id=2 AND company_id=1 AND type IN ('supplier','both')").get();
  const kaveri = db.prepare("SELECT id FROM parties WHERE company_id=1 AND name='Kaveri Labs (Demo)' AND type IN ('supplier','both')").get();
  const creator = db.prepare("SELECT id FROM users WHERE id=1 AND company_id=1 AND role IN ('staff','admin')").get();
  const reviewer = db.prepare("SELECT id FROM users WHERE id=2 AND company_id=1 AND role IN ('accountant','admin')").get();
  if (!branch || !item || !northstar || !kaveri || !creator || !reviewer) return { created: false, reason: 'Synthetic demo prerequisites unavailable' };
  const priorPurchases = purchaseHistoryRows(db, 1, branch.id, item.id);
  if (!priorPurchases.length) return { created: false, reason: 'Synthetic approved purchase history unavailable' };
  const day = new Date().toISOString().slice(0, 10);
  const validUntil = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);
  const casePayload = { branchId: branch.id, gstinId: branch.gstin_id, itemId: item.id, title: 'SYNTHETIC DEMO · Glucose strip supplier review' };
  const specifications = [
    { supplierId: northstar.id, quoteDate: day, validUntil, sourceReference: 'SYNTHETIC QUOTE NS-ERP015-01', paymentTerms: '30 days · 7 day delivery', paidPackQuantity: 5, freePackQuantity: 1, unitsPerPackNumerator: 10, unitsPerPackDenominator: 1, priceCentsPerPack: 10000, taxRateBps: 1200, freightCents: 500, taxTreatment: 'include' },
    { supplierId: kaveri.id, quoteDate: day, validUntil, sourceReference: 'SYNTHETIC QUOTE KL-ERP015-02', paymentTerms: '15 days · 5 day delivery', paidPackQuantity: 4, freePackQuantity: 0, unitsPerPackNumerator: 12, unitsPerPackDenominator: 1, priceCentsPerPack: 11000, taxRateBps: 1200, freightCents: 900, taxTreatment: 'include' },
  ];
  db.exec('SAVEPOINT seed_supplier_comparison_demo');
  try {
    // Repeat the check inside the savepoint in case another caller created the specimen.
    const raced = db.prepare('SELECT id FROM supplier_comparisons WHERE company_id=1 AND client_reference=?').get(clientReference);
    if (raced) { db.exec('RELEASE seed_supplier_comparison_demo'); return { created: false, comparisonId: raced.id }; }
    const comparisonId = Number(db.prepare(`INSERT INTO supplier_comparisons(company_id,gstin_id,branch_id,item_id,item_unit_snapshot,title,client_reference,payload_json,status,created_by,submitted_at,reviewed_by,reviewed_at,review_reason)
      VALUES (1,?,?,?,?,?,?,?,'approved',1,CURRENT_TIMESTAMP,2,CURRENT_TIMESTAMP,?)`).run(branch.gstin_id, branch.id, item.id, item.unit, casePayload.title, clientReference, JSON.stringify(casePayload), 'Synthetic offers checked for demonstration; internal purchasing choice only.').lastInsertRowid);
    const event = (actor, action, detail) => db.prepare('INSERT INTO supplier_comparison_events(comparison_id,company_id,actor_id,action,detail_json) VALUES (?,1,?,?,?)').run(comparisonId, actor, action, JSON.stringify(detail));
    event(1, 'created', { ...casePayload, clientReference, itemUnit: item.unit, syntheticDemo: true });
    const quoteIds = specifications.map((specification, index) => {
      const quoteReference = `SYNTHETIC-DEMO-ERP-015-Q${index + 1}`;
      const quoteId = Number(db.prepare(`INSERT INTO supplier_comparison_quotes(comparison_id,company_id,supplier_id,quote_date,valid_until,source_reference,payment_terms,paid_pack_quantity,free_pack_quantity,units_per_pack_numerator,units_per_pack_denominator,price_cents_per_pack,tax_rate_bps,freight_cents,tax_treatment,client_reference,payload_json,created_by)
        VALUES (?,1,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1)`).run(comparisonId, specification.supplierId, specification.quoteDate, specification.validUntil, specification.sourceReference, specification.paymentTerms,
        specification.paidPackQuantity, specification.freePackQuantity, specification.unitsPerPackNumerator, specification.unitsPerPackDenominator, specification.priceCentsPerPack, specification.taxRateBps,
        specification.freightCents, specification.taxTreatment, quoteReference, JSON.stringify(specification)).lastInsertRowid);
      const cost = quoteCost(db.prepare('SELECT * FROM supplier_comparison_quotes WHERE id=?').get(quoteId));
      event(1, 'quote_added', { quoteId, supplierId: specification.supplierId, sourceReference: specification.sourceReference, cost, syntheticDemo: true });
      return quoteId;
    });
    const selectedQuoteId = quoteIds[0];
    const selectionReason = 'Synthetic demo: lower tax-inclusive cost per box after the free pack and freight; 30-day terms accepted.';
    const fingerprint = historyFingerprint(priorPurchases);
    db.prepare('UPDATE supplier_comparisons SET selected_quote_id=?,selection_reason=?,history_fingerprint=? WHERE id=?').run(selectedQuoteId, selectionReason, fingerprint, comparisonId);
    event(1, 'submitted', { selectedQuoteId, reason: selectionReason, historyFingerprint: fingerprint, syntheticDemo: true });
    event(2, 'approved', { selectedQuoteId, reason: 'Synthetic offers reviewed on equivalent box basis; no PO or ITC decision.', syntheticDemo: true });
    db.exec('RELEASE seed_supplier_comparison_demo');
    return { created: true, comparisonId };
  } catch (error) {
    db.exec('ROLLBACK TO seed_supplier_comparison_demo');
    db.exec('RELEASE seed_supplier_comparison_demo');
    throw error;
  }
}

module.exports = { registerSupplierComparisonRoutes, seedSupplierComparisonDemo, quoteCost };
