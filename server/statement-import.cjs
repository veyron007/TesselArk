const { createHash } = require('node:crypto');
const { installStatementImportSchema } = require('./statement-import-db.cjs');
const { allowedScopes, assertGstinAccess } = require('./access.cjs');

const bad = (message, status = 400) => Object.assign(new Error(message), { status });
const route = handler => (req, res, next) => { try { res.json(handler(req)); } catch (error) { next(error); } };
const camel = row => Object.fromEntries(Object.entries(row).map(([key, value]) => [key.replace(/_([a-z])/g, (_,letter) => letter.toUpperCase()), value]));
const HEADERS = ['supplier_gstin','invoice_number','invoice_date','taxable_amount','tax_amount'];
const MAX_ROWS = 500;
const MAX_BYTES = 128 * 1024;

function parseCsv(csv) {
  if (typeof csv !== 'string' || !csv || Buffer.byteLength(csv,'utf8') > MAX_BYTES) throw bad('CSV must be UTF-8 text no larger than 128 KB');
  const result = [], row = [];
  let field = '', quoted = false, afterQuote = false, line = 1, rowLine = 1;
  const append = () => { row.push(field); field = ''; afterQuote = false; };
  const finish = () => { append(); if (row.some(value => value !== '')) result.push({ line:rowLine, fields:[...row] }); row.length = 0; rowLine = line; };
  for (let index = 0; index < csv.length; index += 1) {
    const char = csv[index];
    if (quoted) {
      if (char === '"' && csv[index+1] === '"') { field += '"'; index += 1; }
      else if (char === '"') { quoted = false; afterQuote = true; }
      else { field += char; if (char === '\n') line += 1; }
      continue;
    }
    if (char === '"') { if (field || afterQuote) throw bad(`Malformed CSV quote on line ${line}`); quoted = true; continue; }
    if (char === ',') { append(); continue; }
    if (char === '\n' || char === '\r') {
      if (char === '\r' && csv[index+1] === '\n') index += 1;
      line += 1; finish(); continue;
    }
    if (afterQuote && char !== ' ' && char !== '\t') throw bad(`Unexpected text after CSV quote on line ${line}`);
    if (!afterQuote) field += char;
  }
  if (quoted) throw bad('CSV has an unclosed quoted field');
  if (field || row.length) finish();
  if (!result.length) throw bad('CSV is empty');
  const header = result.shift().fields.map((value,index) => index === 0 ? value.replace(/^\uFEFF/,'').trim().toLowerCase() : value.trim().toLowerCase());
  if (header.length !== HEADERS.length || header.some((value,index) => value !== HEADERS[index])) throw bad(`CSV columns must be: ${HEADERS.join(', ')}`);
  if (!result.length || result.length > MAX_ROWS) throw bad(`CSV must have 1 to ${MAX_ROWS} data rows`);
  return result;
}

function moneyCents(value, name) {
  if (!/^(?:0|[1-9]\d{0,10})(?:\.\d{1,2})?$/.test(value)) throw bad(`${name} must be a nonnegative rupee amount with at most two decimals`);
  const [whole, fractional = ''] = value.split('.');
  const cents = Number(whole) * 100 + Number(fractional.padEnd(2,'0'));
  if (!Number.isSafeInteger(cents)) throw bad(`${name} is too large`);
  return cents;
}

function normalizeRow(values, line) {
  if (values.length !== HEADERS.length) throw bad(`Line ${line} must have exactly five columns`);
  const [supplier, number, date, taxable, tax] = values.map(value => value.trim());
  const supplierGstin = supplier.toUpperCase();
  if (!/^[0-9]{2}[A-Z0-9]{10}[1-9A-Z]Z[A-Z0-9]$/.test(supplierGstin)) throw bad(`Line ${line}: supplier GSTIN must have a 15-character GSTIN shape`);
  if (!number || number.length > 80 || /[\x00-\x1F\x7F]/.test(number)) throw bad(`Line ${line}: invoice number is invalid`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00Z`)) || new Date(`${date}T00:00:00Z`).toISOString().slice(0,10) !== date) throw bad(`Line ${line}: invoice date must be a real YYYY-MM-DD date`);
  return { line, supplierGstin, invoiceNumber:number, invoiceDate:date, taxableCents:moneyCents(taxable,`Line ${line}: taxable amount`), taxCents:moneyCents(tax,`Line ${line}: tax amount`) };
}

function parseInput(req, db) {
  const body = req.body || {};
  const gstinId = Number(body.gstinId);
  if (!Number.isSafeInteger(gstinId) || gstinId < 1) throw bad('gstinId is required');
  const gstin = db.prepare('SELECT * FROM gstins WHERE id=? AND company_id=?').get(gstinId,req.company.id);
  if (!gstin) throw bad('GSTIN not found in selected company',404);
  assertGstinAccess(db,{companyId:req.company.id,userId:req.user.id,gstinId});
  const period = body.period;
  if (typeof period !== 'string' || !/^\d{4}-(0[1-9]|1[0-2])$/.test(period)) throw bad('period must be YYYY-MM');
  if (typeof body.sourceName !== 'string' || !body.sourceName.trim() || body.sourceName.length > 120 || /[\x00-\x1F\x7F]/.test(body.sourceName)) throw bad('sourceName must be 1 to 120 printable characters');
  const sourceName = body.sourceName.trim();
  const parsed = parseCsv(body.csv).map(row => {
    try { return normalizeRow(row.fields,row.line); }
    catch (error) { return { line:row.line, status:'invalid', detail:error.message }; }
  });
  const fileSha256 = createHash('sha256').update(body.csv,'utf8').digest('hex');
  const payloadSha256 = createHash('sha256').update(JSON.stringify([req.company.id,gstinId,period,sourceName,fileSha256])).digest('hex');
  return { gstinId,period,sourceName,fileSha256,payloadSha256,parsed };
}

function previewInput(req, db, input) {
  const seen = new Map();
  const rows = input.parsed.map(row => {
    if (row.status === 'invalid') return row;
    const key = `${row.supplierGstin}\u0000${row.invoiceNumber}`;
    const previous = seen.get(key);
    const values = [row.invoiceDate,row.taxableCents,row.taxCents,input.period];
    if (previous) return { ...row,status:JSON.stringify(previous) === JSON.stringify(values) ? 'repeat' : 'conflict',detail:'Duplicate key within this CSV' };
    seen.set(key,values);
    const existing = db.prepare('SELECT * FROM purchase_fixtures WHERE company_id=? AND gstin_id=? AND supplier_gstin=? AND invoice_number=?').get(req.company.id,input.gstinId,row.supplierGstin,row.invoiceNumber);
    if (!existing) return { ...row,status:'new',detail:'Ready to import' };
    const same = existing.invoice_date === row.invoiceDate && existing.taxable_cents === row.taxableCents && existing.tax_cents === row.taxCents && existing.source_period === input.period;
    return { ...row,status:same ? 'repeat' : 'conflict',detail:same ? `Exact repeat of local source ${existing.source_name}` : `Existing local source ${existing.source_name} has different values or period`,fixtureId:existing.id };
  });
  const counts = Object.fromEntries(['new','repeat','conflict','invalid'].map(status => [`${status}Count`,rows.filter(row => row.status === status).length]));
  const periodStatus = db.prepare('SELECT status FROM gst_periods WHERE company_id=? AND gstin_id=? AND period=?').get(req.company.id,input.gstinId,input.period)?.status || 'not_created';
  return { sha256:input.payloadSha256,fileSha256:input.fileSha256,rowCount:rows.length,...counts,periodStatus,canCommit:counts.conflictCount === 0 && counts.invalidCount === 0 && (periodStatus === 'open' || periodStatus === 'not_created'),rows,localStatementOnly:true };
}

function registerStatementImportRoutes(app, db) {
  installStatementImportSchema(db);
  app.get('/api/gst/statement-imports',route(req => {
    const gstinId = req.query.gstinId === undefined ? null : Number(req.query.gstinId);
    if (gstinId !== null && (!Number.isSafeInteger(gstinId) || !db.prepare('SELECT 1 FROM gstins WHERE id=? AND company_id=?').get(gstinId,req.company.id))) throw bad('GSTIN not found in selected company',404);
    if (gstinId !== null) assertGstinAccess(db,{companyId:req.company.id,userId:req.user.id,gstinId});
    const allowed = allowedScopes(db,{companyId:req.company.id,userId:req.user.id});
    if (!allowed.gstinIds.length) return {imports:[],localStatementOnly:true};
    const slots = allowed.gstinIds.map(() => '?').join(',');
    const imports = db.prepare(`SELECT s.*,u.name AS imported_by_name,g.gstin FROM statement_imports s JOIN users u ON u.id=s.imported_by JOIN gstins g ON g.id=s.gstin_id
      WHERE s.company_id=? AND s.gstin_id IN (${slots}) AND (? IS NULL OR s.gstin_id=?) ORDER BY s.id DESC LIMIT 100`)
      .all(req.company.id,...allowed.gstinIds,gstinId,gstinId).map(camel);
    return { imports,localStatementOnly:true };
  }));
  app.post('/api/gst/statement-imports/preview',route(req => {
    const input = parseInput(req,db);
    return { preview:previewInput(req,db,input) };
  }));
  app.post('/api/gst/statement-imports/commit',route(req => {
    if (!['accountant','admin'].includes(req.user.role)) throw bad('Accountant or admin role required',403);
    const input = parseInput(req,db);
    if (typeof req.body.expectedSha256 !== 'string' || req.body.expectedSha256 !== input.payloadSha256) throw bad('Preview changed; preview this exact file, source, period and GSTIN again',409);
    db.exec('BEGIN IMMEDIATE');
    try {
      const prior = db.prepare('SELECT * FROM statement_imports WHERE company_id=? AND gstin_id=? AND payload_sha256=?').get(req.company.id,input.gstinId,input.payloadSha256);
      if (prior) { db.exec('COMMIT'); return { import:camel(prior),inserted:0,skipped:prior.row_count,replayed:true,localStatementOnly:true }; }
      const preview = previewInput(req,db,input);
      if (!preview.canCommit) throw bad(preview.periodStatus !== 'open' && preview.periodStatus !== 'not_created' ? 'Local GST period is reviewed or approved; statement import is closed' : 'Resolve invalid or conflicting rows before committing',409);
      db.prepare("INSERT OR IGNORE INTO gst_periods(company_id,gstin_id,period,status) VALUES (?,?,?,'open')").run(req.company.id,input.gstinId,input.period);
      const imported = db.prepare('INSERT INTO statement_imports(company_id,gstin_id,source_period,source_name,file_sha256,payload_sha256,row_count,inserted_count,skipped_count,imported_by) VALUES (?,?,?,?,?,?,?,?,?,?)').run(req.company.id,input.gstinId,input.period,input.sourceName,input.fileSha256,input.payloadSha256,preview.rowCount,preview.newCount,preview.repeatCount,req.user.id);
      const importId = Number(imported.lastInsertRowid);
      for (const row of preview.rows) {
        let fixtureId = row.fixtureId;
        if (row.status === 'new') fixtureId = Number(db.prepare('INSERT INTO purchase_fixtures(company_id,gstin_id,supplier_gstin,invoice_number,invoice_date,taxable_cents,tax_cents,source_period,source_name) VALUES (?,?,?,?,?,?,?,?,?)').run(req.company.id,input.gstinId,row.supplierGstin,row.invoiceNumber,row.invoiceDate,row.taxableCents,row.taxCents,input.period,input.sourceName).lastInsertRowid);
        else if (!fixtureId) fixtureId = db.prepare('SELECT id FROM purchase_fixtures WHERE company_id=? AND gstin_id=? AND supplier_gstin=? AND invoice_number=?').get(req.company.id,input.gstinId,row.supplierGstin,row.invoiceNumber)?.id;
        if (!fixtureId) throw bad('Repeated CSV row has no committed source row',409);
        db.prepare('INSERT INTO statement_import_rows(import_id,line_number,fixture_id,action) VALUES (?,?,?,?)').run(importId,row.line,fixtureId,row.status === 'new' ? 'inserted' : 'repeat');
      }
      db.exec('COMMIT');
      return { import:camel(db.prepare('SELECT * FROM statement_imports WHERE id=?').get(importId)),inserted:preview.newCount,skipped:preview.repeatCount,replayed:false,localStatementOnly:true };
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  }));
}

module.exports = { registerStatementImportRoutes,parseCsv };
