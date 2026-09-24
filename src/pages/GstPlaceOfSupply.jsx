import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import './gst-place-of-supply.css';

const EMPTY_FORM = {
  supplyKind: 'specialist_review', posStateCode: '', basisReference: '', reason: '',
  declaration: { composition: 'mixed_or_unknown', recipientRegistered: false, ordinaryDomestic: false, movementTerminatesAtPos: false, specialCase: 'other_or_unknown' },
};
const SPECIAL_CASES = [
  ['none', 'None identified'], ['bill_to_ship_to', 'Bill to / ship to'], ['unregistered_goods', 'Unregistered recipient, goods'],
  ['immovable_property', 'Immovable property'], ['sez', 'SEZ'], ['export', 'Export'], ['import', 'Import'],
  ['reverse_charge', 'Reverse charge'], ['online_unregistered_service', 'Online service to unregistered recipient'],
  ['other_or_unknown', 'Other or unknown'],
];
const KIND_LABELS = { goods_movement: 'Ordinary goods movement', domestic_service_default: 'Default domestic services', specialist_review: 'Specialist review' };
const STATUS_LABELS = { unassessed: 'No proposal', pending: 'Awaiting independent review', approved: 'Internally approved', rejected: 'Rejected', stale: 'Earlier invoice version' };
const money = (cents) => `₹${(Number(cents || 0) / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const when = (value) => value ? new Date(value).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' }) : '—';
const stateCode = (value) => /^(0[1-9]|[12][0-9]|3[0-8])$/.test(value);

function Fact({ label, value, note }) {
  return <div className="pos-fact"><span>{label}</span><strong>{value || 'Not recorded'}</strong>{note && <small>{note}</small>}</div>;
}

function Split({ proposal, lines }) {
  if (!proposal?.lineSplit?.length) return null;
  const nameFor = (lineId) => lines?.find((line) => Number(line.id) === Number(lineId))?.itemName || `Line #${lineId}`;
  return <div className="pos-split"><div className="pos-table-wrap"><table><thead><tr><th>Source line</th><th>Entered tax</th><th>IGST</th><th>CGST</th><th>SGST</th><th>UTGST</th></tr></thead><tbody>{proposal.lineSplit.map((line) => <tr key={line.lineId}><td>{nameFor(line.lineId)}</td><td>{money(line.taxCents)}</td><td>{money(line.igstCents)}</td><td>{money(line.cgstCents)}</td><td>{money(line.sgstCents)}</td><td>{money(line.utgstCents)}</td></tr>)}</tbody></table></div><p>Advisory allocation of the invoice’s entered tax. This does not change the invoice, ledger or GST period.</p></div>;
}

function Proposal({ proposal, latest, assessment, role, userId, busy, reason, onReason, onReview }) {
  const canReview = latest && proposal.status === 'pending' && ['accountant', 'admin'].includes(role) && Number(proposal.proposedBy) !== Number(userId);
  const status = proposal.status === 'approved' && proposal.outcome !== 'proposed_split' ? 'Referral internally reviewed' : STATUS_LABELS[proposal.status] || proposal.status;
  return <article className="pos-proposal"><div className="pos-proposal-head"><div><span className="ic-step">VERSION {proposal.version} · {KIND_LABELS[proposal.supplyKind] || proposal.supplyKind}</span><h3>{proposal.outcome === 'proposed_split' ? `${proposal.taxHead} allocation proposed` : 'Specialist review required'}</h3></div><span className={`pos-badge ${proposal.status}`}>{status}</span></div>
    <div className="pos-meta"><span>Prepared by <strong>{proposal.proposerName || `User #${proposal.proposedBy}`}</strong> · {when(proposal.proposedAt)}</span><span>Place state <strong>{proposal.posStateCode || 'Undetermined'}</strong></span></div>
    <p><strong>Documented basis:</strong> {proposal.basisReference}</p><p><strong>Reason:</strong> {proposal.reason}</p>
    <div className="pos-declaration"><span>Declared supply: {proposal.declaration?.composition?.replaceAll('_', ' ')}</span><span>Recipient registered: {proposal.declaration?.recipientRegistered ? 'Yes' : 'No'}</span><span>Ordinary domestic: {proposal.declaration?.ordinaryDomestic ? 'Yes' : 'No'}</span><span>Movement terminates at place: {proposal.declaration?.movementTerminatesAtPos ? 'Yes' : 'No'}</span><span>Special case: {SPECIAL_CASES.find(([key]) => key === proposal.declaration?.specialCase)?.[1] || proposal.declaration?.specialCase}</span></div>
    {proposal.reasons?.length > 0 && <div className="pos-reasons"><strong>Why a tax head was withheld</strong><ul>{proposal.reasons.map((item, index) => <li key={index}>{item}</li>)}</ul></div>}
    {proposal.warnings?.length > 0 && <div className="pos-reasons warning"><strong>Source checks</strong><ul>{proposal.warnings.map((item, index) => <li key={index}>{item}</li>)}</ul></div>}
    <Split proposal={proposal} lines={assessment.invoice?.lines} />
    {proposal.review && <div className="pos-review-record"><strong>{proposal.review.decision === 'approved' && proposal.outcome !== 'proposed_split' ? 'Specialist referral acknowledged' : proposal.review.decision === 'approved' ? 'Internal split approved' : 'Rejected'} by {proposal.review.reviewerName || `User #${proposal.review.reviewedBy}`}</strong><small>{when(proposal.review.reviewedAt)}</small><p>{proposal.review.reason}</p></div>}
    {latest && proposal.status === 'pending' && <div className="pos-review-form"><label>Independent review reason<textarea rows="3" maxLength="1000" value={reason} onChange={(event) => onReason(event.target.value)} placeholder="Cite the source evidence and explain this decision" /></label><div className="ic-actions"><button type="button" className="ic-primary" disabled={!canReview || busy || !reason.trim()} onClick={() => onReview(proposal, 'approved')}>{proposal.outcome === 'proposed_split' ? 'Approve internal split' : 'Acknowledge referral'}</button><button type="button" className="ic-secondary" disabled={!canReview || busy || !reason.trim()} onClick={() => onReview(proposal, 'rejected')}>Reject</button></div>{!['accountant', 'admin'].includes(role) ? <small>Accountant or admin access required for review.</small> : Number(proposal.proposedBy) === Number(userId) ? <small>The preparer cannot review their own proposal.</small> : null}</div>}
    {proposal.stale && <p className="pos-stale">The invoice changed after this proposal. Its decision no longer applies to the current version.</p>}
  </article>;
}

export default function GstPlaceOfSupply({ context = {}, invoices = [], initialInvoiceId, onNavigate }) {
  const { apiFetch, gstinId, branchId, role, userId } = context;
  const sales = useMemo(() => invoices.filter((row) => row.type === 'sale'), [invoices]);
  const [invoiceId, setInvoiceId] = useState(null);
  const invoiceIdRef = useRef(null);
  const [assessment, setAssessment] = useState(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [reviewReason, setReviewReason] = useState('');
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  useEffect(() => {
    const selected = sales.find((row) => Number(row.id) === Number(initialInvoiceId));
    const nextId = selected?.id || sales[0]?.id || null;
    invoiceIdRef.current = nextId;
    setInvoiceId(nextId);
  }, [sales, initialInvoiceId, gstinId, branchId]);

  const request = useCallback(async (path, options = {}) => {
    const response = await apiFetch(path, options);
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || body.message || `Request failed (${response.status})`);
    return body;
  }, [apiFetch]);
  const reload = useCallback(async (id) => {
    const result = await request(`/api/gst-place-of-supply/invoices/${id}`);
    if (Number(invoiceIdRef.current) === Number(id)) setAssessment(result.assessment);
  }, [request]);

  useEffect(() => {
    if (!invoiceId) { setAssessment(null); return undefined; }
    let active = true;
    setLoading(true); setAssessment(null); setError(''); setNotice(''); setReviewReason(''); setForm(EMPTY_FORM);
    request(`/api/gst-place-of-supply/invoices/${invoiceId}`)
      .then((result) => { if (active && Number(invoiceIdRef.current) === Number(invoiceId)) setAssessment(result.assessment); })
      .catch((cause) => { if (active) setError(cause.message); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [invoiceId, request]);

  const changeDeclaration = (key, value) => setForm((previous) => ({ ...previous, declaration: { ...previous.declaration, [key]: value } }));
  const send = async (path, body, success) => {
    const requestedId = invoiceId;
    setBusy(true); setError(''); setNotice('');
    try {
      const result = await request(path, { method: 'POST', body: JSON.stringify(body) });
      if (Number(invoiceIdRef.current) === Number(requestedId)) {
        setAssessment(result.assessment);
        setNotice(success);
      }
      return true;
    } catch (cause) {
      if (Number(invoiceIdRef.current) === Number(requestedId)) {
        setError(cause.message);
        if (/snapshot changed|stale|latest proposal/i.test(cause.message)) {
          try { await reload(requestedId); } catch { /* Retain the original actionable error. */ }
        }
      }
      return false;
    } finally { setBusy(false); }
  };
  const submit = async (event) => {
    event.preventDefault();
    if (!assessment) return;
    if (form.supplyKind !== 'specialist_review' && !stateCode(form.posStateCode)) { setError('Enter a two-digit GST state or UT code for this proposed place.'); return; }
    if (!form.basisReference.trim() || !form.reason.trim()) { setError('Document the source reference and reason.'); return; }
    const saved = await send(`/api/gst-place-of-supply/invoices/${invoiceId}/proposals`, {
      fingerprint: assessment.fingerprint, supplyKind: form.supplyKind,
      posStateCode: form.posStateCode.trim(), basisReference: form.basisReference.trim(), reason: form.reason.trim(), declaration: form.declaration,
    }, 'Proposal saved for independent review. Its tax head remains advisory.');
    if (saved) setForm(EMPTY_FORM);
  };
  const review = async (proposal, decision) => {
    if (!reviewReason.trim()) { setError('Record the evidence and reason for this review.'); return; }
    const saved = await send(`/api/gst-place-of-supply/invoices/${invoiceId}/proposals/${proposal.id}/review`, { decision, reason: reviewReason.trim() }, `Version ${proposal.version} ${decision} as an internal decision.`);
    if (saved) setReviewReason('');
  };

  return <div className="pos-layout"><aside className="ic-panel pos-register"><div className="ic-panel-head"><div><span className="ic-step">01 / SALES SOURCE</span><h2>Sales invoices</h2></div><span className="ic-muted">{sales.length} in scope</span></div>{!sales.length ? <p className="ic-empty">No sales invoices in this branch. Create one in Operations to assess its place of supply.</p> : <div className="ic-invoice-list">{sales.map((row) => <button type="button" key={row.id} className={Number(row.id) === Number(invoiceId) ? 'selected' : ''} onClick={() => { invoiceIdRef.current = row.id; setInvoiceId(row.id); }}><span><strong>{row.number}</strong><small>{row.partyName} · {row.invoiceDate}</small></span><span className="ic-row-right"><b className={`ic-status ${row.status}`}>{row.status}</b></span></button>)}</div>}</aside>
    <main className="pos-main"><div className="pos-boundary"><strong>Internal place-of-supply decision support.</strong> A proposed or approved split allocates tax already entered on a sales invoice. A specialist referral contains no tax-head decision. Neither outcome validates statutory treatment, posts accounting entries, alters GST period totals, signs, submits or files anything.</div>
      {error && <div className="ic-notice error" role="alert">{error}</div>}{notice && <div className="ic-notice success" role="status">{notice}</div>}
      {!gstinId || !branchId ? <div className="ic-panel ic-empty">Select a GSTIN and branch to inspect sales invoices.</div> : loading ? <div className="ic-panel ic-empty" role="status">Loading source facts and decision versions…</div> : !assessment ? <div className="ic-panel ic-empty">Select a sales invoice to inspect its source facts.</div> : <>
        <section className="ic-panel"><div className="ic-panel-head"><div><span className="ic-step">02 / SOURCE FACTS</span><h2>{assessment.invoice?.number}</h2><p>Invoice version: {assessment.fingerprint?.slice(0, 12)} · {assessment.invoice?.invoiceDate}</p></div><span className={`pos-badge ${assessment.status}`}>{assessment.status === 'approved' && assessment.proposal?.outcome !== 'proposed_split' ? 'Referral internally reviewed' : STATUS_LABELS[assessment.status] || assessment.status}</span></div>
          <div className="pos-facts"><Fact label="Issuing GSTIN" value={assessment.invoice?.supplierGstin} note={`State / UT ${assessment.invoice?.supplierStateCode || 'unknown'}`} /><Fact label="Recipient GSTIN on invoice" value={assessment.invoice?.partyGstin} note={`Party master state ${assessment.invoice?.partyStateCode || 'unknown'}`} /><Fact label="Entered invoice tax" value={money(assessment.invoice?.taxCents)} note={assessment.arithmeticValid ? 'Line arithmetic reconciles' : 'Line arithmetic needs review'} /></div>
          <div className="pos-source-note">Recipient registration, actual supply type and delivery end point require document review. Item stock tracking and party master state are cues, not legal classification or place-of-supply evidence.</div>
          <div className="pos-lines"><h3>Invoice lines</h3><div className="pos-table-wrap"><table><thead><tr><th>Item on source</th><th>Entered tax</th><th>Stock tracking cue</th></tr></thead><tbody>{assessment.invoice?.lines?.map((line) => <tr key={line.id}><td>{line.itemName}</td><td>{money(line.taxCents)}</td><td>{line.trackStock ? 'Tracked' : 'Not tracked'}</td></tr>)}</tbody></table></div></div>
          <div className="ic-footer-actions"><button type="button" className="ic-secondary" onClick={() => onNavigate?.('operations', invoiceId)}>Open source invoice</button><button type="button" className="ic-text-button" onClick={async () => { setLoading(true); setError(''); try { await reload(invoiceId); } catch (cause) { setError(cause.message); } finally { setLoading(false); } }}>Refresh version</button></div>
        </section>
        <section className="ic-panel pos-form-panel"><div className="ic-panel-head"><div><span className="ic-step">03 / DOCUMENT TREATMENT</span><h2>Propose a place of supply</h2><p>Staff records evidence and declarations; a different accountant or admin reviews the version.</p></div></div>
          {role !== 'staff' ? <p className="ic-empty">Staff access is required to prepare a proposal. You can inspect and review existing decisions below.</p> : <form onSubmit={submit}><div className="pos-form-grid"><label>Supply path<select value={form.supplyKind} onChange={(event) => setForm((previous) => ({ ...previous, supplyKind: event.target.value }))}><option value="specialist_review">Specialist review / unsure</option><option value="goods_movement">Ordinary goods movement</option><option value="domestic_service_default">Default domestic services</option></select></label><label>Proposed place state / UT code<input inputMode="numeric" maxLength="2" pattern="[0-9]{2}" value={form.posStateCode} onChange={(event) => setForm((previous) => ({ ...previous, posStateCode: event.target.value.replace(/\D/g, '').slice(0, 2) }))} placeholder={form.supplyKind === 'specialist_review' ? 'Optional for specialist review' : 'e.g. 27'} required={form.supplyKind !== 'specialist_review'} /></label><label>Supply composition<select value={form.declaration.composition} onChange={(event) => changeDeclaration('composition', event.target.value)}><option value="mixed_or_unknown">Mixed or unknown</option><option value="goods_only">Goods only, documented</option><option value="services_only">Services only, documented</option></select></label><label>Special case<select value={form.declaration.specialCase} onChange={(event) => changeDeclaration('specialCase', event.target.value)}>{SPECIAL_CASES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label></div>
            <div className="pos-checks"><label><input type="checkbox" checked={form.declaration.recipientRegistered} onChange={(event) => changeDeclaration('recipientRegistered', event.target.checked)} />Registered recipient confirmed from source</label><label><input type="checkbox" checked={form.declaration.ordinaryDomestic} onChange={(event) => changeDeclaration('ordinaryDomestic', event.target.checked)} />Ordinary domestic supply confirmed</label><label><input type="checkbox" checked={form.declaration.movementTerminatesAtPos} onChange={(event) => changeDeclaration('movementTerminatesAtPos', event.target.checked)} />Goods movement terminates at the proposed place</label></div>
            <p className="pos-form-hint">Only registered, ordinary domestic goods movement with confirmed termination, or default domestic services with no special case, can produce an advisory tax-head split. Other declarations go to specialist review.</p>
            <label>Evidence or basis reference<input required maxLength="300" value={form.basisReference} onChange={(event) => setForm((previous) => ({ ...previous, basisReference: event.target.value }))} placeholder="Delivery document, contract, tax memo or professional advice" /></label><label>Why this treatment applies<textarea required rows="3" maxLength="1000" value={form.reason} onChange={(event) => setForm((previous) => ({ ...previous, reason: event.target.value }))} placeholder="Explain the actual facts and why the selected path applies" /></label><button type="submit" className="ic-primary" disabled={busy}>Save version for review</button>
          </form>}
        </section>
        <section className="ic-panel"><div className="ic-panel-head"><div><span className="ic-step">04 / DECISION TRAIL</span><h2>Versioned proposals</h2><p>Only the latest current version can receive an independent review.</p></div><span className="ic-muted">{assessment.proposals?.length || 0} versions</span></div>{!assessment.proposals?.length ? <p className="ic-empty">No documented place-of-supply proposal yet.</p> : <div className="pos-proposals">{assessment.proposals.map((proposal, index) => <Proposal key={proposal.id} proposal={proposal} latest={index === 0} assessment={assessment} role={role} userId={userId} busy={busy} reason={reviewReason} onReason={setReviewReason} onReview={review} />)}</div>}</section>
      </>}
    </main></div>;
}
