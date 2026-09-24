import { useRef, useState } from 'react';
import { BrandMark } from '../components/WorkspaceIcon.jsx';
import LandingMotion from './LandingMotion.jsx';
import ScopeVisual from './ScopeVisual.jsx';
import features from '../data/features.json';
import { implemented } from '../data/implementation.js';
import './public.css';

const Arrow = ({ down = false }) => <span aria-hidden="true">{down ? '↓' : '↗'}</span>;
export function PublicHeader({ compact = false }) {
  return <header className="public-header">
    <a className="public-brand" href="/" aria-label="TesselArk home"><span className="public-brand-symbol"><BrandMark /></span><span>TesselArk</span></a>
    {!compact && <nav className="public-nav" aria-label="Page sections"><a href="#platform">Platform</a><a href="#workflow">How it connects</a><a href="#trust">Build status</a></nav>}
    <div className="public-header-actions"><a className="public-signin" href="/demo">Sign in</a><a className="public-button public-button-small" href="/demo">Sign up <Arrow /></a></div>
  </header>;
}

// A deliberately small, synthetic product specimen. No live metrics or customer claims.
export function ProductScene() {
  return <div className="product-scene">
    <div className="scene-platform">
      <div className="scene-top"><span className="scene-brand"><BrandMark /> TesselArk <small>/ Workspace overview</small></span><span className="scene-live">SYNTHETIC DEMO</span></div>
      <div className="specimen-layout">
        <aside className="specimen-sidebar" aria-label="Illustrated workspace navigation"><span className="specimen-nav-active">Overview</span><span>Orders</span><span>Inventory</span><span>Finance</span><span>GST workspace</span><div className="specimen-user"><b>AM</b><span>Aster Medical<small>Mumbai · Accountant</small></span></div></aside>
        <div className="specimen-body">
          <div className="specimen-heading"><div><span className="scene-caption">YOUR BUSINESS, IN CONTEXT</span><h2>A clearer working day.</h2></div><span className="specimen-context">Mumbai GSTIN <i> / </i> Main branch</span></div>
          <div className="specimen-metrics"><div><span>Order fulfilment</span><strong>12 <small>/ 20 units</small></strong><span className="specimen-meter"><i /></span></div><div><span>Source linkage</span><strong>Order <small>→ Invoice</small></strong><small>One movement. No double posting.</small></div><div><span>Review context</span><strong>Evidence <small>→ Decision</small></strong><small>Matching and ITC stay separate.</small></div></div>
          <div className="specimen-detail"><div className="specimen-register"><div className="specimen-register-title"><strong>Follow the source</strong><span>ILLUSTRATIVE RECORDS</span></div><table><thead><tr><th>Record</th><th>Source reference</th><th>State</th></tr></thead><tbody><tr><td><b>Purchase order</b><small>Aster Medical Supplies</small></td><td>PO-DEMO-024</td><td><span className="specimen-status">Partial receipt</span></td></tr><tr><td><b>Purchase invoice</b><small>Linked to the receipt</small></td><td>INV-DEMO-018</td><td><span className="specimen-status neutral">Internal review</span></td></tr><tr><td><b>Purchase evidence</b><small>Supplier statement</small></td><td>SEP · 2026</td><td><span className="specimen-status neutral">ITC pending</span></td></tr></tbody></table></div><aside className="specimen-review"><span className="scene-caption">THE DECISION TRAIL</span><h3>Context travels<br />with the record.</h3><ol><li><span>01</span> Company & branch</li><li><span>02</span> Source evidence</li><li><span>03</span> Independent review</li></ol><p>Local review · No official filing</p></aside></div>
        </div>
      </div>
    </div>
    <div className="scene-footnote"><span><i /> A connected workspace, illustrated with synthetic records</span><span>ORDERS / STOCK / FINANCE / GST</span></div>
  </div>;
}

const chapters = [
  { id: 'operations', label: 'Orders & fulfilment', title: 'A sale is a sequence. Keep it connected.', body: 'Follow sales and purchase orders through partial fulfilment and source-linked invoices. The record preserves what moved, what remains and where the next step begins.', steps: ['Order confirmed', 'Partially fulfilled', 'Invoice linked'], note: 'Linked fulfilment avoids posting the same stock movement twice.', ref: 'ORDER → FULFILMENT → INVOICE', number: '01', detail: '12 received', total: '20 ordered', percent: 60 },
  { id: 'inventory', label: 'Inventory & movement', title: 'See the stock behind the number.', body: 'Trace stock movements, dated batches and storage locations. Inspect same-GSTIN transfers as they move from dispatch to partial receipt in the permitted branches.', steps: ['Source branch', 'In transit', 'Receipt recorded'], note: 'Batch history and location workflows are partial, distinct working slices.', ref: 'BRANCH → MOVEMENT → RECEIPT', number: '02', detail: '8 received', total: '12 dispatched', percent: 67 },
  { id: 'finance', label: 'Finance & review', title: 'Every total deserves a way back.', body: 'Move from journals, payments and scoped reports to their source documents. Review purchase evidence and record an ITC decision as a separate, local accounting step.', steps: ['Source document', 'Journal linked', 'Review recorded'], note: 'Internal approval and ITC eligibility never imply official filing.', ref: 'SOURCE → JOURNAL → REVIEW', number: '03', detail: 'Source linked', total: 'Local records', percent: 100 },
];

const reviewStages = [
  ['01', 'Match the evidence', 'Compare the purchase with the synthetic supplier statement. A match describes evidence, not tax eligibility.'],
  ['02', 'Review ITC eligibility', 'An accountant records a local eligibility decision for the selected GST registration and period.'],
  ['03', 'Approve internally', 'A separate person can review submitted work. The decision stays in the local audit trail.'],
  ['04', 'Keep filing distinct', 'The statutory sandbox simulates outcomes. It does not sign or file a return with a government portal.'],
];

function PlatformExplorer() {
  const [selected, setSelected] = useState(0);
  const chapter = chapters[selected];
  const selectWithKey = (event, index) => {
    const next = event.key === 'ArrowRight' ? (index + 1) % chapters.length : event.key === 'ArrowLeft' ? (index + chapters.length - 1) % chapters.length : event.key === 'Home' ? 0 : event.key === 'End' ? chapters.length - 1 : null;
    if (next === null) return;
    event.preventDefault();
    setSelected(next);
    event.currentTarget.parentElement.children[next].focus();
  };
  return <div className="platform-explorer">
    <div className="platform-tabs" role="tablist" aria-label="Explore the platform">{chapters.map((item, index) => <button key={item.id} id={`tab-${item.id}`} type="button" role="tab" aria-selected={selected === index} aria-controls="platform-panel" tabIndex={selected === index ? 0 : -1} onClick={() => setSelected(index)} onKeyDown={event => selectWithKey(event, index)}><span>{item.number}</span>{item.label}<Arrow /></button>)}</div>
    <div className="platform-panel" id="platform-panel" role="tabpanel" aria-labelledby={`tab-${chapter.id}`} tabIndex={0}>
      <div className="platform-panel-copy"><span className="public-kicker">{chapter.ref}</span><h3>{chapter.title}</h3><p>{chapter.body}</p><a className="public-text-link" href="/demo">Explore this workflow <Arrow /></a></div>
      <div className="flow-specimen"><div className="flow-specimen-top"><span>CONNECTED RECORDS</span><b>{chapter.number} / 03</b></div><div className="flow-specimen-value"><strong>{chapter.detail}</strong><span>{chapter.total}</span></div><div className="flow-meter" aria-hidden="true"><span style={{ width: `${chapter.percent}%` }} /></div><ol>{chapter.steps.map((step, index) => <li key={step}><span>{String(index + 1).padStart(2, '0')}</span><strong>{step}</strong><i aria-hidden="true">{index === 2 ? '↗' : '↓'}</i></li>)}</ol><p>{chapter.note}</p></div>
    </div>
  </div>;
}

export default function Landing() {
  const partialCount = Object.keys(implemented).length;
  const plannedCount = features.length - partialCount;
  const root = useRef(null);
  return <div className="public-page landing-page" ref={root}>
    <LandingMotion root={root} />
    <a className="public-skip" href="#public-main">Skip to content</a>
    <PublicHeader />
    <main id="public-main">
      <section className="public-hero public-container" aria-labelledby="hero-title">
        <div className="hero-copy"><p className="public-kicker"><span className="kicker-rule" /> THE CONNECTED BUSINESS WORKSPACE</p><h1 id="hero-title">Every detail.<br /><span>One clear picture.</span></h1><p className="hero-description">Orders, inventory, finance and GST review. Connected by the records behind them, in the right company and branch context.</p><div className="hero-actions"><a className="public-button" href="/demo">Explore the demo <Arrow /></a><a className="public-text-link" href="#platform">Take a closer look <Arrow down /></a></div><p className="hero-note">Local demonstration · Synthetic data · Prepared accounts</p><div className="hero-scroll-cue" aria-hidden="true"><span>SCROLL TO EXPLORE THE LAYERS</span><i /></div></div>
        <div className="hero-visual"><ScopeVisual /></div>
      </section>
      <section className="hero-stage public-container" aria-label="An illustrated TesselArk workspace"><div className="stage-heading"><p className="public-kicker">A WORKSPACE THAT KEEPS ITS CONTEXT</p><p>A source becomes a movement.<br />A movement becomes a record.</p></div><ProductScene /><div className="stage-endnote"><span>01 / SOURCE</span><span>02 / MOVEMENT</span><span>03 / REVIEW</span></div></section>
      <div className="public-ticker public-container"><span>Clarity at every handoff.</span><p>One company.<b>Its registrations.</b>The right branch.<b>A visible trail.</b></p><a href="#workflow" aria-label="See how the workflow connects"><Arrow down /></a></div>

      <section className="platform-section public-container" id="platform" aria-labelledby="platform-title"><div className="section-intro"><p className="public-kicker">01 / THE PLATFORM</p><div className="section-heading-row"><h2 id="platform-title">The work moves.<br /><span>The context stays.</span></h2><p>A document is only part of the story. See the source, the movement and the decision together in the working slices of TesselArk.</p></div></div><PlatformExplorer /></section>

      <section className="workflow-section" id="workflow" aria-labelledby="workflow-title"><div className="public-container workflow-inner"><div className="workflow-heading"><p className="public-kicker">02 / A VISIBLE TRAIL</p><h2 id="workflow-title">Less piecing together.<br /><span>More understanding.</span></h2><p>From the first record to the next decision, each step has its own place.</p><a className="public-text-link" href="/demo">Follow a demo record <Arrow /></a></div><div className="workflow-list">{[
        ['01', 'Start with the right scope.', 'Choose a company, GST registration and permitted branch. Keep the working context visible.'],
        ['02', 'See what actually happened.', 'Trace orders, partial fulfilment and stock movements through their linked records.'],
        ['03', 'Make the review explicit.', 'Inspect source evidence and record a local decision. Matching, eligibility and approval stay distinct.'],
      ].map(([number, title, copy]) => <article className="workflow-row" key={number}><span className="workflow-index">{number}</span><div><h3>{title}</h3><p>{copy}</p></div></article>)}</div></div></section>

      <section className="review-section public-container" aria-labelledby="review-title"><div className="review-copy"><p className="public-kicker">03 / THE DECISION TRAIL</p><h2 id="review-title">A review is a journey.<br /><span>Every step has its place.</span></h2><p>Source matching, ITC eligibility and internal approval are separate local decisions. TesselArk keeps each one visible without suggesting that a return has been filed.</p><a className="public-text-link" href="/demo">Inspect the local review <Arrow /></a></div><div className="review-stages">{reviewStages.map(([number, title, body]) => <article className="review-stage" key={number}><span>{number}</span><div><h3>{title}</h3><p>{body}</p></div></article>)}</div></section>

      <section className="trust-section public-container" id="trust" aria-labelledby="trust-title"><div className="trust-copy"><p className="public-kicker">04 / AN HONEST WORKING BUILD</p><h2 id="trust-title">Made to explore.<br /><span>Clear about its scope.</span></h2><p>This is a local ERP demonstration with fictional companies and sample transactions. Purchase matching and GST review are local workflows. Statutory screens are simulations, with no live government connection or official filing.</p><a href="/demo" className="public-text-link">View Build Status in the demo <Arrow /></a></div><div className="trust-ledger"><div className="trust-total"><strong>{features.length}</strong><span>researched feature groups</span></div><div className="trust-coverage" aria-label={`${partialCount} partly implemented groups and ${plannedCount} planned groups`}><span style={{ width: `${100 * partialCount / features.length}%` }} /><span /></div><div className="trust-counts"><div><strong>{partialCount}</strong><span>Partly implemented</span></div><div><strong>{plannedCount}</strong><span>Planned</span></div></div><p>Partial means a specific working slice. The in-app register describes what is implemented and what remains.</p></div></section>

      <section className="final-section"><div className="public-container final-inner"><div className="final-symbol" aria-hidden="true"><BrandMark /></div><p className="public-kicker">YOUR NEXT CLEARER WORKING DAY</p><h2>Step inside<br /><span>the whole picture.</span></h2><a className="public-button" href="/demo">Explore TesselArk <Arrow /></a><p>Prepared accounts. Synthetic companies. No registration required.</p></div></section>
    </main>
    <footer className="public-footer public-container"><a className="public-footer-brand" href="/"><BrandMark /> TesselArk</a><span>Local ERP demonstration · Synthetic data</span><a href="/demo">Demo access <Arrow /></a></footer>
  </div>;
}
