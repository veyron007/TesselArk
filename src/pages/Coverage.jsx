import { useMemo, useState } from 'react';
import features from '../data/features.json';
import { implemented } from '../data/implementation.js';
import './coverage.css';

export default function Coverage() {
  const [query, setQuery] = useState('');
  const [domain, setDomain] = useState('All domains');
  const [filter, setFilter] = useState('All statuses');
  const domains = useMemo(() => ['All domains', ...new Set(features.map((item) => item.domain))], []);
  const shown = features.filter((item) => {
    const status = implemented[item.id] ? 'Partial' : 'Planned';
    return (domain === 'All domains' || item.domain === domain)
      && (filter === 'All statuses' || status === filter)
      && `${item.id} ${item.capability} ${item.workflow}`.toLowerCase().includes(query.toLowerCase());
  });

  return <div className="coverage-page">
    <div className="coverage-heading">
      <div><div className="coverage-eyebrow">RESEARCH TRACEABILITY</div><h1>Feature coverage</h1><p>All 85 researched groups remain in scope. The labels show what this local build actually supports.</p></div>
    </div>
    <div className="coverage-summary"><strong>{Object.keys(implemented).length}</strong> groups partly implemented <span>·</span> <strong>{features.length - Object.keys(implemented).length}</strong> planned <span>·</span> <strong>0</strong> full parity claims</div>
    <div className="coverage-controls">
      <input aria-label="Search features" placeholder="Search feature ID or workflow" value={query} onChange={(event) => setQuery(event.target.value)} />
      <select aria-label="Filter domain" value={domain} onChange={(event) => setDomain(event.target.value)}>{domains.map((value) => <option key={value}>{value}</option>)}</select>
      <select aria-label="Filter status" value={filter} onChange={(event) => setFilter(event.target.value)}>{['All statuses', 'Partial', 'Planned'].map((value) => <option key={value}>{value}</option>)}</select>
    </div>
    <div className="coverage-count">Showing {shown.length} of {features.length} groups</div>
    <div className="coverage-list">{shown.map((item) => <details className="coverage-item" key={item.id}>
      <summary><span className="coverage-id">{item.id}</span><span className="coverage-title">{item.capability}<small>{item.domain}</small></span><span className={`coverage-status ${implemented[item.id] ? 'partial' : ''}`}>{implemented[item.id] ? 'Partial' : 'Planned'}</span></summary>
      <div className="coverage-details"><p>{item.workflow}</p><p><b>Acceptance example:</b> {item.acceptance}</p>{implemented[item.id] && <p><b>In this build:</b> {implemented[item.id]}</p>}</div>
    </details>)}</div>
  </div>;
}
