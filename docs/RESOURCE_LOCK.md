# RESOURCE LOCK

Locking freezes a resource against modification while leaving it fully readable. It exists for documents that must not change after the fact — a closed accounting period, a filing already sent to an external authority.

## Effect

While `isLocked` is true:

- blocked: rename, move, remark and tag edits, new versions, trash, permanent delete
- unaffected: view, preview, download, ZIP, activity, favorites, pins

`capabilities()` reports `canEdit`, `canRename`, `canMove`, `canDelete`, and `canUploadVersion` as `false`, so the UI hides the actions rather than offering them and failing.

## Distinct error, not "no permission"

Mutation paths call `assertNotLocked()` **before** the permission check and throw `RESOURCE_LOCKED` (HTTP 423) carrying `lockReason`.

This ordering matters. The owner of a locked file has full rights; if the lock fell through to a generic "you don't have permission", they would be told something false about their own authority and have no way to discover the real cause.

## Who may lock

`canLock` is granted to admins, the primary owner, and holders of `resources:lock`. It uses the same bar as access administration but a separate permission, so the two can be delegated independently.

## Stored state

`isLocked`, `lockedAt`, `lockedById`, and `lockReason` (max 500 chars) live on `Resource`; `lockedBy` and the reason are exposed in the resource DTO so the UI can explain why editing is blocked and who to ask.

Locking an already-locked resource returns `RESOURCE_ALREADY_LOCKED`; unlocking an unlocked one returns `RESOURCE_NOT_LOCKED`.

## Endpoints

| Method | Path |
| --- | --- |
| `POST` | `/api/resources/:id/lock` (optional `reason`) |
| `DELETE` | `/api/resources/:id/lock` |

Both emit activity (`RESOURCE_LOCKED` / `RESOURCE_UNLOCKED`). The lock event records only whether a reason was given — the reason itself lives on the resource, where it is visible in context.
