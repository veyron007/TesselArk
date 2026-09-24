const { assertScopeAccess } = require('./access.cjs');

const invalid = (message, status = 400) => Object.assign(new Error(message), { status });

function optionalId(value, name) {
  if (value === undefined) return null;
  if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value))) {
    throw invalid(`${name} must be a positive integer`);
  }
  return Number(value);
}

function registerWorkspaceMenuRoutes(app, db) {
  app.get('/api/workspace-menu', (req, res, next) => {
    try {
      const companyId = req.company.id;
      const gstinId = optionalId(req.query.gstinId, 'gstinId');
      const branchId = optionalId(req.query.branchId, 'branchId');
      if (gstinId || branchId) assertScopeAccess(db, {
        companyId, userId:req.user.id,
        ...(gstinId ? { gstinId } : {}),
        ...(branchId ? { branchId } : {}),
      });

      const gstins = db.prepare('SELECT id,gstin,state_code FROM gstins WHERE company_id=? ORDER BY id')
        .all(companyId).filter(row => req.scopes.gstinIds.includes(row.id))
        .map(row => ({ id:row.id, gstin:row.gstin, stateCode:row.state_code }));
      const branches = db.prepare('SELECT id,name,gstin_id FROM branches WHERE company_id=? ORDER BY id')
        .all(companyId).filter(row => req.scopes.branchIds.includes(row.id))
        .map(row => ({ id:row.id, name:row.name, gstinId:row.gstin_id }));
      const canReview = ['accountant', 'admin'].includes(req.user.role);
      const permittedBranchIds = branches.filter(row =>
        (!branchId || row.id === branchId) && (!gstinId || row.gstinId === gstinId)).map(row => row.id);
      const submittedInvoices = canReview && permittedBranchIds.length ? db.prepare(`SELECT COUNT(*) AS count
        FROM invoices WHERE company_id=? AND status='submitted'
        AND branch_id IN (${permittedBranchIds.map(() => '?').join(',')})
        AND created_by<>? AND submitted_by<>?`)
        .get(companyId, ...permittedBranchIds, req.user.id, req.user.id).count : 0;
      const pendingTaxPolicies = canReview && branches.length ? db.prepare(`SELECT COUNT(*) AS count
        FROM gst_item_tax_policies WHERE company_id=? AND status='pending' AND created_by<>?`)
        .get(companyId, req.user.id).count : 0;
      res.json({ work:{ submittedInvoices, pendingTaxPolicies }, access:{ gstins, branches } });
    } catch (error) { next(error); }
  });
}

module.exports = { registerWorkspaceMenuRoutes };
