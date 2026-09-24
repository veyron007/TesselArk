import { useCallback, useEffect, useMemo, useState } from 'react';
import './invoice-checks.css';

const percent = (basisPoints) => `${(Number(basisPoints || 0) / 100).toLocaleString('en-IN', { maximumFractionDigits: 2 })}%`;
const dateLabel = (value) => value ? new Date(`${value}T00:00:00`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : '—';
const timestampLabel = (value) => value ? new Date(value).toLocaleString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—';
const initialPolicy = () => ({ itemId: '', hsn: '', rateBps: '', effectiveFrom: '', effectiveTo: '', sourceReference: '', reason: '' });
const statusLabel = (status) => ({ draft: 'Draft', submitted: 'Submitted', approved: 'Approved', pending: 'Awaiting review', rejected: 'Rejected' }[status] || status || 'Unknown');

function Notice({ kind, children }) {
  if (!children) return null;
  return <div className={`ic-notice ${kind}`} role={kind === 'error' ? 'alert' : 'status'}>{children}</div>;
}

function Finding({ finding }) {
  return <li className={`ic-finding ${finding.severity}`}>
    <span className="ic-finding-icon" aria-hidden="true">{finding.severity === 'blocker' ? '!' : finding.severity === 'warning' ? '•' : 'i'}</span>
    <div><strong>{finding.severity === 'blocker' ? 'Needs a decision' : finding.severity === 'warning' ? 'Check before approval' : 'Information'}</strong><p>{finding.message}</p>{finding.lineId && <small>Invoice line #{finding.lineId}</small>}</div>
  </li>;
}

export default function InvoiceChecks({ context = {}, initialInvoiceId, onNavigate, refresh }) {
  const { companyId, gstinId, branchId, userId, role, apiFetch, bootstrap } = context;
  const company = bootstrap?.companies?.find((row) => String(row.id) === String(companyId));
  const branch = company?.branches?.find((row) => String(row.id) === String(branchId));
  const registration = company?.gstins?.find((row) => String(row.id) === String(gstinId));
  const canPrepare = ['staff', 'accountant', 'admin'].includes(role);
  const canReview = ['accountant', 'admin'].includes(role);
  const [view, setView] = useState('invoices');
  const [invoices, setInvoices] = useState([]);
  const [items, setItems] = useState([]);
  const [policies, setPolicies] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [assessment, setAssessment] = useState(null);
  const [search, setSearch] = useState('');
  const [policyForm, setPolicyForm] = useState(initialPolicy);
  const [reviewReasons, setReviewReasons] = useState({});
  const [invoiceReason, setInvoiceReason] = useState('');
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const request = useCallback(async (path, options = {}) => {
    const response = await apiFetch(path, options);
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || body.message || `Request failed (${response.status})`);
    return body;
  }, [apiFetch]);

  const reloadPolicies = useCallback(async () => {
    const result = await request('/api/gst-invoice-checks/policies');
    setPolicies(result.policies || []);
  }, [request]);

  useEffect(() => {
    if (!companyId || !gstinId || !branchId) { setLoading(false); setInvoices([]); setItems([]); setPolicies([]); setSelectedId(null); return undefined; }
    let active = true;
    setLoading(true); setError(''); setNotice(''); setAssessment(null); setSelectedId(null);
    setPolicyForm(initialPolicy());
    const query = new URLSearchParams({ gstinId: String(gstinId), branchId: String(branchId) });
    Promise.all([
      request(`/api/invoices?${query}`),
      request('/api/items'),
      request('/api/gst-invoice-checks/policies'),
    ]).then(([invoiceData, itemData, policyData]) => {
      if (!active) return;
      const rows = invoiceData.invoices || [];
      setInvoices(rows);
      setItems(itemData.items || []);
      setPolicies(policyData.policies || []);
      if (initialInvoiceId && !rows.some((row) => Number(row.id) === Number(initialInvoiceId))) {
        setError('This invoice is unavailable in the selected company, GSTIN and branch. Choose an invoice from the register.');
      } else setSelectedId(initialInvoiceId ? Number(initialInvoiceId) : rows[0]?.id || null);
    }).catch((cause) => { if (active) setError(cause.message); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [companyId, gstinId, branchId, initialInvoiceId, request]);

  useEffect(() => {
    if (!selectedId) { setAssessment(null); return undefined; }
    let active = true;
    setDetailLoading(true); setError(''); setAssessment(null);
    request(`/api/gst-invoice-checks/invoices/${selectedId}`)
      .then((result) => { if (active) setAssessment(result.assessment); })
      .catch((cause) => { if (active) setError(cause.message); })
      .finally(() => { if (active) setDetailLoading(false); });
    return () => { active = false; };
  }, [selectedId, request]);

  const selected = useMemo(() => invoices.find((row) => Number(row.id) === Number(selectedId)), [invoices, selectedId]);
  const filteredInvoices = useMemo(() => {
    const query = search.trim().toLowerCase();
    return invoices.filter((row) => !query || `${row.number} ${row.partyName} ${row.type}`.toLowerCase().includes(query));
  }, [invoices, search]);
  const selectedItem = items.find((row) => Number(row.id) === Number(policyForm.itemId));
  const pendingPolicies = policies.filter((row) => row.status === 'pending').length;
  const blockers = assessment?.blockers ?? assessment?.findings?.filter((row) => row.severity === 'blocker').length ?? 0;
  const warnings = assessment?.warnings ?? assessment?.findings?.filter((row) => row.severity === 'warning').length ?? 0;

  const command = async (path, body, success, after) => {
    setBusy(true); setError(''); setNotice('');
    try {
      const result = await request(path, { method: 'POST', body: JSON.stringify(body) });
      await after?.(result);
      setNotice(success);
      if (typeof refresh === 'function') refresh();
      return result;
    } catch (cause) { setError(cause.message); return null; }
    finally { setBusy(false); }
  };

  const propose = async (event) => {
    event.preventDefault();
    const rateBps = Number(policyForm.rateBps);
    if (!Number.isSafeInteger(rateBps) || rateBps < 0 || rateBps > 10000) { setError('Enter a GST rate in basis points from 0 to 10000.'); return; }
    if (policyForm.effectiveTo && policyForm.effectiveTo < policyForm.effectiveFrom) { setError('The end date must follow the start date.'); return; }
    const result = await command('/api/gst-invoice-checks/policies', {
      itemId: Number(policyForm.itemId), hsn: policyForm.hsn.trim(), rateBps,
      effectiveFrom: policyForm.effectiveFrom, effectiveTo: policyForm.effectiveTo || null,
      sourceReference: policyForm.sourceReference.trim(), reason: policyForm.reason.trim(),
    }, 'Tax policy proposal saved. A different accountant must review its source before it can be used for invoice checks.', reloadPolicies);
    if (result) setPolicyForm(initialPolicy());
  };

  const reviewPolicy = async (policy, decision) => {
    const reason = reviewReasons[policy.id]?.trim();
    if (!reason) { setError('Record the evidence and reason for the policy decision.'); return; }
    const result = await command(`/api/gst-invoice-checks/policies/${policy.id}/review`, { decision, reason },
      `Policy ${decision}. The invoice assessment will now use the current reviewed policy.`, async () => {
        await reloadPolicies();
        if (selectedId) setAssessment((await request(`/api/gst-invoice-checks/invoices/${selectedId}`)).assessment);
      });
    if (result) setReviewReasons((previous) => ({ ...previous, [policy.id]: '' }));
  };

  const reviewInvoice = async (decision) => {
    if (!invoiceReason.trim()) { setError('Record the evidence and reason for the invoice exception decision.'); return; }
    const result = await command(`/api/gst-invoice-checks/invoices/${selectedId}/reviews`, { decision, reason: invoiceReason.trim() },
      decision === 'accepted' ? 'Exception accepted for this invoice version. Reassess if invoice details change.' : 'Exception rejected. Resolve the mismatch before approval.',
      async (data) => setAssessment(data.assessment || (await request(`/api/gst-invoice-checks/invoices/${selectedId}`)).assessment));
    if (result) setInvoiceReason('');
  };

  const startFromLine = (line) => {
    setPolicyForm({ itemId: String(line.itemId), hsn: line.hsn || '', rateBps: String(line.gstRateBps ?? ''), effectiveFrom: assessment.invoice?.invoiceDate || '', effectiveTo: '', sourceReference: '', reason: '' });
    setView('policies');
    setNotice('Invoice values were copied as a starting point. Add a documented source and verify them before proposing a policy.');
  };

  return <section className="ic-page" aria-label="GST invoice checks">
    <header className="ic-hero"><div><p className="ic-eyebrow">TAX CONTROL / INVOICE WORKSPACE</p><h1>Invoice correctness</h1><p>Check invoice data against reviewed, dated item policies and record accountant decisions before approval.</p></div><div className="ic-hero-metric"><span>POLICIES TO REVIEW</span><strong>{pendingPolicies}</strong><small>in this company</small></div></header>
    <div className="ic-scope"><span><strong>{company?.name || 'Selected company'}</strong></span><span>{registration?.gstin || 'No GSTIN selected'}</span><span>{branch?.name || 'No branch selected'}</span><span>{role || 'Current role'}</span></div>
    <p className="ic-boundary"><strong>Internal decision support.</strong> A reviewed policy means your team checked its documented source. TesselArk does not verify statutory rates, sign documents, connect to the GST portal or file returns. Review the current law and evidence before relying on an invoice.</p>
    <div className="ic-tabs" role="tablist" aria-label="Invoice checks sections"><button type="button" role="tab" aria-selected={view === 'invoices'} className={view === 'invoices' ? 'active' : ''} onClick={() => setView('invoices')}>Invoice checks <span>{invoices.length}</span></button><button type="button" role="tab" aria-selected={view === 'policies'} className={view === 'policies' ? 'active' : ''} onClick={() => setView('policies')}>Tax policy register <span>{policies.length}</span></button></div>
    <Notice kind="error">{error}</Notice><Notice kind="success">{notice}</Notice>
    {!gstinId || !branchId ? <div className="ic-empty">Select a GSTIN and branch to inspect invoices.</div> : loading ? <div className="ic-empty" role="status">Loading invoices and tax policies…</div> : view === 'invoices' ? <div className="ic-layout">
      <section className="ic-panel ic-register"><div className="ic-panel-head"><div><span className="ic-step">01 / SELECT SOURCE</span><h2>Invoice register</h2></div><span className="ic-muted">{filteredInvoices.length} shown</span></div><label className="ic-search"><span className="sr-only">Search invoices</span><input type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search number or party" /></label>
        {!invoices.length ? <p className="ic-empty">No invoices in this branch yet. Create one in Operations to run a check.</p> : !filteredInvoices.length ? <p className="ic-empty">No invoices match that search.</p> : <div className="ic-invoice-list">{filteredInvoices.map((row) => <button type="button" key={row.id} className={Number(selectedId) === Number(row.id) ? 'selected' : ''} onClick={() => { setSelectedId(row.id); setInvoiceReason(''); setNotice(''); }}><span><strong>{row.number}</strong><small>{row.partyName} · {dateLabel(row.invoiceDate)}</small></span><span className="ic-row-right"><b className={`ic-status ${row.status}`}>{statusLabel(row.status)}</b><small>{row.type === 'purchase' ? 'Purchase' : 'Sale'}</small></span></button>)}</div>}
      </section>
      <section className="ic-panel ic-assessment" aria-label="Selected invoice assessment">{detailLoading ? <p className="ic-empty" role="status">Checking the invoice…</p> : !assessment ? <div className="ic-empty"><h2>Select an invoice</h2><p>Review line evidence, policy comparisons and any exceptions here.</p></div> : <><div className="ic-panel-head"><div><span className="ic-step">02 / ASSESS</span><h2>{assessment.invoice?.number || selected?.number}</h2><p>{assessment.invoice?.partyName || selected?.partyName} · {dateLabel(assessment.invoice?.invoiceDate || selected?.invoiceDate)}</p></div><span className={`ic-status ${assessment.invoice?.status}`}>{statusLabel(assessment.invoice?.status)}</span></div>
        <div className="ic-assessment-summary"><div className={blockers ? 'blocked' : 'ready'}><span>Policy mismatches</span><strong>{blockers}</strong><small>{blockers ? (assessment.invoice?.status === 'approved' ? 'historical invoice: inspect' : 'decision required before approval') : 'none found'}</small></div><div><span>Review prompts</span><strong>{warnings}</strong><small>verify supporting evidence</small></div><div><span>{assessment.invoice?.status === 'approved' ? 'Invoice status' : 'Approval check'}</span><strong className="ic-word">{assessment.invoice?.status === 'approved' ? 'Recorded' : assessment.approvalReady ? 'Ready' : 'Review'}</strong><small>internal checks only</small></div></div>
        <div className="ic-detail-section"><div className="ic-section-title"><h3>Line policy comparison</h3><span>{assessment.lines?.length || 0} lines</span></div><div className="ic-table-wrap"><table><thead><tr><th>Invoice item</th><th>Invoice HSN</th><th>Entered rate</th><th>Reviewed policy</th><th></th></tr></thead><tbody>{(assessment.lines || []).map((line) => <tr key={line.id}><td><strong>{line.itemName}</strong><small>{line.sku}</small></td><td>{line.hsn || 'Missing'}</td><td>{percent(line.gstRateBps)}</td><td>{line.policy ? <span>{percent(line.policy.rateBps)} <small>from {dateLabel(line.policy.effectiveFrom)}</small></span> : <span className="ic-no-policy">No dated policy</span>}</td><td><button type="button" className="ic-text-button" onClick={() => startFromLine(line)}>Propose policy</button></td></tr>)}</tbody></table></div></div>
        <div className="ic-detail-section"><div className="ic-section-title"><h3>Findings</h3><span>{assessment.findings?.length || 0} total</span></div>{assessment.findings?.length ? <ul className="ic-findings">{assessment.findings.map((finding, index) => <Finding key={`${finding.code}-${finding.lineId || index}`} finding={finding} />)}</ul> : <p className="ic-clear">No data or policy differences found by these local checks. Confirm the supporting tax position independently.</p>}</div>
        {assessment.acceptedOverride && <div className="ic-override"><strong>Accountant exception accepted for this version</strong><p>{assessment.acceptedOverride.reason || 'A reviewed exception is on record.'}</p></div>}
        {assessment.reviews?.length > 0 && <details className="ic-review-history"><summary>Accountant decision trail · {assessment.reviews.length}</summary><ol>{assessment.reviews.map((review) => <li key={review.id}><span className={`ic-status ${review.decision === 'accepted' ? 'approved' : 'rejected'}`}>{review.decision}</span><div><strong>{review.reviewerName || `User #${review.reviewerId}`}</strong><small>{timestampLabel(review.createdAt)} · {review.fingerprint === assessment.fingerprint ? 'Current invoice version' : 'Earlier invoice version'}</small><p>{review.reason}</p></div></li>)}</ol></details>}
        {blockers > 0 && assessment.invoice?.status !== 'approved' && <div className="ic-review"><div className="ic-section-title"><h3>Accountant exception decision</h3><span>Version specific</span></div><p>Resolve the source or document an exception. Acceptance is tied to this invoice’s current details and does not certify a statutory rate.</p><label>Decision reason<textarea rows="3" maxLength="500" value={invoiceReason} onChange={(event) => setInvoiceReason(event.target.value)} placeholder="Cite the source document and why this mismatch is accepted or rejected" /></label><div className="ic-actions"><button type="button" className="ic-primary" disabled={!canReview || busy || !invoiceReason.trim()} onClick={() => reviewInvoice('accepted')}>Accept exception</button><button type="button" className="ic-secondary" disabled={!canReview || busy || !invoiceReason.trim()} onClick={() => reviewInvoice('rejected')}>Reject exception</button></div>{!canReview && <small>Accountant or admin access required.</small>}</div>}
        <div className="ic-footer-actions"><button type="button" className="ic-secondary" onClick={() => onNavigate?.('operations', selectedId)}>Open source invoice</button><button type="button" className="ic-text-button" onClick={async () => { setDetailLoading(true); setError(''); try { setAssessment((await request(`/api/gst-invoice-checks/invoices/${selectedId}`)).assessment); } catch (cause) { setError(cause.message); } finally { setDetailLoading(false); } }}>Run check again</button></div>
      </>}</section>
    </div> : <div className="ic-policy-layout"><section className="ic-panel ic-policy-form"><div className="ic-panel-head"><div><span className="ic-step">01 / DOCUMENT BASIS</span><h2>Propose a dated item policy</h2></div></div><p className="ic-muted">A proposal records your team’s source and dates. A different accountant must review it before invoice comparisons use it.</p>{canPrepare ? <form onSubmit={propose}><label>Catalogue item<select required value={policyForm.itemId} onChange={(event) => { const item = items.find((row) => Number(row.id) === Number(event.target.value)); setPolicyForm((previous) => ({ ...previous, itemId: event.target.value, hsn: item?.hsn || '', rateBps: item ? String(item.gstRateBps) : '' })); }}><option value="">Choose an item</option>{items.map((item) => <option key={item.id} value={item.id}>{item.sku} · {item.name}</option>)}</select></label>{selectedItem && <p className="ic-item-hint">Catalogue value: {selectedItem.hsn || 'no HSN'} · {percent(selectedItem.gstRateBps)}. Verify this against a documented source.</p>}<div className="ic-form-grid"><label>HSN / SAC<input required maxLength="12" value={policyForm.hsn} onChange={(event) => setPolicyForm((previous) => ({ ...previous, hsn: event.target.value }))} placeholder="Documented code" /></label><label>Rate in basis points<input required type="number" min="0" max="10000" step="1" value={policyForm.rateBps} onChange={(event) => setPolicyForm((previous) => ({ ...previous, rateBps: event.target.value }))} placeholder="1800 = 18%" /></label><label>Effective from<input required type="date" value={policyForm.effectiveFrom} onChange={(event) => setPolicyForm((previous) => ({ ...previous, effectiveFrom: event.target.value }))} /></label><label>Effective through<input type="date" min={policyForm.effectiveFrom || undefined} value={policyForm.effectiveTo} onChange={(event) => setPolicyForm((previous) => ({ ...previous, effectiveTo: event.target.value }))} /></label></div><label>Source reference<input required maxLength="300" value={policyForm.sourceReference} onChange={(event) => setPolicyForm((previous) => ({ ...previous, sourceReference: event.target.value }))} placeholder="Notification, circular, internal tax memo or professional advice" /></label><label>Why this treatment applies<textarea required rows="3" maxLength="500" value={policyForm.reason} onChange={(event) => setPolicyForm((previous) => ({ ...previous, reason: event.target.value }))} placeholder="Record product classification, source date and decision rationale" /></label><button className="ic-primary" disabled={busy}>Save policy proposal</button></form> : <p className="ic-empty">This role can inspect the policy register only.</p>}</section>
      <section className="ic-panel ic-policy-register"><div className="ic-panel-head"><div><span className="ic-step">02 / INDEPENDENT REVIEW</span><h2>Policy register</h2></div><span className="ic-muted">{policies.length} policies</span></div>{!policies.length ? <p className="ic-empty">No policies recorded. Propose a dated policy with a source reference to begin independent review.</p> : <div className="ic-policy-list">{policies.map((policy) => <article key={policy.id}><div className="ic-policy-top"><div><span className="ic-step">{policy.sku || `ITEM ${policy.itemId}`}</span><h3>{policy.itemName || 'Catalogue item'}</h3></div><span className={`ic-status ${policy.status}`}>{statusLabel(policy.status)}</span></div><div className="ic-policy-facts"><span><small>HSN / SAC</small><strong>{policy.hsn}</strong></span><span><small>Proposed rate</small><strong>{percent(policy.rateBps)}</strong></span><span><small>Effective dates</small><strong>{dateLabel(policy.effectiveFrom)}{policy.effectiveTo ? ` – ${dateLabel(policy.effectiveTo)}` : ' onward'}</strong></span></div><p className="ic-policy-source"><strong>Source:</strong> {policy.sourceReference}</p><p className="ic-policy-reason">{policy.reason}</p>{policy.reviewReason && <div className="ic-policy-decision"><strong>Review reason</strong><p>{policy.reviewReason}</p></div>}{policy.status === 'pending' && <div className="ic-policy-review"><label>Independent review reason<textarea rows="2" maxLength="500" value={reviewReasons[policy.id] || ''} onChange={(event) => setReviewReasons((previous) => ({ ...previous, [policy.id]: event.target.value }))} placeholder="Record your evidence and decision" /></label><div className="ic-actions"><button type="button" className="ic-primary" disabled={!canReview || Number(policy.createdBy) === Number(userId) || busy || !reviewReasons[policy.id]?.trim()} onClick={() => reviewPolicy(policy, 'approved')}>Approve policy</button><button type="button" className="ic-secondary" disabled={!canReview || Number(policy.createdBy) === Number(userId) || busy || !reviewReasons[policy.id]?.trim()} onClick={() => reviewPolicy(policy, 'rejected')}>Reject</button></div>{!canReview ? <small>Accountant or admin access required.</small> : Number(policy.createdBy) === Number(userId) ? <small>The preparer cannot review this proposal.</small> : null}</div>}</article>)}</div>}</section></div>}
  </section>;
}
