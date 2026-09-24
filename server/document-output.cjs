const { createHash } = require('node:crypto');
const { assertScopeAccess, allowedScopes } = require('./access.cjs');

const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const numberId = (value, name) => {
  if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value))) throw fail(`${name} must be a positive integer`);
  return Number(value);
};
const camel = row => Object.fromEntries(Object.entries(row).map(([key, value]) => [key.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase()), value]));
const languages = Object.freeze({
  en: Object.freeze({ heading:'Invoice copy', invoice:'Invoice', date:'Date', status:'Source status', seller:'Seller', buyer:'Buyer', supplier:'Supplier', item:'Item', sku:'SKU', hsn:'HSN', quantity:'Quantity', unit:'Unit', rate:'Rate', tax:'Tax', total:'Total', subtotal:'Subtotal', notes:'Notes', draft:'Draft source — not approved', approved:'Locally approved source', submitted:'Submitted for internal approval' }),
  hi: Object.freeze({ heading:'चालान की प्रति', invoice:'चालान', date:'तारीख', status:'स्रोत की स्थिति', seller:'विक्रेता', buyer:'खरीदार', supplier:'आपूर्तिकर्ता', item:'वस्तु', sku:'वस्तु कोड', hsn:'एचएसएन', quantity:'मात्रा', unit:'इकाई', rate:'दर', tax:'कर', total:'कुल', subtotal:'कर पूर्व राशि', notes:'टिप्पणी', draft:'मसौदा स्रोत — स्वीकृत नहीं', approved:'स्थानीय स्तर पर स्वीकृत स्रोत', submitted:'आंतरिक स्वीकृति के लिए भेजा गया' }),
  mr: Object.freeze({ heading:'चलनाची प्रत', invoice:'चलन', date:'दिनांक', status:'स्रोत स्थिती', seller:'विक्रेता', buyer:'खरेदीदार', supplier:'पुरवठादार', item:'वस्तू', sku:'वस्तू संकेत', hsn:'एचएसएन', quantity:'प्रमाण', unit:'एकक', rate:'दर', tax:'कर', total:'एकूण', subtotal:'करपूर्व रक्कम', notes:'नोंदी', draft:'मसुदा स्रोत — मंजूर नाही', approved:'स्थानिक पातळीवर मंजूर स्रोत', submitted:'अंतर्गत मंजुरीसाठी सादर' }),
});
const templates = Object.freeze({
  'invoice-standard': Object.freeze({ version:1, layout:'A4' }),
  'invoice-compact': Object.freeze({ version:1, layout:'compact' }),
});

function installDocumentOutputSchema(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS document_output_versions (
    id INTEGER PRIMARY KEY,
    company_id INTEGER NOT NULL REFERENCES companies(id),
    gstin_id INTEGER NOT NULL REFERENCES gstins(id),
    branch_id INTEGER NOT NULL REFERENCES branches(id),
    invoice_id INTEGER NOT NULL REFERENCES invoices(id),
    version INTEGER NOT NULL CHECK(version > 0),
    template_id TEXT NOT NULL,
    template_version INTEGER NOT NULL CHECK(template_version > 0),
    language TEXT NOT NULL,
    source_status TEXT NOT NULL CHECK(source_status IN ('draft','submitted','approved')),
    source_hash TEXT NOT NULL,
    snapshot_json TEXT NOT NULL,
    labels_json TEXT NOT NULL,
    created_by INTEGER NOT NULL REFERENCES users(id),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(invoice_id,version)
  );
  CREATE INDEX IF NOT EXISTS idx_document_output_scope ON document_output_versions(company_id,gstin_id,branch_id,invoice_id);
  CREATE TRIGGER IF NOT EXISTS document_output_versions_immutable_update BEFORE UPDATE ON document_output_versions
    BEGIN SELECT RAISE(ABORT, 'Document output versions are immutable'); END;
  CREATE TRIGGER IF NOT EXISTS document_output_versions_immutable_delete BEFORE DELETE ON document_output_versions
    BEGIN SELECT RAISE(ABORT, 'Document output versions are immutable'); END;`);
}

function invoiceSource(db, req, id) {
  const row = db.prepare(`SELECT v.*,c.name AS company_name,c.tax_regime,b.name AS branch_name,g.gstin,
    p.name AS current_party_name,p.gstin AS current_party_gstin,p.address AS party_address
    FROM invoices v JOIN companies c ON c.id=v.company_id JOIN branches b ON b.id=v.branch_id AND b.company_id=v.company_id
    JOIN gstins g ON g.id=v.gstin_id AND g.company_id=v.company_id AND b.gstin_id=g.id
    JOIN parties p ON p.id=v.party_id AND p.company_id=v.company_id
    WHERE v.id=? AND v.company_id=?`).get(id, req.company.id);
  if (!row) throw fail('Invoice not found in selected company', 404);
  assertScopeAccess(db, { companyId:req.company.id, userId:req.user.id, gstinId:row.gstin_id, branchId:row.branch_id });
  const lines = db.prepare(`SELECT l.id AS invoice_line_id,l.item_id,l.item_sku_snapshot AS sku,
    l.item_name_snapshot AS name,l.item_hsn_snapshot AS hsn,l.item_unit_snapshot AS unit,
    l.item_identity_source,
    l.quantity,l.unit_price_cents,l.gst_rate_bps,l.subtotal_cents,l.tax_cents,l.total_cents
    FROM invoice_lines l JOIN items i ON i.id=l.item_id AND i.company_id=?
    WHERE l.invoice_id=? ORDER BY l.id`).all(req.company.id, id);
  if (!lines.length) throw fail('Invoice has no lines to print', 409);
  return {
    invoiceId:row.id, companyId:row.company_id, gstinId:row.gstin_id, branchId:row.branch_id,
    companyName:row.company_name, taxRegime:row.tax_regime, branchName:row.branch_name, gstin:row.gstin,
    number:row.number, invoiceDate:row.invoice_date, type:row.type, status:row.status,
    partyId:row.party_id, partyName:row.party_name_snapshot || row.current_party_name,
    partyGstin:row.supplier_gstin_snapshot || row.current_party_gstin, partyAddress:row.party_address,
    supplierInvoiceNumber:row.supplier_invoice_number, notes:row.notes,
    subtotalCents:row.subtotal_cents, taxCents:row.tax_cents, totalCents:row.total_cents,
    lines:lines.map(line => ({ ...camel(line), barcodePayload:`TA-${row.company_id}-${line.item_id}` })),
  };
}
const digest = source => createHash('sha256').update(JSON.stringify(source)).digest('hex');

function registerDocumentOutputRoutes(app, db) {
  installDocumentOutputSchema(db);
  const route = fn => (req, res, next) => { try { res.json(fn(req)); } catch (error) { next(error); } };
  const source = (req) => invoiceSource(db, req, numberId(req.params.id, 'invoiceId'));
  const versionRows = (companyId, invoiceId) => db.prepare('SELECT * FROM document_output_versions WHERE company_id=? AND invoice_id=? ORDER BY version DESC').all(companyId, invoiceId);
  const describe = (row, current) => ({
    id:row.id, invoiceId:row.invoice_id, version:row.version, templateId:row.template_id,
    templateVersion:row.template_version, language:row.language, sourceStatus:row.source_status,
    sourceHash:row.source_hash, createdBy:row.created_by, createdAt:row.created_at,
    currentSourceStatus:current.status, sourceChangedSinceVersion:row.source_hash !== digest(current),
  });
  const detail = (row, current) => ({
    ...describe(row, current), snapshot:JSON.parse(row.snapshot_json), labels:JSON.parse(row.labels_json),
  });

  app.get('/api/document-output/invoices', route(req => {
    const branchId = req.query.branchId === undefined ? null : numberId(req.query.branchId, 'branchId');
    const gstinId = req.query.gstinId === undefined ? null : numberId(req.query.gstinId, 'gstinId');
    if (branchId || gstinId) assertScopeAccess(db, { companyId:req.company.id, userId:req.user.id,
      ...(branchId ? { branchId } : {}), ...(gstinId ? { gstinId } : {}) });
    const grants = allowedScopes(db, { companyId:req.company.id, userId:req.user.id });
    const rows = db.prepare(`SELECT v.id,v.number,v.type,v.status,v.invoice_date,v.branch_id,v.gstin_id,
      v.party_name_snapshot,p.name AS party_name,v.total_cents,b.name AS branch_name,
      COALESCE(MAX(d.version),0) AS latest_version
      FROM invoices v JOIN parties p ON p.id=v.party_id JOIN branches b ON b.id=v.branch_id
      LEFT JOIN document_output_versions d ON d.invoice_id=v.id
      WHERE v.company_id=? AND (? IS NULL OR v.branch_id=?) AND (? IS NULL OR v.gstin_id=?)
      GROUP BY v.id ORDER BY v.id DESC LIMIT 200`).all(req.company.id, branchId, branchId, gstinId, gstinId);
    return { invoices:rows.filter(row => grants.gstinIds.includes(row.gstin_id) && grants.branchIds.includes(row.branch_id))
      .map(row => ({ id:row.id, number:row.number, type:row.type, status:row.status, invoiceDate:row.invoice_date,
        branchId:row.branch_id, gstinId:row.gstin_id, branchName:row.branch_name,
        partyName:row.party_name_snapshot || row.party_name, totalCents:row.total_cents, latestVersion:row.latest_version })) };
  }));

  app.get('/api/document-output/invoices/:id/versions', route(req => {
    const current = source(req);
    return { versions:versionRows(req.company.id, current.invoiceId).map(row => describe(row, current)) };
  }));

  app.post('/api/document-output/invoices/:id/versions', route(req => {
    const current = source(req);
    const { templateId, language } = req.body || {};
    const template = Object.hasOwn(templates, templateId) ? templates[templateId] : null;
    if (!template) throw fail('Unsupported print template');
    if (!Object.hasOwn(languages, language)) throw fail('Unsupported print language');
    const sourceHash = digest(current);
    db.exec('SAVEPOINT document_output_create');
    try {
      const existing = db.prepare(`SELECT * FROM document_output_versions WHERE company_id=? AND invoice_id=?
        AND template_id=? AND template_version=? AND language=? AND source_hash=? ORDER BY version DESC LIMIT 1`)
        .get(req.company.id, current.invoiceId, templateId, template.version, language, sourceHash);
      if (existing) {
        db.exec('RELEASE document_output_create');
        return { document:detail(existing, current), replayed:true };
      }
      const version = db.prepare('SELECT COALESCE(MAX(version),0)+1 AS next FROM document_output_versions WHERE invoice_id=?').get(current.invoiceId).next;
      const id = Number(db.prepare(`INSERT INTO document_output_versions
        (company_id,gstin_id,branch_id,invoice_id,version,template_id,template_version,language,source_status,source_hash,snapshot_json,labels_json,created_by)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(req.company.id,current.gstinId,current.branchId,current.invoiceId,
        version,templateId,template.version,language,current.status,sourceHash,JSON.stringify(current),JSON.stringify(languages[language]),req.user.id).lastInsertRowid);
      const created = db.prepare('SELECT * FROM document_output_versions WHERE id=?').get(id);
      db.exec('RELEASE document_output_create');
      return { document:detail(created, current), replayed:false };
    } catch (error) { db.exec('ROLLBACK TO document_output_create'); db.exec('RELEASE document_output_create'); throw error; }
  }));

  app.get('/api/document-output/invoices/:id/versions/:version', route(req => {
    const current = source(req);
    const version = numberId(req.params.version, 'version');
    const row = db.prepare('SELECT * FROM document_output_versions WHERE company_id=? AND invoice_id=? AND version=?')
      .get(req.company.id, current.invoiceId, version);
    if (!row) throw fail('Document version not found', 404);
    return { document:detail(row, current) };
  }));
}

module.exports = { registerDocumentOutputRoutes, installDocumentOutputSchema };
