const { installCountsSchema } = require('./counts-db.cjs');
const { assertScopeAccess } = require('./access.cjs');

const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const integer = (value, name, min = 0) => {
  if (!Number.isSafeInteger(value) || value < min) throw fail(`${name} must be an integer of at least ${min}`);
  return value;
};
const words = (value, name, max = 500, required = true) => {
  if (typeof value !== 'string' || value.length > max || (required && !value.trim())) throw fail(`${name} is invalid`);
  return value.trim();
};
const camel = row => Object.fromEntries(Object.entries(row).map(([key, value]) => [key.replace(/_([a-z])/g, (_,letter) => letter.toUpperCase()),value]));

function registerCountsRoutes(app, db) {
  installCountsSchema(db);
  const route = handler => (req,res,next) => { try { res.json(handler(req)); } catch (error) { next(error); } };
  const atomic = action => {
    db.exec('SAVEPOINT count_action');
    try { const result=action(); db.exec('RELEASE count_action'); return result; }
    catch (error) { db.exec('ROLLBACK TO count_action'); db.exec('RELEASE count_action'); throw error; }
  };
  const preparer = req => { if (!['staff','admin'].includes(req.user.role)) throw fail('Storekeeper or admin role required',403); };
  const reviewer = req => { if (!['accountant','admin'].includes(req.user.role)) throw fail('Accountant or admin reviewer required',403); };
  const branch = (req, id, gstinId) => {
    const row=db.prepare('SELECT * FROM branches WHERE id=? AND company_id=?').get(integer(id,'branchId',1),req.company.id);
    if (!row) throw fail('Branch not found in selected company',404);
    if (gstinId !== undefined && integer(gstinId,'gstinId',1)!==row.gstin_id) throw fail('Branch does not belong to selected GSTIN');
    assertScopeAccess(db,{companyId:req.company.id,userId:req.user.id,gstinId:row.gstin_id,branchId:row.id});
    return row;
  };
  const session = (req,id) => {
    const row=db.prepare('SELECT * FROM count_sessions WHERE id=? AND company_id=?').get(integer(id,'countId',1),req.company.id);
    if (!row) throw fail('Count session not found in selected company',404);
    branch(req,row.branch_id,row.gstin_id);
    return row;
  };
  const proposal = (req,id) => {
    const row=db.prepare('SELECT * FROM reorder_proposals WHERE id=? AND company_id=?').get(integer(id,'proposalId',1),req.company.id);
    if (!row) throw fail('Proposal not found in selected company',404);
    branch(req,row.branch_id,row.gstin_id);
    return row;
  };
  const stock = (companyId,branchId,itemId) => db.prepare('SELECT COALESCE(SUM(quantity_delta),0) AS quantity FROM stock_movements WHERE company_id=? AND branch_id=? AND item_id=?').get(companyId,branchId,itemId).quantity;
  const batchAllocated = (companyId,branchId,itemId) => db.prepare(`SELECT COALESCE(SUM(m.quantity_delta),0) AS quantity FROM batch_movements m JOIN batch_lots l ON l.id=m.batch_id WHERE m.company_id=? AND m.branch_id=? AND l.item_id=?`).get(companyId,branchId,itemId).quantity;
  const locationAllocated = (companyId,branchId,itemId) => {
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='location_movements'").get()) return 0;
    return db.prepare(`SELECT COALESCE(SUM(m.quantity_delta),0) AS quantity FROM location_movements m JOIN locations l ON l.id=m.location_id WHERE m.company_id=? AND l.branch_id=? AND m.item_id=?`).get(companyId,branchId,itemId).quantity;
  };
  const lines = id => db.prepare(`SELECT l.*,i.sku,i.name AS item_name FROM count_lines l JOIN items i ON i.id=l.item_id WHERE l.session_id=? ORDER BY i.sku`).all(id).map(row => ({...camel(row),difference:row.counted_quantity===null?null:row.counted_quantity-row.recorded_quantity}));
  const countDetail = row => ({...camel(row),lines:lines(row.id),events:db.prepare('SELECT * FROM count_events WHERE session_id=? ORDER BY id').all(row.id).map(camel)});
  const event = (row,actor,action,details='') => db.prepare('INSERT INTO count_events(session_id,company_id,actor_id,action,details) VALUES (?,?,?,?,?)').run(row.id,row.company_id,actor,action,details);

  app.get('/api/counts',route(req => {
    const selected=branch(req,Number(req.query.branchId),req.query.gstinId===undefined?undefined:Number(req.query.gstinId));
    return { sessions:db.prepare('SELECT * FROM count_sessions WHERE company_id=? AND branch_id=? ORDER BY id DESC LIMIT 100').all(req.company.id,selected.id).map(countDetail) };
  }));
  app.get('/api/counts/:id',route(req => ({session:countDetail(session(req,Number(req.params.id)))})));
  app.post('/api/counts',route(req => atomic(() => {
    preparer(req);
    const body=req.body || {}, selected=branch(req,body.branchId,body.gstinId);
    let items;
    if (body.itemIds === undefined) items=db.prepare('SELECT id FROM items WHERE company_id=? AND active=1 AND track_stock=1 ORDER BY id').all(req.company.id);
    else {
      if (!Array.isArray(body.itemIds) || body.itemIds.length<1 || body.itemIds.length>100) throw fail('itemIds must contain 1–100 items');
      const ids=body.itemIds.map(value => integer(value,'itemId',1));
      if (new Set(ids).size!==ids.length) throw fail('Duplicate items are not allowed');
      items=ids.map(id => {
        const item=db.prepare('SELECT id FROM items WHERE id=? AND company_id=? AND active=1 AND track_stock=1').get(id,req.company.id);
        if (!item) throw fail('Tracked item not found in selected company',404);
        return item;
      });
    }
    if (!items.length || items.length>100) throw fail('Count requires 1–100 active tracked items');
    const id=Number(db.prepare('INSERT INTO count_sessions(company_id,gstin_id,branch_id,created_by) VALUES (?,?,?,?)').run(req.company.id,selected.gstin_id,selected.id,req.user.id).lastInsertRowid);
    for (const item of items) {
      const recorded=stock(req.company.id,selected.id,item.id);
      if (recorded<0) throw fail('Recorded stock is negative; correct the source ledger first',409);
      db.prepare('INSERT INTO count_lines(session_id,item_id,recorded_quantity) VALUES (?,?,?)').run(id,item.id,recorded);
    }
    const row=session(req,id); event(row,req.user.id,'create',JSON.stringify({itemIds:items.map(item=>item.id)}));
    return {session:countDetail(row)};
  })));
  app.put('/api/counts/:id/lines/:lineId',route(req => atomic(() => {
    preparer(req);
    const row=session(req,Number(req.params.id));
    if (row.status!=='draft' || row.created_by!==req.user.id) throw fail('Only the count creator can edit a draft',409);
    const line=db.prepare('SELECT * FROM count_lines WHERE id=? AND session_id=?').get(integer(Number(req.params.lineId),'lineId',1),row.id);
    if (!line) throw fail('Count line not found',404);
    const body=req.body || {}, counted=integer(body.countedQuantity,'countedQuantity'), reason=words(body.reason ?? '','reason',500,false);
    if (counted!==line.recorded_quantity && !reason) throw fail('A difference requires an investigation reason');
    db.prepare('UPDATE count_lines SET counted_quantity=?,reason=? WHERE id=?').run(counted,reason,line.id);
    event(row,req.user.id,'record_line',JSON.stringify({lineId:line.id,previous:line.counted_quantity,countedQuantity:counted,reason}));
    return {session:countDetail(row)};
  })));
  app.post('/api/counts/:id/submit',route(req => atomic(() => {
    preparer(req);
    const row=session(req,Number(req.params.id));
    if (row.status==='submitted') return {session:countDetail(row),replayed:true};
    if (row.status!=='draft' || row.created_by!==req.user.id) throw fail('Only the count creator can submit a draft',409);
    const entries=lines(row.id);
    if (entries.some(line => line.countedQuantity===null || (line.difference!==0 && !line.reason))) throw fail('Every item needs a count and every difference a reason');
    db.prepare("UPDATE count_sessions SET status='submitted',submitted_by=?,submitted_at=CURRENT_TIMESTAMP WHERE id=?").run(req.user.id,row.id);
    event(row,req.user.id,'submit');
    return {session:countDetail(session(req,row.id)),replayed:false};
  })));
  app.post('/api/counts/:id/review',route(req => atomic(() => {
    reviewer(req);
    const row=session(req,Number(req.params.id)), body=req.body || {};
    if (!['approve','reject'].includes(body.decision)) throw fail('decision must be approve or reject');
    const reviewReason=words(body.reason ?? '','reason',500,body.decision==='reject');
    const target=body.decision==='approve'?'approved':'rejected';
    if (row.status===target && row.review_reason===reviewReason) return {session:countDetail(row),replayed:true};
    if (row.status!=='submitted') throw fail('Count is not awaiting review',409);
    if (row.created_by===req.user.id) throw fail('An independent reviewer is required',403);
    if (target==='approved') {
      for (const line of lines(row.id)) {
        const current=stock(row.company_id,row.branch_id,line.itemId);
        if (current!==line.recordedQuantity) throw fail(`${line.sku} stock changed since count snapshot; start a new count`,409);
        if (line.difference<0) {
          const floor=batchAllocated(row.company_id,row.branch_id,line.itemId)+locationAllocated(row.company_id,row.branch_id,line.itemId);
          if (line.countedQuantity<floor) throw fail(`${line.sku} count is below allocated batch or location stock; resolve allocation first`,409);
        }
        if (line.difference) {
          const movementId=Number(db.prepare(`INSERT INTO stock_movements(company_id,branch_id,item_id,quantity_delta,type,reason,client_reference)
            VALUES (?,?,?,?,?,?,?)`).run(row.company_id,row.branch_id,line.itemId,line.difference,'count_adjustment',line.reason,`count:${row.id}:line:${line.id}`).lastInsertRowid);
          db.prepare('UPDATE count_lines SET stock_movement_id=? WHERE id=?').run(movementId,line.id);
        }
      }
    }
    db.prepare('UPDATE count_sessions SET status=?,reviewed_by=?,review_reason=?,reviewed_at=CURRENT_TIMESTAMP WHERE id=?').run(target,req.user.id,reviewReason,row.id);
    event(row,req.user.id,target,reviewReason);
    return {session:countDetail(session(req,row.id)),replayed:false};
  })));

  const metrics = (req,selected,item,lookbackDays,coverDays) => {
    const since=new Date(Date.now()-(lookbackDays-1)*86400000).toISOString().slice(0,10);
    const invoicedSales=db.prepare(`SELECT COALESCE(SUM(il.quantity),0) AS quantity FROM invoice_lines il
      JOIN invoices i ON i.id=il.invoice_id WHERE i.company_id=? AND i.branch_id=? AND i.type='sale'
      AND i.status='approved' AND i.invoice_date>=? AND il.item_id=?`).get(req.company.id,selected.id,since,item.id).quantity;
    const unbilledDispatch=db.prepare(`SELECT COALESCE(SUM(fl.quantity),0) AS quantity FROM order_fulfillment_lines fl
      JOIN order_fulfillments f ON f.id=fl.fulfillment_id JOIN orders o ON o.id=f.order_id
      JOIN order_lines ol ON ol.id=fl.order_line_id
      WHERE f.company_id=? AND o.branch_id=? AND o.type='sale' AND f.status='confirmed'
      AND f.event_date>=? AND ol.item_id=? AND NOT EXISTS (
        SELECT 1 FROM invoice_lines il JOIN invoices i ON i.id=il.invoice_id
        WHERE il.fulfillment_line_id=fl.id AND i.type='sale' AND i.status='approved'
      )`).get(req.company.id,selected.id,since,item.id).quantity;
    const sales=invoicedSales+unbilledDispatch;
    const commitments=db.prepare(`SELECT o.type,COALESCE(SUM(l.quantity-COALESCE((SELECT SUM(fl.quantity) FROM order_fulfillment_lines fl
      JOIN order_fulfillments f ON f.id=fl.fulfillment_id WHERE fl.order_line_id=l.id AND f.status='confirmed'),0)),0) AS quantity
      FROM orders o JOIN order_lines l ON l.order_id=o.id WHERE o.company_id=? AND o.branch_id=? AND o.status='confirmed' AND l.item_id=? GROUP BY o.type`).all(req.company.id,selected.id,item.id);
    const openSales=commitments.find(row=>row.type==='sale')?.quantity || 0;
    const pendingSupply=commitments.find(row=>row.type==='purchase')?.quantity || 0;
    const onHand=stock(req.company.id,selected.id,item.id);
    const target=Math.max(item.reorder_level,Math.ceil(sales*coverDays/lookbackDays));
    const projectedAvailable=onHand+pendingSupply-openSales;
    return {itemId:item.id,sku:item.sku,itemName:item.name,branchId:selected.id,gstinId:selected.gstin_id,lookbackDays,coverDays,actualSalesUnits:sales,onHandUnits:onHand,openSalesUnits:openSales,pendingSupplyUnits:pendingSupply,minimumUnits:item.reorder_level,targetUnits:target,projectedAvailableUnits:projectedAvailable,proposedUnits:Math.max(0,target-projectedAvailable),method:'Approved sale invoice quantities plus confirmed dispatches without an approved linked invoice in lookback; open confirmed order balance; target is greater of item minimum and sales pace × cover days. No forecast or purchase order is created.'};
  };
  const parameters = req => {
    const selected=branch(req,Number(req.query.branchId),req.query.gstinId===undefined?undefined:Number(req.query.gstinId));
    const lookbackDays=integer(req.query.lookbackDays===undefined?90:Number(req.query.lookbackDays),'lookbackDays',1);
    const coverDays=integer(req.query.coverDays===undefined?30:Number(req.query.coverDays),'coverDays',1);
    if (lookbackDays>365 || coverDays>365) throw fail('Planning windows must be at most 365 days');
    return {selected,lookbackDays,coverDays};
  };
  const proposalDetail = row => ({...camel(row),metrics:JSON.parse(row.metrics_json),events:db.prepare('SELECT * FROM reorder_events WHERE proposal_id=? ORDER BY id').all(row.id).map(camel)});
  app.get('/api/replenishment',route(req => {
    const {selected,lookbackDays,coverDays}=parameters(req);
    const items=db.prepare('SELECT * FROM items WHERE company_id=? AND active=1 AND track_stock=1 ORDER BY sku').all(req.company.id);
    const proposals=db.prepare('SELECT * FROM reorder_proposals WHERE company_id=? AND branch_id=? ORDER BY id DESC LIMIT 100').all(req.company.id,selected.id);
    return {method:'Sales-based arithmetic from approved invoices, confirmed dispatches and open confirmed orders; no predictive AI or automatic purchasing.',rows:items.map(item=>metrics(req,selected,item,lookbackDays,coverDays)),proposals:proposals.map(proposalDetail)};
  }));
  app.post('/api/replenishment/proposals',route(req => atomic(() => {
    preparer(req);
    const body=req.body || {}, selected=branch(req,body.branchId,body.gstinId);
    const item=db.prepare('SELECT * FROM items WHERE id=? AND company_id=? AND active=1 AND track_stock=1').get(integer(body.itemId,'itemId',1),req.company.id);
    if (!item) throw fail('Tracked item not found in selected company',404);
    const lookbackDays=integer(body.lookbackDays ?? 90,'lookbackDays',1),coverDays=integer(body.coverDays ?? 30,'coverDays',1);
    if (lookbackDays>365 || coverDays>365) throw fail('Planning windows must be at most 365 days');
    const values=metrics(req,selected,item,lookbackDays,coverDays);
    if (!values.proposedUnits) throw fail('Current arithmetic does not indicate a shortage',409);
    const id=Number(db.prepare('INSERT INTO reorder_proposals(company_id,gstin_id,branch_id,item_id,metrics_json,created_by) VALUES (?,?,?,?,?,?)').run(req.company.id,selected.gstin_id,selected.id,item.id,JSON.stringify(values),req.user.id).lastInsertRowid);
    db.prepare("INSERT INTO reorder_events(proposal_id,company_id,actor_id,action,details) VALUES (?,?,?,'create',?)").run(id,req.company.id,req.user.id,JSON.stringify(values));
    return {proposal:proposalDetail(proposal(req,id))};
  })));
  app.post('/api/replenishment/proposals/:id/review',route(req => atomic(() => {
    reviewer(req);
    const row=proposal(req,Number(req.params.id)), body=req.body || {};
    if (!['approve','reject'].includes(body.decision)) throw fail('decision must be approve or reject');
    const reason=words(body.reason ?? '','reason',500,body.decision==='reject');
    const target=body.decision==='approve'?'approved':'rejected';
    if (row.status===target && row.review_reason===reason) return {proposal:proposalDetail(row),replayed:true};
    if (row.status!=='pending') throw fail('Proposal has already been reviewed',409);
    if (row.created_by===req.user.id) throw fail('An independent reviewer is required',403);
    if (target==='approved') {
      const item=db.prepare('SELECT * FROM items WHERE id=? AND company_id=? AND active=1 AND track_stock=1').get(row.item_id,row.company_id);
      if (!item) throw fail('Proposal item is no longer active and tracked',409);
      const original=JSON.parse(row.metrics_json);
      const current=metrics(req,branch(req,row.branch_id,row.gstin_id),item,original.lookbackDays,original.coverDays);
      const values=['actualSalesUnits','onHandUnits','openSalesUnits','pendingSupplyUnits','minimumUnits','targetUnits','proposedUnits'];
      if (values.some(key=>current[key]!==original[key])) throw fail('Planning inputs changed; save a new proposal',409);
    }
    db.prepare('UPDATE reorder_proposals SET status=?,reviewed_by=?,review_reason=?,reviewed_at=CURRENT_TIMESTAMP WHERE id=?').run(target,req.user.id,reason,row.id);
    db.prepare('INSERT INTO reorder_events(proposal_id,company_id,actor_id,action,details) VALUES (?,?,?,?,?)').run(row.id,row.company_id,req.user.id,target,reason);
    return {proposal:proposalDetail(proposal(req,row.id)),replayed:false};
  })));
}

module.exports = { registerCountsRoutes };
