# Current visual review findings

Reviewed 24 September 2026 in Chrome at 1440×900 and 390×844, while the frontend was still changing. Recheck after final integration. The shell is restrained and readable at desktop width; the legal context and GST caveats are visible; the mobile document does not overflow horizontally.

| Finding | Reproduction / effect | Acceptance target |
|---|---|---|
| Invoice form focus and context | Open New invoice: focus remains on the background button, modal lacks dialog semantics, and company/role disappear behind the overlay. | Dialog role, initial/focus containment/restoration, visible company and acting role within form, Escape close. |
| Mobile work below fold | At 390×844, first invoice row begins around y=723; GST review activity is below the initial viewport. | Compact scope strip and toolbar; show the first actionable record/case within a reasonable initial mobile view. |
| Mobile invoice action hidden | 690px table inside 390px width pushes status, amount and Open offscreen; invoice/date wrap. | Keep document identity and primary action visible; no broken identifiers; clear scroll affordance or compact rows. |
| Inconsistent page accents and tiny labels | Green shell with unrelated blue tabs/form accents and small pale secondary text. | Shared semantic tokens and readable scale across operations, finance, returns and GST. |
| Dashboard work hierarchy | Large context and navigation tiles dominate while specific review, collections and low-stock work is secondary. | Prioritize actionable cases and exact drilldowns backed by API records; demote navigation repetition. |
| Invoice filters and tabs | Combined sales/purchase list has search only; tabs do not support full keyboard tab behavior and reset search. | Type/status filters, result counts, preserved section state and keyboard-complete tab pattern. |

The first four are the visual acceptance priority. See `ui-acceptance.md` for the durable design direction.

## Second pass: new modules

The Orders, Batches, Evidence Library, Statutory Simulator and All Modules screens were also checked at 1440×900 and 390×844. They share a coherent visual system and none produced document-level horizontal overflow. The following mobile interaction issues remain to verify after integration:

| Finding | Reproduction / effect | Acceptance target |
|---|---|---|
| All Modules selection loses context | Selecting a capability in the mobile list updates the detail below the viewport (about y=904) while scroll remains at the top. | Reveal and focus the selected detail, or switch to a narrow list/detail view with a clear return action. |
| Batches and Evidence start with long forms | Batch expiry watch/register begin around y=1212/1365; Evidence register begins around y=1056. | Show existing records and exceptions before the creation form; open entry from a clear primary action. |
| Orders and Simulator actions require long scroll | Mobile Create order begins around y=1364 and simulator Prepare request around y=980. | Shorten the intro and keep the active form action reachable, using a sticky footer only if it does not obscure fields. |

These findings were sent to the build task. Screenshot evidence is `/tmp/erp-audit2-*-{desktop,mobile}.png` and `/tmp/erp-audit2-module-selection-mobile.png` on the local machine.
