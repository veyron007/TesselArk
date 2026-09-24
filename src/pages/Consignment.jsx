import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import './consignment.css';

const rupees = cents => new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' }).format(cents / 100);
const paise = value => {
  if (!/^\d+(?:\.\d{1,2})?$/.test(value.trim())) throw new Error('Enter rupees with at most two decimal places.');
  const [whole, fraction = ''] = value.trim().split('.');
  const result = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
  if (result > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Amount exceeds the supported limit.');
  return Number(result);
};
const initialForm = { direction: 'outgoing', partyId: '', itemId: '', reference: '', quantity: '', reason: '' };

export default function Consignment({ context }) {
  const { companyId, gstinId, branchId, userId, bootstrap, apiFetch } = context;
  const company = bootstrap?.companies?.find(row => String(row.id) === String(companyId));
  const gstin = company?.gstins?.find(row => String(row.id) === String(gstinId));
  const branch = company?.branches?.find(row => String(row.id) === String(branchId));
  const user = bootstrap?.users?.find(row => String(row.id) === String(userId));
  const canRecord = ['staff', 'admin'].includes(user?.role);
  const canReview = ['accountant', 'admin'].includes(user?.role);
  const [records, setRecords] = useState([]);
  const [items, setItems] = useState([]);
  const [parties, setParties] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [detail, setDetail] = useState(null);
  const [form, setForm] = useState(initialForm);
  const [evidence, setEvidence] = useState('');
  const [returnQuantity, setReturnQuantity] = useState('');
  const [returnEvidence, setReturnEvidence] = useState('');
  const [settlementQuantity, setSettlementQuantity] = useState('');
  const [settlementPrice, setSettlementPrice] = useState('');
  const [settlementReason, setSettlementReason] = useState('');
  const [reviewReasons, setReviewReasons] = useState({});
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const replayKeys = useRef({});
  const referenceFor = (kind, payload) => {
    const signature = JSON.stringify(payload);
    const prior = replayKeys.current[kind];
    if (prior?.signature === signature) return prior.key;
    const key = crypto.randomUUID();
    replayKeys.current = { ...replayKeys.current, [kind]: { signature, key } };
    return key;
  };
  const clearReference = kind => {
    const { [kind]: _discarded, ...remaining } = replayKeys.current;
    replayKeys.current = remaining;
  };

  const request = useCallback(async (url, options) => {
    const response = await apiFetch(url, options);
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `Consignment request failed (${response.status})`);
    return data;
  }, [apiFetch]);
  const load = useCallback(async () => {
    if (!branchId) return;
    setLoading(true); setError('');
    try {
      const [list, masterItems, masterParties] = await Promise.all([
        request(`/api/consignments?branchId=${encodeURIComponent(branchId)}`),
        request('/api/items'), request('/api/parties'),
      ]);
      setRecords(list.consignments); setItems(masterItems.items.filter(item => item.trackStock && item.active));
      setParties(masterParties.parties);
      setSelectedId(current => list.consignments.some(row => row.id === current) ? current : list.consignments[0]?.id || null);
    } catch (cause) { setError(cause.message); setRecords([]); setSelectedId(null); }
    finally { setLoading(false); }
  }, [branchId, request]);
  useEffect(() => { setSelectedId(null); setDetail(null); setForm(initialForm); setNotice(''); load(); }, [companyId, gstinId, branchId, load]);
  useEffect(() => {
    if (!selectedId) { setDetail(null); return; }
    let active = true;
    setDetailLoading(true);
    request(`/api/consignments/${selectedId}`).then(data => { if (active) setDetail(data); })
      .catch(cause => { if (active) { setError(cause.message); setDetail(null); } })
      .finally(() => { if (active) setDetailLoading(false); });
    return () => { active = false; };
  }, [selectedId, request]);
  const selected = detail?.consignment;
  const eligibleParties = useMemo(() => parties.filter(party => form.direction === 'incoming'
    ? ['supplier', 'both'].includes(party.type) : ['customer', 'both'].includes(party.type)), [parties, form.direction]);
  const setField = (field, value) => setForm(current => ({ ...current, [field]: value,
    ...(field === 'direction' ? { partyId: '' } : {}) }));
  const act = async (action, message) => {
    setBusy(true); setError(''); setNotice('');
    try {
      const result = await action();
      await load();
      if (result?.consignment?.id) setSelectedId(result.consignment.id);
      if (result?.consignment?.id) setDetail(await request(`/api/consignments/${result.consignment.id}`));
      setNotice(message);
      return true;
    } catch (cause) { setError(cause.message); return false; }
    finally { setBusy(false); }
  };
  const create = event => { event.preventDefault(); act(async () => {
    const data = await request('/api/consignments', { method: 'POST', body: JSON.stringify({
      gstinId: Number(gstinId), branchId: Number(branchId), partyId: Number(form.partyId), itemId: Number(form.itemId),
      direction: form.direction, reference: form.reference.trim(), quantity: Number(form.quantity), reason: form.reason.trim(),
    }) });
    setForm(initialForm); return data;
  }, 'Consignment recorded as a draft.'); };
  const activate = async event => { event.preventDefault(); const succeeded = await act(() => request(`/api/consignments/${selected.id}/activate`,
    { method: 'POST', body: JSON.stringify({ evidenceReference: evidence.trim() }) }),
    selected.direction === 'outgoing' ? 'Dispatch recorded; company ownership remains unchanged.' : 'Receipt recorded as party owned custody.'); if (succeeded) setEvidence(''); };
  const recordReturn = async event => { event.preventDefault(); const payload = { consignmentId: selected.id, quantity: Number(returnQuantity), evidenceReference: returnEvidence.trim() };
    const succeeded = await act(() => request(`/api/consignments/${selected.id}/returns`,
      { method: 'POST', body: JSON.stringify({ quantity: payload.quantity, evidenceReference: payload.evidenceReference,
        clientReference: referenceFor('return', payload) }) }), 'Unsold return recorded in custody history.');
    if (succeeded) { clearReference('return'); setReturnQuantity(''); setReturnEvidence(''); } };
  const propose = async event => { event.preventDefault(); let proposedUnitPriceCents;
    try { proposedUnitPriceCents = paise(settlementPrice); } catch (cause) { setError(cause.message); return; }
    const payload = { consignmentId: selected.id, quantity: Number(settlementQuantity),
      proposedUnitPriceCents, reason: settlementReason.trim() };
    const succeeded = await act(() => request(`/api/consignments/${selected.id}/settlements`,
      { method: 'POST', body: JSON.stringify({ quantity: payload.quantity, proposedUnitPriceCents: payload.proposedUnitPriceCents,
        reason: payload.reason, clientReference: referenceFor('settlement', payload) }) }), 'Settlement proposed for independent review.');
    if (succeeded) { clearReference('settlement'); setSettlementQuantity(''); setSettlementPrice(''); setSettlementReason(''); } };
  const review = (settlementId, decision) => act(() => request(`/api/consignments/${selected.id}/settlements/${settlementId}/review`,
    { method: 'POST', body: JSON.stringify({ decision, reason: reviewReasons[settlementId]?.trim() || '' }) }),
    decision === 'approve' ? 'Proposal reviewed. Commercial, tax and ledger documents remain pending.' : 'Settlement proposal rejected.');

  return <main className="consignment-page">
    <header className="consignment-hero"><div><span className="consignment-kicker">INVENTORY / CUSTODY DESK</span><h1>Consignment</h1><p>Track who owns the goods, who holds them, and what still needs commercial review.</p></div><button type="button" onClick={load} disabled={loading || busy}>Refresh register</button></header>
    <div className="consignment-scope"><span>Company <strong>{company?.name || '—'}</strong></span><span>GSTIN <strong>{gstin?.gstin || '—'}</strong></span><span>Branch <strong>{branch?.name || '—'}</strong></span><span>Acting as <strong>{user?.name || '—'} · {user?.role || '—'}</strong></span></div>
    <p className="consignment-guidance">Custody and ownership are separate. Incoming receipts and unsold returns never enter owned stock. Outgoing dispatch and return adjust only unbatched saleable physical stock. Settlement approval is an internal proposal review; invoice, tax, ledger and ownership transfer remain pending separate documents.</p>
    {error && <div className="consignment-alert error" role="alert">{error}</div>}{notice && <div className="consignment-alert success" role="status">{notice}</div>}
    <div className="consignment-layout">
      <section className="consignment-card consignment-register"><div className="consignment-title"><h2>Custody register</h2><span>{records.length} records</span></div>
        {loading ? <p className="consignment-empty">Loading consignments…</p> : !records.length ? <p className="consignment-empty">No consignments for this branch. Create a draft to begin.</p> : <div className="consignment-list">{records.map(row => <button key={row.id} type="button" className={row.id === selectedId ? 'selected' : ''} onClick={() => setSelectedId(row.id)}><span><strong>{row.reference}</strong><small>{row.partyNameSnapshot} · {row.itemNameSnapshot}</small></span><span className="consignment-list-meta"><em>{row.direction}</em><strong>{row.custodyQuantity} / {row.quantity}</strong></span></button>)}</div>}</section>
      <section className="consignment-card"><div className="consignment-title"><h2>New custody record</h2><span>Draft first</span></div>{canRecord ? <form className="consignment-form" onSubmit={create}>
        <label>Direction<select value={form.direction} onChange={event => setField('direction', event.target.value)}><option value="outgoing">Outgoing · company owned</option><option value="incoming">Incoming · party owned</option></select></label>
        <label>Party<select value={form.partyId} onChange={event => setField('partyId', event.target.value)} required><option value="">Select party</option>{eligibleParties.map(party => <option key={party.id} value={party.id}>{party.name}</option>)}</select></label>
        <label>Tracked item<select value={form.itemId} onChange={event => setField('itemId', event.target.value)} required><option value="">Select item</option>{items.map(item => <option key={item.id} value={item.id}>{item.sku} · {item.name}</option>)}</select></label>
        <label>Reference<input value={form.reference} onChange={event => setField('reference', event.target.value)} maxLength="100" required placeholder="CON-2026-001" /></label>
        <label>Quantity<input type="number" min="1" step="1" value={form.quantity} onChange={event => setField('quantity', event.target.value)} required /></label>
        <label className="wide">Reason<textarea value={form.reason} onChange={event => setField('reason', event.target.value)} maxLength="500" required placeholder="Agreement or trial context" /></label>
        <button type="submit" disabled={busy || loading}>Create draft</button>
      </form> : <p className="consignment-empty">A storekeeper or company admin creates custody records.</p>}</section>
    </div>
    {detailLoading && <p className="consignment-empty">Loading custody detail…</p>}
    {selected && <section className="consignment-card consignment-detail"><div className="consignment-title"><div><span className="consignment-kicker">{selected.direction.toUpperCase()} / {selected.status.toUpperCase()}</span><h2>{selected.reference}</h2><p>{selected.partyNameSnapshot} · {selected.itemNameSnapshot}</p></div><span className="consignment-badge">Owner: {selected.ownerKind}</span></div>
      <div className="consignment-metrics"><div><small>Original units</small><strong>{selected.quantity}</strong></div><div><small>Current custody</small><strong>{selected.custodyQuantity}</strong></div><div><small>Unsold returned</small><strong>{selected.returnedQuantity}</strong></div><div><small>Reserved for proposal</small><strong>{selected.settlementReservedQuantity}</strong></div><div><small>Available to return</small><strong>{selected.returnableQuantity}</strong></div></div>
      <p className="consignment-fine">Custodian: {selected.custodian.replaceAll('_', ' ')}. Owner: {selected.ownerKind}. Reviewed settlement proposals reserve units, but do not transfer ownership or post an invoice, tax, or ledger entry.</p>
      <div className="consignment-actions">
        {selected.status === 'draft' && canRecord && <form onSubmit={activate}><h3>{selected.direction === 'outgoing' ? 'Record dispatch' : 'Record receipt'}</h3><label>Evidence reference<input value={evidence} onChange={event => setEvidence(event.target.value)} maxLength="150" required placeholder="Dispatch or goods receipt note" /></label><button type="submit" disabled={busy}>Activate custody</button></form>}
        {selected.status === 'active' && canRecord && <><form onSubmit={recordReturn}><h3>Unsold return</h3><label>Quantity<input type="number" min="1" max={selected.returnableQuantity} step="1" value={returnQuantity} onChange={event => setReturnQuantity(event.target.value)} required /></label><label>Return evidence<input value={returnEvidence} onChange={event => setReturnEvidence(event.target.value)} maxLength="150" required /></label><button type="submit" disabled={busy || !selected.returnableQuantity}>Record return</button></form>
          <form onSubmit={propose}><h3>Settlement proposal</h3><label>Quantity<input type="number" min="1" max={selected.returnableQuantity} step="1" value={settlementQuantity} onChange={event => setSettlementQuantity(event.target.value)} required /></label><label>Proposed unit price · ₹<input inputMode="decimal" value={settlementPrice} onChange={event => setSettlementPrice(event.target.value)} required /></label><label>Reason<textarea value={settlementReason} onChange={event => setSettlementReason(event.target.value)} maxLength="500" required /></label><button type="submit" disabled={busy || !selected.returnableQuantity}>Submit for review</button></form></>}
      </div>
      <div className="consignment-bottom"><section><h3>Settlement review</h3>{detail.settlements.length ? detail.settlements.map(row => <article className="consignment-settlement" key={row.id}><div><strong>#{row.id} · {row.quantity} units · {rupees(row.proposedUnitPriceCents)} each</strong><span className="consignment-badge">{row.status.replaceAll('_', ' ')}</span></div><p>{row.reason}</p><small>Proposed by user #{row.proposedBy}{row.reviewedBy ? ` · Reviewed by user #${row.reviewedBy}: ${row.reviewReason}` : ''}</small>{row.status === 'pending' && canReview && row.proposedBy !== Number(userId) && <div className="consignment-review"><label>Decision reason<input value={reviewReasons[row.id] || ''} onChange={event => setReviewReasons(current => ({ ...current, [row.id]: event.target.value }))} maxLength="500" /></label><button type="button" disabled={busy || !reviewReasons[row.id]?.trim()} onClick={() => review(row.id, 'approve')}>Review proposal</button><button type="button" className="secondary" disabled={busy || !reviewReasons[row.id]?.trim()} onClick={() => review(row.id, 'reject')}>Reject</button></div>}</article>) : <p className="consignment-empty">No settlement proposal yet.</p>}</section>
        <section><h3>Custody history</h3>{detail.events.length ? <ol className="consignment-events">{detail.events.map(row => <li key={row.id}><strong>{row.action.replaceAll('_', ' ')}</strong><span>{row.quantity} units · user #{row.actorId} · {row.createdAt}</span><small>{row.details}</small></li>)}</ol> : <p className="consignment-empty">No custody events yet.</p>}</section></div>
    </section>}
  </main>;
}
