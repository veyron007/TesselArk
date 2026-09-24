import { useMemo, useState } from 'react';
import features from '../data/features.json';
import './coverage.css';

const implemented = {
  'ERP-001': 'Filtered company catalogue discovery, sourced category curation and audited human-approved alternative suggestions; no clinical equivalence or automatic order substitution',
  'ERP-002': 'Stock balance and movement ledger for approved invoices and manual receipts/issues',
  'ERP-003': 'Scoped warehouse/store/rack hierarchy, classification of existing unbatched branch stock, and same-GSTIN dispatch/partial receipt with in-transit balance and audit; batch location tracking and inter-GSTIN tax/transport documents remain planned',
  'ERP-004': 'Dated lot receipt, issue, transfer and expiry watch; outbound sale, order and return issues allocate available lots FEFO, while inbound invoice/order receipts remain unbatched until allocation',
  'ERP-005': 'Reviewed source-to-target stock conversion with exact whole-unit ratio, recorded wastage, documented user-entered cost basis, atomic quantity postings and replay protection; inventory valuation and accounting effects remain planned',
  'ERP-007': 'Incoming and outgoing consignment custody with activation evidence, partial unsold returns and independently reviewed settlement proposals; incoming custody does not enter owned stock, and sale or purchase documents, tax, ownership transfer and ledger settlement remain pending',
  'ERP-012': 'Approved invoice line price-difference proposals with affected quantity, old and new rate snapshots, independent commercial and tax review, and replay-safe audit; original invoices, GST books and ledger remain unchanged pending document posting',
  'ERP-015': 'Supplier quote comparison normalizes paid and free packs, unit conversion, tax and freight; purchase history is source-linked and a separate reviewer records the selected supplier. Purchase-order creation, tax credit determination and supplier settlement remain pending',
  'ERP-008': 'Scoped physical count snapshot, independent variance review and replay-safe stock adjustments that protect recorded batch/location allocations; demand-based replenishment proposals receive purchasing review but do not create purchase orders',
  'ERP-013': 'Scoped advisory price rules with precedence, effective dates, discount bands and independently reviewed exceptions; existing invoice and order pricing is not yet bound to approved rules',
  'ERP-014': 'Versioned bundle component formulas, stock preview, independently reviewed schemes with explicit stacking and free-goods assumptions, and source-linked historical deal inspection; no automatic discount, stock or tax posting',
  'ERP-016': 'Scoped customer credit policies, receivable exposure and independently reviewed temporary limits with dated assessments; hold blocks new over-limit sales order confirmations and invoice submissions, while warn remains advisory. Cheque clearance and overdue aging remain pending',
  'ERP-009': 'Scoped sales quotations with draft editing, independent review, expiry, audit and one-time conversion to linked draft sales orders; sales and purchase orders support partial dispatch/receipt and source-linked invoicing. Indents and broader quote/approval variants remain planned',
  'ERP-010': 'Draft, submit and approve simple sales and purchase invoices',
  'ERP-011': 'Source-linked returns, purchase stock issue, sales-return quarantine with inspected release, and explicit commercial subtotal settlement; tax remains a separate proposal',
  'ERP-017': 'Balanced source-linked invoice, payment and commercial-return journals, party ledger, trial balance, periodic P&L and balance-sheet arithmetic; no opening balances, stock valuation, tax-return posting or close',
  'ERP-018': 'Invoice-level receivables/payables, partial payment allocations and explicit commercial return adjustments; refunds, reminders and collections automation remain planned',
  'ERP-019': 'Company-scoped local bank-statement CSV import, duplicate protection, payment matching, explanations and review audit; no live bank connection or cheque lifecycle',
  'ERP-020': 'Branch cash sessions, assigned cash receipts, payouts, counted close and independent discrepancy review; no payment-provider settlement verification',
  'ERP-021': 'Company, GSTIN, branch and date-scoped invoice, payment, return and GST review report with source drilldown and separate measures',
  'ERP-022': 'Scoped cost centres, independently reviewed expense budgets and separate sales/collection targets, with source-linked approved transaction allocations and period variance drilldown; no automatic dimension posting or payroll/manufacturing budgets',
  'ERP-023': 'Explicit GSTIN/branch grants and audited admin changes, plus an opt-in authenticated session path; no complete identity lifecycle or deployment certification',
  'ERP-024': 'Invoice submission and accountant approval states',
  'ERP-025': 'Scoped invoice print copies capture immutable source and template versions with English, Hindi or Marathi labels and stable text item identity; no scannable barcode, legal format validation or ancillary label output',
  'ERP-029': 'Scoped customer follow-up cases linked to the exact sales order, with owner, next action, immutable commitment/disposition history and fulfilment blockers; no messaging automation or external CRM integration',
  'ERP-030': 'Confirmed sales dispatches can be assigned for delivery, with replay-safe partial visits, remaining quantities and staff-reported proof metadata; no verified customer signature, collection allocation or carrier integration',
  'ERP-032': 'Company-wide item-master CSV preview and commit with row validation, rejection reasons, source audit, duplicate SKU checks and exact replay; no transaction or third-party ERP imports',
  'TAX-01': 'Synthetic company, GSTIN and branch records with context selection; no registration lifecycle',
  'TAX-02': 'Sales-invoice place-of-supply proposals capture explicit supply facts, documentary basis, versioned independent review and an advisory IGST or CGST plus SGST/UTGST allocation for narrow ordinary domestic cases; special cases require specialist review, and no tax master, invoice or GST posting is changed',
  'TAX-03': 'Entered-rate invoice arithmetic, internal effective-dated item tax policy review, invoice evidence findings and reasoned accountant override of reviewed-policy mismatches; no official rate lookup, legal classification or posted GST component split',
  'TAX-06': 'Synthetic seed rows and validated local supplier-statement CSV import, with source audit and approved purchase-bill matching; no GST portal verification',
  'TAX-07': 'Local books-versus-demo-fixture match and mismatch review; no GST portal connection',
  'TAX-08': 'Accountant eligible/blocked decisions with reasons; only matched eligible credit enters local preview',
  'TAX-11': 'Source-linked sale/purchase return-note tax proposals with accountant decisions, audit and a separate local arithmetic preview; recorded GST totals stay unchanged',
  'TAX-13': 'Local period review and approval summary; no portal filing',
  'TAX-14': 'Illustrative output and purchase tax totals; ITC eligibility and official liability remain unassessed',
  'TAX-15': 'Company and GSTIN scope selection',
  'TAX-24': 'Local accountant review states',
  'WORK-05': 'Versioned local evidence files with hashes, scoped record links and internal review; no production client access controls',
};

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
