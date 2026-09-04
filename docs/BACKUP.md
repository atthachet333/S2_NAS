# BACKUP

S2 NAS backs up two things that must stay consistent with each other: **MariaDB metadata** and the **physical files** that metadata refers to. Backing up only one of them is not a backup.

## What one backup contains

```
S2_NAS_BACKUP_ROOT/
  2026-09-03T13-00-00Z_<backupId>/
    database/s2_nas.sql     mariadb-dump output
    storage/...             every file object the metadata references
    manifest.json           what this backup should contain
    backup.json             identity + manifest checksum
```

The folder name is built only from a timestamp and the server-issued id. No part of it comes from user input.

`S2_NAS_BACKUP_ROOT` must live outside `S2_NAS_STORAGE_ROOT`; the server refuses to start otherwise. A backup root nested inside storage would back up its own previous backups, growing without bound.

## Included

- MariaDB dump of the application database
- Current file bytes **and every retained `ResourceVersion`** — version history restores in full
- Trashed resources, whose rows and files both still exist. Excluding them would restore a system whose metadata points at files that are gone
- `driveScope`, so My Drive and System Drive restore correctly with no separate engine
- `SystemSetting` overrides
- `IntegrationApp` metadata and credential **hashes**, restoring active/revoked state exactly as of backup time. No plaintext secret exists anywhere, so none can be recovered — that is by design

Permanently deleted resources have no rows left and are therefore naturally absent.

## Excluded

- `temp/` and any unfinished upload — the manifest is derived from metadata, so a file with no row can never be picked up
- Anything under storage that no metadata references
- `backend/.env`, JWT and refresh secrets, database passwords, private keys
- `node_modules`, source code, deployment configuration

**This is a data backup, not a deployment backup.** Environment variables and secrets are not included and must be backed up separately by operations. See [RESTORE.md](./RESTORE.md).

## Consistency

**Database.** `mariadb-dump --single-transaction` reads every table from one InnoDB transaction snapshot, so the dump is consistent as of its start time without locking the server. Uploads and edits continue normally during a backup. Non-InnoDB tables would not get this guarantee; S2 NAS uses InnoDB throughout. `--skip-lock-tables` is used because the application account has no `RELOAD` privilege.

**Storage.** The file list is read from metadata **after** the dump, deliberately. The ordering matters:

| Order | Consequence |
| --- | --- |
| list read **after** dump (chosen) | list ⊇ dump rows. A file uploaded mid-backup gets copied although the dump has no row for it — a harmless orphan |
| list read **before** dump | dump may contain rows the list lacks — a restored row with **no file**, which is real data loss |

We take the side that fails harmlessly. Orphan files are reported at restore but do not fail reconciliation; missing files always do.

The `counts` block in the manifest is informational only for the same reason — it is read after the dump and may drift by a few rows on a busy system. Correctness is proven at restore by reconciling the restored database against the restored files, never by comparing these numbers.

## Manifest and checksums

`manifest.json` lists every object with its `storageKey`, size, and SHA-256, plus the dump's filename, size, and SHA-256. Checksums are computed from the bytes actually written into the backup, not copied from metadata, so a corrupt source file is caught rather than certified.

The manifest is serialised deterministically (sorted objects, stable key order) so its own checksum is reproducible. That checksum is stored in `BackupLog.manifestChecksum`; verification compares it to detect a manifest edited after the fact.

Nothing in the manifest contains an absolute path, `DATABASE_URL`, or any secret — a backup may be copied somewhere with weaker access control.

## Self-verification

A run is marked `COMPLETED` only after it re-reads its own output and confirms the manifest parses, the dump checksum matches, and **every** storage object matches its checksum. Any failure marks the run `FAILED`. Verification checks all files, never a sample — a sampled check gives no real confidence on the day a restore is needed.

## Concurrency

One backup or restore-staging operation at a time. A second attempt returns `BACKUP_ALREADY_RUNNING` (409). Uploads are **not** blocked during a backup; the manifest ordering above handles concurrent writes safely.

The lock is per process, which suits the current single-process deployment. Multiple backend processes would need a database-level lock.

## Permission

`system:backup:manage`, granted to `SUPER_ADMIN` only; `ADMIN` is excluded by default. Apply with `npm run rbac:sync` — it touches only `Permission`, `Role`, and `RolePermission` and never reads or writes users or credentials.

## API

| Method | Path |
| --- | --- |
| `GET` | `/api/admin/backups/readiness` |
| `GET` | `/api/admin/backups` |
| `GET` | `/api/admin/backups/:id` |
| `POST` | `/api/admin/backups` |
| `POST` | `/api/admin/backups/:id/verify` |
| `DELETE` | `/api/admin/backups/:id` |

DTOs never expose `backupName` or any filesystem path. Deleting a `RUNNING` backup is refused; deletion removes files first and the record only if that succeeded, so a backup can never become an untracked orphan on disk.

## CLI

```bash
npm run backup:create
npm run backup:list
npm run backup:verify -- <backupId>
npm run backup:stage-restore -- <backupId>
```

The CLI calls the same service layer as the API — there is no second implementation that could drift.

## Scheduling, retention and offsite

Automated daily scheduling, the retention policy, and offsite copying are documented separately in [BACKUP_SCHEDULING.md](./BACKUP_SCHEDULING.md) and [OFFSITE_BACKUP.md](./OFFSITE_BACKUP.md). Multi-instance locking is covered in [MULTI_INSTANCE_BACKUP.md](./MULTI_INSTANCE_BACKUP.md), and the weekly restore rehearsal in [RESTORE_REHEARSAL.md](./RESTORE_REHEARSAL.md).

## F10 schema note

External accounts, `organizationName`, and `ResourceAccess.expiresAt` are ordinary columns in the existing tables, so they are covered by the standard full dump with no change to the backup procedure. The restore rehearsal was re-run after the F10 migration and passed.
