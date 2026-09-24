function installOrderCrmSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS order_crm_cases (
      id INTEGER PRIMARY KEY,
      company_id INTEGER NOT NULL REFERENCES companies(id),
      gstin_id INTEGER NOT NULL REFERENCES gstins(id),
      branch_id INTEGER NOT NULL REFERENCES branches(id),
      party_id INTEGER NOT NULL REFERENCES parties(id),
      order_id INTEGER REFERENCES orders(id),
      client_reference TEXT NOT NULL,
      subject TEXT NOT NULL,
      customer_request TEXT NOT NULL,
      owner_id INTEGER NOT NULL REFERENCES users(id),
      next_action TEXT NOT NULL,
      due_date TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','closed')),
      created_by INTEGER NOT NULL REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      payload_json TEXT NOT NULL,
      UNIQUE(company_id,client_reference)
    );
    CREATE INDEX IF NOT EXISTS idx_order_crm_scope ON order_crm_cases(company_id,gstin_id,branch_id,due_date,id);
    CREATE TABLE IF NOT EXISTS order_crm_blockers (
      id INTEGER PRIMARY KEY,
      case_id INTEGER NOT NULL REFERENCES order_crm_cases(id),
      order_id INTEGER NOT NULL REFERENCES orders(id),
      fulfillment_id INTEGER REFERENCES order_fulfillments(id),
      description TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','resolved')),
      opened_by INTEGER NOT NULL REFERENCES users(id),
      opened_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      resolved_by INTEGER REFERENCES users(id),
      resolved_at TEXT,
      resolution TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_order_crm_blocker_order ON order_crm_blockers(order_id,fulfillment_id,status);
    CREATE TABLE IF NOT EXISTS order_crm_events (
      id INTEGER PRIMARY KEY,
      case_id INTEGER NOT NULL REFERENCES order_crm_cases(id),
      client_reference TEXT NOT NULL,
      kind TEXT NOT NULL CHECK(kind IN ('request','commitment','disposition','follow_up','blocker_open','blocker_resolve','close','reopen')),
      detail TEXT NOT NULL,
      related_event_id INTEGER REFERENCES order_crm_events(id),
      disposition TEXT CHECK(disposition IN ('fulfilled','partial','unmet','withdrawn')),
      blocker_id INTEGER REFERENCES order_crm_blockers(id),
      fulfillment_id INTEGER REFERENCES order_fulfillments(id),
      actor_id INTEGER NOT NULL REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      payload_json TEXT NOT NULL,
      UNIQUE(case_id,client_reference)
    );
    CREATE INDEX IF NOT EXISTS idx_order_crm_events_case ON order_crm_events(case_id,id);
  `);
}

function seedOrderCrmDemo(db) {
  installOrderCrmSchema(db);
  const order = db.prepare("SELECT id,company_id,gstin_id,branch_id,party_id FROM orders WHERE company_id=1 AND number='DEMO-SO-BLR-301' AND type='sale'").get();
  const due = new Date(); due.setUTCDate(due.getUTCDate() + 2);
  const dueDate = due.toISOString().slice(0,10);
  let changed = false;
  db.exec('SAVEPOINT seed_order_crm');
  try {
    const insertCase = payload => Number(db.prepare(`INSERT INTO order_crm_cases(company_id,gstin_id,branch_id,party_id,order_id,client_reference,subject,customer_request,owner_id,next_action,due_date,created_by,payload_json)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,1,?)`).run(1,payload.gstinId,payload.branchId,payload.partyId,payload.orderId,payload.clientReference,payload.subject,payload.customerRequest,payload.ownerId,payload.nextAction,payload.dueDate,JSON.stringify(payload)).lastInsertRowid);
    const event = (caseId,reference,kind,detail,extra={}) => Number(db.prepare(`INSERT INTO order_crm_events(case_id,client_reference,kind,detail,related_event_id,disposition,blocker_id,fulfillment_id,actor_id,payload_json)
      VALUES (?,?,?,?,?,?,?,?,1,?)`).run(caseId,reference,kind,detail,extra.relatedEventId || null,extra.disposition || null,extra.blockerId || null,extra.fulfillmentId || null,JSON.stringify({clientReference:reference,kind,detail,...extra})).lastInsertRowid);
    const mumbai = db.prepare("SELECT id FROM order_crm_cases WHERE company_id=1 AND client_reference='DEMO-CRM-MUM-029'").get();
    const customer = db.prepare("SELECT id FROM parties WHERE id=1 AND company_id=1 AND type IN ('customer','both')").get();
    if (!mumbai && customer) {
      const payload = { gstinId:1,branchId:1,partyId:customer.id,orderId:null,ownerId:1,
        clientReference:'DEMO-CRM-MUM-029',subject:'Clinic reorder enquiry',
        customerRequest:'Synthetic Harbor Clinic enquiry asking for availability before placing another order.',
        nextAction:'Check available stock and call the clinic with an indicative date',dueDate };
      const caseId = insertCase(payload);
      event(caseId,'DEMO-CRM-MUM-REQUEST','request',payload.customerRequest);
      event(caseId,'DEMO-CRM-MUM-PROMISE','commitment','Synthetic commitment: call the clinic after the stock check.');
      changed = true;
    }
    const existing = db.prepare("SELECT id FROM order_crm_cases WHERE company_id=1 AND client_reference='DEMO-CRM-BLR-029'").get();
    if (order && !existing) {
      const fulfillment = db.prepare('SELECT id FROM order_fulfillments WHERE order_id=? ORDER BY id LIMIT 1').get(order.id);
      const payload = { gstinId:order.gstin_id,branchId:order.branch_id,partyId:order.party_id,orderId:order.id,ownerId:1,
        clientReference:'DEMO-CRM-BLR-029',subject:'Remaining glucose strip delivery',
        customerRequest:'Synthetic Harbor Clinic request for a delivery update on the remaining six boxes.',
        nextAction:'Confirm dispatch plan with the warehouse and call the customer',dueDate };
      const caseId = insertCase(payload);
      event(caseId,'DEMO-CRM-REQUEST','request',payload.customerRequest);
      const prior = event(caseId,'DEMO-CRM-PROMISE-1','commitment','Synthetic initial promise: send an update after the first dispatch.');
      event(caseId,'DEMO-CRM-DISPOSITION-1','disposition','First dispatch completed; six boxes remain open.',{relatedEventId:prior,disposition:'partial'});
      event(caseId,'DEMO-CRM-PROMISE-2','commitment','Synthetic current promise: confirm a date for the remaining six boxes.');
      if (fulfillment) {
        const blockerId = Number(db.prepare(`INSERT INTO order_crm_blockers(case_id,order_id,fulfillment_id,description,opened_by)
          VALUES (?,?,?,?,1)`).run(caseId,order.id,fulfillment.id,'Warehouse confirmation needed before the remaining dispatch date can be promised.').lastInsertRowid);
        event(caseId,'DEMO-CRM-BLOCKER','blocker_open','Warehouse confirmation needed before the remaining dispatch date can be promised.',{blockerId,fulfillmentId:fulfillment.id});
      }
      changed = true;
    }
    db.exec('RELEASE seed_order_crm');
    return changed;
  } catch (error) { db.exec('ROLLBACK TO seed_order_crm'); db.exec('RELEASE seed_order_crm'); throw error; }
}

module.exports = { installOrderCrmSchema, seedOrderCrmDemo };
