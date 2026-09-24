const { createHash } = require('node:crypto');
const { assertScopeAccess } = require('./access.cjs');
const { installGstPlaceOfSupplySchema } = require('./gst-place-of-supply-db.cjs');

/*
 * Advisory API contract (all responses are { assessment }):
 * GET  /api/gst-place-of-supply/invoices/:id
 * POST /api/gst-place-of-supply/invoices/:id/proposals
 *   { fingerprint, supplyKind, posStateCode, basisReference, reason,
 *     declaration:{composition,recipientRegistered,ordinaryDomestic,
 *       movementTerminatesAtPos,specialCase} }
 * POST /api/gst-place-of-supply/invoices/:id/proposals/:proposalId/review
 *   { decision:'approved'|'rejected', reason }
 * Sales invoices only. Staff proposes against the exact current fingerprint;
 * a separate accountant/admin reviews the latest version. Supported ordinary
 * goods movement and default domestic registered-recipient service proposals
 * receive advisory tax heads on saved invoice tax cents. Special cases receive
 * requires_specialist_review and no tax split. No invoice, ledger, or GST
 * period posting occurs here; approval means internal review only.
 * Legal context: IGST Act ss. 7, 8, 10, 12 and CBIC circulars 209/03/2024
 * (unregistered goods) and 242/36/2024 (online unregistered services).
 */
const SOURCES = Object.freeze({
  act:'https://cbic-gst.gov.in/hindi/IGST-bill-e.html',
  unregisteredGoods:'https://www.gstcouncil.gov.in/sites/default/files/2024-09/circular-no-209-03-2024.pdf',
  onlineUnregisteredServices:'https://gstcouncil.gov.in/sites/default/files/2025-01/circular-no-242-2024.pdf',
});
const UT_WITHOUT_LEGISLATURE = new Set(['04','26','31','35','38']);
const SPECIAL_CASES = new Set(['none','bill_to_ship_to','unregistered_goods','immovable_property','sez','export','import','reverse_charge','online_unregistered_service','other_or_unknown']);
const COMPOSITIONS = new Set(['goods_only','services_only','mixed_or_unknown']);
const KINDS = new Set(['goods_movement','domestic_service_default','specialist_review']);
const fail = (message,status=400) => Object.assign(new Error(message),{status});
const route = handler => (req,res,next) => { try { res.json(handler(req)); } catch (error) { next(error); } };
const fields = row => row && Object.fromEntries(Object.entries(row).map(([key,value]) => [key.replace(/_([a-z])/g,(_,letter)=>letter.toUpperCase()),value]));
const integer = (value,name) => {
  if (!Number.isSafeInteger(value) || value < 1) throw fail(`${name} must be a positive integer`);
  return value;
};
const words = (value,name,max) => {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max) throw fail(`${name} must be 1 to ${max} characters`);
  return value.trim();
};
const state = (value,name) => {
  if (typeof value !== 'string' || !/^(0[1-9]|[12][0-9]|3[0-8])$/.test(value)) throw fail(`${name} must be a two-digit Indian GST state/UT code`);
  return value;
};
const atomic = (db,action) => {
  db.exec('BEGIN IMMEDIATE');
  try { const result=action(); db.exec('COMMIT'); return result; }
  catch (error) { db.exec('ROLLBACK'); throw error; }
};

function source(db,req,invoiceId) {
  const invoice = db.prepare(`SELECT v.*,g.gstin AS supplier_gstin,g.state_code AS supplier_state_code,
      b.gstin_id AS branch_gstin_id,p.state_code AS party_state_code
    FROM invoices v JOIN gstins g ON g.id=v.gstin_id AND g.company_id=v.company_id
    JOIN branches b ON b.id=v.branch_id AND b.company_id=v.company_id
    JOIN parties p ON p.id=v.party_id AND p.company_id=v.company_id
    WHERE v.id=? AND v.company_id=?`).get(invoiceId,req.company.id);
  if (!invoice) throw fail('Invoice not found in selected company',404);
  assertScopeAccess(db,{companyId:req.company.id,userId:req.user.id,gstinId:invoice.gstin_id,branchId:invoice.branch_id});
  if (invoice.type !== 'sale') throw fail('Place-of-supply decision support currently accepts sales invoices only; purchase supplier location and source tax need separate review');
  const lines = db.prepare(`SELECT l.*,i.track_stock AS track_stock
    FROM invoice_lines l JOIN items i ON i.id=l.item_id AND i.company_id=?
    WHERE l.invoice_id=? ORDER BY l.id`).all(req.company.id,invoiceId);
  const fingerprint = createHash('sha256').update(JSON.stringify({invoice,lines})).digest('hex');
  const arithmeticValid = lines.length > 0 && lines.every(line =>
    Number.isSafeInteger(line.tax_cents) && line.tax_cents >= 0 &&
    Number.isSafeInteger(line.subtotal_cents) && line.subtotal_cents >= 0 &&
    line.subtotal_cents + line.tax_cents === line.total_cents) &&
    lines.reduce((sum,line)=>sum+line.tax_cents,0) === invoice.tax_cents &&
    lines.reduce((sum,line)=>sum+line.subtotal_cents,0) === invoice.subtotal_cents &&
    invoice.subtotal_cents + invoice.tax_cents === invoice.total_cents;
  return {invoice,lines,fingerprint,arithmeticValid};
}

function parseDeclaration(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw fail('declaration is required');
  const {composition,recipientRegistered,ordinaryDomestic,movementTerminatesAtPos,specialCase} = value;
  if (!COMPOSITIONS.has(composition)) throw fail('declaration.composition is invalid');
  if (typeof recipientRegistered !== 'boolean' || typeof ordinaryDomestic !== 'boolean' || typeof movementTerminatesAtPos !== 'boolean') {
    throw fail('declaration registration, domestic scope and movement fields must be explicit booleans');
  }
  if (!SPECIAL_CASES.has(specialCase)) throw fail('declaration.specialCase is invalid');
  return {composition,recipientRegistered,ordinaryDomestic,movementTerminatesAtPos,specialCase};
}

function decision(sourceRow,input) {
  const {invoice,lines,arithmeticValid} = sourceRow;
  const reasons = [];
  const warnings = [];
  if (input.supplyKind === 'specialist_review') reasons.push('Staff selected specialist review');
  if (!input.declaration.ordinaryDomestic) reasons.push('Domestic ordinary supply was not confirmed');
  if (input.declaration.specialCase !== 'none') reasons.push(`Special case: ${input.declaration.specialCase}`);
  if (!input.declaration.recipientRegistered) reasons.push('Unregistered recipient requires specialist review');
  if (!/^(0[1-9]|[12][0-9]|3[0-8])[A-Za-z0-9]{13}$/.test(invoice.supplier_gstin_snapshot || '')) reasons.push('Registered recipient GSTIN is not recorded on this invoice');
  if (input.declaration.composition === 'mixed_or_unknown') reasons.push('Goods/services composition is mixed or unknown');
  if (input.supplyKind === 'goods_movement' && input.declaration.composition !== 'goods_only') reasons.push('Goods movement requires goods-only declaration');
  if (input.supplyKind === 'domestic_service_default' && input.declaration.composition !== 'services_only') reasons.push('Default services requires services-only declaration');
  if (input.supplyKind === 'goods_movement' && !input.declaration.movementTerminatesAtPos) reasons.push('Delivery termination at the proposed place was not confirmed');
  if (input.supplyKind === 'domestic_service_default' && input.posStateCode && invoice.supplier_gstin_snapshot.slice(0,2) !== input.posStateCode) {
    reasons.push('Registered recipient GSTIN state differs from the proposed default service place');
  }
  if (input.posStateCode && input.supplyKind !== 'specialist_review' && !/^(0[1-9]|[12][0-9]|3[0-8])$/.test(invoice.supplier_state_code || '')) reasons.push('Supplier GSTIN state is not valid');
  if (invoice.supplier_gstin.slice(0,2) !== invoice.supplier_state_code) reasons.push('Supplier GSTIN prefix and registration state disagree');
  if (!arithmeticValid) reasons.push('Invoice line arithmetic does not reconcile');
  const tracking = new Set(lines.map(line=>line.track_stock));
  if (tracking.size > 1) warnings.push('Invoice mixes tracked and untracked lines; confirm declared legal supply composition from source documents');
  if (input.supplyKind === 'goods_movement' && tracking.has(0)) warnings.push('Untracked item classification needs source-document confirmation; tracking is not legal goods/service classification');
  if (input.supplyKind === 'domestic_service_default' && tracking.has(1)) warnings.push('Tracked item classification needs source-document confirmation; tracking is not legal goods/service classification');
  if (!input.posStateCode && input.supplyKind !== 'specialist_review') reasons.push('Proposed place state is missing');
  if (reasons.length) return {outcome:'requires_specialist_review',taxHead:null,lineSplit:null,reasons,warnings};

  const intra = invoice.supplier_state_code === input.posStateCode;
  const taxHead = intra ? (UT_WITHOUT_LEGISLATURE.has(input.posStateCode) ? 'CGST+UTGST' : 'CGST+SGST') : 'IGST';
  const lineSplit = lines.map(line => {
    const taxCents = line.tax_cents;
    const central = intra ? Math.floor(taxCents/2) : 0;
    const stateTax = intra ? taxCents-central : 0; // odd paise deterministically to SGST/UTGST
    return {lineId:line.id,taxCents,igstCents:intra ? 0 : taxCents,cgstCents:central,
      sgstCents:intra && taxHead==='CGST+SGST' ? stateTax : 0,
      utgstCents:intra && taxHead==='CGST+UTGST' ? stateTax : 0};
  });
  return {outcome:'proposed_split',taxHead,lineSplit,reasons:[],warnings};
}

function proposalView(row,review,currentFingerprint) {
  const stale = row.invoice_fingerprint !== currentFingerprint;
  return {id:row.id,invoiceId:row.invoice_id,version:row.version,invoiceFingerprint:row.invoice_fingerprint,
    supplyKind:row.supply_kind,posStateCode:row.pos_state_code,declaration:JSON.parse(row.declaration_json),
    basisReference:row.basis_reference,reason:row.reason,outcome:row.outcome,taxHead:row.tax_head,
    lineSplit:row.line_split_json ? JSON.parse(row.line_split_json) : null,
    reasons:JSON.parse(row.reasons_json),warnings:JSON.parse(row.warnings_json),
    proposedBy:row.proposed_by,proposerName:row.proposer_name,proposedAt:row.proposed_at,
    review:review ? fields(review) : null,stale,status:stale ? 'stale' : review?.decision || 'pending'};
}

function assessment(db,req,sourceRow) {
  const {invoice,lines,fingerprint,arithmeticValid} = sourceRow;
  const proposals = db.prepare(`SELECT p.*,u.name AS proposer_name FROM gst_pos_proposals p
    JOIN users u ON u.id=p.proposed_by AND u.company_id=p.company_id
    WHERE p.company_id=? AND p.invoice_id=? ORDER BY p.version DESC`).all(req.company.id,invoice.id);
  const reviews = db.prepare(`SELECT r.*,u.name AS reviewer_name FROM gst_pos_reviews r
    JOIN gst_pos_proposals p ON p.id=r.proposal_id AND p.company_id=r.company_id
    JOIN users u ON u.id=r.reviewed_by AND u.company_id=r.company_id
    WHERE r.company_id=? AND p.invoice_id=?`).all(req.company.id,invoice.id);
  const reviewByProposal = new Map(reviews.map(row=>[row.proposal_id,row]));
  const shown = proposals.map(row=>proposalView(row,reviewByProposal.get(row.id),fingerprint));
  const latest = shown[0] || null;
  return {
    invoice:{id:invoice.id,companyId:invoice.company_id,gstinId:invoice.gstin_id,branchId:invoice.branch_id,
      number:invoice.number,type:invoice.type,status:invoice.status,invoiceDate:invoice.invoice_date,
      supplierGstin:invoice.supplier_gstin,supplierStateCode:invoice.supplier_state_code,
      partyGstin:invoice.supplier_gstin_snapshot,partyStateCode:invoice.party_state_code,
      taxCents:invoice.tax_cents,lines:lines.map(line=>({id:line.id,itemId:line.item_id,
        itemName:line.item_name_snapshot,taxCents:line.tax_cents,trackStock:Boolean(line.track_stock)}))},
    fingerprint,arithmeticValid,proposal:latest,proposals:shown,status:latest?.status || 'unassessed',
    reviewedSplit:latest?.status === 'approved' && latest.outcome === 'proposed_split' ? latest.lineSplit : null,
    officialVerification:false,postsToInvoice:false,postsToLedger:false,postsToGstPeriod:false,sources:SOURCES,
  };
}

function registerGstPlaceOfSupplyRoutes(app,db) {
  installGstPlaceOfSupplySchema(db);
  const load = (req) => source(db,req,integer(Number(req.params.id),'invoiceId'));
  const path = '/api/gst-place-of-supply/invoices/:id';
  app.get(path,route(req=>({assessment:assessment(db,req,load(req))})));
  app.post(`${path}/proposals`,route(req=>atomic(db,()=>{
    if (req.user.role !== 'staff') throw fail('Staff role required to propose place-of-supply assessment',403);
    const current = load(req);
    const body = req.body || {};
    if (typeof body.fingerprint !== 'string' || body.fingerprint !== current.fingerprint) throw fail('Invoice snapshot changed; refresh assessment before proposing',409);
    if (!KINDS.has(body.supplyKind)) throw fail('supplyKind is invalid');
    const declaration = parseDeclaration(body.declaration);
    const posStateCode = body.posStateCode == null || body.posStateCode === '' ? null : state(body.posStateCode,'posStateCode');
    const basisReference = words(body.basisReference,'basisReference',300);
    const reason = words(body.reason,'reason',1000);
    const calculated = decision(current,{supplyKind:body.supplyKind,posStateCode,declaration});
    const version = db.prepare('SELECT COALESCE(MAX(version),0)+1 AS version FROM gst_pos_proposals WHERE company_id=? AND invoice_id=?')
      .get(req.company.id,current.invoice.id).version;
    db.prepare(`INSERT INTO gst_pos_proposals(company_id,invoice_id,version,invoice_fingerprint,supply_kind,pos_state_code,
      declaration_json,basis_reference,reason,outcome,tax_head,line_split_json,reasons_json,warnings_json,proposed_by)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(req.company.id,current.invoice.id,version,current.fingerprint,body.supplyKind,
      posStateCode,JSON.stringify(declaration),basisReference,reason,calculated.outcome,calculated.taxHead,
      calculated.lineSplit ? JSON.stringify(calculated.lineSplit) : null,JSON.stringify(calculated.reasons),JSON.stringify(calculated.warnings),req.user.id);
    return {assessment:assessment(db,req,current)};
  })));
  app.post(`${path}/proposals/:proposalId/review`,route(req=>atomic(db,()=>{
    if (!['accountant','admin'].includes(req.user.role)) throw fail('Accountant or admin role required',403);
    const current = load(req);
    const proposalId = integer(Number(req.params.proposalId),'proposalId');
    const proposal = db.prepare('SELECT * FROM gst_pos_proposals WHERE id=? AND company_id=? AND invoice_id=?')
      .get(proposalId,req.company.id,current.invoice.id);
    if (!proposal) throw fail('Proposal not found on this invoice',404);
    if (proposal.proposed_by === req.user.id) throw fail('A different accountant or admin must review the proposal',403);
    if (proposal.invoice_fingerprint !== current.fingerprint) throw fail('Invoice snapshot changed; proposal is stale',409);
    const latest = db.prepare('SELECT MAX(version) AS version FROM gst_pos_proposals WHERE company_id=? AND invoice_id=?')
      .get(req.company.id,current.invoice.id).version;
    if (proposal.version !== latest) throw fail('Only the latest proposal can be reviewed',409);
    if (db.prepare('SELECT 1 FROM gst_pos_reviews WHERE proposal_id=?').get(proposalId)) throw fail('Proposal review is final',409);
    const decisionValue = req.body?.decision;
    if (!['approved','rejected'].includes(decisionValue)) throw fail('decision must be approved or rejected');
    const reason = words(req.body?.reason,'reason',1000);
    db.prepare('INSERT INTO gst_pos_reviews(company_id,proposal_id,decision,reason,reviewed_by) VALUES (?,?,?,?,?)')
      .run(req.company.id,proposal.id,decisionValue,reason,req.user.id);
    return {assessment:assessment(db,req,current)};
  })));
}

module.exports = { registerGstPlaceOfSupplyRoutes,installGstPlaceOfSupplySchema,assessment,decision };
