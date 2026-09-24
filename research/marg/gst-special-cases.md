# GST special cases: retained product scope

Research checked **24 September 2026**. This extends the Marg competitor feature map; it does not rank features or choose architecture. Each workflow is enabled by taxpayer, registration, transaction and period eligibility. Business staff prepare records; the accountant/CA reviews treatment and exceptions; the authorised signatory controls submission. Examples below are hypothetical acceptance fixtures, distinguishable from official evidence. Local portal-interaction and demonstration modes remain undecided.

## 1. Reverse charge: domestic purchases and imported services

**Trigger and gate:** An inward supply potentially falls within a notified RCM category. Capture service/goods classification, supplier and recipient status, place/time of supply, exemption, supplier forward-charge option where relevant, and effective notification. Neither an unregistered supplier nor a foreign invoice alone proves RCM applicability.

**Workflow:** Purchase staff record the source bill, receipt, payment and assessment facts. The accountant determines liability; the workbench prepares any required self-invoice/payment voucher and period allocation. Show tax payable through cash separately from potentially eligible ITC. Track payment evidence before suggesting the corresponding claim; support blocked credit, partial eligibility, subsequent adjustments and missed-period correction. Outputs: RCM register, cash requirement, document pack, GSTR-3B liability/ITC proposals and differences against the RCM statement.

**Example:** Synthetic bill `RCM-001` has accountant-approved ₹1,800 liability. An existing ₹20,000 credit balance does not settle it. After cash discharge, an independently reviewed eligible amount may be proposed as ITC; a composition recipient cannot claim that credit.

**Basis:** Current [Rule 85(4)](https://taxinformation.cbic.gov.in/content-page/explore-rules/1000476/1000001) and [CBIC Circular 172/04/2022, 6 July 2022](https://cbic-gst.gov.in/pdf/Circular-172-04-2022-GST.pdf) distinguish cash-only liabilities. The [GSTN 2B guide](https://tutorial.gst.gov.in/userguide/returns/FAQ_gstr2b.htm) separates reverse-charge liability from credit eligibility. Category-specific rates, time-of-supply, self-invoice deadlines, interest and imported-service tests require implementation validation.

## 2. Multiple companies, GSTINs, branches and ISD

**Trigger and gate:** Stock, services or shared costs move between locations. Identify legal company/PAN, supplying and receiving GSTIN, and whether locations share one registration. Company permission is not permission for every group company; an accountant must receive explicit access to each company/GSTIN.

**Workflow:** Staff select the source/destination. Same-GSTIN movements follow the applicable movement-document workflow; supplies between distinct GSTINs require their own tax/valuation assessment, including qualifying transfers without consideration. Preserve source dispatch and destination receipt, shortages, returns and tax documents. A group dashboard reports separately and cannot offset one GSTIN’s tax payable with another’s credit.

**ISD:** The accountant separately identifies qualifying third-party input services received for distinct persons. Prepare attributable/common-credit classification, eligible/ineligible amounts, distribution basis, ISD documents, GSTR-6 working and recipient reconciliation. Do not replace an actual branch supply with an ISD allocation. RCM-related service credit requires its payment/distribution trail.

**Example:** Company A’s Maharashtra and Karnataka registrations receive portions of a common service; Company B’s GSTIN is excluded despite common ownership. Physical stock transfer and service-credit distribution have different documents.

**Basis:** [Current Section 20](https://taxinformation.cbic.gov.in/content-page/explore-act/1000289/1000001); [Notification 16/2024, 6 August 2024](https://gstcouncil.gov.in/sites/default/files/2024-09/16-2024-ct-eng.pdf) establishes **1 April 2025** commencement of the relevant ISD amendments. Distribution formulas, distinct-person valuation and internally generated services need transaction-specific validation.

## 3. Imports, bills of entry and IMS

**Trigger and gate:** A registered business imports goods from overseas or receives goods from SEZ through a BoE. Imported services use their own assessment, not a fictitious BoE.

**Workflow:** The import clerk links supplier invoice, port, BoE number/date, GSTIN, assessed value, separate duty components and goods receipt. Match imported GST data and amendments; retain original and corrected GSTIN/value versions. The accountant reviews credit eligibility and permitted IMS action. Outputs: BoE reconciliation, missing-record queue, receipt evidence and proposed credit without treating every customs charge as GST ITC.

**Exceptions:** Partial receipts, wrong GSTIN, missing ICEGATE record, reassessment and already-claimed imports must remain visible. From the **October 2025 period**, the BoE IMS facility permits **accept or pending**; absent action is deemed accepted. Do not copy the domestic-invoice reject action into this screen.

**Basis:** [GSTN BoE advisory, 30 October 2025, page 1](https://tutorial.gst.gov.in/downloads/news/creative_advisory_on_boe_in_ims_final_30th_october_2025.pdf). Example `BOE-TEST-101` can be accepted for statement purposes while credit remains under eligibility review.

## 4. Exports, SEZ, LUT and refunds

**Trigger and gate:** Sales staff propose export or SEZ treatment. Accountant checks export conditions, recipient/location facts and SEZ authorised-operations evidence. Zero-rated and exempt domestic supplies remain distinct. The payment-of-IGST refund route is subject to the applicable notified eligibility; never offer both routes universally.

**Workflow:** Record selected tax route, LUT/bond evidence and applicable period, invoice endorsement, currency/conversion basis, shipping bill/port/export evidence or service-realisation evidence, and SEZ endorsements where applicable. Reconcile sales declarations with customs/portal records. Prepare category-specific refund working, eligible inputs, exclusions, statements, supporting evidence and claim-period overlap checks. Track application reference, deficiency, reply, sanction, rejection, actual receipt and recredit separately.

**Example:** `EXP-007` is ready for sales reporting but its refund pack lacks export evidence; display the missing item, not “refund approved.” A customer marked SEZ does not automatically pass the authorised-operations gate.

**Basis:** [Current IGST Section 16](https://taxinformation.cbic.gov.in/content-page/explore-act/1000624/1000001/section%2016/ACTS), [GSTN refund guide](https://tutorial.gst.gov.in/userguide/refund/Application_for_Refund.htm). Refund formulas, relevant dates, foreign-realisation conditions, LUT exceptions and current route restrictions require implementation validation.

## 5. Composition, regular registration and QRMP

**Trigger and gate:** Onboarding or a regime/turnover change. Capture effective registration/regime dates, state, PAN-level turnover and activity restrictions; accountant confirms eligibility. Composition is not QRMP: one changes tax treatment, the other changes return/payment cadence.

**Workflow:** Composition billing produces bills of supply, prevents collection of GST as ordinary output tax and prevents purchase ITC claims. Prepare quarterly CMP-08 and annual GSTR-4 work; assess inward RCM separately. A regime exit produces a dated transition, stock/credit assessment and separate historical periods rather than rewriting old invoices.

**QRMP:** Retain quarterly GSTR-1/3B with monthly payment working; optional IFF for eligible first/second-month documents. Reconcile filed IFF against the quarter to avoid duplicates. Unfiled saved records have a carry-forward/review path; B2C transactions belong in the appropriate quarterly reporting rather than IFF.

**Basis:** [Current Section 10](https://taxinformation.cbic.gov.in/content-page/explore-act/1000279/1000001), [GSTN annual GSTR-4 guide](https://tutorial.gst.gov.in/downloads/gstr4annualofflineutility.pdf), [QRMP advisory](https://tutorial.gst.gov.in/offlineutilities/returns/QRMP_Advisory.pdf), [IFF manual](https://tutorial.gst.gov.in/userguide/returns/Manual_IFF.htm). QRMP began **January 2021**. Eligibility thresholds, state exceptions, permitted ecommerce activity and filing extensions require period-specific validation.

## 6. Ecommerce settlements, GST TCS and GST TDS

**Trigger and gate:** Marketplace settlement or payment from an applicable GST deductor. Distinguish seller from operator, normal supplies from section 9(5) supplies, GST section 52 TCS from section 51 TDS, and both from income-tax deductions.

**Seller/deductee workflow:** Staff import order, invoice, return, commission invoice, settlement and deduction detail. The accountant resolves gross sales versus net receipt; reconciles GST deductions with GSTR-7/8-derived records; prepares acceptance/rejection in the separate TDS/TCS Credit Received form and verifies cash-ledger credit after filing. Outputs include settlement bridge, missing-credit queue and correction evidence. An income-tax deduction cannot populate a GST credit field; accepted GST deductions are cash-ledger credit, not purchase ITC.

**Registered deductor/operator workflow:** Enable only for the relevant registration and permission. A GST deductor prepares GSTR-7 deduction records, cash payment, review/signature, acknowledgement, certificate and deductee-rejection corrections. An applicable ecommerce operator separately prepares GSTR-8 supplies/returns/TCS, amendments, cash payment and supplier-feedback reconciliation. Seller access grants neither role. Retain invoice/document detail for GSTR-7 and place of supply for GSTR-8 according to the selected reporting period; acceptance can restrict subsequent corrections.

**Example:** A settlement contains ₹100,000 sales, returns, fees, GST TCS and income-tax TDS; each is separately reconciled, never recorded as a single reduced sale. No deduction rate is inferred from the net bank receipt.

**Basis:** Official [GSTR-7 FAQs, questions 1, 7, 15–25](https://tutorial.gst.gov.in/userguide/returns/GSTR7_FAQ.htm) and [GSTR-8 FAQs, questions 1–2, 19, 21–25](https://tutorial.gst.gov.in/userguide/returns/FAQs_GSTR-8.htm). GSTR-8 place-of-supply selection applies from **April 2025**. Both pages were directly retrieved on the research date; older nil-filing/amendment answers coexist with newer entries, so those details require current implementation validation. [GST Council August 2024 newsletter](https://gstcouncil.gov.in/sites/default/files/2024-09/august_newsletter.pdf) records GST TCS reduction effective **10 July 2024**. Validate applicable rates, contract/place-of-supply gates, deadlines and correction restrictions by period rather than copying a portal validation range as a statutory rate.

## 7. Annual reconciliation and notices

**Annual trigger:** Financial-year close for an applicable taxpayer. Accountant confirms that year’s GSTR-9/9C requirement and exemptions. Build book-to-return bridges for turnover, tax, credit, reversals/reclaims, timing, HSN totals and subsequent-year adjustments; attach explanations and approved evidence. Keep company financial statements and GSTIN returns distinguishable. Outputs: review pack, unresolved differences, form working and filed acknowledgements. Do not treat annual reconciliation as permission to revise filed monthly returns or obtain otherwise ineligible ITC.

**Basis:** [GSTN consolidated FY2024-25 FAQs, 17 December 2025](https://tutorial.gst.gov.in/downloads/news/combined_faq_on_gstr_9_and_9c_17122025.pdf). Form/year mappings, turnover thresholds and annual exemptions need fresh validation for the selected year.

**Notice trigger:** Imported notice, intimation or portal discrepancy. Staff record GSTIN, authority, reference, service date, period and response date; accountant classifies and reviews. Link the actual filed snapshot, invoices, payments and reconciliation, then draft an evidence-indexed response. Retain submission acknowledgement, hearing, order and payment/appeal status. A draft is not a filed reply; do not infer notice authenticity or deadlines from free text alone. [GSTN DRC-01C manual](https://tutorial.gst.gov.in/userguide/returns/Manual_Return_Compliance_ITC.htm) documents an ITC-difference response workflow; other proceedings need their own validated requirements.

## 8. Rate/HSN governance and historical migration

**Trigger:** Notification, classification correction, revised supplier/manufacturer price list or import from Marg. Staff propose item mappings; accountant approves source, classification facts, effective dates and exceptions. Preserve invoice tax/MRP history; show affected future documents and stock without retrospectively recalculating filed sales. [Official September 2025 notification guide](https://www.pib.gov.in/newsite/archiveContent.aspx?lang=2&reg=48&relid=276214) identifies the revised rate/exemption schedules dated **17 September 2025**; item-specific conditions and later amendments remain necessary.

**Migration outputs:** Import preview, rejected rows, control totals, opening-balance sign-off and document lineage. Carry original invoice identifiers, GSTIN, period, filing/IRN status, linked returns, prior credit claims/reversals, unpaid balances, open BoEs/refunds/notices and attachments. Separate incomplete historical evidence from a clean record. Opening an old period locally does not reopen a statutory amendment window. Accountant chooses the permissible adjustment route; preserve both original filing and subsequent correction. No migration may fabricate IRNs, portal acknowledgements or credit eligibility.

## 9. Job work: principal and job-worker operations

**Trigger and actors:** A principal sends owned inputs/capital goods for processing, or a job worker receives another business’s stock. Staff identify ownership, GSTINs, job-worker registration, material category and processing instruction. The accountant validates section 143 eligibility. Keep principal-owned stock separate from the job worker’s own inventory and service invoice.

**Workflow:** Link dispatch challan, quantities/batches, receipt, onward movement to another worker, partial returns, processing output and direct customer dispatch. The principal maintains the ownership/accounting trail. Outputs include goods-at-worker register, challan balance, movement evidence, deadline queue, applicable ITC-04 working and job-work charges reconciliation. A physical return closes only its matched quantity.

**Statutory gates:** Track the ordinary one-year input and three-year capital-goods periods separately. Preserve the mould/die, jig/fixture and tool exceptions and actual Commissioner extension orders; extensions are not automatic. Direct dispatch requires the additional-place-of-business test or applicable exception, including registered job workers. Overdue quantities trigger accountant review of deemed supply from the original dispatch date, tax, interest and reporting. Scrap/waste sales identify the responsible supplier: registered job worker or, if unregistered, principal. Loss/destruction receives its own quantity, evidence and ITC/tax review, not an invented return.

**Basis:** [CGST Act consolidated 11 June 2026, sections 19 and 143, printed pages 35–36 and 114](https://www.indiacode.nic.in/indiacode/bitstream/123456789/15689/1/A2017-12.pdf); [CBIC Rule 45 text, page 48 of the November 2020 compilation](https://cbic-gst.gov.in/pdf/10112020_CGST-Rules-2017_Part-A_Rules.pdf), read with [Notification 35/2021, paragraphs 2(4), effective 1 October 2021](https://cbic-gst.gov.in/pdf/central-tax/notfctn-35-central-tax-english-2021.pdf): ITC-04 specified periods became half-yearly above ₹5 crore preceding-year aggregate turnover, annual otherwise. Validate current exemptions/extensions, clock origin for direct delivery, movement documents, valuation and interest calculations before implementation.

## Local acceptance scenarios

All fixtures are synthetic; assessed rates/eligibility are supplied test inputs, not tax advice.

1. Approved ₹1,800 RCM liability cannot consume an existing ITC balance; its eligible credit is independently reviewed.
2. Unregistered supplier without a qualifying RCM category produces a review task, not automatic RCM.
3. Same-GSTIN warehouse movement and distinct-GSTIN supply produce different document proposals.
4. Company A reviewer cannot access Company B; group totals cannot settle cross-GSTIN balances.
5. Shared-service distribution excludes an unrelated company and preserves the accountant-approved allocation basis.
6. Imported goods permit BoE accept/pending, while imported services require their separate workflow.
7. Corrected BoE GSTIN cannot create a second credit claim; prior claimed amount remains traceable.
8. SEZ sale lacking authorised-operations evidence fails automatic zero-rating approval.
9. Refund evidence missing on `EXP-007` prevents “ready to submit”; sanction and bank receipt remain separate.
10. Composition sale cannot issue an ordinary GST tax invoice or create recipient ITC; dated exit preserves history.
11. Filed IFF invoices are counted once in quarter reconciliation; B2C cannot enter IFF.
12. Marketplace GST TCS, GST TDS and income-tax deductions never merge into one credit balance.
13. Annual timing difference links original invoice and later claim/reversal; unresolved difference survives review export.
14. Notice response retains preparer/reviewer versions and remains “draft” until acknowledgement is recorded.
15. Duplicate migration file changes no accepted totals; historic rate and filed status survive an item-master update.
16. Job-work challan for 100 units with 60 returned leaves 40 at the worker, retaining the original deadline and quantity trail.
17. An overdue input batch raises deemed-supply review; a capital asset uses its own period, and an extension requires an actual order.
18. Recorded scrap identifies registered-worker versus principal invoicing responsibility; unexplained loss remains an exception.
19. Direct customer dispatch cannot close a job-work balance until the applicable premises/registration gate and linked sale/movement documents pass review.
20. Seller credit acceptance cannot open GSTR-7/8 filing privileges; accepted deductions enter cash-credit reconciliation rather than purchase ITC.
