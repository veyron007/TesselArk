const { createHash } = require('node:crypto');
const { installWorkTasksSchema } = require('./work-tasks-db.cjs');

const text = (value) => Buffer.from(value, 'utf8');
const sha256 = (content) => createHash('sha256').update(content).digest('hex');
const generationHash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

const checklist = (steps) => JSON.stringify(steps.map(([key, label]) => ({ key, label })));
const periodRange = (period) => {
  const [year, month] = period.split('-').map(Number);
  return { start: `${period}-01`, end: new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10) };
};

function ensureTemplate(db, spec) {
  const existing = db.prepare(`SELECT t.id FROM work_templates t
    JOIN work_template_versions v ON v.template_id=t.id
    WHERE t.company_id=? AND t.gstin_id=? AND COALESCE(t.branch_id,0)=COALESCE(?,0)
      AND t.scope_type=? AND v.obligation_key=?
    ORDER BY t.id LIMIT 1`).get(spec.companyId, spec.gstinId, spec.branchId, spec.scopeType, spec.obligationKey);
  if (existing) return existing.id;
  const id = Number(db.prepare('INSERT INTO work_templates(company_id,gstin_id,branch_id,scope_type,created_by) VALUES (?,?,?,?,?)')
    .run(spec.companyId, spec.gstinId, spec.branchId, spec.scopeType, spec.createdBy).lastInsertRowid);
  db.prepare(`INSERT INTO work_template_versions(template_id,version,title,obligation_key,recurrence,checklist_json,dependency_template_ids_json,
    status,created_by,approved_by,approved_at,approval_reason) VALUES (?,1,?,?,?,?,?,'approved',?,?,CURRENT_TIMESTAMP,?)`)
    .run(id, spec.title, spec.obligationKey, spec.recurrence, checklist(spec.checklist), JSON.stringify([]), spec.createdBy, spec.approvedBy, spec.approvalReason);
  return id;
}

function templateVersion(db, templateId) {
  return db.prepare('SELECT * FROM work_template_versions WHERE template_id=? ORDER BY version DESC LIMIT 1').get(templateId);
}

function ensureTask(db, spec) {
  const existing = db.prepare('SELECT id FROM work_tasks WHERE template_id=? AND period=?').get(spec.templateId, spec.period);
  if (existing) return existing.id;
  const version = templateVersion(db, spec.templateId);
  const range = periodRange(spec.period);
  const sourcePeriodId = spec.scopeType === 'gstin'
    ? db.prepare('SELECT id FROM gst_periods WHERE company_id=? AND gstin_id=? AND period=?').get(spec.companyId, spec.gstinId, spec.period)?.id || null
    : null;
  if (spec.scopeType === 'gstin' && !sourcePeriodId) throw new Error(`Missing GST period source for ${spec.companyId}:${spec.gstinId}:${spec.period}`);
  const config = {
    templateId: spec.templateId,
    templateVersion: version.version,
    period: spec.period,
    preparerUserId: spec.preparerUserId,
    reviewerUserId: spec.reviewerUserId,
    internalTargetDate: spec.internalTargetDate,
    statutoryDueDate: null,
    statutoryBasis: null,
  };
  const id = Number(db.prepare(`INSERT INTO work_tasks(company_id,gstin_id,branch_id,scope_type,template_id,source_period_id,template_version,title,obligation_key,
    period,period_start,period_end,status,version,preparer_user_id,reviewer_user_id,internal_target_date,statutory_due_date,statutory_basis_json,
    checklist_json,completed_checklist_keys_json,dependency_task_ids_json,generation_hash,created_by,submitted_by,submitted_at,closed_by,closed_at,
    closure_evidence_id,closure_evidence_version,closure_evidence_sha256) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(spec.companyId, spec.gstinId, spec.branchId, spec.scopeType, spec.templateId, sourcePeriodId, version.version, version.title, version.obligation_key,
      spec.period, range.start, range.end, spec.status, spec.version, spec.preparerUserId, spec.reviewerUserId, spec.internalTargetDate, null, null,
      version.checklist_json, JSON.stringify(spec.completedChecklistKeys || []), JSON.stringify([]), generationHash(config), spec.createdBy,
      spec.submittedBy || null, spec.submittedAt || null, spec.closedBy || null, spec.closedAt || null, null, null, null).lastInsertRowid);
  for (const event of spec.events) {
    db.prepare('INSERT INTO work_task_events(task_id,action,details,actor_id) VALUES (?,?,?,?)')
      .run(id, event.action, event.details, event.actorId);
  }
  return id;
}

function addEvidence(db, taskId, spec) {
  if (db.prepare('SELECT 1 FROM work_task_evidence WHERE task_id=? AND version=?').get(taskId, spec.version)) return;
  const content = text(spec.content);
  const digest = sha256(content);
  db.prepare(`INSERT INTO work_task_evidence(task_id,version,file_name,mime_type,byte_size,sha256,content,status,uploaded_by,reviewed_by,reviewed_at,review_reason)
    VALUES (?,?,?,?,?,?,?,?,?,?,CASE WHEN ? IS NULL THEN NULL ELSE CURRENT_TIMESTAMP END,?)`)
    .run(taskId, spec.version, spec.fileName, 'text/plain', content.length, digest, content, spec.status, spec.uploadedBy,
      spec.reviewedBy || null, spec.reviewedBy || null, spec.reviewReason || '');
  db.prepare('INSERT INTO work_task_events(task_id,action,details,actor_id) VALUES (?,?,?,?)')
    .run(taskId, 'evidence_uploaded', `Synthetic evidence ${spec.fileName} recorded as ${spec.status}.`, spec.uploadedBy);
  if (spec.reviewedBy) {
    db.prepare('INSERT INTO work_task_events(task_id,action,details,actor_id) VALUES (?,?,?,?)')
      .run(taskId, 'evidence_reviewed', spec.reviewReason || 'Synthetic evidence reviewed.', spec.reviewedBy);
  }
}

function closeWithEvidence(db, taskId, actorId) {
  const evidence = db.prepare("SELECT * FROM work_task_evidence WHERE task_id=? AND status='approved' ORDER BY version DESC LIMIT 1").get(taskId);
  if (!evidence) return;
  db.prepare(`UPDATE work_tasks SET closure_evidence_id=?,closure_evidence_version=?,closure_evidence_sha256=?
    WHERE id=? AND closure_evidence_id IS NULL`).run(evidence.id, evidence.version, evidence.sha256, taskId);
  if (!db.prepare("SELECT 1 FROM work_task_events WHERE task_id=? AND action='closed'").get(taskId)) {
    db.prepare('INSERT INTO work_task_events(task_id,action,details,actor_id) VALUES (?,?,?,?)')
      .run(taskId, 'closed', 'Closed with approved synthetic internal work evidence. No filing or statutory submission occurred.', actorId);
  }
}

function seedWorkTasksDemo(db) {
  installWorkTasksSchema(db);
  if (!db.prepare('SELECT 1 FROM companies WHERE id=1').get()) return { seeded:false };
  db.exec('SAVEPOINT seed_work_tasks_demo');
  try {
    const gstTemplate = ensureTemplate(db, {
      companyId:1, gstinId:1, branchId:null, scopeType:'gstin', createdBy:2, approvedBy:3,
      title:'DEMO WORK: Aster Maharashtra GST period preparation',
      obligationKey:'DEMO-WORK-GST-PREP', recurrence:'monthly',
      approvalReason:'Approved synthetic recurring checklist for local demo work only.',
      checklist:[
        ['reconcile_itc', 'Reconcile local sales, purchase evidence and ITC review signals'],
        ['review_exceptions', 'Confirm unresolved exceptions and owner assignments'],
        ['assemble_pack', 'Attach internal review pack evidence before closure'],
      ],
    });
    const puneTemplate = ensureTemplate(db, {
      companyId:1, gstinId:1, branchId:2, scopeType:'branch', createdBy:2, approvedBy:3,
      title:'DEMO WORK: Pune consumer-health supply follow-up',
      obligationKey:'DEMO-WORK-CHD-PUNE-SUPPLY', recurrence:'monthly',
      approvalReason:'Approved synthetic branch supply checklist for local demo work only.',
      checklist:[
        ['check_orders', 'Review fictional consumer-health sale orders and replenishment signals'],
        ['assign_followup', 'Assign unresolved supplier or delivery follow-up'],
      ],
    });
    const blrTemplate = ensureTemplate(db, {
      companyId:1, gstinId:2, branchId:3, scopeType:'branch', createdBy:2, approvedBy:3,
      title:'DEMO WORK: Bengaluru consumer-health evidence closure',
      obligationKey:'DEMO-WORK-CHD-BLR-SUPPLY', recurrence:'monthly',
      approvalReason:'Approved synthetic Bengaluru supply checklist for local demo work only.',
      checklist:[
        ['review_sources', 'Review fictional consumer-health purchase and dispatch sources'],
        ['attach_evidence', 'Attach internal closure evidence when complete'],
      ],
    });

    const closed = ensureTask(db, {
      companyId:1, gstinId:1, branchId:2, scopeType:'branch', templateId:puneTemplate, period:'2026-08',
      status:'closed', version:4, preparerUserId:1, reviewerUserId:2, internalTargetDate:'2026-09-05',
      completedChecklistKeys:['check_orders','assign_followup'], createdBy:2, submittedBy:1,
      submittedAt:'2026-09-04 10:00:00', closedBy:2, closedAt:'2026-09-05 15:00:00',
      events:[
        { action:'generated', details:'Generated from approved Pune supply template v1 for 2026-08.', actorId:2 },
        { action:'prepared', details:'Maya completed the fictional Pune consumer-health supply follow-up checklist.', actorId:1 },
        { action:'submitted', details:'Submitted Pune branch work to Dev Accountant for internal review.', actorId:1 },
      ],
    });
    addEvidence(db, closed, {
      version:1, fileName:'demo-pune-chd-2026-08-supply-pack.txt', status:'approved', uploadedBy:1, reviewedBy:2,
      reviewReason:'Reviewed as fictional internal evidence for the demo task only.',
      content:'SYNTHETIC DEMO ONLY. Pune Depot August 2026 consumer-health supply work pack. No GST filing, portal upload, stock posting or official acknowledgement.\n',
    });
    closeWithEvidence(db, closed, 2);

    const submitted = ensureTask(db, {
      companyId:1, gstinId:1, branchId:null, scopeType:'gstin', templateId:gstTemplate, period:'2026-09',
      status:'submitted', version:2, preparerUserId:1, reviewerUserId:2, internalTargetDate:'2026-09-26',
      completedChecklistKeys:['reconcile_itc','review_exceptions','assemble_pack'], createdBy:2, submittedBy:1,
      submittedAt:'2026-09-24 11:00:00',
      events:[
        { action:'generated', details:'Generated from approved template v1 for 2026-09.', actorId:2 },
        { action:'submitted', details:'Submitted with draft evidence still awaiting independent review.', actorId:1 },
      ],
    });
    addEvidence(db, submitted, {
      version:1, fileName:'demo-aster-mh-2026-09-draft-pack.txt', status:'pending', uploadedBy:1,
      content:'SYNTHETIC DEMO ONLY. Draft September 2026 internal review pack awaiting accountant evidence review.\n',
    });

    ensureTask(db, {
      companyId:1, gstinId:1, branchId:2, scopeType:'branch', templateId:puneTemplate, period:'2026-09',
      status:'open', version:1, preparerUserId:1, reviewerUserId:2, internalTargetDate:'2026-09-28',
      completedChecklistKeys:[], createdBy:2,
      events:[
        { action:'generated', details:'Generated for Pune Depot fictional consumer-health supply follow-up.', actorId:2 },
        { action:'assigned', details:'Assigned to Maya Staff for source-backed internal follow-up.', actorId:2 },
      ],
    });

    const blr = ensureTask(db, {
      companyId:1, gstinId:2, branchId:3, scopeType:'branch', templateId:blrTemplate, period:'2026-09',
      status:'closed', version:3, preparerUserId:1, reviewerUserId:2, internalTargetDate:'2026-09-29',
      completedChecklistKeys:['review_sources','attach_evidence'], createdBy:2, submittedBy:1,
      submittedAt:'2026-09-23 12:00:00', closedBy:2, closedAt:'2026-09-24 13:00:00',
      events:[
        { action:'generated', details:'Generated for Bengaluru Branch fictional consumer-health supply evidence closure.', actorId:2 },
        { action:'submitted', details:'Submitted with internal source notes; no stock, invoice or GST total was changed.', actorId:1 },
      ],
    });
    addEvidence(db, blr, {
      version:1, fileName:'demo-blr-chd-supply-closure.txt', status:'approved', uploadedBy:1, reviewedBy:2,
      reviewReason:'Reviewed as synthetic branch supply evidence only.',
      content:'SYNTHETIC DEMO ONLY. Bengaluru consumer-health supply closure note. No authentic supplier document or statutory filing evidence.\n',
    });
    closeWithEvidence(db, blr, 2);

    db.exec('RELEASE seed_work_tasks_demo');
    return { seeded:true };
  } catch (error) {
    db.exec('ROLLBACK TO seed_work_tasks_demo');
    db.exec('RELEASE seed_work_tasks_demo');
    throw error;
  }
}

module.exports = { seedWorkTasksDemo };
