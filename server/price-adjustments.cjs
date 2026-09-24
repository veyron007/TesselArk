const { installPriceAdjustmentSchema } = require('./price-adjustment-db.cjs');
const { assertScopeAccess } = require('./access.cjs');

const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const fields = row => row && Object.fromEntries(Object.entries(row).map(([key, value]) => [key.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase()), value]));
const integer = (value, name, min = 1) => {
  if (!Number.isSafeInteger(value) || value < min) throw fail(`${name} must be an integer of at least ${min}`);
  return value;
};
const words = (value, name, max) => {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max) throw fail(`${name} must be 1 to ${max} characters`);
  return value.trim();
};
const period = value => {
  if (typeof value !== 'string' || !/^\d{4}-(0[1-9]|1[0-2])$/.test(value)) throw fail('period must be YYYY-MM');
  return value;
};
const money = value => {
  if (!Number.isSafeInteger(value)) throw fail('Price adjustment exceeds safe paise precision', 409);
  return value;
};
const roundedTax = (subtotalCents, rateBps) => (BigInt(subtotalCents) * BigInt(rateBps) + 5000n) / 10000n;
const lineAmounts = (oldPrice, newPrice, quantity, rateBps) => {
  const oldSubtotal = BigInt(oldPrice) * BigInt(quantity);
  const newSubtotal = BigInt(newPrice) * BigInt(quantity);
  return {
    subtotalDeltaCents: money(Number(newSubtotal - oldSubtotal)),
    taxProposalCents: money(Number(roundedTax(newSubtotal, rateBps) - roundedTax(oldSubtotal, rateBps))),
  };
};
const atomic = (db, action) => {
  db.exec('BEGIN IMMEDIATE');
  try { const result = action(); db.exec('COMMIT'); return result; }
  catch (error) { db.exec('ROLLBACK'); throw error; }
};
const route = handler => (req, res, next) => { try { res.json(handler(req)); } catch (error) { next(error); } };

function registerPriceAdjustmentRoutes(app, db) {
  installPriceAdjustmentSchema(db);
  const scope = (req, row) => assertScopeAccess(db, { companyId:req.company.id, userId:req.user.id, gstinId:row.gstin_id, branchId:row.branch_id });
  const accountant = req => { if (!['accountant','admin'].includes(req.user.role)) throw fail('Accountant or admin role required', 403); };
  const get = (req, id) => {
    const row = db.prepare('SELECT * FROM price_adjustments WHERE id=? AND company_id=?').get(integer(id,'adjustmentId'),req.company.id);
    if (!row) throw fail('Price adjustment not found in selected company', 404);
    scope(req,row);
    return row;
  };
  const source = (req, lineId) => {
    const row = db.prepare(`SELECT l.*,v.company_id,v.gstin_id,v.branch_id,v.party_id,v.type AS invoice_type,v.status AS invoice_status,v.number AS invoice_number,
      COALESCE(NULLIF(v.party_name_snapshot,''),p.name) AS party_name,i.name AS item_name
      FROM invoice_lines l JOIN invoices v ON v.id=l.invoice_id JOIN parties p ON p.id=v.party_id JOIN items i ON i.id=l.item_id
      WHERE l.id=? AND v.company_id=?`).get(integer(lineId,'invoiceLineId'),req.company.id);
    if (!row) throw fail('Invoice line not found in selected company',404);
    scope(req,row);
    if (row.invoice_status !== 'approved') throw fail('Approved source invoice required',409);
    return row;
  };
  const allocated = lineId => db.prepare(`SELECT COALESCE(SUM(l.quantity),0) AS quantity FROM price_adjustment_lines l
    JOIN price_adjustments a ON a.id=l.adjustment_id WHERE l.invoice_line_id=? AND a.status IN ('pending','approved')`).get(lineId).quantity;
  const detail = (req, id) => {
    const row = get(req,id);
    const lines = db.prepare(`SELECT l.*,v.number AS invoice_number,v.invoice_date,i.name AS item_name,i.sku
      FROM price_adjustment_lines l JOIN invoices v ON v.id=l.invoice_id JOIN items i ON i.id=l.item_id
      WHERE l.adjustment_id=? ORDER BY l.id`).all(id).map(fields);
    const events = db.prepare('SELECT * FROM price_adjustment_events WHERE adjustment_id=? AND company_id=? ORDER BY id').all(id,req.company.id).map(fields);
    const taxReview = db.prepare('SELECT * FROM price_adjustment_tax_reviews WHERE adjustment_id=? AND company_id=?').get(id,req.company.id);
    const taxEvents = db.prepare('SELECT * FROM price_adjustment_tax_events WHERE adjustment_id=? AND company_id=? ORDER BY id').all(id,req.company.id).map(fields);
    return { ...fields(row), lines, events, taxReview:fields(taxReview) || null, taxEvents,
      localProposalOnly:true, excludesRecordedGstAndLedger:true, officialFiling:false };
  };
  const event = (req, id, action, details) => db.prepare('INSERT INTO price_adjustment_events(adjustment_id,company_id,action,actor_id,details) VALUES (?,?,?,?,?)')
    .run(id,req.company.id,action,req.user.id,JSON.stringify(details));
  const validated = (req, body) => {
    const reference = words(body.clientReference,'clientReference',100);
    const reason = words(body.reason,'reason',500);
    if (!Array.isArray(body.lines) || !body.lines.length || body.lines.length > 100) throw fail('lines must contain 1 to 100 source lines');
    const seen = new Set();
    const lines = body.lines.map(input => {
      const invoiceLineId = integer(input?.invoiceLineId,'invoiceLineId');
      if (seen.has(invoiceLineId)) throw fail('Duplicate source invoice line in adjustment',409);
      seen.add(invoiceLineId);
      const row = source(req,invoiceLineId);
      const quantity = integer(input.quantity,'quantity');
      const newUnitPriceCents = integer(input.newUnitPriceCents,'newUnitPriceCents',1);
      if (row.unit_price_cents < 1) throw fail('Free or zero-price source lines need a separate documented treatment',409);
      if (newUnitPriceCents === row.unit_price_cents) throw fail('New rate must differ from source rate');
      if (quantity > row.quantity - allocated(invoiceLineId)) throw fail('Affected quantity exceeds unadjusted invoice quantity',409);
      const amounts = lineAmounts(row.unit_price_cents,newUnitPriceCents,quantity,row.gst_rate_bps);
      return { invoiceLineId,invoiceId:row.invoice_id,itemId:row.item_id,quantity,
        oldUnitPriceCents:row.unit_price_cents,newUnitPriceCents,gstRateBps:row.gst_rate_bps,
        ...amounts,companyId:row.company_id,gstinId:row.gstin_id,branchId:row.branch_id,
        partyId:row.party_id,invoiceType:row.invoice_type };
    });
    const first = lines[0];
    if (lines.some(row => row.companyId !== first.companyId || row.gstinId !== first.gstinId || row.branchId !== first.branchId || row.partyId !== first.partyId || row.invoiceType !== first.invoiceType)) {
      throw fail('All affected invoices must have the same company, GSTIN, branch, party and sale/purchase type',409);
    }
    const subtotalDeltaCents = money(lines.reduce((sum,row) => sum + row.subtotalDeltaCents,0));
    const taxProposalCents = money(lines.reduce((sum,row) => sum + row.taxProposalCents,0));
    const payload = { clientReference:reference,reason,lines:lines.map(({invoiceLineId,quantity,newUnitPriceCents}) => ({invoiceLineId,quantity,newUnitPriceCents})) };
    return { reference,reason,lines,first,subtotalDeltaCents,taxProposalCents,payload };
  };

  app.get('/api/price-adjustments/sources', route(req => {
    const branchId = integer(Number(req.query.branchId),'branchId');
    const branch = db.prepare('SELECT * FROM branches WHERE id=? AND company_id=?').get(branchId,req.company.id);
    if (!branch) throw fail('Branch not found in selected company',404);
    scope(req,branch);
    const rows = db.prepare(`SELECT l.id AS invoice_line_id,l.invoice_id,l.item_id,l.quantity,l.unit_price_cents,l.gst_rate_bps,
      v.number AS invoice_number,v.invoice_date,v.type AS invoice_type,v.party_id,v.gstin_id,v.branch_id,
      COALESCE(NULLIF(v.party_name_snapshot,''),p.name) AS party_name,i.name AS item_name,i.sku
      FROM invoice_lines l JOIN invoices v ON v.id=l.invoice_id JOIN parties p ON p.id=v.party_id JOIN items i ON i.id=l.item_id
      WHERE v.company_id=? AND v.branch_id=? AND v.status='approved' ORDER BY v.invoice_date DESC,v.id DESC,l.id`).all(req.company.id,branchId);
    return { sources:rows.map(row => ({...fields(row),allocatedQuantity:allocated(row.invoice_line_id),availableQuantity:row.quantity-allocated(row.invoice_line_id)})) };
  }));
  app.get('/api/price-adjustments', route(req => {
    const branchId = req.query.branchId ? integer(Number(req.query.branchId),'branchId') : null;
    if (branchId) {
      const branch = db.prepare('SELECT * FROM branches WHERE id=? AND company_id=?').get(branchId,req.company.id);
      if (!branch) throw fail('Branch not found in selected company',404);
      scope(req,branch);
    }
    const rows = db.prepare('SELECT * FROM price_adjustments WHERE company_id=? AND (? IS NULL OR branch_id=?) ORDER BY id DESC LIMIT 200').all(req.company.id,branchId,branchId)
      .filter(row => req.scopes.branchIds.includes(row.branch_id) && req.scopes.gstinIds.includes(row.gstin_id));
    return { adjustments:rows.map(fields), localProposalOnly:true };
  }));
  app.get('/api/price-adjustments/:id', route(req => ({ adjustment:detail(req,Number(req.params.id)) })));
  app.post('/api/price-adjustments', route(req => atomic(db, () => {
    const body = req.body || {};
    const reference = words(body.clientReference,'clientReference',100);
    const existing = db.prepare('SELECT * FROM price_adjustments WHERE company_id=? AND client_reference=?').get(req.company.id,reference);
    if (existing) {
      scope(req,existing);
      const requested = { clientReference:reference,reason:words(body.reason,'reason',500),lines:body.lines };
      if (JSON.stringify(requested) !== existing.payload_json) throw fail('clientReference already used for different adjustment',409);
      return { adjustment:detail(req,existing.id),replayed:true };
    }
    const result = validated(req,body);
    const { first,lines,reason,payload,subtotalDeltaCents,taxProposalCents } = result;
    const id = Number(db.prepare(`INSERT INTO price_adjustments(company_id,gstin_id,branch_id,party_id,invoice_type,client_reference,reason,payload_json,subtotal_delta_cents,tax_proposal_cents,created_by)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(req.company.id,first.gstinId,first.branchId,first.partyId,first.invoiceType,reference,reason,JSON.stringify(payload),subtotalDeltaCents,taxProposalCents,req.user.id).lastInsertRowid);
    const insert = db.prepare(`INSERT INTO price_adjustment_lines(adjustment_id,invoice_id,invoice_line_id,item_id,quantity,old_unit_price_cents,new_unit_price_cents,gst_rate_bps,subtotal_delta_cents,tax_proposal_cents)
      VALUES (?,?,?,?,?,?,?,?,?,?)`);
    for (const line of lines) insert.run(id,line.invoiceId,line.invoiceLineId,line.itemId,line.quantity,line.oldUnitPriceCents,line.newUnitPriceCents,line.gstRateBps,line.subtotalDeltaCents,line.taxProposalCents);
    event(req,id,'created',{reference,reason,subtotalDeltaCents,taxProposalCents,sourceLineIds:lines.map(line => line.invoiceLineId)});
    return { adjustment:detail(req,id),replayed:false };
  })));
  app.post('/api/price-adjustments/:id/review', route(req => atomic(db, () => {
    accountant(req);
    const row = get(req,Number(req.params.id));
    const decision = req.body?.decision;
    if (!['approved','rejected'].includes(decision)) throw fail('decision must be approved or rejected');
    const reason = words(req.body?.reason,'reason',500);
    if (row.status !== 'pending') {
      if (row.status === decision && row.review_reason === reason) return { adjustment:detail(req,row.id),replayed:true };
      throw fail('Commercial review is final',409);
    }
    if (row.created_by === req.user.id) throw fail('A different accountant must review the proposal',403);
    const lines = db.prepare('SELECT * FROM price_adjustment_lines WHERE adjustment_id=?').all(row.id);
    for (const line of lines) {
      const current = source(req,line.invoice_line_id);
      if (current.invoice_id !== line.invoice_id || current.item_id !== line.item_id || current.unit_price_cents !== line.old_unit_price_cents || current.gst_rate_bps !== line.gst_rate_bps) throw fail('Source invoice line differs from captured rate or tax basis',409);
      if (allocated(line.invoice_line_id) > current.quantity) throw fail('Affected quantities exceed source invoice',409);
    }
    db.prepare('UPDATE price_adjustments SET status=?,review_reason=?,reviewed_by=?,reviewed_at=CURRENT_TIMESTAMP WHERE id=?').run(decision,reason,req.user.id,row.id);
    event(req,row.id,decision,{reason});
    return { adjustment:detail(req,row.id),replayed:false };
  })));
  app.post('/api/price-adjustments/:id/tax-review', route(req => atomic(db, () => {
    accountant(req);
    const row = get(req,Number(req.params.id));
    const decision = req.body?.decision;
    if (!['accepted','rejected','deferred'].includes(decision)) throw fail('decision must be accepted, rejected, or deferred');
    const selectedPeriod = period(req.body?.period);
    const reason = words(req.body?.reason,'reason',500);
    const existing = db.prepare('SELECT * FROM price_adjustment_tax_reviews WHERE adjustment_id=? AND company_id=?').get(row.id,req.company.id);
    if (existing && existing.decision === decision && existing.period === selectedPeriod && existing.reason === reason) return { adjustment:detail(req,row.id),replayed:true };
    if (row.status !== 'approved') throw fail('Commercial proposal must be approved before tax review',409);
    if (row.created_by === req.user.id) throw fail('A different accountant must review tax impact',403);
    if (existing && existing.decision !== 'deferred') throw fail('Final tax review cannot be changed',409);
    const gst = db.prepare('SELECT * FROM gst_periods WHERE company_id=? AND gstin_id=? AND period=?').get(req.company.id,row.gstin_id,selectedPeriod);
    if (!gst) throw fail('Selected GSTIN period does not exist locally',404);
    if (decision === 'accepted' && gst.status !== 'open') throw fail('Only an open local period can accept a tax proposal',409);
    if (existing) db.prepare(`UPDATE price_adjustment_tax_reviews SET period=?,decision=?,reason=?,tax_proposal_cents=?,reviewed_by=?,reviewed_at=CURRENT_TIMESTAMP WHERE adjustment_id=?`)
      .run(selectedPeriod,decision,reason,row.tax_proposal_cents,req.user.id,row.id);
    else db.prepare(`INSERT INTO price_adjustment_tax_reviews(adjustment_id,company_id,gstin_id,period,decision,reason,tax_proposal_cents,reviewed_by) VALUES (?,?,?,?,?,?,?,?)`)
      .run(row.id,req.company.id,row.gstin_id,selectedPeriod,decision,reason,row.tax_proposal_cents,req.user.id);
    db.prepare(`INSERT INTO price_adjustment_tax_events(adjustment_id,company_id,gstin_id,period,decision,reason,tax_proposal_cents,actor_id) VALUES (?,?,?,?,?,?,?,?)`)
      .run(row.id,req.company.id,row.gstin_id,selectedPeriod,decision,reason,row.tax_proposal_cents,req.user.id);
    return { adjustment:detail(req,row.id),replayed:false };
  })));
}

module.exports = { registerPriceAdjustmentRoutes };
