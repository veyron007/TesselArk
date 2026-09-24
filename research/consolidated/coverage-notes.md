# Consolidated register: coverage and interpretation

Prepared 2026-09-24. This is a proposed capability register for the local-development webapp, not an implementation inventory, release commitment or claim of licensed-product testing.

## Deliverables and counts

- `feature-register.csv`: **85 coherent planning groups**: 48 ERP/industry families (`ERP-001`–`ERP-048`), 24 GST groups (`TAX-01`–`TAX-24`), and 13 shared webapp workflow groups (`WORK-01`–`WORK-13`).
- `coverage-map.csv`: **180 original source rows**, each mapped to at least one canonical group: all **156 Marg planning rows** and all **24 GST planning groups**. The 156 comprise 93 edition-matrix rows, 60 additional researched rows and 3 user-confirmed operating requirements.
- `byteception-comparison.csv`: **45 evidence observations** covering all 21 homepage observations and all 24 portfolio/blog observations, including exclusions and limitations.

Eighty-five groups do not mean 85 independent implemented features. The 156 original rows and 24 GST groups include overlapping workflows, marketing labels, companion-product jobs and proposed improvements. They are not 180 independent product features.

Canonical dispositions: **59 retained**, **22 deepened**, **4 newly explicit requirements**. Retained requirements remain proposed and unimplemented. Newly explicit groups cover identity/account lifecycle, concurrent editing recovery, document drafting/consent, and expenses/reimbursements. These build on existing access, review, evidence and accounting requirements; they do not establish that Marg lacks all related functionality.

The 45 observation decisions are 26 deepen-existing, 3 add-explicit, 8 retain-existing, 6 excluded, 1 unsupported-GST observation, and 1 sports-domain exclusion with reuse of the generic collaboration pattern. These count observations, not new modules. The expense group becomes explicit through combined portfolio observations that individually extend existing accounting, purchasing and ITC requirements.

## Exact source preservation

Each coverage row retains the original title, full workflow and full uncertainty text. `exact_original_row_json` preserves every source-field value, including editions, retrieval date, origin, evidence level, URL and deferred decisions. All original GST fields are similarly preserved. Relationships are many-to-many: a return can participate in trading, tax adjustment and CA review without becoming three transactions.

All 45 Byteception observations retain their URL, evidence type, original comparison, proposed adaptation and limitation. Original vendor observations are separated from proposed ERP behaviour. The homepage describes engineering capabilities of a studio. JCSS, BOLT, Stadia and the cybersecurity example are separate projects. Jupikit evidence is indexed first-party content and illustrative mockups; direct access returned 403. Blog statements are problem descriptions or design intent, not demonstrated shipped integrations. These sources do not establish one packaged Byteception ERP or a verified GST engine.

Canonical `source_baseline_ids` and `byteception_evidence_ids` resolve through the crosswalks. The unsupported GST observation points to preserved tax groups to document no scope change; it is deliberately excluded from their supporting vendor-evidence IDs.

## No functional pruning

Rare and ambiguous requirements remain explicit:

- Consignment custody/ownership/settlement: `ERP-007`.
- Secondary stock with unresolved meaning: `ERP-006`.
- Batch separators and auto/semi/manual allocation: `ERP-004`.
- Mandi bag quantities and item expenses: `ERP-038`.
- Kitty/committee instalments and Girvi pledged articles: `ERP-039`, as distinct underlying records.
- Caret/crates and deposits: `ERP-040`, with terminology still to verify.
- OPD/Reki: `ERP-041`, retaining clinical/privacy questions.
- Automatic bill separation and amount/day conversion: `ERP-027`, with precise criteria still to demonstrate.
- F3/F4, browser shortcut equivalents and counter peripherals: `ERP-026`.
- Bill tagging: `ERP-018`, retaining source ambiguity.
- Super Pack/Home Edition: `ERP-034`, with package semantics unresolved.
- Go digital: `ERP-033`, retained as an umbrella coverage link rather than an invented independent function.
- Branded banking, commerce, data and companion-product jobs remain represented with access, entitlement, hardware and data-rights dependencies.

Native/mobile companion jobs are expressed as browser workflows. Cloud backup and hosted-product source labels preserve backup/recovery/migration/browser-access needs without selecting cloud hosting. Browser peripherals require later device examples and compatibility checks.

## Shared records and separate decisions

Sales, purchases, stock movements, receipts, settlements, evidence and account postings share business identities. GST workspaces assess/report tax consequences of these records; they must not create a second invoice, purchase, stock movement or accounting entry merely because a transaction appears in another workspace.

An employee-paid supplier bill can appear in purchase intake, the expense claim, bank reconciliation, ITC review and a period review pack. Each view links the same bill. Invoice recipient, paid-by party, reimbursement beneficiary, expense owner, credit eligibility, tax claim and payment allocation remain separate facts. The bill must not be posted or settled twice.

Commercial progress, stock/receipt evidence, payment allocation, matching, credit eligibility, approval version and official government status remain separate. Matching does not establish credit eligibility; payment does not prove filing; signed engagement acceptance does not authorize GST signing. Internal comments do not become client-visible because they share a case. Changes trigger affected re-review and never silently rewrite filed snapshots.

## Exclusions and deferred decisions

Cloud consulting, deployment automation, generic engineering and code-modernisation offerings are excluded from functional counts. Mortgage-testing business logic, sports/venue operations, IoT/video-wall projects and cybersecurity/SOC/honeypot products are not added. Generic evidence, review, imports and status-freshness patterns can inform this ERP. Existing Marg Girvi/pledge scope remains retained: excluding the unrelated BOLT mortgage-testing product does not remove it.

Byteception sources do not establish GST portal access, IMS actions, GSTIN verification, e-invoice registration, e-way bills or legally valid GST signing. These remain governed by existing GST research and later official-source verification. Ordinary consent/signature records are distinct from statutory return signing.

Fixed requirements: local development, webapp-only scope, multiple companies/GSTINs/branches and staff preparation with accountant/CA review. Portal mode, stack, architecture, hosting, integration contracts, delivery priorities and release sequencing remain **deferred**. This register does not elect live, imported or simulated portal operation.

Statutory due dates and source rules attach only to applicable obligations. Internal review and evidence-gathering tasks may carry only internal targets.

## Validation

Programmatic checks verify unique canonical/source/evidence identifiers, all 156+24 original source rows, all 45 observations, valid cross-references and exact preservation of every original source row. Every referenced original GST workflow document exists. **Zero unmapped source rows and zero unresolved internal identifiers.**

Behavioural ambiguities remain product-research questions rather than tested features. This validation demonstrates traceability and internal consistency, not application functionality, statutory compliance or complete parity with a licensed Marg installation.
