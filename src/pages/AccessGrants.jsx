import { useCallback, useEffect, useMemo, useState } from 'react';
import './access-grants.css';

export default function AccessGrants({ context }) {
  const { companyId, userId, role, apiFetch } = context;
  const [data, setData] = useState(null);
  const [targetId, setTargetId] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const request = useCallback(async (path, options) => {
    const response = await apiFetch(path, options);
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || `Request failed (${response.status})`);
    return result;
  }, [apiFetch]);
  const reload = useCallback(async () => {
    const result = await request('/api/access/grants');
    setData(result);
    setTargetId(previous => result.users.some(user => String(user.id) === String(previous)) ? previous : String(result.users[0]?.id || ''));
  }, [request]);
  useEffect(() => {
    let live = true;
    setData(null); setError(''); setNotice('');
    request('/api/access/grants').then(result => {
      if (!live) return;
      setData(result);
      setTargetId(String(result.users[0]?.id || ''));
    }).catch(cause => { if (live) setError(cause.message); });
    return () => { live = false; };
  }, [companyId, userId, request]);
  const target = useMemo(() => data?.users.find(user => String(user.id) === String(targetId)), [data, targetId]);

  async function change(scope, scopeId, granted) {
    if (!reason.trim()) { setError('Record a reason before changing access.'); return; }
    const key = `${scope}:${scopeId}`;
    setBusy(key); setError(''); setNotice('');
    try {
      await request(`/api/access/grants/${scope}/${granted ? 'revoke' : 'grant'}`, {
        method: 'POST', body: JSON.stringify({ userId:target.id, scopeId, reason:reason.trim() }),
      });
      await reload();
      setNotice(`${granted ? 'Revoked' : 'Granted'} ${scope.toUpperCase()} access for ${target.name}.`);
      setReason('');
    } catch (cause) { setError(cause.message); }
    finally { setBusy(''); }
  }

  return <div className="access-page">
    <header className="access-hero"><div><p className="access-eyebrow">IDENTITY & PERMISSIONS</p><h1>Access grants</h1><p>Assign each demo user to the exact GSTINs and branches they may use. Changes take effect on the next request and remain in the audit trail.</p></div><span>Company #{companyId}</span></header>
    {role !== 'admin' ? <div className="access-alert" role="alert">A company admin is required to manage grants.</div> : <>
      {error && <div className="access-alert" role="alert">{error}</div>}
      {notice && <div className="access-alert access-success" role="status">{notice}</div>}
      {!data ? <p className="access-empty">Loading access grants…</p> : <>
        <section className="access-card access-controls"><label>Demo user<select value={targetId} onChange={event => setTargetId(event.target.value)}>{data.users.map(user => <option key={user.id} value={user.id}>{user.name} · {user.role}</option>)}</select></label><label>Reason for change<input value={reason} onChange={event => setReason(event.target.value)} maxLength={500} placeholder="Required for every grant or revocation" /></label></section>
        <div className="access-columns"><section className="access-card"><h2>GST registrations</h2><p>Grant a GSTIN before granting one of its branches.</p><div className="access-rows">{data.gstins.map(gstin => { const granted = target?.gstinIds.includes(gstin.id); return <div key={gstin.id} className="access-row"><div><strong>{gstin.gstin}</strong><small>{gstin.state_code}</small></div><button type="button" className={granted ? 'granted' : ''} disabled={Boolean(busy) || !reason.trim()} onClick={() => change('gstin', gstin.id, granted)}>{busy === `gstin:${gstin.id}` ? 'Saving…' : granted ? 'Revoke' : 'Grant'}</button></div>; })}</div></section>
          <section className="access-card"><h2>Branches</h2><p>Branch access also requires its parent GSTIN grant.</p><div className="access-rows">{data.branches.map(branch => { const granted = target?.branchIds.includes(branch.id); const parent = target?.gstinIds.includes(branch.gstin_id); return <div key={branch.id} className="access-row"><div><strong>{branch.name}</strong><small>{data.gstins.find(item => item.id === branch.gstin_id)?.gstin || 'GSTIN'}</small></div><button type="button" className={granted ? 'granted' : ''} disabled={Boolean(busy) || !reason.trim() || (!granted && !parent)} onClick={() => change('branch', branch.id, granted)}>{busy === `branch:${branch.id}` ? 'Saving…' : granted ? 'Revoke' : 'Grant'}</button></div>; })}</div></section></div>
        <section className="access-card"><h2>Recent changes</h2><div className="access-history">{data.events.length ? data.events.map(event => <div key={event.id}><strong>{event.action} {event.scope_type} #{event.scope_id}</strong><span>User #{event.user_id} · by {event.actor_id ? `user #${event.actor_id}` : 'initial seed'} · {event.created_at}</span><small>{event.reason}</small></div>) : <p>No access changes yet.</p>}</div></section>
      </>}
    </>}
  </div>;
}
