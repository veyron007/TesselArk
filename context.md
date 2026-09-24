# Local ERP workspace

- `research/consolidated/feature-register.csv` is the canonical 85-group feature checklist; `coverage-map.csv` maps 180 source rows. Preserve research files.
- The app is a local demonstration. Distinguish invoice/return approval, synthetic evidence matching, ITC review, payment allocation and official filing; no live portal or bank integration exists.
- Run `npm run dev` for web + API, `npm test` for API tests, `npm run build` for the web build, and `npm run coverage:sync` after research changes.
- Synthetic demo users and company context must be scoped in the API, not only hidden in the UI. Use integer cents for money and basis points for GST rates.
- Runtime startup requires `ERP_AUTH_MODE=demo` or `production`. Demo mode uses header-selected users and stays loopback-only; production mode uses provisioned credentials, sessions, CSRF and live GSTIN/branch grants, but public deployment is unverified. Do not equate this auth path with complete product readiness.
- Orders, batch movements and evidence are domain slices with separate records; link approved fulfilment to invoices to avoid a second stock posting. Return tax review is local analysis and stays separate from official filing. The demo server is loopback-only by default because role selection is not production authentication.
