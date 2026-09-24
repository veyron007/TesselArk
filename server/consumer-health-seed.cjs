// Category inspiration: https://www.haleon.com/our-brands
// Every company, counterparty, item, price, GST rate, and transaction below is
// fictional demonstration data. It implies no Haleon trading relationship.
const { installCatalogueSchema } = require('./catalogue-db.cjs');
const NOTE = 'SYNTHETIC DEMO consumer health transaction. Fictional parties and illustrative prices/tax only; no authentic trade, GST evidence, or official filing.';
const MONTHS = ['2026-04', '2026-05', '2026-06', '2026-09'];
const CATEGORIES = [
  ['Oral health', ['Daily Oral Care Paste 100 g', 'Gentle Gum Care Rinse 250 ml', 'Denture Cleansing Tablets 30s']],
  ['Vitamins, minerals and supplements', ['Everyday Multivitamin Tablets 30s', 'Calcium D3 Tablets 30s', 'Vitamin C Sachets 20s']],
  ['Pain relief', ['Cooling Muscle Gel 50 g', 'Comfort Heat Patches 5s', 'Headache Comfort Balm 20 g']],
  ['Respiratory health', ['Saline Nasal Spray 20 ml', 'Steam Inhalation Drops 15 ml', 'Throat Soothing Lozenges 20s']],
  ['Digestive health', ['Antacid Chewable Tablets 20s', 'Fibre Supplement Sachets 10s', 'Digestive Comfort Granules 100 g']],
  ['Therapeutic skin health', ['Barrier Care Cream 50 g', 'Moisture Repair Ointment 30 g', 'Soothing Skin Lotion 100 ml']],
];
const BRANCHES = [
  { id: 1, gstinId: 1, code: 'MUM', state: '27', supplier: 'Harbour Wellness Wholesale (Demo)', customer: 'Cityline Pharmacy Network (Demo)' },
  { id: 2, gstinId: 1, code: 'PUN', state: '27', supplier: 'Pune Everyday Health Supply (Demo)', customer: 'Greenleaf Chemist Collective (Demo)' },
  { id: 3, gstinId: 2, code: 'BLR', state: '29', supplier: 'Southway Consumer Care Distribution (Demo)', customer: 'Bengaluru Neighbourhood Pharmacy (Demo)' },
];
const stamp = (day, hour = '10') => `${day} ${hour}:00:00`;
const monthKey = month => month.replace('-', '');

function party(db, name, type, city, state) {
  const existing = db.prepare('SELECT id FROM parties WHERE company_id=1 AND name=?').get(name);
  if (existing) return existing.id;
  return Number(db.prepare('INSERT INTO parties(company_id,name,type,gstin,state_code,address) VALUES (1,?,?,\'\',?,?)')
    .run(name, type, state, `${city}; SYNTHETIC DEMO fictional counterparty`).lastInsertRowid);
}

function catalogue(db) {
  const products = [];
  for (const [categoryIndex, [name, names]] of CATEGORIES.entries()) {
    let category = db.prepare('SELECT id FROM catalogue_categories WHERE company_id=1 AND name=?').get(name);
    if (!category) category = { id: Number(db.prepare('INSERT INTO catalogue_categories(company_id,name,source_reference,created_by) VALUES (1,?,?,3)')
      .run(name, 'Public category inspiration: haleon.com/our-brands; fictional demo SKU').lastInsertRowid) };
    for (const [itemIndex, itemName] of names.entries()) {
      const sku = `CHD-${String(categoryIndex + 1).padStart(2, '0')}-${String(itemIndex + 1).padStart(2, '0')}`;
      let item = db.prepare('SELECT id FROM items WHERE company_id=1 AND sku=?').get(sku);
      if (!item) item = { id: Number(db.prepare(`INSERT INTO items(company_id,sku,name,hsn,unit,gst_rate_bps,reorder_level,track_stock)
        VALUES (1,?,?,\'\',\'pack\',1200,12,1)`).run(sku, `${itemName} (Synthetic Demo)`).lastInsertRowid) };
      if (!db.prepare('SELECT 1 FROM catalogue_item_details WHERE item_id=?').get(item.id)) {
        db.prepare(`INSERT INTO catalogue_item_details(item_id,company_id,category_id,product_kind,salt,launched_on,source_reference,updated_by)
          VALUES (?,1,?,'general','','2026-04-01','Public category inspiration: haleon.com/our-brands; fictional demo SKU; illustrative tax/HSN only',3)`).run(item.id, category.id);
        db.prepare('INSERT INTO catalogue_item_tags(item_id,company_id,tag) VALUES (?,1,?)').run(item.id, 'consumer health demo');
        db.prepare('INSERT INTO catalogue_item_events(company_id,item_id,action,source_reference,change_reason,snapshot_json,actor_id) VALUES (1,?,\'metadata_updated\',?,?,?,3)')
          .run(item.id, 'SYNTHETIC DEMO catalogue', 'Initial category curation', JSON.stringify({ category: name, syntheticDemo: true }));
      }
      products.push({ id: item.id, sku, name: `${itemName} (Synthetic Demo)`, price: 9500 + categoryIndex * 1700 + itemIndex * 800 });
    }
  }
  return products;
}

function insertInvoice(db, { branch, partyId, type, number, date, lines, fulfillment = null, supplierNumber = '' }) {
  if (db.prepare('SELECT id FROM invoices WHERE company_id=1 AND number=?').get(number)) return null;
  const counterparty = db.prepare('SELECT name,gstin FROM parties WHERE id=? AND company_id=1').get(partyId);
  const computed = lines.map(line => {
    const subtotal = line.quantity * line.price;
    const tax = Math.round(subtotal * 1200 / 10000);
    return { ...line, subtotal, tax, total: subtotal + tax };
  });
  const subtotal = computed.reduce((sum, line) => sum + line.subtotal, 0);
  const tax = computed.reduce((sum, line) => sum + line.tax, 0);
  const id = Number(db.prepare(`INSERT INTO invoices(company_id,branch_id,gstin_id,party_id,fulfillment_id,number,supplier_invoice_number,
    supplier_gstin_snapshot,party_name_snapshot,type,status,invoice_date,notes,subtotal_cents,tax_cents,total_cents,
    created_by,submitted_by,approved_by,created_at) VALUES (1,?,?,?,?,?,?,?,?,?,'approved',?,?,?,?,?,1,1,2,?)`)
    .run(branch.id, branch.gstinId, partyId, fulfillment?.id || null, number, supplierNumber, counterparty.gstin,
      counterparty.name, type, date, NOTE, subtotal, tax, subtotal + tax, stamp(date)).lastInsertRowid);
  for (const line of computed) {
    db.prepare(`INSERT INTO invoice_lines(invoice_id,item_id,fulfillment_line_id,quantity,unit_price_cents,gst_rate_bps,subtotal_cents,tax_cents,total_cents)
      VALUES (?,?,?,?,?,1200,?,?,?)`).run(id, line.id, fulfillment?.lines.get(line.id) || null, line.quantity, line.price,
        line.subtotal, line.tax, line.total);
    if (!fulfillment) db.prepare(`INSERT INTO stock_movements(company_id,branch_id,item_id,quantity_delta,type,reason,client_reference,invoice_id,created_at)
      VALUES (1,?,?,?,?,?,?,?,?)`).run(branch.id, line.id, type === 'purchase' ? line.quantity : -line.quantity,
        type, number, `consumer-health:invoice:${number}:item:${line.id}`, id, stamp(date));
  }
  if (type === 'purchase') db.prepare('INSERT INTO purchase_evidence(invoice_id,company_id) VALUES (?,1)').run(id);
  return { id, total: subtotal + tax };
}

function linkedSaleOrder(db, { branch, partyId, number, date, lines }) {
  const orderNumber = number.replace('SAL', 'SO');
  const fulfillmentNumber = number.replace('SAL', 'DSP');
  const partyName = db.prepare('SELECT name FROM parties WHERE id=?').get(partyId).name;
  const orderId = Number(db.prepare(`INSERT INTO orders(company_id,gstin_id,branch_id,party_id,party_name_snapshot,type,number,status,
    order_date,notes,created_by,confirmed_by,created_at,confirmed_at)
    VALUES (1,?,?,?,?,'sale',?,'confirmed',?,?,1,2,?,?)`)
    .run(branch.gstinId, branch.id, partyId, partyName, orderNumber, date, NOTE, stamp(date), stamp(date)).lastInsertRowid);
  const fulfillmentId = Number(db.prepare(`INSERT INTO order_fulfillments(order_id,company_id,number,kind,status,event_date,notes,
    created_by,confirmed_by,created_at,confirmed_at) VALUES (?,1,?,'dispatch','confirmed',?,?,1,2,?,?)`)
    .run(orderId, fulfillmentNumber, date, NOTE, stamp(date), stamp(date)).lastInsertRowid);
  const fulfillmentLines = new Map();
  for (const line of lines) {
    const orderLineId = Number(db.prepare(`INSERT INTO order_lines(order_id,item_id,item_name_snapshot,quantity,unit_price_cents,gst_rate_bps)
      VALUES (?,?,?,?,?,1200)`).run(orderId, line.id, line.name, line.quantity, line.price).lastInsertRowid);
    const fulfillmentLineId = Number(db.prepare('INSERT INTO order_fulfillment_lines(fulfillment_id,order_line_id,quantity) VALUES (?,?,?)')
      .run(fulfillmentId, orderLineId, line.quantity).lastInsertRowid);
    const movementId = Number(db.prepare(`INSERT INTO stock_movements(company_id,branch_id,item_id,quantity_delta,type,reason,client_reference,created_at)
      VALUES (1,?,?,?,'sales_dispatch',?,?,?)`)
      .run(branch.id, line.id, -line.quantity, fulfillmentNumber,
        `order-fulfillment:${fulfillmentId}:line:${fulfillmentLineId}`, stamp(date)).lastInsertRowid);
    db.prepare('UPDATE order_fulfillment_lines SET stock_movement_id=? WHERE id=?').run(movementId, fulfillmentLineId);
    fulfillmentLines.set(line.id, fulfillmentLineId);
  }
  for (const [action, linkedId] of [['create', null], ['confirm', null], ['create_fulfillment', fulfillmentId], ['confirm_fulfillment', fulfillmentId]]) {
    db.prepare('INSERT INTO order_events(company_id,order_id,fulfillment_id,action,actor_id,details,created_at) VALUES (1,?,?,?,?,?,?)')
      .run(orderId, linkedId, action, action.includes('confirm') ? 2 : 1, NOTE, stamp(date));
  }
  return { id: fulfillmentId, lines: fulfillmentLines };
}

function payment(db, invoice, number, date, type, fraction) {
  const amount = Math.floor(invoice.total * fraction / 100);
  const reference = `CHD-${type === 'sale' ? 'RCPT' : 'PAY'}-${number}`;
  db.prepare(`INSERT OR IGNORE INTO invoice_payments(company_id,invoice_id,amount_cents,method,reference,payment_date,recorded_by,created_at)
    VALUES (1,?,?,'bank',?,?,1,?)`).run(invoice.id, amount, reference, date, stamp(date, '14'));
}

function draftReturn(db, invoiceId, number, date) {
  const source = db.prepare('SELECT * FROM invoice_lines WHERE invoice_id=? ORDER BY id LIMIT 1').get(invoiceId);
  const subtotal = source.unit_price_cents;
  const tax = Math.round(subtotal * source.gst_rate_bps / 10000);
  const returnId = Number(db.prepare(`INSERT INTO returns(company_id,invoice_id,number,kind,status,reason,subtotal_cents,tax_proposal_cents,
    total_proposal_cents,created_by,created_at) VALUES (1,?,?,'sales_return','draft',?,?,?,?,1,?)`)
    .run(invoiceId, number, `${NOTE} Customer reported damaged outer pack; pending review.`, subtotal, tax, subtotal + tax,
      stamp(date, '15')).lastInsertRowid);
  db.prepare('INSERT INTO return_lines(return_id,invoice_line_id,item_id,quantity,subtotal_cents,tax_proposal_cents) VALUES (?,?,?,1,?,?)')
    .run(returnId, source.id, source.item_id, subtotal, tax);
}

function seedConsumerHealthDemo(db) {
  const summary = { invoices: 0, orders: 0, returns: 0 };
  if (!db.prepare('SELECT 1 FROM companies WHERE id=1').get()) return summary;
  installCatalogueSchema(db);
  db.exec('BEGIN IMMEDIATE');
  try {
    const products = catalogue(db);
    for (const [monthIndex, month] of MONTHS.entries()) {
      for (const [branchIndex, branch] of BRANCHES.entries()) {
        if (!db.prepare('SELECT 1 FROM branches WHERE id=? AND company_id=1 AND gstin_id=?').get(branch.id, branch.gstinId)) continue;
        db.prepare("INSERT OR IGNORE INTO gst_periods(company_id,gstin_id,period,status) VALUES (1,?,?,'open')").run(branch.gstinId, month);
        if (db.prepare('SELECT status FROM gst_periods WHERE gstin_id=? AND period=?').get(branch.gstinId, month).status !== 'open') continue;
        const city = branch.code === 'MUM' ? 'Mumbai' : branch.code === 'PUN' ? 'Pune' : 'Bengaluru';
        const supplierId = party(db, branch.supplier, 'supplier', city, branch.state);
        const customerId = party(db, branch.customer, 'customer', city, branch.state);
        const index = (monthIndex * 4 + branchIndex * 2) % products.length;
        const selected = [products[index], products[(index + 1) % products.length]];
        const key = `${branch.code}-${monthKey(month)}`;
        const purchaseNumber = `CHD-PUR-${key}`;
        const saleNumber = `CHD-SAL-${key}`;
        if (db.prepare('SELECT 1 FROM invoices WHERE company_id=1 AND number=?').get(purchaseNumber)) continue;
        const purchaseDate = `${month}-05`;
        const purchase = insertInvoice(db, { branch, partyId: supplierId, type: 'purchase', number: purchaseNumber,
          supplierNumber: `CHD-FICTIONAL-SUP-${key}`, date: purchaseDate,
          lines: selected.map((item, i) => ({ ...item, quantity: i === 0 ? 48 : 36, price: Math.floor(item.price * 68 / 100) })) });
        if (!purchase) continue;
        summary.invoices++;
        payment(db, purchase, purchaseNumber, `${month}-11`, 'purchase', 70);
        const saleDate = `${month}-16`;
        const saleLines = selected.map((item, i) => ({ ...item, quantity: i === 0 ? 18 : 14 }));
        const fulfillment = linkedSaleOrder(db, { branch, partyId: customerId, number: saleNumber, date: saleDate, lines: saleLines });
        summary.orders++;
        const sale = insertInvoice(db, { branch, partyId: customerId, type: 'sale', number: saleNumber, date: saleDate,
          lines: saleLines, fulfillment });
        summary.invoices++;
        payment(db, sale, saleNumber, `${month}-22`, 'sale', monthIndex % 2 ? 100 : 65);
        if (month === '2026-09') {
          draftReturn(db, sale.id, `CHD-CRN-${key}`, `${month}-23`);
          summary.returns++;
        }
      }
    }
    db.exec('COMMIT');
    return summary;
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}

module.exports = { seedConsumerHealthDemo };
