# GST outward workflows for the Marg competitor

Product-planning baseline: 24 September 2026. Scope: browser-based ERP, developed locally initially. Business staff prepare transactions; an accountant/CA reviews material tax decisions and returns. Local development does not imply offline customer deployment. Stack, architecture, release order and priorities remain undecided. These are proposed capabilities, not claims that Marg lacks them. Preserve the complete Marg feature inventory alongside these workflows.

**Operating principles**

Every screen must distinguish commercial progress, stock movement, accounting posting, tax treatment, government submission and evidence verification. A delivered invoice can have an unresolved tax issue; a registered IRN does not mean a return was filed. Exceptions show affected money/documents, reason, deadline, owner and the next permitted action. Warnings, business-policy overrides and legally prohibited actions are different categories.

The user has deferred the local portal interaction decision until after the feature map. **Simulation**, **Imported portal evidence**, and **Connected government/provider response** are alternative modes to discuss, not adopted choices. If simulation is selected, its references must be visibly fictitious and never represented as official acknowledgements. If imports are selected, retain file, source, GSTIN, period, import time and reviewer; cryptographic verification, when available, remains separate from checking current portal status. No live access, provider contract or filing authority is assumed. Every submitted/registered/filed state must identify its evidence source; actual filing requires matching government filing acknowledgement/status evidence. Generating JSON, exporting, uploading or paying never establishes filing.

Ordinary invoices that satisfy approved tax rules can proceed under the operator's authorized workflow. Accountant/CA review applies to tax exceptions, material overrides and filing; it is not a mandatory stop for every sale.

**1. Registration, applicability and tax setup**

- **Actors / trigger:** Owner and master-data operator prepare; accountant reviews when onboarding, adding a GSTIN, changing registration status or adopting a rule update.
- **Inputs:** Legal entity/PAN; registrations and effective dates; business locations; taxpayer category and filing frequency; historical aggregate turnover; exemptions; customer GSTIN/UIN/category; goods/services, HSN/SAC, UQC, valuation attributes and source evidence.
- **Steps:** Separate company, GSTIN, warehouse and dispatch location. Establish applicability independently for tax collection, e-invoices, e-way bills and return families. Assign effective-dated classifications/rates with evidence. Distinguish an offline syntax/checksum check from a dated portal registration verification. Preview documents affected by a master change and obtain approval before activation.
- **States:** Setup completeness; registration verification freshness; classification confidence; rule approval; applicability effective period. Unknown applicability is not silently converted to exempt.
- **Exceptions / approval:** Suspended/cancelled registrations, pending amendments, missing turnover years, disputed classifications and changed taxpayer category become assigned review cases. Accountant approves rule/classification changes; operator cannot bypass a legal block.
- **Outputs:** Approved tax profile, evidence register, explainable applicability decisions and reminders for expiring evidence.
- **Acceptance:** Two warehouses under one GSTIN do not create two taxpayers; crossing an e-invoice threshold does not alter past documents automatically; a syntactically valid GSTIN remains “portal status unverified” without evidence.

Applicability needs separate tests: Notification 10/2023 lowered the e-invoice turnover threshold to exceeding ₹5 crore, subject to scope/exemptions; the distinct 30-day reporting restriction applies to AATO ₹10 crore and above from April 2025. Never use one generic “GST turnover” switch. [Notification](https://www.gstcouncil.gov.in/node/4365), [IRP reporting advisory](https://einvoice6.gst.gov.in/content/revised-time-limit-for-e-invoice-reporting-for-businesses-with-aato-of-%E2%82%B910-crores-above/).

**2. Supply classification and prevention at billing**

- **Actors / trigger:** Sales/counter staff prepare a quotation conversion, invoice, challan or supplementary document; accountant handles unusual treatment.
- **Inputs:** Order, supply/payment/invoice dates, supplier registration, contractual buyer, actual recipient, bill-from/dispatch-from/bill-to/ship-to, movement reason, item/batch, price, freight, discount and scheme terms.
- **Steps:** Select the actual supply scenario: domestic B2B/B2C, SEZ, export, deemed export, exempt/nil/non-GST, reverse charge, distinct-person transfer, job work or non-sale movement. Keep these classifications distinct. Determine place of supply using the scenario and evidence; show the reason for IGST versus CGST/SGST. Validate HSN/UQC, tax basis, inclusive/exclusive pricing, cess, rounding, duplicate number, source order quantities and statutory document fields. Preview tax and return classification before issue.
- **States:** Commercial draft/approved/issued; tax valid/review required/blocked; stock reserved/released; accounting unposted/posted. One status must not imply the others.
- **Exceptions / approval:** Missing destination, ambiguous bill-to/ship-to direction, mixed/composite supplies, service-specific place of supply, zero-value goods, taxable/exempt mixtures and backdated documents need targeted review. A tax override records reason, evidence and accountant approval.
- **Outputs:** Explainable invoice calculation, document lineage, tax-ready sales register and actionable field errors.
- **Acceptance:** Physical interstate movement does not automatically dictate IGST in a qualifying bill-to/ship-to transaction; a service advance and goods advance follow their applicable treatment; a challan does not become a sale merely because goods moved.

For the documented three-party bill-to/ship-to case, CBIC explains two invoices but one physical movement/e-way bill, with the generator determining the correct party fields. Capture both supply and movement relationships. [Government clarification](https://www.pib.gov.in/newsite/PrintRelease.aspx?lang=2&reg=48&relid=178856).

**3. E-invoice registration, correction and recovery**

- **Actors / trigger:** Authorized billing staff request registration of an applicable invoice/credit/debit note after normal validation; accountant authorizes material tax cancellation/correction exceptions.
- **Inputs:** Frozen document version, registration decision, validated payload, document key, authorized connectivity or import route.
- **Steps:** Preview; approve issue; submit/export; record each attempt; inspect acknowledgement; verify correspondence to the document; attach signed evidence; release the correct customer copy. After a timeout, establish remote status before resubmitting. A duplicate response opens existing-document reconciliation, not automatic new numbering.
- **States:** Not applicable; required; validation failed; ready; submitted; status unknown; registered; rejected; cancellation requested; cancelled. Correction is a linked workflow, never an in-place edit of acknowledged evidence.
- **Exceptions / approval:** Authentication expiry, portal outage, partial bulk success, reporting deadline, duplicate IRN, mismatched imported evidence and an active e-way bill have separate resolutions. Cancellation checks its permitted window and dependencies. After the window, route to accountant-selected corrective documents/return treatment; never claim the IRN was retrospectively cancelled.
- **Outputs:** IRN/acknowledgement/QR evidence, request history, customer-copy version and correction chain.
- **Acceptance:** Timeout after successful registration yields one document after reconciliation; bulk success is tracked per record; a cancelled document identity is not reused; editing a submitted invoice invalidates pending approval rather than changing its signed copy.

IRP documentation says registered details cannot be amended there; cancellation is within 24 hours, and an active linked e-way bill prevents IRN cancellation. The product must explain these separate operations. [IRP FAQ](https://einvoice6.gst.gov.in/content/faq-powered-by-irisirp/).

**4. E-way bill and dispatch lifecycle**

- **Actors / trigger:** Warehouse/dispatch staff prepare movement; transporter updates permitted transport details; accountant reviews unusual movement/tax classification.
- **Inputs:** Invoice/challan, actual origin/destination, goods value, exemption basis, transporter, mode, distance, vehicle/transport document and consignment grouping.
- **Steps:** Determine requirement using movement type and applicable state rules; allocate who generates it; validate Part A; obtain Part B where required; verify acknowledgement and validity before dispatch. Manage vehicle changes, transshipment, consolidated consignments, eligible extension and cancellation. Delivery proof remains a business event separate from portal events.
- **States:** Packing/ready/dispatched/delivered; e-way not required/Part A/active/expired/cancellation pending/cancelled/status unknown; transport leg and evidence freshness.
- **Exceptions / approval:** Breakdown, route change, rejected delivery, expired validity, goods not moved, wrong Part A, officer verification and portal outage create distinct cases. Manager approval cannot make an expired or otherwise invalid movement document valid. The system presents permitted recovery options and escalates unresolved cases.
- **Outputs:** Dispatch pack, e-way evidence, transporter handover, validity timeline and movement audit.
- **Acceptance:** Updating a truck does not modify taxable invoice values; an incorrect Part A is not silently edited; multiple invoices on one truck retain individual bill validity; physical delivery does not invent a government closure acknowledgement.

NIC documents cancellation restrictions, Part-B updates and validity. Its January 2025 validation limits include 180-day document age and a 360-day extension cap. Apply current exceptions and effective dates. The July 2026 hold on mandatory ship-to GSTIN and e-way closure must override earlier planned changes; a field appearing in an API catalogue alone does not activate it. [NIC FAQ](https://docs.ewaybillgst.gov.in/html/faq_new.html), [validation advisory](https://docs.ewaybillgst.gov.in/apidocs/downloads/Additional_Validations_20241217.pdf), [hold advisory](https://docs.ewaybillgst.gov.in/Documents/eWaybill_hold_Advisory.pdf).

**5. Returns, expiry, schemes and credit/debit notes**

- **Actors / trigger:** Customer service/warehouse receives a return or claim; sales proposes settlement; accountant approves tax treatment.
- **Inputs:** Original invoice lines, batches, quantities already returned, historical rates, reason, inspection, scheme agreement, customer registration and relevant period deadlines.
- **Steps:** Record receipt into saleable/quarantine/damaged/expired stock. Separate replacement, refund, price correction, tax correction, discount and commercial settlement. Propose GST credit/debit note, financial credit or another applicable documented route; show effects on stock, customer balance, tax and recipient credit separately. Allocate across source invoices without duplicating recovery. Register/report documents when applicable and track customer communication.
- **States:** Claim raised/inspected/accepted/disputed/settled; stock disposition; commercial approval; tax reduction eligibility; e-document status; return reporting status.
- **Exceptions / approval:** Late returns, missing source invoices, mixed historical rates, manufacturer-funded discounts, free samples, bundled schemes and expired medicines require scenario-specific decisions. Commercial approval does not authorize reducing GST. Accountant approves tax consequences and supporting evidence.
- **Outputs:** Traceable adjustment chain, customer settlement, tax impact and destruction/reversal tasks where relevant.
- **Acceptance:** Financial credit reduces receivable without automatically reducing output GST; partial return cannot exceed supplied quantity; a medicine expiry claim does not automatically become a generic sales return; a replacement retains both original and replacement movements.

CBIC provides alternative expired-medicine return routes and distinct scheme treatment. Circular 251/08/2025 clarifies commercial discounts; Circular 253/10/2025 withdrew the specific evidence procedure of Circular 212/6/2024. Do not revive a mandatory CA/CMA certificate requirement from that withdrawn circular. Any proposed statutory discount amendment still needs its enacted commencement verified before activation. [Expiry circular](https://gstcouncil.gov.in/sites/default/files/2024-06/circular-no-72_new.pdf), [scheme circular](https://cbic-gst.gov.in/pdf/circular-cgst-92.pdf), [251 circular](https://mahagst.gov.in/public/uploads/mvatservices/176035536214T%20of%202025.pdf), [withdrawal bulletin](https://gstcouncil.gov.in/sites/default/files/2025-11/october_issue.pdf).

**6. GSTR-1 / IFF / GSTR-1A / GSTR-3B close**

- **Actors / trigger:** Staff prepare a period; accountant/CA reviews; authorized signatory controls filing. Trigger is monthly/quarterly close or discovery of a correction.
- **Inputs:** Sales and adjustment registers, IRP/e-way evidence, portal downloads, document series, HSN totals, advances, exports/SEZ evidence, approved inward-credit decisions and ledger balances.
- **Steps:** Reconcile books versus IRP versus portal; resolve duplicates/missing documents; map applicable return tables; validate HSN and document counts. Separate reported outward liability from eligible ITC and payment. Review differences; approve an immutable period snapshot; export or submit through an authorized route; inspect processing errors; compare portal preview; obtain signing authorization; retain filing acknowledgement. Reconcile 3B against 1/1A, inward decisions, RCM and ledgers before payment/offset and filing.
- **States:** Preparing/issues/reviewed/approved; exported/uploaded/processed; awaiting signature/filed/status unknown; payment initiated/confirmed/offset. Each form has its own state and evidence source. “Filed” requires matching actual government filing acknowledgement/status evidence; imported evidence remains labelled as imported and a hypothetical simulation can only show simulated filing.
- **Exceptions / approval:** Late invoices, saved portal drafts, failed uploads, amendments, nil-return eligibility, QRMP/IFF duplicate inclusion and post-approval edits create reviewed tasks. Any material change invalidates affected approval. Never equate successful upload or payment with filing.
- **Outputs:** Return-ready files, variance explanations, signed-off snapshot, actual filing evidence and residual action list.
- **Acceptance:** Same-period correction uses eligible GSTR-1A routing; recipient GSTIN correction does not use an unsupported 1A operation; an IFF document is not counted twice; changed invoice values reopen approval; a demo filing remains “Simulation”.

GSTR-1A is optional, once per period, available after GSTR-1 filing/due date as applicable and before that period’s 3B; recipient effects reach a later 2B. Current return mapping also needs separate B2B/B2C HSN summaries and document-series controls. [GSTR-1A FAQ](https://tutorial.gst.gov.in/downloads/news/creative_faqs_on_gstr1a_fo_cr25785.pdf), [HSN/document advisory](https://tutorial.gst.gov.in/downloads/news/updated_advisory_hsn_table12_25042025.pdf), [3B guide](https://tutorial.gst.gov.in/userguide/returns/GSTR3B.htm).

**7. Rate transitions and interrupted work**

- **Actors / trigger:** Accountant prepares a verified rate/rule change; staff resume affected drafts or interrupted operations.
- **Inputs:** Enacted notification/effective date, classification, supply/payment/invoice dates, existing stock, open orders, returns, approvals and prior evidence.
- **Steps:** Preview affected items/documents; classify time-of-supply cases; review prices/margins; schedule approved changes; notify operators; preserve past values. Recover saved work at its last confirmed state; reconcile external outcomes before retry. Show deadlines with uncertainty, not invented acknowledgements.
- **States:** Rule proposed/reviewed/scheduled/effective/superseded; draft stale/revalidated; operation pending/uncertain/reconciled; approval valid/invalidated.
- **Exceptions / approval:** Missing event dates, overlapping rules, goods becoming exempt, backdated invoices and partial payments need accountant review. Distinguish a configuration correction from changing history.
- **Outputs:** Transition impact report, approved rule version, revalidation tasks and preserved calculation evidence.
- **Acceptance:** An old invoice remains unchanged after a rate update; supply/invoice/payment straddling a change is evaluated explicitly; the return of an old sale is not blindly valued at today’s rate; browser refresh or network failure does not duplicate posting.

The government's rate-transition FAQ confirms why invoice date alone is insufficient and why accumulated credit and newly exempt supplies need different treatment. [Official transition FAQ](https://www.gstcouncil.gov.in/sites/default/files/2025-09/faq_0.pdf).

**8. Customer advances, adjustment and cancellation**

- **Actors / trigger:** Accounts staff record money received before invoicing; sales associates the order; accountant reviews uncertain treatment, tax adjustments and period close. Trigger includes receipt, partial invoicing, cancellation or refund.
- **Inputs:** Customer/order, receipt and bank dates, amount, goods/service classification, supply location, expected supply, taxpayer category, rate evidence, original receipt voucher and previous allocations.
- **Steps:** Distinguish an advance for supply from a refundable security deposit or unidentified receipt. Assess tax applicability before calculation: ordinary qualifying goods advances benefit from Notification 66/2017, while taxable service advances can trigger liability under section 13. Apply exemptions and exceptions explicitly; the goods relief excludes specified actionable claims after the 2023 amendment. Issue the required receipt voucher/document, record applicable taxable value/tax and reconcile the receipt to the bank. Allocate advances to one or multiple subsequent invoices with a visible balance; carry applicable tax adjustments between periods without charging the same value twice. If cancelled before supply and tax invoicing, link a refund voucher to the receipt; otherwise route through the appropriate invoice/credit-note process. Record actual refund separately from an approved refund instruction.
- **States:** Receipt identified/unidentified; allocation unallocated/partial/full; tax assessment pending/not payable/payable/reported/adjusted; refund requested/approved/paid; balance open/closed.
- **Exceptions / approval:** Uncertain rate/place of supply, mixed orders, rate changes, split refunds, cross-GSTIN allocation and already-filed periods become accountant cases. Refund approval never automatically changes a filed return; propose the permitted adjustment with evidence.
- **Outputs:** Advance ageing, voucher chain, bank reconciliation, invoice allocations, tax-period adjustment schedule and unapplied/refundable balances. Purchase advances connect to procurement and the inward/RCM workflow: assess reverse charge only where applicable; paying an advance alone does not establish ITC eligibility.
- **Acceptance cases:** (1) A qualifying goods advance records cash and liability without incorrectly collecting advance GST. (2) A taxable service advance reported in one period and invoiced in the next adjusts the previously reported amount once, retaining any unallocated balance. (3) A cancelled unfulfilled order produces a linked refund voucher and payment evidence; a partial refund cannot exceed the unapplied balance or silently reduce filed liability.

Primary basis: [Notification 66/2017](https://www.gstcouncil.gov.in/hi/node/3993), [50/2023 amendment](https://gstcouncil.gov.in/node/4405), [CGST section 13](https://www.cggst.com/uploads/document/1752318380-section-13.pdf), and [CGST receipt/refund voucher provisions, section 31(3)(d–e)](https://cbic-gst.gov.in/hindi/CGST-bill-e.html).
