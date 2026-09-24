# API and GST integrity review

Read-only review of the local demo on 24 September 2026. Findings were reported while implementation was still moving; recheck each against the final code and mark resolved only with a focused regression test. Production authentication remains out of scope for this demo, but demo claims must match enforced behavior.

| Issue | Trigger and consequence | Expected resolution/check |
|---|---|---|
| Duplicate supplier bill / ITC | Two purchases use one supplier invoice reference, match the same 2B fixture, then both post stock and eligible credit. | Unique supplier/GSTIN/reference within the appropriate scope; one fixture supports one active claim; replay and amendment tests. |
| Supplier identity changed after review | Editing party GSTIN/name changes how a historic bill displays while old matched/eligible evidence remains. | Snapshot identity used by each bill; invalidate affected draft review or force a versioned correction; prior approved snapshot remains inspectable. |
| Non-stock service sale blocked | Aster Services calibration item has no stock, so sale approval fails with insufficient stock. | Explicit service/non-stock item behavior; invoice/tax posting without inventory movement. |
| Period approval strands invoices | Submitted invoice exists when period is reviewed/approved; later invoice approval is blocked with no correction path. | Block review until submitted documents resolved; controlled versioned correction/reopen for later discoveries. |
| ITC assigned to document month | January invoice matched to February 2B is counted in January by invoice date. | Preserve invoice date, source appearance period and separately reviewed claim period; period rollup uses the claim allocation. |
| Negative local tax estimate | Eligible credit exceeds output and UI displays negative value as an estimate, suggesting refund or negative payable. | Separate nonnegative indicative payable and surplus reviewed credit; explain that statutory tax-head utilization is not modeled. |
| Manual stock retry posts twice | Repeated stock movement POST after client timeout changes quantity twice. | Per-company unique source/idempotency key, return existing movement on replay. |
| Demo branch scope not enforced | Maya persona is described as Mumbai/Pune-only but API grants company-wide read/write. | Add server-side user grants by branch/GSTIN across all endpoints, or explicitly revise persona/coverage claims to company-wide demo access. |
| Service return changes stock | Approving a return for a non-stock service creates a physical stock movement; a purchase return can fail for insufficient stock. | Use the item's stock-tracking flag and skip inventory movements for services. |
| Later return blocked by source period | Once the original invoice's GST period is internally reviewed, a later physical/commercial return is blocked although its tax effect is still an unreviewed proposal. | Separate commercial/stock return from current-period tax review; define a controlled late-return path. |
| Historical party name changes | Finance and returns screens join the current party master instead of the invoice's approved name snapshot. | Display the approved invoice identity in those views, retaining the current master separately where useful. |
| Failed scope switch shows stale rows | Finance and Returns keep the previous company's results if loading the new company fails. | Clear scoped lists/totals at load start and show error/empty state until the new response succeeds. |

Source: independent API reviewer assessment of `server/api.cjs`, `server/db.cjs`, tests and `qa/demo-scenarios.md`. The initially observed raw purchase-tax subtraction was already being changed during review; verify the final UI never falls back to raw purchase tax for eligible ITC.

## Orders, batches and evidence review

The new modules were reviewed while code was changing. Findings were sent to the build task for focused regression checks.

| Issue | Trigger and consequence | Expected resolution/check |
|---|---|---|
| Composition order cannot be invoiced | A Nila order with nonzero GST can dispatch stock, but exact linked invoice creation rejects that rate. | Enforce composition tax preconditions before physical fulfilment; test the order-to-invoice path. |
| Unsafe order arithmetic | Individually safe quantity and unit price can multiply beyond a safe integer; the order may fulfil but its invoice later fails. | Check each multiplication, tax and aggregate total before order creation; boundary test. |
| Batch/stock divergence | A dispatch posts generic stock without consuming a lot; lot view can say 10 on hand when branch stock is 5. | Allocate tracked goods to lots with paired movements, or explicitly label the lot ledger as incomplete/unallocated and avoid an available-stock claim. |
| Evidence changes scope with case | Evidence is scoped at upload, but a draft case can later move branch/GSTIN while its old linked evidence remains approved. | Block linked scope edits or invalidate/relink evidence with an audit event; recheck scope on review/download. |
| Shallow file signature check | A malformed file with a plausible PDF prefix can be uploaded and internally approved. | Parse format more fully, or clearly state that format validity and authenticity were not verified. |

The reviewer found no direct cross-company evidence download or mutation exposure in the reviewed routes. Company-wide demo permissions remain a documented limitation.
