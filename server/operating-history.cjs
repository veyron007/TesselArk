// All records here are synthetic operating specimens. Stable document numbers
// make the seed safe to replay into an existing local demo database.
const NOTE = 'SYNTHETIC DEMO OPERATING HISTORY. Local workflow record; no bank confirmation, official tax filing, or authentic third-party evidence.';
const DAY_MS = 86_400_000;
// Keep fixture identities stable across calendar-month rollover.
const DEMO_AS_OF = new Date(Date.UTC(2026, 8, 24));

function monthDate(offset, day) {
  const now = DEMO_AS_OF;
  const first = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - offset, 1));
  const lastDay = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
  const usableDay = offset === 0 ? Math.min(day, now.getUTCDate()) : Math.min(day, lastDay);
  return new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth(), usableDay)).toISOString().slice(0,10);
}

const stamp = date => `${date} 10:00:00`;
const paidDate = date => {
  const candidate = new Date(Date.parse(`${date}T00:00:00Z`) + DAY_MS).toISOString().slice(0,10);
  const today = DEMO_AS_OF.toISOString().slice(0,10);
  return candidate > today ? today : candidate;
};
const key = date => date.slice(0,7).replace('-','');

function party(db, companyId, name, type, gstin, stateCode) {
  const existing = db.prepare('SELECT id FROM parties WHERE company_id=? AND name=?').get(companyId,name);
  if (existing) return existing.id;
  return Number(db.prepare('INSERT INTO parties(company_id,name,type,gstin,state_code,address) VALUES (?,?,?,?,?,?)')
    .run(companyId,name,type,gstin,stateCode,`${name} — synthetic demonstration account`).lastInsertRowid);
}

function item(db, sku, name, hsn, unit, rate, reorderLevel) {
  const existing = db.prepare('SELECT id FROM items WHERE company_id=1 AND sku=?').get(sku);
  if (existing) return existing.id;
  return Number(db.prepare('INSERT INTO items(company_id,sku,name,hsn,unit,gst_rate_bps,reorder_level,track_stock) VALUES (1,?,?,?,?,?,?,1)')
    .run(sku,name,hsn,unit,rate,reorderLevel).lastInsertRowid);
}

function invoice(db, spec) {
  const existing = db.prepare('SELECT id FROM invoices WHERE company_id=? AND number=?').get(spec.companyId,spec.number);
  if (existing) return { id:existing.id, created:false };
  const product = db.prepare('SELECT name,sku,gst_rate_bps FROM items WHERE id=? AND company_id=?').get(spec.itemId,spec.companyId);
  const counterparty = db.prepare('SELECT name,gstin FROM parties WHERE id=? AND company_id=?').get(spec.partyId,spec.companyId);
  if (!product || !counterparty) throw new Error(`Synthetic history source missing for ${spec.number}`);
  const subtotal = spec.quantity * spec.price;
  const tax = Math.round(subtotal * spec.rate / 10_000);
  const total = subtotal + tax;
  const result = db.prepare(`INSERT INTO invoices(company_id,branch_id,gstin_id,party_id,fulfillment_id,number,supplier_invoice_number,
    supplier_gstin_snapshot,party_name_snapshot,type,status,invoice_date,notes,subtotal_cents,tax_cents,total_cents,
    created_by,submitted_by,approved_by,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,'approved',?,?,?,?,?,?,?,?,?)`)
    .run(spec.companyId,spec.branchId,spec.gstinId,spec.partyId,spec.fulfillmentId || null,spec.number,
      spec.supplierNumber || '',counterparty.gstin,counterparty.name,spec.type,spec.date,NOTE,subtotal,tax,total,
      spec.actorId,spec.actorId,spec.approverId,stamp(spec.date));
  const id = Number(result.lastInsertRowid);
  db.prepare('INSERT INTO invoice_lines(invoice_id,item_id,quantity,unit_price_cents,gst_rate_bps,subtotal_cents,tax_cents,total_cents) VALUES (?,?,?,?,?,?,?,?)')
    .run(id,spec.itemId,spec.quantity,spec.price,spec.rate,subtotal,tax,total);
  if (spec.type === 'purchase') db.prepare('INSERT INTO purchase_evidence(invoice_id,company_id) VALUES (?,?)').run(id,spec.companyId);
  if (spec.trackStock && !spec.fulfillmentId) {
    db.prepare('INSERT INTO stock_movements(company_id,branch_id,item_id,quantity_delta,type,reason,client_reference,invoice_id,created_at) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(spec.companyId,spec.branchId,spec.itemId,spec.type === 'purchase' ? spec.quantity : -spec.quantity,
        spec.type,spec.number,`history:invoice:${spec.number}`,id,stamp(spec.date));
  }
  return { id, created:true, total, tax, subtotal };
}

function payment(db, spec, invoiceId, total) {
  const amount = Math.floor(total * spec.share / 100);
  if (!amount) return;
  const reference = `HIST-${spec.type === 'sale' ? 'RCPT' : 'PAY'}-${spec.number}`;
  db.prepare('INSERT OR IGNORE INTO invoice_payments(company_id,invoice_id,amount_cents,method,reference,payment_date,recorded_by,created_at) VALUES (?,?,?,?,?,?,?,?)')
    .run(spec.companyId,invoiceId,amount,spec.method || 'bank',reference,paidDate(spec.date),spec.actorId,stamp(paidDate(spec.date)));
}

function syntheticPurchaseReview(db, spec, invoiceId, subtotal, tax) {
  const events = db.prepare('SELECT 1 FROM purchase_evidence_events WHERE invoice_id=? LIMIT 1').get(invoiceId);
  const evidence = db.prepare('SELECT match_status,eligibility_status,fixture_id FROM purchase_evidence WHERE invoice_id=?').get(invoiceId);
  if (events || !evidence || evidence.match_status !== 'unmatched' || evidence.eligibility_status !== 'pending' || evidence.fixture_id) return;
  const counterparty = db.prepare('SELECT gstin FROM parties WHERE id=?').get(spec.partyId);
  const period = spec.date.slice(0,7);
  db.prepare(`INSERT OR IGNORE INTO purchase_fixtures(company_id,gstin_id,supplier_gstin,invoice_number,invoice_date,
    taxable_cents,tax_cents,source_period,source_name,imported_at) VALUES (?,?,?,?,?,?,?,?,?,?)`)
    .run(spec.companyId,spec.gstinId,counterparty.gstin,spec.supplierNumber,spec.date,subtotal,tax,period,
      'SYNTHETIC local statement specimen; no GST portal connection',stamp(paidDate(spec.date)));
  const fixture = db.prepare('SELECT id,taxable_cents,tax_cents FROM purchase_fixtures WHERE company_id=? AND gstin_id=? AND supplier_gstin=? AND invoice_number=?')
    .get(spec.companyId,spec.gstinId,counterparty.gstin,spec.supplierNumber);
  if (!fixture || fixture.taxable_cents !== subtotal || fixture.tax_cents !== tax) return;
  db.prepare(`UPDATE purchase_evidence SET fixture_id=?,match_status='matched',eligibility_status='eligible',claim_period=?,
    review_reason='SYNTHETIC local eligibility review only; no official GST claim',matched_by=?,reviewed_by=?,
    matched_at=?,reviewed_at=? WHERE invoice_id=?`)
    .run(fixture.id,period,spec.approverId,spec.approverId,stamp(paidDate(spec.date)),stamp(paidDate(spec.date)),invoiceId);
  for (const [action,details] of [['match','SYNTHETIC local statement match'],['eligibility','SYNTHETIC local eligible review; no official filing']]) {
    db.prepare('INSERT INTO purchase_evidence_events(invoice_id,action,details,actor_id,created_at) VALUES (?,?,?,?,?)')
      .run(invoiceId,action,details,spec.approverId,stamp(paidDate(spec.date)));
  }
}

function linkedOrder(db, spec) {
  const orderNumber = `HIST-${spec.type === 'sale' ? 'SO' : 'PO'}-${spec.branchId}-${key(spec.date)}`;
  const fulfillmentNumber = `HIST-${spec.type === 'sale' ? 'DSP' : 'GRN'}-${spec.branchId}-${key(spec.date)}`;
  const existing = db.prepare('SELECT id FROM order_fulfillments WHERE company_id=? AND number=?').get(spec.companyId,fulfillmentNumber);
  if (existing) return { fulfillmentId:existing.id, created:false };
  const counterparty = db.prepare('SELECT name FROM parties WHERE id=? AND company_id=?').get(spec.partyId,spec.companyId);
  const product = db.prepare('SELECT name FROM items WHERE id=? AND company_id=?').get(spec.itemId,spec.companyId);
  if (!counterparty || !product) throw new Error(`Synthetic order source missing for ${orderNumber}`);
  const orderId = Number(db.prepare(`INSERT INTO orders(company_id,gstin_id,branch_id,party_id,party_name_snapshot,type,number,status,
    order_date,notes,created_by,confirmed_by,created_at,confirmed_at)
    VALUES (?,?,?,?,?,?,?,'confirmed',?,?,?,?,?,?)`)
    .run(spec.companyId,spec.gstinId,spec.branchId,spec.partyId,counterparty.name,spec.type,orderNumber,
      spec.date,NOTE,spec.actorId,spec.approverId,stamp(spec.date),stamp(spec.date)).lastInsertRowid);
  const orderLineId = Number(db.prepare('INSERT INTO order_lines(order_id,item_id,item_name_snapshot,quantity,unit_price_cents,gst_rate_bps) VALUES (?,?,?,?,?,?)')
    .run(orderId,spec.itemId,product.name,spec.quantity+2,spec.price,spec.rate).lastInsertRowid);
  const fulfillmentId = Number(db.prepare(`INSERT INTO order_fulfillments(order_id,company_id,number,kind,status,event_date,notes,created_by,
    confirmed_by,created_at,confirmed_at) VALUES (?,?,?,?,'confirmed',?,?,?,?,?,?)`)
    .run(orderId,spec.companyId,fulfillmentNumber,spec.type === 'sale' ? 'dispatch' : 'receipt',spec.date,
      NOTE,spec.actorId,spec.approverId,stamp(spec.date),stamp(spec.date)).lastInsertRowid);
  const fulfillmentLineId = Number(db.prepare('INSERT INTO order_fulfillment_lines(fulfillment_id,order_line_id,quantity) VALUES (?,?,?)')
    .run(fulfillmentId,orderLineId,spec.quantity).lastInsertRowid);
  const movementId = Number(db.prepare('INSERT INTO stock_movements(company_id,branch_id,item_id,quantity_delta,type,reason,client_reference,created_at) VALUES (?,?,?,?,?,?,?,?)')
    .run(spec.companyId,spec.branchId,spec.itemId,spec.type === 'sale' ? -spec.quantity : spec.quantity,
      spec.type === 'sale' ? 'sales_dispatch' : 'purchase_receipt',fulfillmentNumber,
      `order-fulfillment:${fulfillmentId}:line:${fulfillmentLineId}`,stamp(spec.date)).lastInsertRowid);
  db.prepare('UPDATE order_fulfillment_lines SET stock_movement_id=? WHERE id=?').run(movementId,fulfillmentLineId);
  for (const [action,fulfillment] of [['create',null],['confirm',null],['create_fulfillment',fulfillmentId],['confirm_fulfillment',fulfillmentId]]) {
    db.prepare('INSERT INTO order_events(company_id,order_id,fulfillment_id,action,actor_id,details,created_at) VALUES (?,?,?,?,?,?,?)')
      .run(spec.companyId,orderId,fulfillment,action,action.includes('confirm') ? spec.approverId : spec.actorId,NOTE,stamp(spec.date));
  }
  return { fulfillmentId, created:true };
}

function draftReturn(db, spec, invoiceId) {
  const number = `HIST-CRN-${spec.branchId}-${key(spec.date)}`;
  if (db.prepare('SELECT id FROM returns WHERE company_id=? AND number=?').get(spec.companyId,number)) return false;
  const source = db.prepare('SELECT id,quantity,unit_price_cents,gst_rate_bps,item_id FROM invoice_lines WHERE invoice_id=? ORDER BY id LIMIT 1').get(invoiceId);
  if (!source || source.quantity < 2) return false;
  const subtotal = source.unit_price_cents;
  const tax = Math.round(subtotal * source.gst_rate_bps / 10_000);
  const id = Number(db.prepare(`INSERT INTO returns(company_id,invoice_id,number,kind,status,reason,subtotal_cents,
    tax_proposal_cents,total_proposal_cents,created_by,created_at) VALUES (?,?,?,'sales_return','draft',?,?,?,?,?,?)`)
    .run(spec.companyId,invoiceId,number,`${NOTE} Customer-reported damaged outer pack; pending inspection.`,subtotal,tax,subtotal+tax,
      spec.actorId,stamp(spec.date)).lastInsertRowid);
  db.prepare('INSERT INTO return_lines(return_id,invoice_line_id,item_id,quantity,subtotal_cents,tax_proposal_cents) VALUES (?,?,?,1,?,?)')
    .run(id,source.id,source.item_id,subtotal,tax);
  return true;
}

function seedOperatingHistory(db) {
  if (!db.prepare('SELECT id FROM companies WHERE id=3').get()) return { invoices:0,orders:0,returns:0 };
  const summary = { invoices:0,orders:0,returns:0 };
  db.exec('BEGIN IMMEDIATE');
  try {
    const products = [
      item(db,'HIST-MED-101','Nitrile Examination Gloves (Demo)','4015','box',1200,20),
      item(db,'HIST-MED-102','Sterile Gauze Packs (Demo)','3005','pack',1200,24),
      item(db,'HIST-MED-103','Digital Pulse Oximeter (Demo)','9018','unit',1200,12),
      item(db,'HIST-MED-104','Surface Disinfectant 500 ml (Demo)','3808','bottle',1800,18),
      item(db,'HIST-MED-105','Blood Collection Tubes (Demo)','9018','box',1200,16),
    ];
    const branches = [
      { branchId:1,gstinId:1,state:'27',short:'MUM',customers:[
        party(db,1,'Seaside Diagnostic Centre (Demo)','customer','27DEMOD0000C1Z1','27'),
        party(db,1,'West Ward Community Clinic (Demo)','customer','27DEMOW0000C1Z2','27')],
        supplier:party(db,1,'Western Meditech Distribution (Demo)','supplier','27DEMOM0000S1Z1','27') },
      { branchId:2,gstinId:1,state:'27',short:'PUN',customers:[
        party(db,1,'Pune Health Network (Demo)','customer','27DEMOP0000C1Z3','27'),
        party(db,1,'Cedar Pathology Lab (Demo)','customer','27DEMOC0000C1Z4','27')],
        supplier:party(db,1,'Pune Clinical Wholesale (Demo)','supplier','27DEMOP0000S1Z2','27') },
      { branchId:3,gstinId:2,state:'29',short:'BLR',customers:[
        party(db,1,'Bengaluru Neighborhood Hospital (Demo)','customer','29DEMOB0000C1Z1','29'),
        party(db,1,'South Ridge Diagnostics (Demo)','customer','29DEMOS0000C1Z2','29')],
        supplier:party(db,1,'Deccan Healthcare Supply (Demo)','supplier','29DEMOD0000S1Z1','29') },
    ];
    // The prior Mumbai GST period is already internally approved in baseline
    // fixtures. Avoid inserting new sources into that reviewed period.
    const offsets = [7,6,5,4,3,2,0];
    for (const offset of offsets) {
      const purchaseDate = monthDate(offset,3);
      const firstSaleDate = monthDate(offset,10);
      const secondSaleDate = monthDate(offset,18);
      const periodKey = key(purchaseDate);
      for (const gstinId of [1,2]) db.prepare("INSERT OR IGNORE INTO gst_periods(company_id,gstin_id,period,status) VALUES (1,?,?,'open')")
        .run(gstinId,purchaseDate.slice(0,7));
      for (const [branchIndex,branch] of branches.entries()) {
        if (db.prepare('SELECT status FROM gst_periods WHERE company_id=1 AND gstin_id=? AND period=?')
          .get(branch.gstinId,purchaseDate.slice(0,7))?.status !== 'open') continue;
        const itemId = products[(branchIndex + offset) % products.length];
        const rate = db.prepare('SELECT gst_rate_bps FROM items WHERE id=?').get(itemId).gst_rate_bps;
        const basePrice = [4800,2600,145000,7400,3600][(branchIndex + offset) % products.length];
        const supplierPrice = Math.floor(basePrice * 0.68);
        const bought = 48 + ((branchIndex + offset) % 4) * 8;
        const purchase = {companyId:1,branchId:branch.branchId,gstinId:branch.gstinId,partyId:branch.supplier,itemId,
          type:'purchase',number:`HIST-PUR-${branch.short}-${periodKey}`,supplierNumber:`HIST-SUP-${branch.short}-${periodKey}`,
          date:purchaseDate,quantity:bought,price:supplierPrice,rate,trackStock:true,actorId:1,approverId:2,share:65};
        const purchased = invoice(db,purchase);
        if (purchased.created) {
          summary.invoices++;
          payment(db,purchase,purchased.id,purchased.total);
        }
        if (offset % 2 === 0 && offset !== 0) syntheticPurchaseReview(db,purchase,purchased.id,
          purchase.quantity*purchase.price,Math.round(purchase.quantity*purchase.price*purchase.rate/10_000));
        const sale = {companyId:1,branchId:branch.branchId,gstinId:branch.gstinId,partyId:branch.customers[0],itemId,
          type:'sale',number:`HIST-SAL-${branch.short}-${periodKey}-01`,date:firstSaleDate,
          quantity:5 + ((branchIndex + offset) % 4),price:basePrice,rate,trackStock:true,actorId:1,approverId:2,share:70};
        const order = linkedOrder(db,sale);
        if (order.created) summary.orders++;
        const billed = invoice(db,{...sale,fulfillmentId:order.fulfillmentId});
        if (billed.created) {
          summary.invoices++;
          payment(db,sale,billed.id,billed.total);
        }
        const second = {...sale,partyId:branch.customers[1],number:`HIST-SAL-${branch.short}-${periodKey}-02`,
          date:secondSaleDate,quantity:3 + ((branchIndex * 2 + offset) % 4),price:basePrice+300,
          share:offset % 3 === 0 ? 0 : 100,method:'upi'};
        const secondBilled = invoice(db,second);
        if (secondBilled.created) {
          summary.invoices++;
          payment(db,second,secondBilled.id,secondBilled.total);
        }
        if (offset % 3 === 0 && draftReturn(db,second,secondBilled.id)) summary.returns++;
      }
    }
    const serviceCustomer = party(db,2,'MetroCare Instruments (Demo)','customer','27DEMOM0000B1Z3','27');
    const retailSupplier = party(db,3,'Nashik Staples Wholesale (Demo)','supplier','27DEMON0000S1Z2','27');
    for (const offset of [6,5,4,3,2,1,0]) {
      const periodKey = key(monthDate(offset,4));
      for (const [companyId,gstinId] of [[2,3],[3,4]]) {
        db.prepare("INSERT OR IGNORE INTO gst_periods(company_id,gstin_id,period,status) VALUES (?,?,?,'open')")
          .run(companyId,gstinId,monthDate(offset,4).slice(0,7));
      }
      const service = {companyId:2,branchId:4,gstinId:3,partyId:serviceCustomer,itemId:4,type:'sale',
        number:`HIST-SVC-MUM-${periodKey}`,date:monthDate(offset,12),quantity:1 + offset % 3,
        price:85000,rate:1800,trackStock:false,actorId:4,approverId:5,share:offset % 3 === 0 ? 0 : 75};
      if (db.prepare('SELECT status FROM gst_periods WHERE company_id=2 AND gstin_id=3 AND period=?')
        .get(service.date.slice(0,7))?.status === 'open') {
        const serviceInvoice = invoice(db,service);
        if (serviceInvoice.created) { summary.invoices++; payment(db,service,serviceInvoice.id,serviceInvoice.total); }
      }
      const retailPurchase = {companyId:3,branchId:5,gstinId:4,partyId:retailSupplier,itemId:5,type:'purchase',
        number:`HIST-PUR-NSK-${periodKey}`,supplierNumber:`HIST-NSK-SUP-${periodKey}`,
        date:monthDate(offset,4),quantity:35,price:5400,rate:0,trackStock:true,actorId:6,approverId:7,share:60};
      if (db.prepare('SELECT status FROM gst_periods WHERE company_id=3 AND gstin_id=4 AND period=?')
        .get(retailPurchase.date.slice(0,7))?.status !== 'open') continue;
      const bought = invoice(db,retailPurchase);
      if (bought.created) { summary.invoices++; payment(db,retailPurchase,bought.id,bought.total); }
      const retailSale = {companyId:3,branchId:5,gstinId:4,partyId:6,itemId:5,type:'sale',
        number:`HIST-SAL-NSK-${periodKey}`,date:monthDate(offset,15),quantity:9 + offset % 3,
        price:9000,rate:0,trackStock:true,actorId:6,approverId:7,share:100,method:'upi'};
      const sold = invoice(db,retailSale);
      if (sold.created) { summary.invoices++; payment(db,retailSale,sold.id,sold.total); }
    }
    // Earlier local runs used a presentation-only movement label. Normalize
    // those rows to the same type/reference contract as confirmed API orders.
    // The update never touches quantities or posts a second movement.
    for (const row of db.prepare(`SELECT fl.id AS line_id,fl.stock_movement_id,f.id AS fulfillment_id,
      f.number,o.type FROM order_fulfillment_lines fl JOIN order_fulfillments f ON f.id=fl.fulfillment_id
      JOIN orders o ON o.id=f.order_id WHERE f.number LIKE 'HIST-%' AND fl.stock_movement_id IS NOT NULL`).all()) {
      const type = row.type === 'sale' ? 'sales_dispatch' : 'purchase_receipt';
      const reference = `order-fulfillment:${row.fulfillment_id}:line:${row.line_id}`;
      db.prepare('UPDATE stock_movements SET type=?,reason=?,client_reference=? WHERE id=? AND (type<>? OR reason<>? OR client_reference<>?)')
        .run(type,row.number,reference,row.stock_movement_id,type,row.number,reference);
    }
    db.exec('COMMIT');
    return summary;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

module.exports = { seedOperatingHistory };
