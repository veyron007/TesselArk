function installQuotesSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS quotes (
      id INTEGER PRIMARY KEY,
      company_id INTEGER NOT NULL REFERENCES companies(id),
      gstin_id INTEGER NOT NULL REFERENCES gstins(id),
      branch_id INTEGER NOT NULL REFERENCES branches(id),
      party_id INTEGER NOT NULL REFERENCES parties(id),
      party_name_snapshot TEXT NOT NULL,
      party_gstin_snapshot TEXT NOT NULL DEFAULT '',
      number TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','submitted','approved','rejected','converted')),
      quote_date TEXT NOT NULL,
      expiry_date TEXT NOT NULL,
      notes TEXT NOT NULL DEFAULT '',
      subtotal_cents INTEGER NOT NULL CHECK(subtotal_cents>=0),
      tax_cents INTEGER NOT NULL CHECK(tax_cents>=0),
      total_cents INTEGER NOT NULL CHECK(total_cents>=0),
      review_reason TEXT NOT NULL DEFAULT '',
      created_by INTEGER NOT NULL REFERENCES users(id),
      submitted_by INTEGER REFERENCES users(id),
      reviewed_by INTEGER REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      submitted_at TEXT,
      reviewed_at TEXT,
      converted_at TEXT,
      UNIQUE(company_id,number)
    );
    CREATE TABLE IF NOT EXISTS quote_lines (
      id INTEGER PRIMARY KEY,
      quote_id INTEGER NOT NULL REFERENCES quotes(id),
      item_id INTEGER NOT NULL REFERENCES items(id),
      item_sku_snapshot TEXT NOT NULL,
      item_name_snapshot TEXT NOT NULL,
      item_hsn_snapshot TEXT NOT NULL DEFAULT '',
      item_unit_snapshot TEXT NOT NULL,
      quantity INTEGER NOT NULL CHECK(quantity>0),
      unit_price_cents INTEGER NOT NULL CHECK(unit_price_cents>=0),
      gst_rate_bps INTEGER NOT NULL CHECK(gst_rate_bps BETWEEN 0 AND 10000),
      subtotal_cents INTEGER NOT NULL CHECK(subtotal_cents>=0),
      tax_cents INTEGER NOT NULL CHECK(tax_cents>=0),
      total_cents INTEGER NOT NULL CHECK(total_cents>=0)
    );
    CREATE TABLE IF NOT EXISTS quote_events (
      id INTEGER PRIMARY KEY,
      company_id INTEGER NOT NULL REFERENCES companies(id),
      quote_id INTEGER NOT NULL REFERENCES quotes(id),
      action TEXT NOT NULL,
      actor_id INTEGER NOT NULL REFERENCES users(id),
      details TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_quotes_scope ON quotes(company_id,branch_id,gstin_id,id);
    CREATE INDEX IF NOT EXISTS idx_quote_events ON quote_events(quote_id,id);
  `);
  if (!db.prepare('PRAGMA table_info(orders)').all().some(row => row.name === 'source_quote_id')) {
    db.exec('ALTER TABLE orders ADD COLUMN source_quote_id INTEGER REFERENCES quotes(id)');
  }
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS uq_order_source_quote ON orders(source_quote_id) WHERE source_quote_id IS NOT NULL');
}

function seedQuoteDemo(db) {
  const today=new Date().toISOString().slice(0,10);
  const nextMonth=new Date(Date.now()+35*86400000).toISOString().slice(0,10);
  const specimens=[
    {number:'DEMO-QUO-MUM-001',status:'draft',gstinId:1,branchId:1,partyId:1,itemId:1,quantity:6,price:8800,rate:1200,actor:1},
    {number:'DEMO-QUO-PUN-002',status:'submitted',gstinId:1,branchId:2,partyId:1,itemId:2,quantity:12,price:3200,rate:1200,actor:1},
    {number:'DEMO-QUO-BLR-003',status:'approved',gstinId:2,branchId:3,partyId:1,itemId:3,quantity:8,price:6700,rate:1200,actor:1},
    {number:'DEMO-QUO-MUM-004',status:'converted',gstinId:1,branchId:1,partyId:1,itemId:2,quantity:5,price:4300,rate:1200,actor:1},
    {number:'DEMO-QUO-BLR-005',status:'rejected',gstinId:2,branchId:3,partyId:1,itemId:1,quantity:20,price:10200,rate:1200,actor:1},
  ];
  db.exec('SAVEPOINT quote_seed');
  try {
    for (const spec of specimens) {
      if (db.prepare('SELECT 1 FROM quotes WHERE company_id=1 AND number=?').get(spec.number)) continue;
      const party=db.prepare('SELECT name,gstin FROM parties WHERE id=? AND company_id=1').get(spec.partyId);
      const item=db.prepare('SELECT sku,name,hsn,unit FROM items WHERE id=? AND company_id=1').get(spec.itemId);
      if (!party || !item) continue;
      const subtotal=spec.quantity*spec.price,tax=Math.round(subtotal*spec.rate/10000);
      const reviewReason=spec.status==='rejected'?'Customer requested revised delivery and price terms':'Synthetic internal quotation review';
      const id=Number(db.prepare(`INSERT INTO quotes(company_id,gstin_id,branch_id,party_id,party_name_snapshot,party_gstin_snapshot,number,status,quote_date,expiry_date,notes,subtotal_cents,tax_cents,total_cents,review_reason,created_by,submitted_by,reviewed_by,submitted_at,reviewed_at,converted_at)
        VALUES (1,?,?,?,?,?,?,?,?,?,'Synthetic quotation specimen; no stock or tax posting',?,?,?,?,1,?,?,?,?,?)`)
        .run(spec.gstinId,spec.branchId,spec.partyId,party.name,party.gstin,spec.number,spec.status,today,nextMonth,subtotal,tax,subtotal+tax,spec.status==='draft'||spec.status==='submitted'?'':reviewReason,spec.status==='draft'?null:1,['approved','rejected','converted'].includes(spec.status)?2:null,spec.status==='draft'?null:today,spec.status==='approved'||spec.status==='rejected'||spec.status==='converted'?today:null,spec.status==='converted'?today:null).lastInsertRowid);
      db.prepare('INSERT INTO quote_lines(quote_id,item_id,item_sku_snapshot,item_name_snapshot,item_hsn_snapshot,item_unit_snapshot,quantity,unit_price_cents,gst_rate_bps,subtotal_cents,tax_cents,total_cents) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
        .run(id,spec.itemId,item.sku,item.name,item.hsn,item.unit,spec.quantity,spec.price,spec.rate,subtotal,tax,subtotal+tax);
      const event=db.prepare('INSERT INTO quote_events(company_id,quote_id,action,actor_id,details) VALUES (1,?,?,?,?)');
      event.run(id,'create',1,'Synthetic demo quotation');
      if (spec.status!=='draft') event.run(id,'submit',1,'Synthetic demo submission');
      if (['approved','rejected','converted'].includes(spec.status)) event.run(id,spec.status==='rejected'?'reject':'approve',2,reviewReason);
      if (spec.status==='converted') {
        const orderNumber='DEMO-SO-FROM-QUO-004';
        const orderId=Number(db.prepare(`INSERT INTO orders(company_id,gstin_id,branch_id,party_id,party_name_snapshot,type,number,status,order_date,notes,created_by,source_quote_id)
          VALUES (1,?,?,?,?, 'sale',?,'draft',?,'Synthetic draft from approved quotation',1,?)`)
          .run(spec.gstinId,spec.branchId,spec.partyId,party.name,orderNumber,today,id).lastInsertRowid);
        db.prepare('INSERT INTO order_lines(order_id,item_id,item_name_snapshot,quantity,unit_price_cents,gst_rate_bps) VALUES (?,?,?,?,?,?)')
          .run(orderId,spec.itemId,item.name,spec.quantity,spec.price,spec.rate);
        db.prepare('INSERT INTO order_events(company_id,order_id,action,actor_id,details) VALUES (1,?,\'create\',1,?)').run(orderId,`Converted from ${spec.number}`);
        event.run(id,'convert',1,`Draft sales order ${orderNumber}`);
      }
    }
    db.exec('RELEASE quote_seed');
  } catch (error) {
    db.exec('ROLLBACK TO quote_seed');
    db.exec('RELEASE quote_seed');
    throw error;
  }
}

module.exports={installQuotesSchema,seedQuoteDemo};
