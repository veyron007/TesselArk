const { createHash } = require('node:crypto');
const { installBankSchema } = require('./bank-db.cjs');
const { assertCompanyWideAccess } = require('./access.cjs');

const bad = (message,status=400) => Object.assign(new Error(message),{status});
const route = handler => (req,res,next) => { try { res.json(handler(req)); } catch (error) { next(error); } };
const camel = row => Object.fromEntries(Object.entries(row).map(([key,value]) => [key.replace(/_([a-z])/g,(_,letter)=>letter.toUpperCase()),value]));
const HEADERS = ['date','reference','description','amount'];

function id(value,label) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) throw bad(`${label} must be a positive integer`);
  return number;
}
function printable(value,label,max=120) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\x00-\x1F\x7F]/.test(value)) throw bad(`${label} must be 1 to ${max} printable characters`);
  return value.trim();
}
function reviewer(req) {
  if (!['accountant','admin'].includes(req.user.role)) throw bad('Accountant or admin role required',403);
}
function account(db,companyId,accountId) {
  const row = db.prepare('SELECT * FROM bank_accounts WHERE id=? AND company_id=?').get(accountId,companyId);
  if (!row) throw bad('Bank account not found in selected company',404);
  return row;
}
function transaction(db,callback) {
  db.exec('BEGIN IMMEDIATE');
  try { const value=callback(); db.exec('COMMIT'); return value; }
  catch (error) { db.exec('ROLLBACK'); throw error; }
}
function parseCsv(csv) {
  if (typeof csv !== 'string' || !csv || Buffer.byteLength(csv,'utf8') > 128*1024) throw bad('CSV must be UTF-8 text no larger than 128 KB');
  const rows=[]; let fields=[],field='',quoted=false,afterQuote=false,line=1,rowLine=1;
  const endField=()=>{fields=[...fields,field];field='';afterQuote=false;};
  const endRow=()=>{endField();if (fields.some(value=>value!=='')) rows.push({line:rowLine,fields});fields=[];rowLine=line;};
  for (let index=0;index<csv.length;index+=1) {
    const char=csv[index];
    if (quoted) {
      if (char==='"' && csv[index+1]==='"') {field+='"';index+=1;}
      else if (char==='"') {quoted=false;afterQuote=true;}
      else {field+=char;if (char==='\n') line+=1;}
      continue;
    }
    if (char==='"') {if (field || afterQuote) throw bad(`Malformed CSV quote on line ${line}`);quoted=true;continue;}
    if (char===',') {endField();continue;}
    if (char==='\n' || char==='\r') {if (char==='\r' && csv[index+1]==='\n') index+=1;line+=1;endRow();continue;}
    if (afterQuote && char!==' ' && char!=='\t') throw bad(`Unexpected text after CSV quote on line ${line}`);
    if (!afterQuote) field+=char;
  }
  if (quoted) throw bad('CSV has an unclosed quoted field');
  if (field || fields.length) endRow();
  if (!rows.length) throw bad('CSV is empty');
  const header=rows.shift().fields.map((value,index)=>(index===0?value.replace(/^\uFEFF/,''):value).trim().toLowerCase());
  if (header.length!==HEADERS.length || header.some((value,index)=>value!==HEADERS[index])) throw bad(`CSV columns must be: ${HEADERS.join(', ')}`);
  if (!rows.length || rows.length>500) throw bad('CSV must have 1 to 500 data rows');
  return rows;
}
function amountCents(value,line) {
  if (!/^-?(?:0|[1-9]\d{0,10})(?:\.\d{1,2})?$/.test(value)) throw bad(`Line ${line}: amount must be a signed rupee amount with at most two decimals`);
  const negative=value.startsWith('-');
  const [whole,fraction='']=(negative?value.slice(1):value).split('.');
  const cents=(Number(whole)*100+Number(fraction.padEnd(2,'0')))*(negative?-1:1);
  if (!Number.isSafeInteger(cents) || cents===0) throw bad(`Line ${line}: amount must be a nonzero safe amount`);
  return cents;
}
function normalize(raw) {
  if (raw.fields.length!==4) throw bad(`Line ${raw.line}: exactly four columns required`);
  const [date,reference,description,amount]=raw.fields.map(value=>value.trim());
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00Z`)) || new Date(`${date}T00:00:00Z`).toISOString().slice(0,10)!==date) throw bad(`Line ${raw.line}: date must be a real YYYY-MM-DD date`);
  return {line:raw.line,transactionDate:date,reference:printable(reference,`Line ${raw.line}: reference`,100),description:printable(description,`Line ${raw.line}: description`,300),amountCents:amountCents(amount,raw.line)};
}
function input(req,db) {
  const body=req.body || {};
  const accountId=id(body.accountId,'accountId');account(db,req.company.id,accountId);
  const sourceName=printable(body.sourceName,'sourceName');
  const rows=parseCsv(body.csv).map(row=>{try{return normalize(row);}catch(error){return {line:row.line,status:'invalid',detail:error.message};}});
  const fileSha256=createHash('sha256').update(body.csv,'utf8').digest('hex');
  const payloadSha256=createHash('sha256').update(JSON.stringify([req.company.id,accountId,sourceName,fileSha256])).digest('hex');
  return {accountId,sourceName,rows,fileSha256,payloadSha256};
}
function preview(db,companyId,data) {
  const seen=new Map();
  const rows=data.rows.map(row=>{
    if (row.status==='invalid') return row;
    const prior=seen.get(row.reference);
    if (prior) {
      const same=prior.transactionDate===row.transactionDate && prior.description===row.description && prior.amountCents===row.amountCents;
      return {...row,status:same?'repeat':'conflict',detail:'Duplicate reference within this CSV'};
    }
    seen.set(row.reference,row);
    const existing=db.prepare('SELECT * FROM bank_statement_lines WHERE company_id=? AND account_id=? AND reference=?').get(companyId,data.accountId,row.reference);
    if (!existing) return {...row,status:'new',detail:'Ready to import'};
    const same=existing.transaction_date===row.transactionDate && existing.description===row.description && existing.amount_cents===row.amountCents;
    return {...row,status:same?'repeat':'conflict',detail:same?'Exact repeat of an imported bank line':'Existing bank reference has changed data',lineId:existing.id};
  });
  const counts=Object.fromEntries(['new','repeat','conflict','invalid'].map(status=>[`${status}Count`,rows.filter(row=>row.status===status).length]));
  return {sha256:data.payloadSha256,fileSha256:data.fileSha256,rowCount:rows.length,...counts,canCommit:counts.conflictCount===0 && counts.invalidCount===0,rows,localStatementOnly:true};
}
function lineDetail(db,lineId,companyId) {
  const row=db.prepare(`SELECT l.*,a.name AS account_name,p.reference AS payment_reference,p.method AS payment_method,v.number AS invoice_number,v.type AS invoice_type
    FROM bank_statement_lines l JOIN bank_accounts a ON a.id=l.account_id
    LEFT JOIN invoice_payments p ON p.id=l.payment_id LEFT JOIN invoices v ON v.id=p.invoice_id
    WHERE l.id=? AND l.company_id=?`).get(lineId,companyId);
  if (!row) throw bad('Bank line not found in selected company',404);
  return camel(row);
}
function registerBankRoutes(app,db) {
  installBankSchema(db);
  const secureRoute = handler => route(req => {
    assertCompanyWideAccess(db,{companyId:req.company.id,userId:req.user.id});
    return handler(req);
  });
  app.get('/api/bank/accounts',secureRoute(req=>({accounts:db.prepare('SELECT * FROM bank_accounts WHERE company_id=? ORDER BY name').all(req.company.id).map(camel),localStatementOnly:true})));
  app.post('/api/bank/accounts',secureRoute(req=>{
    reviewer(req);const body=req.body || {};
    const name=printable(body.name,'name',80),maskedAccount=printable(body.maskedAccount,'maskedAccount',40);
    if (db.prepare('SELECT 1 FROM bank_accounts WHERE company_id=? AND name=?').get(req.company.id,name)) throw bad('Bank account name already exists in selected company',409);
    const result=db.prepare('INSERT INTO bank_accounts(company_id,name,masked_account,created_by) VALUES (?,?,?,?)').run(req.company.id,name,maskedAccount,req.user.id);
    return {account:camel(account(db,req.company.id,Number(result.lastInsertRowid))),localStatementOnly:true};
  }));
  app.get('/api/bank/statements',secureRoute(req=>{
    const accountId=id(req.query.accountId,'accountId');account(db,req.company.id,accountId);
    return {imports:db.prepare('SELECT * FROM bank_statement_imports WHERE company_id=? AND account_id=? ORDER BY id DESC LIMIT 100').all(req.company.id,accountId).map(camel),localStatementOnly:true};
  }));
  app.post('/api/bank/statements/preview',secureRoute(req=>({preview:preview(db,req.company.id,input(req,db))})));
  app.post('/api/bank/statements/commit',secureRoute(req=>{
    reviewer(req);const data=input(req,db);
    if (typeof req.body.expectedSha256!=='string' || req.body.expectedSha256!==data.payloadSha256) throw bad('Preview changed; preview this exact file, source and account again',409);
    return transaction(db,()=>{
      const prior=db.prepare('SELECT * FROM bank_statement_imports WHERE company_id=? AND account_id=? AND payload_sha256=?').get(req.company.id,data.accountId,data.payloadSha256);
      if (prior) return {import:camel(prior),inserted:0,skipped:prior.row_count,replayed:true,localStatementOnly:true};
      const checked=preview(db,req.company.id,data);
      if (!checked.canCommit) throw bad('Resolve invalid or conflicting bank lines before committing',409);
      const result=db.prepare('INSERT INTO bank_statement_imports(company_id,account_id,source_name,file_sha256,payload_sha256,row_count,inserted_count,skipped_count,imported_by) VALUES (?,?,?,?,?,?,?,?,?)').run(req.company.id,data.accountId,data.sourceName,data.fileSha256,data.payloadSha256,checked.rowCount,checked.newCount,checked.repeatCount,req.user.id);
      const importId=Number(result.lastInsertRowid);
      for (const row of checked.rows) {
        let lineId=row.lineId;
        if (row.status==='new') lineId=Number(db.prepare('INSERT INTO bank_statement_lines(company_id,account_id,import_id,line_number,transaction_date,reference,description,amount_cents) VALUES (?,?,?,?,?,?,?,?)').run(req.company.id,data.accountId,importId,row.line,row.transactionDate,row.reference,row.description,row.amountCents).lastInsertRowid);
        else if (!lineId) lineId=db.prepare('SELECT id FROM bank_statement_lines WHERE company_id=? AND account_id=? AND reference=?').get(req.company.id,data.accountId,row.reference)?.id;
        if (!lineId) throw bad('Repeated bank line has no committed source row',409);
        db.prepare('INSERT INTO bank_statement_import_rows(import_id,line_number,statement_line_id,action) VALUES (?,?,?,?)').run(importId,row.line,lineId,row.status==='new'?'inserted':'repeat');
      }
      return {import:camel(db.prepare('SELECT * FROM bank_statement_imports WHERE id=?').get(importId)),inserted:checked.newCount,skipped:checked.repeatCount,replayed:false,localStatementOnly:true};
    });
  }));
  app.get('/api/bank/lines',secureRoute(req=>{
    const accountId=id(req.query.accountId,'accountId');account(db,req.company.id,accountId);
    const lines=db.prepare(`SELECT l.*,p.reference AS payment_reference,p.method AS payment_method,v.number AS invoice_number,v.type AS invoice_type
      FROM bank_statement_lines l LEFT JOIN invoice_payments p ON p.id=l.payment_id LEFT JOIN invoices v ON v.id=p.invoice_id
      WHERE l.company_id=? AND l.account_id=? ORDER BY l.transaction_date DESC,l.id DESC LIMIT 1000`).all(req.company.id,accountId).map(camel);
    const aggregate=db.prepare(`SELECT COUNT(*) AS line_count,
      COALESCE(SUM(CASE WHEN status='pending' THEN 1 ELSE 0 END),0) AS pending_count,
      COALESCE(SUM(CASE WHEN status='matched' THEN 1 ELSE 0 END),0) AS matched_count,
      COALESCE(SUM(CASE WHEN status='explained' THEN 1 ELSE 0 END),0) AS explained_count,
      COALESCE(SUM(CASE WHEN amount_cents>0 THEN amount_cents ELSE 0 END),0) AS total_credits_cents,
      COALESCE(SUM(CASE WHEN amount_cents<0 THEN -amount_cents ELSE 0 END),0) AS total_debits_cents
      FROM bank_statement_lines WHERE company_id=? AND account_id=?`).get(req.company.id,accountId);
    return {lines,summary:camel(aggregate),hasMore:aggregate.line_count>lines.length,localStatementOnly:true};
  }));
  app.get('/api/bank/lines/:id',secureRoute(req=>{
    const lineId=id(req.params.id,'line id');
    return {line:lineDetail(db,lineId,req.company.id),events:db.prepare('SELECT * FROM bank_review_events WHERE company_id=? AND line_id=? ORDER BY id').all(req.company.id,lineId).map(camel),localStatementOnly:true};
  }));
  app.get('/api/bank/payments',secureRoute(req=>{
    const accountId=id(req.query.accountId,'accountId');account(db,req.company.id,accountId);
    const payments=db.prepare(`SELECT p.*,a.account_id,v.number AS invoice_number,v.type AS invoice_type,v.total_cents AS invoice_total_cents,
      CASE WHEN v.type='sale' THEN p.amount_cents ELSE -p.amount_cents END AS signed_amount_cents
      FROM invoice_payments p JOIN invoices v ON v.id=p.invoice_id AND v.company_id=p.company_id
      JOIN bank_payment_account_assignments a ON a.payment_id=p.id AND a.company_id=p.company_id AND a.account_id=?
      LEFT JOIN bank_statement_lines l ON l.payment_id=p.id
      WHERE p.company_id=? AND p.method IN ('bank','upi') AND l.id IS NULL
      ORDER BY p.payment_date DESC,p.id DESC LIMIT 500`).all(accountId,req.company.id).map(camel);
    return {payments,localStatementOnly:true};
  }));
  app.get('/api/bank/payments/unassigned',secureRoute(req=>{
    const payments=db.prepare(`SELECT p.*,v.number AS invoice_number,v.type AS invoice_type,v.total_cents AS invoice_total_cents,
      CASE WHEN v.type='sale' THEN p.amount_cents ELSE -p.amount_cents END AS signed_amount_cents
      FROM invoice_payments p JOIN invoices v ON v.id=p.invoice_id AND v.company_id=p.company_id
      LEFT JOIN bank_payment_account_assignments a ON a.payment_id=p.id
      WHERE p.company_id=? AND p.method IN ('bank','upi') AND a.payment_id IS NULL
      ORDER BY p.payment_date DESC,p.id DESC LIMIT 500`).all(req.company.id).map(camel);
    return {payments,localStatementOnly:true};
  }));
  app.get('/api/bank/payment-assignments',secureRoute(req=>{
    const accountId=id(req.query.accountId,'accountId');account(db,req.company.id,accountId);
    const assignments=db.prepare(`SELECT a.*,u.name AS assigned_by_name,p.reference AS payment_reference,
      p.payment_date,p.amount_cents,p.method,v.number AS invoice_number,v.type AS invoice_type,
      l.id AS matched_line_id,l.reference AS matched_reference,l.reviewed_at AS matched_at
      FROM bank_payment_account_assignments a
      JOIN users u ON u.id=a.assigned_by AND u.company_id=a.company_id
      JOIN invoice_payments p ON p.id=a.payment_id AND p.company_id=a.company_id
      JOIN invoices v ON v.id=p.invoice_id AND v.company_id=p.company_id
      LEFT JOIN bank_statement_lines l ON l.payment_id=a.payment_id AND l.account_id=a.account_id AND l.company_id=a.company_id
      WHERE a.company_id=? AND a.account_id=? ORDER BY a.assigned_at DESC,a.payment_id DESC LIMIT 500`).all(req.company.id,accountId).map(camel);
    return {assignments,localStatementOnly:true};
  }));
  app.post('/api/bank/payments/:id/account',secureRoute(req=>{
    reviewer(req);
    const paymentId=id(req.params.id,'payment id');
    const body=req.body || {};
    const accountId=id(body.accountId,'accountId');
    account(db,req.company.id,accountId);
    const reason=printable(body.reason,'reason',500);
    return transaction(db,()=>{
      const payment=db.prepare(`SELECT p.*,v.status AS invoice_status FROM invoice_payments p
        JOIN invoices v ON v.id=p.invoice_id AND v.company_id=p.company_id
        WHERE p.id=? AND p.company_id=?`).get(paymentId,req.company.id);
      if (!payment) throw bad('Payment not found in selected company',404);
      if (!['bank','upi'].includes(payment.method) || payment.invoice_status!=='approved') throw bad('Only approved bank or UPI payments can be assigned to a bank account',409);
      if (db.prepare('SELECT 1 FROM bank_payment_account_assignments WHERE payment_id=?').get(paymentId)) throw bad('Payment is already assigned to a bank account',409);
      db.prepare('INSERT INTO bank_payment_account_assignments(payment_id,company_id,account_id,reason,assigned_by) VALUES (?,?,?,?,?)').run(paymentId,req.company.id,accountId,reason,req.user.id);
      return {assignment:camel(db.prepare('SELECT * FROM bank_payment_account_assignments WHERE payment_id=?').get(paymentId)),localStatementOnly:true};
    });
  }));
  app.post('/api/bank/lines/:id/review',secureRoute(req=>{
    reviewer(req);const lineId=id(req.params.id,'line id');const body=req.body || {};
    return transaction(db,()=>{
      const line=db.prepare('SELECT * FROM bank_statement_lines WHERE id=? AND company_id=?').get(lineId,req.company.id);
      if (!line) throw bad('Bank line not found in selected company',404);
      const decision=body.decision;
      if (decision==='match') {
        if (line.status!=='pending') throw bad('Reopen this bank line before changing its review',409);
        const paymentId=id(body.paymentId,'paymentId');
        const payment=db.prepare(`SELECT p.*,v.type AS invoice_type,v.status AS invoice_status FROM invoice_payments p JOIN invoices v ON v.id=p.invoice_id AND v.company_id=p.company_id WHERE p.id=? AND p.company_id=?`).get(paymentId,req.company.id);
        if (!payment) throw bad('Payment not found in selected company',404);
        if (!['bank','upi'].includes(payment.method) || payment.invoice_status!=='approved') throw bad('Only approved bank or UPI payments can be reconciled',409);
        const assignment=db.prepare('SELECT account_id FROM bank_payment_account_assignments WHERE payment_id=? AND company_id=?').get(paymentId,req.company.id);
        if (!assignment || assignment.account_id!==line.account_id) throw bad('Payment must be explicitly assigned to this bank account before matching',409);
        const signed=payment.invoice_type==='sale'?payment.amount_cents:-payment.amount_cents;
        if (signed!==line.amount_cents) throw bad('Bank line amount or direction does not match payment',409);
        if (db.prepare('SELECT 1 FROM bank_statement_lines WHERE payment_id=?').get(paymentId)) throw bad('Payment already reconciled to a bank line',409);
        const reason=body.reason===undefined || body.reason===''?'Reviewed amount, direction and company against payment':printable(body.reason,'reason',500);
        db.prepare("UPDATE bank_statement_lines SET status='matched',payment_id=?,explanation=NULL,reviewed_by=?,reviewed_at=CURRENT_TIMESTAMP WHERE id=?").run(paymentId,req.user.id,lineId);
        db.prepare("INSERT INTO bank_review_events(company_id,line_id,action,payment_id,reason,actor_id) VALUES (?,?,'match',?,?,?)").run(req.company.id,lineId,paymentId,reason,req.user.id);
      } else if (decision==='explain') {
        if (line.status!=='pending') throw bad('Reopen this bank line before changing its review',409);
        const reason=printable(body.reason,'reason',500);
        db.prepare("UPDATE bank_statement_lines SET status='explained',payment_id=NULL,explanation=?,reviewed_by=?,reviewed_at=CURRENT_TIMESTAMP WHERE id=?").run(reason,req.user.id,lineId);
        db.prepare("INSERT INTO bank_review_events(company_id,line_id,action,payment_id,reason,actor_id) VALUES (?,?,'explain',NULL,?,?)").run(req.company.id,lineId,reason,req.user.id);
      } else if (decision==='reopen') {
        if (line.status==='pending') throw bad('Bank line is already pending',409);
        const reason=printable(body.reason,'reason',500);
        db.prepare("UPDATE bank_statement_lines SET status='pending',payment_id=NULL,explanation=NULL,reviewed_by=NULL,reviewed_at=NULL WHERE id=?").run(lineId);
        db.prepare("INSERT INTO bank_review_events(company_id,line_id,action,payment_id,reason,actor_id) VALUES (?,?,'reopen',?,?,?)").run(req.company.id,lineId,line.payment_id,reason,req.user.id);
      } else throw bad('decision must be match, explain or reopen');
      return {line:lineDetail(db,lineId,req.company.id),events:db.prepare('SELECT * FROM bank_review_events WHERE company_id=? AND line_id=? ORDER BY id').all(req.company.id,lineId).map(camel),localStatementOnly:true};
    });
  }));
}

module.exports={installBankSchema,registerBankRoutes,parseCsv};
