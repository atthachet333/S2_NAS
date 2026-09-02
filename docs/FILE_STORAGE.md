# FILE STORAGE

The database stores logical metadata; the storage provider stores opaque version bytes below `S2_NAS_STORAGE_ROOT`. The user-visible folder tree never maps to physical directories. Rename, move, restore, and ownership transfer therefore cause no physical relocation.

```text
storage/
├── resources/{resourceId}/{opaque-version-key}
└── temp/upload-{uuid}
```

Upload is streamed to `temp`, bounded by `S2_NAS_MAX_UPLOAD_BYTES` (or legacy `MAX_UPLOAD_SIZE_MB`), and hashed with SHA-256 during the same pass. The server detects MIME from a safe signature/extension policy, resolves duplicate decisions, commits a new opaque file, then writes `Resource`, `ResourceVersion`, and activity metadata transactionally. Failures discard staged bytes.

Content and downloads use authenticated API streams. Storage is never served statically. `resolveStorageKey` and `resolveInsideStorage` contain all reads/writes within the configured root. DTOs and system status responses expose no storage key or physical path.

ZIP output is streamed with Archiver; it is not accumulated in RAM. The planner authorizes every active root and descendant, builds archive names only from validated resource names, checks metadata totals against centralized limits, and verifies each stored file exists with the expected size before adding it.

Managed file bytes are the sum of active `Resource` file metadata. Disk usage is the operating-system volume total/used/free metric. They are deliberately distinct; the dashboard storage donut represents disk usage.
