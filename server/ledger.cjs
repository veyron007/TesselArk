const { installLedgerSchema, ensureLedgerAccounts } = require('./ledger-db.cjs');
const { allowedScopes, assertBranchAccess, assertCompanyWideAccess } = require('./access.cjs');

const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const camel = row => Object.fromEntries(Object.entries(row).map(([key,value]) => [key.replace(/_([a-z])/g,(_,letter) => letter.toUpperCase()),value]));
const positiveId = (value,label) => {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id < 1) throw fail(`${label} must be a positive integer`);
  return id;
};
const validPeriod = value => {
  if (typeof value !== 'string' || !/^\d{4}-(0[1-9]|1[0-2])$/.test(value)) throw fail('period must be YYYY-MM');
  return value;
};
const validDate = value => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw fail('asOf must be YYYY-MM-DD');
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0,10) !== value) throw fail('asOf must be YYYY-MM-DD');
  return value;
};
const monthEnd = period => new Date(Date.UTC(Number(period.slice(0,4)),Number(period.slice(5,7)),0)).toISOString().slice(0,10);
const checkedCents = (value,label,allowZero = true) => {
  if (!Number.isSafeInteger(value) || value < 0 || (!allowZero && value === 0)) throw fail(`${label} must be nonnegative integer paise`,409);
  return value;
};

function accountId(db,companyId,code) {
  const account = db.prepare('SELECT id FROM ledger_accounts WHERE company_id=? AND code=?').get(companyId,code);
  if (!account) throw fail(`Ledger account ${code} is missing`,409);
  return account.id;
}

function journalDetail(db,id,companyId) {
  const row = db.prepare(`SELECT j.*,p.name AS current_party_name FROM journals j LEFT JOIN parties p ON p.id=j.party_id WHERE j.id=? AND j.company_id=?`).get(id,companyId);
  if (!row) throw fail('Journal not found in selected company',404);
  const lines = db.prepare(`SELECT l.id,a.code AS account_code,a.name AS account_name,l.debit_cents,l.credit_cents
    FROM journal_lines l JOIN ledger_accounts a ON a.id=l.account_id
    WHERE l.journal_id=? ORDER BY l.id`).all(id).map(camel);
  const debit = lines.reduce((total,line) => total+line.debitCents,0);
  const credit = lines.reduce((total,line) => total+line.creditCents,0);
  const { current_party_name: currentPartyName, ...journal } = row;
  return { ...camel(journal),partyName:row.party_name_snapshot || currentPartyName || null,lines,totalDebitCents:debit,totalCreditCents:credit };
}

function writeJournal(db,source,lines) {
  const existing = db.prepare('SELECT id FROM journals WHERE company_id=? AND source_type=? AND source_id=?')
    .get(source.companyId,source.sourceType,source.sourceId);
  if (existing) return journalDetail(db,existing.id,source.companyId);
  const debit = lines.reduce((sum,line)=>sum+line.debitCents,0);
  const credit = lines.reduce((sum,line)=>sum+line.creditCents,0);
  if (!Number.isSafeInteger(debit) || debit !== credit || (debit === 0 && source.sourceType !== 'invoice')) throw fail('Journal must balance in integer paise',409);
  for (const line of lines) {
    checkedCents(line.debitCents,'debitCents');
    checkedCents(line.creditCents,'creditCents');
    if (line.debitCents === line.creditCents) throw fail('Each line must have one nonzero side',409);
  }
  ensureLedgerAccounts(db,source.companyId);
  const result = db.prepare(`INSERT INTO journals(company_id,gstin_id,branch_id,party_id,party_name_snapshot,source_type,source_id,document_number,journal_date,description)
    VALUES (?,?,?,?,?,?,?,?,?,?)`).run(source.companyId,source.gstinId,source.branchId,source.partyId,source.partyName,source.sourceType,source.sourceId,source.documentNumber,source.journalDate,source.description);
  const insert = db.prepare('INSERT INTO journal_lines(journal_id,account_id,debit_cents,credit_cents) VALUES (?,?,?,?)');
  for (const line of lines) insert.run(result.lastInsertRowid,accountId(db,source.companyId,line.code),line.debitCents,line.creditCents);
  return journalDetail(db,Number(result.lastInsertRowid),source.companyId);
}

function postInvoice(db,invoiceId) {
  const invoice = db.prepare('SELECT * FROM invoices WHERE id=?').get(positiveId(invoiceId,'invoiceId'));
  if (!invoice) throw fail('Invoice not found',404);
  if (invoice.status !== 'approved') throw fail('Only approved invoices post to the ledger',409);
  const subtotal = checkedCents(invoice.subtotal_cents,'subtotalCents');
  const tax = checkedCents(invoice.tax_cents,'taxCents');
  const total = checkedCents(invoice.total_cents,'totalCents');
  if (subtotal + tax !== total) throw fail('Invoice totals do not reconcile',409);
  const sale = invoice.type === 'sale';
  if (!sale && invoice.type !== 'purchase') throw fail('Unsupported invoice type',409);
  const lines = sale
    ? [{code:'1200',debitCents:total,creditCents:0},{code:'4000',debitCents:0,creditCents:subtotal},{code:'2200',debitCents:0,creditCents:tax}]
    : [{code:'5000',debitCents:subtotal,creditCents:0},{code:'1300',debitCents:tax,creditCents:0},{code:'2100',debitCents:0,creditCents:total}];
  return writeJournal(db,{
    companyId:invoice.company_id,gstinId:invoice.gstin_id,branchId:invoice.branch_id,partyId:invoice.party_id,
    partyName:invoice.party_name_snapshot || db.prepare('SELECT name FROM parties WHERE id=?').get(invoice.party_id)?.name || '',
    sourceType:'invoice',sourceId:invoice.id,documentNumber:invoice.number,journalDate:invoice.invoice_date,
    description:`Approved ${sale ? 'sales' : 'purchase'} invoice ${invoice.number}`,
  },lines.filter(line => line.debitCents || line.creditCents));
}

function postPayment(db,paymentId) {
  const payment = db.prepare('SELECT * FROM invoice_payments WHERE id=?').get(positiveId(paymentId,'paymentId'));
  if (!payment) throw fail('Payment not found',404);
  const invoice = db.prepare('SELECT * FROM invoices WHERE id=? AND company_id=?').get(payment.invoice_id,payment.company_id);
  if (!invoice || invoice.status !== 'approved') throw fail('Payment requires an approved invoice in the same company',409);
  postInvoice(db,invoice.id);
  const amount = checkedCents(payment.amount_cents,'amountCents',false);
  const sale = invoice.type === 'sale';
  const cashCode = payment.method === 'cash' ? '1000' : ['bank','upi'].includes(payment.method) ? '1100' : sale ? '1150' : '2300';
  const lines = sale
    ? [{code:cashCode,debitCents:amount,creditCents:0},{code:'1200',debitCents:0,creditCents:amount}]
    : [{code:'2100',debitCents:amount,creditCents:0},{code:cashCode,debitCents:0,creditCents:amount}];
  return writeJournal(db,{
    companyId:invoice.company_id,gstinId:invoice.gstin_id,branchId:invoice.branch_id,partyId:invoice.party_id,
    partyName:invoice.party_name_snapshot || db.prepare('SELECT name FROM parties WHERE id=?').get(invoice.party_id)?.name || '',
    sourceType:'payment',sourceId:payment.id,documentNumber:payment.reference,journalDate:payment.payment_date,
    description:`${sale ? 'Customer collection' : 'Supplier payment'} against ${invoice.number}`,
  },lines);
}

function syncLedgerSources(db) {
  installLedgerSchema(db);
  let invoices = 0, payments = 0;
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const row of db.prepare("SELECT id FROM invoices WHERE status='approved' ORDER BY id").all()) {
      if (!db.prepare("SELECT 1 FROM journals WHERE source_type='invoice' AND source_id=?").get(row.id)) { postInvoice(db,row.id); invoices++; }
    }
    for (const row of db.prepare('SELECT id FROM invoice_payments ORDER BY id').all()) {
      if (!db.prepare("SELECT 1 FROM journals WHERE source_type='payment' AND source_id=?").get(row.id)) { postPayment(db,row.id); payments++; }
    }
    db.exec('COMMIT');
    return { invoices, payments };
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}

function trialBalance(db,companyId,asOf = new Date().toISOString().slice(0,10)) {
  validDate(asOf);
  ensureLedgerAccounts(db,companyId);
  const rows = db.prepare(`SELECT a.id AS account_id,a.company_id,a.code,a.name,a.kind,a.normal_side,
    COALESCE(SUM(CASE WHEN j.journal_date<=? THEN l.debit_cents ELSE 0 END),0) AS debit_cents,
    COALESCE(SUM(CASE WHEN j.journal_date<=? THEN l.credit_cents ELSE 0 END),0) AS credit_cents
    FROM ledger_accounts a LEFT JOIN journal_lines l ON l.account_id=a.id
    LEFT JOIN journals j ON j.id=l.journal_id AND j.company_id=a.company_id
    WHERE a.company_id=? GROUP BY a.id ORDER BY a.code`).all(asOf,asOf,companyId).map(row => ({
      ...camel(row),balanceDebitCents:Math.max(0,row.debit_cents-row.credit_cents),
      balanceCreditCents:Math.max(0,row.credit_cents-row.debit_cents),
    }));
  return { asOf,rows,totalDebitCents:rows.reduce((sum,row)=>sum+row.debitCents,0),totalCreditCents:rows.reduce((sum,row)=>sum+row.creditCents,0) };
}

function ledgerReports(db,companyId,period) {
  validPeriod(period);
  const asOf = monthEnd(period);
  const trial = trialBalance(db,companyId,asOf);
  const periodRows = db.prepare(`SELECT a.kind,a.code,COALESCE(SUM(l.credit_cents-l.debit_cents),0) AS net_cents
    FROM ledger_accounts a JOIN journal_lines l ON l.account_id=a.id JOIN journals j ON j.id=l.journal_id
    WHERE a.company_id=? AND j.company_id=? AND j.journal_date BETWEEN ? AND ?
    GROUP BY a.id`).all(companyId,companyId,`${period}-01`,asOf);
  const revenue = periodRows.filter(row=>row.kind==='revenue').reduce((sum,row)=>sum+row.net_cents,0);
  const purchases = -periodRows.filter(row=>row.kind==='expense').reduce((sum,row)=>sum+row.net_cents,0);
  const assets = trial.rows.filter(row=>row.kind==='asset').reduce((sum,row)=>sum+row.debitCents-row.creditCents,0);
  const liabilities = trial.rows.filter(row=>row.kind==='liability').reduce((sum,row)=>sum+row.creditCents-row.debitCents,0);
  const cumulativeRevenue = trial.rows.filter(row=>row.kind==='revenue').reduce((sum,row)=>sum+row.creditCents-row.debitCents,0);
  const cumulativePurchases = trial.rows.filter(row=>row.kind==='expense').reduce((sum,row)=>sum+row.debitCents-row.creditCents,0);
  const currentEarnings = cumulativeRevenue-cumulativePurchases;
  return {
    period,
    incomeStatement:{revenueCents:revenue,purchasesCents:purchases,netResultCents:revenue-purchases},
    balanceSheet:{assetsCents:assets,liabilitiesCents:liabilities,currentEarningsCents:currentEarnings,balanced:assets===liabilities+currentEarnings},
    limitations:[
      'Approved return proposals and return tax adjustments are excluded from posted accounts.',
      'Purchases use a periodic expense account; inventory cost valuation and item margin are not available.',
      'Opening balances, manual corrections, depreciation, and period close are not yet supported.',
      'Recorded bank and cash payment methods are not bank reconciliations or provider confirmations.',
      'Purchase GST control is recorded tax, not a confirmed eligible ITC claim.',
    ],
  };
}

function partyLedger(db,companyId,partyId) {
  const party = db.prepare('SELECT * FROM parties WHERE id=? AND company_id=?').get(partyId,companyId);
  if (!party) throw fail('Party not found in selected company',404);
  const entries = db.prepare(`SELECT j.id AS journal_id,j.journal_date,j.document_number,j.source_type,j.source_id,
    a.code AS account_code,l.debit_cents,l.credit_cents
    FROM journals j JOIN journal_lines l ON l.journal_id=j.id JOIN ledger_accounts a ON a.id=l.account_id
    WHERE j.company_id=? AND j.party_id=? AND a.code IN ('1200','2100')
    ORDER BY j.journal_date,j.id,l.id`).all(companyId,partyId).map(camel);
  const receivable = entries.filter(row=>row.accountCode==='1200').reduce((sum,row)=>sum+row.debitCents-row.creditCents,0);
  const payable = entries.filter(row=>row.accountCode==='2100').reduce((sum,row)=>sum+row.creditCents-row.debitCents,0);
  return {party:camel(party),entries,openingBalanceCents:0,receivableCents:receivable,payableCents:payable,closingBalanceCents:receivable-payable};
}

function registerLedgerRoutes(app,db) {
  const route = handler => (req,res,next) => { try { res.json(handler(req)); } catch (error) { next(error); } };
  app.get('/api/ledger/accounts',route(req => {
    assertCompanyWideAccess(db,{companyId:req.company.id,userId:req.user.id});
    ensureLedgerAccounts(db,req.company.id);
    return { accounts:db.prepare('SELECT * FROM ledger_accounts WHERE company_id=? ORDER BY code').all(req.company.id).map(camel) };
  }));
  app.get('/api/ledger/journals',route(req => {
    const period = req.query.period === undefined ? null : validPeriod(req.query.period);
    const limit = req.query.limit === undefined ? 50 : Number(req.query.limit);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw fail('limit must be 1 to 200');
    const branches = allowedScopes(db,{companyId:req.company.id,userId:req.user.id}).branchIds;
    const rows = db.prepare(`SELECT id FROM journals WHERE company_id=? AND branch_id IN (${branches.map(() => '?').join(',') || 'NULL'}) AND (? IS NULL OR substr(journal_date,1,7)=?) ORDER BY journal_date DESC,id DESC LIMIT ?`)
      .all(req.company.id,...branches,period,period,limit);
    return { journals:rows.map(row=>journalDetail(db,row.id,req.company.id)) };
  }));
  app.get('/api/ledger/journals/:id',route(req => {
    const journal = journalDetail(db,positiveId(req.params.id,'id'),req.company.id);
    assertBranchAccess(db,{companyId:req.company.id,userId:req.user.id,branchId:journal.branchId});
    return {journal};
  }));
  app.get('/api/ledger/trial-balance',route(req => {
    assertCompanyWideAccess(db,{companyId:req.company.id,userId:req.user.id});
    return trialBalance(db,req.company.id,req.query.asOf || new Date().toISOString().slice(0,10));
  }));
  app.get('/api/ledger/reports',route(req => {
    assertCompanyWideAccess(db,{companyId:req.company.id,userId:req.user.id});
    return ledgerReports(db,req.company.id,req.query.period || new Date().toISOString().slice(0,7));
  }));
  app.get('/api/ledger/party/:id',route(req => {
    assertCompanyWideAccess(db,{companyId:req.company.id,userId:req.user.id});
    return partyLedger(db,req.company.id,positiveId(req.params.id,'id'));
  }));
}

module.exports = { installLedgerSchema, syncLedgerSources, postInvoice, postPayment, writeJournal, registerLedgerRoutes, trialBalance, ledgerReports, partyLedger };
