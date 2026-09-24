const { createHash } = require('node:crypto');
const { TextDecoder } = require('node:util');
const { allowedScopes, assertScopeAccess } = require('./access.cjs');

const MAX_BYTES = 128 * 1024;
const TYPES = { 'application/pdf':'.pdf', 'image/png':'.png', 'image/jpeg':'.jpg', 'text/plain':'.txt' };
const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const id = (value, name = 'id') => {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 1) throw fail(`${name} must be a positive integer`);
  return n;
};
const str = (value, name, max = 200, required = true) => {
  if (typeof value !== 'string' || value.length > max || (required && !value.trim())) throw fail(`${name} is invalid`);
  return value.trim();
};
const camel = row => Object.fromEntries(Object.entries(row).map(([key, value]) => [key.replace(/_([a-z])/g, (_, x) => x.toUpperCase()), value]));
const route = handler => (req, res, next) => { try { handler(req, res); } catch (error) { next(error); } };

function validateFile(body) {
  const fileName = str(body.fileName, 'fileName', 120);
  if (fileName.includes('/') || fileName.includes('\\') || /[\x00-\x1f\x7f]/.test(fileName) || fileName === '.' || fileName === '..') throw fail('fileName must be a plain safe file name');
  const mimeType = str(body.mimeType, 'mimeType', 80);
  const extension = TYPES[mimeType];
  if (!extension) throw fail('File type must be PDF, PNG, JPEG, or plain text');
  if (!(fileName.toLowerCase().endsWith(extension) || (mimeType === 'image/jpeg' && fileName.toLowerCase().endsWith('.jpeg')))) throw fail('File extension does not match MIME type');
  const base64 = body.contentBase64;
  if (typeof base64 !== 'string' || !base64 || base64.length > Math.ceil(MAX_BYTES / 3) * 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(base64)) throw fail('contentBase64 must contain a valid file of at most 128 KiB');
  const content = Buffer.from(base64, 'base64');
  if (!content.length || content.length > MAX_BYTES || content.toString('base64') !== base64) throw fail('File size or encoding is invalid');
  if (mimeType === 'application/pdf' && content.subarray(0, 5).toString() !== '%PDF-') throw fail('PDF content signature is invalid');
  if (mimeType === 'image/png' && !content.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) throw fail('PNG content signature is invalid');
  if (mimeType === 'image/jpeg' && !(content[0] === 0xff && content[1] === 0xd8 && content.at(-2) === 0xff && content.at(-1) === 0xd9)) throw fail('JPEG content signature is invalid');
  if (mimeType === 'text/plain') {
    if (content.includes(0)) throw fail('Text file contains binary bytes');
    try { new TextDecoder('utf-8', { fatal:true }).decode(content); } catch { throw fail('Text file must be UTF-8'); }
  }
  return { fileName, mimeType, content, byteSize:content.length, sha256:createHash('sha256').update(content).digest('hex') };
}

function registerEvidenceRoutes(app, db) {
  const document = (req) => {
    const row = db.prepare('SELECT * FROM evidence_documents WHERE id=? AND company_id=?').get(id(req.params.id), req.company.id);
    if (!row) throw fail('Evidence document not found in selected company', 404);
    validateTarget(row.company_id, row.gstin_id, row.branch_id, row.target_type, row.target_id);
    assertScopeAccess(db,{companyId:req.company.id,userId:req.user.id,gstinId:row.gstin_id,branchId:row.branch_id});
    return row;
  };
  const version = (documentId, number) => db.prepare('SELECT * FROM evidence_versions WHERE document_id=? AND version=?').get(documentId, number);
  const latest = documentId => db.prepare('SELECT * FROM evidence_versions WHERE document_id=? ORDER BY version DESC LIMIT 1').get(documentId);
  const metadata = row => { const { content, ...rest } = row; return camel(rest); };
  const detail = row => ({ ...camel(row), versions:db.prepare('SELECT * FROM evidence_versions WHERE document_id=? ORDER BY version DESC').all(row.id).map(metadata) });
  const validateScope = (companyId, gstinId, branchId) => {
    const branch = db.prepare('SELECT b.id FROM branches b JOIN gstins g ON g.id=b.gstin_id WHERE b.id=? AND b.company_id=? AND b.gstin_id=? AND g.company_id=?').get(branchId, companyId, gstinId, companyId);
    if (!branch) throw fail('Branch and GSTIN must belong to selected company and match each other');
  };
  const validateTarget = (companyId, gstinId, branchId, targetType, targetId) => {
    const table = targetType === 'invoice' ? 'invoices' : targetType === 'workflow_case' ? 'workflow_cases' : null;
    if (!table) throw fail('targetType must be invoice or workflow_case');
    const target = db.prepare(`SELECT id FROM ${table} WHERE id=? AND company_id=? AND gstin_id=? AND branch_id=?`).get(targetId,companyId,gstinId,branchId);
    if (!target) throw fail('Linked record not found in selected company, GSTIN and branch',404);
  };
  const insertVersion = (documentId, number, file, userId) => {
    db.prepare('INSERT INTO evidence_versions(document_id,version,file_name,mime_type,byte_size,sha256,content,uploaded_by) VALUES (?,?,?,?,?,?,?,?)')
      .run(documentId,number,file.fileName,file.mimeType,file.byteSize,file.sha256,file.content,userId);
  };

  app.get('/api/evidence', route((req,res) => {
    const gstinId = req.query.gstinId === undefined ? null : id(req.query.gstinId,'gstinId');
    const branchId = req.query.branchId === undefined ? null : id(req.query.branchId,'branchId');
    if (gstinId && !db.prepare('SELECT 1 FROM gstins WHERE id=? AND company_id=?').get(gstinId,req.company.id)) throw fail('GSTIN not found in selected company',404);
    if (branchId && !db.prepare('SELECT 1 FROM branches WHERE id=? AND company_id=?').get(branchId,req.company.id)) throw fail('Branch not found in selected company',404);
    if (gstinId || branchId) assertScopeAccess(db,{companyId:req.company.id,userId:req.user.id,
      ...(gstinId ? {gstinId} : {}),...(branchId ? {branchId} : {})});
    const allowed = allowedScopes(db,{companyId:req.company.id,userId:req.user.id});
    const targetType = req.query.targetType === undefined ? null : str(req.query.targetType,'targetType',30);
    if (targetType && !['invoice','workflow_case'].includes(targetType)) throw fail('Invalid targetType');
    const targetId = req.query.targetId === undefined ? null : id(req.query.targetId,'targetId');
    const rows = db.prepare(`SELECT d.*, v.version, v.file_name, v.mime_type, v.byte_size, v.sha256, v.status, v.uploaded_by, v.uploaded_at, v.reviewed_by, v.reviewed_at, v.review_reason
      FROM evidence_documents d JOIN evidence_versions v ON v.document_id=d.id AND v.version=(SELECT MAX(version) FROM evidence_versions WHERE document_id=d.id)
      WHERE d.company_id=? AND (? IS NULL OR d.gstin_id=?) AND (? IS NULL OR d.branch_id=?) AND (? IS NULL OR d.target_type=?) AND (? IS NULL OR d.target_id=?) ORDER BY d.id DESC`)
      .all(req.company.id,gstinId,gstinId,branchId,branchId,targetType,targetType,targetId,targetId).map(camel);
    res.json({ documents:rows.filter(row => allowed.gstinIds.includes(row.gstinId) && allowed.branchIds.includes(row.branchId)) });
  }));

  app.post('/api/evidence', route((req,res) => {
    const body = req.body || {};
    const gstinId = id(body.gstinId,'gstinId'), branchId = id(body.branchId,'branchId'), targetId = id(body.targetId,'targetId');
    const targetType = str(body.targetType,'targetType',30), title = str(body.title,'title',160);
    const audience = body.audience ?? 'internal';
    if (!['internal','client'].includes(audience)) throw fail('audience must be internal or client');
    validateScope(req.company.id,gstinId,branchId);
    assertScopeAccess(db,{companyId:req.company.id,userId:req.user.id,gstinId,branchId});
    validateTarget(req.company.id,gstinId,branchId,targetType,targetId);
    const file = validateFile(body);
    db.exec('BEGIN IMMEDIATE');
    try {
      const documentId = Number(db.prepare('INSERT INTO evidence_documents(company_id,gstin_id,branch_id,title,audience,target_type,target_id,created_by) VALUES (?,?,?,?,?,?,?,?)')
        .run(req.company.id,gstinId,branchId,title,audience,targetType,targetId,req.user.id).lastInsertRowid);
      insertVersion(documentId,1,file,req.user.id);
      db.exec('COMMIT');
      res.json({ document:detail(db.prepare('SELECT * FROM evidence_documents WHERE id=?').get(documentId)) });
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  }));

  app.get('/api/evidence/:id', route((req,res) => res.json({ document:detail(document(req)) })));

  app.post('/api/evidence/:id/versions', route((req,res) => {
    const current = document(req), file = validateFile(req.body || {});
    const nextVersion = latest(current.id).version + 1;
    insertVersion(current.id,nextVersion,file,req.user.id);
    res.json({ document:detail(current) });
  }));

  app.get('/api/evidence/:id/download', route((req,res) => {
    const current = document(req);
    const number = req.query.version === undefined ? latest(current.id).version : id(req.query.version,'version');
    const file = version(current.id,number);
    if (!file) throw fail('Evidence version not found',404);
    const safeName = file.file_name.replace(/[^A-Za-z0-9._-]/g,'_');
    res.set({ 'Content-Type':file.mime_type, 'Content-Length':String(file.byte_size), 'Content-Disposition':`attachment; filename="${safeName}"`, 'X-Content-Type-Options':'nosniff', 'Cache-Control':'private, no-store' });
    res.send(file.content);
  }));

  app.post('/api/evidence/:id/review', route((req,res) => {
    if (!['accountant','admin'].includes(req.user.role)) throw fail('Accountant or admin role required',403);
    const current = document(req);
    const expectedVersion = id(req.body?.expectedVersion,'expectedVersion');
    const expectedSha256 = req.body?.expectedSha256;
    if (typeof expectedSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(expectedSha256)) throw fail('expectedSha256 must be a SHA-256 hex digest');
    const file = latest(current.id);
    const decision = req.body?.decision;
    if (!['approved','rejected'].includes(decision)) throw fail('decision must be approved or rejected');
    if (file.version !== expectedVersion || file.sha256 !== expectedSha256) throw fail('Evidence has changed; reload and review the current version',409);
    if (file.status !== 'pending') throw fail('Latest evidence version has already been reviewed',409);
    if (file.uploaded_by === req.user.id) throw fail('Uploader cannot review their own evidence version',403);
    const reason = str(req.body?.reason ?? '','reason',500,false);
    if (decision === 'rejected' && !reason) throw fail('Rejection reason is required');
    const updated = db.prepare(`UPDATE evidence_versions SET status=?,review_reason=?,reviewed_by=?,reviewed_at=CURRENT_TIMESTAMP
      WHERE id=? AND document_id=? AND version=? AND sha256=? AND status='pending' AND uploaded_by<>?
      AND version=(SELECT MAX(version) FROM evidence_versions WHERE document_id=?)`)
      .run(decision,reason,req.user.id,file.id,current.id,expectedVersion,expectedSha256,req.user.id,current.id);
    if (updated.changes !== 1) throw fail('Evidence has changed; reload and review the current version',409);
    res.json({ document:detail(current) });
  }));
}

module.exports = { registerEvidenceRoutes };
