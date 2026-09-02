# PHASE D FILE OPERATIONS

Phase D delivers upload, duplicate decisions, immutable versions, authenticated preview/download, recent resources, recursive trash/restore/permanent delete, folder and multi-select ZIP, secure image thumbnails, and distinct managed-storage/disk metrics.

## Download semantics

- A single file uses `GET /api/resources/:id/download` and keeps its original filename. The UI labels this action `ดาวน์โหลดไฟล์ต้นฉบับ`.
- A historical version uses the same endpoint with `?version=N`. The UI labels this action `ดาวน์โหลดเวอร์ชันนี้` so it cannot be confused with the current file.
- A single folder or any selection of two or more resources uses ZIP download. ZIP is never used for a one-file selection.

## ZIP

- `GET /api/resources/:id/download-zip`: one folder, `{folder name}.zip`.
- `POST /api/resources/download-zip` with `{ "resourceIds": [] }`: files/folders/mixed, `S2-NAS-Download-YYYY-MM-DD.zip`.
- Nested selected roots are de-duplicated; archive entries are unique and relative.
- Policy A fails the whole request if any active included resource is unauthorized.
- Deleted rows are excluded by active-tree queries.
- `S2_NAS_ZIP_MAX_RESOURCES` and `S2_NAS_ZIP_MAX_BYTES` are checked from aggregate metadata before streaming. Exceeding either returns `ZIP_TOO_LARGE`.
- `RESOURCE_ZIP_DOWNLOADED` records root IDs, count, user, and total bytes without logging filenames.

## Preview and thumbnails

PDF, safe raster images, and safe text types use authenticated inline content with `nosniff` and no-store caching. Unsupported Office/archive types retain the details/download fallback. JPEG/PNG/WEBP/GIF grid thumbnails use authenticated blob URLs, lazy loading, object-fit, and a 10 MiB client threshold. SVG/HTML remain icons/downloads.

## Configuration

| Variable | Purpose |
| --- | --- |
| `S2_NAS_STORAGE_ROOT` | Private physical storage root |
| `S2_NAS_MAX_UPLOAD_BYTES` | Upload stream limit in bytes |
| `S2_NAS_ZIP_MAX_RESOURCES` | Maximum planned ZIP entries |
| `S2_NAS_ZIP_MAX_BYTES` | Maximum aggregate uncompressed file bytes |
| `S2_NAS_TRASH_RETENTION_DAYS` | Documented retention target; no Phase D scheduler |

Do not publish actual environment values or secrets. `MAX_UPLOAD_SIZE_MB` remains a backward-compatible fallback.

## Security summary

All endpoints authenticate and authorize server-side. Storage is not static. Physical paths and storage keys never enter DTOs or archive names. Content-Disposition includes an ASCII fallback plus RFC 5987 UTF-8 encoding. Streams are bounded by metadata limits; ZIP paths derive only from validated resource names. Deleted-resource and version authorization uses the active resource as authority.

The scanner remains `NOT_CONFIGURED`; see `UPLOAD_SECURITY.md`. Phase D adds no schema migration and does not start Phase E.
