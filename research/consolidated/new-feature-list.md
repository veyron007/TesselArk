# Consolidated ERP and GST feature map — Marg + Byteception research

Discussion version 3, 24 September 2026. This is the new product feature list. It retains the Marg/GST scope and incorporates relevant Byteception research. These are proposed requirements, not implemented or hands-on-verified product capabilities.

**Confirmed product boundary**

A full Marg competitor delivered as a webapp; local development initially; multiple companies, GSTINs and branches; staff prepare and accountants/CAs review. No prior feature is dropped to narrow the product. Stack, architecture, delivery priorities, production hosting, offline behaviour and GST portal interaction mode remain undecided. Native apps are outside this discussion; their previously identified business jobs remain browser workflows.

**What Byteception contributes**

Byteception identifies itself as a product engineering studio. Its homepage lists reusable application capabilities, not a packaged ERP specification. Relevant examples include access controls, collaboration, documents and assisted work. [Byteception](https://byteception.com/)

Its JCSS PM case study describes engagement management, recurring tasks and client visibility. BOLT describes validation scenarios, versioned reviews and evidence. Those are useful references for our operational and GST review workflows. They do not establish Indian GST calculation or filing capabilities. [JCSS PM](https://byteception.com/gallery/jcss), [BOLT](https://byteception.com/gallery/bolt)

Jupikit is an associated finance product; indexed first-party material labels it private beta. Direct access failed during research. Its finance illustrations and related blogs inform expense-handling ideas, not a claim that its tax, payroll or integrations were tested. [Jupikit](https://jupikit.com/), [finance-product discussion](https://byteception.com/blog/financial-hygiene-is-a-feature)

**The comparison, before adding anything**

| Byteception theme | Existing plan | Decision in the new list |
|---|---|---|
| Workspaces, roles, audit | Already explicit in Marg controls and our company/GSTIN/CA boundaries | Retain shared controls; clarify client and staff visibility rather than invent duplicate security modules. |
| Sign-in choices | Users and powers existed; account/session lifecycle was underspecified | Add explicit invitation, verification, recovery, second-factor, session and access-removal workflows. Authentication options remain policy choices. |
| Notifications | Messaging, reminders and task ownership existed | Deepen into a personal work inbox with grouping, urgency, deduplication, acknowledgement and escalation policy. |
| Live collaboration | Comments, versioned approval and correction history existed | Add explicit concurrent-edit awareness and stale-change resolution; preserve typing and prevent silent overwrite. |
| Document editing | Invoice formats and evidence packs existed | Add general drafts, reusable templates, variables, version comparison, review and approved exports. |
| Repository | Evidence attachments existed across GST workflows | Define a shared, permission-controlled library with provenance, versions, search and disclosure controls. |
| Recurring tasks | Period checks and due dates existed | Make obligation generation and ownership explicit; keep statutory dates separate from internal target dates. |
| Engagements and client view | GST-24 already covered CA engagement/review | Deepen accepted scope, work packages, missing-information requests, client visibility and handover. |
| Structured records | Search, filters, exports and bulk work existed | Define saved views, selection scope, stable context, per-row results and conflict behaviour. |
| Review scenarios | Tax checks and acceptance examples existed | Make reusable, versioned review checklists and tax-policy example comparisons available to authorized reviewers. |
| Expense and payment context | Accounts/payroll/purchase capture existed | Specify who incurred and paid each expense, reimbursement obligations, evidence completeness and payment-aware follow-up. |
| AI and connectors | Capture/imports, exchange monitoring and suggestions existed | Add governed multi-step assistance and connector-status workflows; suggested actions do not gain tax or filing authority. |
| Cloud/CI/CD services, listed stack | These are engineering services or implementation choices | Do not turn them into ERP business features or stack decisions. |
| Mortgage, sports, IoT, threat monitoring | Unrelated portfolio domains | Do not add these businesses to the ERP. Reuse only applicable interaction/review patterns. |

The source-by-source decisions are in [byteception-comparison.csv](byteception-comparison.csv). Vendor statements and our proposed adaptations are separate fields. The detailed source registers are [homepage evidence](../byteception/capability-evidence.json) and [portfolio evidence](../byteception/portfolio-evidence.json).

**The new whole-product feature list**

The canonical list is [feature-register.csv](feature-register.csv): **85 capability groups — 48 ERP, 24 GST and 13 shared webapp workflows**. It groups overlapping requirements while the [coverage map](coverage-map.csv) preserves all **156 earlier parity rows and 24 GST groups**, including every original field. The comparison separately records **45 Byteception observations**. Capability groups are not a count of independent features; transaction and GST requirements share the same business records.

| Product area | Retained scope and refinements |
|---|---|
| Organisation and identity | Companies, GSTINs, branches/stores, years, invitations, access scope, roles, review powers, sign-in/recovery/session controls and client engagement access |
| Item and party masters | Customers/suppliers, units/packs, variants, categories/salts/substitutes, batches, serials, manufacturing/expiry data, price lists, schemes, negotiated rates and labels |
| Sales and POS | Quotations, orders, challans, retail/wholesale invoices, counters, split payments, cash handling, scales/barcodes, customer displays, loyalty, rapid keyboard/touch entry and editable print formats |
| Procurement | Indents, quotations, purchase orders, temporary entries, receipts, service evidence, bills, source capture, supplier mapping, commercial variances, cost comparisons and replenishment |
| Inventory | Multi-store/rack stock, reservations/movements, counts, batches/expiry, conversions/bundles, consignment, secondary stock, shortages, replacements, scrap and returnable crates |
| Returns and claims | Sales/purchase returns, sold-batch validation, breakage/expiry, quantity/price differences, commercial settlement, GST-linked notes and partial resolution |
| Accounts and cash | Ledgers, journals, statements, receivables/payables, bill allocation, credit limits, PDCs, collection/interest workings, budgets, cost centres, targets and year close |
| Expenses and reimbursements | Claim capture, invoice ownership, who incurred/paid, cost attribution, missing documents, commercial approval, tax review, payable/settlement linkage and duplicate protection |
| Banking and collections | Statement mapping/reconciliation, supported connected banking, payment references, pending matches, collection drafts and paid-status checks before reminders |
| Distribution and commerce | Salespeople/routes, commissions, retailer orders, field invoicing, delivery status, owner views, QR/storefront orders, marketplaces, ERP exchange and channel/manufacturer reporting |
| Manufacturing and trades | Planning, materials, BOM/formulations, costs and quality records; pharmacy, garments, jewellery, mandi, restaurants, appointments/OPD and other retained specialist rows |
| People and payroll | Employee, attendance, leave, salary, reimbursement and statutory payroll jobs already present in the baseline; exact domain rules remain separately validated |
| Work management | Assigned tasks, recurring obligations, dependency checklists, review packages, milestones, shared progress, workload, escalation and accountable completion evidence |
| Documents and collaboration | Source library, drafts/templates, variables, comments with audience controls, version history, approval/consent records, signed/approved copies and exports |
| Reports and operations | MIS, financial/stock dashboards, consolidated management views, drilldown, saved filters, bulk actions, history, scheduled reports and evidence freshness |
| Imports, automation and continuity | Import preview/control totals, repair/re-import, migration, integrations and entitlements, supervised assistance, backup/restore, audit history and period controls |
| GST | All 24 capability groups below, connected to the operational records above |

Unusual baseline entries remain visible in the crosswalk, including secondary stock, batch splitting, amount/day bill conversion, legacy function-key jobs, crate tracking, kitty/pledge records, OPD/Reki, Super Pack/Home Edition and nearby-shop services. Ambiguous vendor labels still need specimens; grouping them is not permission to discard them. Hardware, third-party networks and licensed data remain explicit dependencies.

**All GST capability groups retained**

| IDs | Functional coverage |
|---|---|
| GST-01–03 | Registration/applicability; tax masters and policies; invoice validation and explanations |
| GST-04–05 | E-invoice lifecycle; e-way/transport compliance and dispatch readiness |
| GST-06–07 | Purchase evidence and receipt linkage; cross-period matching and reconciliation |
| GST-08–09 | Eligibility/claim/reversal/reclaim review; IMS action and evidence workflows |
| GST-10–11 | Supplier/customer resolution; returns, claims and commercial/GST notes |
| GST-12–14 | Reverse charge; return preparation/review/filing evidence; liabilities and payments |
| GST-15–17 | Multi-GSTIN/ISD; imports/exports/SEZ/refunds; composition/QRMP and applicable deduction roles |
| GST-18–20 | Annual compliance/migration; notices/evidence; effective-dated compliance and rate changes |
| GST-21–24 | Common credit/capital goods; job work; advances/adjustments; CA engagement and review |

The underlying detailed workflows remain [inward/ITC](../marg/gst-inward-workflows.md), [outward/filing](../marg/gst-outward-workflows.md) and [special GST cases](../marg/gst-special-cases.md). No tax rate, legal deadline or eligibility conclusion is imported from Byteception's design blogs. Matching, commercial approval, document consent and government filing remain separate decisions.

**Workflow improvements made explicit after the comparison**

1. **Accepted CA scope → recurring work → client-visible completion.** The business defines covered companies/GSTINs, periods, services and responsibilities. An accepted version starts applicable work packages and required evidence requests. Each work item has an owner, review responsibility, internal target and completion criteria; statutory obligations additionally carry a verified deadline and its source. Internal requests and review tasks must not present their target dates as legal deadlines. A scope change affects future or explicitly revised work; it does not silently rewrite signed records or transfer ownership of the business's data to a CA firm. Client users see permitted progress and requests. Their acknowledgement does not mean a return was filed.

2. **Document arrives → accountable evidence → reviewed transaction.** Staff identify company/GSTIN, supplier, purpose and who paid. Capture/mapping suggestions retain the source and uncertainty. Duplicate and ownership checks run before acceptance. Missing evidence becomes an assigned request. The underlying purchase, expense or reimbursement retains its own accounting and tax review. An email/chat connection, if later selected, follows the same process and does not bypass review.

3. **Expense paid personally → reimbursement → correct accounting and GST assessment.** Distinguish the supplier invoice, original payment, employee claim and reimbursement. Check company ownership of the invoice and the expenditure's facts. Approval to reimburse does not establish ITC eligibility. Link settlement once; prevent the supplier payment and later reimbursement from becoming two purchases or two credit claims. Partial reimbursement and rejected claim lines retain their own balances.

4. **Review package → questions → corrected version → fresh approval.** Bundle the precise transactions, evidence and differences under review. Separate internal reviewer comments from messages disclosed to the business or supplier. Replies resolve questions against that version. Changed tax data reopens affected review, while unchanged work can remain valid with a clear impact explanation. Sign-off attaches to the version actually examined. An approved export excludes internal-only discussion.

5. **Recurring obligation → changing circumstances → one correct task.** Keep recurrence, legal applicability and filing status independent. Changing a filing frequency, registration status or verified extension updates affected future work and alerts owners; it does not create duplicates or erase missed periods. A reminder marked read, checklist tick or time-based task completion cannot mark an official obligation filed. Quarterly and monthly work must preserve their distinct purposes.

6. **Two people edit → visible conflict → deliberate resolution.** Show relevant activity and notify a user when the record under review changes. Preserve unsaved work, compare conflicting fields and require a deliberate choice when values cannot safely combine. Only the permitted current version can be posted or approved. A remote refresh must not overwrite a cashier's work or keep an approval green after tax evidence changes.

7. **Bulk action → scope preview → individual results.** A user selects a saved view, sees the companies/GSTINs and record count, then previews the exact action. Distinguish selected rows from all matching results. Check permissions and current record versions individually. Show successes, exclusions and failures with safe next steps. Cross-client export or approval is never authorized merely by being in a consolidated table. Search and filter context must survive normal navigation. This adapts usability considerations from Byteception's [large-list discussion](https://byteception.com/blog/pagination-at-enterprise-scale); it does not select its implementation.

8. **Tax-policy change → reference cases → approved impact.** Authorized accountants maintain reviewed example transactions and expected treatment alongside a policy. A change produces differences, unresolved cases and a new review record. Preserve prior results and rationale. Passing sample checks supports review but does not certify legal compliance or establish that every transaction is correct. This is an ERP review aid inspired by BOLT's evidence pattern, not a new mortgage-testing business.

9. **Assisted work → bounded proposal → accountable action.** A user requests a defined task such as prepare missing-document cases or propose reconciliation matches. The assistant states its scope, records evidence, proposes changes and stops at required review points. Users inspect exclusions, confidence, failures and affected records before an authorized action. Automated orchestration does not acquire permission to choose final tax treatment, send messages, pay, sign or file.

10. **Collection reminder → payment check → appropriate follow-up.** Check allocated payments and unresolved bank matches before drafting a reminder. A confirmed payment changes the follow-up appropriately; an ambiguous receipt creates a review case. Keep the message draft, approval and actual delivery status separate. The owner sees reconciled cash, outstanding invoices and estimated tax with timestamps, rather than a misleading single total.

**Documents, signing and sharing rules**

General document drafting supports templates, imported exhibits, variable validation, versions, review, accepted/signed copies and exports. A signed engagement or business approval is a document consent record. It is not a GST DSC/EVC signature, an IRN or evidence of statutory filing. Which signing methods are needed remains a product question.

The evidence library links documents to source transactions and reviews, with uploader/source/time, version, audience and access scope. Copying an attachment into a package does not broaden its audience. Revoking a client or reviewer removes future access while retaining business-owned audit history. Bank statements, payroll records and client documents follow their assigned permissions.

**Acceptance examples added to the catalogue**

- Re-running a recurring series creates no second obligation for an already-created registration/period/type.
- A vendor rate or tax policy change invalidates affected review only; the old filed snapshot remains inspectable.
- A private CA note is absent from a client PDF, notification preview and shared package.
- An expired invitation or revoked reviewer cannot recover client access through a saved view or old link.
- A collaborator's edit produces a visible version difference before another user approves stale data.
- A partial import can be repaired and re-imported without recreating previously accepted purchases.
- A personal-card expense and its reimbursement create one underlying expense, with separate settlement evidence.
- A bulk action spanning GSTINs gives per-record results and excludes records outside the user's scope.
- A successful document-signing step leaves the GST filing state unchanged.
- An assisted matching job proposes reviewable links and cannot silently post credit, send supplier messages or file returns.

**How to read the coverage evidence**

The [coverage notes](coverage-notes.md) state the reconciliation counts and mapping rules. Every earlier Marg and GST identifier is retained as a source reference. Byteception comparisons classify overlap, deeper specification, genuinely new explicit requirements, exclusions and unverified claims. The list does not add all counts together or present studio marketing as tested ERP behaviour.

This version is ready for product review. It does not choose a stack, reorder delivery priorities or decide between imported evidence, simulation, sandbox and live portal connectivity.
