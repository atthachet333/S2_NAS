# BACKUP SCHEDULING

F6 turns the verified F5 engine into an unattended one. It reuses the F5 backup, verification, and deletion services without reimplementing any of them.

## Schedule

One system-wide daily schedule.

| Setting | Default | Editable at |
| --- | --- | --- |
| `BACKUP_ENABLED` | `true` | `/admin/backup` |
| `BACKUP_TIME` | `02:00` | `/admin/backup` |
| `BACKUP_RETENTION_DAYS` | `30` | `/admin/backup` |
| `BACKUP_MIN_KEEP_COUNT` | `7` | `/admin/backup` |
| `OFFSITE_COPY_ENABLED` | `false` | `/admin/backup` |
| Timezone | `Asia/Bangkok` | `S2_NAS_BACKUP_TIMEZONE` (deployment only) |

All five editable settings live in the F4 `SystemSetting` allowlist, so they inherit its validation, DB → env → default resolution, audit trail, and cache invalidation. Changing them needs `system:backup:manage`; no second permission was added.

Only `DAILY` is supported. Hourly, weekly, and cron expressions are deliberately out of scope — a schedule that is reliable beats one that is flexible.

## Timezone

`BACKUP_TIME` is interpreted in `S2_NAS_BACKUP_TIMEZONE`, **never** UTC. Conversion uses `Intl.DateTimeFormat` to read the zone's actual offset at that instant rather than adding a fixed number of hours. Asia/Bangkok has no DST, but the code does not depend on that — moving the deployment to a DST zone must not silently shift backups by an hour.

The timezone is deployment configuration, not a UI setting: changing it retroactively reinterprets "which day" a backup belongs to, which is an operations decision.

## Restart and catch-up

The scheduler ticks every minute and decides from data, not from an in-memory timer, so a restart cannot lose or duplicate a run.

| Situation | Behaviour |
| --- | --- |
| Schedule disabled | skip |
| A scheduled backup already succeeded today (in the configured zone) | skip — this is the duplicate guard |
| Today's time not reached | skip |
| Missed by ≤ `S2_NAS_BACKUP_CATCHUP_GRACE_HOURS` (default 6) | run once, as catch-up |
| Missed by more than the grace window | skip and wait for the next day |

"Already ran today" is derived by querying the latest `SCHEDULED` + `COMPLETED` row and converting its `startedAt` into the configured zone. There is no separate state file to fall out of sync.

The last rule is deliberate: a server that was down for three days should not fire three backups on boot. Each would capture the same present-day state, so the extra runs add cost and no safety.

## Duplicate-run prevention

Three independent layers:

1. **Decision** — `ALREADY_RAN_TODAY` blocks a second run for the same zoned date.
2. **Operation lock** — the F5 per-process lock; a tick that finds any operation running skips rather than queues.
3. **Single timer** — one interval per process, so the scheduler cannot race itself.

A manual backup started while a scheduled one is running is rejected with `BACKUP_ALREADY_RUNNING` (409), and vice versa.

## Disk space

Before a scheduled run, free space at the backup root is compared against twice the size of the most recent completed backup. Clearly insufficient space aborts before any large copy starts. Filesystems that do not report free space do not block the run — but the check is skipped honestly rather than reported as passed.

Retention **never** runs to free space for a backup; it runs only after a successful one, under its own policy.

## Retention

Runs after each successful scheduled backup, and on demand from the UI or `npm run backup:retention`.

Rules, in priority order:

1. Only `COMPLETED` backups are candidates. `PENDING`, `RUNNING`, and `FAILED` are never deleted automatically.
2. Delete those older than `BACKUP_RETENTION_DAYS`…
3. …but never drop below `BACKUP_MIN_KEEP_COUNT`.
4. Never delete the last remaining good backup, even if the minimum is configured as 0.
5. Oldest first.

Example: 30-day retention, minimum 7, only 5 backups exist → **nothing is deleted**.

Deletion goes through the F5 `deleteBackup` service, which removes files first and the record only if that succeeded. A physical deletion failure keeps the metadata, records `BACKUP_RETENTION_FAILED`, and processing continues with the remaining candidates.

## Health and staleness

`/admin/backup` shows last backup, last status, next run, verified count, and last verified offsite copy — all real values, no fabricated progress. If no successful backup exists within `S2_NAS_BACKUP_STALE_HOURS` (default 48), a warning appears using the server's own threshold rather than a hardcoded number.

## Operator identity

Scheduled runs are attributed to a real account that already holds `system:backup:manage`, chosen by oldest active user. No service account is created and no credential is touched. If nobody holds the permission, the scheduler does nothing — better than backing up in the name of an unidentified actor.

## Audit

`BACKUP_SCHEDULE_UPDATED`, `BACKUP_SCHEDULE_ENABLED`, `BACKUP_SCHEDULE_DISABLED`, `BACKUP_SCHEDULED_STARTED`, `BACKUP_SCHEDULED_COMPLETED`, `BACKUP_RETENTION_DELETED`, `BACKUP_RETENTION_FAILED`. No paths and no secrets.

## CLI

```bash
npm run backup:schedule-status
npm run backup:retention
npm run backup:offsite -- <backupId>
```

## Limitations

- Multi-instance safety is now enforced by a MariaDB advisory lock - see [MULTI_INSTANCE_BACKUP.md](./MULTI_INSTANCE_BACKUP.md).
- The settings cache is per process too, so another instance would not see a schedule change until its own cache is invalidated.
- Frequency is daily only.
