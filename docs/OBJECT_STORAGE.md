# OBJECT STORAGE

S2 NAS stores document bytes through a **storage provider**, not through the filesystem directly. Two providers exist: `LOCAL` (disk below `S2_NAS_STORAGE_ROOT`) and `S3` (any S3-compatible object store — AWS S3, Cloudflare R2, MinIO). The logical model in [FILE_STORAGE.md](FILE_STORAGE.md) is unchanged: the database holds metadata, the provider holds opaque bytes, and the user-visible folder tree still maps to nothing physical.

## The rule that matters most

**Every row carries its own provider, and that value is authoritative.** `Resource.storageProvider` and `ResourceVersion.storageProvider` say where those bytes live. Reads use the row's provider — never the configured default.

There is **no fallback between providers**. If a row says `S3` and the object is not there, that is an inconsistency to report, not something to paper over by looking on disk. A fallback would let the system appear healthy while damage spreads underneath it, and would silently relocate reads the day the default changes.

Switching `S2_NAS_STORAGE_PROVIDER` therefore changes **where new writes go**, and nothing else. Existing rows keep being read from wherever they already are. Mixed LOCAL/S3 estates are a normal, supported state — not a migration window to be rushed through.

## The provider contract

```
createStorageKey  prepare  put  commitStaged  getStream  getRangeStream
stat  exists  delete  copy  removeResourceScope  health  localPathFor
```

Two deliberate absences and one deliberate addition:

- **No `move()`.** Renames, moves, restores and ownership transfers are metadata-only in this system. A `move()` on the contract would invite callers to relocate bytes for operations that must never touch them.
- **`commitStaged` exists** so `LOCAL` can `rename` a staged file into place instead of re-streaming it. Without it, every upload would pay a second full copy on the local path.
- **`localPathFor` is a compatibility escape hatch, not an API.** It returns a real path for `LOCAL` and `null` otherwise. Only OCR, document extraction, and provider-aware infrastructure helpers may call it. Business services must never branch on filesystem paths — use `withLocalMaterialization` instead, which gives any consumer a local file for the duration of a callback and deletes it afterwards regardless of outcome.

Object keys keep the existing format, `resources/<resourceId>/<uuid>`, on both providers. The S3 provider adds its configured prefix when talking to the store and strips it on the way back, in one place; the rest of the system only ever sees logical keys.

## Integrity and safety

Bytes are streamed and hashed with SHA-256 in the same pass on both providers — nothing buffers a whole document in memory, and range requests transfer only the requested window. **ETag is never used as a checksum**: it is not a content hash for multipart objects. Uploads stage first and commit after the database transaction succeeds; failures discard staged bytes. No ACLs are set and no presigned URLs are issued — downloads stay on authenticated API streams, so authorization is never delegated to the object store.

## Health

`READY` · `NOT_CONFIGURED` · `DEGRADED` (reachable, credentials or permissions insufficient) · `UNAVAILABLE` (unreachable or bucket missing).

These stay distinct because they need different responses, and the failure classifier keeps them apart: a missing object is a `404`, a refused credential is a `502`, an unreachable endpoint is a `503`. Collapsing them would send people hunting for files that never went missing. Health output carries no endpoint, bucket, region or credential.

An outage on the non-default provider never blocks reads from the other one.

## Migration and audit

```bash
npm run storage:migrate -- --from LOCAL --to S3 --resource-ids <id>,<id>
npm run audit:storage -- --checksum --orphans
```

Migration always runs **copy → verify → switch metadata**, in that order, and **never deletes the source**. It is resumable and idempotent; interrupting it leaves extra copies, never a row pointing at bytes that are not there. `--dry-run` reports without writing. Scope migrations explicitly: an unscoped run selects rows across the whole estate.

`audit:storage` is read-only. It reports missing objects, size and checksum mismatches, resource/version inconsistencies, orphaned objects, and `RESTORE_STAGE_RESIDUE` left by an interrupted restore. It probes `S3` health even when no row references S3 yet, so residue and misconfiguration surface before the first real migration. An audit distinguishes "object missing" from "provider unavailable" — reporting thousands of phantom missing objects during a network blip would be worse than useless.

## Backup and restore

Backups are `PORTABLE_FULL` and provider-neutral: bytes are read from whichever provider each row names and written into the archive, so one backup restores to either provider. Manifest v2 records `resourceVersionId` and `originalProvider`; `originalProvider` is **informational only**. The restore target is chosen by the command, never inferred from the manifest — all six cross-provider directions are supported and tested. S3 restores stage under `restore-stage/<runId>/` and are promoted only after verification.

## Observability

Every provider operation logs provider kind, operation, duration, byte count and outcome. Logs deliberately exclude object keys, filesystem paths, bucket names, endpoints, credentials and document content — keys embed resource identifiers, and logs routinely travel further than the system that produced them. For stream-returning operations the recorded duration is time-until-stream-ready, not transfer time.

## Configuration

```
S2_NAS_STORAGE_PROVIDER=local|s3      # where NEW writes go; does not move anything
S2_NAS_S3_ENDPOINT=                   # omit for AWS S3
S2_NAS_S3_REGION=  S2_NAS_S3_BUCKET=  S2_NAS_S3_PREFIX=
S2_NAS_S3_ACCESS_KEY_ID=  S2_NAS_S3_SECRET_ACCESS_KEY=
S2_NAS_S3_FORCE_PATH_STYLE=1          # required by MinIO and most self-hosted gateways
```

Credentials belong in the process environment or a secret manager. `npm run qa:s3-smoke` validates a real endpoint end to end against a disposable prefix; it refuses to run without credentials and must never be pointed at a production bucket.
