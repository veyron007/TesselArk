const { installOrdersSchema } = require('./orders-db.cjs');
const { allocateBatchIssue } = require('./batch-inventory.cjs');
const { allowedScopes, assertScopeAccess, assertGstinAccess } = require('./access.cjs');
const { holdBaseline, assertCreditHold } = require('./credit.cjs');

const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const positive = (value, name) => { const n = Number(value); if (!Number.isSafeInteger(n) || n < 1) throw fail(`${name} must be a positive integer`); return n; };
const nonnegative = (value, name) => { const n = Number(value); if (!Number.isSafeInteger(n) || n < 0) throw fail(`${name} must be a non-negative integer`); return n; };
const string = (value, name, max = 200, required = true) => { if (typeof value !== 'string' || value.length > max || (required && !value.trim())) throw fail(`${name} is invalid`); return value.trim(); };
const day = value => { const s = string(value, 'date', 10); if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || Number.isNaN(Date.parse(`${s}T00:00:00Z`)) || new Date(`${s}T00:00:00Z`).toISOString().slice(0,10) !== s) throw fail('date must be YYYY-MM-DD'); return s; };
const camel = row => Object.fromEntries(Object.entries(row).map(([key,value]) => [key.replace(/_([a-z])/g, (_,letter) => letter.toUpperCase()),value]));

function registerOrdersRoutes(app, db) {
  installOrdersSchema(db);
  const route = handler => (req,res,next) => { try { res.json(handler(req)); } catch (error) { next(error); } };
  const atomic = action => { db.exec('BEGIN IMMEDIATE'); try { const result = action(); db.exec('COMMIT'); return result; } catch (error) { db.exec('ROLLBACK'); throw error; } };
  const scoped = (table,id,companyId) => { const row = db.prepare(`SELECT * FROM ${table} WHERE id=? AND company_id=?`).get(id,companyId); if (!row) throw fail(`${table.slice(0,-1)} not found in selected company`,404); return row; };
  const scope = (req,row) => assertScopeAccess(db,{companyId:req.company.id,userId:req.user.id,gstinId:row.gstin_id,branchId:row.branch_id});
  const orderFor = (req,id) => { const row=scoped('orders',id,req.company.id); scope(req,row); return row; };
  const visible = req => (req.scopes || allowedScopes(db,{companyId:req.company.id,userId:req.user.id})).branchIds;
  const event = (order,actorId,action,fulfillmentId=null,details='') => db.prepare('INSERT INTO order_events(company_id,order_id,fulfillment_id,action,actor_id,details) VALUES (?,?,?,?,?,?)').run(order.company_id,order.id,fulfillmentId,action,actorId,details);
  const lines = id => db.prepare(`SELECT l.*,i.sku,i.track_stock FROM order_lines l JOIN items i ON i.id=l.item_id WHERE l.order_id=? ORDER BY l.id`).all(id).map(row => {
    const confirmed = db.prepare(`SELECT COALESCE(SUM(fl.quantity),0) AS quantity FROM order_fulfillment_lines fl JOIN order_fulfillments f ON f.id=fl.fulfillment_id WHERE fl.order_line_id=? AND f.status='confirmed'`).get(row.id).quantity;
    return { ...camel(row),confirmedQuantity:confirmed,remainingQuantity:row.quantity-confirmed };
  });
  const fulfillmentDetail = (id,companyId) => {
    const row = scoped('order_fulfillments',id,companyId);
    return { ...camel(row),lines:db.prepare('SELECT * FROM order_fulfillment_lines WHERE fulfillment_id=? ORDER BY id').all(id).map(line => {
      const reference=`order-fulfillment:${id}:line:${line.id}`;
      const allocation=db.prepare('SELECT result_json FROM batch_issue_operations WHERE company_id=? AND source_reference=?').get(companyId,reference);
      return { ...camel(line),allocation:allocation?JSON.parse(allocation.result_json):null };
    }) };
  };
  const detail = (id,companyId) => {
    const row = scoped('orders',id,companyId);
    const orderLines = lines(id);
    const fulfillmentRows = db.prepare('SELECT id FROM order_fulfillments WHERE order_id=? ORDER BY id').all(id).map(item => fulfillmentDetail(item.id,companyId));
    return { ...camel(row),lines:orderLines,fulfillments:fulfillmentRows,orderedQuantity:orderLines.reduce((sum,line)=>sum+line.quantity,0),confirmedQuantity:orderLines.reduce((sum,line)=>sum+line.confirmedQuantity,0),remainingQuantity:orderLines.reduce((sum,line)=>sum+line.remainingQuantity,0),subtotalCents:orderLines.reduce((sum,line)=>sum+line.quantity*line.unitPriceCents,0) };
  };

  app.get('/api/orders', route(req => {
    const gstinId = req.query.gstinId ? positive(req.query.gstinId,'gstinId') : null;
    const branchId = req.query.branchId ? positive(req.query.branchId,'branchId') : null;
    if (gstinId && !db.prepare('SELECT 1 FROM gstins WHERE id=? AND company_id=?').get(gstinId,req.company.id)) throw fail('GSTIN not found in selected company',404);
    if (branchId && !db.prepare('SELECT 1 FROM branches WHERE id=? AND company_id=?').get(branchId,req.company.id)) throw fail('Branch not found in selected company',404);
    if (gstinId) assertGstinAccess(db,{companyId:req.company.id,userId:req.user.id,gstinId});
    if (branchId) assertScopeAccess(db,{companyId:req.company.id,userId:req.user.id,gstinId:gstinId ?? undefined,branchId});
    const branches=visible(req);
    return { orders:db.prepare(`SELECT id FROM orders WHERE company_id=? AND branch_id IN (${branches.map(()=>'?').join(',') || 'NULL'}) AND (? IS NULL OR gstin_id=?) AND (? IS NULL OR branch_id=?) ORDER BY id DESC`).all(req.company.id,...branches,gstinId,gstinId,branchId,branchId).map(row => detail(row.id,req.company.id)) };
  }));
  app.get('/api/orders/:id/events', route(req => { const id=positive(req.params.id,'id'); orderFor(req,id); return { events:db.prepare('SELECT * FROM order_events WHERE order_id=? ORDER BY id').all(id).map(camel) }; }));
  app.get('/api/orders/:id', route(req => { const id=positive(req.params.id,'id'); orderFor(req,id); return { order:detail(id,req.company.id) }; }));
  app.post('/api/orders', route(req => atomic(() => {
    const body=req.body || {}, type=body.type;
    if (!['purchase','sale'].includes(type)) throw fail('type must be purchase or sale');
    const gstinId=positive(body.gstinId,'gstinId'), branchId=positive(body.branchId,'branchId'), partyId=positive(body.partyId,'partyId');
    const branch=db.prepare('SELECT * FROM branches WHERE id=? AND company_id=? AND gstin_id=?').get(branchId,req.company.id,gstinId);
    if (!branch) throw fail('Branch and GSTIN must belong to selected company and each other');
    scope(req,{gstin_id:gstinId,branch_id:branchId});
    const party=db.prepare('SELECT * FROM parties WHERE id=? AND company_id=?').get(partyId,req.company.id);
    if (!party || ![type==='purchase'?'supplier':'customer','both'].includes(party.type)) throw fail('Party is not valid for this order type');
    if (!Array.isArray(body.lines) || !body.lines.length || body.lines.length>100) throw fail('lines must contain 1–100 items');
    const seen=new Set();
    const values=body.lines.map(line => {
      const itemId=positive(line.itemId,'itemId'),quantity=positive(line.quantity,'quantity'),unitPriceCents=nonnegative(line.unitPriceCents,'unitPriceCents');
      if (seen.has(itemId)) throw fail('Duplicate item lines are not supported'); seen.add(itemId);
      const item=db.prepare('SELECT * FROM items WHERE id=? AND company_id=? AND active=1').get(itemId,req.company.id);
      if (!item) throw fail('Item not found in selected company');
      const gstRateBps=nonnegative(line.gstRateBps ?? item.gst_rate_bps,'gstRateBps');
      if (gstRateBps>10000) throw fail('gstRateBps must be at most 10000');
      if (req.company.tax_regime==='composition' && gstRateBps!==0) throw fail('Composition company orders must use zero ordinary GST rate');
      const subtotal=quantity*unitPriceCents;
      const tax=Math.round(subtotal*gstRateBps/10000);
      if (!Number.isSafeInteger(subtotal) || !Number.isSafeInteger(tax) || !Number.isSafeInteger(subtotal+tax)) throw fail('Order line amount is too large');
      return { itemId,quantity,unitPriceCents,gstRateBps,itemName:item.name };
    });
    const totals=values.reduce((sum,line)=>{const subtotal=line.quantity*line.unitPriceCents;return {subtotal:sum.subtotal+subtotal,tax:sum.tax+Math.round(subtotal*line.gstRateBps/10000)};},{subtotal:0,tax:0});
    if (!Number.isSafeInteger(totals.subtotal) || !Number.isSafeInteger(totals.tax) || !Number.isSafeInteger(totals.subtotal+totals.tax)) throw fail('Order total is too large');
    const number=string(body.number,'number',60),orderDate=day(body.orderDate),notes=string(body.notes ?? '','notes',1000,false);
    if (db.prepare('SELECT 1 FROM orders WHERE company_id=? AND number=?').get(req.company.id,number)) throw fail('Order number already exists in selected company',409);
    const id=Number(db.prepare('INSERT INTO orders(company_id,gstin_id,branch_id,party_id,party_name_snapshot,type,number,order_date,notes,created_by) VALUES (?,?,?,?,?,?,?,?,?,?)').run(req.company.id,gstinId,branchId,partyId,party.name,type,number,orderDate,notes,req.user.id).lastInsertRowid);
    const insert=db.prepare('INSERT INTO order_lines(order_id,item_id,item_name_snapshot,quantity,unit_price_cents,gst_rate_bps) VALUES (?,?,?,?,?,?)');
    values.forEach(line => insert.run(id,line.itemId,line.itemName,line.quantity,line.unitPriceCents,line.gstRateBps));
    event(scoped('orders',id,req.company.id),req.user.id,'create');
    return { order:detail(id,req.company.id) };
  })));
  app.post('/api/orders/:id/confirm', route(req => atomic(() => {
    const row=orderFor(req,positive(req.params.id,'id'));
    if (row.status==='confirmed') return { order:detail(row.id,req.company.id),replayed:true };
    const creditScope={companyId:req.company.id,gstinId:row.gstin_id,branchId:row.branch_id,partyId:row.party_id};
    const before=row.type==='sale' ? holdBaseline(db,creditScope) : null;
    db.prepare("UPDATE orders SET status='confirmed',confirmed_by=?,confirmed_at=CURRENT_TIMESTAMP WHERE id=?").run(req.user.id,row.id);
    assertCreditHold(db,creditScope,before);
    event(row,req.user.id,'confirm');
    return { order:detail(row.id,req.company.id),replayed:false };
  })));
  app.post('/api/orders/:id/fulfillments', route(req => atomic(() => {
    const order=orderFor(req,positive(req.params.id,'id'));
    if (order.status!=='confirmed') throw fail('Confirm the order before creating a receipt or dispatch',409);
    const body=req.body || {}, requested=body.lines;
    if (!Array.isArray(requested) || !requested.length || requested.length>100) throw fail('lines must contain 1–100 order lines');
    const orderLines=lines(order.id),seen=new Set();
    const entries=requested.map(line => {
      const orderLineId=positive(line.orderLineId,'orderLineId'),quantity=positive(line.quantity,'quantity');
      if (seen.has(orderLineId)) throw fail('Duplicate order line'); seen.add(orderLineId);
      const source=orderLines.find(item=>item.id===orderLineId);
      if (!source) throw fail('Order line not found');
      if (quantity>source.remainingQuantity) throw fail('Quantity exceeds remaining order quantity',409);
      return { orderLineId,quantity };
    });
    const number=string(body.number,'number',60),eventDate=day(body.eventDate),notes=string(body.notes ?? '','notes',1000,false),kind=order.type==='purchase'?'receipt':'dispatch';
    if (db.prepare('SELECT 1 FROM order_fulfillments WHERE company_id=? AND number=?').get(req.company.id,number)) throw fail('Fulfillment number already exists in selected company',409);
    const id=Number(db.prepare('INSERT INTO order_fulfillments(order_id,company_id,number,kind,event_date,notes,created_by) VALUES (?,?,?,?,?,?,?)').run(order.id,req.company.id,number,kind,eventDate,notes,req.user.id).lastInsertRowid);
    const insert=db.prepare('INSERT INTO order_fulfillment_lines(fulfillment_id,order_line_id,quantity) VALUES (?,?,?)');
    entries.forEach(line=>insert.run(id,line.orderLineId,line.quantity));
    event(order,req.user.id,'create_fulfillment',id,kind);
    return { fulfillment:fulfillmentDetail(id,req.company.id),order:detail(order.id,req.company.id) };
  })));
  app.post('/api/orders/fulfillments/:id/confirm', route(req => atomic(() => {
    const fulfillment=scoped('order_fulfillments',positive(req.params.id,'id'),req.company.id);
    const order=scoped('orders',fulfillment.order_id,req.company.id);
    scope(req,order);
    if (fulfillment.status==='confirmed') return { fulfillment:fulfillmentDetail(fulfillment.id,req.company.id),order:detail(order.id,req.company.id),replayed:true };
    const entries=fulfillmentDetail(fulfillment.id,req.company.id).lines;
    for (const entry of entries) {
      const source=db.prepare('SELECT l.*,i.track_stock FROM order_lines l JOIN items i ON i.id=l.item_id WHERE l.id=? AND l.order_id=?').get(entry.orderLineId,order.id);
      if (!source) throw fail('Order line missing',409);
      const confirmed=db.prepare(`SELECT COALESCE(SUM(fl.quantity),0) AS quantity FROM order_fulfillment_lines fl JOIN order_fulfillments f ON f.id=fl.fulfillment_id WHERE fl.order_line_id=? AND f.status='confirmed'`).get(source.id).quantity;
      if (confirmed+entry.quantity>source.quantity) throw fail('Quantity exceeds remaining order quantity',409);
      if (source.track_stock && order.type==='sale') {
        const stock=db.prepare('SELECT COALESCE(SUM(quantity_delta),0) AS quantity FROM stock_movements WHERE company_id=? AND branch_id=? AND item_id=?').get(req.company.id,order.branch_id,source.item_id).quantity;
        if (stock<entry.quantity) throw fail('Insufficient stock for dispatch',409);
      }
      if (source.track_stock) {
        let movementId;
        if (order.type==='sale') {
          movementId=allocateBatchIssue(db,{companyId:req.company.id,branchId:order.branch_id,itemId:source.item_id,quantity:entry.quantity,reason:fulfillment.number,sourceReference:`order-fulfillment:${fulfillment.id}:line:${entry.id}`,userId:req.user.id,movementType:'sales_dispatch'}).firstStockMovementId;
        } else {
          movementId=Number(db.prepare('INSERT INTO stock_movements(company_id,branch_id,item_id,quantity_delta,type,reason,client_reference) VALUES (?,?,?,?,?,?,?)').run(req.company.id,order.branch_id,source.item_id,entry.quantity,'purchase_receipt',fulfillment.number,`order-fulfillment:${fulfillment.id}:line:${entry.id}`).lastInsertRowid);
        }
        db.prepare('UPDATE order_fulfillment_lines SET stock_movement_id=? WHERE id=?').run(movementId,entry.id);
      }
    }
    db.prepare("UPDATE order_fulfillments SET status='confirmed',confirmed_by=?,confirmed_at=CURRENT_TIMESTAMP WHERE id=?").run(req.user.id,fulfillment.id);
    event(order,req.user.id,'confirm_fulfillment',fulfillment.id,fulfillment.kind);
    return { fulfillment:fulfillmentDetail(fulfillment.id,req.company.id),order:detail(order.id,req.company.id),replayed:false };
  })));
}

module.exports = { registerOrdersRoutes };
