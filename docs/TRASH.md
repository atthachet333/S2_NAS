# TRASH

`POST /api/resources/:id/trash` soft-deletes the selected resource and its active descendants. Physical version files remain in place. Normal listings, recent, preview, download, and ZIP exclude trashed rows.

Restore uses `POST /api/resources/:id/restore`:

- Normal: restore to `trashedFromId`.
- Name conflict: server returns `TRASH_RESTORE_CONFLICT` with `reason: NAME_CONFLICT`; UI requires a valid new name.
- Original parent missing/deleted: server returns `reason: PARENT_MISSING`; UI requires an explicit `FolderPicker` destination. Root is allowed only when deliberately selected.

Permanent deletion first previews exact resource/file/version counts, then deletes every descendant physical version and metadata. It is irreversible. `S2_NAS_TRASH_RETENTION_DAYS` documents the future retention-job policy; Phase D has no automatic purge job.
