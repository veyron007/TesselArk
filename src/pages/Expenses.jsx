import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import './expenses.css';

const money = value => new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' }).format(Number(value || 0) / 100);
const date = value => value ? new Date(String(value).replace(' ', 'T')).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : '—';
const label = value => String(value || '').replace(/_/g, ' ').replace(/^./, letter => letter.toUpperCase());
const today = () => { const now = new Date(); return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`; };
const amountInCents = value => {
  const text = String(value).trim();
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,2})?$/.test(text)) return null;
  const [whole, fraction = ''] = text.split('.');
  const amount = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  return Number.isSafeInteger(amount) ? amount : null;
};
const initialDraft = { invoiceId: '', claimantUserId: '', paidBy: 'employee', purpose: '', costCentre: '', evidenceDocumentId: '', evidenceVersion: '', proofReference: '' };
const initialPayment = { amount: '', method: 'bank', reference: '', paymentDate: today() };

export default function Expenses({ context = {}, refresh, onNavigate }) {
  const { companyId, gstinId, branchId, userId, role, bootstrap, apiFetch } = context;
  const [claims, setClaims] = useState([]);
  const [invoices, setInvoices] = useState([]);
  const [documents, setDocuments] = useState([]);
  const [centres, setCentres] = useState([]);
  const [claimants, setClaimants] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [detail, setDetail] = useState(null);
  const [documentDetail, setDocumentDetail] = useState(null);
  const [invoicePayments, setInvoicePayments] = useState(null);
  const [view, setView] = useState('claims');
  const [filter, setFilter] = useState('all');
  const [draft, setDraft] = useState(initialDraft);
  const [payment, setPayment] = useState(initialPayment);
  const [reviewReason, setReviewReason] = useState('');
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const scopeVersion = useRef(0);
  const detailVersion = useRef(0);
  const company = bootstrap?.companies?.find(row => String(row.id) === String(companyId));
  const users = (bootstrap?.users || []).filter(row => !row.companyId || String(row.companyId) === String(companyId));
  const userName = id => [...claimants, ...users].find(row => Number(row.id) === Number(id))?.name || `User #${id}`;
  const canReview = ['accountant', 'admin'].includes(role);
  const canReimburse = canReview;
  const scope = useMemo(() => new URLSearchParams({ gstinId: String(gstinId), branchId: String(branchId) }).toString(), [gstinId, branchId]);
  const request = useCallback(async (path, init = {}) => {
    const response = await apiFetch(path, init);
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || data.message || `Request failed (${response.status})`);
    return data;
  }, [apiFetch]);

  const reloadClaims = useCallback(async () => {
    const data = await request(`/api/expenses?${scope}`);
    setClaims(data.claims || []);
  }, [request, scope]);

  useEffect(() => {
    const version = ++scopeVersion.current;
    setClaims([]); setInvoices([]); setDocuments([]); setCentres([]); setClaimants([]); setSelectedId(null); setDetail(null);
    setDocumentDetail(null); setInvoicePayments(null); setDraft({ ...initialDraft, claimantUserId: role === 'staff' ? String(userId) : '' }); setView('claims');
    setError(''); setNotice(''); setLoading(true);
    if (!companyId || !gstinId || !branchId) { setLoading(false); return undefined; }
    Promise.allSettled([
      request(`/api/expenses?${scope}`),
      request(`/api/invoices?${scope}`),
      request(`/api/evidence?${scope}`),
      request(`/api/budgets/overview?${new URLSearchParams({ gstinId: String(gstinId), branchId: String(branchId), period: new Date().toISOString().slice(0, 7) })}`),
      request(`/api/expenses/claimants?${scope}`),
    ]).then(results => {
      if (version !== scopeVersion.current) return;
      if (results[0].status === 'rejected') setError(results[0].reason.message);
      else setClaims(results[0].value.claims || []);
      if (results[1].status === 'fulfilled') setInvoices((results[1].value.invoices || []).filter(row => row.type === 'purchase' && row.status === 'approved'));
      if (results[2].status === 'fulfilled') setDocuments(results[2].value.documents || []);
      if (results[3].status === 'fulfilled') setCentres(results[3].value.centres || []);
      if (results[4].status === 'fulfilled') setClaimants(results[4].value.users || []);
      const missing = results.slice(1).filter(row => row.status === 'rejected');
      if (missing.length && results[0].status === 'fulfilled') setError('Some source choices could not be loaded. Refresh this scope before preparing a claim.');
    }).finally(() => { if (version === scopeVersion.current) setLoading(false); });
    return () => { scopeVersion.current += 1; };
  }, [companyId, gstinId, branchId, scope, request]);

  const loadDetail = useCallback(async id => {
    const version = ++detailVersion.current;
    setDetailLoading(true);
    try {
      const data = await request(`/api/expenses/${id}`);
      if (version === detailVersion.current) setDetail(data.claim);
    } catch (cause) { if (version === detailVersion.current) setError(cause.message); }
    finally { if (version === detailVersion.current) setDetailLoading(false); }
  }, [request]);

  useEffect(() => {
    setDetail(null); setInvoicePayments(null); setReviewReason(''); setPayment(initialPayment);
    if (selectedId) loadDetail(selectedId);
    return () => { detailVersion.current += 1; };
  }, [selectedId, loadDetail]);

  useEffect(() => {
    let active = true;
    setDocumentDetail(null);
    if (!draft.evidenceDocumentId) return undefined;
    request(`/api/evidence/${draft.evidenceDocumentId}`).then(data => {
      if (!active) return;
      setDocumentDetail(data.document);
      const latest = data.document?.versions?.[0];
      setDraft(previous => previous.evidenceDocumentId === draft.evidenceDocumentId ? { ...previous, evidenceVersion: latest ? String(latest.version) : '' } : previous);
    }).catch(cause => { if (active) setError(cause.message); });
    return () => { active = false; };
  }, [draft.evidenceDocumentId, request]);

  useEffect(() => {
    let active = true;
    setInvoicePayments(null);
    if (!detail?.invoiceId || detail.paidBy !== 'company') return undefined;
    request(`/api/finance/payments?invoiceId=${detail.invoiceId}`).then(data => {
      if (active) setInvoicePayments(data);
    }).catch(() => { if (active) setInvoicePayments({ unavailable: true }); });
    return () => { active = false; };
  }, [detail?.invoiceId, detail?.paidBy, request]);

  const selectedInvoice = invoices.find(row => String(row.id) === draft.invoiceId);
  const evidenceChoices = documents.filter(row => row.targetType === 'invoice' && String(row.targetId) === draft.invoiceId && row.status === 'approved');
  const selectedEvidence = documents.find(row => String(row.id) === draft.evidenceDocumentId);
  const visibleClaims = claims.filter(row => filter === 'all' || row.status === filter || (filter === 'employee' && row.paidBy === 'employee') || (filter === 'company' && row.paidBy === 'company'));
  const totalAwaiting = claims.filter(row => row.status === 'submitted').length;
  const totalRemaining = claims.filter(row => row.paidBy === 'employee').reduce((sum, row) => sum + Number(row.reimbursementRemainingCents || 0), 0);
  const paymentCents = amountInCents(payment.amount);
  const remainingCents = Number(detail?.reimbursementRemainingCents || 0);
  const validPayment = paymentCents !== null && paymentCents > 0 && paymentCents <= remainingCents && payment.reference.trim() && /^\d{4}-\d{2}-\d{2}$/.test(payment.paymentDate);

  const run = async (action, success, after) => {
    setBusy(true); setError(''); setNotice('');
    try {
      const data = await action();
      if (data?.claim) { setDetail(data.claim); setSelectedId(data.claim.id); }
      await reloadClaims();
      after?.();
      setNotice(success);
      refresh?.();
    } catch (cause) {
      setError(cause.message);
      if (selectedId) await loadDetail(selectedId);
    } finally { setBusy(false); }
  };

  const create = event => {
    event.preventDefault();
    if (!selectedInvoice || !evidenceChoices.some(row => String(row.id) === draft.evidenceDocumentId) || !draft.evidenceVersion || !draft.claimantUserId || !draft.purpose.trim() || !draft.proofReference.trim()) {
      setError('Choose an approved purchase invoice, its latest approved evidence version, claimant, purpose and payment proof reference.'); return;
    }
    run(() => request('/api/expenses', { method: 'POST', body: JSON.stringify({
      invoiceId: Number(draft.invoiceId), claimantUserId: Number(draft.claimantUserId), paidBy: draft.paidBy,
      purpose: draft.purpose.trim(), costCentre: draft.costCentre.trim() || undefined,
      evidenceDocumentId: Number(draft.evidenceDocumentId), evidenceVersion: Number(draft.evidenceVersion), proofReference: draft.proofReference.trim(),
    }) }), 'Expense claim saved as a draft.', () => { setView('claims'); setDraft({ ...initialDraft, claimantUserId: role === 'staff' ? String(userId) : '' }); });
  };
  const submit = () => detail && (Number(detail.createdBy) === Number(userId) || Number(detail.claimantUserId) === Number(userId)) && run(() => request(`/api/expenses/${detail.id}/submit`, { method: 'POST', body: JSON.stringify({ expectedVersion: detail.version }) }), 'Claim submitted for independent review.');
  const review = decision => {
    if (!detail?.sourceFingerprint) { setError('Refresh the claim to get its current source fingerprint.'); return; }
    if (decision === 'rejected' && !reviewReason.trim()) { setError('Record a reason for rejection.'); return; }
    run(() => request(`/api/expenses/${detail.id}/review`, { method: 'POST', body: JSON.stringify({ expectedVersion: detail.version, sourceFingerprint: detail.sourceFingerprint, decision, reason: reviewReason.trim() || undefined }) }),
      decision === 'approved' ? 'Claim approved in this workspace.' : 'Claim rejected with a recorded reason.', () => setReviewReason(''));
  };
  const reimburse = event => {
    event.preventDefault();
    if (!validPayment) { setError(`Enter a positive amount no greater than ${money(remainingCents)}, with a reference and date.`); return; }
    run(() => request(`/api/expenses/${detail.id}/reimbursements`, { method: 'POST', body: JSON.stringify({ amountCents: paymentCents, method: payment.method, reference: payment.reference.trim(), paymentDate: payment.paymentDate }) }),
      'Reimbursement recorded internally. Bank or UPI settlement has not been verified.', () => setPayment(initialPayment));
  };

  return <section className="expense-page" aria-label="Expenses and reimbursements">
    <header className="expense-hero"><div><span className="expense-kicker">FINANCE / EXPENSES</span><h1>Expenses &amp; reimbursements</h1><p>Link a purchase invoice and versioned evidence to an expense claim. Review employee paid and company paid costs separately.</p></div><button type="button" className="expense-primary" onClick={() => { setView(view === 'create' ? 'claims' : 'create'); setError(''); setNotice(''); }}>{view === 'create' ? 'View claims' : 'New claim'}</button></header>
    <div className="expense-scope" aria-label="Current expense scope"><span><small>Company</small><strong>{company?.name || '—'}</strong></span><span><small>GSTIN</small><strong>{company?.gstins?.find(row => String(row.id) === String(gstinId))?.gstin || '—'}</strong></span><span><small>Branch</small><strong>{company?.branches?.find(row => String(row.id) === String(branchId))?.name || '—'}</strong></span><span><small>Acting as</small><strong>{userName(userId)} · {label(role)}</strong></span></div>
    <p className="expense-boundary">Claims and approvals are internal records. Employee paid approval transfers the approved supplier payable into an employee payable; reimbursement entries reduce that payable. This demo does not send money or verify bank settlement. Company paid supplier payments remain a separate invoice payment trail.</p>
    {error && <div className="expense-message error" role="alert">{error}<button type="button" aria-label="Dismiss error" onClick={() => setError('')}>×</button></div>}
    {notice && <div className="expense-message success" role="status">{notice}<button type="button" aria-label="Dismiss notice" onClick={() => setNotice('')}>×</button></div>}
    {!companyId || !gstinId || !branchId ? <div className="expense-card expense-empty">Select a permitted GSTIN and branch to view expense claims.</div> : loading ? <div className="expense-card expense-empty" role="status">Loading scoped expenses and source records…</div> : <>
      <div className="expense-metrics"><div><small>Claims in branch</small><strong>{claims.length}</strong><span>Across both payment paths</span></div><div><small>Awaiting review</small><strong>{totalAwaiting}</strong><span>Submitted claims</span></div><div><small>Employee reimbursement open</small><strong>{money(totalRemaining)}</strong><span>Approved employee paid claims only</span></div></div>
      {view === 'create' ? <div className="expense-grid"><section className="expense-card"><div className="expense-section-head"><span className="expense-kicker">01 / SOURCE</span><h2>Prepare an expense claim</h2><p>Choose an approved purchase invoice and its latest approved evidence version. The claim does not approve the invoice or tax treatment.</p></div><form className="expense-form" onSubmit={create}>
        <label>Approved purchase invoice<select required value={draft.invoiceId} onChange={event => setDraft(previous => ({ ...previous, invoiceId: event.target.value, evidenceDocumentId: '', evidenceVersion: '' }))}><option value="">Select invoice</option>{invoices.map(row => <option key={row.id} value={row.id}>{row.number} · {row.partyName} · {money(row.totalCents)}</option>)}</select></label>
        {!invoices.length && <p className="expense-help">No approved purchase invoices are visible in this scope. Create and approve one in Operations first.</p>}
        {selectedInvoice && <div className="expense-source"><strong>{selectedInvoice.number}</strong><span>{selectedInvoice.partyName} · {date(selectedInvoice.invoiceDate)} · {money(selectedInvoice.totalCents)}</span><button type="button" className="expense-text" onClick={() => onNavigate?.('operations', selectedInvoice.id)}>Open invoice ↗</button></div>}
        {role === 'staff' && <p className="expense-help">Staff can create claims only for themselves.</p>}
        <div className="expense-form-row"><label>Claimant<select required value={draft.claimantUserId} onChange={event => setDraft(previous => ({ ...previous, claimantUserId: event.target.value }))}><option value="">Select person</option>{claimants.map(row => <option key={row.id} value={row.id}>{row.name} · {label(row.role)}</option>)}</select></label><label>Who paid?<select value={draft.paidBy} onChange={event => setDraft(previous => ({ ...previous, paidBy: event.target.value }))}><option value="employee">Employee paid</option><option value="company">Company paid</option></select></label></div>
        <p className="expense-path-note">{draft.paidBy === 'employee' ? 'Approval allocates the invoice cost to the employee paid path. The approved amount may then be reimbursed in parts.' : 'Approval records a company paid expense claim. Supplier payments remain on the invoice payable trail; this claim has no employee reimbursement.'}</p>
        <label>Business purpose<textarea required maxLength="500" rows="3" value={draft.purpose} onChange={event => setDraft(previous => ({ ...previous, purpose: event.target.value }))} placeholder="What was purchased and why?" /></label>
        <label>Cost centre (optional)<select value={draft.costCentre} onChange={event => setDraft(previous => ({ ...previous, costCentre: event.target.value }))}><option value="">No cost centre</option>{centres.map(row => <option key={row.id} value={row.code}>{row.code} · {row.name}</option>)}</select></label>
        <div className="expense-form-row"><label>Linked approved evidence<select required value={draft.evidenceDocumentId} onChange={event => setDraft(previous => ({ ...previous, evidenceDocumentId: event.target.value, evidenceVersion: '' }))} disabled={!draft.invoiceId}><option value="">Select document</option>{evidenceChoices.map(row => <option key={row.id} value={row.id}>{row.title} · {row.fileName} · v{row.version}</option>)}</select></label><label>Latest approved version<select required value={draft.evidenceVersion} onChange={event => setDraft(previous => ({ ...previous, evidenceVersion: event.target.value }))} disabled={!documentDetail}><option value="">Select version</option>{(documentDetail?.versions || []).filter(row => row.status === 'approved' && row.version === documentDetail?.versions?.[0]?.version).map(row => <option key={row.version} value={row.version}>v{row.version} · {row.fileName} · Approved</option>)}</select></label></div>
        {draft.invoiceId && !evidenceChoices.length && <p className="expense-help">No latest approved evidence is linked to this invoice. Add or review a document in Evidence Library before preparing the claim.</p>}
        {selectedEvidence && <p className="expense-help">{selectedEvidence.title} · latest version {selectedEvidence.version} · {label(selectedEvidence.status)} local evidence review. The claim is tied to the selected file version.</p>}
        <label>Payment proof reference<input required maxLength="100" value={draft.proofReference} onChange={event => setDraft(previous => ({ ...previous, proofReference: event.target.value }))} placeholder="Receipt, card slip, transfer or internal reference" /></label>
        <button className="expense-primary" disabled={busy || !selectedInvoice || !evidenceChoices.length || !draft.evidenceVersion}>{busy ? 'Saving…' : 'Save draft claim'}</button>
      </form></section><aside className="expense-card expense-guide"><span className="expense-kicker">HOW IT MOVES</span><h2>From source to decision</h2><ol><li><strong>1. Prepare</strong><span>Link one approved purchase invoice and one exact evidence version.</span></li><li><strong>2. Submit</strong><span>Freeze the source fingerprint for independent review.</span></li><li><strong>3. Review</strong><span>An accountant or admin approves or rejects the current version.</span></li><li><strong>4. Settle</strong><span>Employee paid claims may receive partial reimbursement entries; company paid costs follow supplier AP.</span></li></ol><button type="button" className="expense-secondary" onClick={() => onNavigate?.('evidence')}>Open Evidence Library</button></aside></div> : <div className="expense-grid"><section className="expense-card expense-register"><div className="expense-list-heading"><div><span className="expense-kicker">01 / REGISTER</span><h2>Expense claims</h2><p>Open a claim to inspect its source, decisions and settlement trail.</p></div><button type="button" className="expense-secondary" onClick={() => { setError(''); reloadClaims().catch(cause => setError(cause.message)); }}>Refresh</button></div><div className="expense-filters" aria-label="Filter claims">{[['all','All'],['submitted','Awaiting review'],['employee','Employee paid'],['company','Company paid']].map(([value, text]) => <button type="button" key={value} className={filter === value ? 'active' : ''} aria-pressed={filter === value} onClick={() => setFilter(value)}>{text}</button>)}</div>{!visibleClaims.length ? <p className="expense-empty">{claims.length ? 'No claims match this filter.' : 'No expense claims in this branch yet. Start with an approved purchase invoice and its evidence.'}</p> : <div className="expense-list">{visibleClaims.map(row => <button type="button" key={row.id} className={`expense-list-row ${selectedId === row.id ? 'selected' : ''}`} onClick={() => setSelectedId(row.id)}><span><strong>{row.invoice?.number || `Claim #${row.id}`}</strong><small>{row.purpose || `Claim #${row.id}`} · {userName(row.claimantUserId)}</small></span><span className="expense-row-end"><b className={`expense-status ${row.status}`}>{label(row.status)}</b><small>{row.paidBy === 'employee' ? 'Employee paid' : 'Company paid'} · {money(row.status === 'approved' ? row.approvedAmountCents : row.invoice?.totalCents)}</small></span></button>)}</div>}</section><section className="expense-card expense-detail" aria-label="Selected expense claim">{detailLoading ? <p className="expense-empty" role="status">Opening claim…</p> : !detail ? <div className="expense-detail-placeholder"><span className="expense-kicker">02 / CLAIM DETAIL</span><h2>Select a claim</h2><p>Invoice basis, evidence version, internal decision and payment trail appear here.</p></div> : <>
        <div className="expense-detail-head"><div><span className="expense-kicker">CLAIM #{detail.id} · VERSION {detail.version}</span><h2>{detail.invoice?.number || `Invoice #${detail.invoiceId}`}</h2><p>{detail.invoice?.partyNameSnapshot || 'Purchase invoice'} · {date(detail.invoice?.invoiceDate)}</p></div><span className={`expense-status ${detail.status}`}>{label(detail.status)}</span></div>
        <div className="expense-facts"><div><small>Payment path</small><strong>{detail.paidBy === 'employee' ? 'Employee paid' : 'Company paid'}</strong></div><div><small>Claimant</small><strong>{userName(detail.claimantUserId)}</strong></div><div><small>Invoice total</small><strong>{money(detail.invoice?.totalCents)}</strong></div><div><small>{detail.paidBy === 'company' ? 'Categorised amount' : 'Approved claim'}</small><strong>{money(detail.approvedAmountCents)}</strong></div></div>
        <div className="expense-detail-section"><div className="expense-section-line"><h3>Invoice &amp; evidence</h3><button type="button" className="expense-text" onClick={() => onNavigate?.('operations', detail.invoiceId)}>Open source invoice ↗</button></div><p><strong>Purpose:</strong> {detail.purpose}</p><p><strong>Cost centre:</strong> {detail.costCentre || 'Unassigned'}</p><p><strong>Evidence:</strong> {detail.evidence?.title || `Document #${detail.evidenceDocumentId}`} · version {detail.evidenceVersion} {detail.evidence?.fileName ? `· ${detail.evidence.fileName}` : ''}</p><p><strong>Proof reference:</strong> {detail.proofReference}</p><button type="button" className="expense-text" onClick={() => onNavigate?.('evidence')}>Open Evidence Library ↗</button></div>
        {detail.status === 'draft' && <div className="expense-action"><h3>Submit for review</h3><p>The reviewer will compare this version with its invoice and exact evidence file.</p>{[detail.createdBy, detail.claimantUserId].some(id => Number(id) === Number(userId)) ? <button type="button" className="expense-primary" disabled={busy} onClick={submit}>{busy ? 'Submitting…' : 'Submit claim'}</button> : <p className="expense-help">Only the claim creator or claimant can submit this draft.</p>}</div>}
        {detail.status === 'submitted' && <div className="expense-action"><h3>Independent review</h3><p>Source fingerprint: <code>{detail.sourceFingerprint || 'Loading current source…'}</code></p>{canReview && ![detail.createdBy, detail.claimantUserId, detail.submittedBy].some(id => Number(id) === Number(userId)) ? <><label>Decision reason<textarea rows="2" maxLength="500" value={reviewReason} onChange={event => setReviewReason(event.target.value)} placeholder="Evidence checked or reason for rejection" /></label><div className="expense-actions"><button type="button" className="expense-primary" disabled={busy || !detail.sourceFingerprint} onClick={() => review('approved')}>Approve claim</button><button type="button" className="expense-secondary" disabled={busy || !reviewReason.trim() || !detail.sourceFingerprint} onClick={() => review('rejected')}>Reject claim</button></div></> : <p className="expense-help">{!canReview ? 'Accountant or admin access is required to review claims.' : 'The creator, claimant and submitter cannot review this claim.'}</p>}</div>}
        {detail.paidBy === 'employee' ? <div className="expense-detail-section"><h3>Employee reimbursement</h3><div className="expense-settlement"><span><small>Employee paid</small><strong>{money(detail.employeePaidCents)}</strong></span><span><small>Recorded reimbursement</small><strong>{money(detail.reimbursedCents)}</strong></span><span><small>Remaining</small><strong>{money(detail.reimbursementRemainingCents)}</strong></span></div>{detail.status === 'approved' && remainingCents > 0 && (canReimburse ? <form className="expense-form expense-payment-form" onSubmit={reimburse}><p>Record a partial or final reimbursement entry. This does not send funds or confirm bank settlement.</p><div className="expense-form-row"><label>Amount (₹)<input required inputMode="decimal" value={payment.amount} onChange={event => setPayment(previous => ({ ...previous, amount: event.target.value }))} placeholder="0.00" /></label><label>Method<select value={payment.method} onChange={event => setPayment(previous => ({ ...previous, method: event.target.value }))}><option value="bank">Bank</option><option value="upi">UPI</option></select></label><label>Reference<input required maxLength="100" value={payment.reference} onChange={event => setPayment(previous => ({ ...previous, reference: event.target.value }))} placeholder="Transfer or UPI reference" /></label><label>Payment date<input required type="date" value={payment.paymentDate} onChange={event => setPayment(previous => ({ ...previous, paymentDate: event.target.value }))} /></label></div><button className="expense-primary" disabled={busy || !validPayment}>{busy ? 'Recording…' : 'Record reimbursement'}</button></form> : <p className="expense-help">Accountant or admin access is required to record reimbursements.</p>)}<h4>Recorded entries</h4>{detail.reimbursements?.length ? <ol className="expense-trail">{detail.reimbursements.map(row => <li key={row.id}><strong>{money(row.amountCents)} · {String(row.method).toUpperCase()}</strong><span>{row.reference} · {date(row.paymentDate)} · recorded by {userName(row.recordedBy)}</span></li>)}</ol> : <p className="expense-help">No reimbursement entries recorded.</p>}</div> : <div className="expense-detail-section"><h3>Supplier payable trail</h3><p>Company paid claims have no employee reimbursement. Supplier payments are allocated against the approved purchase invoice in Finance.</p>{invoicePayments?.invoice && <div className="expense-settlement"><span><small>Invoice total</small><strong>{money(invoicePayments.invoice.totalCents)}</strong></span><span><small>Recorded supplier payments</small><strong>{money(invoicePayments.invoice.paidCents)}</strong></span><span><small>Outstanding payable</small><strong>{money(invoicePayments.invoice.outstandingCents)}</strong></span></div>}{invoicePayments?.payments?.length ? <ol className="expense-trail">{invoicePayments.payments.map(row => <li key={row.id}><strong>{money(row.amountCents)} · {String(row.method).toUpperCase()}</strong><span>{row.reference} · {date(row.paymentDate)}</span></li>)}</ol> : <p className="expense-help">{invoicePayments?.unavailable ? 'Supplier payment history could not be loaded.' : 'No supplier payment entries found.'}</p>}<button type="button" className="expense-text" onClick={() => onNavigate?.('finance')}>Open Finance payables ↗</button></div>}
        <div className="expense-detail-section"><h3>Decision trail</h3>{detail.events?.length ? <ol className="expense-trail">{detail.events.map(row => <li key={row.id}><strong>{label(row.action)} · {date(row.createdAt)}</strong><span>{userName(row.actorId)} · version {row.version}{row.details ? ` · ${row.details}` : ''}</span></li>)}</ol> : <p className="expense-help">No events returned for this claim.</p>}</div>
      </>}</section></div>}
    </>}
  </section>;
}
