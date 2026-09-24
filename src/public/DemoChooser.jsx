import { useEffect, useMemo, useState } from 'react';
import { readDemoSelection, saveDemoSelection } from '../demo-entry.js';
import { PublicHeader } from './Landing.jsx';
import './public.css';

const roleCopy = {
  staff: 'Explore assigned orders, fulfilment, inventory and operational records.',
  accountant: 'Inspect invoices, finance, reports, GST evidence and local review decisions.',
  admin: 'Inspect the whole granted workspace, including access grants and Build Status.',
};

export default function DemoChooser() {
  const [state, setState] = useState({ status: 'loading', accounts: [], error: '' });
  const [retry, setRetry] = useState(0);
  const [selectionError, setSelectionError] = useState('');
  const selected = readDemoSelection();

  useEffect(() => {
    const controller = new AbortController();
    fetch('/api/demo/accounts', { signal: controller.signal, credentials: 'same-origin' }).then(async response => {
      const data = await response.json().catch(() => ({}));
      if (response.status === 403 && data.demoMode === false) return { status: 'production', accounts: [], error: '' };
      if (!response.ok) throw new Error(data.error || 'Could not load prepared demo accounts.');
      return { status: 'ready', accounts: data.accounts || [], error: '' };
    }).then(result => { if (!controller.signal.aborted) setState(result); }).catch(error => {
      if (!controller.signal.aborted) setState({ status: 'error', accounts: [], error: error.message });
    });
    return () => controller.abort();
  }, [retry]);

  const groups = useMemo(() => {
    const grouped = new Map();
    for (const account of state.accounts) {
      if (!grouped.has(account.companyId)) grouped.set(account.companyId, { id: account.companyId, name: account.companyName, accounts: [] });
      grouped.get(account.companyId).accounts.push(account);
    }
    return [...grouped.values()];
  }, [state.accounts]);

  const enter = (event, account) => {
    if (!saveDemoSelection(account)) {
      event.preventDefault();
      setSelectionError('This browser could not save the demo selection. Enable session storage and try again.');
    }
  };

  return <div className="public-page chooser-page"><a className="public-skip" href="#public-main">Skip to demo accounts</a><PublicHeader compact /><main id="public-main" className="chooser-main public-container"><div className="chooser-heading"><div><p className="public-kicker">TESSELARK DEMO ACCESS</p><h1>Choose a point of view.</h1><p>Sign in and Sign up both lead here during this local demo. Select a prepared account to enter the actual workspace. This does not register a public account.</p></div><aside><strong>Working with sample data</strong><span>Company, GSTIN, branch and role permissions are applied by the server.</span></aside></div>
    {state.status === 'loading' && <div className="chooser-status" role="status">Loading prepared demo accounts…</div>}
    {state.status === 'error' && <div className="chooser-status" role="alert"><strong>Demo accounts unavailable</strong><p>{state.error}</p><button type="button" className="public-button" onClick={() => { setState({ status: 'loading', accounts: [], error: '' }); setRetry(value => value + 1); }}>Try again</button></div>}
    {state.status === 'production' && <div className="chooser-status"><strong>Demo selection is unavailable in authenticated mode.</strong><p>Use your provisioned credentials to sign in. Public account registration is not available.</p><a className="public-button" href="/app">Go to sign in <span aria-hidden="true">↗</span></a></div>}
    {state.status === 'ready' && groups.length === 0 && <div className="chooser-status" role="status">No demo accounts are prepared in this workspace.</div>}
    {selectionError && <p className="chooser-error" role="alert">{selectionError}</p>}
    {groups.map(group => <section className="chooser-company" key={group.id} aria-labelledby={`company-${group.id}`}><div className="chooser-company-heading"><div><span className="chooser-company-index">DEMO COMPANY</span><h2 id={`company-${group.id}`}>{group.name}</h2></div><span>{group.accounts.length} prepared roles</span></div><div className="chooser-grid">{group.accounts.map(account => {
      const isSelected = selected && selected.companyId === account.companyId && selected.userId === account.userId;
      return <article className="chooser-card" key={account.userId}><div className="chooser-card-top"><span className="chooser-role">{account.role === 'admin' ? 'Owner / Admin' : account.role}</span>{isSelected && <span className="chooser-current">Current selection</span>}</div><div className="chooser-avatar" aria-hidden="true">{account.userName.split(' ').map(part => part[0]).slice(0, 2).join('')}</div><h3>{account.userName}</h3><p>{roleCopy[account.role] || 'Explore records in this account’s granted scope.'}</p><div className="chooser-scope"><strong>Granted scope</strong><span>{account.gstins.length} GSTIN{account.gstins.length === 1 ? '' : 's'} · {account.branches.length} branch{account.branches.length === 1 ? '' : 'es'}</span><small>{account.branches.map(branch => branch.name).join(' · ') || 'No branch grant'}</small></div><a className="chooser-enter" href="/app" onClick={event => enter(event, account)} aria-label={`Enter demo as ${account.userName} at ${group.name}`}>Enter demo <span aria-hidden="true">↗</span></a></article>;
    })}</div></section>)}
    <div className="chooser-footnote"><strong>Inside the workspace</strong><p>Open <b>Build Status</b> from navigation to see the researched feature coverage and the limits of this local build. Demo selection is for exploration; it is not production authentication.</p></div>
  </main><footer className="public-footer public-container"><span>TesselArk · Local demonstration</span><a href="/">Back to overview</a></footer></div>;
}
