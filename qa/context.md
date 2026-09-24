# QA context

- `demo-scenarios.md` is the synthetic showcase and acceptance specification, not a claim that every scenario works. Test actual browser, API and persisted database behavior before marking one complete.
- `ui-acceptance.md` defines the business-focused visual and interaction review. Inspect screenshots at desktop and narrow widths, and exercise controls rather than judging source code alone.
- `api-review.md` tracks reported integrity risks. Recheck against final code and close an issue only with a focused regression test or clear evidence.
- `release-verification.md` records commands and browser results from an isolated production-style local run. Re-run it against the final clean demo database before handoff.
- Keep test data synthetic. Treat local approvals, exported files and simulated references separately from verified statutory filing evidence.
- Do not change source implementation from this folder without coordinating with the code owner; record reproducible trigger, observed result and expected result.
