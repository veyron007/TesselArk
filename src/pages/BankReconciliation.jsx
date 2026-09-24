import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import './accounting.css';

const TEMPLATE = 'date,reference,description,amount\n2026-09-24,UTR-12345,Customer transfer,1250.00\n';
const money = cents => new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' }).format((Number(cents) || 0) / 100);
const dateLabel = value => value ? new Date(`${String(value).slice(0, 10)}T00:00:00`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : '—';
const normalizeStatus = value => String(value || 'pending').toLowerCase();

export default function BankReconciliation({ context = {}, refresh }) {
  const [accounts, setAccounts] = useState([]);
  const [accountId, setAccountId] = useState('');
  const [accountForm, setAccountForm] = useState({ name: '', maskedAccount: '' });
  const [showAccountForm, setShowAccountForm] = useState(false);
  const [sourceName, setSourceName] = useState('');
  const [csv, setCsv] = useState('');
  const [preview, setPreview] = useState(null);
  const [lines, setLines] = useState([]);
  const [summary, setSummary] = useState(null);
  const [payments, setPayments] = useState([]);
  const [unassignedPayments, setUnassignedPayments] = useState([]);
  const [assignments, setAssignments] = useState([]);
  const [statements, setStatements] = useState([]);
  const [assignmentPaymentId, setAssignmentPaymentId] = useState('');
  const [assignmentReason, setAssignmentReason] = useState('');
  const [filter, setFilter] = useState('all');
  const [editing, setEditing] = useState(null);
  const [decision, setDecision] = useState('match');
  const [paymentId, setPaymentId] = useState('');
  const [reason, setReason] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const detailVersion = useRef(0);
  const canReview = ['accountant', 'admin'].includes(context.role);
  const company = context.bootstrap?.companies?.find(item => String(item.id) === String(context.companyId));
  const request = useCallback(async (path, options = {}) => {
    const response = await context.apiFetch(path, options);
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
    return data;
  }, [context.apiFetch]);
  const loadAccounts = useCallback(async () => {
    const data = await request('/api/bank/accounts');
    setAccounts(data.accounts || []);
    setAccountId(current => (data.accounts || []).some(item => String(item.id) === String(current)) ? current : String(data.accounts?.[0]?.id || ''));
  }, [request]);
  const loadDetail = useCallback(async () => {
    const version = ++detailVersion.current;
    if (!accountId) { setLines([]); setSummary(null); setPayments([]); setUnassignedPayments([]); setAssignments([]); setStatements([]); setLoading(false); return; }
    setLoading(true); setError('');
    try {
      const params = `?accountId=${encodeURIComponent(accountId)}`;
      const [lineData, paymentData, statementData, unassignedData, assignmentData] = await Promise.all([
        request(`/api/bank/lines${params}`), request(`/api/bank/payments${params}`), request(`/api/bank/statements${params}`), request('/api/bank/payments/unassigned'), request(`/api/bank/payment-assignments${params}`),
      ]);
      if (version !== detailVersion.current) return;
      setLines(lineData.lines || []); setSummary(lineData.summary || null);
      setPayments(paymentData.payments || []); setStatements(statementData.imports || []); setUnassignedPayments(unassignedData.payments || []); setAssignments(assignmentData.assignments || []);
    } catch (cause) { if (version === detailVersion.current) setError(cause.message); }
    finally { if (version === detailVersion.current) setLoading(false); }
  }, [request, accountId]);
  useEffect(() => {
    let active = true;
    ++detailVersion.current;
    setLoading(true); setAccounts([]); setAccountId(''); setLines([]); setSummary(null); setPayments([]); setUnassignedPayments([]); setAssignments([]); setStatements([]); setAssignmentPaymentId(''); setAssignmentReason(''); setError(''); setNotice(''); setPreview(null);
    request('/api/bank/accounts').then(data => {
      if (!active) return;
      setAccounts(data.accounts || []); setAccountId(String(data.accounts?.[0]?.id || ''));
      if (!data.accounts?.length) setLoading(false);
    }).catch(cause => { if (active) { setError(cause.message); setLoading(false); } });
    return () => { active = false; };
  }, [request, context.companyId]);
  useEffect(() => {
    let active = true;
    if (!accountId) return undefined;
    const version = ++detailVersion.current;
    setLoading(true); setError(''); setEditing(null); setPreview(null); setLines([]); setSummary(null); setPayments([]); setUnassignedPayments([]); setAssignments([]); setStatements([]); setAssignmentPaymentId(''); setAssignmentReason('');
    const params = `?accountId=${encodeURIComponent(accountId)}`;
    Promise.all([request(`/api/bank/lines${params}`), request(`/api/bank/payments${params}`), request(`/api/bank/statements${params}`), request('/api/bank/payments/unassigned'), request(`/api/bank/payment-assignments${params}`)])
      .then(([lineData, paymentData, statementData, unassignedData, assignmentData]) => {
        if (!active || version !== detailVersion.current) return;
        setLines(lineData.lines || []); setSummary(lineData.summary || null);
        setPayments(paymentData.payments || []); setStatements(statementData.imports || []); setUnassignedPayments(unassignedData.payments || []); setAssignments(assignmentData.assignments || []);
      }).catch(cause => { if (active && version === detailVersion.current) setError(cause.message); }).finally(() => { if (active && version === detailVersion.current) setLoading(false); });
    return () => { active = false; };
  }, [request, accountId]);
  const selectedAccount = accounts.find(item => String(item.id) === String(accountId));
  const filtered = useMemo(() => lines.filter(line => filter === 'all' || normalizeStatus(line.status) === filter), [lines, filter]);
  const counts = useMemo(() => ({ pending: lines.filter(line => line.status === 'pending').length, matched: lines.filter(line => line.status === 'matched').length, explained: lines.filter(line => line.status === 'explained').length }), [lines]);
  const createAccount = async event => {
    event.preventDefault(); setBusy(true); setError(''); setNotice('');
    try {
      const data = await request('/api/bank/accounts', { method: 'POST', body: JSON.stringify({ name: accountForm.name.trim(), maskedAccount: accountForm.maskedAccount.trim() }) });
      await loadAccounts(); setAccountId(String(data.account?.id || ''));
      setAccountForm({ name: '', maskedAccount: '' }); setShowAccountForm(false);
      setNotice('Local bank account added. No bank connection was established.');
    } catch (cause) { setError(cause.message); }
    finally { setBusy(false); }
  };
  const assignPayment = async event => {
    event.preventDefault();
    if (!accountId || !assignmentPaymentId || !assignmentReason.trim()) return;
    setBusy(true); setError(''); setNotice('');
    try {
      await request(`/api/bank/payments/${encodeURIComponent(assignmentPaymentId)}/account`, {
        method: 'POST', body: JSON.stringify({ accountId: Number(accountId), reason: assignmentReason.trim() }),
      });
      setNotice(`Payment #${assignmentPaymentId} assigned to ${selectedAccount?.name}. The account choice and reason are recorded for audit; matching to a statement line is a separate review.`);
      setAssignmentPaymentId(''); setAssignmentReason('');
      await loadDetail(); refresh?.();
    } catch (cause) { setError(cause.message); }
    finally { setBusy(false); }
  };
  const readFile = async file => {
    if (!file) return;
    if (file.size > 128 * 1024) { setError('Choose a CSV no larger than 128 KB.'); return; }
    try {
      const value = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(await file.arrayBuffer());
      setCsv(value); setSourceName(file.name.slice(0, 120)); setPreview(null); setError('');
    } catch { setError('The file is not valid UTF-8. Export a UTF-8 CSV and try again.'); }
  };
  const sourceBody = () => ({ accountId: Number(accountId), sourceName: sourceName.trim(), csv });
  const inspect = async event => {
    event.preventDefault(); setBusy(true); setError(''); setNotice(''); setPreview(null);
    try { const data = await request('/api/bank/statements/preview', { method: 'POST', body: JSON.stringify(sourceBody()) }); setPreview(data.preview); }
    catch (cause) { setError(cause.message); }
    finally { setBusy(false); }
  };
  const commit = async () => {
    if (!preview?.canCommit) return;
    setBusy(true); setError(''); setNotice('');
    try {
      const data = await request('/api/bank/statements/commit', { method: 'POST', body: JSON.stringify({ ...sourceBody(), expectedSha256: preview.sha256 }) });
      setNotice(data.replayed ? 'This exact statement was already imported.' : `${data.inserted || 0} line${data.inserted === 1 ? '' : 's'} imported; ${data.skipped || 0} repeat${data.skipped === 1 ? '' : 's'} skipped. Each line still needs review.`);
      setPreview(null); await loadDetail(); refresh?.();
    } catch (cause) { setError(cause.message); }
    finally { setBusy(false); }
  };
  const startReview = (line, nextDecision) => {
    setEditing(line.id); setDecision(nextDecision); setPaymentId(''); setReason(''); setError('');
  };
  const review = async event => {
    event.preventDefault();
    if (!editing) return;
    setBusy(true); setError(''); setNotice('');
    try {
      const payload = decision === 'match' ? { decision, paymentId: Number(paymentId), reason: reason.trim() || undefined } : { decision, reason: reason.trim() };
      await request(`/api/bank/lines/${editing}/review`, { method: 'POST', body: JSON.stringify(payload) });
      setNotice(decision === 'match' ? 'Statement line matched to a recorded payment.' : decision === 'explain' ? 'Unmatched line explained and retained for audit.' : 'Review reopened.');
      setEditing(null); await loadDetail(); refresh?.();
    } catch (cause) { setError(cause.message); }
    finally { setBusy(false); }
  };
  const downloadTemplate = () => {
    const url = URL.createObjectURL(new Blob([TEMPLATE], { type: 'text/csv;charset=utf-8' }));
    const link = document.createElement('a'); link.href = url; link.download = 'local-bank-statement-template.csv'; link.click(); URL.revokeObjectURL(url);
  };
  return <section className="acct-page acct-bank" aria-label="Local bank reconciliation">
    <header className="acct-head"><div><span className="acct-kicker">FINANCE / LOCAL BANK STATEMENTS</span><h1>Bank reconciliation</h1><p>Trace imported statement lines to recorded payments or an approved explanation.</p></div><span className="acct-scope">{company?.name || 'Selected company'} · local CSV</span></header>
    <div className="acct-note"><strong>Local evidence only.</strong> A CSV import does not connect to a bank or verify settlement with a provider. A recorded payment and a matched statement line remain separate audit events. Cheques and connected banking are outside this workflow.</div>
    {error && <div className="acct-message error" role="alert">{error}<button type="button" onClick={() => setError('')}>Dismiss</button></div>}
    {notice && <div className="acct-message success" role="status">{notice}<button type="button" onClick={() => setNotice('')}>Dismiss</button></div>}
    <div className="acct-toolbar"><div className="acct-filters"><label>Local bank account<select value={accountId} onChange={event => setAccountId(event.target.value)} aria-label="Local bank account"><option value="">Choose account</option>{accounts.map(item => <option key={item.id} value={item.id}>{item.name} · {item.maskedAccount}</option>)}</select></label><button type="button" className="acct-secondary" onClick={() => setShowAccountForm(value => !value)}>{showAccountForm ? 'Cancel' : 'Add account'}</button></div><button type="button" className="acct-secondary" onClick={loadDetail} disabled={loading || !accountId}>Refresh</button></div>
    {showAccountForm && <form className="acct-card acct-bank-form" onSubmit={createAccount}><div className="acct-card-head"><h2>Add a local account</h2></div><label>Account label<input required maxLength={80} value={accountForm.name} onChange={event => setAccountForm({ ...accountForm, name: event.target.value })} placeholder="Operating account" /></label><label>Masked account number<input required maxLength={40} value={accountForm.maskedAccount} onChange={event => setAccountForm({ ...accountForm, maskedAccount: event.target.value })} placeholder="•••• 0042" /></label><button type="submit" className="acct-primary" disabled={busy || !canReview}>Save local account</button>{!canReview && <p className="acct-hint">Switch to accountant or admin demo role to add an account.</p>}</form>}
    {!accountId ? <div className="acct-card"><p className="acct-empty">Add a local bank account to import a statement and begin reconciliation.</p></div> : <>
      <div className="acct-metrics"><div><span>STATEMENT LINES</span><strong>{loading ? '—' : summary?.lineCount ?? lines.length}</strong><small>{selectedAccount?.maskedAccount}</small></div><div><span>PENDING REVIEW</span><strong>{loading ? '—' : summary?.pendingCount ?? counts.pending ?? 0}</strong><small>Need a match or explanation</small></div><div><span>REVIEWED</span><strong>{loading ? '—' : (summary?.matchedCount ?? counts.matched ?? 0) + (summary?.explainedCount ?? counts.explained ?? 0)}</strong><small>Matches and explanations are distinct</small></div></div>
      <div className="acct-card acct-bank-attribution"><div className="acct-card-head"><div><h2>Payment account attribution</h2><p>Assign a recorded bank or UPI payment to this local account before matching it to a statement line.</p></div><span className="acct-pill">{payments.length} eligible here · {unassignedPayments.length} unassigned</span></div>
        {loading ? <p className="acct-empty" role="status">Loading payment candidates…</p> : unassignedPayments.length === 0 ? <p className="acct-empty">No unassigned bank or UPI payments in this company. Payments assigned to {selectedAccount?.name} are available in the line matching choices below.</p> : <form className="acct-bank-assignment" onSubmit={assignPayment}><label>Unassigned recorded payment<select aria-label="Unassigned recorded payment" required value={assignmentPaymentId} onChange={event => setAssignmentPaymentId(event.target.value)}><option value="">Choose a payment</option>{unassignedPayments.map(payment => <option key={payment.id} value={payment.id}>{dateLabel(payment.paymentDate)} · {payment.reference} · {money(payment.signedAmountCents)} · {payment.invoiceNumber || `Payment #${payment.id}`}</option>)}</select></label><label>Account attribution reason<input required maxLength={500} value={assignmentReason} onChange={event => setAssignmentReason(event.target.value)} placeholder="Statement account and payment reference reviewed" /></label><div className="acct-bank-assignment-action"><p>Assignment is audited and cannot be silently changed. Matching still needs a separate line review.</p><button type="submit" className="acct-primary" disabled={!canReview || busy || !assignmentPaymentId || !assignmentReason.trim()}>{busy ? 'Assigning…' : `Assign to ${selectedAccount?.name}`}</button></div>{!canReview && <p className="acct-hint">Switch to accountant or admin demo role to assign a payment.</p>}</form>}
        <div className="acct-assignment-history"><div className="acct-assignment-title"><h3>Account assignment audit</h3><span>{assignments.length} assigned</span></div>{assignments.length === 0 ? <p>No recorded payment has been assigned to this account yet.</p> : <div className="acct-assignment-list">{assignments.map(item => <article key={item.paymentId}><div><strong>{item.invoiceNumber || `Payment #${item.paymentId}`}</strong><small>{item.paymentReference} · {dateLabel(item.paymentDate)} · {item.method?.toUpperCase()} · {money(item.invoiceType === 'purchase' ? -item.amountCents : item.amountCents)}</small><small>Assigned by {item.assignedByName || `user #${item.assignedBy}`} · {item.reason}</small></div><span className={`acct-pill ${item.matchedLineId ? 'good' : ''}`}>{item.matchedLineId ? `Matched · ${item.matchedReference || `line #${item.matchedLineId}`}` : 'Awaiting statement match'}</span></article>)}</div>}</div>
      </div>
      <div className="acct-bank-layout"><div className="acct-card"><div className="acct-card-head"><div><h2>Import statement</h2><p>Preview before writing any rows.</p></div><button type="button" className="acct-link" onClick={downloadTemplate}>CSV template</button></div><form className="acct-bank-form" onSubmit={inspect}><label>Source name<input required maxLength={120} value={sourceName} onChange={event => { setSourceName(event.target.value); setPreview(null); }} placeholder="September operating statement.csv" /></label><label className="acct-file">Choose CSV<input type="file" accept=".csv,text/csv" onChange={event => readFile(event.target.files?.[0])} /></label><label>Or paste CSV<textarea value={csv} onChange={event => { setCsv(event.target.value); setPreview(null); }} rows={6} spellCheck="false" placeholder={TEMPLATE} required /></label><p className="acct-hint">Columns: date, reference, description, amount. Positive rupees are credits; negative rupees are debits. Maximum 128 KB.</p><button type="submit" className="acct-primary" disabled={busy || !csv.trim()}>Preview and validate</button></form></div><div className="acct-card"><div className="acct-card-head"><div><h2>Import preview</h2><p>Duplicates and invalid lines stay visible before commit.</p></div>{preview && <span className="acct-pill">{preview.rowCount} rows</span>}</div>{!preview ? <p className="acct-empty">Choose or paste a statement to inspect every row before importing it.</p> : <><div className="acct-bank-stats"><span><b>{preview.newCount}</b> new</span><span><b>{preview.repeatCount}</b> repeats</span><span><b>{preview.conflictCount}</b> conflicts</span><span><b>{preview.invalidCount}</b> invalid</span></div><div className="acct-bank-preview">{(preview.rows || []).map((row, index) => <article key={`${row.line || index}-${row.reference || ''}`}><span className={row.status}>{row.status}</span><div><strong>{row.reference || `Line ${row.line || index + 1}`}</strong><small>{row.description || row.detail}</small></div><div>{row.amountCents === undefined ? '—' : money(row.amountCents)}<small>{row.transactionDate || ''}</small></div></article>)}</div><div className="acct-bank-actions"><p>{preview.canCommit ? 'Validated for local import.' : 'Correct invalid or conflicting rows, then preview again.'}</p><button type="button" className="acct-primary" onClick={commit} disabled={!preview.canCommit || !canReview || busy}>Commit statement</button></div>{!canReview && <p className="acct-hint" style={{ padding: '0 17px 14px' }}>Accountant or admin demo role required to commit.</p>}</>}</div></div>
      <div className="acct-card"><div className="acct-card-head"><div><h2>Reconciliation queue</h2><p>{selectedAccount?.name} · each line needs a match or a reviewed explanation.</p></div><span className="acct-pill">{statements.length} imports</span></div><div className="acct-bank-filter" aria-label="Statement line filter">{[['all', 'All'], ['pending', 'Pending'], ['matched', 'Matched'], ['explained', 'Explained']].map(([key, label]) => <button type="button" key={key} className={filter === key ? 'active' : ''} onClick={() => setFilter(key)}>{label}</button>)}</div>{loading ? <p className="acct-empty" role="status">Loading statement lines…</p> : filtered.length === 0 ? <p className="acct-empty">{lines.length ? 'No statement lines match this filter.' : 'No local statement lines imported for this account yet.'}</p> : <div className="acct-bank-lines">{filtered.map(line => <article className="acct-bank-line" key={line.id}><div className="acct-bank-line-top"><div><strong>{line.description || line.reference}</strong><small>{dateLabel(line.transactionDate)} · {line.reference}</small></div><b>{money(line.amountCents)}</b></div><div className="acct-bank-line-bottom"><span className={`acct-pill ${normalizeStatus(line.status) === 'matched' || normalizeStatus(line.status) === 'explained' ? 'good' : 'warn'}`}>{line.status || 'pending'}</span><span>{line.paymentId ? `Matched to payment #${line.paymentId} · ${line.paymentReference || ''}` : line.explanation ? `Reviewed explanation: ${line.explanation}` : 'Awaiting review'}</span></div>{canReview && <div className="acct-bank-line-actions">{normalizeStatus(line.status) === 'pending' ? <><button type="button" onClick={() => startReview(line, 'match')}>Match payment</button><button type="button" onClick={() => startReview(line, 'explain')}>Explain line</button></> : <button type="button" onClick={() => startReview(line, 'reopen')}>Reopen review</button>}</div>}{editing === line.id && <form className="acct-bank-review" onSubmit={review}>{decision === 'match' ? <label>Recorded payment<select aria-label="Recorded payment" required value={paymentId} onChange={event => setPaymentId(event.target.value)}><option value="">Choose same amount and direction</option>{payments.filter(payment => payment.signedAmountCents === line.amountCents).map(payment => <option key={payment.id} value={payment.id}>{dateLabel(payment.paymentDate)} · {payment.reference} · {money(payment.signedAmountCents)} · {payment.invoiceNumber || `Payment #${payment.id}`}</option>)}</select></label> : <label>Reason<input required maxLength={500} value={reason} onChange={event => setReason(event.target.value)} placeholder={decision === 'explain' ? 'Why this line has no payment allocation' : 'Reason for reopening'} /></label>}<div className="acct-bank-review-actions"><button type="submit" className="acct-primary" disabled={busy || (decision === 'match' && !paymentId) || (decision !== 'match' && !reason.trim())}>{busy ? 'Saving…' : decision === 'match' ? 'Confirm match' : decision === 'explain' ? 'Save explanation' : 'Reopen line'}</button><button type="button" className="acct-secondary" onClick={() => setEditing(null)}>Cancel</button></div></form>}</article>)}</div>}</div>
    </>}
  </section>;
}
