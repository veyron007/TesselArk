import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import './return-settlement.css';

const money = cents => new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' }).format((Number(cents) || 0) / 100);
const localDate = () => {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
};
const dateLabel = value => value ? new Date(`${value.slice(0, 10)}T12:00:00`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : '—';

export default function ReturnSettlement({ context = {}, refresh, onOpenInvoice }) {
  const { companyId, branchId, gstinId, userId, role, bootstrap, apiFetch } = context;
  const scopeKey = [companyId, branchId, gstinId, userId].join(':');
  const latestScope = useRef(scopeKey);
  latestScope.current = scopeKey;
  const loadVersion = useRef(0);
  const balanceVersion = useRef(0);
  const [returns, setReturns] = useState([]);
  const [settlements, setSettlements] = useState([]);
  const [loadedScope, setLoadedScope] = useState('');
  const [selectedId, setSelectedId] = useState(null);
  const [balanceSnapshot, setBalanceSnapshot] = useState(null);
  const [settlementDate, setSettlementDate] = useState(localDate);
  const [loading, setLoading] = useState(true);
  const [balanceLoading, setBalanceLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [revision, setRevision] = useState(0);
  const company = bootstrap?.companies?.find(row => String(row.id) === String(companyId));
  const canPost = role === 'accountant' || role === 'admin';
  useEffect(() => { setNotice(''); }, [scopeKey]);

  const request = useCallback(async (path, options) => {
    const response = await apiFetch(path, options);
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
    return data;
  }, [apiFetch]);

  useEffect(() => {
    const version = ++loadVersion.current;
    setLoading(true);
    setError('');
    setReturns([]);
    setSettlements([]);
    setBalanceSnapshot(null);
    if (!companyId || !branchId || !gstinId) { setLoading(false); return undefined; }
    const params = new URLSearchParams({ branchId: String(branchId), gstinId: String(gstinId) });
    Promise.all([request(`/api/returns?${params}`), request('/api/return-settlements')])
      .then(([returnData, settlementData]) => {
        if (version !== loadVersion.current || latestScope.current !== scopeKey) return;
        const records = returnData.returns || [];
        setReturns(records);
        setSettlements(settlementData.settlements || []);
        setLoadedScope(scopeKey);
        setSelectedId(previous => records.some(row => row.id === previous) ? previous : records[0]?.id ?? null);
      })
      .catch(cause => { if (version === loadVersion.current && latestScope.current === scopeKey) { setLoadedScope(scopeKey); setError(cause.message); } })
      .finally(() => { if (version === loadVersion.current && latestScope.current === scopeKey) setLoading(false); });
    return () => { loadVersion.current += 1; };
  }, [companyId, branchId, gstinId, userId, request, revision, scopeKey]);

  const visibleReturns = loadedScope === scopeKey ? returns : [];
  const visibleSettlements = loadedScope === scopeKey ? settlements : [];
  const selected = useMemo(() => visibleReturns.find(row => row.id === selectedId) || null, [visibleReturns, selectedId]);
  const settlementByReturn = useMemo(() => new Map(visibleSettlements.map(row => [row.returnId, row])), [visibleSettlements]);
  const posted = selected ? settlementByReturn.get(selected.id) : null;
  const pendingCount = visibleReturns.filter(row => row.status === 'approved' && !settlementByReturn.has(row.id)).length;
  const postedCount = visibleReturns.filter(row => settlementByReturn.has(row.id)).length;
  const balanceKey = selected ? `${scopeKey}:${selected.invoiceId}` : '';
  const balance = balanceSnapshot?.key === balanceKey ? balanceSnapshot.data : null;

  useEffect(() => {
    const version = ++balanceVersion.current;
    setBalanceSnapshot(null);
    if (!selected) { setBalanceLoading(false); return undefined; }
    setBalanceLoading(true);
    request(`/api/return-settlements/balance?invoiceId=${selected.invoiceId}`)
      .then(data => { if (version === balanceVersion.current && latestScope.current === scopeKey) setBalanceSnapshot({ key:balanceKey, data:data.balance }); })
      .catch(cause => { if (version === balanceVersion.current && latestScope.current === scopeKey) setError(cause.message); })
      .finally(() => { if (version === balanceVersion.current && latestScope.current === scopeKey) setBalanceLoading(false); });
    return () => { balanceVersion.current += 1; };
  }, [balanceKey, request, revision, scopeKey]);

  async function post(event) {
    event.preventDefault();
    if (!selected || !canPost || selected.status !== 'approved' || posted) return;
    const startedScope = scopeKey;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const result = await request('/api/return-settlements', {
        method: 'POST', body: JSON.stringify({ returnId: selected.id, settlementDate }),
      });
      if (latestScope.current !== startedScope) return;
      setNotice(`${selected.number} commercial adjustment posted${result.alreadySettled ? ' previously' : ''}. Tax proposal remains outside GST.`);
      setRevision(value => value + 1);
      refresh?.();
    } catch (cause) { if (latestScope.current === startedScope) setError(cause.message); }
    finally { setBusy(false); }
  }

  const projectedOutstanding = balance && selected && !posted && selected.status === 'approved'
    ? Math.max(0, balance.adjustedTotalCents - selected.subtotalCents - balance.paidCents) : null;
  const projectedRefund = balance && selected && !posted && selected.status === 'approved'
    ? Math.max(0, balance.paidCents - (balance.adjustedTotalCents - selected.subtotalCents)) : null;
  return <section className="rsett-page" aria-label="Commercial return settlement">
    <header className="rsett-head"><div><p className="rsett-eyebrow">FINANCE / RETURNS</p><h1>Return settlements</h1><p>Post the commercial adjustment from an approved return against its source invoice.</p></div><div className="rsett-head-total"><strong>{pendingCount}</strong><span>awaiting posting</span></div></header>
    <div className="rsett-note"><strong>Separate records, separate decisions.</strong> Settlement adjusts receivables or payables by the approved return subtotal. The tax proposal remains pending local review and does not change GST, eligible ITC, or official filing.</div>
    {error && <div className="rsett-alert error" role="alert">{error}<button type="button" onClick={() => setError('')} aria-label="Dismiss error">×</button></div>}
    {notice && <div className="rsett-alert success" role="status">{notice}<button type="button" onClick={() => setNotice('')} aria-label="Dismiss notice">×</button></div>}
    <div className="rsett-stats" aria-label="Return settlement status"><div><span>APPROVED, PENDING</span><strong>{pendingCount}</strong><small>Ready for commercial posting</small></div><div><span>POSTED</span><strong>{postedCount}</strong><small>With source linked journals</small></div><div><span>CURRENT SCOPE</span><strong>{company?.name || 'Selected company'}</strong><small>{company?.branches?.find(row => String(row.id) === String(branchId))?.name || 'Selected branch'} · {company?.gstins?.find(row => String(row.id) === String(gstinId))?.gstin || 'Selected GSTIN'}</small></div></div>
    <div className="rsett-layout">
      <section className="rsett-panel rsett-register" aria-label="Return settlement register"><div className="rsett-panel-head"><div><h2>Return register</h2><p>Approved source notes in the selected branch and GSTIN.</p></div><button type="button" className="rsett-refresh" onClick={() => setRevision(value => value + 1)} disabled={loading}>Refresh</button></div>
        {loading || loadedScope !== scopeKey ? <p className="rsett-empty" role="status">Loading return settlements…</p> : !visibleReturns.length ? <div className="rsett-empty"><strong>No return notes in this scope</strong><p>Create and approve a return against a source invoice first.</p></div> : <div className="rsett-list">{visibleReturns.map(row => {
          const linked = settlementByReturn.get(row.id);
          const state = linked ? 'posted' : row.status === 'approved' ? 'pending' : 'draft';
          return <button key={row.id} type="button" className={`rsett-row ${selectedId === row.id ? 'selected' : ''}`} aria-pressed={selectedId === row.id} onClick={() => { setSelectedId(row.id); setError(''); }}><span className="rsett-row-top"><strong>{row.number}</strong><span className={`rsett-pill ${state}`}>{state}</span></span><span className="rsett-row-meta">{row.invoiceNumber} · {row.partyName}</span><span className="rsett-row-bottom"><span>{row.kind === 'sales_return' ? 'Sales return' : 'Purchase return'} · {row.branchName}</span><strong>{money(row.subtotalCents)}</strong></span></button>;
        })}</div>}
      </section>
      <section className="rsett-panel rsett-detail" aria-label="Selected return settlement">
        {!selected ? <div className="rsett-empty"><strong>Select a return note</strong><p>Review its source invoice, commercial adjustment, and tax proposal before posting.</p></div> : <>
          <div className="rsett-detail-head"><div><p className="rsett-eyebrow">{selected.kind === 'sales_return' ? 'SALES CREDIT' : 'PURCHASE DEBIT'}</p><h2>{selected.number}</h2><p>{selected.partyName} · {dateLabel(selected.invoiceDate)}</p></div><span className={`rsett-pill ${posted ? 'posted' : selected.status === 'approved' ? 'pending' : 'draft'}`}>{posted ? 'posted' : selected.status === 'approved' ? 'pending' : 'draft'}</span></div>
          <div className="rsett-source"><div><span>Source invoice</span><button type="button" onClick={() => onOpenInvoice?.(selected.invoiceId)}>{selected.invoiceNumber} ↗</button></div><div><span>Branch / GSTIN</span><strong>{selected.branchName} · {selected.gstin}</strong></div><div><span>Return reason</span><strong>{selected.reason}</strong></div></div>
          <div className="rsett-amounts"><div><span>Commercial subtotal</span><strong>{money(selected.subtotalCents)}</strong><small>{posted ? 'Posted to the ledger' : 'Amount eligible for commercial posting'}</small></div><div><span>Tax proposal</span><strong>{money(selected.taxProposalCents)}</strong><small>Unposted · separate review</small></div><div><span>Indicative note total</span><strong>{money(selected.totalProposalCents)}</strong><small>Commercial + proposed tax</small></div></div>
          <div className="rsett-balance"><h3>Source invoice balance</h3>{balanceLoading ? <p role="status">Loading balance…</p> : balance ? <><div><span>Invoice total</span><strong>{money(balance.totalCents)}</strong></div><div><span>Paid</span><strong>{money(balance.paidCents)}</strong></div><div><span>Posted commercial adjustments</span><strong>{money(balance.commercialAdjustmentCents)}</strong></div><div className="rsett-balance-primary"><span>Adjusted outstanding</span><strong>{money(balance.outstandingCents)}</strong></div>{balance.refundableCents > 0 && <div className="rsett-balance-primary"><span>Refundable after adjustment</span><strong>{money(balance.refundableCents)}</strong></div>}{projectedOutstanding !== null && <div className="rsett-projection"><span>After posting this return</span><strong>{projectedRefund > 0 ? `${money(projectedRefund)} refundable` : `${money(projectedOutstanding)} outstanding`}</strong></div>}</> : <p>Balance unavailable.</p>}</div>
          {posted ? <div className="rsett-posted" role="status"><strong>Commercial adjustment posted</strong><span>{dateLabel(posted.settlementDate)} · journal #{posted.journalId || 'pending'} · {money(posted.amountCents)}</span><small>Tax {money(posted.taxProposalCents)} excluded from this journal.</small></div> : selected.status !== 'approved' ? <p className="rsett-readonly">Approve this return in Returns before commercial settlement.</p> : canPost ? <form className="rsett-form" onSubmit={post}><label>Settlement date<input type="date" required min={selected.invoiceDate} value={settlementDate} onChange={event => setSettlementDate(event.target.value)} /></label><button type="submit" disabled={busy || balanceLoading || !balance || !settlementDate || settlementDate < selected.invoiceDate}>{busy ? 'Posting…' : `Post ${money(selected.subtotalCents)} adjustment`}</button><small>A journal and balance adjustment will be recorded once. Tax remains separate.</small></form> : <p className="rsett-readonly">Choose an accountant or admin demo role to post the commercial adjustment.</p>}
        </>}
      </section>
    </div>
  </section>;
}
