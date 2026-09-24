const { createHash } = require('node:crypto');

// Presentation records use only the existing domain tables. The natural keys make
// this safe to run when a persistent demo database is reopened.
function seedExpandedDemo(db) {
  if (!db.prepare('SELECT 1 FROM companies WHERE id=3').get()) return;
  db.exec('BEGIN IMMEDIATE');
  try {
    const today = new Date().toISOString().slice(0, 10);
    const period = today.slice(0, 7);
    const party = (companyId, name, type, gstin, state) => {
      const existing = db.prepare('SELECT id FROM parties WHERE company_id=? AND name=?').get(companyId, name);
      if (existing) return existing.id;
      return Number(db.prepare('INSERT INTO parties(company_id,name,type,gstin,state_code) VALUES (?,?,?,?,?)')
        .run(companyId, name, type, gstin, state).lastInsertRowid);
    };
    const item = (companyId, sku, name, hsn, unit, rate, tracked) => {
      const existing = db.prepare('SELECT id FROM items WHERE company_id=? AND sku=?').get(companyId, sku);
      if (existing) return existing.id;
      return Number(db.prepare('INSERT INTO items(company_id,sku,name,hsn,unit,gst_rate_bps,track_stock) VALUES (?,?,?,?,?,?,?)')
        .run(companyId, sku, name, hsn, unit, rate, tracked).lastInsertRowid);
    };
    const addInvoice = spec => {
      const existing = db.prepare('SELECT id FROM invoices WHERE company_id=? AND number=?').get(spec.company, spec.number);
      if (existing) return existing.id;
      const { company, branch, gstin, counterparty, partyName, partyGstin, number, supplierNumber = '', type, status, date, notes, lines, creator, approver } = spec;
      const totals = lines.map(line => {
        const subtotal = line.quantity * line.price;
        const tax = Math.round(subtotal * line.rate / 10000);
        return { ...line, subtotal, tax, total: subtotal + tax };
      });
      const subtotal = totals.reduce((sum, line) => sum + line.subtotal, 0);
      const tax = totals.reduce((sum, line) => sum + line.tax, 0);
      const id = Number(db.prepare('INSERT INTO invoices(company_id,branch_id,gstin_id,party_id,number,supplier_invoice_number,supplier_gstin_snapshot,party_name_snapshot,type,status,invoice_date,notes,subtotal_cents,tax_cents,total_cents,created_by,submitted_by,approved_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
        .run(company,branch,gstin,counterparty,number,supplierNumber,partyGstin,partyName,type,status,date,notes,subtotal,tax,subtotal+tax,creator,status === 'draft' ? null : creator,status === 'approved' ? approver : null).lastInsertRowid);
      const insertLine = db.prepare('INSERT INTO invoice_lines(invoice_id,item_id,quantity,unit_price_cents,gst_rate_bps,subtotal_cents,tax_cents,total_cents) VALUES (?,?,?,?,?,?,?,?)');
      for (const line of totals) insertLine.run(id,line.item,line.quantity,line.price,line.rate,line.subtotal,line.tax,line.total);
      if (type === 'purchase' && status === 'approved') db.prepare('INSERT INTO purchase_evidence(invoice_id,company_id) VALUES (?,?)').run(id,company);
      return id;
    };

    const kaveri = party(1,'Kaveri Labs (Demo)','supplier','29DEMOS0000A1Z3','29');
    const service = item(1,'DEMO-SVC-031','Shared Equipment Support (Demo)','9987','service',1800,0);
    item(1,'DEMO-CAP-020','Cold Storage Unit (Demo)','8418','unit',1800,1);
    // These are separate GSTIN drafts. The app has no common-credit allocation engine.
    for (const [gstin, branch, suffix] of [[1,1,'MH'],[2,3,'KA']]) {
      addInvoice({ company:1,branch,gstin,counterparty:kaveri,partyName:'Kaveri Labs (Demo)',partyGstin:'29DEMOS0000A1Z3',number:`DEMO-COMMON-${suffix}-001`,supplierNumber:`DEMO-KL-${suffix}-001`,type:'purchase',status:'draft',date:today,notes:'SYNTHETIC COMMON SERVICE WORKING. Separate recipient draft; allocation, ITC and supplier posting pending.',creator:1,lines:[{item:service,quantity:1,price:120000,rate:1800}] });
    }

    const puneCustomer = party(1,'Pune Community Lab (Demo)','customer','27DEMOC0000A1Z6','27');
    if (!db.prepare("SELECT 1 FROM orders WHERE company_id=1 AND number='DEMO-SO-PUN-401'").get()) {
      const orderId = Number(db.prepare("INSERT INTO orders(company_id,gstin_id,branch_id,party_id,party_name_snapshot,type,number,status,order_date,notes,created_by,confirmed_by,confirmed_at) VALUES (1,1,2,?,'Pune Community Lab (Demo)','sale','DEMO-SO-PUN-401','confirmed',?,'SYNTHETIC ORDER awaiting partial dispatch from Pune',1,3,CURRENT_TIMESTAMP)").run(puneCustomer,today).lastInsertRowid);
      db.prepare("INSERT INTO order_lines(order_id,item_id,item_name_snapshot,quantity,unit_price_cents,gst_rate_bps) VALUES (?,1,'Glucose Strips',12,6200,1200)").run(orderId);
      for (const [action, actor] of [['create',1],['confirm',3]]) db.prepare("INSERT INTO order_events(company_id,order_id,action,actor_id,details) VALUES (1,?,?,?,'Synthetic sales order; no stock dispatched')").run(orderId,action,actor);
    }
    const mysuru = db.prepare("SELECT id,name FROM parties WHERE company_id=1 AND gstin='29DEMOH0000A1Z8'").get();
    if (mysuru && !db.prepare("SELECT 1 FROM orders WHERE company_id=1 AND number='DEMO-SO-BLR-402'").get()) {
      const orderId = Number(db.prepare("INSERT INTO orders(company_id,gstin_id,branch_id,party_id,party_name_snapshot,type,number,status,order_date,notes,created_by) VALUES (1,2,3,?,?,'sale','DEMO-SO-BLR-402','draft',?,'SYNTHETIC Mysuru Care order; dispatch and invoicing pending',1)")
        .run(mysuru.id,mysuru.name,today).lastInsertRowid);
      db.prepare("INSERT INTO order_lines(order_id,item_id,item_name_snapshot,quantity,unit_price_cents,gst_rate_bps) VALUES (?,1,'Glucose Strips',7,6700,1200)").run(orderId);
      db.prepare("INSERT INTO order_events(company_id,order_id,action,actor_id,details) VALUES (1,?,'create',1,'Synthetic draft; no stock dispatched')").run(orderId);
    }

    // Lot assignment reserves identity against existing Pune stock; the physical
    // movement is zero so the opening balance is never counted twice.
    const lotSpecs = [
      ['DEMO-PUN-GLU-READY',6,new Date(Date.now() + 540 * 86400000).toISOString().slice(0,10)],
      ['DEMO-PUN-GLU-EXPIRED',4,'2020-01-31'],
    ];
    for (const [code, quantity, expiry] of lotSpecs) {
      if (db.prepare('SELECT 1 FROM batch_lots WHERE company_id=1 AND item_id=1 AND batch_code=?').get(code)) continue;
      const physical = db.prepare('SELECT COALESCE(SUM(quantity_delta),0) q FROM stock_movements WHERE company_id=1 AND branch_id=2 AND item_id=1').get().q;
      const assigned = db.prepare('SELECT COALESCE(SUM(m.quantity_delta),0) q FROM batch_movements m JOIN batch_lots l ON l.id=m.batch_id WHERE m.company_id=1 AND m.branch_id=2 AND l.item_id=1').get().q;
      if (physical - assigned < quantity) continue;
      const lotId = Number(db.prepare('INSERT INTO batch_lots(company_id,item_id,batch_code,expires_on) VALUES (1,1,?,?)').run(code,expiry).lastInsertRowid);
      const reference = `demo:pune:lot:${code}`;
      const movementId = Number(db.prepare("INSERT INTO stock_movements(company_id,branch_id,item_id,quantity_delta,type,reason,client_reference) VALUES (1,2,1,0,'batch_assignment','SYNTHETIC assignment from opening stock',?)").run(reference).lastInsertRowid);
      db.prepare("INSERT INTO batch_movements(company_id,batch_id,branch_id,gstin_id,quantity_delta,type,is_allocation,reason,request_signature,operation_reference,stock_movement_id,recorded_by) VALUES (1,?,2,1,?,'receipt',1,'SYNTHETIC allocation from existing Pune stock','{\"syntheticDemo\":true}',?,?,1)")
        .run(lotId,quantity,reference,movementId);
    }

    const serviceBuyer = party(2,'North Quay Instruments (Demo)','customer','27DEMOC0000B1Z2','27');
    const demoService = item(2,'DEMO-SVC-501','Instrument Maintenance (Demo)','9987','service',1800,0);
    const serviceSale = addInvoice({ company:2,branch:4,gstin:3,counterparty:serviceBuyer,partyName:'North Quay Instruments (Demo)',partyGstin:'27DEMOC0000B1Z2',number:'DEMO-SVC-MUM-501',type:'sale',status:'approved',date:today,notes:'SYNTHETIC local service invoice; no physical stock or official filing.',creator:4,approver:5,lines:[{item:demoService,quantity:2,price:75000,rate:1800}] });
    db.prepare("INSERT OR IGNORE INTO invoice_payments(company_id,invoice_id,amount_cents,method,reference,payment_date,recorded_by) VALUES (2,?,60000,'bank','DEMO-SVC-BANK-501',?,4)").run(serviceSale,today);
    addInvoice({ company:2,branch:4,gstin:3,counterparty:5,partyName:'Bright Repairs',partyGstin:'',number:'DEMO-RCM-REVIEW-502',supplierNumber:'DEMO-BR-502',type:'purchase',status:'draft',date:today,notes:'SYNTHETIC unregistered-supplier review candidate only. RCM classification, liability and ITC have not been decided.',creator:4,lines:[{item:demoService,quantity:1,price:40000,rate:0}] });
    if (!db.prepare("SELECT 1 FROM evidence_documents WHERE company_id=2 AND target_type='invoice' AND target_id=? AND title='SYNTHETIC DEMO: service acceptance note'").get(serviceSale)) {
      const docId = Number(db.prepare("INSERT INTO evidence_documents(company_id,gstin_id,branch_id,title,audience,target_type,target_id,created_by) VALUES (2,3,4,'SYNTHETIC DEMO: service acceptance note','internal','invoice',?,4)").run(serviceSale).lastInsertRowid);
      const content = Buffer.from('SYNTHETIC DEMO ONLY. Service acceptance specimen. No authentic customer approval or official evidence.\n');
      db.prepare("INSERT INTO evidence_versions(document_id,version,file_name,mime_type,byte_size,sha256,content,status,uploaded_by) VALUES (?,1,'demo-service-acceptance.txt','text/plain',?,?,?,'pending',4)")
        .run(docId,content.length,createHash('sha256').update(content).digest('hex'),content);
    }
    if (!db.prepare("SELECT 1 FROM statutory_lifecycle_documents WHERE company_id=2 AND gstin_id=3 AND kind='irn' AND source_id=?").get(serviceSale)) {
      const reference = 'SIM-DEMO-IRN-SVC-501';
      const sessionReference = 'SIM-DEMO-TOKEN-SVC-501';
      db.prepare("INSERT INTO statutory_lifecycle_sessions(company_id,gstin_id,service,token_reference,actor_id,expires_at) VALUES (2,3,'irn',?,5,datetime('now','+15 minutes'))").run(sessionReference);
      db.prepare("INSERT INTO statutory_lifecycle_events(company_id,gstin_id,kind,source_id,action,outcome,idempotency_key,request_json,response_json,actor_id) VALUES (2,3,'irn',NULL,'auth','success','demo:svc:501:auth',?,?,5)")
        .run(JSON.stringify({service:'irn',gstinId:3,syntheticDemo:true}),JSON.stringify({simulation:true,tokenReference:sessionReference,officialSubmission:false}));
      db.prepare("INSERT INTO statutory_lifecycle_documents(company_id,gstin_id,kind,source_id,status,reference) VALUES (2,3,'irn',?,'generated',?)")
        .run(serviceSale,reference);
      db.prepare("INSERT INTO statutory_lifecycle_events(company_id,gstin_id,kind,source_id,action,outcome,idempotency_key,request_json,response_json,source_snapshot_json,actor_id) VALUES (2,3,'irn',?,'generate','success','demo:svc:501:irn',?,?,?,5)")
        .run(serviceSale,JSON.stringify({kind:'irn',sourceId:serviceSale,syntheticDemo:true}),JSON.stringify({simulation:true,reference,officialSubmission:false,officialSignature:false}),JSON.stringify({invoiceNumber:'DEMO-SVC-MUM-501',companyId:2,gstinId:3,syntheticDemo:true}));
    }

    // A zero-tax local composition specimen. The notes are explicit because the
    // current invoice model has no distinct bill-of-supply document type.
    const existingNilaSale = db.prepare("SELECT id FROM invoices WHERE company_id=3 AND number='DEMO-NILA-BOS-601'").get();
    const nilaStock = db.prepare('SELECT COALESCE(SUM(quantity_delta),0) q FROM stock_movements WHERE company_id=3 AND branch_id=5 AND item_id=5').get().q;
    let nilaSale = existingNilaSale?.id;
    if (!nilaSale && nilaStock >= 5) {
      nilaSale = addInvoice({ company:3,branch:5,gstin:4,counterparty:6,partyName:'Walk-in Customer',partyGstin:'',number:'DEMO-NILA-BOS-601',type:'sale',status:'approved',date:today,notes:'SYNTHETIC COMPOSITION BILL-OF-SUPPLY SPECIMEN; zero ordinary output GST, no ITC or filing evidence.',creator:6,approver:7,lines:[{item:5,quantity:5,price:9500,rate:0}] });
      db.prepare("INSERT INTO stock_movements(company_id,branch_id,item_id,quantity_delta,type,reason,client_reference,invoice_id) VALUES (3,5,5,-5,'sale','DEMO-NILA-BOS-601','demo:nila:sale:601',?)").run(nilaSale);
    }
    if (nilaSale && db.prepare("SELECT 1 FROM stock_movements WHERE company_id=3 AND client_reference='demo:nila:sale:601' AND invoice_id=?").get(nilaSale)
      && !db.prepare("SELECT 1 FROM returns WHERE company_id=3 AND number='DEMO-NILA-RET-601'").get()) {
      const line = db.prepare('SELECT id FROM invoice_lines WHERE invoice_id=?').get(nilaSale);
      const returnId = Number(db.prepare("INSERT INTO returns(company_id,invoice_id,number,kind,status,reason,subtotal_cents,tax_proposal_cents,total_proposal_cents,created_by) VALUES (3,?,'DEMO-NILA-RET-601','sales_return','draft','SYNTHETIC customer request; no stock or tax effect until local approval',9500,0,9500,6)").run(nilaSale).lastInsertRowid);
      db.prepare('INSERT INTO return_lines(return_id,invoice_line_id,item_id,quantity,subtotal_cents,tax_proposal_cents) VALUES (?,?,5,1,9500,0)').run(returnId,line.id);
    }
    // Current-period rows are present for both additional legal entities.
    for (const [company,gstin] of [[2,3],[3,4]]) db.prepare("INSERT OR IGNORE INTO gst_periods(company_id,gstin_id,period,status) VALUES (?,? ,?,'open')").run(company,gstin,period);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

module.exports = { seedExpandedDemo };
