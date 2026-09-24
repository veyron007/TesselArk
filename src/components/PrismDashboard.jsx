import { useEffect, useId, useMemo, useState } from 'react';
import { gstTrend, invoiceTrend, monthWindow, scopedOutstanding } from './dashboard-data.js';
import './prism-dashboard.css';

const money = value => new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 2 }).format((value ?? 0) / 100);
const shortMoney = value => new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', notation: 'compact', maximumFractionDigits: 1 }).format(value / 100);
const monthLabel = month => new Date(`${month}-01T12:00:00`).toLocaleDateString('en-IN', { month: 'short', year: '2-digit' });
const dateLabel = date => date ? new Date(`${date.slice(0, 10)}T12:00:00`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : 'Date unavailable';
const modules = [
  { id: 'dashboard', name: 'Overview', icon: 'grid', tone: 'blue' },
  { id: 'operations', name: 'Operations', icon: 'cart', tone: 'mint' },
  { id: 'orders', name: 'Orders', icon: 'document', tone: 'violet' },
  { id: 'batches', name: 'Inventory', icon: 'box', tone: 'mint' },
  { id: 'gst', name: 'GST', icon: 'tax', tone: 'violet' },
  { id: 'accounting', name: 'Accounting', icon: 'ledger', tone: 'blue' },
  { id: 'reporting', name: 'Reports', icon: 'chart', tone: 'peach' },
  { id: 'catalogue', name: 'Catalogue', icon: 'grid', tone: 'violet' },
];

function Icon({ name, className = '' }) {
  const paths = {
    grid: <><rect x="3" y="3" width="7" height="7" rx="1.5" /><rect x="14" y="3" width="7" height="7" rx="1.5" /><rect x="3" y="14" width="7" height="7" rx="1.5" /><rect x="14" y="14" width="7" height="7" rx="1.5" /></>,
    cart: <><path d="M2 3h3l2.5 12h11L21 7H6" /><circle cx="9" cy="20" r="1" /><circle cx="18" cy="20" r="1" /></>,
    document: <><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9Z" /><path d="M14 3v6h6M8 13h8M8 17h6" /></>,
    box: <><path d="m12 3 9 5v9l-9 5-9-5V8Z" /><path d="m3 8 9 5 9-5M12 13v9M7.5 5.5l9 5" /></>,
    tax: <><path d="M6 5h12M6 9h12M7 5c8 0 8 8 0 8l9 7" /></>,
    ledger: <><rect x="4" y="3" width="16" height="18" rx="2" /><path d="M8 3v18M12 8h4M12 12h4M12 16h3" /></>,
    chart: <><path d="M4 3v17h17M8 15v-4M13 15V7M18 15v-6" /></>,
    arrow: <path d="M5 12h14m-5-5 5 5-5 5" />,
    percent: <><path d="m6 18 12-12" /><circle cx="7" cy="7" r="3" /><circle cx="17" cy="17" r="3" /></>,
    check: <path d="m5 12 4 4L19 6" />,
  };
  return <svg className={`prism-icon ${className}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name] || paths.document}</svg>;
}

function useDashboard(context, refreshKey, retry) {
  const [state, setState] = useState(null);
  const scope = `${context.companyId}:${context.gstinId}:${context.branchId}:${context.userId}:${refreshKey}:${retry}`;
  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    const query = new URLSearchParams();
    if (context.branchId) query.set('branchId', context.branchId);
    if (context.gstinId) query.set('gstinId', context.gstinId);
    const gstQuery = new URLSearchParams();
    if (context.gstinId) gstQuery.set('gstinId', context.gstinId);
    setState(null);
    const endpoints = [
      ['summary', `/api/dashboard?${query}`],
      ['invoices', `/api/invoices?${query}`],
      ['gst', `/api/gst/periods?${gstQuery}`],
      ['finance', '/api/finance/open?type=sale'],
    ];
    Promise.allSettled(endpoints.map(async ([, url]) => {
      const response = await context.apiFetch(url, { signal: controller.signal });
      if (!response.ok) throw new Error(response.status === 403 ? 'Your access does not include this view.' : `This view could not load (${response.status}).`);
      return response.json();
    })).then(results => {
      if (!active) return;
      setState({ scope, resources: Object.fromEntries(results.map((result, index) => [endpoints[index][0], result.status === 'fulfilled'
        ? { data: result.value } : { error: result.reason.message }])) });
    });
    return () => { active = false; controller.abort(); };
  }, [context.apiFetch, context.branchId, context.gstinId, scope]);
  return state?.scope === scope ? state.resources : null;
}

function ChartTable({ rows, kind }) {
  const gst = kind === 'gst';
  return <details className="prism-chart-data"><summary>View chart data</summary><div className="prism-table-scroll" role="region" aria-label={`${gst ? 'GST position' : 'Sales and purchases'} data`} tabIndex={0}>
    <table><caption>{gst ? 'Registration-wide local GST period values. A missing period is not a zero balance.' : 'Approved invoice subtotals, excluding tax, for the selected branch and registration.'}</caption>
      <thead><tr><th scope="col">Month</th><th scope="col">{gst ? 'Output GST' : 'Sales'}</th><th scope="col">{gst ? 'Reviewed eligible ITC' : 'Purchases'}</th></tr></thead>
      <tbody>{rows.map(row => <tr key={row.month}><th scope="row">{monthLabel(row.month)}</th><td>{gst && !row.hasPeriod ? 'No period' : money(gst ? row.outputCents : row.salesCents)}</td><td>{gst && !row.hasPeriod ? 'No period' : money(gst ? row.eligibleItcCents : row.purchasesCents)}</td></tr>)}</tbody>
    </table></div></details>;
}

function Chart({ rows, kind }) {
  const id = useId();
  const gst = kind === 'gst';
  const keys = gst ? ['outputCents', 'eligibleItcCents'] : ['salesCents', 'purchasesCents'];
  const maximum = Math.max(100, ...rows.flatMap(row => keys.map(key => row[key] ?? 0)));
  const step = 10 ** Math.floor(Math.log10(maximum));
  const ceiling = Math.ceil(maximum / step) * step;
  const x = index => 64 + index * (360 / Math.max(1, rows.length - 1));
  const y = value => 210 - (value / ceiling) * 170;
  return <><svg className="prism-chart-svg" viewBox="0 0 460 250" role="img" aria-labelledby={`${id}-title ${id}-description`}>
    <title id={`${id}-title`}>{gst ? 'Monthly output GST and reviewed eligible ITC' : 'Monthly approved sales and purchases'}</title>
    <desc id={`${id}-description`}>Values in Indian rupees, {monthLabel(rows[0].month)} to {monthLabel(rows.at(-1).month)}. Exact values are available in the chart data table below.{gst && ' Blank months have no recorded GST period.'}</desc>
    <defs><linearGradient id={`${id}-fill`} x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#439bff" stopOpacity=".2" /><stop offset="100%" stopColor="#439bff" stopOpacity=".02" /></linearGradient></defs>
    {[0, 1, 2, 3, 4].map(tick => <g key={tick}><line x1="54" x2="442" y1={y(ceiling * tick / 4)} y2={y(ceiling * tick / 4)} stroke="#e8eef7" /><text x="46" y={y(ceiling * tick / 4) + 4} textAnchor="end" className="prism-axis">{shortMoney(ceiling * tick / 4)}</text></g>)}
    {rows.map((row, index) => <g key={row.month}><line x1={x(index)} x2={x(index)} y1="40" y2="210" stroke="#f0f4fa" /><text x={x(index)} y="234" textAnchor="middle" className="prism-axis">{monthLabel(row.month)}</text></g>)}
    {!gst && <path d={`M ${x(0)} 210 ${rows.map((row, index) => `L ${x(index)} ${y(row.salesCents)}`).join(' ')} L ${x(rows.length - 1)} 210 Z`} fill={`url(#${id}-fill)`} />}
    {keys.map((key, series) => gst ? rows.map((row, index) => row.hasPeriod && <rect key={`${key}-${row.month}`} x={x(index) + (series ? 1 : -16)} y={y(row[key])} width="14" height={210 - y(row[key])} rx="3" fill={series ? '#36b992' : '#4598f8'} />)
      : <g key={key}><polyline points={rows.map((row, index) => `${x(index)},${y(row[key])}`).join(' ')} fill="none" stroke={series ? '#9c65e9' : '#348bf5'} strokeWidth="2.5" strokeDasharray={series ? '6 3' : undefined} />{rows.map((row, index) => <circle key={row.month} cx={x(index)} cy={y(row[key])} r="4" fill={series ? '#9c65e9' : '#348bf5'} stroke="white" strokeWidth="1.5" />)}</g>)}
  </svg><ChartTable rows={rows} kind={kind} /></>;
}

function DataMessage({ loading, error, empty, children }) {
  if (loading || error || empty) return <div className={`prism-data-message${error ? ' prism-data-error' : ''}`} role={error ? 'status' : undefined}>{loading ? 'Loading workspace data…' : error || empty}</div>;
  return children;
}

function ReviewRail({ resources, context, onNavigate }) {
  const loading = !resources;
  const summary = resources?.summary.data;
  const invoices = resources?.invoices.data?.invoices ?? [];
  const pending = invoices.filter(row => ['draft', 'submitted'].includes(row.status));
  const periods = resources?.gst.data?.periods;
  const openPeriods = periods?.filter(row => row.status === 'open').length;
  const outstanding = resources?.finance.data ? scopedOutstanding(resources.finance.data.invoices, context) : null;
  return <aside className="prism-review-rail" aria-label="Work to review">
    <section className="prism-panel prism-review-panel"><div className="prism-panel-heading"><h2>Work to review</h2><span className="prism-count" aria-label={resources?.invoices.data ? `${pending.length} draft or submitted invoices` : loading ? 'Loading invoice queue' : 'Invoice queue unavailable'}>{resources?.invoices.data ? pending.length : '—'}</span></div>
      <div className="prism-rail-section"><h3>Invoice queue</h3><p className="prism-rail-note">Drafts and internal approvals</p>
        <DataMessage loading={loading} error={resources?.invoices.error} empty={!pending.length && 'No draft or submitted invoices in this scope.'}>
          <div className="prism-review-list">{pending.slice(0, 3).map(invoice => <button className="prism-review-item" key={invoice.id} onClick={() => onNavigate('operations', invoice.id)}>
            <Icon name="document" /><span><strong>{invoice.number}</strong><small>{invoice.partyName}</small><small>{money(invoice.totalCents)} · {dateLabel(invoice.invoiceDate)}</small><span className={`prism-state ${invoice.status}`}>{invoice.status === 'draft' ? 'Continue draft' : 'Awaiting approval'}</span></span><Icon name="arrow" />
          </button>)}</div>
        </DataMessage>
        {pending.length > 3 && <button className="prism-text-button" onClick={() => onNavigate('operations')}>View all {pending.length} invoices <Icon name="arrow" /></button>}
      </div>
      <div className="prism-rail-section prism-signals">
        <button onClick={() => onNavigate('finance')}><span><strong>Sales outstanding</strong><small>Selected branch · all dates</small></span><b>{outstanding === null ? '—' : money(outstanding)}</b></button>
        {resources?.finance.error && <p className="prism-inline-error">{resources.finance.error}</p>}
        <button onClick={() => onNavigate('operations')}><span><strong>Low stock</strong><small>At or below reorder level</small></span><b>{summary?.stats.lowStockItems ?? '—'}</b></button>
        {resources?.summary.error && <p className="prism-inline-error">Stock counts unavailable.</p>}
        <button onClick={() => onNavigate('gst')}><span><strong>Open GST periods</strong><small>Registration-wide · local review</small></span><b>{openPeriods ?? '—'}</b></button>
        {resources?.gst.error && <p className="prism-inline-error">{resources.gst.error}</p>}
      </div>
    </section>
    <section className="prism-note-card prism-gst-note"><span className="prism-icon-tile blue"><Icon name="document" /></span><div><h3>GST review · local demo</h3><p>Purchase matching and ITC eligibility need separate review. Internal approval does not sign or file a return.</p><p>No GST portal connection.</p><button className="prism-outline-button" onClick={() => onNavigate('gst')}>Open GST review <Icon name="arrow" /></button></div></section>
    <section className="prism-note-card prism-inventory-note"><span className="prism-icon-tile violet"><Icon name="box" /></span><div><h3>Keep supplies moving</h3><p>Review your lots, stock movements and expiry dates.</p><button className="prism-text-button" onClick={() => onNavigate('batches')}>View inventory <Icon name="arrow" /></button></div></section>
  </aside>;
}

export default function Dashboard({ context, refreshKey, onNavigate }) {
  const [retry, setRetry] = useState(0);
  const resources = useDashboard(context, refreshKey, retry);
  const now = new Date();
  const currentMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const months = useMemo(() => monthWindow(currentMonth), [currentMonth]);
  const summary = resources?.summary.data;
  const invoices = resources?.invoices.data?.invoices ?? [];
  const periods = resources?.gst.data?.periods ?? [];
  const salesRows = invoiceTrend(invoices, months);
  const gstRows = gstTrend(periods, months);
  const hasErrors = resources && Object.values(resources).some(resource => resource.error);
  const cards = [
    { label: 'Sales', value: summary?.salesCents, meta: 'Approved subtotal · excludes tax', icon: 'cart', tone: 'mint' },
    { label: 'Purchases', value: summary?.purchasesCents, meta: 'Approved subtotal · excludes tax', icon: 'cart', tone: 'blue' },
    { label: 'Output GST', value: summary?.outputGstCents, meta: 'Recorded on approved sales', icon: 'tax', tone: 'violet' },
    { label: 'Purchase tax', value: summary?.purchaseTaxCents, meta: 'Recorded tax · eligibility separate', icon: 'percent', tone: 'peach' },
  ];
  return <div className="prism-dashboard" aria-busy={!resources}>
    {hasErrors && <div className="prism-load-alert" role="status"><span>Some dashboard data could not be loaded. Available views are shown below.</span><button className="prism-outline-button" onClick={() => setRetry(value => value + 1)}>Retry</button></div>}
    <div className="prism-layout"><div className="prism-main">
      <nav className="prism-module-strip" aria-label="Workspace shortcuts">{modules.map(module => <button key={module.id} className={module.id === 'dashboard' ? 'is-current' : ''} aria-current={module.id === 'dashboard' ? 'page' : undefined} onClick={() => onNavigate(module.id)}><span className={`prism-icon-tile ${module.tone}`}><Icon name={module.icon} /></span><span>{module.name}</span></button>)}</nav>
      <section aria-label="All-time branch totals"><div className="prism-section-meta"><span>Selected branch & registration</span><span>All recorded dates</span></div>
        <div className="prism-kpis">{cards.map(card => <article className={`prism-kpi ${card.tone}`} key={card.label}><div className="prism-kpi-top"><span className={`prism-icon-tile ${card.tone}`}><Icon name={card.icon} /></span><div><h2>{card.label}</h2><strong>{summary ? money(card.value) : '—'}</strong></div></div><p>{!resources ? 'Loading…' : resources.summary.error ? 'Data unavailable' : card.meta}</p></article>)}</div>
      </section>
      <div className="prism-chart-pair">
        <section className="prism-panel prism-chart-panel"><div className="prism-panel-heading"><h2>Sales vs purchases</h2><span className="prism-period-label">6 months</span></div><p className="prism-chart-subtitle">Approved subtotals · selected branch · excludes tax</p><div className="prism-legend"><span className="sales">Sales</span><span className="purchases">Purchases · dashed</span></div>
          <DataMessage loading={!resources} error={resources?.invoices.error} empty={resources?.invoices.data && !invoices.some(row => row.status === 'approved' && months.includes(row.invoiceDate.slice(0, 7))) && 'No approved invoices in the last six months.'}><Chart rows={salesRows} kind="invoices" /></DataMessage>
        </section>
        <section className="prism-panel prism-chart-panel"><div className="prism-panel-heading"><h2>GST position</h2><span className="prism-period-label">6 months</span></div><p className="prism-chart-subtitle">Selected registration · all branches · local review</p><div className="prism-legend"><span className="sales">Output GST</span><span className="itc">Reviewed eligible ITC</span></div>
          <DataMessage loading={!resources} error={resources?.gst.error} empty={resources?.gst.data && !gstRows.some(row => row.hasPeriod) && 'No GST periods recorded in the last six months.'}><Chart rows={gstRows} kind="gst" /></DataMessage>
          {resources?.gst.data && gstRows.some(row => row.hasPeriod) && <p className="prism-chart-footnote">Blank months have no recorded period. ITC uses its claim period.</p>}
        </section>
      </div>
      <section className="prism-panel prism-invoices"><div className="prism-panel-heading"><div><h2>Recent invoices</h2><p>Latest created records in this scope</p></div><button className="prism-text-button" onClick={() => onNavigate('operations')}>View all <Icon name="arrow" /></button></div>
        <DataMessage loading={!resources} error={resources?.summary.error} empty={summary && !summary.recentActivity.length && 'No invoices yet. Open Operations to create your first invoice.'}>
          <div className="prism-table-scroll" role="region" aria-label="Recent invoices" tabIndex={0}><table><thead><tr><th scope="col">Date</th><th scope="col">Type</th><th scope="col">Invoice</th><th scope="col">Party</th><th scope="col" className="prism-numeric">Total</th><th scope="col" className="prism-numeric">GST</th><th scope="col">Status</th><th scope="col">Action</th></tr></thead>
            <tbody>{summary?.recentActivity.map(invoice => <tr key={invoice.id}><td>{dateLabel(invoice.invoiceDate)}</td><td><span className={`prism-state ${invoice.type}`}>{invoice.type === 'sale' ? 'Sale' : 'Purchase'}</span></td><td><button className="prism-invoice-link" onClick={() => onNavigate('operations', invoice.id)}>{invoice.number}</button></td><td className="prism-party">{invoice.partyName}</td><td className="prism-numeric">{money(invoice.totalCents)}</td><td className="prism-numeric">{money(invoice.taxCents)}</td><td><span className={`prism-state ${invoice.status}`}>{invoice.status === 'approved' ? 'Approved' : invoice.status === 'submitted' ? 'Submitted' : 'Draft'}</span></td><td><button className="prism-row-open" aria-label={`Open invoice ${invoice.number}`} onClick={() => onNavigate('operations', invoice.id)}><Icon name="arrow" /></button></td></tr>)}</tbody>
          </table></div>
        </DataMessage>
        <p className="prism-table-note">Invoice approval is an internal state. Purchase tax shown here is recorded tax, before ITC eligibility review.</p>
      </section>
      <div className="prism-footprint"><span><b>{summary?.stats.items ?? '—'}</b> company items</span><span><b>{summary?.stats.parties ?? '—'}</b> company parties</span><span><b>{summary?.stats.approvedInvoices ?? '—'}</b> approved invoices in scope</span><button className="prism-text-button" onClick={() => onNavigate('coverage')}>Build status <Icon name="arrow" /></button></div>
    </div><ReviewRail resources={resources} context={context} onNavigate={onNavigate} /></div>
  </div>;
}
