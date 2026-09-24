const { installQuotesSchema }=require('./quotes-db.cjs');
const { allowedScopes,assertScopeAccess,assertGstinAccess }=require('./access.cjs');

const fail=(message,status=400)=>Object.assign(new Error(message),{status});
const integerValue=value=>(typeof value==='number'&&Number.isSafeInteger(value))||(typeof value==='string'&&/^\d+$/.test(value))?Number(value):NaN;
const positive=(value,name)=>{const n=integerValue(value);if(!Number.isSafeInteger(n)||n<1)throw fail(`${name} must be a positive integer`);return n;};
const nonnegative=(value,name)=>{const n=integerValue(value);if(!Number.isSafeInteger(n)||n<0)throw fail(`${name} must be a non-negative integer`);return n;};
const text=(value,name,max=200,required=true)=>{if(typeof value!=='string'||value.length>max||(required&&!value.trim()))throw fail(`${name} is invalid`);return value.trim();};
const day=(value,name)=>{const s=text(value,name,10);if(!/^\d{4}-\d{2}-\d{2}$/.test(s)||Number.isNaN(Date.parse(`${s}T00:00:00Z`))||new Date(`${s}T00:00:00Z`).toISOString().slice(0,10)!==s)throw fail(`${name} must be YYYY-MM-DD`);return s;};
const camel=row=>Object.fromEntries(Object.entries(row).map(([key,value])=>[key.replace(/_([a-z])/g,(_,letter)=>letter.toUpperCase()),value]));
const today=()=>new Date().toISOString().slice(0,10);

function registerQuotesRoutes(app,db) {
  installQuotesSchema(db);
  const route=handler=>(req,res,next)=>{try{res.json(handler(req));}catch(error){next(error);}};
  const atomic=action=>{db.exec('SAVEPOINT quote_route');try{const result=action();db.exec('RELEASE quote_route');return result;}catch(error){db.exec('ROLLBACK TO quote_route');db.exec('RELEASE quote_route');throw error;}};
  const scope=(req,gstinId,branchId)=>assertScopeAccess(db,{companyId:req.company.id,userId:req.user.id,gstinId,branchId});
  const event=(quoteId,companyId,actorId,action,details='')=>db.prepare('INSERT INTO quote_events(company_id,quote_id,action,actor_id,details) VALUES (?,?,?,?,?)').run(companyId,quoteId,action,actorId,details);
  const find=(req,id)=>{
    const quote=db.prepare('SELECT * FROM quotes WHERE id=? AND company_id=?').get(id,req.company.id);
    if(!quote)throw fail('Quote not found in selected company',404);
    scope(req,quote.gstin_id,quote.branch_id);
    return quote;
  };
  const detail=(id,companyId)=>{
    const row=db.prepare('SELECT * FROM quotes WHERE id=? AND company_id=?').get(id,companyId);
    if(!row)throw fail('Quote not found in selected company',404);
    const converted=db.prepare('SELECT id FROM orders WHERE source_quote_id=? AND company_id=?').get(id,companyId);
    const lines=db.prepare('SELECT * FROM quote_lines WHERE quote_id=? ORDER BY id').all(id).map(camel);
    const events=db.prepare('SELECT * FROM quote_events WHERE quote_id=? AND company_id=? ORDER BY id').all(id,companyId).map(camel);
    return {...camel(row),convertedOrderId:converted?.id??null,expired:row.expiry_date<today(),lines,events};
  };
  const auditTerms=quote=>({
    number:quote.number,gstinId:quote.gstinId,branchId:quote.branchId,partyId:quote.partyId,
    partyNameSnapshot:quote.partyNameSnapshot,partyGstinSnapshot:quote.partyGstinSnapshot,
    quoteDate:quote.quoteDate,expiryDate:quote.expiryDate,notes:quote.notes,
    subtotalCents:quote.subtotalCents,taxCents:quote.taxCents,totalCents:quote.totalCents,
    lines:quote.lines.map(line=>({itemId:line.itemId,itemSkuSnapshot:line.itemSkuSnapshot,itemNameSnapshot:line.itemNameSnapshot,itemHsnSnapshot:line.itemHsnSnapshot,itemUnitSnapshot:line.itemUnitSnapshot,quantity:line.quantity,unitPriceCents:line.unitPriceCents,gstRateBps:line.gstRateBps,subtotalCents:line.subtotalCents,taxCents:line.taxCents,totalCents:line.totalCents}))
  });
  const validated=(req,body,existingId=null)=>{
    const companyId=req.company.id,gstinId=positive(body.gstinId,'gstinId'),branchId=positive(body.branchId,'branchId'),partyId=positive(body.partyId,'partyId');
    const branch=db.prepare('SELECT id FROM branches WHERE id=? AND company_id=? AND gstin_id=?').get(branchId,companyId,gstinId);
    if(!branch)throw fail('Branch and GSTIN must belong to selected company and each other');
    scope(req,gstinId,branchId);
    const party=db.prepare('SELECT * FROM parties WHERE id=? AND company_id=?').get(partyId,companyId);
    if(!party||!['customer','both'].includes(party.type))throw fail('Party must be a customer in selected company');
    const number=text(body.number,'number',60),quoteDate=day(body.quoteDate,'quoteDate'),expiryDate=day(body.expiryDate,'expiryDate'),notes=text(body.notes??'','notes',1000,false);
    if(expiryDate<quoteDate)throw fail('expiryDate must be on or after quoteDate');
    if(db.prepare('SELECT 1 FROM quotes WHERE company_id=? AND number=? AND id<>?').get(companyId,number,existingId??0))throw fail('Quote number already exists in selected company',409);
    if(!Array.isArray(body.lines)||body.lines.length<1||body.lines.length>100)throw fail('lines must contain 1–100 items');
    const seen=new Set(),lines=body.lines.map(line=>{
      if(!line||typeof line!=='object')throw fail('Quote line is invalid');
      const itemId=positive(line.itemId,'itemId'),quantity=positive(line.quantity,'quantity'),unitPriceCents=nonnegative(line.unitPriceCents,'unitPriceCents');
      if(seen.has(itemId))throw fail('Duplicate item lines are not supported');seen.add(itemId);
      const item=db.prepare('SELECT * FROM items WHERE id=? AND company_id=? AND active=1').get(itemId,companyId);
      if(!item)throw fail('Item not found in selected company');
      const gstRateBps=nonnegative(line.gstRateBps??item.gst_rate_bps,'gstRateBps');
      if(gstRateBps>10000)throw fail('gstRateBps must be at most 10000');
      if(req.company.tax_regime==='composition'&&gstRateBps!==0)throw fail('Composition company quotes must use zero ordinary GST rate');
      const subtotalCents=quantity*unitPriceCents,taxCents=Math.round(subtotalCents*gstRateBps/10000),totalCents=subtotalCents+taxCents;
      if(![subtotalCents,taxCents,totalCents].every(Number.isSafeInteger))throw fail('Quote line amount is too large');
      return {itemId,sku:item.sku,name:item.name,hsn:item.hsn,unit:item.unit,quantity,unitPriceCents,gstRateBps,subtotalCents,taxCents,totalCents};
    });
    const totals=lines.reduce((acc,line)=>({subtotalCents:acc.subtotalCents+line.subtotalCents,taxCents:acc.taxCents+line.taxCents,totalCents:acc.totalCents+line.totalCents}),{subtotalCents:0,taxCents:0,totalCents:0});
    if(!Object.values(totals).every(Number.isSafeInteger))throw fail('Quote total is too large');
    return {companyId,gstinId,branchId,partyId,party,number,quoteDate,expiryDate,notes,lines,...totals};
  };
  const insertLines=(id,lines)=>{
    const insert=db.prepare('INSERT INTO quote_lines(quote_id,item_id,item_sku_snapshot,item_name_snapshot,item_hsn_snapshot,item_unit_snapshot,quantity,unit_price_cents,gst_rate_bps,subtotal_cents,tax_cents,total_cents) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)');
    for(const line of lines)insert.run(id,line.itemId,line.sku,line.name,line.hsn,line.unit,line.quantity,line.unitPriceCents,line.gstRateBps,line.subtotalCents,line.taxCents,line.totalCents);
  };
  const canReview=(req,quote)=>{
    if(!['accountant','admin'].includes(req.user.role))throw fail('Accountant or admin role required',403);
    if([quote.created_by,quote.submitted_by].includes(req.user.id))throw fail('An independent reviewer is required',403);
  };
  const notExpired=quote=>{if(quote.expiry_date<today())throw fail('Quote has expired',409);};

  app.get('/api/quotes',route(req=>{
    const gstinId=req.query.gstinId?positive(req.query.gstinId,'gstinId'):null;
    const branchId=req.query.branchId?positive(req.query.branchId,'branchId'):null;
    if(gstinId)assertGstinAccess(db,{companyId:req.company.id,userId:req.user.id,gstinId});
    if(branchId)assertScopeAccess(db,{companyId:req.company.id,userId:req.user.id,gstinId:gstinId??undefined,branchId});
    const branches=(req.scopes||allowedScopes(db,{companyId:req.company.id,userId:req.user.id})).branchIds;
    const rows=db.prepare(`SELECT id FROM quotes WHERE company_id=? AND branch_id IN (${branches.map(()=>'?').join(',')||'NULL'}) AND (? IS NULL OR gstin_id=?) AND (? IS NULL OR branch_id=?) ORDER BY id DESC`).all(req.company.id,...branches,gstinId,gstinId,branchId,branchId);
    return {quotes:rows.map(row=>detail(row.id,req.company.id))};
  }));
  app.get('/api/quotes/:id',route(req=>{const quote=find(req,positive(req.params.id,'id'));return {quote:detail(quote.id,req.company.id)};}));
  app.post('/api/quotes',route(req=>atomic(()=>{
    const v=validated(req,req.body||{});
    const id=Number(db.prepare(`INSERT INTO quotes(company_id,gstin_id,branch_id,party_id,party_name_snapshot,party_gstin_snapshot,number,quote_date,expiry_date,notes,subtotal_cents,tax_cents,total_cents,created_by)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(v.companyId,v.gstinId,v.branchId,v.partyId,v.party.name,v.party.gstin,v.number,v.quoteDate,v.expiryDate,v.notes,v.subtotalCents,v.taxCents,v.totalCents,req.user.id).lastInsertRowid);
    insertLines(id,v.lines);event(id,v.companyId,req.user.id,'create',JSON.stringify(auditTerms(detail(id,v.companyId))));
    return {quote:detail(id,v.companyId)};
  })));
  app.put('/api/quotes/:id',route(req=>atomic(()=>{
    const quote=find(req,positive(req.params.id,'id'));
    if(quote.status!=='draft')throw fail('Only a draft quote can be edited',409);
    if(quote.created_by!==req.user.id)throw fail('Only the quote creator can edit this draft',403);
    const before=auditTerms(detail(quote.id,req.company.id));
    const v=validated(req,req.body||{},quote.id);
    db.prepare(`UPDATE quotes SET gstin_id=?,branch_id=?,party_id=?,party_name_snapshot=?,party_gstin_snapshot=?,number=?,quote_date=?,expiry_date=?,notes=?,subtotal_cents=?,tax_cents=?,total_cents=? WHERE id=?`)
      .run(v.gstinId,v.branchId,v.partyId,v.party.name,v.party.gstin,v.number,v.quoteDate,v.expiryDate,v.notes,v.subtotalCents,v.taxCents,v.totalCents,quote.id);
    db.prepare('DELETE FROM quote_lines WHERE quote_id=?').run(quote.id);insertLines(quote.id,v.lines);
    event(quote.id,v.companyId,req.user.id,'edit',JSON.stringify({before,after:auditTerms(detail(quote.id,v.companyId))}));
    return {quote:detail(quote.id,v.companyId)};
  })));
  app.post('/api/quotes/:id/submit',route(req=>atomic(()=>{
    const quote=find(req,positive(req.params.id,'id'));
    if(quote.status!=='draft')throw fail('Only a draft quote can be submitted',409);
    notExpired(quote);
    db.prepare("UPDATE quotes SET status='submitted',submitted_by=?,submitted_at=CURRENT_TIMESTAMP WHERE id=?").run(req.user.id,quote.id);
    event(quote.id,req.company.id,req.user.id,'submit');
    return {quote:detail(quote.id,req.company.id)};
  })));
  const review=(action,status)=>route(req=>atomic(()=>{
    const quote=find(req,positive(req.params.id,'id'));
    if(quote.status!=='submitted')throw fail('Only a submitted quote can be reviewed',409);
    canReview(req,quote);
    if(action==='approve')notExpired(quote);
    const reason=text(req.body?.reviewReason??'','reviewReason',500,action==='reject');
    db.prepare('UPDATE quotes SET status=?,reviewed_by=?,review_reason=?,reviewed_at=CURRENT_TIMESTAMP WHERE id=?').run(status,req.user.id,reason,quote.id);
    event(quote.id,req.company.id,req.user.id,action,reason);
    return {quote:detail(quote.id,req.company.id)};
  }));
  app.post('/api/quotes/:id/approve',review('approve','approved'));
  app.post('/api/quotes/:id/reject',review('reject','rejected'));
  app.post('/api/quotes/:id/convert',route(req=>atomic(()=>{
    const quote=find(req,positive(req.params.id,'id'));
    const existing=db.prepare('SELECT * FROM orders WHERE source_quote_id=? AND company_id=?').get(quote.id,req.company.id);
    if(existing)return {quote:detail(quote.id,req.company.id),order:orderDetail(existing.id),replayed:true};
    if(quote.status!=='approved')throw fail('Only an approved quote can be converted',409);
    notExpired(quote);
    const party=db.prepare('SELECT type FROM parties WHERE id=? AND company_id=?').get(quote.party_id,req.company.id);
    if(!party||!['customer','both'].includes(party.type))throw fail('Quote customer is no longer eligible for a sales order',409);
    const quoteLines=db.prepare('SELECT * FROM quote_lines WHERE quote_id=? ORDER BY id').all(quote.id);
    if(!quoteLines.length||quoteLines.some(line=>!db.prepare('SELECT 1 FROM items WHERE id=? AND company_id=? AND active=1').get(line.item_id,req.company.id)))throw fail('A quoted item is no longer active',409);
    const orderNumber=text(req.body?.orderNumber,'orderNumber',60),orderDate=day(req.body?.orderDate??today(),'orderDate'),notes=text(req.body?.notes??`Converted from quotation ${quote.number}`,'notes',1000,false);
    if(db.prepare('SELECT 1 FROM orders WHERE company_id=? AND number=?').get(req.company.id,orderNumber))throw fail('Order number already exists in selected company',409);
    const orderId=Number(db.prepare(`INSERT INTO orders(company_id,gstin_id,branch_id,party_id,party_name_snapshot,type,number,status,order_date,notes,created_by,source_quote_id)
      VALUES (?,?,?,?,?,'sale',?,'draft',?,?,?,?)`).run(req.company.id,quote.gstin_id,quote.branch_id,quote.party_id,quote.party_name_snapshot,orderNumber,orderDate,notes,req.user.id,quote.id).lastInsertRowid);
    const insert=db.prepare('INSERT INTO order_lines(order_id,item_id,item_name_snapshot,quantity,unit_price_cents,gst_rate_bps) VALUES (?,?,?,?,?,?)');
    for(const line of quoteLines)insert.run(orderId,line.item_id,line.item_name_snapshot,line.quantity,line.unit_price_cents,line.gst_rate_bps);
    db.prepare('INSERT INTO order_events(company_id,order_id,action,actor_id,details) VALUES (?,?,\'create\',?,?)').run(req.company.id,orderId,req.user.id,`Converted from quotation ${quote.number}`);
    db.prepare("UPDATE quotes SET status='converted',converted_at=CURRENT_TIMESTAMP WHERE id=?").run(quote.id);
    event(quote.id,req.company.id,req.user.id,'convert',`Draft sales order ${orderNumber}`);
    return {quote:detail(quote.id,req.company.id),order:orderDetail(orderId),replayed:false};
  })));
  function orderDetail(id) {
    const row=db.prepare('SELECT * FROM orders WHERE id=?').get(id);
    return {...camel(row),lines:db.prepare('SELECT * FROM order_lines WHERE order_id=? ORDER BY id').all(id).map(camel)};
  }
}

module.exports={registerQuotesRoutes};
