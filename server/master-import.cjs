const { createHash } = require('node:crypto');
const { assertCompanyWideAccess, assertScopeAccess } = require('./access.cjs');

const HEADERS = ['sku','name','hsn','unit','gst_rate_bps','reorder_level','track_stock'];
const MAX_BYTES = 128 * 1024;
const MAX_ROWS = 500;
const bad = (message,status=400) => Object.assign(new Error(message),{status});
const route = handler => (req,res,next) => { try { res.json(handler(req)); } catch (error) { next(error); } };
const camel = row => Object.fromEntries(Object.entries(row).map(([key,value]) => [key.replace(/_([a-z])/g,(_,letter) => letter.toUpperCase()),value]));
const sha256 = value => createHash('sha256').update(value,'utf8').digest('hex');

function installMasterImportSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS master_imports (
      id INTEGER PRIMARY KEY,
      company_id INTEGER NOT NULL REFERENCES companies(id),
      gstin_id INTEGER NOT NULL REFERENCES gstins(id),
      branch_id INTEGER NOT NULL REFERENCES branches(id),
      source_name TEXT NOT NULL,
      file_sha256 TEXT NOT NULL,
      payload_sha256 TEXT NOT NULL,
      preview_sha256 TEXT NOT NULL,
      csv_text TEXT NOT NULL,
      row_count INTEGER NOT NULL,
      accepted_count INTEGER NOT NULL,
      rejected_count INTEGER NOT NULL,
      imported_by INTEGER NOT NULL REFERENCES users(id),
      imported_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(company_id,payload_sha256)
    );
    CREATE TABLE IF NOT EXISTS master_import_rows (
      import_id INTEGER NOT NULL REFERENCES master_imports(id),
      line_number INTEGER NOT NULL,
      raw_values_json TEXT NOT NULL,
      sku TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL CHECK(status IN ('accepted','rejected')),
      reason TEXT NOT NULL,
      item_id INTEGER REFERENCES items(id),
      PRIMARY KEY(import_id,line_number)
    );
    CREATE INDEX IF NOT EXISTS idx_master_import_company ON master_imports(company_id,id);
  `);
}

function parseCsv(csv) {
  if (typeof csv !== 'string' || !csv || Buffer.byteLength(csv,'utf8') > MAX_BYTES) throw bad('CSV must be UTF-8 text no larger than 128 KB');
  const result = [], row = [];
  let field = '', quoted = false, afterQuote = false, line = 1, rowLine = 1;
  const append = () => { row.push(field); field = ''; afterQuote = false; };
  const finish = () => { append(); if (row.some(value => value !== '')) result.push({line:rowLine,fields:[...row]}); row.length = 0; rowLine = line; };
  for (let index=0; index<csv.length; index+=1) {
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
  const header = result.shift().fields.map((value,index) => (index ? value : value.replace(/^\uFEFF/,'')).trim().toLowerCase());
  if (header.length !== HEADERS.length || header.some((value,index) => value !== HEADERS[index])) throw bad(`CSV columns must be: ${HEADERS.join(', ')}`);
  if (!result.length || result.length > MAX_ROWS) throw bad(`CSV must have 1 to ${MAX_ROWS} data rows`);
  return result;
}

function normalizeRow(fields,line) {
  if (fields.length !== HEADERS.length) throw bad(`Line ${line}: expected ${HEADERS.length} columns`);
  const [sku,name,hsn,unit,rate,level,tracking] = fields.map(value => value.trim());
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,49}$/.test(sku)) throw bad(`Line ${line}: sku must be 1 to 50 letters, digits, dot, slash, hyphen or underscore`);
  if (!name || name.length > 200 || /[\x00-\x1F\x7F]/.test(name) || /^[=+\-@]/.test(name)) throw bad(`Line ${line}: name must be 1 to 200 printable characters and cannot start with a spreadsheet formula operator`);
  if (!/^\d{0,12}$/.test(hsn)) throw bad(`Line ${line}: hsn must be up to 12 digits`);
  if (!unit || unit.length > 20 || /[\x00-\x1F\x7F]/.test(unit) || /^[=+\-@]/.test(unit)) throw bad(`Line ${line}: unit must be 1 to 20 printable characters and cannot start with a spreadsheet formula operator`);
  if (!/^\d+$/.test(rate) || !Number.isSafeInteger(Number(rate)) || Number(rate) > 10000) throw bad(`Line ${line}: gst_rate_bps must be 0 to 10000`);
  if (!/^\d+$/.test(level) || !Number.isSafeInteger(Number(level)) || Number(level) > 1000000) throw bad(`Line ${line}: reorder_level must be 0 to 1000000`);
  if (!/^(true|false)$/i.test(tracking)) throw bad(`Line ${line}: track_stock must be true or false`);
  return {sku,name,hsn,unit,gstRateBps:Number(rate),reorderLevel:Number(level),trackStock:tracking.toLowerCase() === 'true'};
}

function parseInput(req,db) {
  assertCompanyWideAccess(db,{companyId:req.company.id,userId:req.user.id});
  const body = req.body || {};
  const gstinId = Number(body.gstinId), branchId = Number(body.branchId);
  if (!Number.isSafeInteger(gstinId) || gstinId < 1 || !Number.isSafeInteger(branchId) || branchId < 1) throw bad('gstinId and branchId are required');
  if (!db.prepare('SELECT 1 FROM gstins WHERE id=? AND company_id=?').get(gstinId,req.company.id)) throw bad('GSTIN not found in selected company',404);
  assertScopeAccess(db,{companyId:req.company.id,userId:req.user.id,gstinId,branchId});
  if (typeof body.sourceName !== 'string' || !body.sourceName.trim() || body.sourceName.length > 120 || /[\x00-\x1F\x7F]/.test(body.sourceName)) throw bad('sourceName must be 1 to 120 printable characters');
  const sourceName = body.sourceName.trim();
  const rows = parseCsv(body.csv);
  const fileSha256 = sha256(body.csv);
  const payloadSha256 = sha256(JSON.stringify([req.company.id,gstinId,branchId,sourceName,fileSha256]));
  return {gstinId,branchId,sourceName,csv:body.csv,rows,fileSha256,payloadSha256};
}

function previewInput(db,companyId,input) {
  const seen = new Set();
  const rows = input.rows.map(({line,fields}) => {
    const base = {line,rawValues:fields};
    try {
      const item = normalizeRow(fields,line);
      const key = item.sku.toUpperCase();
      if (seen.has(key)) return {...base,...item,status:'rejected',reason:'Duplicate SKU within this CSV'};
      seen.add(key);
      const existing = db.prepare('SELECT id,sku FROM items WHERE company_id=? AND sku=? COLLATE NOCASE').get(companyId,item.sku);
      if (existing) return {...base,...item,status:'rejected',reason:`Existing company item SKU ${existing.sku} (item #${existing.id})`,itemId:existing.id};
      return {...base,...item,status:'ready',reason:'Ready to create company item master'};
    } catch (error) { return {...base,sku:fields[0]?.trim() || '',status:'rejected',reason:error.message}; }
  });
  const readyCount = rows.filter(row => row.status === 'ready').length;
  const snapshot = rows.map(row => [row.line,row.status,row.reason,row.itemId || null]);
  return {sha256:sha256(JSON.stringify([input.payloadSha256,snapshot])),fileSha256:input.fileSha256,rowCount:rows.length,readyCount,rejectedCount:rows.length-readyCount,canCommit:true,rows};
}

function detail(db,companyId,id) {
  const source = db.prepare(`SELECT m.id,m.company_id,m.gstin_id,m.branch_id,m.source_name,m.file_sha256,m.payload_sha256,
    m.row_count,m.accepted_count,m.rejected_count,m.imported_by,m.imported_at,u.name AS imported_by_name
    FROM master_imports m JOIN users u ON u.id=m.imported_by WHERE m.id=? AND m.company_id=?`).get(id,companyId);
  if (!source) throw bad('Item master import not found in selected company',404);
  const rows = db.prepare('SELECT line_number AS source_line,raw_values_json,sku,status,reason,item_id FROM master_import_rows WHERE import_id=? ORDER BY line_number').all(id)
    .map(row => ({sourceLine:row.source_line,rawValues:JSON.parse(row.raw_values_json),sku:row.sku,status:row.status,reason:row.reason,itemId:row.item_id}));
  return {import:camel(source),rows};
}

function registerMasterImportRoutes(app,db) {
  installMasterImportSchema(db);
  app.get('/api/master-imports',route(req => {
    assertCompanyWideAccess(db,{companyId:req.company.id,userId:req.user.id});
    const imports = db.prepare(`SELECT m.id,m.company_id,m.gstin_id,m.branch_id,m.source_name,m.file_sha256,
      m.row_count,m.accepted_count,m.rejected_count,m.imported_by,m.imported_at,u.name AS imported_by_name
      FROM master_imports m JOIN users u ON u.id=m.imported_by WHERE m.company_id=? ORDER BY m.id DESC LIMIT 100`).all(req.company.id).map(camel);
    return {imports};
  }));
  app.get('/api/master-imports/:id',route(req => {
    assertCompanyWideAccess(db,{companyId:req.company.id,userId:req.user.id});
    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id) || id < 1) throw bad('id must be a positive integer');
    return detail(db,req.company.id,id);
  }));
  app.get('/api/master-imports/:id/source',(req,res,next) => {
    try {
      assertCompanyWideAccess(db,{companyId:req.company.id,userId:req.user.id});
      const id = Number(req.params.id);
      if (!Number.isSafeInteger(id) || id < 1) throw bad('id must be a positive integer');
      const source = db.prepare('SELECT csv_text FROM master_imports WHERE id=? AND company_id=?').get(id,req.company.id);
      if (!source) throw bad('Item master import not found in selected company',404);
      res.type('text/csv; charset=utf-8').set('Content-Disposition',`attachment; filename="item-master-import-${id}.csv"`).send(source.csv_text);
    } catch (error) { next(error); }
  });
  app.post('/api/master-imports/preview',route(req => {
    const input = parseInput(req,db);
    const prior = db.prepare('SELECT id,preview_sha256 FROM master_imports WHERE company_id=? AND payload_sha256=?').get(req.company.id,input.payloadSha256);
    if (prior) {
      const saved = detail(db,req.company.id,prior.id);
      const rows = saved.rows.map(row => ({line:row.sourceLine,rawValues:row.rawValues,sku:row.sku,name:row.rawValues[1] || '',status:row.status,reason:row.reason,itemId:row.itemId}));
      return {preview:{sha256:prior.preview_sha256,fileSha256:input.fileSha256,rowCount:rows.length,
        readyCount:saved.import.acceptedCount,rejectedCount:saved.import.rejectedCount,canCommit:true,rows,replayOf:prior.id}};
    }
    return {preview:{...previewInput(db,req.company.id,input),replayOf:null}};
  }));
  app.post('/api/master-imports/commit',route(req => {
    if (!['accountant','admin'].includes(req.user.role)) throw bad('Accountant or admin role required',403);
    const input = parseInput(req,db);
    db.exec('BEGIN IMMEDIATE');
    try {
      const prior = db.prepare('SELECT id,preview_sha256 FROM master_imports WHERE company_id=? AND payload_sha256=?').get(req.company.id,input.payloadSha256);
      if (prior) {
        if (req.body.expectedSha256 !== prior.preview_sha256) throw bad('Preview changed; preview this exact CSV, source and scope again',409);
        const result = detail(db,req.company.id,prior.id);
        db.exec('COMMIT');
        return {...result,accepted:result.import.acceptedCount,rejected:result.import.rejectedCount,replayed:true};
      }
      const preview = previewInput(db,req.company.id,input);
      if (req.body.expectedSha256 !== preview.sha256) throw bad('Master data changed since preview; preview this CSV again',409);
      const saved = db.prepare(`INSERT INTO master_imports(company_id,gstin_id,branch_id,source_name,file_sha256,payload_sha256,preview_sha256,csv_text,row_count,accepted_count,rejected_count,imported_by)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(req.company.id,input.gstinId,input.branchId,input.sourceName,input.fileSha256,input.payloadSha256,preview.sha256,input.csv,preview.rowCount,preview.readyCount,preview.rejectedCount,req.user.id);
      const importId = Number(saved.lastInsertRowid);
      const insertItem = db.prepare('INSERT INTO items(company_id,sku,name,hsn,unit,gst_rate_bps,reorder_level,track_stock) VALUES (?,?,?,?,?,?,?,?)');
      const insertRow = db.prepare('INSERT INTO master_import_rows(import_id,line_number,raw_values_json,sku,status,reason,item_id) VALUES (?,?,?,?,?,?,?)');
      for (const row of preview.rows) {
        const itemId = row.status === 'ready' ? Number(insertItem.run(req.company.id,row.sku,row.name,row.hsn,row.unit,row.gstRateBps,row.reorderLevel,row.trackStock ? 1 : 0).lastInsertRowid) : row.itemId || null;
        const status = row.status === 'ready' ? 'accepted' : 'rejected';
        const reason = status === 'accepted' ? `Created item #${itemId} from source line ${row.line}` : row.reason;
        insertRow.run(importId,row.line,JSON.stringify(row.rawValues),row.sku,status,reason,itemId);
      }
      const result = detail(db,req.company.id,importId);
      db.exec('COMMIT');
      return {...result,accepted:preview.readyCount,rejected:preview.rejectedCount,replayed:false};
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  }));
}

module.exports = {registerMasterImportRoutes,installMasterImportSchema,parseCsv};
