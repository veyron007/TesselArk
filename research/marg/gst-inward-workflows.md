# Inward purchases, reconciliation and ITC — product workflow specification

Research date: 24 September 2026. Scope: a complete Marg competitor, delivered as a locally developed web application. This document specifies inward workflows; it does not select technology, architecture or delivery priorities. **Proposed behaviour** below is product design, not a claim that GST law prescribes these screens or approvals.

## Evidence and boundaries

Retain Marg's existing purchase entry/import, item mapping, purchase returns, GSTIN verification, 2A/2B reconciliation, tolerance controls, reports and audit history. Marg documents [PDF purchase ingestion](https://care.margcompusoft.com/marg-wallet/purchase-import-through-pdf/183040/10/how-to-import-purchase-pdf-file-through-wallet-in-marg-erp-software) and [2B reconciliation](https://care.margcompusoft.com/margerp/gstr-2a-reconciliation/179260/utils/common). Its [IMS article](https://main.margcompusoft.com/m/what-is-an-invoice-management-system-and-how-marg-erp-keeps-you-gst-compliant/) is a marketing claim; native submission details remain unverified.

Legal/portal anchors are narrower than the proposal:

- GSTR-2B is an inward-credit statement, not a return the taxpayer files. Its availability flags do not resolve every eligibility restriction; taxpayers must self-assess. [GSTN 2B FAQ](https://tutorial.gst.gov.in/userguide/returns/FAQ_gstr2b.htm)
- Rule 37 addresses previously availed credit when supplier consideration remains unpaid after 180 days, with exceptions and subsequent re-availment; the December amendment expressly covers partial non-payment proportionately. [Notification 19/2022](https://gstcouncil.gov.in/sites/default/files/2024-05/19-2022-ct-eng_1.pdf), [Notification 26/2022](https://cbic-gst.gov.in/pdf/central-tax/ct26-2022.pdf)
- Temporary reversals and later reclaims require distinct reporting from permanent reversals. [CBIC Circular 170](https://cbic-gst.gov.in/pdf/Circular-170-02-2022-GST.pdf)
- IMS actions can require 2B recomputation before the corresponding 3B is filed. No action can mean deemed acceptance; it is not equivalent to an internal review. [GSTN IMS FAQ](https://tutorial.gst.gov.in/downloads/news/additional_faqs_ims_17_10_2024.pdf)
- October 2025 changes add bounded Pending options for specified records and ITC-reduction declarations for relevant credit notes/amendments. [GSTN changes FAQ](https://tutorial.gst.gov.in/downloads/news/creative_faq_on_gstr9_for_24_25_dt_15_oct_25_v6_final.pdf)

All legal decisions retain the applicable period, cited rule and reviewer. Imported evidence cannot certify an unseen portal state. **GST portal activity mode is deferred until after the feature map.** Labelled simulation, user-imported evidence, provider sandbox and authorized live connectivity are alternatives for later discussion, not adopted modes. Local web development alone selects none of them. Export, approval, sandbox responses and simulated acknowledgements never display as an official portal submission.

## Roles and page surfaces

Operating model: business staff prepare records and evidence; the accountant/CA reviews tax decisions before period approval. Commercial credit-note evidence follows the applicable facts and rules; the product does not impose a universal CA/CMA certificate requirement.

Routine billing and AP postings proceed under assigned staff permissions and approved policies. Exception decisions and period tax approval require accountant/CA review; a CA need not approve every simple transaction individually.

| Role | Responsibility and authority |
|---|---|
| Buyer | PO, commercial variance, supplier-resolution tasks; cannot approve ITC merely by accepting a price. |
| Receiver | Quantity, batch/serial, expiry, location and service-receipt evidence; cannot classify credit eligibility. |
| AP operator | Captures bills, maps documents, allocates payments and prepares reconciliations. |
| GST accountant | Reviews evidence, proposes eligibility, IMS actions, reversals and period allocations. |
| Controller/CA reviewer | Approves material overrides and tax decisions within assigned GSTINs; leaves reasons and evidence. |
| Authorized filer | Owns external tax actions; authentic portal evidence establishes observed completion through the subsequently selected activity mode. |
| Owner/auditor | Views cash exposure and evidence; auditor access is read-only by default. |

Surfaces: **Purchase Inbox**, **PO & Receipt**, **Bill Workspace**, **2B Reconciliation**, **ITC Register**, **Common Credit Working**, **Capital Goods History**, **IMS Inbox**, **Supplier Cases**, **Period Review** and **Evidence Library**. Each supports GSTIN, branch, period, supplier and status filters, keyboard entry, bulk selection, drill-down and permission-controlled exports. Money is broken down by tax head; counts never substitute for amounts.

## Independent state dimensions

Do not implement one sequence such as “received → matched → eligible → claimed.” One invoice can be received, disputed, portal-matched, partly eligible and partly paid simultaneously.

| Dimension | States / measures |
|---|---|
| Capture | Draft, needs mapping, needs correction, verified, superseded; source version retained. |
| Receipt | Not evidenced, partial, complete, rejected/returned; line quantities and dates. |
| Commercial | PO absent, within tolerance, variance open, exception approved, resolved. |
| Books | Unposted, posted, adjusted/reversed; posted history retained. |
| Matching | Unmatched, suggested, confirmed exact, confirmed tolerance, ambiguous, superseded; separate portal-presence flag. |
| Tax assessment | Unassessed, evidence pending, eligible amount, ineligible amount, disputed amount; reason per allocation. |
| ITC movements | Claim proposed/approved/reported; reversal and reclaim movements with amounts, reasons and periods. |
| Payment | Unallocated, allocated, partly settled, settled, reversed; allocation evidence distinct from bank entry. |
| IMS | Observed portal action, proposed action, approved action, external confirmation, stale/conflicting evidence. |
| Return evidence | Draft, approved, export produced, externally reported, filing evidence verified; 2B freshness tracked separately. |

Reopening a match does not erase an ITC claim. Changing a payment allocation recalculates review proposals, not previously filed figures. Changes invalidate affected approvals explicitly.

## 1. Purchase capture, receipt and PO variance

**Trigger:** invoice, goods, service completion or credit note arrives. **Inputs:** supplier/recipient GSTIN, document type/number/date, PO, source PDF/image/structured file, line quantities/UOM, prices, discounts, freight, taxable values, taxes, batch/expiry/serials, bill-to/ship-to, receipt and payment references.

**Happy path:**

1. AP selects the receiving GSTIN and imports or enters the document. Preserve original file, import time, uploader and a stable fingerprint; show extraction confidence beside each uncertain field.
2. Validate arithmetic, mandatory fields and duplicate candidates before posting. Supplier invoice identity includes supplier, recipient, type, number and financial-year context; punctuation normalization generates suggestions without destroying the original.
3. Map supplier items to internal items and UOM conversions. Preview stock, payable and tax effects; explicitly classify goods, services, capital assets, imports, RCM and ISD evidence.
4. Receiver records actual accepted/rejected quantities and locations. Multiple receipts can link to one bill and vice versa. Service acceptance uses dated completion evidence rather than a fabricated warehouse receipt.
5. Compare PO, receipt and bill by quantity, rate, discount, tax and charges. Buyer resolves the commercial variance; receiver resolves physical differences; accountant reviews tax differences.
6. AP posts the reviewed bill, retaining links to sources and receipts. The ITC register starts an assessment; posting alone never creates an approved claim.

**Branches:** missing PO permits a reasoned exception; it is not necessarily a GST defect. Damaged/expired stock creates return/claim records. Extra quantity can be quarantined pending acceptance. Invoice-before-receipt, split deliveries, free quantity and unit-conversion differences remain visible. A purchase return or commercial debit claim does not automatically establish a supplier GST credit note. Amend posted entries through linked corrections and re-review affected periods.

**Outputs:** purchase register, receipt/stock record, payable, variance case and tax-evidence bundle. No invoice-match rule automatically stops supplier payment; any commercial payment restriction is a separate authorized business decision.

## 2. GSTR-2B reconciliation across periods

**Trigger:** new/recomputed 2B file, corrected bill, supplier amendment or period review. **Inputs:** local purchases, previous matches, 2B/2A files, original and amended document references, prior ITC movements.

**Happy path:** import against a selected GSTIN and period; validate file identity and totals; record generation/download time and version. Run exact matching first, then ranked candidates using GSTIN, type, number, date, tax heads and value. Show both documents side by side. Reviewer confirms suggestions or records an override. Keep books date, document date, supplier reporting period, 2B appearance period and claim period independently searchable.

Search unresolved records across periods and financial years; do not manufacture a missing purchase merely because it appears on the portal. Preserve invoice/amendment lineage and compare amended versus original amounts without counting both as fresh credit. A credit note may relate to multiple invoices; uncertain allocations remain unresolved instead of forcing a false one-to-one link.

**Branches:** duplicate candidates require selection; amount/date tolerances produce “matched with variance” plus explanation, never “eligible.” Portal-only records create evidence requests; books-only records create supplier cases. Imports use BoE identity and supporting customs evidence; ISD and RCM have distinct classifications. 2A can assist investigation but does not silently replace the selected 2B basis. Re-importing the same file changes no totals; importing a newer version shows added, removed and changed records.

**Outputs:** signed reconciliation snapshot, remaining exceptions, tax-head deltas and document lineage. Claimed credit stays traceable when a later correction changes its match.

## 3. Eligibility, claim, reversal and reclaim

**Trigger:** reconciliation review, receipt, payment, credit note, use change or supplier-filing evidence. **Inputs:** document possession, receipt/business-use evidence, restrictions, portal availability, prior claims, payment allocations, tax treatment and applicable legal period.

**Happy path:** accountant assesses each amount as eligible, ineligible or evidence pending, with reasons. Include blocked-credit, mixed/exempt-use, time-limit, receipt, RCM, ISD and import checks appropriate to the transaction; uncertain legal treatment routes to the reviewer. Preview claim amount and return classification. Reviewer approves; period export includes only approved allocations. Imported filed-return evidence records what was actually reported and the reconciliation to the approved draft.

Maintain separate movement amounts for original claim, temporary reversal, permanent reversal, reclaim and credit-note reduction. Each movement cites its source, reason, tax head, approval and reported period. Reclaim requires the original reversal and resolution evidence and cannot exceed its remaining reclaimable balance. Do not reverse unclaimed credit or reclaim permanent disallowance automatically. Compare the period's reclaim schedule with the imported portal reversal/reclaim statement, including opening balances; discrepancies require review. [GSTN statement advisory](https://www.mahagst.gov.in/public/uploads/gstnadvisory/1768891569_389%20Advisory%20%20FAQ%20on%20Electronic%20Credit%20Reversal%20and%20Re-claimed%20Statement%20%20RCM%20Liability%20or%20ITC%20Statement.pdf)

**Payment allocation:** bank reconciliation identifies a payment; AP separately allocates it across invoices, advances and approved adjustments. Partial settlement records allocation date and amount, including treatment of deductions, credit notes and disputed balances. A reviewer confirms whether a non-cash adjustment satisfies the relevant condition. Rule 37 proposals use previously availed ITC and the proportion remaining unpaid, exclude applicable exceptions, and show the day-count and period basis. Later payment proposes reclaim against that specific reversal. Interest is a separately reviewed calculation under applicable law, not a universal flat charge.

For a simple fully eligible ₹11,800 bill with ₹1,800 claimed ITC and ₹5,900 validly allocated payment, the reviewed unpaid proportion is 50%, suggesting ₹900 reversal when Rule 37 applies. A later ₹2,950 valid allocation suggests ₹450 reclaim, subject to remaining reversal and review. Mixed eligibility, credit notes and prior reversals require allocation-level analysis rather than this simplified ratio.

Credit notes show original tax, previously claimed amount, prior reductions and proposed additional reduction. A commercial discount and a GST credit note remain distinct. Rule 37A supplier non-filing review is a separate reason from buyer non-payment; supplier portal evidence, statutory dates and later filing support its reversal/re-availment review. [Notification 26/2022](https://cbic-gst.gov.in/pdf/central-tax/ct26-2022.pdf)

### 3A. Common-credit apportionment and capital-goods use

**Legal distinction:** Rule 42 addresses common inputs/input services and contains annual final determination, subject to exceptions; Rule 43 treats capital goods separately, including use changes and useful-life calculations. Do not transpose Rule 42's annual formula onto every capital asset. The [CBIC rules compilation, Rules 42–43](https://cbic-gst.gov.in/pdf/24092021-CGST-Rules-2017-Part-A-Rules.pdf) establishes this distinction but is dated September 2021; applicable amendments and deadlines must be verified for the working's tax period. [Circular 170, paragraph 4.3(B)](https://cbic-gst.gov.in/pdf/Circular-170-02-2022-GST.pdf) specifies Table 4(B)(1) reporting for the relevant reversals; annual adjustments must not be silently relabelled as ordinary temporary-credit reclaim.

**Proposed workflow:** month-end, new exempt activity, changed business use, year-end or asset-use changes open a **Common Credit Working**. Staff attach invoice allocations, business/nonbusiness-use evidence, turnover classifications and adjustments, prior reversals and asset records. The accountant determines applicability and exclusions; the reviewer approves exceptional judgments and the period working.

Separate exclusively taxable/zero-rated, exclusively exempt, exclusively nonbusiness, blocked and common input/service amounts. Reconcile the resulting pools to the purchase register before calculating anything. The worksheet displays numerator/denominator sources, exclusions, tax-head calculations, rounding, legal version and invoice drill-down. Apply the relevant nonbusiness component only after assessing its conditions. Neither one exempt sale nor an arbitrary cost-centre percentage automatically determines the result.

Prepare the monthly reversal, compare it with earlier approved/reported movements and approve its return treatment. At year-end, the Rule 42 annual working recomputes the applicable annual amounts, compares actual monthly reversals and proposes an additional reversal or credit adjustment with a separately reviewed interest/deadline assessment. Preserve both under- and over-reversal cases; never overwrite monthly filed figures.

**Capital Goods History** stores invoice/tax, capitalization and depreciation treatment, asset location, prior claims, dated use categories, remaining statutory life, transfers/disposal and supporting evidence. Reviewers select the applicable Rule 43 treatment and monthly working; an asset becoming common-use reopens assessment from the evidenced date without restarting its life. Project-specific provisions, sale/disposal and nonbusiness use route to their applicable reviewed treatment rather than a universal percentage.

Independent dimensions are allocation classification, evidence completeness, calculation version, review status and reported adjustment. Zero/unknown turnover, uncertain exclusions, mixed uses, missing asset dates and retrospective corrections remain exceptions with a documented resolution. Later corrections invalidate affected draft approvals and generate comparison workings; filed snapshots stay intact. Outputs are approved monthly schedules, annual reconciliation, asset-use ledger, return adjustments and traceable explanations. Portal mode remains deferred.

## 4. IMS inbox, decisions and recomputation

**Trigger:** imported IMS snapshot or changed supplier document. **Inputs:** document category, portal reference/action, books/receipt match, prior ITC, generation time, filing frequency and period.

**Happy path:** reconcile snapshot to local records; inspect each document; accountant proposes a permitted action with reason; reviewer approves an action manifest. Execution and confirmation follow the activity mode to be discussed after the feature map. An import-based alternative would export a review pack/instructions and ingest subsequent authentic portal evidence; connected alternatives would use the relevant authorized provider workflow. Preserve unresolved or conflicting rows. Approval/export alone never changes the observed portal action; simulation and sandbox outcomes remain explicitly non-official.

Where an action changes the basis of an already generated 2B, mark the period “recomputation evidence required.” After authorized portal recomputation, obtain the refreshed 2B through the subsequently selected mode, compare changes and repeat affected eligibility checks. Tax return readiness requires current evidence or an explicitly documented review exception, not a simulated success toast.

**Branches:** permit actions by document type and effective rules. Do not reject merely because books lack an invoice. Show deemed acceptance separately from deliberate acceptance. For specified credit notes/amendments, calculate Pending expiry from the applicable 2B period and monthly/quarterly filing cycle; offer only actions still allowed. Ask for the applicable ITC-reduction declaration with prior-claim evidence to avoid duplicate reduction. Supplier amendments invalidate stale action approvals. Filed periods cannot be silently recomputed locally.

BoE records need a separate IMS view: October 2025 guidance provides accept/pending handling and GSTIN-amendment reduction declarations. Do not copy the domestic three-action menu onto every import record. [GSTN BoE advisory](https://tutorial.gst.gov.in/downloads/news/creative_advisory_on_boe_in_ims_final_30th_october_2025.pdf)

## 5. Supplier resolution and evidence handoff

An exception creates a case containing disputed facts, amount affected, owner, requested correction and follow-up date. Buyer/AP drafts a supplier request; sending requires an authorized explicit action. Drafts, imported replies and any connected messaging remain distinguishable; the delivery mechanism is not selected here. Supplier promises do not close tax exceptions: attach corrected documents or portal evidence, rerun matching and obtain fresh approval. Resolution history can reopen without losing earlier correspondence.

Every source has filename, fingerprint, GSTIN, period, origin, uploader, capture time and evidence type. Retain raw files, mappings, correction history and exports; distinguish supplier assertion, reviewer judgment and portal evidence. The period pack contains receipts, purchase-to-2B bridge, IMS manifest, eligibility decisions, reversal/reclaim schedule, unresolved cases and sign-offs.

## Acceptance scenarios

1. **Duplicate import:** importing one bill twice produces one posted payable and an explained duplicate candidate; same-number bills from different suppliers remain distinct.
2. **Partial receipt:** a 100-unit invoice with 60 received shows 40 unevidenced; matching never approves the entire ITC automatically.
3. **PO variance:** buyer accepts a higher price; tax assessment remains independently awaiting review.
4. **Cross-period match:** January purchase first appears in February 2B; both dates remain visible and only one claim allocation exists.
5. **Amendment:** a later corrected tax value retains lineage, proposes the difference and leaves filed history intact.
6. **Matched but blocked:** an exact match with a reviewer-confirmed blocked-credit reason produces no eligible claim merely because reconciliation succeeded.
7. **Partial settlement:** the ₹11,800 example produces reviewed ₹900 reversal and ₹450 later reclaim; reversing the payment allocation reopens review without rewriting filed figures.
8. **Credit note overlap:** prior reversal reduces the proposed additional ITC reduction; an unclaimed invoice cannot generate an invented reclaim balance.
9. **IMS action freshness:** approved/exported action remains unconfirmed until authentic portal evidence is obtained through the selected mode; changed action requires refreshed 2B evidence before normal readiness.
10. **Pending expiry/BoE:** domestic credit-note deadline uses the correct filing cycle; a BoE does not expose unsupported Reject.
11. **Supplier promise:** “will upload tomorrow” leaves the exception open; a later matching file resolves it with history preserved.
12. **Wrong evidence:** a different GSTIN file or unlabelled simulated acknowledgement cannot mark a real period externally filed.
13. **Exempt turnover begins midyear:** the working identifies affected common inputs, produces reviewed monthly reversals and an annual Rule 42 comparison without rewriting earlier filed returns.
14. **Capital goods become mixed-use:** dated asset history drives a separate reviewed Rule 43 schedule; neither useful life nor an automatic annual formula resets.
15. **Allocation corrected later:** changing a prior common-use allocation invalidates affected draft approvals and creates adjustment review; original filed amounts and evidence remain accessible.
