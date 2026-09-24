# Local SQLite release and recovery

This runbook applies to the **local synthetic demo**. Keep the server bound to loopback. The commands require Node 26+ and explicit paths; no command defaults to `server/erp.sqlite`. Use an absolute path outside the repository for backups and recovery copies, with enough free space for two additional full-size copies. Protect those copies like the database: they can contain business records and evidence blobs.

## Before a local release

1. Stop `npm run dev`, `npm start`, and any other process using the target SQLite file. Confirm there are no `-wal`, `-shm`, or `-journal` sidecars. If sidecars remain, reopen and cleanly close the database with SQLite so committed WAL content is checkpointed; do **not** delete sidecars by hand. `--offline` is the operator's assertion, not a process detector.
2. Run `npm test` and `npm run build`. Review the code and schema changes. Retain the previous application revision for rollback.
3. Create a snapshot, choosing a **new** output name each time:

   ```bash
   npm run db:backup -- --db /absolute/path/erp.sqlite --output /safe/place/erp-before-release.sqlite
   npm run db:check -- --db /safe/place/erp-before-release.sqlite
   ```

4. Apply pending versioned migrations only while offline. This command creates another verified backup before it changes the database:

   ```bash
   npm run db:migrate -- --db /absolute/path/erp.sqlite --backup /safe/place/erp-before-migrate.sqlite --offline
   npm run db:check -- --db /absolute/path/erp.sqlite
   ```

5. Start the app on loopback, confirm `/api/bootstrap` and the relevant workflow using synthetic records, then retain the release backup. The baseline migration `001-baseline` only checks that expected current tables and columns exist and records its checksum. New migration files must be ordered in `server/migrations.cjs`, immutable after use, and transactional. Use a new forward migration for later changes. Test a copy of the target database before applying it to the target.

## Restore

Stop all processes using the target. Check the desired source snapshot, then restore it. A replacement requires `--replace`, `--offline`, and a **new** `--recovery` path. The command snapshots the current target to that path, verifies both copies, stages the restored file in the target directory, and atomically replaces the main file. It refuses a target with SQLite sidecars.

```bash
npm run db:check -- --db /safe/place/erp-before-release.sqlite
npm run db:restore -- --source /safe/place/erp-before-release.sqlite --db /absolute/path/erp.sqlite --replace --recovery /safe/place/erp-pre-restore.sqlite --offline
npm run db:check -- --db /absolute/path/erp.sqlite
```

For a new isolated database path, omit `--replace` and `--recovery`; the command refuses to overwrite an existing file. To reverse a restore, stop the app and restore the `erp-pre-restore.sqlite` recovery copy to the same target, choosing a **different** recovery filename. Restart the matching application revision after restore. Do not point a newer binary at an older schema without verifying compatibility on a copy.

## Limits and failure handling

- Backups use SQLite's online backup API, so committed WAL changes are included. `integrity_check` and `foreign_key_check` run on source and backup. The command does not authenticate business content or verify statutory records.
- Atomic rename protects the target from a partially written replacement. The recovery copy preserves the previous logical database. These commands do not coordinate with an open application connection; stopping every writer remains mandatory. A process that starts between the sidecar check and rename can still cause trouble.
- Historical `CREATE TABLE`, conditional `ALTER TABLE`, and seed/backfill SQL still execute in `server/db.cjs` and module installers at startup. They are not yet represented by immutable migrations. The baseline is a starting point for future changes, not proof of a fully managed migration history or safe downgrade.
- There is no scheduled backup, retention policy, offsite copy, disk failure recovery, deployment pipeline, or tested multi-host restore. Rehearse this procedure against an isolated copy before using it for important data. This demo remains unsuitable for public production or real statutory filing.
