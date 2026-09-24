# Browser ERP showcase and acceptance scenarios

This is a seeded, end-to-end acceptance specification for a multi-company, multi-GSTIN, multi-branch browser ERP. It tests linked records and visible state changes across the working frontend, backend and database; it is not a claim that any capability is already implemented. Use synthetic fixtures and the environment's clearly labelled demo mode. A GST portal action can be called submitted, registered or filed only when matching, verified evidence from the actual statutory source is attached. A local simulation, generated JSON, export, upload, payment, screenshot or user-entered reference is not that evidence. No live GST portal integration is claimed.

## Personas and boundaries

- **Staff (Maya, sales/AP/store):** create and correct drafts, receive stock, capture source documents, dispatch goods, record payments and raise return/expense cases within assigned branch and GSTIN. Cannot approve tax exceptions, file returns or inspect other clients.
- **Accountant/CA (Dev):** has explicitly granted access to Firm A's two GSTINs and Firm B's GSTIN. Reviews matching, eligibility, tax exceptions, period work and evidence. A CA engagement or review does not transfer ownership of records or imply filing authority.
- **Owner (Ravi):** manages company setup and grants, sees permitted consolidated business, cash and stock views, approves commercial decisions. Cannot use group ownership to bypass GSTIN permissions or convert estimated liability into filed status.

## Seed data

Create three legal entities and four registrations, with explicit branch-to-GSTIN mapping. Keep all identifiers synthetic and visibly marked as demo data.

| Entity / registration | Branches and operating setup |
|---|---|
| **Aster Medical Supplies Pvt Ltd** — PAN `DEMOA0000A` | Maharashtra GSTIN `27DEMOA0000A1Z1`: Mumbai Central (main), Pune Depot. Karnataka GSTIN `29DEMOA0000A1Z7`: Bengaluru Branch. Regular taxpayer; monthly return cadence. |
| **Aster Services Pvt Ltd** — PAN `DEMOA0000B` | Maharashtra GSTIN `27DEMOA0000B1Z5`: Mumbai Office. Regular taxpayer; monthly cadence. It is commonly owned with Aster Medical but must remain a separate legal entity. |
| **Nila Retail** — PAN `DEMON00000A` | Maharashtra GSTIN `27DEMON0000A1Z9`: Nashik Store. Composition regime, effective-dated. Must not collect ordinary output GST or claim purchase ITC. |

Seed users: Maya (sales and purchase clerk, Mumbai Central + Pune only), Iqbal (storekeeper, Bengaluru only), Dev (CA reviewer, explicitly scoped to Aster Medical and Aster Services; no Nila access), Ravi (owner of all three entities). Add an expired invite for an ex-CA and a revoked session to check removal.

Seed parties and records:

- Supplier **Northstar Pharma** (synthetic GSTIN `27DEMOS0000A1Z2`), **Kaveri Labs** (`29DEMOS0000A1Z3`), and unregistered **Bright Repairs**. Customer **Harbor Clinic** (`27DEMOH0000A1Z4`), registered interstate customer **Mysuru Care** (`29DEMOH0000A1Z8`), and walk-in B2C customers. Include marketplace **Bazaar Demo** as a separate settlement counterparty.
- Items: `MED-001` Glucose Strips (batch tracking, opening 40 at Mumbai); `MED-002` Saline Pack (batch/expiry tracking); `SUP-010` Syringe Pack; `CAP-020` Cold Storage Unit (capital asset); and service `SVC-030` Equipment Calibration. Seed effective-dated, accountant-reviewed demo tax mappings with supplied test rates; label rates and outcomes as fixtures, not legal advice. Add one unmapped service and one expired batch.
- Start with stock ledger, customer/supplier ledgers and opening balances that reconcile. Configure separate Mumbai, Pune, Bengaluru and Nashik cash/bank accounts and cost centres. Seed a common-services invoice for Aster Medical's Maharashtra and Karnataka GSTINs; no allocation to Aster Services.
- Seed linked source documents: PO `PO-101` for 100 MED-001 units; bill `NS-501` for 100 units at the PO rate; receipt `GRN-501` for 60 accepted and 40 short; a duplicate copy of NS-501; an altered-value supplier amendment; February 2B fixture containing the original once and amended version later. Seed one invoice with an approved eligibility allocation, one blocked-credit line, one evidence-pending line, and an RCM review candidate with supplied accountant-approved test liability.
- Seed Harbor invoice `INV-MUM-101` (20 MED-001, batch and stock issue) with partial receipt/payment, Mysuru draft order, a dispatch challan and e-way evidence fixture explicitly labelled simulated, marketplace gross settlement with returns/fees/GST-TCS/income-tax deduction as separate components, and purchase return `PR-501` linked to the received 60 units. Add a sales return of 3 units against the exact sold batch and an unsupported return request for 25 units.
- Seed dated financial periods, an unfiled current-period return workbench, an imported 2B snapshot with source/GSTIN/period metadata, an old-period filed snapshot with matching synthetic verified evidence, one RCM purchase candidate, one BoE review case, a notice draft, and a common-credit working. The historic filed snapshot must remain immutable.

## Scenarios

Each scenario should be executed in the browser under the named persona. Persist changes, reload the affected records, and confirm the API/database-backed result and audit history. Screens should show relevant company, GSTIN, branch, source, actor, timestamp, owner and next action; consolidated views must preserve row identity and filter context.

1. **Access scope survives navigation (Maya → Dev → Ravi).** Maya opens Harbor Clinic and creates a draft from Mumbai Central. Her company/GSTIN/branch context stays visible in list, detail and return navigation. Direct URL/API access to Bengaluru, Aster Services or Nila records is denied. Dev sees only the three explicitly granted GSTINs, while Ravi's permitted group dashboard drills down to each legal entity without netting their ledgers. The expired invite and revoked session cannot reopen a saved link. **Negative:** hiding a row in the UI alone is insufficient; server responses and exports must also enforce scope.

2. **PO → receipt → bill → payable → stock → ITC evidence (Maya then Dev).** Import NS-501 twice. The duplicate is detected without creating a second payable; 60 accepted units post to the selected Mumbai location and 40 remain a visible shortage/variance. Bill posting creates payable and assessment-needed purchase evidence, not approved ITC. Dev can match it to February 2B while retaining January document date and February appearance period. **Negative:** exact match or supplier payment alone cannot approve the unreceived 40 or any credit.

3. **Amendment and idempotent import (Dev).** Import the corrected NS-501/2B snapshot. Show original and amended amounts and lineage, propose only the delta for review, and preserve the accepted original/import totals on re-import. Any changed tax basis invalidates the affected draft approval; the historic filed snapshot is untouched. **Negative:** no duplicate payable, fresh credit claim or rewrite of filed period.

4. **Eligibility → claim → return snapshot → evidence (Dev).** Review NS-501 lines independently: eligible, blocked, and evidence-pending allocations have reasons. Only approved eligible amounts enter the current period's return preview. Approval/export creates a versioned snapshot; mark it filed only after matching statutory acknowledgement/status evidence is verified and stored. A demo/simulation attempt remains visibly simulated and leaves external filing unconfirmed. **Negative:** upload success, payment, JSON generation or CA sign-off cannot set filed.

5. **Sales quote/order → invoice → stock → receivable → collection (Maya then Ravi).** Convert Mysuru Care's order to a Bengaluru-fulfilled interstate invoice under the correct selling GSTIN, with explainable supplied-fixture tax, batch issue and customer receivable. Record a partial bank receipt against that invoice; owner dashboard reflects the remaining balance and branch stock. **Negative:** physical dispatch branch alone cannot silently select taxpayer/GSTIN or tax treatment; no cross-company credit offset.

6. **Dispatch document states stay independent (Iqbal).** Prepare a challan for a stock movement and attach the synthetic e-way fixture. UI shows business dispatch and demo transport evidence independently from any actual portal-registered state. Changing truck details cannot alter invoice tax/amount; delivered status cannot invent portal closure. **Negative:** an expired/mismatched fixture blocks “verified/active” claims and shows recovery owner/action.

7. **Sales return → batch inspection → credit note proposal → stock and AR (Maya then Dev).** Accept 3 returned MED-001 against INV-MUM-101's sold batch into quarantine, link the claim, and show separate stock, commercial receivable and proposed tax-note effects. Dev reviews tax treatment and evidence before adjustment enters return work. **Negative:** the request to return 25 exceeds sold quantity and is rejected or split into a documented exception; commercial refund alone cannot reduce output tax.

8. **Purchase return → supplier claim/payable → tax review (Maya then Dev).** Link PR-501 to the 60 actually received units, record damaged disposition and supplier settlement proposal, and update stock/payable through a traceable adjustment. A supplier commercial debit claim remains distinct from supplier GST credit note and ITC reversal. **Negative:** cannot return the 40 never received or silently reverse an unclaimed credit.

9. **Partial payment and reversal/reclaim proposals (Dev).** Allocate a partial payment against the purchase bill and show remaining payable plus any supplied-rule review proposal with calculation basis. Reversing the allocation reopens affected draft review; later valid payment can propose reclaim only against the same remaining reversible balance. **Negative:** no automatic interest, reclaim of permanent disallowance, or rewrite of an already filed amount.

10. **Marketplace settlement and reminder guard (Ravi).** Reconcile gross sales, returns, fees, GST-TCS, income-tax deduction and net bank receipt as separate rows. GST credit candidate stays in the proper reconciliation flow, not purchase ITC; income-tax deduction creates no GST credit. Before drafting a collection reminder, check invoice allocations and pending bank matches. **Negative:** net deposit cannot be booked as net sales or trigger a reminder for a confirmed-paid invoice.

11. **Common service allocation / ISD review across GSTINs (Dev).** Allocate the seeded common-service evidence only to the explicitly covered Aster Medical registrations using a reviewer-approved basis; show source invoice, recipient allocations and separate review state. Aster Services and Nila remain outside the allocation. **Negative:** common ownership or consolidated access cannot add an unapproved recipient or merge physical stock transfer with service-credit distribution.

12. **RCM liability and cash discharge (Dev).** Review the candidate against seeded classification facts. When the supplied test liability is approved, show liability/payment separately from available ITC; after payment evidence, propose any eligible credit as a separate reviewed allocation. **Negative:** the unregistered supplier flag alone must not assert RCM; existing ITC balance cannot settle cash-only liability; composition Nila cannot claim the credit.

13. **Composition sale and regime boundaries (Maya/Dev).** Create a Nila retail sale as a bill of supply under its effective regime, with no ordinary GST collection and no ITC. Switch context to Aster Medical and confirm its tax setup and history are independent. **Negative:** copying a regular invoice or claiming supplier credit for Nila is blocked with an actionable reason; historical Aster invoices do not change.

14. **BoE, notice and evidence provenance (Dev).** Open the seeded BoE case in its import-specific review with only permitted accept/pending choices; imported services use a separate RCM assessment. Draft a notice response linked to a period snapshot and evidence index. Keep imported records, local judgment and actual official response evidence visibly distinct. **Negative:** no domestic IMS reject option on BoE, no draft labeled filed, no unrelated-GSTIN evidence accepted as verification.

15. **Concurrent edits, bulk scope and audit (Maya plus Dev).** Maya edits an invoice while Dev has opened its review version. Dev sees stale-change warning and field-level difference; neither save silently erases the other's work, and tax changes invalidate sign-off. Select a bulk reminder/export from a filtered view and preview exact records/GSTINs before execution; show per-row outcomes. **Negative:** bulk selection cannot include hidden clients, stale approved versions, or turn a selected simulation into filing.

## Acceptance evidence to capture

For each scenario retain record IDs and before/after state, visible validation/error text, actor and permissions, network/API result, persisted database state, linked source/evidence metadata and audit events. Include one reload/revisit after each successful mutation to prove persistence. A scenario passes only when linked modules agree on identity, quantities and balances, and independent states remain independent. Mark any unavailable workflow as **not implemented** instead of simulating a success.
