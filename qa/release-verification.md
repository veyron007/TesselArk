# Local demo verification ledger

The table below records earlier local checks from 24 September 2026. The current verified snapshot is in the final section. Neither snapshot claims full ERP or statutory parity.

| Check | Observation |
|---|---|
| API integration suite | `npm test` passed 61/61 in the orchestration task after the CSV import and cross-period GST fixes, including order amount/regime boundaries, FEFO allocation, evidence scope edits, CSV import integrity and cross-period matching. |
| Web build | `npm run build` passed independently after final integration; Vite transformed 54 modules. |
| Dependency audit | `npm audit --audit-level=moderate` reported 0 vulnerabilities at 07:12 UTC. |
| Fresh production-style startup | Built SPA + API started on `127.0.0.1:3011` with an isolated `/tmp` SQLite file. Browser loaded with no application error. |
| Company scope in browser | Switching from Aster Medical to Aster Services selected its own GSTIN and changed Orders to the new entity's records. |
| Coverage | Clean built app at `127.0.0.1:3001` displayed all 85 researched groups: 19 partial, 66 planned, 0 full parity claims. |
| Evidence seed | Default Mumbai scope showed `SYNTHETIC DEMO: Pharmacy receiving note`: reviewed v1, pending v2, distinct hashes and review history. |
| Return tax review | Staff decision buttons disabled. Accountant accepted seeded `DEMO-CRN-MUM-201` (₹5.40) with reason; local preview showed ₹5.40 reviewed sales credit and -₹5.40 indicative net adjustment. Reload retained decision and audit reason. |
| Statutory simulator | In the dev browser, an IRN rejection produced a persistent `SIM-*` reference and explicit no-government-action text. Recheck final clean seed. |
| All Modules prototype | An ERP-003 case was created and submitted in browser, with visible event history. This did not post inventory. Recheck after default database reset. |
| Clean default demo | Orchestrator backed up the QA database, reset the generated default DB, and started the built app on loopback port 3001. Root browser loaded a clean desktop dashboard. |
| Seeded linked orders | In Bengaluru branch/GSTIN, `DEMO-SO-BLR-301` showed 4/10 fulfilled, 6 remaining, linked dispatch `DEMO-DISP-BLR-301` and approved invoice `DEMO-SAL-BLR-301`. Purchase `DEMO-PO-BLR-302` showed 5/12 received, 7 remaining, linked `DEMO-GRN-BLR-302` and `DEMO-PUR-BLR-302`. |
| Seeded batch | Mumbai expiry watch and batch register displayed `DEMO-SALINE-NEAR-EXPIRY`, six Saline Packs expiring 8 Oct 2026, linked to a stock assignment record. |
| Final navigation | All thirteen sidebar destinations opened in the built browser, including Statement Import. GST Workspace has no `h1`, so a heading-only automated loop stopped there; the page itself rendered source transactions. Simulator, All Modules and Coverage were then opened manually. |
| Statement import, isolated browser | On `127.0.0.1:3011` with a separate `/tmp` database, staff pasted a one-row synthetic CSV. Preview showed 1 new row, 0 conflicts and a disabled commit for staff. After switching to accountant and re-entering the source, commit imported the row and displayed source/user/time/hash history. Re-preview of the same CSV reported 1 exact repeat and 0 new rows. The default `3001` demo database was not changed by this test. |
| Staff-to-accountant import handoff | After the role-switch fix and a built-page reload on `3011`, staff entered a different one-row CSV and previewed it. Switching to Dev Accountant in the same company/GSTIN preserved the source name, CSV and preview; Commit became enabled. |
| Final clean app smoke | `127.0.0.1:3001` returned HTTP 200 for the built app. Bootstrap contained 3 companies and 7 demo users. Default Aster Medical statement-import history was empty as intended, and Bengaluru seeded order API returned the linked partial order records. |
| Final mobile import view | At 390×844 on clean built `3001`, the mobile navigation opened Statement Import, the page showed its heading and zero user imports, and document width stayed within the viewport. |

Those historical checks ended at 61/61 tests and a 54-module build; later work supersedes them.

## Current local verification · 24 September 2026

| Check | Observation |
|---|---|
| API integration | `npm test`: 140/140 passed, including partial GSTIN/branch grants, maker/checker, return quarantine, simulated statutory state, auth, and SQLite maintenance. |
| Coverage | Node test coverage measured 98.89% lines, 81.17% branches, 97.12% functions before the final small auth cleanup. |
| Web build and dependencies | `npm run build` passed at 65 transformed modules; `npm audit --audit-level=moderate` found 0 reported vulnerabilities. |
| Local database | A SQLite online snapshot was saved to `/tmp/erp-default-backup-20260924-0828.sqlite` and passed `PRAGMA integrity_check`; the live default DB also passed integrity check after restart. No QA imports were added to the default DB. |
| Default app | Rebuilt app restarted with `ERP_AUTH_MODE=demo` at `127.0.0.1:3001`; root returned 200. Aster Services' synthetic sale and the admin grant register loaded through the API. |
| Desktop/mobile browser | Current built UI opened Access Grants, Statutory Sandbox and Build Status without page errors; Access Grants showed five registration/branch rows. At 390px the document width was 390px. |
| Navigation sweep | Current default app opened all 19 admin-visible destinations in headless Chrome with no page exceptions or missing main region. |
| Authenticated browser | A separate in-memory production-mode server with test-only insecure cookie handling verified sign-in, signed-in dashboard and sign-out at 390px with no page errors. The real production cookie requires HTTPS. |
| Independent audit | Read-only report at `/tmp/erp-independent-production-audit-2026-09-24.md` mapped 23 partial and 62 planned feature groups and found 0/15 full browser acceptance scenarios verified. Security review at `/tmp/erp-production-auth-security-review-2026-09-24.md` identified statutory access and auth deployment issues; high-priority code findings were fixed and retested. |

This app remains a local demo with a separately tested authentication path. Public deployment, official GST integration and full 85-group feature completion have not been verified.
