import { useCallback, useEffect, useState } from 'react';
import './cashier.css';

const money = value => new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' }).format((Number(value) || 0) / 100);
const today = () => new Date().toISOString().slice(0, 10);
const cents = value => /^\d+(?:\.\d{1,2})?$/.test(String(value).trim()) ? Math.round(Number(value) * 100) : NaN;

export default function Cashier({ context, refresh }) {
  const [sessions, setSessions] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [detail, setDetail] = useState(null);
  const [eligible, setEligible] = useState([]);
  const [date, setDate] = useState(today());
  const [opening, setOpening] = useState('');
  const [paymentId, setPaymentId] = useState('');
  const [payout, setPayout] = useState({ kind: 'expense', amount: '', reference: '', notes: '' });
  const [counted, setCounted] = useState('');
  const [closeNotes, setCloseNotes] = useState('');
  const [review, setReview] = useState({ decision: 'approve', reason: '' });
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);

  const api = useCallback(async (url, init) => {
    const response = await context.apiFetch(url, init);
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
    return data;
  }, [context.apiFetch]);
  const load = useCallback(async (id = selectedId) => {
    setLoading(true);
    try {
      const list = await api(`/api/cashier/sessions?branchId=${context.branchId}`);
      setSessions(list.sessions || []);
      const nextId = id ?? list.sessions?.[0]?.id;
      setSelectedId(nextId ?? null);
      if (nextId) {
        const result = await api(`/api/cashier/sessions/${nextId}`);
        setDetail(result);
      } else setDetail(null);
      setError('');
    } catch (cause) { setError(cause.message); }
    finally { setLoading(false); }
  }, [api, context.branchId, selectedId]);
  useEffect(() => { setSelectedId(null); setDetail(null); load(null); }, [context.companyId, context.branchId, api]);
  useEffect(() => {
    if (!detail?.session || detail.session.status !== 'open') { setEligible([]); return; }
    let active = true;
    api(`/api/cashier/eligible-payments?branchId=${context.branchId}&businessDate=${detail.session.businessDate}`)
      .then(data => { if (active) setEligible(data.payments || []); })
      .catch(cause => { if (active) setError(cause.message); });
    return () => { active = false; };
  }, [api, context.branchId, detail?.session?.id, detail?.session?.status, detail?.session?.businessDate]);
  const act = async (url, body, message, id = selectedId) => {
    setBusy(true); setError(''); setNotice('');
    try {
      const result = await api(url, { method: 'POST', body: JSON.stringify(body) });
      await load(result.session?.id ?? id);
      setNotice(message);
      refresh?.();
    } catch (cause) { setError(cause.message); }
    finally { setBusy(false); }
  };
  const session = detail?.session;
  const isAccountant = ['accountant', 'admin'].includes(context.role);

  return <section className="cash-page" aria-label="Cashier sessions">
    <header className="cash-head"><div><span className="cash-eyebrow">FINANCE / BRANCH CASH</span><h1>Cashier sessions</h1><p>Reconcile recorded cash collections and payouts against a physical count. Payment provider settlement is separate.</p></div><span className="cash-scope">{context.bootstrap?.companies?.find(company => String(company.id) === String(context.companyId))?.branches?.find(branch => String(branch.id) === String(context.branchId))?.name || 'Selected branch'}</span></header>
    {error && <div className="cash-alert error" role="alert">{error}<button type="button" onClick={() => setError('')} aria-label="Dismiss error">×</button></div>}
    {notice && <div className="cash-alert success" role="status">{notice}<button type="button" onClick={() => setNotice('')} aria-label="Dismiss notice">×</button></div>}
    <div className="cash-layout">
      <aside className="cash-card"><h2>Sessions</h2><p className="cash-muted">One cash drawer per branch and business date.</p>
        <form className="cash-form" onSubmit={event => { event.preventDefault(); const amount = cents(opening); if (!Number.isSafeInteger(amount) || amount < 0) return setError('Enter a valid opening amount.'); act('/api/cashier/sessions', { branchId: Number(context.branchId), businessDate: date, openingCashCents: amount }, 'Session opened.'); }}>
          <label>Business date<input type="date" required value={date} onChange={event => setDate(event.target.value)} /></label>
          <label>Opening cash (₹)<input inputMode="decimal" required placeholder="0.00" value={opening} onChange={event => setOpening(event.target.value)} /></label>
          <button className="btn btn-primary" disabled={busy}>Open session</button>
        </form>
        <div className="cash-session-list">{loading && <p>Loading sessions…</p>}{sessions.map(row => <button type="button" key={row.id} className={String(selectedId) === String(row.id) ? 'selected' : ''} onClick={() => load(row.id)}><span><strong>{row.businessDate}</strong><small>{row.branchName}</small></span><span className={`cash-status ${row.status}`}>{row.status.replace('_', ' ')}</span></button>)}{!loading && sessions.length === 0 && <p className="cash-muted">No sessions for this branch.</p>}</div>
      </aside>
      <div className="cash-detail">{!session ? <div className="cash-card cash-empty">Open a session to begin the cash count.</div> : <>
        <div className="cash-card"><div className="cash-title"><div><span className="cash-eyebrow">SESSION #{session.id}</span><h2>{session.businessDate}</h2></div><span className={`cash-status ${session.status}`}>{session.status.replace('_', ' ')}</span></div>
          <div className="cash-metrics"><div><span>Opening</span><strong>{money(session.openingCashCents)}</strong></div><div><span>Collections</span><strong>{money(session.collectionsCents)}</strong></div><div><span>Payouts</span><strong>{money(session.payoutsCents)}</strong></div><div className="cash-expected"><span>Expected close</span><strong>{money(session.expectedCashCents)}</strong></div></div>
          {session.status !== 'open' && <p className="cash-result">Counted {money(session.countedCashCents)} · discrepancy {money(session.discrepancyCents)}{session.reviewNote ? ` · review: ${session.reviewNote}` : ''}</p>}
        </div>
        {session.status === 'open' && <div className="cash-action-grid">
          <div className="cash-card"><h3>Allocate cash receipt</h3><p className="cash-muted">Only cash payments already recorded on approved sales invoices can be attached.</p><form className="cash-form" onSubmit={event => { event.preventDefault(); if (!paymentId) return; act(`/api/cashier/sessions/${session.id}/assignments`, { paymentId: Number(paymentId) }, 'Cash payment attached.'); setPaymentId(''); }}><label>Unassigned cash payment<select required value={paymentId} onChange={event => setPaymentId(event.target.value)}><option value="">Select payment</option>{eligible.map(row => <option key={row.id} value={row.id}>{row.invoiceNumber} · {row.reference} · {money(row.amountCents)}</option>)}</select></label><button className="btn btn-primary" disabled={busy || !paymentId}>Attach payment</button></form>
            <ul className="cash-list">{detail.assignments?.map(row => <li key={row.id}><strong>{money(row.amountCents)}</strong><span>{row.invoiceNumber} · {row.reference}</span></li>)}</ul></div>
          <div className="cash-card"><h3>Record cash payout</h3><form className="cash-form" onSubmit={event => { event.preventDefault(); const amount = cents(payout.amount); if (!Number.isSafeInteger(amount) || amount <= 0) return setError('Enter a positive payout.'); act(`/api/cashier/sessions/${session.id}/payouts`, { kind: payout.kind, amountCents: amount, reference: payout.reference.trim(), notes: payout.notes.trim() }, 'Payout recorded.'); setPayout({ kind: 'expense', amount: '', reference: '', notes: '' }); }}><label>Kind<select value={payout.kind} onChange={event => setPayout({ ...payout, kind: event.target.value })}><option value="expense">Expense</option><option value="refund">Refund</option><option value="transfer">Transfer</option></select></label><label>Amount (₹)<input required inputMode="decimal" value={payout.amount} onChange={event => setPayout({ ...payout, amount: event.target.value })} /></label><label>Reference<input required maxLength="100" value={payout.reference} onChange={event => setPayout({ ...payout, reference: event.target.value })} /></label><label>Notes<input maxLength="500" value={payout.notes} onChange={event => setPayout({ ...payout, notes: event.target.value })} /></label><button className="btn btn-primary" disabled={busy}>Record payout</button></form></div>
          <div className="cash-card cash-close"><h3>Close session</h3><p className="cash-muted">Count the physical cash. A difference requires independent accountant review.</p><form className="cash-form" onSubmit={event => { event.preventDefault(); const amount = cents(counted); if (!Number.isSafeInteger(amount) || amount < 0) return setError('Enter a valid cash count.'); act(`/api/cashier/sessions/${session.id}/close`, { countedCashCents: amount, notes: closeNotes.trim() }, 'Session count submitted.'); }}><label>Counted cash (₹)<input required inputMode="decimal" value={counted} onChange={event => setCounted(event.target.value)} /></label><label>Count note<input value={closeNotes} onChange={event => setCloseNotes(event.target.value)} /></label><button className="btn btn-primary" disabled={busy}>Submit close</button></form></div>
        </div>}
        {session.status === 'pending_review' && <div className="cash-card"><h3>Discrepancy review</h3><p className="cash-muted">The counted amount differs from the expected balance. An accountant who did not close this session must decide.</p>{isAccountant && <form className="cash-form" onSubmit={event => { event.preventDefault(); act(`/api/cashier/sessions/${session.id}/review`, { decision: review.decision, reason: review.reason.trim() }, 'Review recorded.'); }}><label>Decision<select value={review.decision} onChange={event => setReview({ ...review, decision: event.target.value })}><option value="approve">Approve discrepancy</option><option value="reject">Reject close</option></select></label><label>Reason<input required value={review.reason} onChange={event => setReview({ ...review, reason: event.target.value })} /></label><button className="btn btn-primary" disabled={busy}>Record review</button></form>}</div>}
        <div className="cash-card"><h3>Activity trail</h3><ul className="cash-list">{detail.payouts?.map(row => <li key={`p-${row.id}`}><strong>{money(row.amountCents)}</strong><span>{row.kind} · {row.reference}</span></li>)}{detail.events?.map(row => <li key={`e-${row.id}`}><strong>{row.action}</strong><span>{row.details || row.createdAt}</span></li>)}</ul></div>
      </>}</div>
    </div>
  </section>;
}
