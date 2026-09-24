const { installBudgetsSchema } = require('./budgets-db.cjs');
const { assertScopeAccess } = require('./access.cjs');

const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const camel = row => Object.fromEntries(Object.entries(row).map(([key,value]) => [key.replace(/_([a-z])/g, (_,letter) => letter.toUpperCase()), value]));
const positiveId = (value, name) => {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw fail(`${name} must be a positive integer`);
  return parsed;
};
const cents = (value, name, min = 0) => {
  if (!Number.isSafeInteger(value) || value < min) throw fail(`${name} must be safe integer paise of at least ${min}`);
  return value;
};
const required = (value, name, max = 500) => {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max) throw fail(`${name} must be 1 to ${max} characters`);
  return value.trim();
};
const period = value => {
  if (typeof value !== 'string' || !/^\d{4}-(0[1-9]|1[0-2])$/.test(value)) throw fail('period must be YYYY-MM');
  return value;
};
const measureFor = { purchase_line: 'expense', sale_line: 'sales', sale_receipt: 'collections' };
const measures = ['expense','sales','collections'];
const tx = (db, action) => {
  db.exec('SAVEPOINT budgets_action');
  try { const result = action(); db.exec('RELEASE budgets_action'); return result; }
  catch (error) { db.exec('ROLLBACK TO budgets_action'); db.exec('RELEASE budgets_action'); throw error; }
};

function registerBudgetsRoutes(app, db) {
  installBudgetsSchema(db);
  const route = handler => (req,res,next) => { try { res.json(handler(req)); } catch (error) { next(error); } };
  const scope = (req, gstinValue, branchValue) => {
    const companyId = req.company.id, userId = req.user.id;
    const gstinId = positiveId(gstinValue,'gstinId'), branchId = positiveId(branchValue,'branchId');
    const branch = db.prepare('SELECT id,name,gstin_id FROM branches WHERE id=? AND company_id=? AND gstin_id=?').get(branchId,companyId,gstinId);
    if (!branch) throw fail('Branch and GSTIN must belong to selected company and each other',404);
    assertScopeAccess(db,{companyId,userId,gstinId,branchId});
    return { companyId,gstinId,branchId,branch };
  };
  const centre = (req, value) => {
    const row = db.prepare('SELECT * FROM budget_centres WHERE id=? AND company_id=?').get(positiveId(value,'centreId'),req.company.id);
    if (!row) throw fail('Cost centre not found in selected company',404);
    scope(req,row.gstin_id,row.branch_id);
    return row;
  };
  const event = (req,type,id,action,details) => db.prepare('INSERT INTO budget_events(company_id,entity_type,entity_id,action,actor_id,details) VALUES (?,?,?,?,?,?)')
    .run(req.company.id,type,id,action,req.user.id,details);
  const source = (req,type,value) => {
    if (!Object.hasOwn(measureFor,type)) throw fail('sourceType must be purchase_line, sale_line or sale_receipt');
    const sourceId = positiveId(value,'sourceId');
    const row = type === 'sale_receipt'
      ? db.prepare(`SELECT p.id,p.amount_cents AS capacity_cents,p.payment_date AS source_date,i.company_id,i.gstin_id,i.branch_id,i.number AS document_number,p.reference
          FROM invoice_payments p JOIN invoices i ON i.id=p.invoice_id AND i.company_id=p.company_id
          WHERE p.id=? AND i.company_id=? AND i.type='sale' AND i.status='approved'`).get(sourceId,req.company.id)
      : db.prepare(`SELECT l.id,l.subtotal_cents AS capacity_cents,i.invoice_date AS source_date,i.company_id,i.gstin_id,i.branch_id,i.number AS document_number,'' AS reference
          FROM invoice_lines l JOIN invoices i ON i.id=l.invoice_id
          WHERE l.id=? AND i.company_id=? AND i.type=? AND i.status='approved'`).get(sourceId,req.company.id,type === 'sale_line' ? 'sale' : 'purchase');
    if (!row) throw fail('Approved source not found in selected company',404);
    scope(req,row.gstin_id,row.branch_id);
    cents(row.capacity_cents,'source amount');
    return { ...row, sourceType:type, measure:measureFor[type], sourceId };
  };
  const allocationCapacity = src => {
    const allocated = db.prepare("SELECT COALESCE(SUM(amount_cents),0) AS amount FROM budget_allocations WHERE company_id=? AND source_type=? AND source_id=? AND status IN ('pending','approved')")
      .get(src.company_id,src.sourceType,src.sourceId).amount;
    if (!Number.isSafeInteger(allocated)) throw fail('Allocated amount exceeds safe integer paise',409);
    return src.capacity_cents - allocated;
  };
  const loadEntity = (req,table,idValue) => {
    const row = db.prepare(`SELECT * FROM ${table} WHERE id=? AND company_id=?`).get(positiveId(idValue,'id'),req.company.id);
    if (!row) throw fail('Record not found in selected company',404);
    centre(req,row.centre_id);
    return row;
  };

  app.get('/api/budgets/overview',route(req => {
    const s = scope(req,req.query.gstinId,req.query.branchId), month = period(req.query.period);
    const centres = db.prepare('SELECT * FROM budget_centres WHERE company_id=? AND gstin_id=? AND branch_id=? ORDER BY code,id').all(s.companyId,s.gstinId,s.branchId).map(camel);
    const plans = db.prepare(`SELECT p.* FROM budget_plans p JOIN budget_centres c ON c.id=p.centre_id
      WHERE p.company_id=? AND c.gstin_id=? AND c.branch_id=? AND p.period=? ORDER BY p.id`)
      .all(s.companyId,s.gstinId,s.branchId,month).map(camel);
    const allocations = db.prepare(`SELECT a.* FROM budget_allocations a JOIN budget_centres c ON c.id=a.centre_id
      WHERE a.company_id=? AND c.gstin_id=? AND c.branch_id=? AND a.source_date>=? AND a.source_date<? ORDER BY a.source_date,a.id`)
      .all(s.companyId,s.gstinId,s.branchId,`${month}-01`,nextMonth(month)).map(camel);
    const sourceRows = [
      ...db.prepare(`SELECT l.id AS source_id,'sale_line' AS source_type,l.subtotal_cents AS capacity_cents,i.invoice_date AS source_date,i.number AS document_number,'' AS reference
        FROM invoice_lines l JOIN invoices i ON i.id=l.invoice_id WHERE i.company_id=? AND i.gstin_id=? AND i.branch_id=? AND i.type='sale' AND i.status='approved' AND i.invoice_date>=? AND i.invoice_date<?`)
        .all(s.companyId,s.gstinId,s.branchId,`${month}-01`,nextMonth(month)),
      ...db.prepare(`SELECT l.id AS source_id,'purchase_line' AS source_type,l.subtotal_cents AS capacity_cents,i.invoice_date AS source_date,i.number AS document_number,'' AS reference
        FROM invoice_lines l JOIN invoices i ON i.id=l.invoice_id WHERE i.company_id=? AND i.gstin_id=? AND i.branch_id=? AND i.type='purchase' AND i.status='approved' AND i.invoice_date>=? AND i.invoice_date<?`)
        .all(s.companyId,s.gstinId,s.branchId,`${month}-01`,nextMonth(month)),
      ...db.prepare(`SELECT p.id AS source_id,'sale_receipt' AS source_type,p.amount_cents AS capacity_cents,p.payment_date AS source_date,i.number AS document_number,p.reference
        FROM invoice_payments p JOIN invoices i ON i.id=p.invoice_id AND i.company_id=p.company_id WHERE i.company_id=? AND i.gstin_id=? AND i.branch_id=? AND i.type='sale' AND i.status='approved' AND p.payment_date>=? AND p.payment_date<?`)
        .all(s.companyId,s.gstinId,s.branchId,`${month}-01`,nextMonth(month)),
    ];
    const sources = sourceRows.map(row => ({ ...camel(row), measure:measureFor[row.source_type],remainingCents:allocationCapacity({ company_id:s.companyId,sourceType:row.source_type,sourceId:row.source_id,capacity_cents:row.capacity_cents }) }))
      .sort((a,b) => a.sourceDate.localeCompare(b.sourceDate) || a.sourceType.localeCompare(b.sourceType) || a.sourceId-b.sourceId);
    const rows = centres.flatMap(c => measures.map(measure => {
      const plan = plans.find(p => p.centreId === c.id && p.measure === measure && p.status === 'approved');
      const actual = allocations.filter(a => a.centreId === c.id && a.status === 'approved' && measureFor[a.sourceType] === measure);
      const actualCents = actual.reduce((sum,a) => safeAdd(sum,a.amountCents),0);
      return { centreId:c.id,code:c.code,centreName:c.name,measure,period:month,planId:plan?.id || null,planCents:plan?.amountCents ?? null,actualCents,
        varianceCents:plan ? actualCents-plan.amountCents : null,allocationIds:actual.map(a => a.id),basis:plan?.basis || null };
    }));
    const events = db.prepare(`SELECT e.* FROM budget_events e WHERE e.company_id=? AND (
      (e.entity_type='centre' AND e.entity_id IN (SELECT id FROM budget_centres WHERE company_id=? AND gstin_id=? AND branch_id=?)) OR
      (e.entity_type='plan' AND e.entity_id IN (SELECT p.id FROM budget_plans p JOIN budget_centres c ON c.id=p.centre_id WHERE c.company_id=? AND c.gstin_id=? AND c.branch_id=? AND p.period=?)) OR
      (e.entity_type='allocation' AND e.entity_id IN (SELECT a.id FROM budget_allocations a JOIN budget_centres c ON c.id=a.centre_id WHERE c.company_id=? AND c.gstin_id=? AND c.branch_id=? AND a.source_date>=? AND a.source_date<?)))
      ORDER BY e.id DESC LIMIT 100`).all(s.companyId,s.companyId,s.gstinId,s.branchId,s.companyId,s.gstinId,s.branchId,month,s.companyId,s.gstinId,s.branchId,`${month}-01`,nextMonth(month)).map(camel);
    return { scope:{ companyId:s.companyId,gstinId:s.gstinId,branchId:s.branchId,period:month },centres,plans,allocations,sources,rows,events,
      notes:['Expense actual: approved purchase invoice line subtotal. Sales actual: approved sales invoice line subtotal. Collections actual: recorded payment on an approved sales invoice, including uncleared methods.',
        'Allocations are explicit and independently reviewed. Unallocated source amounts are excluded. Approved returns, cancellation effects, tax and discounts are not netted into these measures.',
        'Positive variance means actual exceeds plan. A positive expense variance is over budget; a negative sales or collections variance is a target shortfall. These measures must not be totaled together.',
        'Plans and allocations do not post or modify invoices, payments, journals, GST or statutory filing.'] };
  }));

  app.post('/api/budgets/centres',route(req => tx(db,() => {
    if (!['admin','accountant'].includes(req.user.role)) throw fail('Accountant or admin role required',403);
    const b = req.body || {}, s = scope(req,b.gstinId,b.branchId);
    const code = required(b.code,'code',32).toUpperCase(), name = required(b.name,'name',120), purpose = required(b.purpose,'purpose');
    if (!/^[A-Z0-9][A-Z0-9_-]*$/.test(code)) throw fail('code may contain only letters, numbers, underscore and hyphen');
    const existing = db.prepare('SELECT * FROM budget_centres WHERE company_id=? AND gstin_id=? AND branch_id=? AND code=?').get(s.companyId,s.gstinId,s.branchId,code);
    if (existing) {
      if (existing.name === name && existing.purpose === purpose) return { centre:camel(existing),replayed:true };
      throw fail('Cost centre code already exists with different details',409);
    }
    const id = Number(db.prepare('INSERT INTO budget_centres(company_id,gstin_id,branch_id,code,name,purpose,created_by) VALUES (?,?,?,?,?,?,?)').run(s.companyId,s.gstinId,s.branchId,code,name,purpose,req.user.id).lastInsertRowid);
    event(req,'centre',id,'created',purpose);
    return { centre:camel(db.prepare('SELECT * FROM budget_centres WHERE id=?').get(id)),replayed:false };
  })));

  app.post('/api/budgets/plans',route(req => tx(db,() => {
    const b = req.body || {}, c = centre(req,b.centreId), month = period(b.period);
    if (!measures.includes(b.measure)) throw fail('measure must be expense, sales or collections');
    const amount = cents(b.amountCents,'amountCents'), basis = required(b.basis,'basis'), ref = required(b.clientReference,'clientReference',100);
    const existing = db.prepare('SELECT * FROM budget_plans WHERE company_id=? AND client_reference=?').get(req.company.id,ref);
    if (existing) {
      if (existing.centre_id===c.id && existing.period===month && existing.measure===b.measure && existing.amount_cents===amount && existing.basis===basis) return { plan:camel(existing),replayed:true };
      throw fail('Client reference already used for a different plan',409);
    }
    if (db.prepare("SELECT 1 FROM budget_plans WHERE centre_id=? AND period=? AND measure=? AND status IN ('pending','approved')").get(c.id,month,b.measure)) throw fail('A pending or approved plan already exists for this centre, period and measure',409);
    const id = Number(db.prepare('INSERT INTO budget_plans(company_id,centre_id,period,measure,amount_cents,basis,client_reference,created_by) VALUES (?,?,?,?,?,?,?,?)')
      .run(req.company.id,c.id,month,b.measure,amount,basis,ref,req.user.id).lastInsertRowid);
    event(req,'plan',id,'created',basis);
    return { plan:camel(db.prepare('SELECT * FROM budget_plans WHERE id=?').get(id)),replayed:false };
  })));

  app.post('/api/budgets/allocations',route(req => tx(db,() => {
    const b = req.body || {}, c = centre(req,b.centreId), src = source(req,b.sourceType,b.sourceId);
    if (c.gstin_id !== src.gstin_id || c.branch_id !== src.branch_id) throw fail('Source and centre must share company, GSTIN and branch');
    const amount = cents(b.amountCents,'amountCents',1), basis = required(b.basis,'basis'), ref = required(b.clientReference,'clientReference',100);
    const existing = db.prepare('SELECT * FROM budget_allocations WHERE company_id=? AND client_reference=?').get(req.company.id,ref);
    if (existing) {
      if (existing.centre_id===c.id && existing.source_type===b.sourceType && existing.source_id===src.sourceId && existing.amount_cents===amount && existing.basis===basis) return { allocation:camel(existing),replayed:true };
      throw fail('Client reference already used for a different allocation',409);
    }
    if (amount > allocationCapacity(src)) throw fail('Allocation exceeds remaining approved source subtotal or receipt',409);
    const id = Number(db.prepare('INSERT INTO budget_allocations(company_id,centre_id,source_type,source_id,source_date,amount_cents,basis,client_reference,created_by) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(req.company.id,c.id,b.sourceType,src.sourceId,src.source_date,amount,basis,ref,req.user.id).lastInsertRowid);
    event(req,'allocation',id,'created',basis);
    return { allocation:camel(db.prepare('SELECT * FROM budget_allocations WHERE id=?').get(id)),replayed:false };
  })));

  const review = (table,kind) => route(req => tx(db,() => {
    if (!['accountant','admin'].includes(req.user.role)) throw fail('Accountant or admin role required for review',403);
    const row = loadEntity(req,table,req.params.id), b = req.body || {};
    if (!['approve','reject'].includes(b.decision)) throw fail('decision must be approve or reject');
    const reason = required(b.reason,'reason'), status = b.decision === 'approve' ? 'approved' : 'rejected';
    if (row.status !== 'pending') {
      if (row.status === status && row.reviewed_by === req.user.id && row.review_reason === reason) return { [kind]:camel(row),replayed:true };
      throw fail('Decision already recorded',409);
    }
    if (row.created_by === req.user.id) throw fail('Independent reviewer required',403);
    if (kind === 'allocation' && status === 'approved') {
      const src = source(req,row.source_type,row.source_id);
      if (src.gstin_id !== db.prepare('SELECT gstin_id FROM budget_centres WHERE id=?').get(row.centre_id).gstin_id || src.branch_id !== db.prepare('SELECT branch_id FROM budget_centres WHERE id=?').get(row.centre_id).branch_id) throw fail('Source scope changed',409);
      if (src.source_date !== row.source_date) throw fail('Source date changed',409);
      if (allocationCapacity(src) < 0) throw fail('Source amount fell below reserved allocations',409);
    }
    db.prepare(`UPDATE ${table} SET status=?,reviewed_by=?,review_reason=?,reviewed_at=CURRENT_TIMESTAMP WHERE id=? AND status='pending'`).run(status,req.user.id,reason,row.id);
    event(req,kind,row.id,status,reason);
    return { [kind]:camel(db.prepare(`SELECT * FROM ${table} WHERE id=?`).get(row.id)),replayed:false };
  }));
  app.post('/api/budgets/plans/:id/review',review('budget_plans','plan'));
  app.post('/api/budgets/allocations/:id/review',review('budget_allocations','allocation'));
}

function nextMonth(month) {
  const [year,number] = month.split('-').map(Number);
  return `${year + (number === 12 ? 1 : 0)}-${String(number === 12 ? 1 : number+1).padStart(2,'0')}-01`;
}
function safeAdd(left,right) {
  const result = left + right;
  if (!Number.isSafeInteger(result)) throw fail('Actual exceeds safe integer paise',409);
  return result;
}

module.exports = { registerBudgetsRoutes };
