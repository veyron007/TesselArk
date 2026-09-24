import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import WorkspaceIcon, { BrandMark } from './components/WorkspaceIcon.jsx';
import Dashboard from './components/PrismDashboard.jsx';
import { readWorkspaceRoute, readWorkspaceScope, resolveWorkspaceScope, workspaceUrl } from './workspace-route.js';
const Operations = lazy(() => import('./pages/Operations.jsx'));
const Orders = lazy(() => import('./pages/Orders.jsx'));
const BatchInventory = lazy(() => import('./pages/BatchInventory.jsx'));
const Locations = lazy(() => import('./pages/Locations.jsx'));
const Conversion = lazy(() => import('./pages/Conversion.jsx'));
const Catalogue = lazy(() => import('./pages/Catalogue.jsx'));
const Counts = lazy(() => import('./pages/Counts.jsx'));
const Pricing = lazy(() => import('./pages/Pricing.jsx'));
const CreditControls = lazy(() => import('./pages/CreditControls.jsx'));
const Consignment = lazy(() => import('./pages/Consignment.jsx'));
const PriceAdjustments = lazy(() => import('./pages/PriceAdjustments.jsx'));
const SupplierComparison = lazy(() => import('./pages/SupplierComparison.jsx'));
const OrderCrm = lazy(() => import('./pages/OrderCrm.jsx'));
const Bundles = lazy(() => import('./pages/Bundles.jsx'));
const Budgets = lazy(() => import('./pages/Budgets.jsx'));
const Delivery = lazy(() => import('./pages/Delivery.jsx'));
const DocumentOutput = lazy(() => import('./pages/DocumentOutput.jsx'));
const MasterImport = lazy(() => import('./pages/MasterImport.jsx'));
const Finance = lazy(() => import('./pages/Finance.jsx'));
const Cashier = lazy(() => import('./pages/Cashier.jsx'));
const Reporting = lazy(() => import('./pages/Reporting.jsx'));
const Accounting = lazy(() => import('./pages/Accounting.jsx'));
const BankReconciliation = lazy(() => import('./pages/BankReconciliation.jsx'));
const Returns = lazy(() => import('./pages/Returns.jsx'));
const EvidenceLibrary = lazy(() => import('./pages/EvidenceLibrary.jsx'));
const ReturnTaxReview = lazy(() => import('./pages/ReturnTaxReview.jsx'));
const ReturnSettlement = lazy(() => import('./pages/ReturnSettlement.jsx'));
const ReturnInspection = lazy(() => import('./pages/ReturnInspection.jsx'));
const Gst = lazy(() => import('./pages/Gst.jsx'));
const InvoiceChecks = lazy(() => import('./pages/InvoiceChecks.jsx'));
const StatementImport = lazy(() => import('./pages/StatementImport.jsx'));
const Coverage = lazy(() => import('./pages/Coverage.jsx'));
const StatutoryLifecycle = lazy(() => import('./pages/StatutoryLifecycle.jsx'));
const AccessGrants = lazy(() => import('./pages/AccessGrants.jsx'));

const navigation = [
  { id: 'dashboard', label: 'Dashboard', icon: '◫', description: 'Business overview' },
  { id: 'orders', label: 'Orders', icon: '▧', description: 'Sales orders & fulfilment' },
  { id: 'delivery', label: 'Delivery Proof', icon: '◇', description: 'Partial delivery and staff-reported proof' },
  { id: 'order-crm', label: 'Customer Follow-up', icon: '◷', description: 'Requests, commitments & blockers' },
  { id: 'catalogue', label: 'Catalogue', icon: '▤', description: 'Product discovery & curated alternatives' },
  { id: 'operations', label: 'Operations', icon: '▦', description: 'Sales, purchases & stock' },
  { id: 'documents', label: 'Document Output', icon: '▤', description: 'Versioned local invoice print copies' },
  { id: 'master-import', label: 'Item Import', icon: '⇧', description: 'Preview and commit company item CSV' },
  { id: 'batches', label: 'Batches', icon: '▥', description: 'Batch stock & allocation' },
  { id: 'locations', label: 'Locations & Transfers', icon: '⌗', description: 'Godowns, stores, racks & in-transit stock' },
  { id: 'conversion', label: 'Stock Conversion', icon: '⇄', description: 'Reviewed packing, ratios & wastage' },
  { id: 'counts', label: 'Counts & Replenishment', icon: '▣', description: 'Physical count & purchasing review' },
  { id: 'consignment', label: 'Consignment', icon: '◇', description: 'Custody, unsold returns & settlement review' },
  { id: 'pricing', label: 'Pricing Controls', icon: '◈', description: 'Price rules & discount exceptions' },
  { id: 'price-adjustments', label: 'Price Adjustments', icon: '↗', description: 'Invoice rate differences & tax review' },
  { id: 'supplier-comparison', label: 'Supplier Comparison', icon: '≍', description: 'Normalize quotes & review landed costs' },
  { id: 'bundles', label: 'Bundles & Schemes', icon: '◈', description: 'Versioned formulas, offers & deal history' },
  { id: 'credit', label: 'Credit Controls', icon: '◎', description: 'Customer exposure & temporary limits' },
  { id: 'finance', label: 'Finance', icon: '₹', description: 'Balances & payments' },
  { id: 'accounting', label: 'Accounting', icon: '▥', description: 'Journals & trial balance' },
  { id: 'bank', label: 'Bank Reconciliation', icon: '↔', description: 'Local statement matching' },
  { id: 'cashier', label: 'Cashier', icon: '▤', description: 'Cash drawer & close review' },
  { id: 'reporting', label: 'Reports', icon: '▧', description: 'Scoped management reporting' },
  { id: 'budgets', label: 'Budgets & Targets', icon: '◫', description: 'Cost centres and source-linked variances' },
  { id: 'returns', label: 'Returns', icon: '↩', description: 'Sales & purchase returns' },
  { id: 'return-inspection', label: 'Return Inspection', icon: '◇', description: 'Quarantine and saleable release' },
  { id: 'return-settlement', label: 'Return Settlement', icon: '◈', description: 'Commercial credit & payable adjustment' },
  { id: 'return-tax', label: 'Return Tax Review', icon: '◈', description: 'Local credit & debit note arithmetic' },
  { id: 'evidence', label: 'Evidence Library', icon: '▣', description: 'Files, provenance & review' },
  { id: 'gst', label: 'GST Workspace', icon: '◇', description: 'GST review & period preview' },
  { id: 'invoice-checks', label: 'Invoice Checks', icon: '✓', description: 'Invoice evidence and reviewed tax policy' },
  { id: 'statement-import', label: 'Statement Import', icon: '⇧', description: 'Local supplier statement CSV' },
  { id: 'simulator', label: 'Statutory Sandbox', icon: '⌁', description: 'Local filing flow simulation', tag: 'SIM' },
  { id: 'access-grants', label: 'Access Grants', icon: '⛨', description: 'GSTIN and branch permissions', adminOnly: true },
  { id: 'coverage', label: 'Build Status', icon: '▤', description: 'Verified feature coverage' },
];

function firstForCompany(bootstrap, companyId, preferred = {}) {
  const company = bootstrap?.companies?.find((item) => String(item.id) === String(companyId));
  return { company, ...resolveWorkspaceScope(company, preferred) };
}

function AuthScreen({ onSubmit, busy, error }) {
  return <main className="auth-screen">
    <div className="auth-layout">
      <section className="auth-intro" aria-label="TesselArk workspace">
        <div className="auth-brand"><div className="brand-mark"><BrandMark /></div><div><strong>TesselArk</strong><span>Business workspace</span></div></div>
        <div className="auth-intro-copy"><span className="eyebrow">YOUR BUSINESS, IN CONTEXT</span><h1>Welcome back.</h1><p>Pick up the work that matters, with company records, tax review, and financial activity in one place.</p></div>
        <p className="auth-intro-foot">Access follows your company, GST registrations, and branch grants.</p>
      </section>
      <section className="auth-panel" aria-labelledby="auth-title">
        <div className="auth-panel-head"><span className="auth-panel-kicker">SECURE WORKSPACE</span><h2 id="auth-title">Sign in</h2><p>Use the email and password provided for your account.</p></div>
        {error && <div className="auth-error" role="alert">{error}</div>}
        <form className="auth-form" onSubmit={onSubmit}>
          <label>Email address<input name="email" type="email" autoComplete="username" required autoFocus /></label>
          <label>Password<input name="password" type="password" autoComplete="current-password" required /></label>
          <button className="btn btn-primary" type="submit" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
        </form>
        <p className="auth-help">Need access? Contact your workspace administrator.</p>
      </section>
    </div>
  </main>;
}

function App() {
  const [activePage, setActivePage] = useState(() => readWorkspaceRoute(window.location).page);
  const [bootstrap, setBootstrap] = useState(null);
  const [bootError, setBootError] = useState('');
  const [bootLoading, setBootLoading] = useState(true);
  const [bootstrapRetry, setBootstrapRetry] = useState(0);
  const bootstrapRequest = useRef(0);
  const [selection, setSelection] = useState(() => {
    const scope = readWorkspaceScope(window.location);
    return { companyId: '', branchId: scope.branchId || '', gstinId: scope.gstinId || '', userId: '', role: '' };
  });
  const [refreshKey, setRefreshKey] = useState(0);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [contextExpanded, setContextExpanded] = useState(false);
  const sidebarRef = useRef(null);
  const menuButtonRef = useRef(null);

  useEffect(() => {
    if (!mobileMenuOpen) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const focusFrame = requestAnimationFrame(() => sidebarRef.current?.querySelector('button')?.focus());
    const onKeyDown = (event) => {
      if (event.key === 'Escape') { setMobileMenuOpen(false); return; }
      if (event.key !== 'Tab') return;
      const buttons = [...(sidebarRef.current?.querySelectorAll('button') ?? [])].filter((item) => item.getClientRects().length);
      const first = buttons[0];
      const last = buttons[buttons.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    const onResize = () => { if (window.innerWidth > 700) setMobileMenuOpen(false); };
    document.addEventListener('keydown', onKeyDown);
    window.addEventListener('resize', onResize);
    return () => {
      cancelAnimationFrame(focusFrame);
      document.body.style.overflow = previousOverflow;
      document.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('resize', onResize);
      menuButtonRef.current?.focus();
    };
  }, [mobileMenuOpen]);
  const [initialInvoiceId, setInitialInvoiceId] = useState(() => {
    const route = readWorkspaceRoute(window.location);
    return ['operations', 'documents', 'invoice-checks'].includes(route.page) ? route.recordId : null;
  });
  const [initialOrderId, setInitialOrderId] = useState(() => {
    const route = readWorkspaceRoute(window.location);
    return route.page === 'orders' ? route.recordId : null;
  });
  const [authMode, setAuthMode] = useState('unknown');
  const [needsLogin, setNeedsLogin] = useState(false);
  const [authUser, setAuthUser] = useState(null);
  const [csrfToken, setCsrfToken] = useState('');
  const [signInError, setSignInError] = useState('');
  const [signInBusy, setSignInBusy] = useState(false);
  const [signOutBusy, setSignOutBusy] = useState(false);

  const loadBootstrap = useCallback(async (signal, requestId) => {
    setBootLoading(true);
    setBootError('');
    try {
      const response = await fetch('/api/bootstrap', {
        signal,
        credentials: 'same-origin',
        headers: {
          ...(selection.companyId ? { 'x-company-id': String(selection.companyId) } : {}),
          ...(selection.userId ? { 'x-user-id': String(selection.userId) } : {}),
        },
      });
      if (response.status === 401) {
        setBootstrap(null);
        setAuthMode('production');
        setNeedsLogin(true);
        setAuthUser(null);
        setCsrfToken('');
        return;
      }
      if (!response.ok) {
        const detail = await response.json().catch(() => ({}));
        throw new Error(detail.error || detail.message || `Could not load the workspace (${response.status})`);
      }
      const data = await response.json();
      if (signal.aborted || requestId !== bootstrapRequest.current) return;
      if (data.demoMode === false) {
        const sessionResponse = await fetch('/api/auth/session', { signal, credentials: 'same-origin' });
        if (signal.aborted || requestId !== bootstrapRequest.current) return;
        if (sessionResponse.status === 401) {
          setBootstrap(null);
          setAuthMode('production');
          setNeedsLogin(true);
          setAuthUser(null);
          setCsrfToken('');
          return;
        }
        if (!sessionResponse.ok) throw new Error(`Could not verify your session (${sessionResponse.status})`);
        const session = await sessionResponse.json();
        if (signal.aborted || requestId !== bootstrapRequest.current) return;
        setAuthUser(session.user);
        setCsrfToken(session.csrfToken);
        setAuthMode('production');
      } else {
        setAuthMode('demo');
        setAuthUser(null);
        setCsrfToken('');
      }
      setNeedsLogin(false);
      const companies = data.companies ?? [];
      const companyId = data.demoMode === false ? data.currentCompanyId : selection.companyId || data.currentCompanyId || data.currentCompany?.id || companies[0]?.id || '';
      const userId = data.demoMode === false ? data.currentUserId : selection.userId || data.currentUserId || data.currentUser?.id || data.users?.find((user) => String(user.companyId) === String(companyId))?.id || data.users?.[0]?.id || '';
      const companyContext = firstForCompany(data, companyId, selection);
      const user = data.users?.find((item) => String(item.id) === String(userId));
      setBootstrap(data);
      setSelection({ companyId, branchId: companyContext.branchId, gstinId: companyContext.gstinId, userId, role: user?.role ?? '' });
    } catch (error) {
      if (signal.aborted || requestId !== bootstrapRequest.current) return;
      setBootError(error.message || 'Unable to connect to the workspace.');
    } finally {
      if (!signal.aborted && requestId === bootstrapRequest.current) setBootLoading(false);
    }
  }, [selection.companyId, selection.userId]);

  useEffect(() => {
    const controller = new AbortController();
    const requestId = ++bootstrapRequest.current;
    loadBootstrap(controller.signal, requestId);
    return () => controller.abort();
  }, [loadBootstrap, bootstrapRetry]);
  useEffect(() => {
    const onHistoryChange = () => {
      const route = readWorkspaceRoute(window.location);
      const scope = readWorkspaceScope(window.location);
      setActivePage(route.page);
      setInitialInvoiceId(['operations', 'documents', 'invoice-checks'].includes(route.page) ? route.recordId : null);
      setInitialOrderId(route.page === 'orders' ? route.recordId : null);
      if (bootstrap) setSelection(previous => {
        const company = bootstrap.companies?.find(item => String(item.id) === String(previous.companyId));
        return { ...previous, ...resolveWorkspaceScope(company, scope) };
      });
    };
    window.addEventListener('popstate', onHistoryChange);
    return () => window.removeEventListener('popstate', onHistoryChange);
  }, [bootstrap]);
  useEffect(() => {
    if (!bootLoading && bootstrap && activePage === 'access-grants' && selection.role !== 'admin') {
      window.history.replaceState(null, '', workspaceUrl('dashboard', null, window.location.href));
      setActivePage('dashboard');
    }
  }, [activePage, bootLoading, bootstrap, selection.role]);

  const onSelectionChange = useCallback((update) => {
    if (authMode === 'production' && (update.companyId !== undefined || update.userId !== undefined)) return;
    if ((update.companyId !== undefined && String(update.companyId) !== String(selection.companyId))
      || (update.userId !== undefined && String(update.userId) !== String(selection.userId))) {
      bootstrapRequest.current += 1;
    }
    setSelection((previous) => {
      const next = { ...previous, ...update };
      if (update.companyId !== undefined && String(update.companyId) !== String(previous.companyId)) {
        next.branchId = '';
        next.gstinId = '';
        const companyUser = bootstrap?.users?.find((user) => String(user.companyId) === String(update.companyId)) ?? bootstrap?.users?.[0];
        next.userId = companyUser?.id ?? '';
        next.role = companyUser?.role ?? '';
      }
      if (update.userId !== undefined && String(update.userId) !== String(previous.userId)) {
        next.branchId = '';
        next.gstinId = '';
        next.role = bootstrap?.users?.find((user) => String(user.id) === String(update.userId))?.role ?? '';
      }
      if (update.gstinId !== undefined) {
        const company = bootstrap?.companies?.find((item) => String(item.id) === String(next.companyId));
        const matchingBranch = company?.branches?.find((branch) => String(branch.gstinId) === String(update.gstinId));
        next.branchId = matchingBranch?.id ?? '';
      }
      if (update.branchId !== undefined) {
        const company = bootstrap?.companies?.find((item) => String(item.id) === String(next.companyId));
        const branch = company?.branches?.find((item) => String(item.id) === String(update.branchId));
        if (branch?.gstinId) next.gstinId = branch.gstinId;
      }
      return next;
    });
  }, [authMode, bootstrap, selection.companyId, selection.userId]);

  const apiFetch = useCallback(async (url, init = {}) => {
    const headers = new Headers(init.headers);
    if (init.body && typeof init.body === 'string' && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
    if (authMode === 'production') {
      if (!['GET', 'HEAD', 'OPTIONS'].includes(String(init.method || 'GET').toUpperCase()) && csrfToken) headers.set('x-csrf-token', csrfToken);
    } else {
      headers.set('x-company-id', String(selection.companyId || ''));
      headers.set('x-user-id', String(selection.userId || ''));
    }
    const response = await fetch(url, { ...init, credentials: 'same-origin', headers });
    if (response.status === 401 && authMode === 'production') {
      setBootstrap(null);
      setNeedsLogin(true);
      setAuthUser(null);
      setCsrfToken('');
    }
    return response;
  }, [authMode, csrfToken, selection.companyId, selection.userId]);

  const signIn = useCallback(async (event) => {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    setSignInBusy(true);
    setSignInError('');
    try {
      const response = await fetch('/api/auth/login', {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: String(form.get('email') || '').trim(), password: String(form.get('password') || '') }),
      });
      if (!response.ok) {
        const detail = await response.json().catch(() => ({}));
        throw new Error(response.status === 401 ? 'Email or password is incorrect.' : detail.error || detail.message || `Sign in failed (${response.status})`);
      }
      formElement.reset();
      setNeedsLogin(false);
      setBootstrapRetry((value) => value + 1);
    } catch (error) {
      setSignInError(error.message || 'Could not sign in. Try again.');
    } finally {
      setSignInBusy(false);
    }
  }, []);

  const signOut = useCallback(async () => {
    setSignOutBusy(true);
    setBootError('');
    try {
      const response = await fetch('/api/auth/logout', {
        method: 'POST', credentials: 'same-origin', headers: { 'x-csrf-token': csrfToken },
      });
      if (!response.ok && response.status !== 401) throw new Error(`Could not sign out (${response.status})`);
      setBootstrap(null);
      setSelection({ companyId: '', branchId: '', gstinId: '', userId: '', role: '' });
      setAuthUser(null);
      setCsrfToken('');
      setNeedsLogin(true);
      setMobileMenuOpen(false);
      setActivePage('dashboard');
      setInitialInvoiceId(null);
      setInitialOrderId(null);
      window.history.replaceState(null, '', workspaceUrl('dashboard', null, window.location.href));
    } catch (error) {
      setBootError(error.message || 'Could not sign out. Try again.');
    } finally {
      setSignOutBusy(false);
    }
  }, [csrfToken]);

  const refreshDashboard = useCallback(() => setRefreshKey((value) => value + 1), []);
  const navigate = useCallback((page, recordId = null) => {
    const url = workspaceUrl(page, recordId, window.location.href, selection);
    if (`${window.location.pathname}${window.location.search}` !== url)
      window.history.pushState(null, '', url);
    setInitialInvoiceId(['operations', 'documents', 'invoice-checks'].includes(page) ? recordId : null);
    setInitialOrderId(page === 'orders' ? recordId : null);
    setActivePage(page);
  }, [selection]);
  const context = useMemo(() => ({ ...selection, bootstrap, apiFetch }), [selection, bootstrap, apiFetch]);
  const company = bootstrap?.companies?.find((item) => String(item.id) === String(selection.companyId));
  const users = bootstrap?.users?.filter((user) => !user.companyId || String(user.companyId) === String(selection.companyId)) ?? [];
  const currentUserName = authUser?.name || users.find((user) => String(user.id) === String(selection.userId))?.name || 'User';
  const scopeReady = !bootLoading && !bootError
    && String(bootstrap?.currentCompanyId) === String(selection.companyId)
    && String(bootstrap?.currentUserId) === String(selection.userId);
  useEffect(() => {
    if (!scopeReady) return;
    const recordId = ['operations', 'documents', 'invoice-checks'].includes(activePage) ? initialInvoiceId : activePage === 'orders' ? initialOrderId : null;
    const url = workspaceUrl(activePage, recordId, window.location.href, selection);
    if (`${window.location.pathname}${window.location.search}` !== url)
      window.history.replaceState(null, '', url);
  }, [scopeReady, activePage, initialInvoiceId, initialOrderId, selection]);
  const active = navigation.find((item) => item.id === activePage);
  const pageProps = { context, refresh: refreshDashboard, bootstrap, selection, onSelectionChange, refreshDashboard, initialInvoiceId, initialOrderId, onNavigate: navigate, onOpenInvoice: (invoiceId) => navigate('operations', invoiceId), onOpenDocument: (invoiceId) => navigate('documents', invoiceId) };

  if (needsLogin) return <AuthScreen onSubmit={signIn} busy={signInBusy} error={signInError} />;
  if (bootError && !bootstrap) return (
    <div className="boot-screen"><div className="boot-card"><div className="brand-mark large">T</div><h1>Workspace unavailable</h1><p>{bootError}</p><button className="btn btn-primary" onClick={() => setBootstrapRetry((value) => value + 1)}>Try again</button></div></div>
  );
  if (!bootstrap) return <div className="boot-screen"><div className="loading-ring" /><span>Preparing your workspace…</span></div>;

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">Skip to workspace</a>
      {mobileMenuOpen && <button className="mobile-scrim" aria-label="Dismiss navigation overlay" onClick={() => setMobileMenuOpen(false)} />}
      <aside id="workspace-navigation" ref={sidebarRef} className={`sidebar ${mobileMenuOpen ? 'sidebar-open' : ''}`} aria-label="Workspace navigation">
        <div className="brand"><div className="brand-mark"><BrandMark /></div><div><strong>TesselArk</strong><span>Business workspace</span></div><button className="sidebar-close" type="button" aria-label="Close navigation" onClick={() => setMobileMenuOpen(false)}>×</button></div>
        <div className="sidebar-label">CONNECTED WORKFLOWS</div>
        <nav className="nav-list" aria-label="Main navigation">
          {navigation.filter((item) => !item.adminOnly || selection.role === 'admin').map((item) => <div key={item.id} className="nav-entry"><button aria-label={item.label} aria-current={activePage === item.id ? 'page' : undefined} className={`nav-item ${activePage === item.id ? 'active' : ''}`} onClick={() => { navigate(item.id); setMobileMenuOpen(false); }}><WorkspaceIcon className="nav-icon" name={item.id} /><span>{item.label}</span>{item.tag && <small className="nav-tag" aria-hidden="true">{item.tag}</small>}{activePage === item.id && <span className="nav-active-dot" aria-hidden="true" />}</button></div>)}
        </nav>
        <div className="sidebar-spacer" />
        <div className="sidebar-assist"><span className="assist-icon">✦</span><strong>Demo workspace</strong><p>Explore a working ERP flow with sample business data.</p><button onClick={() => navigate('coverage')}>View coverage <span>↗</span></button></div>
        <div className="sidebar-footer"><span className="status-dot" /> {authMode === 'production' ? 'Authenticated workspace' : 'Local demo environment'}</div>
      </aside>

      <div className="workspace" inert={mobileMenuOpen ? true : undefined}>
        <header className="topbar">
          <div className="topbar-leading"><button ref={menuButtonRef} className="menu-toggle" aria-expanded={mobileMenuOpen} aria-controls="workspace-navigation" aria-label="Open navigation" onClick={() => setMobileMenuOpen(true)}>☰</button><div className="breadcrumb">Workspace <span>/</span> <strong>{active?.label}</strong></div></div>
          <div className="topbar-trailing"><span className="topbar-user"><strong>{currentUserName}</strong><small>{selection.role}</small></span><div className="live-pill"><span className="status-dot" /> {authMode === 'production' ? 'SIGNED IN' : 'DEMO DATA'}</div><div className="avatar" title={authUser?.name || users.find((user) => String(user.id) === String(selection.userId))?.name}>{(authUser?.name || users.find((user) => String(user.id) === String(selection.userId))?.name || 'U').slice(0, 1).toUpperCase()}</div>{authMode === 'production' && <button className="sign-out-button" type="button" onClick={signOut} disabled={signOutBusy}>{signOutBusy ? 'Signing out…' : 'Sign out'}</button>}</div>
        </header>

        <main id="main-content" tabIndex={-1} className={`main-content ${activePage === 'dashboard' ? 'overview-content' : ''}`}>
          {activePage === 'dashboard' && <div className="workspace-header"><div><div className="eyebrow">BUSINESS OVERVIEW</div><h1>Welcome back, {currentUserName.split(' ')[0]}.</h1><p>Here’s what’s happening at {company?.name}.</p></div><div className="today-pill">{new Date().toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })}</div></div>}

          <section className={`context-bar ${contextExpanded ? 'context-expanded' : ''} ${activePage !== 'dashboard' ? 'context-on-subpage' : ''}`} aria-label="Business context" aria-busy={bootLoading}>
            <div className="context-title"><span className="context-icon">⌘</span><div><strong>Business context</strong><small>Records follow this scope</small></div></div>
            <button className="context-summary" type="button" aria-expanded={contextExpanded} aria-controls="context-fields" onClick={() => setContextExpanded((value) => !value)}><span><span className="context-summary-label">BUSINESS CONTEXT</span><strong title={company?.name}>{company?.name || 'Choose company'}</strong><small>GSTIN · {company?.gstins?.find((item) => String(item.id) === String(selection.gstinId))?.gstin || 'No GSTIN'}</small><small>Branch · {company?.branches?.find((item) => String(item.id) === String(selection.branchId))?.name || 'No branch'}</small><small>{authUser?.name || users.find((item) => String(item.id) === String(selection.userId))?.name || 'User'} · {selection.role || 'role'}</small><small>Period · All dates</small></span><span className="context-toggle-label">{contextExpanded ? 'Close' : 'Change scope'}<span className="context-chevron" aria-hidden="true">⌄</span></span></button>
            <div id="context-fields" className="context-fields">
            {authMode === 'production' ? <div className="context-select context-static"><span>COMPANY</span><strong>{company?.name || 'Assigned company'}</strong></div> : <label className="context-select"><span>COMPANY</span><select aria-label="Company" value={selection.companyId} onChange={(event) => onSelectionChange({ companyId: event.target.value })}>{bootstrap.companies?.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>}
            <label className="context-select"><span>GSTIN</span><select aria-label="GSTIN" value={selection.gstinId} disabled={bootLoading || Boolean(bootError)} onChange={(event) => onSelectionChange({ gstinId: event.target.value })}><option value="">{bootLoading ? 'Loading access…' : 'No permitted GSTIN'}</option>{company?.gstins?.map((item) => <option key={item.id} value={item.id}>{item.gstin}</option>)}</select></label>
            <label className="context-select"><span>BRANCH</span><select aria-label="Branch" value={selection.branchId} disabled={bootLoading || Boolean(bootError)} onChange={(event) => onSelectionChange({ branchId: event.target.value })}><option value="">{bootLoading ? 'Loading access…' : 'No permitted branch'}</option>{company?.branches?.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
            <div className="context-period"><span>PERIOD</span><strong>All dates</strong></div>
            {authMode === 'production' ? <div className="context-select context-static user-select"><span>SIGNED IN AS</span><strong>{authUser?.name || users[0]?.name} · {selection.role}</strong></div> : <label className="context-select user-select"><span>DEMO ROLE SWITCHER</span><select aria-label="Demo role switcher" value={selection.userId} onChange={(event) => onSelectionChange({ userId: event.target.value })}>{users.map((user) => <option key={user.id} value={user.id}>{user.name} · {user.role}</option>)}</select></label>}
            </div>
          </section>

          {bootError && <div className="alert error" role="alert">{bootError}<button className="btn btn-secondary" onClick={() => setBootstrapRetry((value) => value + 1)}>Retry access</button></div>}
          {!scopeReady && !bootError && <div className="alert info" role="status">Loading permitted business context…</div>}
          {scopeReady && <Suspense fallback={<div className="alert info" role="status">Opening workspace…</div>}>
            {activePage === 'dashboard' && <Dashboard {...pageProps} refreshKey={refreshKey} onNavigate={navigate} />}
            {activePage === 'operations' && <Operations {...pageProps} />}
            {activePage === 'documents' && <DocumentOutput {...pageProps} />}
            {activePage === 'master-import' && <MasterImport {...pageProps} />}
            {activePage === 'orders' && <Orders {...pageProps} />}
            {activePage === 'delivery' && <Delivery {...pageProps} />}
            {activePage === 'order-crm' && <OrderCrm {...pageProps} />}
            {activePage === 'catalogue' && <Catalogue {...pageProps} />}
            {activePage === 'batches' && <BatchInventory {...pageProps} />}
            {activePage === 'locations' && <Locations {...pageProps} />}
            {activePage === 'conversion' && <Conversion {...pageProps} />}
            {activePage === 'counts' && <Counts {...pageProps} />}
            {activePage === 'consignment' && <Consignment {...pageProps} />}
            {activePage === 'pricing' && <Pricing {...pageProps} />}
            {activePage === 'price-adjustments' && <PriceAdjustments {...pageProps} />}
            {activePage === 'supplier-comparison' && <SupplierComparison {...pageProps} />}
            {activePage === 'bundles' && <Bundles {...pageProps} />}
            {activePage === 'credit' && <CreditControls {...pageProps} />}
            {activePage === 'finance' && <Finance {...pageProps} />}
            {activePage === 'accounting' && <Accounting {...pageProps} />}
            {activePage === 'bank' && <BankReconciliation {...pageProps} />}
            {activePage === 'cashier' && <Cashier {...pageProps} />}
            {activePage === 'reporting' && <Reporting {...pageProps} />}
            {activePage === 'budgets' && <Budgets {...pageProps} />}
            {activePage === 'returns' && <Returns {...pageProps} />}
            {activePage === 'return-inspection' && <ReturnInspection {...pageProps} />}
            {activePage === 'return-settlement' && <ReturnSettlement {...pageProps} />}
            {activePage === 'return-tax' && <ReturnTaxReview {...pageProps} />}
            {activePage === 'evidence' && <EvidenceLibrary {...pageProps} />}
            {activePage === 'gst' && <Gst {...pageProps} />}
            {activePage === 'invoice-checks' && <InvoiceChecks {...pageProps} />}
            {activePage === 'statement-import' && <StatementImport {...pageProps} />}
            {activePage === 'simulator' && <StatutoryLifecycle {...pageProps} />}
            {activePage === 'access-grants' && selection.role === 'admin' && <AccessGrants {...pageProps} />}
            {activePage === 'coverage' && <Coverage {...pageProps} />}
          </Suspense>}
        </main>
      </div>
    </div>
  );
}


export default App;
