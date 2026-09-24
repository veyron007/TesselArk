import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { openDatabase } = require('../db.cjs');
const { createApp } = require('../api.cjs');

async function fixture(t) {
  const db = openDatabase(':memory:');
  const server = createApp({db}).listen(0);
  t.after(() => { server.close(); db.close(); });
  const api = async (method,path,body,{companyId=1,userId=1}={}) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`,{
      method,headers:{'content-type':'application/json','x-company-id':String(companyId),'x-user-id':String(userId)},
      body:body === undefined ? undefined : JSON.stringify(body),
    });
    return {status:response.status,data:await response.json()};
  };
  return {db,api};
}

let sequence=0;
function invoice(db,{gstinId=1,branchId=1,partyId=1,partyGstin='27DEMOH0000A1Z4',type='sale',itemIds=[1],taxCents=1201}={}) {
  const subtotalCents = 10005*itemIds.length;
  const totalTaxCents = taxCents*itemIds.length;
  const id = Number(db.prepare(`INSERT INTO invoices(company_id,branch_id,gstin_id,party_id,number,supplier_gstin_snapshot,
    party_name_snapshot,type,status,invoice_date,subtotal_cents,tax_cents,total_cents,created_by,submitted_by)
    VALUES (1,?,?,?,?,?,? ,?,'submitted','2026-09-20',?,?,?,1,1)`)
    .run(branchId,gstinId,partyId,`POS-${++sequence}`,partyGstin,'Demo recipient',type,
      subtotalCents,totalTaxCents,subtotalCents+totalTaxCents).lastInsertRowid);
  for (const itemId of itemIds) db.prepare(`INSERT INTO invoice_lines(invoice_id,item_id,quantity,unit_price_cents,gst_rate_bps,
    subtotal_cents,tax_cents,total_cents) VALUES (?,?,1,10005,1200,10005,?,?)`)
    .run(id,itemId,taxCents,10005+taxCents);
  return id;
}

const declaration = (changes={}) => ({composition:'goods_only',recipientRegistered:true,ordinaryDomestic:true,
  movementTerminatesAtPos:true,specialCase:'none',...changes});
const proposal = (fingerprint,changes={}) => ({fingerprint,supplyKind:'goods_movement',posStateCode:'27',
  basisReference:'Signed delivery note DEMO-1',reason:'Staff confirmed destination on source document',
  declaration:declaration(),...changes});
const path = id => `/api/gst-place-of-supply/invoices/${id}`;

test('same-state goods split preserves every existing tax paisa and has no posting side effects',async t => {
  const {db,api} = await fixture(t);
  const id = invoice(db);
  const before = {
    invoice:db.prepare('SELECT * FROM invoices WHERE id=?').get(id),
    journal:db.prepare('SELECT COUNT(*) AS n FROM journals').get().n,
    period:db.prepare('SELECT * FROM gst_periods WHERE company_id=1 AND gstin_id=1 ORDER BY id LIMIT 1').get(),
    stock:db.prepare('SELECT COUNT(*) AS n FROM stock_movements').get().n,
  };
  const read = await api('GET',path(id));
  assert.equal(read.status,200);
  assert.equal(read.data.assessment.invoice.supplierGstin,'27DEMOA0000A1Z1');
  assert.equal(read.data.assessment.invoice.partyGstin,'27DEMOH0000A1Z4');
  const made = await api('POST',`${path(id)}/proposals`,proposal(read.data.assessment.fingerprint));
  assert.equal(made.status,200);
  assert.equal(made.data.assessment.proposal.taxHead,'CGST+SGST');
  assert.deepEqual(made.data.assessment.proposal.lineSplit[0],{
    lineId:made.data.assessment.invoice.lines[0].id,taxCents:1201,igstCents:0,cgstCents:600,sgstCents:601,utgstCents:0,
  });
  assert.equal(made.data.assessment.proposal.status,'pending');
  assert.match(made.data.assessment.proposal.proposedAt,/^\d{4}-\d{2}-\d{2}/);
  const reviewed = await api('POST',`${path(id)}/proposals/${made.data.assessment.proposal.id}/review`,
    {decision:'approved',reason:'Checked destination evidence'}, {userId:2});
  assert.equal(reviewed.status,200);
  assert.equal(reviewed.data.assessment.status,'approved');
  assert.match(reviewed.data.assessment.proposal.review.reviewedAt,/^\d{4}-\d{2}-\d{2}/);
  assert.equal(reviewed.data.assessment.reviewedSplit[0].cgstCents,600);
  assert.deepEqual(db.prepare('SELECT * FROM invoices WHERE id=?').get(id),before.invoice);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM journals').get().n,before.journal);
  assert.deepEqual(db.prepare('SELECT * FROM gst_periods WHERE company_id=1 AND gstin_id=1 ORDER BY id LIMIT 1').get(),before.period);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM stock_movements').get().n,before.stock);
});

test('different-state goods and default registered service allocate exact saved tax to IGST',async t => {
  const {db,api} = await fixture(t);
  const goodsId = invoice(db,{gstinId:2,branchId:3,partyGstin:'27DEMOH0000A1Z4'});
  const goodsRead = await api('GET',path(goodsId));
  const goods = await api('POST',`${path(goodsId)}/proposals`,proposal(goodsRead.data.assessment.fingerprint));
  assert.equal(goods.status,200);
  assert.equal(goods.data.assessment.proposal.taxHead,'IGST');
  assert.equal(goods.data.assessment.proposal.lineSplit[0].igstCents,1201);

  const serviceId = Number(db.prepare(`INSERT INTO items(company_id,sku,name,hsn,track_stock) VALUES (1,'POS-SVC-TEST','Service test','9983',0)`).run().lastInsertRowid);
  const invoiceId = invoice(db,{itemIds:[serviceId]});
  const read = await api('GET',path(invoiceId));
  const made = await api('POST',`${path(invoiceId)}/proposals`,proposal(read.data.assessment.fingerprint,{
    supplyKind:'domestic_service_default',declaration:declaration({composition:'services_only',movementTerminatesAtPos:false}),
    basisReference:'Registered recipient GSTIN and ordinary service description',
  }));
  assert.equal(made.status,200);
  assert.equal(made.data.assessment.proposal.taxHead,'CGST+SGST');
  assert.deepEqual(made.data.assessment.proposal.reasons,[]);
  const mismatch = await api('POST',`${path(invoiceId)}/proposals`,proposal(read.data.assessment.fingerprint,{
    supplyKind:'domestic_service_default',posStateCode:'29',
    declaration:declaration({composition:'services_only',movementTerminatesAtPos:false}),
  }));
  assert.equal(mismatch.data.assessment.proposal.outcome,'requires_specialist_review');
  assert.match(mismatch.data.assessment.proposal.reasons.join(' '),/recipient GSTIN state/);
});

test('intra-UT split puts odd tax paisa in UTGST, while event rows cannot be rewritten',async t => {
  const {db,api} = await fixture(t);
  const gstinId = Number(db.prepare("INSERT INTO gstins(company_id,gstin,state_code) VALUES (1,'04DEMOA0000A1Z1','04')").run().lastInsertRowid);
  const branchId = Number(db.prepare("INSERT INTO branches(company_id,gstin_id,name) VALUES (1,?,'Chandigarh Test')").run(gstinId).lastInsertRowid);
  db.prepare("INSERT INTO user_gstin_grants(company_id,user_id,gstin_id,granted_by,reason) VALUES (1,1,?,3,'Test scope')").run(gstinId);
  db.prepare("INSERT INTO user_branch_grants(company_id,user_id,branch_id,granted_by,reason) VALUES (1,1,?,3,'Test scope')").run(branchId);
  const id = invoice(db,{gstinId,branchId,partyGstin:'04DEMOH0000A1Z4'});
  const read = await api('GET',path(id));
  const made = await api('POST',`${path(id)}/proposals`,proposal(read.data.assessment.fingerprint,{posStateCode:'04'}));
  assert.equal(made.status,200);
  assert.equal(made.data.assessment.proposal.taxHead,'CGST+UTGST');
  assert.deepEqual(made.data.assessment.proposal.lineSplit[0],{
    lineId:made.data.assessment.invoice.lines[0].id,taxCents:1201,igstCents:0,cgstCents:600,sgstCents:0,utgstCents:601,
  });
  assert.throws(() => db.prepare("UPDATE gst_pos_proposals SET reason='Forged' WHERE id=?").run(made.data.assessment.proposal.id),/immutable/);
  assert.throws(() => db.prepare('DELETE FROM gst_pos_proposals WHERE id=?').run(made.data.assessment.proposal.id),/immutable/);
});

test('unregistered, bill-to/ship-to, mixed and uncertain supplies require specialist review without a split',async t => {
  const {db,api} = await fixture(t);
  const unregisteredId = invoice(db,{partyId:3,partyGstin:''});
  const unregisteredRead = await api('GET',path(unregisteredId));
  const unregistered = await api('POST',`${path(unregisteredId)}/proposals`,proposal(unregisteredRead.data.assessment.fingerprint,{
    declaration:declaration({recipientRegistered:false,specialCase:'unregistered_goods'}),
  }));
  assert.equal(unregistered.status,200);
  assert.equal(unregistered.data.assessment.proposal.outcome,'requires_specialist_review');
  assert.equal(unregistered.data.assessment.proposal.taxHead,null);
  assert.equal(unregistered.data.assessment.proposal.lineSplit,null);

  const id = invoice(db);
  const read = await api('GET',path(id));
  const special = await api('POST',`${path(id)}/proposals`,proposal(read.data.assessment.fingerprint,{
    declaration:declaration({specialCase:'bill_to_ship_to'}),
  }));
  assert.equal(special.data.assessment.proposal.outcome,'requires_specialist_review');
  assert.equal(special.data.assessment.proposal.lineSplit,null);
  for (const specialCase of ['immovable_property','sez','export','import','reverse_charge','online_unregistered_service','other_or_unknown']) {
    const caseResult = await api('POST',`${path(id)}/proposals`,proposal(read.data.assessment.fingerprint,{
      declaration:declaration({specialCase}),
    }));
    assert.equal(caseResult.data.assessment.proposal.outcome,'requires_specialist_review',specialCase);
    assert.equal(caseResult.data.assessment.proposal.taxHead,null,specialCase);
  }
  const uncertain = await api('POST',`${path(id)}/proposals`,proposal(read.data.assessment.fingerprint,{
    supplyKind:'specialist_review',posStateCode:'',declaration:declaration({composition:'mixed_or_unknown',ordinaryDomestic:false,specialCase:'other_or_unknown'}),
  }));
  assert.equal(uncertain.status,200);
  assert.equal(uncertain.data.assessment.proposal.posStateCode,null);
  assert.equal(uncertain.data.assessment.proposal.taxHead,null);

  const serviceId = Number(db.prepare(`INSERT INTO items(company_id,sku,name,hsn,track_stock) VALUES (1,'POS-SVC-MIX','Service test','9983',0)`).run().lastInsertRowid);
  const mixedId = invoice(db,{itemIds:[1,serviceId]});
  const mixedRead = await api('GET',path(mixedId));
  const mixed = await api('POST',`${path(mixedId)}/proposals`,proposal(mixedRead.data.assessment.fingerprint,{
    declaration:declaration({composition:'mixed_or_unknown'}),
  }));
  assert.equal(mixed.data.assessment.proposal.outcome,'requires_specialist_review');
  assert.match(mixed.data.assessment.proposal.reasons.join(' '),/mixed or unknown/);
  const declaredGoods = await api('POST',`${path(mixedId)}/proposals`,proposal(mixedRead.data.assessment.fingerprint,{
    basisReference:'Signed goods-only source despite inventory tracking settings',
  }));
  assert.equal(declaredGoods.data.assessment.proposal.outcome,'proposed_split');
  assert.match(declaredGoods.data.assessment.proposal.warnings.join(' '),/tracked and untracked/);
});

test('separation of duties, immutable review, versions and stale invoice snapshot are enforced',async t => {
  const {db,api} = await fixture(t);
  const id = invoice(db);
  const read = await api('GET',path(id));
  const first = await api('POST',`${path(id)}/proposals`,proposal(read.data.assessment.fingerprint));
  const firstId = first.data.assessment.proposal.id;
  assert.equal((await api('POST',`${path(id)}/proposals`,proposal(read.data.assessment.fingerprint),{userId:2})).status,403);
  assert.equal((await api('POST',`${path(id)}/proposals/${firstId}/review`,{decision:'approved',reason:'Self review'})).status,403);
  assert.equal((await api('POST',`${path(id)}/proposals/${firstId}/review`,{decision:'approved',reason:'Staff cannot review'})).status,403);
  const second = await api('POST',`${path(id)}/proposals`,proposal(read.data.assessment.fingerprint,{reason:'Revised evidence'}));
  assert.equal(second.data.assessment.proposal.version,2);
  assert.equal((await api('POST',`${path(id)}/proposals/${firstId}/review`,{decision:'approved',reason:'Old version'}, {userId:2})).status,409);
  const secondId = second.data.assessment.proposal.id;
  const approved = await api('POST',`${path(id)}/proposals/${secondId}/review`,{decision:'approved',reason:'Independent check'}, {userId:2});
  assert.equal(approved.status,200);
  assert.equal((await api('POST',`${path(id)}/proposals/${secondId}/review`,{decision:'rejected',reason:'Changed mind'}, {userId:3})).status,409);
  db.prepare('UPDATE invoice_lines SET tax_cents=tax_cents+1,total_cents=total_cents+1 WHERE invoice_id=?').run(id);
  db.prepare('UPDATE invoices SET tax_cents=tax_cents+1,total_cents=total_cents+1 WHERE id=?').run(id);
  const stale = await api('GET',path(id));
  assert.equal(stale.data.assessment.status,'stale');
  assert.equal(stale.data.assessment.reviewedSplit,null);
  assert.equal((await api('POST',`${path(id)}/proposals/${secondId}/review`,{decision:'approved',reason:'Stale'}, {userId:3})).status,409);
  assert.equal((await api('POST',`${path(id)}/proposals`,proposal(read.data.assessment.fingerprint))).status,409);
});

test('sales-only, company/GSTIN/branch scope and proposal identity prevent leaking or tampering',async t => {
  const {db,api} = await fixture(t);
  const id = invoice(db);
  const purchaseId = invoice(db,{type:'purchase'});
  assert.equal((await api('GET',path(purchaseId))).status,400);
  assert.equal((await api('GET',path(id),undefined,{companyId:2,userId:4})).status,404);
  const read = await api('GET',path(id));
  assert.equal((await api('POST',`${path(id)}/proposals`,proposal(read.data.assessment.fingerprint,{posStateCode:'99'}))).status,400);
  const made = await api('POST',`${path(id)}/proposals`,proposal(read.data.assessment.fingerprint));
  const secondInvoice = invoice(db);
  assert.equal((await api('POST',`${path(secondInvoice)}/proposals/${made.data.assessment.proposal.id}/review`,
    {decision:'approved',reason:'Wrong invoice'}, {userId:2})).status,404);
  db.prepare("UPDATE user_branch_grants SET revoked_by=3,revoked_at=CURRENT_TIMESTAMP,revoked_reason='Test revocation' WHERE company_id=1 AND user_id=1 AND branch_id=1 AND revoked_at IS NULL").run();
  assert.equal((await api('GET',path(id))).status,403);
  assert.equal((await api('POST',`${path(id)}/proposals`,proposal(read.data.assessment.fingerprint))).status,403);
  db.prepare("UPDATE user_gstin_grants SET revoked_by=3,revoked_at=CURRENT_TIMESTAMP,revoked_reason='Test revocation' WHERE company_id=1 AND user_id=2 AND gstin_id=1 AND revoked_at IS NULL").run();
  assert.equal((await api('POST',`${path(id)}/proposals/${made.data.assessment.proposal.id}/review`,
    {decision:'approved',reason:'Revoked reviewer'}, {userId:2})).status,403);
});
