# Frontend context

- React/Vite pages consume the local `/api` endpoints through the Vite proxy. Send `x-company-id` and `x-user-id` for scoped calls.
- Workspace pages use bookmarkable paths (`/orders`, `/operations`, `/budgets`, etc.); source order and invoice links use a validated positive `?record=` ID. Selected GSTIN and branch IDs are carried in the URL and validated against the current company's permitted scope on load. App navigation updates browser history, and Back/Forward restores the page and branch. Record visibility still follows the selected company, GSTIN, branch and user grants.
- In production auth mode, the shell signs in through `/api/auth/login`, resumes via `/api/auth/session`, sends `X-CSRF-Token` on mutations and hides demo company/user switching. Browser cookies are HttpOnly; do not read them in client code.
- Keep company, GSTIN, branch and role visible during operations. Use loading, empty, success and error states for every data workflow.
- Do not label local GST period review as filed or officially submitted.
- The approved Prism Overview (Option C, 2026-09-24) visual system is applied through `prism-shell.css` and `prism-pages.css`; domain overrides deliberately outrank lazy-loaded page styles. `components/PrismDashboard.jsx` presents real API data. Dashboard KPI totals cover all recorded dates in the selected branch; charts cover six calendar months. GST chart periods remain registration-wide and show reviewed eligible ITC, not raw purchase tax. Keep chart table alternatives and the explicit local-review labels.
