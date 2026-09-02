# FILE VERSIONS

Every file starts at version 1. A same-name upload with `NEW_VERSION` or `POST /api/resources/:id/versions` creates a new immutable `ResourceVersion`, advances `Resource.currentVersion`, and updates current metadata without changing `Resource.id`.

Each version has separate physical bytes, opaque `storageKey`, SHA-256, size, MIME type, remark, uploader, and creation time. `GET /api/resources/:id/content?version=N` previews a permitted version; `GET /api/resources/:id/download?version=N` downloads it. The server authorizes the active parent resource on every request. Trashed/deleted resources cannot expose versions.

Version history records historical uploaders; transferring the responsible owner does not rewrite it. Permanent deletion removes all physical version files before metadata deletion.
