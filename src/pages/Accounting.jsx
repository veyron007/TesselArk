import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import './accounting.css';

const money = cents => new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' }).format((Number(cents) || 0) / 100);
const today = () => new Date().toISOString().slice(0, 10);
const dateLabel = value => value ? new Date(`${value}T00:00:00`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : '—';
const monthEnd = period => new Date(Date.UTC(Number(period.slice(0, 4)), Number(period.slice(5, 7)), 0)).toISOString().slice(0, 10);

export default function Accounting({ context = {}, onOpenInvoice }) {
  const [period, setPeriod] = useState(today().slice(0, 7));
  const [asOf, setAsOf] = useState(today());
  const [view, setView] = useState('journals');
  const [accounts, setAccounts] = useState([]);
  const [journals, setJournals] = useState([]);
  const [trial, setTrial] = useState(null);
  const [reports, setReports] = useState(null);
  const [selected, setSelected] = useState(null);
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const loadVersion = useRef(0);
  const request = useCallback(async path => {
    const response = await context.apiFetch(path);
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
    return data;
  }, [context.apiFetch]);
  const load = useCallback(async () => {
    const version = ++loadVersion.current;
    setLoading(true); setError('');
    try {
      const [accountData, journalData, trialData, reportData] = await Promise.all([
        request('/api/ledger/accounts'),
        request(`/api/ledger/journals?period=${encodeURIComponent(period)}&limit=100`),
        request(`/api/ledger/trial-balance?asOf=${encodeURIComponent(asOf)}`),
        request(`/api/ledger/reports?period=${encodeURIComponent(period)}`),
      ]);
      if (version !== loadVersion.current) return;
      setAccounts(accountData.accounts || []);
      setJournals(journalData.journals || []);
      setTrial(trialData); setReports(reportData);
    } catch (cause) { if (version === loadVersion.current) setError(cause.message); }
    finally { if (version === loadVersion.current) setLoading(false); }
  }, [request, period, asOf]);
  useEffect(() => {
    let active = true;
    const version = ++loadVersion.current;
    setLoading(true); setError(''); setSelected(null);
    setAccounts([]); setJournals([]); setTrial(null); setReports(null);
    Promise.all([
      request('/api/ledger/accounts'),
      request(`/api/ledger/journals?period=${encodeURIComponent(period)}&limit=100`),
      request(`/api/ledger/trial-balance?asOf=${encodeURIComponent(asOf)}`),
      request(`/api/ledger/reports?period=${encodeURIComponent(period)}`),
    ]).then(([accountData, journalData, trialData, reportData]) => {
      if (!active || version !== loadVersion.current) return;
      setAccounts(accountData.accounts || []); setJournals(journalData.journals || []); setTrial(trialData); setReports(reportData);
    }).catch(cause => { if (active && version === loadVersion.current) setError(cause.message); }).finally(() => { if (active && version === loadVersion.current) setLoading(false); });
    return () => { active = false; };
  }, [request, period, asOf, context.companyId]);
  useEffect(() => {
    if (!selected) return undefined;
    const escape = event => { if (event.key === 'Escape') setSelected(null); };
    window.addEventListener('keydown', escape);
    return () => window.removeEventListener('keydown', escape);
  }, [selected]);
  const company = context.bootstrap?.companies?.find(item => String(item.id) === String(context.companyId));
  const filtered = useMemo(() => journals.filter(row => [row.documentNumber, row.description, row.partyName, row.sourceType].some(value => String(value || '').toLowerCase().includes(query.toLowerCase()))), [journals, query]);
  const rows = trial?.rows || [];
  const report = reports?.incomeStatement;
  const sheet = reports?.balanceSheet;
  return <section className="acct-page" aria-label="Accounting books">
    <header className="acct-head"><div><span className="acct-kicker">ACCOUNTING / COMPANY BOOKS</span><h1>General ledger</h1><p>Source-linked journals, balances, and a current management view.</p></div><span className="acct-scope">{company?.name || 'Selected company'} · ₹ INR</span></header>
    <div className="acct-note"><strong>Posting scope:</strong> approved invoices and recorded payment allocations. Returns, opening balances and inventory cost valuation have not been posted to these books. Reports are local management views.</div>
    <div className="acct-toolbar"><div className="acct-tabs" role="tablist" aria-label="Accounting view">{[['journals', 'Journals'], ['trial', 'Trial balance'], ['reports', 'Reports'], ['accounts', 'Accounts']].map(([key, label]) => <button key={key} type="button" role="tab" aria-selected={view === key} className={view === key ? 'active' : ''} onClick={() => setView(key)}>{label}</button>)}</div><div className="acct-filters"><label>{view === 'trial' ? 'As of' : 'Period'}<input type={view === 'trial' ? 'date' : 'month'} value={view === 'trial' ? asOf : period} onChange={event => { if (view === 'trial') setAsOf(event.target.value); else { setPeriod(event.target.value); setAsOf(monthEnd(event.target.value)); } }} /></label><button type="button" className="acct-secondary" onClick={load} disabled={loading}>Refresh</button></div></div>
    {error && <div className="acct-message error" role="alert">{error}<button type="button" onClick={load}>Retry</button></div>}
    <div className="acct-metrics"><div><span>JOURNALS IN PERIOD</span><strong>{loading ? '—' : journals.length}</strong><small>Source linked entries</small></div><div><span>TRIAL DEBITS</span><strong>{loading ? '—' : money(trial?.totalDebitCents)}</strong><small>As of {dateLabel(asOf)}</small></div><div><span>TRIAL CREDITS</span><strong>{loading ? '—' : money(trial?.totalCreditCents)}</strong><small>{trial?.totalDebitCents === trial?.totalCreditCents ? 'Balanced' : 'Review difference'}</small></div></div>
    {view === 'journals' && <div className="acct-card"><div className="acct-card-head"><div><h2>Journal register</h2><p>Open an entry to see its debits, credits and source.</p></div><label className="acct-search"><span className="sr-only">Search journals</span><input value={query} onChange={event => setQuery(event.target.value)} placeholder="Search entries" /></label></div>{loading ? <p className="acct-empty" role="status">Loading journals…</p> : filtered.length === 0 ? <p className="acct-empty">{journals.length ? 'No entries match this search.' : 'No approved invoice or payment entries were posted in this period.'}</p> : <div className="acct-table-wrap"><table className="acct-table"><thead><tr><th>Date</th><th>Source</th><th>Description</th><th>Context</th><th className="number">Debits</th><th className="number">Credits</th><th /></tr></thead><tbody>{filtered.map(row => <tr key={row.id}><td>{dateLabel(row.journalDate)}</td><td><strong>{row.documentNumber || `${row.sourceType} #${row.sourceId}`}</strong><small>{row.sourceType}</small></td><td>{row.description}</td><td><small>{row.partyName || '—'}<br />{row.gstinId ? `GSTIN #${row.gstinId}` : 'Company'} · {row.branchId ? `Branch #${row.branchId}` : 'All branches'}</small></td><td className="number">{money(row.totalDebitCents)}</td><td className="number">{money(row.totalCreditCents)}</td><td><button type="button" className="acct-link" onClick={() => setSelected(row)}>Inspect</button></td></tr>)}</tbody></table></div>}</div>}
    {view === 'trial' && <div className="acct-card"><div className="acct-card-head"><div><h2>Trial balance</h2><p>Cumulative posted balances as of {dateLabel(asOf)}.</p></div><span className={`acct-pill ${trial?.totalDebitCents === trial?.totalCreditCents ? 'good' : 'warn'}`}>{trial?.totalDebitCents === trial?.totalCreditCents ? 'Balanced' : 'Difference'}</span></div>{loading ? <p className="acct-empty" role="status">Loading trial balance…</p> : rows.length === 0 ? <p className="acct-empty">No account balances as of this date. Approve an invoice to begin.</p> : <div className="acct-table-wrap"><table className="acct-table"><thead><tr><th>Code</th><th>Account</th><th>Type</th><th className="number">Debits</th><th className="number">Credits</th><th className="number">Debit balance</th><th className="number">Credit balance</th></tr></thead><tbody>{rows.map(row => <tr key={row.code}><td><strong>{row.code}</strong></td><td>{row.name}</td><td><span className="acct-pill">{row.kind}</span></td><td className="number">{money(row.debitCents)}</td><td className="number">{money(row.creditCents)}</td><td className="number">{row.balanceDebitCents ? money(row.balanceDebitCents) : '—'}</td><td className="number">{row.balanceCreditCents ? money(row.balanceCreditCents) : '—'}</td></tr>)}</tbody><tfoot><tr><th colSpan={3}>Totals</th><th className="number">{money(trial?.totalDebitCents)}</th><th className="number">{money(trial?.totalCreditCents)}</th><th colSpan={2} /></tr></tfoot></table></div>}</div>}
    {view === 'reports' && <div className="acct-report-grid"><div className="acct-card"><div className="acct-card-head"><div><h2>Income statement</h2><p>Period {period}</p></div></div>{loading ? <p className="acct-empty">Loading report…</p> : <div className="acct-report-lines"><div><span>Revenue</span><strong>{money(report?.revenueCents)}</strong></div><div><span>Purchases</span><strong>{money(report?.purchasesCents)}</strong></div><div className="total"><span>Net result</span><strong>{money(report?.netResultCents)}</strong></div></div>}</div><div className="acct-card"><div className="acct-card-head"><div><h2>Balance sheet snapshot</h2><p>Based on currently posted sources</p></div></div>{loading ? <p className="acct-empty">Loading report…</p> : <div className="acct-report-lines"><div><span>Assets</span><strong>{money(sheet?.assetsCents)}</strong></div><div><span>Liabilities</span><strong>{money(sheet?.liabilitiesCents)}</strong></div><div><span>Current earnings</span><strong>{money(sheet?.currentEarningsCents)}</strong></div><div className="total"><span>Equation</span><strong>{sheet?.balanced ? 'Balanced' : 'Needs review'}</strong></div></div>}</div>{reports?.limitations?.length > 0 && <div className="acct-card acct-limitations"><h2>Report basis</h2><ul>{reports.limitations.map((item, index) => <li key={index}>{item}</li>)}</ul></div>}</div>}
    {view === 'accounts' && <div className="acct-card"><div className="acct-card-head"><div><h2>Chart of accounts</h2><p>System accounts used by source postings.</p></div><span className="acct-pill">{accounts.length} accounts</span></div>{loading ? <p className="acct-empty">Loading accounts…</p> : accounts.length === 0 ? <p className="acct-empty">No accounts configured for this company.</p> : <div className="acct-table-wrap"><table className="acct-table"><thead><tr><th>Code</th><th>Account</th><th>Type</th><th>Normal side</th></tr></thead><tbody>{accounts.map(row => <tr key={row.id}><td><strong>{row.code}</strong></td><td>{row.name}</td><td>{row.kind}</td><td>{row.normalSide}</td></tr>)}</tbody></table></div>}</div>}
    {selected && <div className="acct-overlay" onMouseDown={event => { if (event.target === event.currentTarget) setSelected(null); }}><div className="acct-drawer" role="dialog" aria-modal="true" aria-label={`Journal ${selected.documentNumber || selected.id}`}><div className="acct-drawer-top"><div><span className="acct-kicker">JOURNAL #{selected.id}</span><h2>{selected.documentNumber || selected.description}</h2><p>{dateLabel(selected.journalDate)} · {selected.sourceType} · {selected.partyName || company?.name}</p></div><button type="button" aria-label="Close journal" className="acct-close" onClick={() => setSelected(null)}>×</button></div><p className="acct-drawer-desc">{selected.description}</p><div className="acct-entry-lines"><div className="heading"><span>Account</span><span>Debit</span><span>Credit</span></div>{(selected.lines || []).map((line, index) => <div key={`${line.accountCode}-${index}`}><span><strong>{line.accountCode}</strong> {line.accountName}</span><span>{line.debitCents ? money(line.debitCents) : '—'}</span><span>{line.creditCents ? money(line.creditCents) : '—'}</span></div>)}<div className="total"><span>Entry total</span><span>{money(selected.totalDebitCents)}</span><span>{money(selected.totalCreditCents)}</span></div></div>{String(selected.sourceType || '').includes('invoice') && onOpenInvoice && <button type="button" className="acct-primary" onClick={() => onOpenInvoice(selected.sourceId)}>Open source invoice ↗</button>}<p className="acct-footnote">Journal entries are source-linked. Corrections require a controlled source workflow.</p></div></div>}
  </section>;
}
