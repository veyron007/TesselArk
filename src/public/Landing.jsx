import { BrandMark } from '../components/WorkspaceIcon.jsx';
import LandingMotion from './LandingMotion.jsx';
import ScopeVisual from './ScopeVisual.jsx';
import './public.css';

export function PublicHeader({ compact = false }) {
  return <header className="public-header">
    <a className="public-brand" href="/" aria-label="TesselArk home"><span className="public-brand-symbol"><BrandMark /></span><span>TesselArk</span></a>
    {!compact && <nav className="public-nav" aria-label="Page sections"><a href="#platform">Platform</a><a href="#workflow">Workflow</a><a href="#trust">Build status</a></nav>}
    <div className="public-header-actions"><a className="public-signin" href="/demo">Sign in</a><a className="public-button public-button-small" href="/demo">Sign up <span aria-hidden="true">↗</span></a></div>
  </header>;
}

export function ProductScene() {
  return <div className="product-scene" role="img" aria-label="Illustration of scoped operations, invoice checks and GST review in the TesselArk workspace">
    <div className="scene-halo" aria-hidden="true" />
    <ScopeVisual compact />
    <div className="scene-platform">
      <div className="scene-top"><span className="scene-brand"><BrandMark /> TesselArk <small>/ Workspace</small></span><span className="scene-live">LOCAL DEMO</span></div>
      <div className="scene-context"><span className="scene-context-label">BUSINESS CONTEXT</span><strong>Aster Medical Supplies</strong><span>Mumbai GSTIN <b>·</b> Main branch <b>·</b> Accountant</span></div>
      <div className="scene-columns">
        <div className="scene-main"><span className="scene-caption">CONNECTED WORK</span><strong>One record. A clearer trail.</strong><div className="scene-flow"><div><i>01</i><span>Purchase order<small>Partially received</small></span></div><div><i>02</i><span>Invoice review<small>Source linked</small></span></div><div><i>03</i><span>GST evidence<small>Local review</small></span></div></div></div>
        <div className="scene-aside"><span className="scene-caption">REVIEW QUEUE</span><div className="scene-queue"><span>Invoice checks</span><strong>Evidence ready</strong><small>Policy + source review</small></div><div className="scene-mini"><span>Scope</span><strong>GSTIN → Branch → User</strong></div></div>
      </div>
    </div>
    <div className="scene-floating scene-floating-left"><span>ORDER → INVOICE</span><strong>Linked at the source</strong></div>
    <div className="scene-floating scene-floating-right"><span>STATUTORY SANDBOX</span><strong>Simulation only</strong></div>
  </div>;
}

const workflow = [
  { index: '01', title: 'Choose your business scope', body: 'Move between a company, its GST registration and an allowed branch before working with records.', meta: 'COMPANY / GSTIN / BRANCH' },
  { index: '02', title: 'Follow operational evidence', body: 'Trace orders, partial fulfilment, invoices, stock and dated batches through their source links.', meta: 'ORDER / STOCK / INVOICE' },
  { index: '03', title: 'Review before deciding', body: 'Compare purchase evidence, inspect invoice findings and record local accountant decisions with reasons.', meta: 'EVIDENCE / REVIEW / AUDIT' },
];

export default function Landing() {
  return <div className="public-page landing-page">
    <LandingMotion />
    <a className="public-skip" href="#public-main">Skip to content</a>
    <PublicHeader />
    <main id="public-main">
      <section className="public-hero public-container" aria-labelledby="hero-title">
        <div className="hero-copy"><p className="public-kicker"><span className="kicker-rule" /> THE WORKSPACE WITH A MEMORY</p><h1 id="hero-title">See the whole business.<br /><em>Keep every detail.</em></h1><p className="hero-description">A connected workspace for orders, inventory, finance and local GST review. Move from a decision to the records behind it, in the right company and branch context.</p><div className="hero-actions"><a className="public-button" href="/demo">Explore the demo <span aria-hidden="true">↗</span></a><a className="public-text-link" href="#platform">See how it connects <span aria-hidden="true">↓</span></a></div><p className="hero-note">Synthetic business data · Local demonstration · No account registration required</p></div>
        <ProductScene />
      </section>

      <div className="public-ticker"><div className="public-container ticker-inner"><strong>Built for work with context</strong><span>COMPANY SCOPE</span><span>ORDER TRAIL</span><span>STOCK MOVEMENT</span><span>REVIEW EVIDENCE</span><span>LOCAL GST PREVIEW</span></div></div>

      <section className="platform-section public-container" id="platform" aria-labelledby="platform-title"><div className="section-intro"><p className="public-kicker">THE PLATFORM</p><h2 id="platform-title">A thread through the work.</h2><p>Each workspace keeps the operational record close to its financial and review context. These are partial, working slices of a larger ERP plan.</p></div><div className="platform-composition"><div className="platform-large"><span className="platform-label">OPERATIONS</span><h3>Trade moves. The source stays visible.</h3><p>Sales and purchase orders support partial fulfilment, with linked invoices that avoid posting stock twice.</p><div className="platform-path"><span>ORDER</span><b aria-hidden="true">→</b><span>FULFILMENT</span><b aria-hidden="true">→</b><span>INVOICE</span></div></div><div className="platform-side"><article><span className="platform-label">INVENTORY</span><h3>Know where stock has been.</h3><p>Inspect movement history, dated batches, locations and in-transit transfers within permitted branches.</p></article><article><span className="platform-label">FINANCE + REPORTS</span><h3>Numbers with a route back.</h3><p>Review payments, journals, balances and scoped reports beside their source documents.</p></article></div></div></section>

      <section className="workflow-section" id="workflow" aria-labelledby="workflow-title"><div className="public-container workflow-inner"><div className="section-intro"><p className="public-kicker">A WORKABLE SEQUENCE</p><h2 id="workflow-title">From scope to evidence to review.</h2><p>TesselArk separates the record, the evidence and the human decision, so each step remains legible.</p></div><div className="workflow-list">{workflow.map(item => <article className="workflow-row" key={item.index}><span className="workflow-index">{item.index}</span><div><h3>{item.title}</h3><p>{item.body}</p></div><span className="workflow-meta">{item.meta}</span></article>)}</div><a className="public-button public-button-outline" href="/demo">Choose a demo workspace <span aria-hidden="true">↗</span></a></div></section>

      <section className="scope-section public-container" aria-labelledby="scope-title"><div className="scope-copy"><p className="public-kicker">CONTEXT IS THE CONTROL</p><h2 id="scope-title">Every layer of access, in its place.</h2><p>Company identity, GST registration, branch and user grants are distinct. The workspace keeps that scope visible while the server applies it to the records you can see and change.</p><div className="scope-note"><strong>A boundary you can inspect</strong><span>Switch a prepared demo role and see the permitted context change with it.</span></div><a className="public-text-link" href="/demo">See the roles <span aria-hidden="true">↗</span></a></div><ScopeVisual /></section>

      <section className="trust-section public-container" id="trust" aria-labelledby="trust-title"><div className="trust-copy"><p className="public-kicker">CLEAR ABOUT WHAT THIS IS</p><h2 id="trust-title">The record is real.<br />The scenario is synthetic.</h2><p>Explore a local working build with fictional companies and sample transactions. GST purchase matching, invoice checks and statutory screens are review and simulation tools, not live government connections or official filing.</p><a href="/demo" className="public-text-link">Enter and view Build Status <span aria-hidden="true">↗</span></a></div><div className="trust-ledger"><div><strong>85</strong><span>researched feature groups</span></div><div><strong>38</strong><span>partly implemented</span></div><div><strong>47</strong><span>planned</span></div><p>Coverage is shown inside the demo, with the implemented behavior described for each group.</p></div></section>

      <section className="final-section"><div className="public-container final-inner"><div><p className="public-kicker">START WITH A REAL ROLE</p><h2>See the work from the inside.</h2><p>Choose a prepared staff, accountant or owner demo account. Your selection opens the actual workspace in its granted company scope.</p></div><a className="public-button public-button-light" href="/demo">Explore TesselArk <span aria-hidden="true">↗</span></a></div></section>
    </main>
    <footer className="public-footer public-container"><span className="public-footer-brand"><BrandMark /> TesselArk</span><span>Local ERP demonstration · Synthetic data</span><a href="/demo">Demo access <span aria-hidden="true">↗</span></a></footer>
  </div>;
}
