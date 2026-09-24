# Project instructions for coding agents

Before changing code or research in a directory, read the root `context.md` and that directory's nearest `context.md`. Read parent context files when crossing subsystem boundaries. These files hold durable product and workflow constraints; `progress.md` holds current implementation status.

The researched scope lives in `research/consolidated/feature-register.csv` and its `coverage-map.csv`. Record actual behavior honestly in the app's coverage data and tests. Never infer that a feature works because it appears in the research catalogue or seed fixtures.

This is a local webapp demo under active construction. Keep company, GSTIN and branch identities separate. Treat purchase matching, ITC eligibility, internal approval, statutory signing and actual filing as distinct states. Run the relevant tests and inspect the browser for UI changes.
