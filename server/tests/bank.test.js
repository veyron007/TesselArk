import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import express from 'express';

const require = createRequire(import.meta.url);
const { openDatabase } = require('../db.cjs');
const { installBankSchema } = require('../bank-db.cjs');
const { registerBankRoutes } = require('../bank.cjs');

async function fixture(t) {
  const db = openDatabase(':memory:');
  installBankSchema(db);
  const app = express();
  app.use(express.json());
  app.use('/api', (req, res, next) => {
    const companyId = Number(req.header('x-company-id') || 1);
    const userId = Number(req.header('x-user-id') || 1);
    req.company = db.prepare('SELECT * FROM companies WHERE id=?').get(companyId);
    req.user = db.prepare('SELECT * FROM users WHERE id=? AND company_id=?').get(userId, companyId);
    if (!req.company || !req.user) return res.status(403).json({ error:'Unknown company or user' });
    next();
  });
  registerBankRoutes(app,db);
  app.use((error,_req,res,_next) => res.status(error.status || 500).json({ error:error.message }));
  const server = app.listen(0);
  t.after(() => { server.close(); db.close(); });
  return async (method,path,body,companyId=1,userId=2) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`,{method,headers:{'content-type':'application/json','x-company-id':String(companyId),'x-user-id':String(userId)},body:body === undefined ? undefined : JSON.stringify(body)});
    return { status:response.status,data:await response.json() };
  };
}

const csv = 'date,reference,description,amount\n2026-09-20,DEMO-MUM-BANK-201,Harbor receipt,50.00\n';

test('bank CSV preview, commit, review and exact replay preserve source audit',async t => {
  const api = await fixture(t);
  const account = await api('POST','/api/bank/accounts',{name:'Operating bank',maskedAccount:'•••• 1234'});
  assert.equal(account.status,200);
  const input = {accountId:account.data.account.id,sourceName:'Local bank export.csv',csv};
  const preview = await api('POST','/api/bank/statements/preview',input);
  assert.equal(preview.status,200);
  assert.equal(preview.data.preview.newCount,1);
  const saved = await api('POST','/api/bank/statements/commit',{...input,expectedSha256:preview.data.preview.sha256});
  assert.equal(saved.status,200);
  assert.equal(saved.data.inserted,1);
  const replay = await api('POST','/api/bank/statements/commit',{...input,expectedSha256:preview.data.preview.sha256});
  assert.equal(replay.data.replayed,true);
  const listed = await api('GET',`/api/bank/lines?accountId=${input.accountId}`);
  assert.equal(listed.data.summary.pendingCount,1);
  const candidate = (await api('GET','/api/bank/payments/unassigned')).data.payments.find(p=>p.reference==='DEMO-MUM-BANK-201');
  assert.ok(candidate);
  assert.equal((await api('POST',`/api/bank/lines/${listed.data.lines[0].id}/review`,{decision:'match',paymentId:candidate.id})).status,409);
  const assignment=await api('POST',`/api/bank/payments/${candidate.id}/account`,{accountId:input.accountId,reason:'Reviewed treasury source account'});
  assert.equal(assignment.status,200);
  assert.equal(assignment.data.assignment.accountId,input.accountId);
  assert.equal((await api('GET',`/api/bank/payments?accountId=${input.accountId}`)).data.payments.some(p=>p.id===candidate.id),true);
  const reviewed = await api('POST',`/api/bank/lines/${listed.data.lines[0].id}/review`,{decision:'match',paymentId:candidate.id});
  assert.equal(reviewed.status,200);
  assert.equal(reviewed.data.line.status,'matched');
  assert.equal((await api('GET',`/api/bank/lines?accountId=${input.accountId}`)).data.summary.matchedCount,1);
  const history=await api('GET',`/api/bank/lines/${listed.data.lines[0].id}`);
  assert.equal(history.data.events.length,1);
  assert.equal(history.data.events[0].paymentId,candidate.id);
});

test('changed duplicate, malformed input, scope and permissions are enforced',async t => {
  const api = await fixture(t);
  const created = await api('POST','/api/bank/accounts',{name:'Bank A',maskedAccount:'1234'});
  const accountId = created.data.account.id;
  const input = {accountId,sourceName:'File',csv};
  const preview = await api('POST','/api/bank/statements/preview',input);
  assert.equal((await api('POST','/api/bank/statements/commit',{...input,expectedSha256:preview.data.preview.sha256},1,1)).status,403);
  assert.equal((await api('POST','/api/bank/statements/commit',{...input,expectedSha256:'bad'})).status,409);
  assert.equal((await api('POST','/api/bank/statements/commit',{...input,expectedSha256:preview.data.preview.sha256})).status,200);
  const changed = await api('POST','/api/bank/statements/preview',{...input,csv:csv.replace('50.00','60.00')});
  assert.equal(changed.data.preview.conflictCount,1);
  assert.equal(changed.data.preview.canCommit,false);
  assert.equal((await api('GET',`/api/bank/lines?accountId=${accountId}`,undefined,2,5)).status,404);
  assert.equal((await api('POST','/api/bank/statements/preview',{...input,csv:'date,reference,description,amount\n2026-02-30,X,x,1.00\n'})).data.preview.invalidCount,1);
});

test('one line cannot match a different company or a payment already reconciled elsewhere',async t => {
  const api = await fixture(t);
  const a = (await api('POST','/api/bank/accounts',{name:'Bank A',maskedAccount:'1234'})).data.account.id;
  const b = (await api('POST','/api/bank/accounts',{name:'Bank B',maskedAccount:'5678'})).data.account.id;
  const other = (await api('POST','/api/bank/accounts',{name:'Bank C',maskedAccount:'9999'},2,5)).data.account.id;
  const importLine = async (accountId,reference) => {
    const input={accountId,sourceName:'File',csv:csv.replace('DEMO-MUM-BANK-201',reference)};
    const p=await api('POST','/api/bank/statements/preview',input);
    assert.equal((await api('POST','/api/bank/statements/commit',{...input,expectedSha256:p.data.preview.sha256})).status,200);
    return (await api('GET',`/api/bank/lines?accountId=${accountId}`)).data.lines[0].id;
  };
  const line1=await importLine(a,'FIRST-REF');
  const line2=await importLine(b,'SECOND-REF');
  const paymentId=(await api('GET','/api/bank/payments/unassigned')).data.payments.find(p=>p.reference==='DEMO-MUM-BANK-201').id;
  assert.equal((await api('POST',`/api/bank/payments/${paymentId}/account`,{accountId:a,reason:'Allocated to Bank A'})).status,200);
  assert.equal((await api('GET',`/api/bank/payments?accountId=${b}`)).data.payments.some(p=>p.id===paymentId),false);
  assert.equal((await api('POST',`/api/bank/lines/${line2}/review`,{decision:'match',paymentId})).status,409);
  assert.equal((await api('POST',`/api/bank/lines/${line1}/review`,{decision:'match',paymentId})).status,200);
  assert.equal((await api('POST',`/api/bank/lines/${line2}/review`,{decision:'match',paymentId})).status,409);
  const otherInput={accountId:other,sourceName:'File',csv};
  const p=await api('POST','/api/bank/statements/preview',otherInput,2,5);
  assert.equal((await api('POST','/api/bank/statements/commit',{...otherInput,expectedSha256:p.data.preview.sha256},2,5)).status,200);
  const otherLine=(await api('GET',`/api/bank/lines?accountId=${other}`,undefined,2,5)).data.lines[0].id;
  assert.equal((await api('POST',`/api/bank/lines/${otherLine}/review`,{decision:'match',paymentId},2,5)).status,404);
});

test('debits, explanation, reopening and payment direction need human review',async t => {
  const api=await fixture(t);
  const accountId=(await api('POST','/api/bank/accounts',{name:'Treasury',maskedAccount:'•••• 8877'})).data.account.id;
  const input={accountId,sourceName:'Bank file',csv:'date,reference,description,amount\n2026-09-20,OUT-1,"Supplier, outbound",-50.00\n'};
  const preview=await api('POST','/api/bank/statements/preview',input);
  assert.equal(preview.data.preview.rows[0].description,'Supplier, outbound');
  assert.equal((await api('POST','/api/bank/statements/commit',{...input,expectedSha256:preview.data.preview.sha256})).status,200);
  const lineId=(await api('GET',`/api/bank/lines?accountId=${accountId}`)).data.lines[0].id;
  const salePayment=(await api('GET','/api/bank/payments/unassigned')).data.payments.find(row=>row.reference==='DEMO-MUM-BANK-201');
  assert.equal((await api('POST',`/api/bank/payments/${salePayment.id}/account`,{accountId,reason:'Allocated to Treasury'})).status,200);
  assert.equal((await api('POST',`/api/bank/lines/${lineId}/review`,{decision:'match',paymentId:salePayment.id})).status,409);
  assert.equal((await api('POST',`/api/bank/lines/${lineId}/review`,{decision:'explain',reason:'Outgoing bank fee awaiting source voucher'},1,1)).status,403);
  const explained=await api('POST',`/api/bank/lines/${lineId}/review`,{decision:'explain',reason:'Outgoing bank fee awaiting source voucher'});
  assert.equal(explained.data.line.status,'explained');
  assert.equal(explained.data.events[0].reason,'Outgoing bank fee awaiting source voucher');
  assert.equal((await api('POST',`/api/bank/lines/${lineId}/review`,{decision:'explain',reason:'Overwrite'})).status,409);
  const reopened=await api('POST',`/api/bank/lines/${lineId}/review`,{decision:'reopen',reason:'Found supplier remittance advice'});
  assert.equal(reopened.data.line.status,'pending');
  assert.equal(reopened.data.events.length,2);
});

test('within-file repeats are skipped and changed duplicates block the whole commit',async t => {
  const api=await fixture(t);
  const accountId=(await api('POST','/api/bank/accounts',{name:'Current account',maskedAccount:'x1234'})).data.account.id;
  const repeated={accountId,sourceName:'Repeat file',csv:csv+csv.split('\n')[1]+'\n'};
  const preview=await api('POST','/api/bank/statements/preview',repeated);
  assert.equal(preview.data.preview.repeatCount,1);
  assert.equal(preview.data.preview.newCount,1);
  const saved=await api('POST','/api/bank/statements/commit',{...repeated,expectedSha256:preview.data.preview.sha256});
  assert.equal(saved.data.skipped,1);
  assert.equal((await api('GET',`/api/bank/lines?accountId=${accountId}`)).data.lines.length,1);
  const conflict={accountId,sourceName:'Conflict file',csv:csv+csv.split('\n')[1].replace('50.00','51.00')+'\n'};
  const checked=await api('POST','/api/bank/statements/preview',conflict);
  assert.equal(checked.data.preview.conflictCount,1);
  assert.equal((await api('POST','/api/bank/statements/commit',{...conflict,expectedSha256:checked.data.preview.sha256})).status,409);
});

test('payment account assignment is scoped, reviewer only and immutable',async t=>{
  const api=await fixture(t);
  const a=(await api('POST','/api/bank/accounts',{name:'Company A',maskedAccount:'1234'})).data.account.id;
  const foreign=(await api('POST','/api/bank/accounts',{name:'Company B',maskedAccount:'5678'},2,5)).data.account.id;
  const paymentId=(await api('GET','/api/bank/payments/unassigned')).data.payments.find(p=>p.reference==='DEMO-MUM-BANK-201').id;
  assert.equal((await api('POST',`/api/bank/payments/${paymentId}/account`,{accountId:a,reason:'Reviewed source account'},1,1)).status,403);
  assert.equal((await api('POST',`/api/bank/payments/${paymentId}/account`,{accountId:foreign,reason:'Wrong company'})).status,404);
  assert.equal((await api('POST',`/api/bank/payments/${paymentId}/account`,{accountId:foreign,reason:'Wrong payment'},2,5)).status,404);
  assert.equal((await api('POST',`/api/bank/payments/${paymentId}/account`,{accountId:a,reason:'Reviewed source account'})).status,200);
  assert.equal((await api('POST',`/api/bank/payments/${paymentId}/account`,{accountId:a,reason:'Try duplicate'})).status,409);
  assert.equal((await api('GET','/api/bank/payments/unassigned')).data.payments.some(p=>p.id===paymentId),false);
});

test('payment assignment history survives matching and hides another company',async t=>{
  const api=await fixture(t);
  const accountId=(await api('POST','/api/bank/accounts',{name:'History bank',maskedAccount:'x1234'})).data.account.id;
  const paymentId=(await api('GET','/api/bank/payments/unassigned')).data.payments.find(p=>p.reference==='DEMO-MUM-BANK-201').id;
  const assign=await api('POST',`/api/bank/payments/${paymentId}/account`,{accountId,reason:'Confirmed using treasury advice'});
  assert.equal(assign.status,200);
  const before=await api('GET',`/api/bank/payment-assignments?accountId=${accountId}`);
  assert.equal(before.status,200);
  assert.equal(before.data.assignments[0].reason,'Confirmed using treasury advice');
  assert.equal(before.data.assignments[0].paymentReference,'DEMO-MUM-BANK-201');
  assert.equal(before.data.assignments[0].matchedLineId,null);
  assert.ok(before.data.assignments[0].assignedAt);
  const input={accountId,sourceName:'History.csv',csv};
  const preview=await api('POST','/api/bank/statements/preview',input);
  assert.equal((await api('POST','/api/bank/statements/commit',{...input,expectedSha256:preview.data.preview.sha256})).status,200);
  const lineId=(await api('GET',`/api/bank/lines?accountId=${accountId}`)).data.lines[0].id;
  assert.equal((await api('POST',`/api/bank/lines/${lineId}/review`,{decision:'match',paymentId})).status,200);
  const after=await api('GET',`/api/bank/payment-assignments?accountId=${accountId}`);
  assert.equal(after.data.assignments[0].matchedLineId,lineId);
  assert.equal(after.data.assignments[0].matchedReference,'DEMO-MUM-BANK-201');
  assert.equal((await api('GET',`/api/bank/payment-assignments?accountId=${accountId}`,undefined,2,5)).status,404);
});
