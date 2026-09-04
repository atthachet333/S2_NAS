# TRASH

`POST /api/resources/:id/trash` soft-deletes the selected resource and its active descendants. Physical version files remain in place. Normal listings, recent, preview, download, and ZIP exclude trashed rows.

Restore uses `POST /api/resources/:id/restore`:

- Normal: restore to `trashedFromId`.
- Name conflict: server returns `TRASH_RESTORE_CONFLICT` with `reason: NAME_CONFLICT`; UI requires a valid new name.
- Original parent missing/deleted: server returns `reason: PARENT_MISSING`; UI requires an explicit `FolderPicker` destination. Root is allowed only when deliberately selected.

Permanent deletion first previews exact resource/file/version counts, then deletes every descendant physical version and metadata. It is irreversible. `S2_NAS_TRASH_RETENTION_DAYS` (default 14) is enforced by a retention worker.

Each trashed resource expires on its own clock at `deletedAt + S2_NAS_TRASH_RETENTION_DAYS`; the trash is never emptied wholesale on a shared cycle, so a user who deletes something today always gets the full window to restore it. The listing returns `expiresAt` per row and the UI shows the remaining days.

The worker (`backend/src/modules/files/trash-retention.ts`) runs once shortly after startup readiness and daily thereafter, and reuses the same permanent-delete core as the manual action, so both paths share one policy. It selects only the roots of trashed branches (permanent delete already removes descendants), caps each run, isolates per-resource failures so one bad row cannot stop the sweep, and deliberately skips locked resources rather than unlocking them. Audit rows are written with `userId = null` and `metadata.reason = 'RETENTION'` to distinguish system sweeps from user actions. Setting the value to `0` disables automatic purging entirely.
