const error = (message,status) => Object.assign(new Error(message),{status});

function id(value,name) {
  if (!Number.isSafeInteger(value) || value < 1) throw error(`${name} must be a positive integer`,400);
  return value;
}

function reason(value) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 500) {
    throw error('Access change reason must be 1 to 500 characters',400);
  }
  return value.trim();
}

function member(db,companyId,userId) {
  const row = db.prepare('SELECT * FROM users WHERE id=? AND company_id=?').get(id(userId,'userId'),id(companyId,'companyId'));
  if (!row) throw error('User is not a member of selected company',403);
  return row;
}

function administrator(db,companyId,actorId) {
  const row = member(db,companyId,actorId);
  if (row.role !== 'admin') throw error('Company admin role required to change scope grants',403);
  return row;
}

function scopeRow(db,table,scopeId,companyId,name) {
  const row = db.prepare(`SELECT * FROM ${table} WHERE id=? AND company_id=?`).get(id(scopeId,`${name}Id`),companyId);
  if (!row) throw error(`${name} not found in selected company`,404);
  return row;
}

function allowedScopes(db,{companyId,userId}) {
  member(db,companyId,userId);
  const gstinIds = db.prepare(`SELECT g.gstin_id AS id FROM user_gstin_grants g
    JOIN gstins s ON s.id=g.gstin_id AND s.company_id=g.company_id
    WHERE g.company_id=? AND g.user_id=? AND g.revoked_at IS NULL ORDER BY g.gstin_id`)
    .all(companyId,userId).map(row => row.id);
  const branchIds = db.prepare(`SELECT b.branch_id AS id FROM user_branch_grants b
    JOIN branches s ON s.id=b.branch_id AND s.company_id=b.company_id
    JOIN user_gstin_grants g ON g.company_id=b.company_id AND g.user_id=b.user_id
      AND g.gstin_id=s.gstin_id AND g.revoked_at IS NULL
    WHERE b.company_id=? AND b.user_id=? AND b.revoked_at IS NULL ORDER BY b.branch_id`)
    .all(companyId,userId).map(row => row.id);
  return { gstinIds, branchIds };
}

function assertCompanyWideAccess(db,{companyId,userId}) {
  const allowed = allowedScopes(db,{companyId,userId});
  const gstinCount = db.prepare('SELECT COUNT(*) AS count FROM gstins WHERE company_id=?').get(companyId).count;
  const branchCount = db.prepare('SELECT COUNT(*) AS count FROM branches WHERE company_id=?').get(companyId).count;
  if (allowed.gstinIds.length !== gstinCount || allowed.branchIds.length !== branchCount) {
    throw error('Full company scope is required',403);
  }
  return allowed;
}

function assertGstinAccess(db,{companyId,userId,gstinId}) {
  member(db,companyId,userId);
  const row = scopeRow(db,'gstins',gstinId,companyId,'GSTIN');
  if (!db.prepare('SELECT 1 FROM user_gstin_grants WHERE company_id=? AND user_id=? AND gstin_id=? AND revoked_at IS NULL')
    .get(companyId,userId,gstinId)) throw error('GSTIN access is not granted',403);
  return row;
}

function assertBranchAccess(db,{companyId,userId,branchId}) {
  member(db,companyId,userId);
  const row = scopeRow(db,'branches',branchId,companyId,'Branch');
  assertGstinAccess(db,{companyId,userId,gstinId:row.gstin_id});
  if (!db.prepare('SELECT 1 FROM user_branch_grants WHERE company_id=? AND user_id=? AND branch_id=? AND revoked_at IS NULL')
    .get(companyId,userId,branchId)) throw error('Branch access is not granted',403);
  return row;
}

function assertScopeAccess(db,{companyId,userId,gstinId,branchId}) {
  if (gstinId === undefined && branchId === undefined) throw error('GSTIN or branch scope is required',400);
  if (branchId === undefined) return assertGstinAccess(db,{companyId,userId,gstinId});
  const branch = scopeRow(db,'branches',branchId,id(companyId,'companyId'),'Branch');
  if (gstinId !== undefined && branch.gstin_id !== id(gstinId,'gstinId')) {
    throw error('Branch does not belong to selected GSTIN',400);
  }
  return assertBranchAccess(db,{companyId,userId,branchId});
}

function atomic(db,name,action) {
  db.exec(`SAVEPOINT ${name}`);
  try {
    const result = action();
    db.exec(`RELEASE ${name}`);
    return result;
  } catch (cause) {
    db.exec(`ROLLBACK TO ${name}`);
    db.exec(`RELEASE ${name}`);
    throw cause;
  }
}

function event(db,{companyId,userId,actorId,type,scopeId,action,explanation}) {
  db.prepare('INSERT INTO access_events(company_id,user_id,actor_id,scope_type,scope_id,action,reason) VALUES (?,?,?,?,?,?,?)')
    .run(companyId,userId,actorId,type,scopeId,action,explanation);
}

function grantGstin(db,{companyId,actorId,userId,gstinId,reason:why}) {
  return atomic(db,'grant_gstin',() => {
    administrator(db,companyId,actorId); member(db,companyId,userId);
    const row = scopeRow(db,'gstins',gstinId,companyId,'GSTIN');
    const explanation = reason(why);
    if (db.prepare('SELECT 1 FROM user_gstin_grants WHERE company_id=? AND user_id=? AND gstin_id=? AND revoked_at IS NULL').get(companyId,userId,gstinId)) return {changed:false,gstin:row};
    db.prepare('INSERT INTO user_gstin_grants(company_id,user_id,gstin_id,granted_by,reason) VALUES (?,?,?,?,?)')
      .run(companyId,userId,gstinId,actorId,explanation);
    event(db,{companyId,userId,actorId,type:'gstin',scopeId:gstinId,action:'grant',explanation});
    return {changed:true,gstin:row};
  });
}

function grantBranch(db,{companyId,actorId,userId,branchId,reason:why}) {
  return atomic(db,'grant_branch',() => {
    administrator(db,companyId,actorId); member(db,companyId,userId);
    const row = scopeRow(db,'branches',branchId,companyId,'Branch');
    const explanation = reason(why);
    if (!db.prepare('SELECT 1 FROM user_gstin_grants WHERE company_id=? AND user_id=? AND gstin_id=? AND revoked_at IS NULL')
      .get(companyId,userId,row.gstin_id)) throw error('Grant parent GSTIN access before branch access',409);
    if (db.prepare('SELECT 1 FROM user_branch_grants WHERE company_id=? AND user_id=? AND branch_id=? AND revoked_at IS NULL').get(companyId,userId,branchId)) return {changed:false,branch:row};
    db.prepare('INSERT INTO user_branch_grants(company_id,user_id,branch_id,granted_by,reason) VALUES (?,?,?,?,?)')
      .run(companyId,userId,branchId,actorId,explanation);
    event(db,{companyId,userId,actorId,type:'branch',scopeId:branchId,action:'grant',explanation});
    return {changed:true,branch:row};
  });
}

function revokeBranch(db,{companyId,actorId,userId,branchId,reason:why}) {
  return atomic(db,'revoke_branch',() => {
    administrator(db,companyId,actorId); member(db,companyId,userId);
    const row = scopeRow(db,'branches',branchId,companyId,'Branch');
    const explanation = reason(why);
    const result = db.prepare(`UPDATE user_branch_grants SET revoked_by=?,revoked_at=CURRENT_TIMESTAMP,revoked_reason=?
      WHERE company_id=? AND user_id=? AND branch_id=? AND revoked_at IS NULL`)
      .run(actorId,explanation,companyId,userId,branchId);
    if (result.changes) event(db,{companyId,userId,actorId,type:'branch',scopeId:branchId,action:'revoke',explanation});
    return {changed:Boolean(result.changes),branch:row};
  });
}

function revokeGstin(db,{companyId,actorId,userId,gstinId,reason:why}) {
  return atomic(db,'revoke_gstin',() => {
    administrator(db,companyId,actorId); member(db,companyId,userId);
    const row = scopeRow(db,'gstins',gstinId,companyId,'GSTIN');
    const explanation = reason(why);
    const branches = db.prepare(`SELECT b.id FROM branches b JOIN user_branch_grants g
      ON g.branch_id=b.id AND g.company_id=b.company_id
      WHERE b.company_id=? AND b.gstin_id=? AND g.user_id=? AND g.revoked_at IS NULL ORDER BY b.id`)
      .all(companyId,gstinId,userId);
    for (const branch of branches) revokeBranch(db,{companyId,actorId,userId,branchId:branch.id,reason:explanation});
    const result = db.prepare(`UPDATE user_gstin_grants SET revoked_by=?,revoked_at=CURRENT_TIMESTAMP,revoked_reason=?
      WHERE company_id=? AND user_id=? AND gstin_id=? AND revoked_at IS NULL`)
      .run(actorId,explanation,companyId,userId,gstinId);
    if (result.changes) event(db,{companyId,userId,actorId,type:'gstin',scopeId:gstinId,action:'revoke',explanation});
    return {changed:Boolean(result.changes),gstin:row,revokedBranches:branches.map(branch => branch.id)};
  });
}

module.exports = { allowedScopes, assertCompanyWideAccess, assertGstinAccess, assertBranchAccess, assertScopeAccess,
  grantGstin, grantBranch, revokeGstin, revokeBranch };
