# Script context

- `sync_coverage.py` copies the canonical feature register into a compact frontend catalogue. Preserve all 85 IDs; do not infer implementation from the research requirement status.
- `sqlite-maintenance.cjs` requires explicit file paths. Backup uses a consistent SQLite snapshot; restore and migration require an offline operator assertion. Test these commands only against temporary databases, and retain the recovery file after replacement.
