const { allowedScopes, grantGstin, grantBranch, revokeGstin, revokeBranch } = require('./access.cjs');

const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const integer = (value, name) => {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) throw fail(`${name} must be a positive integer`);
  return number;
};
const route = handler => (req, res, next) => {
  try { res.json(handler(req)); } catch (error) { next(error); }
};
const admin = req => {
  if (req.user.role !== 'admin') throw fail('Company admin role required', 403);
};

function registerAccessRoutes(app, db) {
  app.get('/api/access/grants', route(req => {
    admin(req);
    const companyId = req.company.id;
    const users = db.prepare('SELECT id,name,role FROM users WHERE company_id=? ORDER BY id').all(companyId)
      .map(user => ({ ...user, ...allowedScopes(db, { companyId, userId:user.id }) }));
    const gstins = db.prepare('SELECT id,gstin,state_code FROM gstins WHERE company_id=? ORDER BY id').all(companyId);
    const branches = db.prepare('SELECT id,name,gstin_id FROM branches WHERE company_id=? ORDER BY id').all(companyId);
    const events = db.prepare(`SELECT id,user_id,actor_id,scope_type,scope_id,action,reason,created_at
      FROM access_events WHERE company_id=? ORDER BY id DESC LIMIT 100`).all(companyId);
    return { users, gstins, branches, events };
  }));

  app.post('/api/access/grants/:scope/:action', route(req => {
    admin(req);
    const { scope, action } = req.params;
    if (!['gstin','branch'].includes(scope) || !['grant','revoke'].includes(action)) throw fail('Unknown grant action', 404);
    const body = req.body || {};
    const common = { companyId:req.company.id, actorId:req.user.id,
      userId:integer(body.userId,'userId'), reason:body.reason };
    const scopeId = integer(body.scopeId,'scopeId');
    const method = { 'gstin:grant':grantGstin, 'gstin:revoke':revokeGstin,
      'branch:grant':grantBranch, 'branch:revoke':revokeBranch }[`${scope}:${action}`];
    const result = method(db, { ...common, [scope === 'gstin' ? 'gstinId' : 'branchId']:scopeId });
    return { ...result, userId:common.userId, ...allowedScopes(db,{companyId:common.companyId,userId:common.userId}) };
  }));
}

module.exports = { registerAccessRoutes };
