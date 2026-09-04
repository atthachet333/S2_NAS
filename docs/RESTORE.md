# RESTORE

Restore is far more dangerous than backup: it overwrites data that is still in use. F5 therefore stops at **"staged and proven"**. There is no one-click production cutover, and nothing in the UI or API writes to the live system.

## Staged restore

Every step happens in a temporary database and a temporary directory:

| | Location |
| --- | --- |
| Database | `S2_NAS_RESTORE_DB_PREFIX` + backup id (default `test_s2nas_restore_<id>`) |
| Files | `S2_NAS_RESTORE_STAGE_ROOT/stage-<id>` |

The live database and live storage are not written at any point.

### Why the `test_` prefix

The application's database account holds `ALL PRIVILEGES` on `s2_nas` only. It cannot create arbitrary databases, but MariaDB grants `CREATE`/`DROP` on the `test_%` namespace to `PUBLIC` by default, so staging databases live there. Change `S2_NAS_RESTORE_DB_PREFIX` if your deployment grants the account a different namespace.

## Two hard safety rules

The dump is generated **without** `--databases`. That flag embeds `CREATE DATABASE s2_nas` and `USE s2_nas` in the file, and an import of such a dump ignores the database named on the command line and writes to the embedded one — silently overwriting production while appearing to target staging. This is enforced twice:

1. `assertDumpHasNoDatabaseSwitch` rejects any dump containing `USE` or `CREATE DATABASE`, both when written and again before import.
2. `importDump` refuses outright when the target database equals the live database (`RESTORE_TARGET_IS_LIVE`).

## 1. Precheck

Changes nothing, anywhere. Fails closed if any of these do not hold:

- backup exists and is `COMPLETED`
- manifest parses and is a supported version
- manifest checksum matches the value recorded at creation
- dump checksum matches
- every storage object is present and matches its checksum
- no unsafe path (`..`, absolute, drive-qualified) appears in the manifest
- enough free disk for staging (skipped, not faked, on filesystems that do not report it)

## 2. Stage

Creates the staging database, imports the dump, copies every object into the staging directory, and re-verifies size and SHA-256 for each one.

## 3. Reconcile

Checks the restored database against the restored files in **both** directions:

- every `resource_versions` row has a file of the right size and checksum
- every staged file is referenced by a row

`missing`, size mismatch, and checksum mismatch fail. **Orphans do not** — they are the expected, harmless result of the backup ordering described in [BACKUP.md](./BACKUP.md).

## Manual production cutover

Not automated, and deliberately so: an automatic cutover without a proven rollback path can turn a recoverable incident into an unrecoverable one.

Before starting, confirm the restore has been staged and reconciled clean.

1. **Announce downtime** and stop the S2 NAS backend. Do not attempt a live cutover.
2. **Create a rollback point** — take a fresh backup of the current state *and verify it*. This is the state you return to if the cutover goes wrong. Skipping this step is the single most common way a restore becomes a disaster.
3. **Snapshot current storage** by moving (not deleting) `S2_NAS_STORAGE_ROOT` aside, e.g. to `storage.pre-restore`.
4. **Restore the database** into the live database from the staged database, or import the dump directly into it. This is the irreversible step.
5. **Restore the files** by copying the staged directory into `S2_NAS_STORAGE_ROOT`.
6. **Verify before reopening**: `npx prisma migrate status` reports up to date, drift shows no difference, the app starts, and a spot check of resources, versions, trash, and both drives looks right.
7. **Reopen access.** Keep the rollback backup and `storage.pre-restore` until you are confident.

### Rollback

If step 6 fails: stop the backend, restore the step-2 backup, move `storage.pre-restore` back, and reopen. This works only if step 2 was actually done.

## What restore does not bring back

The restore environment must already have working application code, a valid `.env` with the correct secrets, a MariaDB server, a storage root, and a backup root. Backups contain **no** secrets or deployment configuration — see [BACKUP.md](./BACKUP.md).

A restored database contains integration credential **hashes** exactly as of backup time. Revoked stays revoked, active stays active. No plaintext secret is recoverable, because none is stored.

## Automated rehearsal

A weekly staged restore proves the newest backup is still restorable without any cutover. See [RESTORE_REHEARSAL.md](./RESTORE_REHEARSAL.md).

## Cleaning up

`npm run backup:discard-stage -- <backupId>` drops the staging database and removes the staging directory. Staging areas are working space, not something to keep.
