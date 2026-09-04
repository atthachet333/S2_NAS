# OFFSITE BACKUP

A backup that lives on the same machine as the data does not survive disk failure, server loss, theft, fire, or ransomware. F6 copies verified backups to a second location and **re-verifies them there**.

## Provider abstraction

```ts
interface OffsiteBackupProvider {
  healthCheck(): Promise<OffsiteHealth>;
  uploadBackup(backupName, backupId): Promise<OffsiteCopyResult>;
  verifyRemote(backupName, backupId): Promise<OffsiteCopyResult>;
  deleteRemote(backupId): Promise<void>;
}
```

No cloud provider is hardcoded. The first implementation is a filesystem provider, which is testable end to end today; a cloud provider can be added later without touching the scheduler or the backup engine.

## Filesystem provider

Configured by deployment, never through the UI:

```
S2_NAS_OFFSITE_BACKUP_ROOT=E:/S2_NAS_OFFSITE_BACKUPS
# or a share:
S2_NAS_OFFSITE_BACKUP_ROOT=//NAS01/S2_NAS_BACKUPS
```

Startup refuses a root that overlaps the storage root or the backup root in either direction — an overlapping root would copy its own copies forever.

The API never returns this path. The UI shows only whether the destination is configured and reachable.

## Layout

The package keeps its identity; nothing is flattened.

```
offsite-root/
  <backupId>/
    database/s2_nas.sql
    storage/...
    manifest.json
    backup.json
```

Only the server-issued backup id is used as a path segment, and it is re-validated before use (`OFFSITE_INVALID_ID` otherwise), so no traversal is possible.

## Verification is mandatory

A successful copy is **not** treated as success. After copying, the provider reads the files back **from the destination** and recomputes SHA-256 for:

- `manifest.json` — must be byte-identical to the local original
- the database dump — against the checksum in the manifest
- every storage object — against its manifest checksum
- the object count — must match exactly

Only then does the backup become `VERIFIED`. Writes to a network share can succeed partially, or be truncated, without the OS reporting an error; trusting the copy call alone would produce backups that only fail on the day they are needed.

An interrupted or partial previous copy is overwritten on the next attempt rather than being topped up, so a half-copy can never be mistaken for a complete one.

## State

`offsiteState` is a separate column from `BackupStatus`, deliberately:

`NOT_CONFIGURED` · `PENDING` · `COPYING` · `VERIFIED` · `FAILED`

**A locally verified backup stays `COMPLETED` even when the offsite copy fails.** The local backup is still good and still restorable; conflating the two would discard a valid backup because of a network problem.

## Retry

Bounded: `S2_NAS_OFFSITE_MAX_ATTEMPTS` (default 3). Once exhausted, automatic retries stop and an administrator must trigger `POST /api/admin/backups/:id/offsite-retry`, which resets the counter. There is no continuous retry loop — a permanently unreachable destination would otherwise generate endless load and log noise.

## Network share availability

`healthCheck()` is a bounded probe (mkdir, write, delete). If the destination is unavailable the copy fails cleanly and is recorded; **the application still starts and backups still run locally**. Offsite availability is never on the startup path.

## Offsite retention — manual, by design

Remote backups are **not** deleted automatically in this iteration. Local retention is automated; remote deletion is manual or handled by a separate operations policy.

The reason is asymmetry of risk: deleting the wrong local copy still leaves the offsite one, but automatic remote deletion driven by a bug could remove the last surviving copy. `deleteRemote()` exists and is tested, but nothing calls it on a schedule. Revisit once remote verification has real operational history.

## Not covered

Offsite copies contain the same content as local ones: no secrets, no `.env`, no source. They are **not encrypted at rest** — they hold all company file content, so protect the destination accordingly. See [DISASTER_RECOVERY.md](./DISASTER_RECOVERY.md).

## Concurrency

Offsite copying deliberately does **not** take the backup operation lock: it only reads a completed package and writes elsewhere, so blocking the nightly backup behind a slow network copy would cost safety without gaining any. See the conflict matrix in [MULTI_INSTANCE_BACKUP.md](./MULTI_INSTANCE_BACKUP.md).

## Safety invariants preserved from F5

The offsite path performs **no database operations at all**. A test asserts the module contains neither `importDump` nor `runSql`, and that copying leaves the live row count unchanged. The three guards introduced after the F5 incident remain in force: dumps contain no `USE`/`CREATE DATABASE`, `assertDumpHasNoDatabaseSwitch` runs before every import, and `importDump` refuses when the target is the live database.
