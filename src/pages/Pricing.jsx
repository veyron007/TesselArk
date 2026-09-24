import { useCallback, useEffect, useMemo, useState } from 'react';
import './pricing.css';

const today = () => new Date().toISOString().slice(0, 10);
const money = cents => cents == null ? '—' : `₹${(cents / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const percent = bps => `${(bps / 100).toFixed(2)}%`;
const scopeName = { company: 'Company', item: 'Item', party: 'Customer', party_item: 'Customer + item' };
const initialPolicy = () => ({ scope: 'company', itemId: '', partyId: '', rateRupees: '', minDiscount: '0', defaultDiscount: '0', maxDiscount: '0', effectiveFrom: today(), effectiveTo: '', sourceReference: '', reason: '' });
const initialRequest = () => ({ rateRupees: '', discount: '', reason: '', clientReference: '' });
const toCents = value => Math.round(Number(value) * 100);
const toBps = value => Math.round(Number(value) * 100);

export default function Pricing({ context = {}, refresh }) {
  const [masters, setMasters] = useState({ items: [], parties: [] });
  const [rules, setRules] = useState([]);
  const [exceptions, setExceptions] = useState([]);
  const [ruleForm, setRuleForm] = useState(initialPolicy);
  const [selection, setSelection] = useState({ itemId: '', partyId: '', priceDate: today() });
  const [quote, setQuote] = useState(null);
  const [proposal, setProposal] = useState(initialRequest);
  const [decisionReason, setDecisionReason] = useState({});
  const [audit, setAudit] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const canManage = context.role === 'admin';
  const company = context.bootstrap?.companies?.find(row => String(row.id) === String(context.companyId));
  const branch = company?.branches?.find(row => String(row.id) === String(context.branchId));
  const gstin = company?.gstins?.find(row => String(row.id) === String(context.gstinId));

  const request = useCallback(async (path, init = {}) => {
    const response = context.apiFetch ? await context.apiFetch(path, init) : await fetch(path, { ...init, headers: { 'content-type': 'application/json', 'x-company-id': String(context.companyId), 'x-user-id': String(context.userId), ...init.headers } });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
    return data;
  }, [context.apiFetch, context.companyId, context.userId]);
  const load = useCallback(async () => {
    const [masterData, ruleData, exceptionData] = await Promise.all([
      request('/api/pricing/masters'), request('/api/pricing/rules'), request('/api/pricing/exceptions')
    ]);
    setMasters(masterData); setRules(ruleData.rules || []); setExceptions(exceptionData.exceptions || []);
  }, [request]);
  useEffect(() => {
    let live = true;
    setLoading(true); setError(''); setQuote(null); setAudit(null);
    Promise.all([request('/api/pricing/masters'), request('/api/pricing/rules'), request('/api/pricing/exceptions')])
      .then(([masterData, ruleData, exceptionData]) => {
        if (!live) return;
        setMasters(masterData); setRules(ruleData.rules || []); setExceptions(exceptionData.exceptions || []);
      }).catch(cause => { if (live) setError(cause.message); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [request]);
  useEffect(() => { setRuleForm(initialPolicy()); setSelection({ itemId: '', partyId: '', priceDate: today() }); setQuote(null); setProposal(initialRequest()); setAudit(null); setNotice(''); }, [context.companyId, context.userId, context.branchId]);

  const itemById = useMemo(() => Object.fromEntries(masters.items.map(row => [row.id, row])), [masters.items]);
  const partyById = useMemo(() => Object.fromEntries(masters.parties.map(row => [row.id, row])), [masters.parties]);
  const update = (setter, field, value) => setter(previous => ({ ...previous, [field]: value }));
  const mutate = async (path, body, success, after) => {
    setBusy(true); setError(''); setNotice('');
    try {
      const result = await request(path, { method: 'POST', body: JSON.stringify(body) });
      await load();
      if (audit) setAudit(await request('/api/pricing/audit'));
      setNotice(success); after?.(result); refresh?.();
      return result;
    } catch (cause) { setError(cause.message); return null; }
    finally { setBusy(false); }
  };
  const createRule = event => {
    event.preventDefault();
    mutate('/api/pricing/rules', {
      scope: ruleForm.scope,
      itemId: ['item', 'party_item'].includes(ruleForm.scope) ? Number(ruleForm.itemId) : undefined,
      partyId: ['party', 'party_item'].includes(ruleForm.scope) ? Number(ruleForm.partyId) : undefined,
      rateCents: toCents(ruleForm.rateRupees),
      minDiscountBps: toBps(ruleForm.minDiscount), defaultDiscountBps: toBps(ruleForm.defaultDiscount), maxDiscountBps: toBps(ruleForm.maxDiscount),
      effectiveFrom: ruleForm.effectiveFrom, effectiveTo: ruleForm.effectiveTo || null,
      sourceReference: ruleForm.sourceReference, reason: ruleForm.reason
    }, 'Pricing rule recorded with its source and audit entry.', () => setRuleForm(initialPolicy()));
  };
  const preview = async event => {
    event.preventDefault(); setError(''); setNotice(''); setQuote(null);
    try {
      const params = new URLSearchParams({ ...selection, branchId: String(context.branchId) });
      const result = await request(`/api/pricing/quote?${params}`);
      setQuote(result.quote);
      if (result.quote.hasPolicy) setProposal(previous => ({ ...previous, rateRupees: (result.quote.rateCents / 100).toFixed(2), discount: (result.quote.discountBps / 100).toFixed(2) }));
    } catch (cause) { setError(cause.message); }
  };
  const requestException = event => {
    event.preventDefault();
    if (!quote?.hasPolicy) return;
    mutate('/api/pricing/exceptions', {
      branchId: Number(context.branchId), itemId: quote.itemId, partyId: quote.partyId, priceDate: quote.priceDate,
      proposedRateCents: toCents(proposal.rateRupees), proposedDiscountBps: toBps(proposal.discount),
      reason: proposal.reason, clientReference: proposal.clientReference
    }, 'Exception submitted for a separate company admin decision. No invoice price changed.', () => setProposal(initialRequest()));
  };
  const currentRules = rules.filter(row => row.active);
  const pending = exceptions.filter(row => row.status === 'pending');
  const history = exceptions.filter(row => row.status !== 'pending');

  return <section className="pricing-page">
    <header className="pricing-hero">
      <div><span className="pricing-eyebrow">TRADE CONTROL · ERP-013</span><h1>Pricing &amp; discounts</h1><p>Review a dated rate, set discount limits, and route exceptions to a separate approver.</p></div>
      <div className="pricing-scope"><span>Working scope</span><strong>{company?.name || 'Selected company'}</strong><small>{gstin?.gstin || 'GSTIN'} · {branch?.name || 'Branch'}</small><small>{canManage ? 'Company admin' : context.role || 'Staff'} · {context.bootstrap?.users?.find?.(row => String(row.id) === String(context.userId))?.name || `User #${context.userId}`}</small></div>
    </header>
    <div className="pricing-boundary" role="note"><strong>Advisory control</strong><span>These policy previews and approvals are stored separately from invoices. Billing still requires an explicit price choice; this screen does not recalculate or authorize an invoice.</span></div>
    {error && <div className="pricing-error" role="alert">{error}</div>}
    {notice && <div className="pricing-notice" role="status">{notice}</div>}
    {loading ? <div className="pricing-panel">Loading pricing data…</div> : <>
      <div className="pricing-metrics"><div><span>Active rules</span><strong>{currentRules.length}</strong><small>Across this company</small></div><div><span>Pending decisions</span><strong>{pending.length}</strong><small>Visible branch requests</small></div><div><span>Precedence</span><strong>4 levels</strong><small>Customer + item → customer → item → company</small></div></div>
      <div className="pricing-layout">
        <div className="pricing-column">
          <section className="pricing-panel"><div className="pricing-section-head"><div><span className="pricing-eyebrow">01 · RATE ENGINE</span><h2>Check applicable price</h2></div><span>On selected date and branch</span></div>
            <form className="pricing-form pricing-preview-form" onSubmit={preview}>
              <label>Customer<select required value={selection.partyId} onChange={event => { update(setSelection, 'partyId', event.target.value); setQuote(null); }}><option value="">Select customer</option>{masters.parties.map(row => <option key={row.id} value={row.id}>{row.name}</option>)}</select></label>
              <label>Item<select required value={selection.itemId} onChange={event => { update(setSelection, 'itemId', event.target.value); setQuote(null); }}><option value="">Select item</option>{masters.items.filter(row => row.active).map(row => <option key={row.id} value={row.id}>{row.sku} · {row.name}</option>)}</select></label>
              <label>Pricing date<input required type="date" value={selection.priceDate} onChange={event => { update(setSelection, 'priceDate', event.target.value); setQuote(null); }} /></label>
              <button disabled={busy}>Preview policy</button>
            </form>
            {quote && (quote.hasPolicy ? <div className="pricing-quote"><span className="pricing-tag">{scopeName[quote.rule.scope]} rule #{quote.rule.id}</span><div className="pricing-quote-figures"><div><small>List rate</small><strong>{money(quote.rateCents)}</strong></div><div><small>Default discount</small><strong>{percent(quote.discountBps)}</strong></div><div><small>Net unit rate</small><strong>{money(quote.netRateCents)}</strong></div></div><p>Allowed discount: {percent(quote.rule.minDiscountBps)}–{percent(quote.rule.maxDiscountBps)} · Effective {quote.rule.effectiveFrom} to {quote.rule.effectiveTo || 'open ended'}</p><small>Source: {quote.rule.sourceReference}</small></div> : <p className="pricing-empty">No active rate applies on this date. Ask a company admin to create a policy before proposing an exception.</p>)}
          </section>
          <section className="pricing-panel"><div className="pricing-section-head"><div><span className="pricing-eyebrow">02 · EXCEPTION DESK</span><h2>Request an exception</h2></div><span>Approval required for altered rate or out of range discount</span></div>
            {quote?.hasPolicy ? <form className="pricing-form" onSubmit={requestException}>
              <div className="pricing-field-pair"><label>Proposed unit rate (₹)<input required type="number" min="0.01" step="0.01" value={proposal.rateRupees} onChange={event => update(setProposal, 'rateRupees', event.target.value)} /></label><label>Proposed discount (%)<input required type="number" min="0" max="100" step="0.01" value={proposal.discount} onChange={event => update(setProposal, 'discount', event.target.value)} /></label></div>
              <label>Business reason<textarea required maxLength="500" rows="2" value={proposal.reason} onChange={event => update(setProposal, 'reason', event.target.value)} placeholder="Customer agreement or documented exception" /></label>
              <label>Unique request reference<input required maxLength="120" value={proposal.clientReference} onChange={event => update(setProposal, 'clientReference', event.target.value)} placeholder="e.g. RATE-REQ-2026-042" /></label>
              <button disabled={busy}>Submit for decision</button>
            </form> : <p className="pricing-empty">Preview a rate to prepare an exception request.</p>}
          </section>
        </div>
        <div className="pricing-column">
          <section className="pricing-panel"><div className="pricing-section-head"><div><span className="pricing-eyebrow">03 · POLICY BOOK</span><h2>Active rate rules</h2></div><span>{currentRules.length} active</span></div>
            {!currentRules.length && <p className="pricing-empty">No active price rules yet. A company admin can publish the first dated rate.</p>}
            <div className="pricing-rule-list">{currentRules.map(row => <article className="pricing-rule" key={row.id}><div><span className="pricing-tag">{scopeName[row.scope]}</span><small>Rule #{row.id}</small></div><h3>{row.itemId ? itemById[row.itemId]?.name || `Item #${row.itemId}` : 'All items'} <span>·</span> {row.partyId ? partyById[row.partyId]?.name || `Customer #${row.partyId}` : 'All customers'}</h3><div className="pricing-rule-numbers"><strong>{money(row.rateCents)}</strong><span>Default {percent(row.defaultDiscountBps)} · Range {percent(row.minDiscountBps)}–{percent(row.maxDiscountBps)}</span></div><small>{row.effectiveFrom} → {row.effectiveTo || 'No end date'} · {row.sourceReference}</small>{canManage && <button type="button" className="pricing-text-button" disabled={busy} onClick={() => { const reason = window.prompt(`Reason for retiring rule #${row.id}`); if (reason?.trim()) mutate(`/api/pricing/rules/${row.id}/retire`, { reason }, 'Rule retired with an audit entry.'); }}>Retire rule</button>}</article>)}</div>
          </section>
          {canManage && <details className="pricing-panel pricing-create"><summary><span className="pricing-eyebrow">MANAGER CONTROL</span><strong>Create dated rule</strong><small>Rules are immutable; retire and replace to change a rate.</small></summary><form className="pricing-form" onSubmit={createRule}>
            <label>Rule scope<select value={ruleForm.scope} onChange={event => update(setRuleForm, 'scope', event.target.value)}><option value="company">Company</option><option value="item">Item</option><option value="party">Customer</option><option value="party_item">Customer + item</option></select></label>
            {['item', 'party_item'].includes(ruleForm.scope) && <label>Item<select required value={ruleForm.itemId} onChange={event => update(setRuleForm, 'itemId', event.target.value)}><option value="">Select item</option>{masters.items.filter(row => row.active).map(row => <option key={row.id} value={row.id}>{row.sku} · {row.name}</option>)}</select></label>}
            {['party', 'party_item'].includes(ruleForm.scope) && <label>Customer<select required value={ruleForm.partyId} onChange={event => update(setRuleForm, 'partyId', event.target.value)}><option value="">Select customer</option>{masters.parties.map(row => <option key={row.id} value={row.id}>{row.name}</option>)}</select></label>}
            <div className="pricing-field-pair"><label>Unit rate (₹)<input required type="number" min="0.01" step="0.01" value={ruleForm.rateRupees} onChange={event => update(setRuleForm, 'rateRupees', event.target.value)} /></label><label>Default discount (%)<input required type="number" min="0" max="100" step="0.01" value={ruleForm.defaultDiscount} onChange={event => update(setRuleForm, 'defaultDiscount', event.target.value)} /></label></div>
            <div className="pricing-field-pair"><label>Minimum discount (%)<input required type="number" min="0" max="100" step="0.01" value={ruleForm.minDiscount} onChange={event => update(setRuleForm, 'minDiscount', event.target.value)} /></label><label>Maximum discount (%)<input required type="number" min="0" max="100" step="0.01" value={ruleForm.maxDiscount} onChange={event => update(setRuleForm, 'maxDiscount', event.target.value)} /></label></div>
            <div className="pricing-field-pair"><label>Effective from<input required type="date" value={ruleForm.effectiveFrom} onChange={event => update(setRuleForm, 'effectiveFrom', event.target.value)} /></label><label>Effective to<input type="date" value={ruleForm.effectiveTo} onChange={event => update(setRuleForm, 'effectiveTo', event.target.value)} /></label></div>
            <label>Source reference<input required maxLength="160" value={ruleForm.sourceReference} onChange={event => update(setRuleForm, 'sourceReference', event.target.value)} placeholder="Circular or contract reference" /></label><label>Reason<textarea required maxLength="500" rows="2" value={ruleForm.reason} onChange={event => update(setRuleForm, 'reason', event.target.value)} /></label><button disabled={busy}>Publish rule</button>
          </form></details>}
        </div>
      </div>
      <section className="pricing-panel"><div className="pricing-section-head"><div><span className="pricing-eyebrow">04 · DECISION LOG</span><h2>Exception requests</h2></div><span>Branch scoped · source snapshot retained</span></div>
        {!exceptions.length && <p className="pricing-empty">No exception requests are visible for your branch grants.</p>}
        <div className="pricing-exception-list">{[...pending, ...history].map(row => <article className="pricing-exception" key={row.id}><div className="pricing-exception-top"><div><span className={`pricing-status ${row.status}`}>{row.status}</span><strong>{row.clientReference}</strong></div><small>#{row.id} · {row.priceDate} · Branch #{row.branchId}</small></div><p>{partyById[row.partyId]?.name || `Customer #${row.partyId}`} · {itemById[row.itemId]?.name || `Item #${row.itemId}`}</p><div className="pricing-exception-comparison"><span>Policy {money(row.baseline.rateCents)} / {percent(row.baseline.discountBps)}</span><strong>Requested {money(row.proposedRateCents)} / {percent(row.proposedDiscountBps)}</strong></div><small>Reason: {row.reason} · Requested by user #{row.requestedBy}</small>{row.decisionReason && <small>Decision: {row.decisionReason} · User #{row.decidedBy}</small>}{canManage && row.status === 'pending' && String(row.requestedBy) === String(context.userId) && <small>Another company admin must decide your request.</small>}{canManage && row.status === 'pending' && String(row.requestedBy) !== String(context.userId) && <div className="pricing-decision"><input aria-label={`Decision reason for ${row.clientReference}`} placeholder="Decision reason" maxLength="500" value={decisionReason[row.id] || ''} onChange={event => setDecisionReason(previous => ({ ...previous, [row.id]: event.target.value }))} /><button disabled={busy || !decisionReason[row.id]?.trim()} onClick={() => mutate(`/api/pricing/exceptions/${row.id}/decision`, { decision: 'approved', reason: decisionReason[row.id] }, 'Exception approved as an advisory record; invoice prices are unchanged.')}>Approve</button><button className="pricing-secondary" disabled={busy || !decisionReason[row.id]?.trim()} onClick={() => mutate(`/api/pricing/exceptions/${row.id}/decision`, { decision: 'rejected', reason: decisionReason[row.id] }, 'Exception rejected and audited.')}>Reject</button></div>}</article>)}</div>
      </section>
      {canManage && <section className="pricing-panel"><div className="pricing-section-head"><div><span className="pricing-eyebrow">05 · AUDIT</span><h2>Change history</h2></div><button className="pricing-secondary" disabled={busy} onClick={async () => { try { setAudit(await request('/api/pricing/audit')); } catch (cause) { setError(cause.message); } }}>Load audit trail</button></div>{audit && <div className="pricing-audit"><div><h3>Policy events</h3>{audit.ruleEvents.length ? audit.ruleEvents.map(row => <p key={row.id}><strong>{row.action}</strong> · Rule #{row.ruleId} · User #{row.actorId} · {row.createdAt}</p>) : <p>No events.</p>}</div><div><h3>Exception events</h3>{audit.exceptionEvents.length ? audit.exceptionEvents.map(row => <p key={row.id}><strong>{row.action}</strong> · Request #{row.exceptionId} · User #{row.actorId} · {row.createdAt}</p>) : <p>No events.</p>}</div></div>}</section>}
    </>}
  </section>;
}
