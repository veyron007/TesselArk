const { installOrderCrmSchema } = require('./order-crm-db.cjs');
const { assertScopeAccess, allowedScopes } = require('./access.cjs');

const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const id = (value, name) => { const number = Number(value); if (!Number.isSafeInteger(number) || number < 1) throw fail(`${name} must be a positive integer`); return number; };
const line = (value, name, max = 500) => { if (typeof value !== 'string' || !value.trim() || value.trim().length > max) throw fail(`${name} must be 1 to ${max} characters`); return value.trim(); };
const date = (value, name) => { if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`)) || new Date(`${value}T00:00:00Z`).toISOString().slice(0,10) !== value) throw fail(`${name} must be a real YYYY-MM-DD date`); return value; };
const camel = row => row && Object.fromEntries(Object.entries(row).map(([key,value]) => [key.replace(/_([a-z])/g,(_,letter)=>letter.toUpperCase()),value]));
const optionalId = (value,name) => value === null || value === undefined || value === '' ? null : id(value,name);
const cleanRef = value => line(value,'clientReference',100);
const same = (left,right) => left === JSON.stringify(right);

function registerOrderCrmRoutes(app, db) {
  installOrderCrmSchema(db);
  const route = handler => (req,res,next) => { try { res.json(handler(req)); } catch (error) { next(error); } };
  const atomic = action => { db.exec('SAVEPOINT order_crm_action'); try { const result = action(); db.exec('RELEASE order_crm_action'); return result; } catch (error) { db.exec('ROLLBACK TO order_crm_action'); db.exec('RELEASE order_crm_action'); throw error; } };
  const scope = (req,gstinId,branchId) => assertScopeAccess(db,{companyId:req.company.id,userId:req.user.id,gstinId,branchId});
  const canWrite = req => { if (!['staff','admin'].includes(req.user.role)) throw fail('Staff or admin role required for customer follow-up',403); };
  const owner = (req,ownerId,gstinId,branchId) => {
    const user = db.prepare("SELECT id,name,role FROM users WHERE id=? AND company_id=? AND role IN ('staff','admin')").get(ownerId,req.company.id);
    if (!user) throw fail('Owner must be a staff or admin user in this company',404);
    const grants = allowedScopes(db,{companyId:req.company.id,userId:ownerId});
    if (!grants.gstinIds.includes(gstinId) || !grants.branchIds.includes(branchId)) throw fail('Owner lacks this GSTIN or branch grant',403);
    return user;
  };
  const customer = (req,partyId) => {
    const party = db.prepare("SELECT id,name FROM parties WHERE id=? AND company_id=? AND type IN ('customer','both')").get(partyId,req.company.id);
    if (!party) throw fail('Customer not found in selected company',404);
    return party;
  };
  const sourceOrder = (req,orderId,scopeIds,partyId) => {
    if (!orderId) return null;
    const order = db.prepare("SELECT id,number,party_id FROM orders WHERE id=? AND company_id=? AND gstin_id=? AND branch_id=? AND type='sale'").get(orderId,req.company.id,scopeIds.gstinId,scopeIds.branchId);
    if (!order || order.party_id !== partyId) throw fail('Sales order must match the case customer and branch scope',409);
    return order;
  };
  const caseRow = (req,caseId) => {
    const row = db.prepare('SELECT * FROM order_crm_cases WHERE id=? AND company_id=?').get(caseId,req.company.id);
    if (!row) throw fail('Follow-up case not found in selected company',404);
    scope(req,row.gstin_id,row.branch_id);
    return row;
  };
  const editable = (req,row) => { canWrite(req); if (req.user.role !== 'admin' && row.owner_id !== req.user.id) throw fail('Only the case owner or admin may update this follow-up',403); };
  const detail = row => {
    const events = db.prepare(`SELECT e.*,u.name AS actor_name FROM order_crm_events e JOIN users u ON u.id=e.actor_id WHERE e.case_id=? ORDER BY e.id`).all(row.id).map(camel);
    const dispositions = new Map();
    for (const event of events) if (event.kind === 'disposition') dispositions.set(event.relatedEventId,event);
    const commitments = events.filter(event => event.kind === 'commitment').map(event => ({...event,latestDisposition:dispositions.get(event.id) || null}));
    const blockers = db.prepare(`SELECT b.*,f.number AS fulfillment_number,f.status AS fulfillment_status FROM order_crm_blockers b
      LEFT JOIN order_fulfillments f ON f.id=b.fulfillment_id WHERE b.case_id=? ORDER BY b.id`).all(row.id).map(camel);
    const fulfillments = row.order_id ? db.prepare(`SELECT f.id,f.number,f.kind,f.status,f.event_date,
      COALESCE(SUM(fl.quantity),0) AS quantity FROM order_fulfillments f LEFT JOIN order_fulfillment_lines fl ON fl.fulfillment_id=f.id
      WHERE f.order_id=? AND f.company_id=? GROUP BY f.id ORDER BY f.id`).all(row.order_id,row.company_id).map(camel) : [];
    const order = row.order_id ? db.prepare('SELECT id,number,status,order_date FROM orders WHERE id=? AND company_id=?').get(row.order_id,row.company_id) : null;
    return { ...camel(row),partyName:db.prepare('SELECT name FROM parties WHERE id=?').get(row.party_id)?.name,
      ownerName:db.prepare('SELECT name FROM users WHERE id=?').get(row.owner_id)?.name,order:camel(order),events,commitments,blockers,fulfillments };
  };
  const list = (req,gstinId,branchId) => {
    scope(req,gstinId,branchId);
    return db.prepare(`SELECT c.id,c.company_id,c.gstin_id,c.branch_id,c.party_id,c.order_id,c.client_reference,c.subject,c.owner_id,
      c.next_action,c.due_date,c.status,c.created_at,c.updated_at,p.name AS party_name,u.name AS owner_name,o.number AS order_number,
      (SELECT COUNT(*) FROM order_crm_blockers b WHERE b.case_id=c.id AND b.status='open') AS open_blocker_count
      FROM order_crm_cases c JOIN parties p ON p.id=c.party_id JOIN users u ON u.id=c.owner_id LEFT JOIN orders o ON o.id=c.order_id
      WHERE c.company_id=? AND c.gstin_id=? AND c.branch_id=? ORDER BY CASE c.status WHEN 'open' THEN 0 ELSE 1 END,c.due_date,c.id DESC`)
      .all(req.company.id,gstinId,branchId).map(camel);
  };

  app.get('/api/order-crm',route(req => {
    const gstinId = id(req.query.gstinId,'gstinId'), branchId = id(req.query.branchId,'branchId');
    scope(req,gstinId,branchId);
    const customers = db.prepare("SELECT id,name FROM parties WHERE company_id=? AND type IN ('customer','both') ORDER BY name").all(req.company.id);
    const users = db.prepare("SELECT id,name,role FROM users WHERE company_id=? AND role IN ('staff','admin') ORDER BY name").all(req.company.id)
      .filter(user => { const grants = allowedScopes(db,{companyId:req.company.id,userId:user.id}); return grants.gstinIds.includes(gstinId) && grants.branchIds.includes(branchId); });
    const orders = db.prepare("SELECT id,number,party_id,status,order_date FROM orders WHERE company_id=? AND gstin_id=? AND branch_id=? AND type='sale' ORDER BY id DESC").all(req.company.id,gstinId,branchId).map(camel);
    return {cases:list(req,gstinId,branchId),customers,users,orders};
  }));
  app.get('/api/order-crm/:id',route(req => ({case:detail(caseRow(req,id(req.params.id,'id')))})));
  app.post('/api/order-crm',route(req => atomic(() => {
    canWrite(req);
    const body = req.body || {}, gstinId = id(body.gstinId,'gstinId'), branchId = id(body.branchId,'branchId');
    scope(req,gstinId,branchId);
    const partyId = id(body.partyId,'partyId'), orderId = optionalId(body.orderId,'orderId'), ownerId = id(body.ownerId ?? req.user.id,'ownerId');
    customer(req,partyId); sourceOrder(req,orderId,{gstinId,branchId},partyId); owner(req,ownerId,gstinId,branchId);
    if (req.user.role !== 'admin' && ownerId !== req.user.id) throw fail('Only admin may assign another owner',403);
    const payload = {gstinId,branchId,partyId,orderId,ownerId,clientReference:cleanRef(body.clientReference),subject:line(body.subject,'subject',160),
      customerRequest:line(body.customerRequest,'customerRequest',1000),nextAction:line(body.nextAction,'nextAction',300),dueDate:date(body.dueDate,'dueDate')};
    const existing = db.prepare('SELECT * FROM order_crm_cases WHERE company_id=? AND client_reference=?').get(req.company.id,payload.clientReference);
    if (existing) { if (!same(existing.payload_json,payload)) throw fail('clientReference already belongs to a different case payload',409); return {case:detail(caseRow(req,existing.id)),replayed:true}; }
    const caseId = Number(db.prepare(`INSERT INTO order_crm_cases(company_id,gstin_id,branch_id,party_id,order_id,client_reference,subject,customer_request,owner_id,next_action,due_date,created_by,payload_json)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(req.company.id,gstinId,branchId,partyId,orderId,payload.clientReference,payload.subject,payload.customerRequest,ownerId,payload.nextAction,payload.dueDate,req.user.id,JSON.stringify(payload)).lastInsertRowid);
    db.prepare(`INSERT INTO order_crm_events(case_id,client_reference,kind,detail,actor_id,payload_json) VALUES (?,?,'request',?,?,?)`)
      .run(caseId,`${payload.clientReference}:request`,payload.customerRequest,req.user.id,JSON.stringify({kind:'request',detail:payload.customerRequest}));
    return {case:detail(caseRow(req,caseId)),replayed:false};
  })));
  app.post('/api/order-crm/:id/actions',route(req => atomic(() => {
    const row = caseRow(req,id(req.params.id,'id'));
    canWrite(req);
    const body = req.body || {}, kind = line(body.kind,'kind',30), clientReference = cleanRef(body.clientReference);
    if (!['request','commitment','disposition','follow_up','blocker_open','blocker_resolve','close','reopen'].includes(kind)) throw fail('Unsupported follow-up action');
    const payload = {kind,clientReference,detail:line(body.detail,'detail',1000)};
    if (kind === 'disposition') { payload.relatedEventId=id(body.relatedEventId,'relatedEventId'); payload.disposition=line(body.disposition,'disposition',20); if (!['fulfilled','partial','unmet','withdrawn'].includes(payload.disposition)) throw fail('Invalid commitment disposition'); }
    if (kind === 'follow_up') {
      payload.nextAction=line(body.nextAction,'nextAction',300); payload.dueDate=date(body.dueDate,'dueDate');
      payload.ownerId=id(body.ownerId ?? row.owner_id,'ownerId');
    }
    if (kind === 'blocker_open') { if (!row.order_id) throw fail('Link a sales order before adding fulfillment blockers',409); payload.fulfillmentId=optionalId(body.fulfillmentId,'fulfillmentId'); }
    if (kind === 'blocker_resolve') payload.blockerId=id(body.blockerId,'blockerId');
    const existing = db.prepare('SELECT * FROM order_crm_events WHERE case_id=? AND client_reference=?').get(row.id,clientReference);
    if (existing) {
      if (existing.actor_id !== req.user.id && req.user.role !== 'admin') throw fail('Only the original actor or admin may replay this action',403);
      if (!same(existing.payload_json,payload)) throw fail('clientReference already belongs to a different action payload',409);
      return {case:detail(row),event:camel(existing),replayed:true};
    }
    editable(req,row);
    if (kind === 'follow_up') owner(req,payload.ownerId,row.gstin_id,row.branch_id);
    if (kind === 'follow_up' && payload.ownerId !== row.owner_id && req.user.role !== 'admin') throw fail('Only admin may reassign case ownership',403);
    if (row.status === 'closed' && kind !== 'reopen') throw fail('Reopen this case before adding actions',409);
    if (row.status === 'open' && kind === 'reopen') throw fail('Case is already open',409);
    if (row.status === 'closed' && kind === 'close') throw fail('Case is already closed',409);
    if (kind === 'disposition') {
      const commitment = db.prepare("SELECT id FROM order_crm_events WHERE id=? AND case_id=? AND kind='commitment'").get(payload.relatedEventId,row.id);
      if (!commitment) throw fail('Disposition must reference a commitment in this case',409);
    }
    if (kind === 'blocker_open' && payload.fulfillmentId) {
      const fulfillment = db.prepare('SELECT id FROM order_fulfillments WHERE id=? AND order_id=? AND company_id=?').get(payload.fulfillmentId,row.order_id,req.company.id);
      if (!fulfillment) throw fail('Fulfillment must belong to the linked sales order',409);
    }
    let blockerId = null;
    if (kind === 'blocker_open') blockerId = Number(db.prepare(`INSERT INTO order_crm_blockers(case_id,order_id,fulfillment_id,description,opened_by) VALUES (?,?,?,?,?)`)
      .run(row.id,row.order_id,payload.fulfillmentId,payload.detail,req.user.id).lastInsertRowid);
    if (kind === 'blocker_resolve') {
      const blocker = db.prepare('SELECT id,status FROM order_crm_blockers WHERE id=? AND case_id=?').get(payload.blockerId,row.id);
      if (!blocker) throw fail('Blocker not found in this case',404);
      if (blocker.status === 'resolved') throw fail('Blocker already resolved; reuse its original clientReference for replay',409);
      db.prepare("UPDATE order_crm_blockers SET status='resolved',resolved_by=?,resolved_at=CURRENT_TIMESTAMP,resolution=? WHERE id=?")
        .run(req.user.id,payload.detail,payload.blockerId);
      blockerId = payload.blockerId;
    }
    const eventId = Number(db.prepare(`INSERT INTO order_crm_events(case_id,client_reference,kind,detail,related_event_id,disposition,blocker_id,fulfillment_id,actor_id,payload_json)
      VALUES (?,?,?,?,?,?,?,?,?,?)`).run(row.id,clientReference,kind,payload.detail,payload.relatedEventId || null,payload.disposition || null,blockerId,payload.fulfillmentId || null,req.user.id,JSON.stringify(payload)).lastInsertRowid);
    if (kind === 'follow_up') db.prepare('UPDATE order_crm_cases SET next_action=?,due_date=?,owner_id=?,updated_at=CURRENT_TIMESTAMP WHERE id=?')
      .run(payload.nextAction,payload.dueDate,payload.ownerId,row.id);
    else if (kind === 'close' || kind === 'reopen') db.prepare('UPDATE order_crm_cases SET status=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(kind === 'close' ? 'closed' : 'open',row.id);
    else db.prepare('UPDATE order_crm_cases SET updated_at=CURRENT_TIMESTAMP WHERE id=?').run(row.id);
    return {case:detail(caseRow(req,row.id)),event:camel(db.prepare('SELECT * FROM order_crm_events WHERE id=?').get(eventId)),replayed:false};
  })));
}

module.exports = { registerOrderCrmRoutes };
