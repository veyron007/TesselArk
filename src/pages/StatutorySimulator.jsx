import { useEffect, useMemo, useState } from 'react';
import './statutorySimulator.css';

const TYPES = [
  { id: 'irn', title: 'IRN response', subtitle: 'Synthetic invoice registration response', icon: '↗', source: 'invoice' },
  { id: 'eway', title: 'E-way response', subtitle: 'Synthetic movement document response', icon: '⇢', source: 'invoice' },
  { id: 'gst_return', title: 'GST return response', subtitle: 'Synthetic period submission response', icon: '▤', source: 'period' },
];

const label = (value) => String(value ?? '—').replaceAll('_', ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());

function monthLabel(period) {
  if (!/^\d{4}-\d{2}$/.test(String(period ?? ''))) return period ?? 'Period';
  const [year, month] = period.split('-').map(Number);
  return new Intl.DateTimeFormat('en-IN', { month: 'long', year: 'numeric' }).format(new Date(year, month - 1, 1));
}

function dateLabel(value) {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' });
}

export default function StatutorySimulator({ context = {}, refresh = 0 }) {
  const { companyId, gstinId, userId, role, apiFetch } = context;
  const [kind, setKind] = useState('irn');
  const [invoiceId, setInvoiceId] = useState('');
  const [periodId, setPeriodId] = useState('');
  const [scenario, setScenario] = useState('success');
  const [prepared, setPrepared] = useState(null);
  const [invoices, setInvoices] = useState([]);
  const [periods, setPeriods] = useState([]);
  const [simulations, setSimulations] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const request = async (path, options = {}) => {
    const response = await (apiFetch ? apiFetch(path, options) : fetch(path, {
      ...options, headers: { 'x-company-id': companyId, 'x-user-id': userId, ...options.headers },
    }));
    if (!response.ok) {
      const failure = await response.json().catch(() => ({}));
      throw new Error(failure.error || failure.message || `Request failed (${response.status})`);
    }
    return response.json();
  };

  useEffect(() => {
    if (!companyId) return undefined;
    let active = true;
    setLoading(true);
    setError('');
    setNotice('');
    setSimulations([]);
    setPrepared(null);
    const params = new URLSearchParams();
    if (gstinId) params.set('gstinId', gstinId);
    Promise.all([
      request(`/api/invoices${params.size ? `?${params}` : ''}`),
      request(`/api/gst/periods${params.size ? `?${params}` : ''}`),
      request(`/api/simulations${params.size ? `?${params}` : ''}`),
    ]).then(([invoiceResult, periodResult, simulationResult]) => {
      if (!active) return;
      const sales = (invoiceResult.invoices ?? []).filter((invoice) => invoice.type === 'sale' && invoice.status === 'approved');
      const periodList = (periodResult.periods ?? []).filter((period) => period.status === 'approved');
      setInvoices(sales);
      setPeriods(periodList);
      setSimulations(simulationResult.simulations ?? []);
      setInvoiceId((current) => sales.some((invoice) => String(invoice.id) === String(current)) ? current : String(sales[0]?.id ?? ''));
      setPeriodId((current) => periodList.some((period) => String(period.id) === String(current)) ? current : String(periodList[0]?.id ?? ''));
    }).catch((cause) => { if (active) setError(cause.message || 'Could not load simulator data.'); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [companyId, gstinId, userId, refresh]);

  const selectedType = TYPES.find((item) => item.id === kind) ?? TYPES[0];
  const selectedInvoice = invoices.find((invoice) => String(invoice.id) === String(invoiceId));
  const selectedPeriod = periods.find((period) => String(period.id) === String(periodId));
  const canReview = /accountant|admin|owner|ca/i.test(String(role ?? ''));
  const requiresReviewer = selectedType.source === 'period';
  const canPrepare = !loading && !busy && (selectedType.source === 'invoice' ? Boolean(invoiceId) : Boolean(periodId)) && (!requiresReviewer || canReview);

  function prepareRequest(event) {
    event.preventDefault();
    if (!canPrepare) return;
    setPrepared({
      kind,
      gstinId: Number(gstinId),
      sourceId: Number(selectedType.source === 'invoice' ? invoiceId : periodId),
      scenario,
      idempotencyKey: crypto.randomUUID(),
    });
    setError('');
    setNotice('Demo request prepared locally. Review it, then run the simulation.');
  }

  async function runSimulation() {
    if (!prepared) return;
    setBusy('run');
    setError('');
    setNotice('');
    try {
      const result = await request('/api/simulations', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(prepared),
      });
      setSimulations((current) => [result.simulation, ...current.filter((entry) => entry.id !== result.simulation.id)]);
      setNotice(result.replayed ? 'Existing simulated outcome replayed.' : 'Simulated outcome recorded locally. No government action occurred.');
      setPrepared(null);
    } catch (cause) {
      setError(cause.message || 'Could not run simulation.');
    } finally {
      setBusy('');
    }
  }

  const recentSimulations = useMemo(() => [...simulations].sort((a, b) => Number(b.id) - Number(a.id)), [simulations]);

  return <div className="sim-page">
    <div className="sim-banner"><span className="sim-watermark">SIMULATED</span><div><strong>Local statutory response simulator</strong><p>Practice invoice, e-way, and GST return response handling with demo records. Every reference and outcome on this page is synthetic.</p></div></div>
    <p className="sim-boundary">Simulated responses are NOT government registration or filing evidence. No GST portal or provider is connected, and no official invoice registration, e-way bill, or return submission occurs.</p>
    {error && <div className="sim-alert sim-error" role="alert">{error}</div>}
    {notice && <div className="sim-alert sim-success" role="status">{notice}</div>}

    <div className="sim-layout">
      <section className="sim-card sim-create"><div className="sim-section-title"><div><span className="sim-eyebrow">01 · Prepare</span><h2>Choose a demo response</h2></div><span className="sim-stage-tag">LOCAL ONLY</span></div>
        <div className="sim-types" role="group" aria-label="Demo response type">{TYPES.map((item) => <button key={item.id} type="button" className={`sim-type ${kind === item.id ? 'active' : ''}`} aria-pressed={kind === item.id} onClick={() => { setKind(item.id); setPrepared(null); }}><span className="sim-type-icon">{item.icon}</span><strong>{item.title}</strong><small>{item.subtitle}</small></button>)}</div>
        <form className="sim-form" onSubmit={prepareRequest}>
          {selectedType.source === 'invoice' ? <label>Approved sale invoice<select value={invoiceId} onChange={(event) => { setInvoiceId(event.target.value); setPrepared(null); }} disabled={loading}><option value="">Choose an invoice</option>{invoices.map((invoice) => <option key={invoice.id} value={invoice.id}>{invoice.number} · {invoice.partyName} · {invoice.invoiceDate}</option>)}</select><small>{selectedInvoice ? `${selectedInvoice.partyName} · ${selectedInvoice.invoiceDate} · selected GSTIN` : 'An approved sale is required before this demo response.'}</small></label> : <label>Internally approved GST period<select value={periodId} onChange={(event) => { setPeriodId(event.target.value); setPrepared(null); }} disabled={loading}><option value="">Choose an approved period</option>{periods.map((period) => <option key={period.id} value={period.id}>{monthLabel(period.period)} · {period.gstin}</option>)}</select><small>{selectedPeriod ? `${selectedPeriod.gstin} · internal approval recorded` : 'An internally approved period is required. Review the period in GST Workspace first.'}</small></label>}
          <label>Demo outcome<select value={scenario} onChange={(event) => { setScenario(event.target.value); setPrepared(null); }}><option value="success">Synthetic success</option><option value="rejection">Synthetic rejection</option><option value="timeout">Synthetic timeout</option></select><small>Choose the response path to demonstrate; none contacts a government service.</small></label>
          {requiresReviewer && !canReview && <p className="sim-role-note">Switch to an accountant or admin demo user for the GST return response.</p>}
          <button className="sim-primary" type="submit" disabled={!canPrepare}>Prepare local request<span aria-hidden="true">→</span></button>
        </form>
        {prepared && <div className="sim-prepared"><span>READY TO SIMULATE</span><strong>{label(prepared.kind)} · {label(prepared.scenario)}</strong><p>Source #{prepared.sourceId} under selected GSTIN. Running records a synthetic response only.</p><button type="button" onClick={runSimulation} disabled={Boolean(busy)}>{busy === 'run' ? 'Running…' : 'Run simulation →'}</button></div>}
      </section>

      <section className="sim-card sim-history"><div className="sim-section-title"><div><span className="sim-eyebrow">02 · Inspect</span><h2>Simulation history</h2></div><span className="sim-count">{recentSimulations.length} runs</span></div>
        {loading ? <p className="sim-empty">Loading demo history…</p> : recentSimulations.length === 0 ? <p className="sim-empty">No simulated responses yet. Prepare and run a local request to see one here.</p> : <div className="sim-job-list">{recentSimulations.map((simulation) => <article className="sim-job" key={simulation.id}>
          <div className="sim-job-top"><div><span className="sim-job-kind">{label(simulation.kind)} · {label(simulation.scenario)}</span><strong>{simulation.reference}</strong></div><span className={`sim-status sim-status-${String(simulation.status).toLowerCase()}`}>{label(simulation.status)}</span></div>
          <p className="sim-job-meta">Source #{simulation.sourceId} · {dateLabel(simulation.createdAt)}</p>
          <div className="sim-result"><span>SIMULATED RESPONSE</span><p>{simulation.response?.message ?? 'Synthetic result recorded locally.'}</p></div>
          <div className="sim-job-actions"><span>Government registration or filing evidence: none</span></div>
        </article>)}</div>}
      </section>
    </div>
  </div>;
}
