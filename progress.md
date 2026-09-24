# ERP build progress

Last updated: 2026-09-24

## Plan

- Build a persistent local React + Node/SQLite ERP vertical slice.
- Cover company, GSTIN and branch context, item and party masters, stock, sales/purchase invoices, staff submission, accountant review, and a local GST period summary.
- Keep the 85-group research register visible in the app. Mark only demonstrably working workflows as partial; leave all other groups planned.
- Use `qa/demo-scenarios.md` for integration targets and negative cases. Its 15 scenarios are a future acceptance set; passing a subset will be reported explicitly.
- User requires the full 85-group product build beyond the presentation deadline. Generic workflow records are navigation and data scaffolding only; specialist business rules stay planned until implemented and tested. A clearly labeled statutory simulator will support a technical demonstration without impersonating official services.

## Build

- [x] Feature register synced to UI catalogue (85 groups).
- [x] Frontend/backend package and local dev configuration created.
- [x] Persistent API, schema initialization and synthetic seed records (3 companies, 4 GSTINs, 5 branches).
- [x] React shell and functional operations/GST pages.
- [x] Connected invoice → stock → GST workflow and API tests.
- [x] Second wave: source-linked sales/purchase return proposals, invoice payment allocations, and synthetic purchase evidence matching with ITC review.
- [x] All-group prototype record workbench, keeping actual capability status separate.
- [x] Simulated statutory service for local demonstration (IRN/e-way/GST return outcomes with SIM references only).
- [x] Batch receipt/issue/transfer with expiry and branch stock protection; order partial fulfilment and source-linked invoice stock deduplication.
- [x] Versioned local evidence library with scoped links, SHA-256, download and internal review.
- [x] Accountant review and append-only audit for return-note tax proposals; separate local arithmetic preview in GST workspace, excluded from recorded period totals.
- [x] Local supplier-statement CSV preview/import with validation, exact replay, conflict blocking and source audit feeding purchase evidence matching.
- [x] Source-linked balanced invoice/payment journals, party ledger, trial balance and limited financial statements with seeded source backfill.
- [x] Local bank statement CSV import and audited line review; explicit payment-to-account attribution is required before matching.
- [x] Branch cashier sessions, automatic assignment of new cash receipts, payouts, counted close and independent discrepancy review.
- [x] Source-linked operational reports with company/GSTIN/branch/date filters and stale-response protection.
- [x] Explicit commercial subtotal settlement for approved returns, with AR/AP adjustment and separate unposted tax proposal.
- [x] New sales-return quarantine, source-lot inspection and explicit stock release/rejection.
- [x] Explicit demo-user GSTIN/branch grants, revocation and admin audit controls across routed domain modules.
- [x] Stateful statutory sandbox with synthetic authentication, IRN/e-way/GST-return lifecycles and immutable simulated events.
- [x] Expanded idempotent synthetic records across all three companies, with source states documented in `qa/demo-fixtures.md`.
- [x] Opt-in production authentication path with provisioned credentials, secure sessions, CSRF protection and private-proxy controls; separate demo mode stays loopback-only.
- [x] Versioned SQLite baseline plus tested backup, integrity check and guarded restore commands for local recovery.
- [x] Removed generic All Modules prototype from primary product navigation; Build Status keeps honest scope labels.
- [x] ERP-003 partial location workflow: warehouse/store/rack hierarchy, unbatched stock assignment, scoped same-GSTIN in-transit dispatch/partial receipt, replay protection and audit. Inter-GSTIN dispatch is blocked pending tax/transport workflows; batch location tracking remains open.
- [x] Idempotent ERP-003 demo hierarchy, existing-stock rack assignment and draft replenishment transfer, verified without changing physical stock totals.
- [x] ERP-005 partial reviewed stock conversion: whole-unit ratio/wastage and documented cost preview, independent review, atomic source/target posting, and idempotent replay; no valuation/accounting posting.
- [x] ERP-001 partial company catalogue: scoped discovery, sourced category and alternative curation, medicinal safety notice and audit; no clinical equivalence or automatic substitution.
- [x] ERP-008 partial physical counts and replenishment: independent variance review with replay-safe stock adjustment, stock and demand planning, and separate purchasing proposal approval; no automatic purchase order creation.
- [x] ERP-013 partial dated price rules, advisory quotes and independently reviewed discount exceptions; no invoice/order pricing hook.
- [x] ERP-016 partial customer exposure, scoped base limits and independently reviewed temporary limits; hold blocks new over-limit sales order confirmations and sales invoice submissions, while warn remains advisory. Cheque clearance and overdue aging remain pending.
- [x] ERP-007 partial consignment custody, evidenced activation, unsold returns and reviewed settlement proposal. Taxable documents, ownership transfer and ledger posting remain pending.
- [x] ERP-012 partial approved-invoice price-difference proposals and separate commercial/tax review. Source invoices and GST/ledger stay unchanged.
- [x] ERP-015 partial normalized supplier quotes, source-linked purchase history and independently reviewed choice. Purchase order creation remains pending.
- [x] ERP-014 partial versioned bundles, reviewed schemes and source-linked historical deals without automatic stock, rate or tax posting.
- [x] ERP-022 partial scoped cost centres, approved budgets and separate sales/collection targets with reviewed source allocations and period variances.
- [x] ERP-029 partial customer cases, order links, commitments, dispositions, follow-ups and fulfilment blockers; no external messaging or CRM sync.
- [x] ERP-025 partial versioned invoice print copies tied to scoped source records, source status, template version and English/Hindi/Marathi labels; no scannable barcode or validated legal format.
- [x] ERP-030 partial dispatch-linked delivery assignments, staff-reported partial handovers and unallocated collection reports; no independently verified customer proof or Finance allocation.
- [x] ERP-032 partial item-master CSV preview/commit with row reasons, source audit, stale preview protection and exact replay; other master and transaction imports remain pending.
- [x] Bookmarkable workspace paths with validated order/invoice record IDs and selected GSTIN/branch context; Back/Forward rejects stale or ungranted branch scope.
- [x] Renamed the product to TesselArk across the app shell, sign-in, browser metadata, favicon, package identity and primary documentation. A separate six-option light-mode design exploration is in progress; the selected direction will be applied after user choice.
- [x] Lazy-loaded domain pages to reduce the initial built JavaScript from 503 KB (139 KB gzip) to 255 KB (78 KB gzip); all 19 sidebar destinations opened in a browser with no page errors.
- [ ] Domain-specific implementation of remaining researched groups, with acceptance tests.

## Observe

- `npm install` completed; dependency audit reported 0 vulnerabilities.
- No app was present at start; `research/` is preserved.
- `npm test`: 140/140 backend tests pass after scope, statutory lifecycle, fixtures, authentication and recovery work. `npm run build` passes at 65 transformed modules. Measured Node test coverage: 98.89% lines, 81.17% branches and 97.12% functions (before the final small auth cleanup).
- Both app servers bind to 127.0.0.1 by default. `npm audit` reports 0 vulnerabilities. A clean `npm start` with freshly regenerated SQLite served the built UI and all intended specimens; the former QA database was backed up to `/tmp/ledgerline-qa-backup-2026-09-24.sqlite`.
- HTTP smoke: staff created a purchase draft; staff submitted; accountant approved; stock rose by two units and GST period purchase tax reflected ₹24. Generated demo DB was then reseeded for the final fixture.
- Seeded approved Harbor Clinic sale displays ₹200 sales and ₹24 output GST in the API dashboard.
- Final production smoke: 3 companies, two intentional linked Bengaluru partial orders, one synthetic Mumbai evidence file with reviewed/pending versions, one near-expiry assigned lot and an approved physical return pending separate tax review. No QA records remain in the default SQLite file.
- Isolated browser QA on port 3012 passed purchase bill → CSV preview/commit → GST match with ITC still pending, plus changed-duplicate conflict blocking and a 390px no-overflow check. Default port 3001 remains clean with no user imports.
- Independent isolated QA on port 3027 verified accounting, bank CSV/review, cashier close/review, reporting and source drilldown at desktop and 390px. It found and retested fixes for a stale report after company switch, invalid report date, month-end timezone error, and zero-value invoice posting. Default port 3001 was not mutated by that audit.
- Current default local app on port 3001 was rebuilt and restarted in explicit demo mode after a verified SQLite snapshot; HTTP root, cross-company fixture and admin grant API checks passed. Desktop and 390px browser checks opened Access Grants, Statutory Sandbox and Build Status with no page errors or horizontal overflow. A separate in-memory production-auth browser run passed sign-in, signed-in dashboard, sign-out and mobile width.

## Review

- First browser review caught a Vite JSX runtime error; `vite.config.js` now uses the automatic JSX transform. Dashboard renders in Chrome headless.
- Premium desktop and narrow-screen visual passes fixed truncated legal context, duplicate headings, mobile context, catalogue detail navigation, above-fold batch/evidence registers, and linked invoice navigation. Named-session browser flows passed for Orders, Batches, Evidence Library, Return Tax Review, Statutory Simulator and the All Modules prototype workbench at desktop and 390px.

## Rectify

- Purchase GST labels separate raw recorded tax, locally reviewed eligible ITC, nonnegative payable estimate, and surplus reviewed credit. No refund or official liability is claimed.
- API review findings addressed with focused tests: duplicate supplier reference, supplier snapshot, non-stock service, unresolved invoice period lock, claim period attribution, nonnegative payable/surplus display, and stock client-reference replay. GSTIN/branch grants now enforce routed business records; shared company-wide masters and unscoped bank records retain explicit limits.
- Independent review fixes are in place: service returns skip stock, historic invoice parties use snapshots, late returns remain commercial records with a separate tax review, scoped evidence cannot follow an edited workflow case, item stock tracking is fixed after transaction history, and unique-key conflicts return 409.
- Outbound sale invoices, order dispatches, manual issues and purchase returns allocate available lots FEFO. Existing unbatched purchase stock can be assigned to a lot with no physical quantity increase. Inbound receipts remain unbatched until that explicit assignment.
- Closed GST claim periods now reject eligibility edits or rematching that would change approved ITC; evidence review binds to the exact displayed version/hash and rejects self review; normalized supplier identity/reference prevents duplicate approved purchase bills across aliases.
- Maker/checker guards reject invoice self approval and GST period review/self approval. Cash receipts require an open drawer and auto assignment; closing blocks unassigned receipts. Bank reconciliation requires explicit audited payment account attribution. Existing synthetic companies received a second eligible reviewer where their demo roster lacked one.
- Independent security review found and retested fixes for simulated GST-return access with partial branch grants, a statutory token borrowed by staff, implicit demo startup, proxy-shared rate-limit identity and multi-tab CSRF expiry. Public deployment remains gated on actual HTTPS proxy and operational checks.

## Functional coverage

The app's Build Status page lists all 85 groups. Thirty-eight groups are marked **partial**: ERP-001, ERP-002, ERP-003, ERP-004, ERP-005, ERP-007, ERP-008, ERP-009, ERP-010, ERP-011, ERP-012, ERP-013, ERP-014, ERP-015, ERP-016, ERP-017, ERP-018, ERP-019, ERP-020, ERP-021, ERP-022, ERP-023, ERP-024, ERP-025, ERP-029, ERP-030, ERP-032, TAX-01, TAX-03, TAX-06, TAX-07, TAX-08, TAX-11, TAX-13, TAX-14, TAX-15, TAX-24, and WORK-05. The other 47 are **planned**. Partial means only the described slice works. The opt-in authenticated path is locally tested, while public deployment, official GST filing, portal interaction and full Marg parity are unverified or unavailable.

Demo users now have explicit GSTIN/branch grants with server-side enforcement and audited admin changes. An opt-in authenticated mode has a tested sign-in UI and API boundary, but has not been deployed to a public HTTPS environment. The independent production audit in `/tmp/erp-independent-production-audit-2026-09-24.md` found **0/15 complete acceptance scenarios verified**, and this build must not be described as full product parity or official filing.

## Prism Overview design — 2026-09-24

- Applied user-approved Option C to the real dashboard and shared shell, with matching styles across existing domain pages. Kept all current routes including Pricing and Credit Controls.
- Dashboard now uses scoped API metrics, real six-month invoice/GST charts with exact data tables, invoice drilldowns and a local-review rail. Scope and tax-state distinctions remain explicit; no coverage claims were promoted.
- Final verification: 179/179 tests, build passed, all 25 desktop destinations opened, core context switches and invoice/GST drilldowns checked. Initial 390px shell/menu checks passed; broader responsive sweep deferred per later steering. See `qa/prism-redesign.md` for evidence and limitations.
