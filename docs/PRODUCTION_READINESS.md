# S2 NAS production recovery and migration runbook

Status: preparation only. The 1,765 database-referenced LOCAL objects still require recovery.
Nothing in this document authorizes a production path switch, a database mutation, or a write to
`D:\S2_NAS_DATA` before recovery is complete and independently preserved.

## Fixed locations

- Code root: `D:\S2A_PROJECT\S2_NAS`
- Final data root: `D:\S2_NAS_DATA`
- Intended storage value: `S2_NAS_STORAGE_ROOT=D:/S2_NAS_DATA/storage`
- Intended backup value: `S2_NAS_BACKUP_ROOT=D:/S2_NAS_DATA/backups`

The final data root is separate from source code. User-visible folders are database metadata and
must never be mirrored as physical directory names. Opaque `storageKey` paths remain stable.

Planned layout (do not create before the recovery gate):

```text
D:\S2_NAS_DATA
├─ storage
│  ├─ resources
│  └─ temp
├─ backups
│  ├─ restore-staging
│  └─ _rehearsal-stage
└─ models
   ├─ semantic
   └─ assistant
```

## Other path settings to migrate deliberately

| Setting | Planned relationship | Gate |
| --- | --- | --- |
| `S2_NAS_RESTORE_STAGE_ROOT` | `D:/S2_NAS_DATA/backups/restore-staging` | after recovery |
| `S2_NAS_REHEARSAL_STAGE_ROOT` | `D:/S2_NAS_DATA/backups/_rehearsal-stage` | after recovery |
| `S2_NAS_EMBEDDING_MODEL_PATH` | `D:/S2_NAS_DATA/models/semantic/<model>` | only after model binaries are copied and verified |
| `S2_NAS_ASSISTANT_MODEL_PATH` | `D:/S2_NAS_DATA/models/assistant/<model.gguf>` | only after model binaries are copied and verified |
| `S2_NAS_ASSISTANT_LLAMA_BIN` | final assistant runtime path | only after binaries are copied and verified |
| `S2_NAS_ASSISTANT_TOKENIZER_BIN` | final tokenizer path | only after binaries are copied and verified |
| `S2_NAS_OCR_BIN` | installed OCR executable | retain unless the executable itself moves |
| `S2_NAS_OCR_TEMP_ROOT` | separate disposable temp location | never place beneath storage |
| `S2_NAS_MARIADB_BIN` | MariaDB client directory | retain unless client installation moves |
| `S2_NAS_OFFSITE_BACKUP_ROOT` | different physical disk/network destination | must not be inside data root |

`S2_NAS_BACKUP_ROOT` must not be nested within storage. Offsite backup must be on another physical
device or network destination; another folder or drive letter on the same SSD is not offsite.

## Recovery validation index

The export is a read-only MariaDB query and contains only version ID, resource ID, `storageKey`,
size, SHA-256, and creation timestamp. It never includes credentials or document contents.

```powershell
npm run recovery:index -- --json --output X:\S2_NAS_RECOVERY\reports\local-index.json
```

The output uses exclusive creation and refuses to overwrite an existing report. Expected baseline:
1,765 LOCAL objects and 1,295,344,028 bytes. A different result must be investigated before copying.

## Candidate-root storage audit

This mode does not use or change the active storage root. It opens candidate files read-only and
validates exact `storageKey`, size, and SHA-256 against MariaDB. It also reports missing files,
unexpected files, and same-name candidates found outside their exact stable path.

```powershell
npm run recovery:audit -- --root X:\S2_NAS_RECOVERY\verified --report X:\S2_NAS_RECOVERY\reports\candidate-audit.json
```

Use `--no-checksum` only for a preliminary inventory; that result is never authoritative.

## Verified migration

Always rehearse first:

```powershell
npm run recovery:migrate -- --source X:\S2_NAS_RECOVERY\verified --target D:\S2_NAS_DATA\storage --dry-run --report X:\S2_NAS_RECOVERY\reports\migration-dry-run.json
```

Do not execute that command while recovery is pending: even a dry run against a nonexistent target
does not create it, but the later execute mode does. Execute requires all source objects to match
their database SHA-256 before the first target write:

```powershell
npm run recovery:migrate -- --source X:\S2_NAS_RECOVERY\verified --target D:\S2_NAS_DATA\storage --execute --confirm-verified-copy --report X:\S2_NAS_RECOVERY\reports\migration.json
```

The tool never deletes source, never overwrites a conflicting target, never modifies database rows,
and never edits environment files. It reads every copied target object back and emits
`readyForConfigSwitch: true` only when the complete target audit is authoritative.

## Configuration switch and rollback

The switch is a separate, explicitly approved maintenance action after all 1,765 objects are
authoritative and the recovery image/source remains preserved.

1. Preserve `backend/.env` and record the pre-switch path values without exposing secrets.
2. Stop only `s2-nas-backend` for the final cutover.
3. Set the two intended root values above and the staged/model paths that have passed their gates.
4. Start only `s2-nas-backend`; do not run `pm2 save` while it is intentionally stopped.
5. Run the storage audit with SHA-256, then test preview, download, history, upload, new version,
   classification, workflow submission, Link Lock, backup create/verify, and restore staging.
6. Roll back by stopping only the backend, restoring the preserved environment values, and starting
   only the backend. Never delete either source as part of rollback.

Do not remove missing `ResourceVersion` rows. If fewer than 1,765 objects are authoritative, stop and
produce the exact missing-resource report for an explicit business decision.

## Production runtime

`ecosystem.config.cjs` defines only `s2-nas-backend` and `s2-nas-frontend`. It sets
`NODE_ENV=production` but deliberately contains no storage, backup, model, database, or secret
values. The backend continues to load `backend/.env`; process environment takes precedence.
Production mode requires MariaDB and storage startup checks and uses JSON logging with credential
redaction. No known development-only behavior is required by the backend.

The frontend uses `frontend/server.mjs`, not Vite preview. It serves only build output, provides SPA
fallback, proxies `/api` to `127.0.0.1:8889`, accepts `s2anas.s2aconsultant.com`, serves PWA assets,
rejects source maps, provides no directory listing, and expects HTTPS termination at Cloudflare.
Build first, then use PM2 only during an approved cutover:

```powershell
npm run build
pm2 startOrReload ecosystem.config.cjs --only s2-nas-backend,s2-nas-frontend
```

Do not run that PM2 command during recovery preparation. Do not restart unrelated PM2 applications.

## Backup policy after recovery

- Daily portable-full backup at 02:00 Asia/Bangkok.
- Retain at least 30 daily backups and never fewer than 7 known-good sets.
- Copy each verified backup to a different physical disk or network/offsite destination.
- Verify every new backup; alert when the last success is older than 48 hours.
- Run a staged restore rehearsal weekly at 03:30 Sunday and alert after 14 days without success.
- Acceptance requires zero missing objects, zero checksum failures, and zero new orphan delta.
- Preserve at least one recovery image and the recovery source independently of backup rotation.

## Cloudflare and readiness gate

Cloudflare terminates HTTPS and forwards the public host unchanged. Keep the backend on the local
origin port; expose the frontend origin only as required by the tunnel/reverse proxy. Validate the
public hostname, PWA manifest/service worker, API requests, upload limits, and cache bypass for
authenticated `/api` responses. Never cache API responses at Cloudflare or in the service worker.

Production readiness remains **NO** until recovery, authoritative checksum validation, explicit
path-switch approval, application validation, a new portable-full backup, and a successful restore
rehearsal are all complete.
