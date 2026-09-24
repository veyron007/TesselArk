import { useEffect, useRef, useState } from 'react';
import './workspace-menu.css';

function formatRole(role) {
  return role ? role.replace(/_/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase()) : 'Workspace member';
}

export default function WorkspaceMenu({
  authMode, user, users, company, companies, selection, onSelectionChange,
  apiFetch, onNavigate, activePage, scopeReady, refreshKey, signOut, signOutBusy,
}) {
  const [open, setOpen] = useState(false);
  const [work, setWork] = useState(null);
  const [workError, setWorkError] = useState('');
  const [workRetry, setWorkRetry] = useState(0);
  const rootRef = useRef(null);
  const triggerRef = useRef(null);
  const closeRef = useRef(null);
  const previousContext = useRef(null);
  const name = user?.name || 'User';
  const role = user?.role || selection.role;
  const canReviewWork = role === 'accountant' || role === 'admin';
  const currentGstin = company?.gstins?.find((item) => String(item.id) === String(selection.gstinId));
  const currentBranch = company?.branches?.find((item) => String(item.id) === String(selection.branchId));
  const branches = company?.branches?.filter((item) => String(item.gstinId) === String(selection.gstinId)) ?? [];
  const contextKey = [activePage, selection.companyId, selection.userId, selection.gstinId, selection.branchId].join(':');

  useEffect(() => {
    if (previousContext.current !== null && previousContext.current !== contextKey) setOpen(false);
    previousContext.current = contextKey;
  }, [contextKey]);

  useEffect(() => {
    if (!open) return undefined;
    const frame = requestAnimationFrame(() => closeRef.current?.focus());
    const onKeyDown = (event) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      setOpen(false);
      triggerRef.current?.focus();
    };
    const onPointerDown = (event) => {
      if (!rootRef.current?.contains(event.target)) setOpen(false);
    };
    const onFocusIn = (event) => {
      if (!rootRef.current?.contains(event.target)) setOpen(false);
    };
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('focusin', onFocusIn);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('focusin', onFocusIn);
    };
  }, [open]);

  useEffect(() => {
    if (!open || !scopeReady || !canReviewWork || !selection.gstinId || !selection.branchId) return undefined;
    const controller = new AbortController();
    setWork(null);
    setWorkError('');
    const params = new URLSearchParams({ gstinId: String(selection.gstinId), branchId: String(selection.branchId) });
    apiFetch(`/api/workspace-menu?${params}`, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) {
          const detail = await response.json().catch(() => ({}));
          throw new Error(detail.error || detail.message || `Could not load work (${response.status})`);
        }
        return response.json();
      })
      .then((data) => {
        if (!Number.isInteger(data?.work?.submittedInvoices) || data.work.submittedInvoices < 0
          || !Number.isInteger(data.work.pendingTaxPolicies) || data.work.pendingTaxPolicies < 0) {
          throw new Error('Work counts were unavailable. Try again.');
        }
        if (!controller.signal.aborted) setWork(data.work);
      })
      .catch((error) => {
        if (!controller.signal.aborted) setWorkError(error.message || 'Could not load work.');
      });
    return () => controller.abort();
  }, [open, scopeReady, canReviewWork, selection.gstinId, selection.branchId, apiFetch, refreshKey, workRetry]);

  const navigate = (page) => {
    setOpen(false);
    onNavigate(page);
  };

  return <div className="workspace-menu" ref={rootRef}>
    <button
      ref={triggerRef}
      className="workspace-menu-trigger"
      type="button"
      aria-label={`${name}, ${formatRole(role)}. Workspace and account menu`}
      aria-expanded={open}
      aria-controls={open ? 'workspace-menu-panel' : undefined}
      onClick={() => setOpen((value) => !value)}
    >
      <span className="topbar-user"><strong>{name}</strong><small>{formatRole(role)}</small></span>
      <span className="avatar" aria-hidden="true">{name.slice(0, 1).toUpperCase()}</span>
      <span className={`workspace-menu-chevron ${open ? 'is-open' : ''}`} aria-hidden="true">⌄</span>
    </button>

    {open && <section id="workspace-menu-panel" className="workspace-menu-panel" role="dialog" aria-label="Workspace and account">
      <div className="workspace-menu-header">
        <span className="workspace-menu-avatar" aria-hidden="true">{name.slice(0, 1).toUpperCase()}</span>
        <div><strong>{name}</strong><span>{formatRole(role)}{authMode === 'demo' ? ' · Demo user' : ''}</span></div>
        <button ref={closeRef} className="workspace-menu-close" type="button" aria-label="Close workspace menu" onClick={() => { setOpen(false); triggerRef.current?.focus(); }}>×</button>
      </div>
      <div className="workspace-menu-section">
        <span className="workspace-menu-kicker">YOUR WORKSPACE</span>
        <strong className="workspace-menu-company">{company?.name || 'No company selected'}</strong>
        <p className="workspace-menu-scope">{currentGstin?.gstin || 'No GSTIN'} <span aria-hidden="true">·</span> {currentBranch?.name || 'No branch'}</p>
        <p className="workspace-menu-grants">Access to {company?.gstins?.length ?? 0} GSTIN{company?.gstins?.length === 1 ? '' : 's'} and {company?.branches?.length ?? 0} branch{company?.branches?.length === 1 ? '' : 'es'} in this company</p>
      </div>
      <div className="workspace-menu-section workspace-menu-switches">
        <span className="workspace-menu-kicker">SWITCH CONTEXT</span>
        {authMode === 'demo' && <label>Company
          <select value={selection.companyId} onChange={(event) => onSelectionChange({ companyId: event.target.value })}>
            {companies?.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
          </select>
        </label>}
        <div className="workspace-menu-switch-grid">
          <label>GSTIN
            <select value={selection.gstinId} disabled={!scopeReady} onChange={(event) => onSelectionChange({ gstinId: event.target.value })}>
              {!company?.gstins?.length && <option value="">No permitted GSTIN</option>}
              {(company?.gstins ?? []).map((item) => <option key={item.id} value={item.id}>{item.gstin}</option>)}
            </select>
          </label>
          <label>Branch
            <select value={selection.branchId} disabled={!scopeReady} onChange={(event) => onSelectionChange({ branchId: event.target.value })}>
              {!branches.length && <option value="">No permitted branch</option>}
              {branches.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
            </select>
          </label>
        </div>
        {authMode === 'demo' && <label>Demo role
          <select value={selection.userId} onChange={(event) => onSelectionChange({ userId: event.target.value })}>
            {users.map((item) => <option key={item.id} value={item.id}>{item.name} · {formatRole(item.role)}</option>)}
          </select>
        </label>}
      </div>
      <div className="workspace-menu-section workspace-menu-inbox">
        <button type="button" className="workspace-menu-work-link" onClick={() => navigate('inbox')}>
          <span>Action Inbox<small>Cases and documents in this scope</small></span><span aria-hidden="true">↗</span>
        </button>
      </div>
      {canReviewWork && <div className="workspace-menu-section workspace-menu-work">
        <span className="workspace-menu-kicker">WORK NEEDING ATTENTION</span>
        {!scopeReady ? <p role="status">Loading permitted context…</p> : workError ? <div className="workspace-menu-work-error" role="alert"><span>{workError}</span><button type="button" onClick={() => setWorkRetry((value) => value + 1)}>Retry</button></div> : !work ? <p role="status">Loading work counts…</p> : <>
          <button type="button" className="workspace-menu-work-link" onClick={() => navigate('operations')}><span>Submitted invoices<small>Open Operations</small></span><strong>{work.submittedInvoices}</strong></button>
          <button type="button" className="workspace-menu-work-link" onClick={() => navigate('invoice-checks')}><span>Pending tax policies<small>Open Invoice Checks</small></span><strong>{work.pendingTaxPolicies}</strong></button>
        </>}
      </div>}
      {authMode === 'production' && <div className="workspace-menu-section workspace-menu-footer"><button type="button" onClick={signOut} disabled={signOutBusy}>{signOutBusy ? 'Signing out…' : 'Sign out'} <span aria-hidden="true">↗</span></button></div>}
    </section>}
  </div>;
}
