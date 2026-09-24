# Technical presentation runbook

Use synthetic records only. The app and all new workflow records are local; demo user switching is not production authentication. Before presenting, confirm the server health, company context, navigation labels and coverage count against the running build.

## Start and confirm

The built app should already be running. Confirm the API and open the app:

```bash
curl -fsS http://127.0.0.1:3001/api/bootstrap
```

Open <http://127.0.0.1:3001>. If that command fails because the server is stopped, build and start the production-style local server from the repository root:

```bash
npm run build
npm start
```

Then confirm bootstrap again:

```bash
curl -fsS http://127.0.0.1:3001/api/bootstrap
```

SQLite persists at `server/erp.sqlite` unless `ERP_DB_PATH` overrides it. For development-only work, `npm run dev` uses Vite on port 5173 and the API on port 3001; do not start it when the built server is already using port 3001.

The response should include the three demo companies, their GSTINs and branches, and demo users. The current API defaults to **Aster Medical Supplies Pvt Ltd (Demo)** and **Maya Staff · staff**.

## Set the context

Start with **Aster Medical Supplies Pvt Ltd (Demo)**, **Mumbai Central**, GSTIN `27DEMOA0000A1Z1`, and **Maya Staff · staff**. Use **Dev Accountant · accountant** for review actions. Keep the context bar visible so the audience can see the company, GSTIN, branch and demo user. The API scopes users to a company, but it does not enforce the narrower branch/GSTIN grants in the future acceptance scenarios.

The currently seeded sale `SAL-01-00001` is locally approved for Harbor Clinic: 2 Glucose Strips, ₹200 taxable value, ₹24 recorded GST and ₹224 total. It posted a stock movement and creates a ₹224 open receivable. It is not a filed tax record.

For a live Evidence Library version action, prepare one small synthetic replacement text file (under 128 KB) on the presentation machine:

```bash
printf 'Synthetic pharmacy receiving note, presentation demo only. Version three.\n' > /tmp/tesselark-evidence-v3.txt
```

## Click-through flows

The current navigation labels are **Dashboard**, **Orders**, **Operations**, **Batches**, **Finance**, **Returns**, **Return Tax Review**, **Evidence Library**, **GST Workspace**, **Statement Import**, **Statutory Simulator**, **All Modules**, and **Feature Coverage**. Simulator and module prototypes are tagged **SIM** and **PROTO** under “Explore the roadmap.”

1. **Partial order fulfillment linked to an invoice.** Change the branch to **Bengaluru Branch**; the GSTIN should change to `29DEMOA0000A1Z7`. Open **Orders → Sales orders** and select the seeded business reference `DEMO-SO-BLR-301`. It is confirmed for Harbor Clinic, with 4 of 10 Glucose Strips dispatched and 6 remaining. The confirmed dispatch is `DEMO-DISP-BLR-301`; the linked invoice `DEMO-SAL-BLR-301` is approved. Point out that fulfillment posted physical stock once and invoice approval records the accounting/tax event without posting that stock again. For the purchase side, **Purchase orders** includes `DEMO-PO-BLR-302` (12 Saline Packs ordered, 5 received, 7 remaining), receipt `DEMO-GRN-BLR-302`, and linked bill `DEMO-PUR-BLR-302`. These are synthetic, local records; the order/dispatch does not represent e-waybill or portal evidence.

2. **Lot receipt, issue, transfer and expiry watch.** Return to **Mumbai Central** and open **Batches**. The source includes the stable near-expiry lot specimen `DEMO-SALINE-NEAR-EXPIRY` with 6 Saline Packs allocated from existing stock and due within 30 days of database initialization; it is an allocation from existing stock, not a new supplier receipt. Use it to show **Expiry watch**. To demonstrate all movement controls without relying on prior browser-smoke lots, choose **Receive new**, tracked item **MED-001 · Glucose Strips**, a unique lot code such as `TALK-<today>-<time>`, quantity 5, a synthetic GRN reference/reason, and expiry about two weeks after the presentation date. Choose **Receive new stock**. Select that exact lot under **Issue**, issue 1, then under **Transfer**, move 2 to **Pune Depot**. Expected balances for this new lot: 2 at Mumbai and 2 at Pune after the three events; refresh to show the batch ledger. These movements affect physical stock only; do not also enter the same receipt elsewhere.

3. **Show linked balances.** Use **Finance → Receivables**. The seeded `DEMO-SAL-BLR-301` invoice is ₹179.20 outstanding; the seeded Mumbai invoice `DEMO-MUM-201` shows ₹50.00 recorded and ₹91.60 outstanding. Open a row to show its invoice, party, branch/GSTIN and allocation. Recorded payment is a local allocation, not verified bank settlement.

4. **Show the commercial return and separate tax decision.** Choose **Returns** and locate the seeded approved return `DEMO-CRN-MUM-201` against `DEMO-MUM-201` when scoped to Mumbai Central. Its ₹5.40 tax amount is an unreviewed proposal. Then open **Return Tax Review**, select the current open period, and select `DEMO-CRN-MUM-201`. On a fresh database, enter a short reason and choose **Accept for preview** as Dev Accountant; if the local review already exists, show its history instead. The separate preview should show ₹5.40 sales credit tax, −₹5.40 indicative net adjustment, and one accepted note. Describe this only as accountant-reviewed local arithmetic. The preview is excluded from recorded GST totals and does not change eligible ITC, period status or filing. Do not describe “eligible” here as statutory eligibility.

5. **Upload, version and review evidence.** Return to **Mumbai Central**. The seed includes **SYNTHETIC DEMO: Pharmacy receiving note**, linked to prototype case `DEMO-CASE-PHARM-036`: version 1 is locally approved, version 2 is pending, and both have different SHA-256 hashes. Select that title in the register to show the seeded version history. Upload `/tmp/tesselark-evidence-v3.txt` using **Upload replacement version → Add version**. The new latest version should be pending; switch to Dev Accountant and choose **Approve evidence**. Refresh to confirm version 3 and its local reviewer/time metadata persist. This shows existing seeded upload/version/review states plus a live version action. Upload validation and hashing establish file handling/provenance only; they do not establish authenticity, portal acceptance or client access.

6. **GST books and synthetic purchase evidence.** Open **GST Workspace** for the Mumbai GSTIN. The seeded Northstar bills `DEMO-NS-501` and `DEMO-NS-502` appear beside synthetic imported fixture rows: NS-501 amounts match; NS-502 differs. Show books amount, candidate source, source period, match state and eligibility state. A local accountant can match the first, mark it eligible with a reason, and block the differing row with a reason. These decisions are local and do not come from a live GST portal. Show the selected period preview and its internal review state; do not call it a filed return or official liability calculation.

7. **Statement Import: staff prepares, accountant commits, GST review stays separate.** Open **Statement Import** as Maya Staff. Choose an open source period, source name, and a CSV (or paste CSV) with the five displayed columns; for a safe repeat/provenance demo use Northstar supplier GSTIN `27DEMOS0000A1Z2`, invoice `NS-501`, taxable ₹300.00, tax ₹36.00, and the invoice date shown on seeded bill `DEMO-NS-501`. Select **Preview and validate** and show the repeat/new/conflict/invalid counts. Switch to **Dev Accountant · accountant**; the current build preserves the CSV and preview across this role switch, and **Commit statement** becomes available. Commit and show **Imported sources**: the exact repeat is skipped, while the local import history records source/user/period and file hash. Separately, in **GST Workspace** use the corresponding open period and `DEMO-NS-501` to show its already-seeded statement candidate; **Check statement match** changes its match state while credit stays **pending**. Only a separate reasoned **Mark eligible** action changes the local ITC decision and claim period. This seeded match is not caused by the repeat import. Optional full new-source path, only if time allows: in **Operations**, create and approve a synthetic purchase bill with a unique supplier invoice reference; import a CSV row with that same supplier GSTIN, reference, date and amounts, then match that newly imported candidate in **GST Workspace**. Do not imply either CSV path is portal-verified or that a match alone grants ITC.

8. **Demonstrate the statutory simulator.** Open **Statutory Simulator**, keep its **SIMULATED** banner and no-portal boundary visible, choose **IRN response**, select approved sale `SAL-01-00001`, choose **Synthetic success**, then **Prepare local request → Run simulation**. The history displays a generated `SIM-*` reference and **Simulated Success**; do not rely on a fixed number because it changes with prior runs. Refresh to show persistence. This records only a synthetic response through `/api/simulations`; it does not create an IRN or register an invoice with the government.

9. **Show the all-module prototype boundary.** Open **All Modules (PROTO)**, search `ERP-003`, and select **Godowns, stores and racks**. Its label says **Planned · prototype case only**. Choose **＋ New case** and save a synthetic draft, for example “Rack transfer planning note,” with a fake reference and notes that explicitly call it planning. The case register persists it. Optionally submit it and switch to Dev Accountant to **Approve case**; the history records human review only. No stock transfer, valuation or specialist inventory effect is posted. Prototype cases do not count as implemented workflows.

10. **Close on coverage.** Open **Feature Coverage**. The current coverage page reports 85 researched groups: 19 **Partial**, 66 **Planned**, and 0 full-parity claims. Partial means only the described slice is available. The added lot, evidence, order, return-tax and statement-import screens represent bounded workflows; a generic prototype case or a simulated statutory response does not make a planned specialist capability implemented.

## Limits to state plainly

There is no live GST portal, bank, e-invoice or government integration. All `SIM-*` outcomes are generated locally. Internal review, evidence upload, payment allocation, tax preview and approval remain distinct from statutory filing and verified source evidence. If a control or seeded record is missing, say it is unavailable in this local build; do not improvise a successful state.


## Two-minute browser-failure script

1. Run `curl -fsS http://127.0.0.1:3001/api/bootstrap` and say: “This is a local SQLite demo. The selected business is synthetic, and the role selector is not production authentication.”
2. Run `curl -fsS -H 'x-company-id: 1' -H 'x-user-id: 1' 'http://127.0.0.1:3001/api/orders?gstinId=2&branchId=3'` and point to the stable business references `DEMO-SO-BLR-301`, `DEMO-DISP-BLR-301`, and linked `DEMO-SAL-BLR-301`: 4 of 10 units dispatched, 6 remaining, invoice approved.
3. Say: “Batches records lot-level stock events and expiry; Evidence Library stores versioned local files and internal review. Neither proves statutory acceptance or document authenticity.” If prepared, show the single synthetic v3 text file and the seeded v1/v2 version history.
4. Close with: “The coverage page reports 19 partial slices, 66 planned groups, and zero full-parity claims. The statutory simulator is local only; no portal or bank integration and no official filing is claimed.”

Do not reset or delete the SQLite database during presentation setup. Refresh the affected page after a mutation to show that the local record persists.
