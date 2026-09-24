# ERP webapp visual and UX acceptance direction

Design intent: **quiet precision for daily business work**. The interface serves sales staff entering many records, owners scanning operations across companies, and accountants reviewing exceptions. It should feel contemporary and crafted while remaining fast and readable through long work sessions. The app opens directly into a useful workspace, not a marketing or AI-chat screen.

## Experience rules

- Keep the active company, GSTIN, branch, period and user role visible wherever a record can be created or reviewed. Changing context must explain its effect and retain the user's place.
- Make the next business action obvious: what is ready, blocked, awaiting someone else, or complete. Show the accountable person, reason and evidence on the record itself.
- Use a restrained layered palette: calm neutral canvas, strong ink, one decisive action accent and semantic status colors. Status must also have text and icons; color alone is insufficient. Avoid default purple gradients, decorative blobs, nested cards and inflated hero sections.
- Give tabular work proper column alignment, useful density, sticky identity/actions where needed, consistent row heights, visible totals, clear selection and filter counts. Amounts align by decimal; dates and identifiers are easy to distinguish.
- Prefer well-spaced typography, fine dividers, gentle depth and a deliberate rhythm over large empty areas. Contrast and text size must support all-day use.
- Use short, high-signal transitions for opening a detail pane, completing a save and showing a changed status. Respect reduced motion.
- Treat AI as a reviewable tool in context: provenance, proposed changes and an explicit apply step. It should not dominate navigation, copy or visual language.

## Required screens and states to inspect

1. **Workspace home:** active scope, meaningful today/this-period work, exceptions, collections and stock; real seeded amounts; drilldowns lead to the exact records.
2. **Sales and purchases:** lists with search/filter, good empty/loading/error states, dense but legible rows; create/edit form with validation next to fields; draft/post distinctions.
3. **Inventory:** item, batch and location context; movement history; no ambiguous generic "stock" number when branches differ.
4. **GST review:** separate matching, eligibility, approval and official status; evidence links and an explanatory next step on each unresolved case.
5. **Company/GSTIN switcher:** visibly scoped and keyboard usable; owner consolidated view still shows each registration's identity.
6. **Permission and failure cases:** clear denial and recovery copy; no leaked records; blocked action never appears successful.

## Interaction checks

- Keyboard focus is visible; Tab order and Enter/Escape behavior are predictable for tables, filters, dialogs and forms.
- A user can tell whether an action saved after navigation or reload. Pending/failed saves remain explicit.
- Filters, sort and selection are preserved on return from a detail view. Bulk actions preview exact scope and report per-record results.
- Destructive or consequential actions preview effects; tax state changes identify who reviewed which version.
- At desktop width, the navigation and workspace remain clear; at tablet/mobile width, tables can scroll without losing record identity or hiding primary actions.
- Browser contrast, overflow and responsive behavior are inspected in the running app. No lorem ipsum, random KPI numbers or dead controls in the showcase path.

## Review evidence

Capture screenshots of home, a transaction list, an edit form and GST review at desktop width; repeat one operational screen at narrow width. Exercise the seeded scenarios in `demo-scenarios.md`. Record concrete UI defects and fix them before treating the visual pass as complete.
