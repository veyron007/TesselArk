import { useCallback, useEffect, useMemo, useState } from 'react';
import './Inbox.css';

const sourceNames = { crm: 'Customer follow-up', invoice: 'Invoice', expense: 'Expense claim', cashier: 'Cash drawer' };
const dateOnly = (value) => value ? new Date(`${value.slice(0, 10)}T12:00:00`) : null;
const dateLabel = (value) => {
  const parsed = dateOnly(value);
  return parsed && !Number.isNaN(parsed.getTime())
    ? parsed.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })
    : 'Not set';
};
const timeLabel = (value) => {
  const parsed = value ? new Date(value) : null;
  return parsed && !Number.isNaN(parsed.getTime())
    ? parsed.toLocaleString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' })
    : 'Time unavailable';
};
const moneyLabel = (cents) => Number.isInteger(cents)
  ? new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 2 }).format(cents / 100)
  : '—';
const printableReason = (value) => value.trim().replace(/\s+/g, ' ');
const tomorrow = () => {
  const date = new Date();
  date.setDate(date.getDate() + 1);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
};
const localToday = () => {
  const date = new Date();
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
};
const isSnoozed = (item) => Boolean(item.snoozedUntil && item.snoozedUntil.slice(0, 10) >= localToday());
const isOverdue = (item) => Boolean(item.dueDate && item.dueDate.slice(0, 10) < localToday());
const safeSourceLink = (value) => {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//')) return null;
  try {
    const url = new URL(value, window.location.origin);
    if (url.origin !== window.location.origin || !/^\/(order-crm|operations|expenses|invoice-checks|cashier)(\/|$)/.test(url.pathname)) return null;
    return `${url.pathname}${url.search}`;
  } catch { return null; }
};

function Status({ item }) {
  if (isSnoozed(item)) return <span className="inbox-status snoozed">Snoozed</span>;
  if (item.escalation?.status === 'requested') return <span className="inbox-status escalated">Escalation requested</span>;
  if (item.acknowledged) return <span className="inbox-status acknowledged">Seen</span>;
  return <span className="inbox-status new">Needs attention</span>;
}

export default function Inbox({ context = {}, refresh }) {
  const { companyId, gstinId, branchId, userId, bootstrap, apiFetch } = context;
  const company = bootstrap?.companies?.find((item) => String(item.id) === String(companyId));
  const gstin = company?.gstins?.find((item) => String(item.id) === String(gstinId));
  const branch = company?.branches?.find((item) => String(item.id) === String(branchId));
  const user = bootstrap?.users?.find((item) => String(item.id) === String(userId));
  const [items, setItems] = useState([]);
  const [counts, setCounts] = useState(null);
  const [selectedId, setSelectedId] = useState(null);
  const [filter, setFilter] = useState('attention');
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [snoozeUntil, setSnoozeUntil] = useState(tomorrow);
  const [escalationReason, setEscalationReason] = useState('');
  const [policies, setPolicies] = useState([]);
  const [policyLoading, setPolicyLoading] = useState(false);
  const [policyError, setPolicyError] = useState('');
  const [policyNotice, setPolicyNotice] = useState('');
  const [policyBusy, setPolicyBusy] = useState(false);
  const [policyForm, setPolicyForm] = useState({ sourceType: 'crm', overdueDays: '0', blockerAllowed: true, reason: '' });
  const isAdmin = context.role === 'admin';

  const request = useCallback(async (path, options = {}) => {
    const response = await apiFetch(path, options);
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || data.message || `Inbox request failed (${response.status})`);
    return data;
  }, [apiFetch]);

  const load = useCallback(async (signal) => {
    if (!gstinId || !branchId) { setLoading(false); setItems([]); setCounts(null); return; }
    setLoading(true);
    setError('');
    const params = new URLSearchParams({ gstinId: String(gstinId), branchId: String(branchId), includeSnoozed: '1' });
    try {
      const result = await request(`/api/inbox?${params}`, { signal });
      if (signal?.aborted) return;
      if (!Array.isArray(result.items)) throw new Error('Inbox data is unavailable. Try again.');
      setItems(result.items);
      setCounts(result.counts || null);
      setSelectedId((current) => result.items.some((item) => item.id === current) ? current : result.items[0]?.id ?? null);
    } catch (cause) {
      if (!signal?.aborted) { setError(cause.message || 'Could not load the inbox.'); setItems([]); setCounts(null); }
    } finally { if (!signal?.aborted) setLoading(false); }
  }, [gstinId, branchId, request]);

  useEffect(() => {
    const controller = new AbortController();
    setSelectedId(null);
    setNotice('');
    setQuery('');
    setFilter('attention');
    load(controller.signal);
    return () => controller.abort();
  }, [companyId, userId, load]);

  const loadPolicies = useCallback(async (signal) => {
    if (!isAdmin) { setPolicies([]); return; }
    setPolicyLoading(true);
    setPolicyError('');
    try {
      const result = await request('/api/inbox/policies', { signal });
      if (!signal?.aborted) setPolicies(Array.isArray(result.policies) ? result.policies : []);
    } catch (cause) {
      if (!signal?.aborted) { setPolicyError(cause.message || 'Could not load policies.'); setPolicies([]); }
    } finally { if (!signal?.aborted) setPolicyLoading(false); }
  }, [isAdmin, request]);
  useEffect(() => {
    const controller = new AbortController();
    setPolicyNotice('');
    loadPolicies(controller.signal);
    return () => controller.abort();
  }, [companyId, userId, loadPolicies]);

  const savePolicy = async (event) => {
    event.preventDefault();
    if (!isAdmin || policyBusy) return;
    setPolicyBusy(true);
    setPolicyError('');
    setPolicyNotice('');
    try {
      await request('/api/inbox/policies', { method: 'POST', body: JSON.stringify({
        sourceType: policyForm.sourceType, overdueDays: Number(policyForm.overdueDays),
        blockerAllowed: policyForm.blockerAllowed, reason: printableReason(policyForm.reason),
      }) });
      setPolicyNotice(`Escalation policy saved for ${sourceNames[policyForm.sourceType]}. Eligible threads can now request independent review.`);
      setPolicyForm((current) => ({ ...current, reason: '' }));
      await Promise.all([loadPolicies(), load()]);
    } catch (cause) { setPolicyError(cause.message || 'Could not save policy.'); }
    finally { setPolicyBusy(false); }
  };

  const visible = useMemo(() => items.filter((item) => {
    if (filter === 'attention' && (item.acknowledged || isSnoozed(item))) return false;
    if (filter === 'snoozed' && !isSnoozed(item)) return false;
    if (filter === 'all' && isSnoozed(item)) return false;
    const text = `${item.title || ''} ${item.summary || ''} ${item.owner?.name || ''} ${item.blocker || ''} ${sourceNames[item.sourceType] || ''}`.toLowerCase();
    return text.includes(query.trim().toLowerCase());
  }), [items, filter, query]);
  const selected = visible.find((item) => item.id === selectedId) || visible[0] || null;
  const events = Array.isArray(selected?.events) ? selected.events : [];

  const takeAction = async (action, payload = {}) => {
    if (!selected || busy) return;
    setBusy(action);
    setError('');
    setNotice('');
    try {
      const path = `/api/inbox/${encodeURIComponent(selected.sourceType)}/${encodeURIComponent(selected.sourceId)}/${action}`;
      await request(path, { method: 'POST', body: JSON.stringify({ expectedRevision: selected.sourceRevision, ...payload }) });
      setNotice(action === 'acknowledge' ? 'Thread marked as seen. Its source work is still open.'
        : action === 'snooze' ? `Thread snoozed until ${dateLabel(payload.until)}. Its due date and source work have not changed.`
          : 'Escalation recorded in this thread. Its source work is still open.');
      if (action === 'escalate') setEscalationReason('');
      await load();
      refresh?.();
    } catch (cause) {
      setError(cause.message || 'Could not update this thread.');
    } finally { setBusy(''); }
  };

  return <div className="inbox-page">
    <header className="inbox-hero">
      <div><span className="inbox-eyebrow">WORKSPACE · WORK-03</span><h1>Action inbox</h1><p>One thread for each case or document. See what changed, who owns the next step, and where to continue.</p></div>
      <div className="inbox-hero-scope"><span>VIEWING</span><strong>{company?.name || 'Company'}</strong><small>{gstin?.gstin || 'GSTIN'} <span aria-hidden="true">·</span> {branch?.name || 'Branch'}</small><small>{user?.name || 'Workspace member'}</small></div>
    </header>
    <div className="inbox-boundary"><span aria-hidden="true">✦</span><p>Inbox actions manage attention only. Acknowledging, snoozing or escalating a thread does not approve a transaction, settle a claim, sign a return or file with a portal.</p></div>
    {error && <div className="inbox-message error" role="alert">{error} <button type="button" onClick={() => load()}>Retry</button></div>}
    {notice && <div className="inbox-message success" role="status">{notice}</div>}
    <div className="inbox-metrics" aria-label="Inbox summary">
      <div><span>IN SCOPE</span><strong>{counts?.total ?? '—'}</strong><small>Case and document threads</small></div>
      <div><span>UNSEEN CHANGES</span><strong>{counts?.unacknowledged ?? '—'}</strong><small>Including snoozed threads</small></div>
      <div><span>PAST DUE</span><strong>{counts?.overdue ?? '—'}</strong><small>Based on source due dates</small></div>
      <div><span>SNOOZED</span><strong>{counts?.snoozed ?? '—'}</strong><small>Temporarily out of view</small></div>
    </div>
    <div className="inbox-layout">
      <section className="inbox-list-panel" aria-label="Threads">
        <div className="inbox-panel-head"><div><span className="inbox-eyebrow">YOUR QUEUE</span><h2>Threads</h2></div><button className="inbox-refresh" type="button" onClick={() => load()} disabled={loading || Boolean(busy)} aria-label="Refresh inbox">↻ <span>Refresh</span></button></div>
        <div className="inbox-controls">
          <div className="inbox-tabs" role="group" aria-label="Filter threads">
            {[['attention', 'Needs attention'], ['all', 'All active'], ['snoozed', 'Snoozed']].map(([value, label]) => <button key={value} type="button" aria-pressed={filter === value} onClick={() => setFilter(value)}>{label}</button>)}
          </div>
          <label className="inbox-search"><span className="sr-only">Search threads</span><span aria-hidden="true">⌕</span><input type="search" placeholder="Search threads" value={query} onChange={(event) => setQuery(event.target.value)} /></label>
        </div>
        {loading ? <div className="inbox-list-empty" role="status">Loading threads for this branch…</div>
          : !visible.length ? <div className="inbox-list-empty"><strong>{items.length ? 'No threads match this view' : 'No threads in this scope'}</strong><span>{items.length ? 'Try a different filter or search term.' : 'New case and document activity will appear here.'}</span></div>
            : <div className="inbox-list">{visible.map((item) => <button key={item.id} type="button" className={`inbox-thread ${selected?.id === item.id ? 'selected' : ''}`} onClick={() => { setSelectedId(item.id); setNotice(''); }} aria-current={selected?.id === item.id ? 'true' : undefined}>
              <span className="inbox-thread-top"><span className="inbox-source">{sourceNames[item.sourceType] || 'Source record'}</span><span className="inbox-thread-date">{dateLabel(item.updatedAt)}</span></span>
              <span className="inbox-thread-title">{item.title || 'Untitled thread'}</span><span className="inbox-thread-summary">{item.summary || 'No summary available.'}</span>
              <span className="inbox-thread-foot"><Status item={item} /><span>{item.owner?.name || 'Unassigned'}</span>{item.dueDate && <span className={isOverdue(item) ? 'inbox-due-overdue' : ''}>Due {dateLabel(item.dueDate)}</span>}</span>
            </button>)}</div>}
      </section>
      <section className="inbox-detail-panel" aria-label="Selected thread details">
        {!selected ? <div className="inbox-detail-empty"><span aria-hidden="true">▤</span><h2>Select a thread</h2><p>Its source timeline, blocker and available attention actions will appear here.</p></div> : <>
          <div className="inbox-detail-heading"><div><span className="inbox-eyebrow">{sourceNames[selected.sourceType] || 'SOURCE RECORD'} · #{selected.sourceId}</span><h2>{selected.title}</h2><p>{selected.summary}</p></div><Status item={selected} /></div>
          <div className="inbox-detail-meta">
            <div><span>OWNER</span><strong>{selected.owner?.name || 'Unassigned'}</strong></div>
            <div><span>AMOUNT</span><strong>{moneyLabel(selected.amountCents)}</strong></div>
            <div><span>DUE DATE</span><strong className={isOverdue(selected) ? 'inbox-due-overdue' : ''}>{dateLabel(selected.dueDate)}</strong></div>
            <div><span>LAST CHANGE</span><strong>{timeLabel(selected.updatedAt)}</strong></div>
          </div>
          <div className="inbox-next-step"><div><span className="inbox-eyebrow">NEXT PERMITTED ACTION</span><strong>{selected.permittedAction || 'Review the source record'}</strong>{selected.blocker && <p><b>Blocker:</b> {selected.blocker}</p>}</div>{safeSourceLink(selected.deepLink) && <a href={safeSourceLink(selected.deepLink)}>Open source <span aria-hidden="true">↗</span></a>}</div>
          {selected.escalation?.status === 'requested' && <div className="inbox-escalation"><strong>Independent review requested {timeLabel(selected.escalation.escalatedAt)}</strong>{selected.escalation.target?.name && <span>Assigned reviewer: {selected.escalation.target.name}</span>}{selected.escalation.reason && <span>Reason: {selected.escalation.reason}</span>}</div>}
          <div className="inbox-history-head"><div><span className="inbox-eyebrow">SOURCE HISTORY</span><h3>Thread timeline</h3></div><span>{events.length} event{events.length === 1 ? '' : 's'}</span></div>
          {events.length ? <ol className="inbox-timeline">{events.map((event, index) => <li key={event.id ?? `${event.at}-${index}`}><span className="inbox-timeline-dot" aria-hidden="true" /><div><strong>{event.kind || 'Update'}</strong><p>{event.detail || 'Source event recorded.'}</p><small>{event.actorName || 'System'} · {event.at ? timeLabel(event.at) : 'Timestamp not recorded'}</small></div></li>)}</ol> : <p className="inbox-history-empty">No source events are available for this thread.</p>}
          <div className="inbox-action-box"><div className="inbox-action-head"><div><span className="inbox-eyebrow">MANAGE ATTENTION</span><h3>Keep the thread moving</h3></div><span>Source work remains separate</span></div>
            <div className="inbox-action-grid">
              <div className="inbox-action-tile"><strong>Mark as seen</strong><p>Records that you reviewed this revision. A later source change will need fresh attention.</p><button type="button" disabled={Boolean(busy) || selected.acknowledged} onClick={() => takeAction('acknowledge')}>{selected.acknowledged ? 'Seen for this revision' : busy === 'acknowledge' ? 'Saving…' : 'Acknowledge'}</button></div>
              <form className="inbox-action-tile" onSubmit={(event) => { event.preventDefault(); takeAction('snooze', { until: snoozeUntil }); }}><strong>Snooze</strong><p>Temporarily hide this thread. Its source due date stays the same.</p><label>Show again on<input type="date" required min={tomorrow()} value={snoozeUntil} onChange={(event) => setSnoozeUntil(event.target.value)} /></label><button type="submit" disabled={Boolean(busy)}>{busy === 'snooze' ? 'Saving…' : 'Snooze thread'}</button></form>
              <form className="inbox-action-tile" onSubmit={(event) => { event.preventDefault(); takeAction('escalate', { reason: printableReason(escalationReason) }); }}><strong>Request independent review</strong><p>Record why this needs attention under an admin approved escalation policy.</p>{!selected.canEscalate && <div className="inbox-action-unavailable">{selected.escalationUnavailableReason || 'No active approved policy applies to this thread.'}</div>}<label>Reason<textarea required maxLength="500" rows="2" value={escalationReason} onChange={(event) => setEscalationReason(event.target.value)} placeholder="Explain the blocker or risk" disabled={!selected.canEscalate} /></label><button type="submit" disabled={Boolean(busy) || !selected.canEscalate || !escalationReason.trim()}>{busy === 'escalate' ? 'Saving…' : 'Request escalation'}</button></form>
            </div>
          </div>
        </>}
      </section>
    </div>
    {isAdmin && <section className="inbox-policy-panel" aria-label="Escalation policies">
      <div className="inbox-policy-heading"><div><span className="inbox-eyebrow">ADMIN CONTROLS</span><h2>Escalation policies</h2><p>Approve when a source type may request independent review. A policy never approves the source document or case.</p></div><span>{policies.length} active</span></div>
      {policyError && <div className="inbox-message error" role="alert">{policyError}<button type="button" onClick={() => loadPolicies()}>Retry</button></div>}
      {policyNotice && <div className="inbox-message success" role="status">{policyNotice}</div>}
      <div className="inbox-policy-layout"><div className="inbox-policy-list"><h3>Current company policies</h3>{policyLoading ? <p role="status">Loading policies…</p> : policies.length ? policies.map((policy) => <div className="inbox-policy-row" key={policy.id}><div><strong>{sourceNames[policy.sourceType] || policy.sourceType}</strong><span>{policy.blockerAllowed ? 'Blocker eligible' : 'No blocker trigger'} · {policy.overdueDays} overdue day{policy.overdueDays === 1 ? '' : 's'}</span><small>Approved {timeLabel(policy.approvedAt)}{policy.approvedBy ? ` · by user #${policy.approvedBy}` : ''}</small></div><p>{policy.reason}</p></div>) : <p>No escalation policy has been approved for this company.</p>}</div>
        <form className="inbox-policy-form" onSubmit={savePolicy}><h3>Approve or replace policy</h3><p>Choose the source type and threshold. The server assigns an independent eligible reviewer when an escalation is requested.</p><label>Source type<select value={policyForm.sourceType} onChange={(event) => setPolicyForm((current) => ({ ...current, sourceType: event.target.value }))}>{Object.entries(sourceNames).map(([value, name]) => <option key={value} value={value}>{name}</option>)}</select></label><label>Overdue days<input type="number" min="0" max="365" step="1" required value={policyForm.overdueDays} onChange={(event) => setPolicyForm((current) => ({ ...current, overdueDays: event.target.value }))} /></label><label className="inbox-policy-check"><input type="checkbox" checked={policyForm.blockerAllowed} onChange={(event) => setPolicyForm((current) => ({ ...current, blockerAllowed: event.target.checked }))} /> Allow a recorded blocker to trigger review</label><label>Approval reason<textarea required maxLength="500" rows="3" value={policyForm.reason} onChange={(event) => setPolicyForm((current) => ({ ...current, reason: event.target.value }))} placeholder="Why this policy is appropriate for this company" /></label><button type="submit" disabled={policyBusy || !policyForm.reason.trim()}>{policyBusy ? 'Saving policy…' : 'Approve policy'}</button></form></div>
    </section>}
  </div>;
}
