# RESTORE REHEARSAL

A backup whose checksums verify proves only that **the files have not rotted**. It does not prove the backup can actually be restored. The rehearsal closes that gap by restoring a recent backup for real — into throwaway space — every week.

**There is no production cutover anywhere in this path.** Not in the API, not in the UI, not in the CLI.

## Schedule

Weekly. Defaults: **Sunday 03:30 `Asia/Bangkok`**, deliberately far from the 02:00 backup window because both are I/O heavy and mutually exclusive.

| Setting | Default |
| --- | --- |
| `RESTORE_REHEARSAL_ENABLED` | `true` |
| `RESTORE_REHEARSAL_DAY` | `0` (Sunday) |
| `RESTORE_REHEARSAL_TIME` | `03:30` |

These live in the F4 `SystemSetting` allowlist and inherit its validation, resolution order, audit, and cache invalidation. `RESTORE_REHEARSAL_DAY` accepts `0`–`6`; note that `0` is a *valid* value (Sunday), so it uses a 0-6 range check rather than the positive-integer helper.

No cron syntax. The same F6 scheduler timer dispatches both the backup and the rehearsal — there is no second scheduling engine.

## Missed runs

Identical philosophy to backup scheduling: already ran today → skip; wrong weekday → skip; not yet due → skip; missed within the grace window → run once; missed by longer → wait for next week. Multiple missed rehearsals are never replayed.

## Backup selection

The newest backup that is `COMPLETED` **and** has a recorded manifest checksum (i.e. self-verified at creation). `FAILED` and unverified backups are ignored.

If that backup already passed a rehearsal within `S2_NAS_REHEARSAL_STALE_DAYS` (14), the run is skipped — re-proving the same package weekly costs real I/O and proves nothing new. With no eligible backup, the run is a clean skip, not an error.

Offsite verification is **not** required: this proves the local backup.

## Steps

1. Verify the backup package (manifest, dump checksum, every object checksum)
2. Create the scratch database
3. Import the dump into it
4. Schema sanity check — the core tables must exist
5. Copy every storage object into the staging directory
6. Recompute SHA-256 of each restored file against the manifest
7. Reconcile the restored database against the restored files, both directions
8. Record counts: resources, versions, missing, orphan, checksum failures

Byte identity is checked with **SHA-256 for every object**, never file size alone.

## Safety

**Database.** The scratch name is built from the server-issued rehearsal id, character-filtered, then passed through `assertScratchDatabase`, which rejects the live database name, anything outside `S2_NAS_RESTORE_DB_PREFIX`, and any name with characters outside `[A-Za-z0-9_]`. No user input reaches a database name. `importDump` independently refuses when the target equals the live database, and re-checks that the dump contains no `USE` / `CREATE DATABASE` — the F5 guards are unchanged and re-tested here.

**Storage.** Staging lives under `S2_NAS_REHEARSAL_STAGE_ROOT` (default `<backup root>/_rehearsal-stage`). Startup refuses a value overlapping the storage root or the offsite root in either direction. A test confirms live files are byte-identical after a rehearsal.

## Cleanup

The scratch database is dropped and the staging directory removed in `finally` — on pass *and* on failure.

**A rehearsal that passes but cannot clean up is recorded as FAILED**, with `cleanupFailed` set and `REHEARSAL_CLEANUP_FAILED`. Leftover databases and directories are unowned state that grows every week; reporting success while leaking it would hide a real problem.

## Failure

A failed rehearsal means the *recovery path* needs investigation. It never deletes or downgrades the backup — retention is entirely independent. Live database and live storage are untouched either way. Health becomes degraded and the admin API surfaces it.

Errors are safe strings: "ไฟล์สำรองไม่ครบ", "Checksum ไม่ตรงกัน", "ไม่สามารถล้างพื้นที่ staging ได้". No paths, credentials, command lines, or stack traces.

## Health

`GET /api/admin/backups/rehearsal` reports enabled, day, time, timezone, next run, last run, last status, last rehearsed backup, and last pass. A warning appears when no rehearsal has passed within `S2_NAS_REHEARSAL_STALE_DAYS` (14 days), using the server's own threshold.

## API and CLI

```
GET   /api/admin/backups/rehearsal
PATCH /api/admin/backups/rehearsal
POST  /api/admin/backups/rehearsal/run-now
GET   /api/admin/backups/rehearsals
GET   /api/admin/backups/lock
```

```bash
npm run restore:rehearsal
npm run restore:rehearsal-status
npm run backup:lock-status
```

Permission: `system:backup:manage` — no new permission was introduced.

## Resource usage

A rehearsal reads the whole backup, imports a full dump, copies every object, and hashes everything twice. Expect roughly the I/O of one backup plus one restore, and transient disk use equal to the backup size. It holds the distributed lock throughout, so it can never overlap a scheduled backup.

## Alerting

Not included. Failures are visible in the admin UI and API; email/LINE notification is a later phase.
