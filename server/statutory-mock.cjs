const { allowedScopes, assertGstinAccess, assertScopeAccess } = require('./access.cjs');
const bad = (message, status = 400) => Object.assign(new Error(message), { status });
const positiveId = (value, name) => {
  if (!Number.isSafeInteger(value) || value < 1) throw bad(`${name} must be a positive integer`);
  return value;
};
const choice = (value, name, allowed) => {
  if (!allowed.includes(value)) throw bad(`${name} is invalid`);
  return value;
};

const statusFor = {
  success: 'simulated_success',
  rejection: 'simulated_rejection',
  timeout: 'simulated_timeout',
};

const present = row => ({
  id: row.id,
  companyId: row.company_id,
  gstinId: row.gstin_id,
  kind: row.kind,
  sourceId: row.source_id,
  scenario: row.scenario,
  status: row.status,
  idempotencyKey: row.idempotency_key,
  reference: row.reference,
  simulation: true,
  request: JSON.parse(row.request_json),
  response: JSON.parse(row.response_json),
  actorId: row.actor_id,
  createdAt: row.created_at,
});

function registerStatutoryMockRoutes(app, db) {
  const hasFullGstinAccess = (companyId, gstinId, allowed) => {
    if (!allowed.gstinIds.includes(gstinId)) return false;
    const branches = db.prepare('SELECT id FROM branches WHERE company_id=? AND gstin_id=?').all(companyId, gstinId);
    return branches.every(branch => allowed.branchIds.includes(branch.id));
  };
  const requireFullGstinAccess = (companyId, userId, gstinId) => {
    assertGstinAccess(db, { companyId, userId, gstinId });
    if (!hasFullGstinAccess(companyId, gstinId, allowedScopes(db, { companyId, userId })))
      throw bad('All branches for this GSTIN are required', 403);
  };
  db.exec(`
    CREATE TABLE IF NOT EXISTS statutory_simulations (
      id INTEGER PRIMARY KEY,
      company_id INTEGER NOT NULL REFERENCES companies(id),
      gstin_id INTEGER NOT NULL REFERENCES gstins(id),
      kind TEXT NOT NULL CHECK(kind IN ('irn','eway','gst_return')),
      source_id INTEGER NOT NULL,
      scenario TEXT NOT NULL CHECK(scenario IN ('success','rejection','timeout')),
      status TEXT NOT NULL CHECK(status IN ('simulated_success','simulated_rejection','simulated_timeout')),
      idempotency_key TEXT NOT NULL,
      reference TEXT UNIQUE,
      request_json TEXT NOT NULL,
      response_json TEXT NOT NULL,
      actor_id INTEGER NOT NULL REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(company_id,idempotency_key)
    );
    CREATE INDEX IF NOT EXISTS idx_statutory_simulations_scope
      ON statutory_simulations(company_id,gstin_id,id DESC);
  `);

  const route = handler => (req, res, next) => {
    try { res.json(handler(req)); } catch (error) { next(error); }
  };

  app.post('/api/simulations', route(req => {
    const body = req.body;
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw bad('Request body must be an object');
    const kind = choice(body.kind, 'kind', ['irn', 'eway', 'gst_return']);
    const gstinId = positiveId(body.gstinId, 'gstinId');
    const sourceId = positiveId(body.sourceId, 'sourceId');
    const scenario = choice(body.scenario, 'scenario', Object.keys(statusFor));
    const idempotencyKey = body.idempotencyKey;
    if (typeof idempotencyKey !== 'string' || !idempotencyKey.trim() || idempotencyKey.length > 128)
      throw bad('idempotencyKey must be a nonempty string of at most 128 characters');
    if (kind === 'gst_return' && !['accountant', 'admin'].includes(req.user.role))
      throw bad('Accountant or admin role required', 403);

    const request = { kind, gstinId, sourceId, scenario };
    const requestJson = JSON.stringify(request);
    const key = idempotencyKey.trim();
    const companyId = req.company.id;
    const gstin = db.prepare('SELECT id FROM gstins WHERE id=? AND company_id=?').get(gstinId, companyId);
    if (!gstin) throw bad('GSTIN not found in selected company', 404);
    assertGstinAccess(db,{companyId,userId:req.user.id,gstinId});
    if (kind === 'gst_return') {
      requireFullGstinAccess(companyId, req.user.id, gstinId);
      const period = db.prepare('SELECT id,status FROM gst_periods WHERE id=? AND company_id=? AND gstin_id=?').get(sourceId, companyId, gstinId);
      if (!period) throw bad('GST period not found for selected GSTIN and company', 404);
      if (period.status !== 'approved') throw bad('GST period must be internally approved', 409);
    } else {
      const invoice = db.prepare('SELECT id,status,type,branch_id FROM invoices WHERE id=? AND company_id=? AND gstin_id=?').get(sourceId, companyId, gstinId);
      if (!invoice) throw bad('Invoice not found for selected GSTIN and company', 404);
      assertScopeAccess(db,{companyId,userId:req.user.id,gstinId,branchId:invoice.branch_id});
      if (invoice.status !== 'approved' || invoice.type !== 'sale') throw bad('Simulation requires an approved sales invoice', 409);
    }
    const existing = db.prepare('SELECT * FROM statutory_simulations WHERE company_id=? AND idempotency_key=?').get(companyId, key);
    if (existing) {
      if (existing.request_json !== requestJson) throw bad('Idempotency key already used for a different simulation request', 409);
      return { simulation: present(existing), replayed: true };
    }

    db.exec('BEGIN IMMEDIATE');
    try {
      const status = statusFor[scenario];
      const response = { simulation: true, status, reference: null,
        message: scenario === 'success' ? 'Demo response accepted' : scenario === 'rejection' ? 'Demo response rejected' : 'Demo response timed out' };
      const result = db.prepare(`INSERT INTO statutory_simulations
        (company_id,gstin_id,kind,source_id,scenario,status,idempotency_key,request_json,response_json,actor_id)
        VALUES (?,?,?,?,?,?,?,?,?,?)`).run(companyId, gstinId, kind, sourceId, scenario, status, key, requestJson, JSON.stringify(response), req.user.id);
      const id = Number(result.lastInsertRowid);
      const reference = `SIM-${kind.toUpperCase().replace('_', '-')}-${String(companyId).padStart(2, '0')}-${String(id).padStart(6, '0')}`;
      db.prepare('UPDATE statutory_simulations SET reference=?,response_json=? WHERE id=?')
        .run(reference, JSON.stringify({ ...response, reference }), id);
      const row = db.prepare('SELECT * FROM statutory_simulations WHERE id=?').get(id);
      db.exec('COMMIT');
      return { simulation: present(row), replayed: false };
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }));

  app.get('/api/simulations', route(req => {
    let gstinId = null;
    if (req.query.gstinId !== undefined) {
      if (typeof req.query.gstinId !== 'string' || !/^[1-9]\d*$/.test(req.query.gstinId)) throw bad('gstinId must be a positive integer');
      gstinId = positiveId(Number(req.query.gstinId), 'gstinId');
      if (!db.prepare('SELECT 1 FROM gstins WHERE id=? AND company_id=?').get(gstinId, req.company.id))
        throw bad('GSTIN not found in selected company', 404);
      assertGstinAccess(db,{companyId:req.company.id,userId:req.user.id,gstinId});
    }
    const allowed = allowedScopes(db,{companyId:req.company.id,userId:req.user.id});
    const rows = db.prepare(`SELECT * FROM statutory_simulations WHERE company_id=?
      AND (? IS NULL OR gstin_id=?) ORDER BY id DESC`).all(req.company.id, gstinId, gstinId);
    return { simulations: rows.filter(row => {
      if (!allowed.gstinIds.includes(row.gstin_id)) return false;
      if (row.kind === 'gst_return') return hasFullGstinAccess(req.company.id, row.gstin_id, allowed);
      const invoice = db.prepare('SELECT branch_id FROM invoices WHERE id=? AND company_id=? AND gstin_id=?').get(row.source_id,req.company.id,row.gstin_id);
      return invoice && allowed.branchIds.includes(invoice.branch_id);
    }).map(present) };
  }));
}

module.exports = { registerStatutoryMockRoutes };
