# PERMISSIONS

The backend enforces every protected operation; hidden or disabled UI controls are not authorization.

`ORGANIZATION` resources are visible to active authenticated users with `resources:read`. `RESTRICTED` resources require admin status, primary ownership, or direct access. Mutations additionally require the corresponding role permission and owner/editor/admin authority. Downloads require `canDownload`; direct grants can separately control `allowDownload`.

ZIP uses fail-whole policy A. Every selected root and every active descendant is independently re-authorized. A folder needs `canView`; a file needs `canDownload`. Any failure returns `RESOURCE_ACCESS_DENIED`, and no partial archive is sent. Trashed/deleted resources are excluded and cannot be previewed, downloaded, version-downloaded, or included in ZIP.

Restore requires delete/restore authority on the trashed item and edit authority on an explicitly selected destination. Name conflicts require a valid new name. A missing original parent never silently falls back to root.

Permanent delete requires the item already be in trash and delete authority. All descendant versions are handled server-side.

## Phase E capabilities

`canShare` and `canLock` are granted to admins, the primary owner, and holders of `resources:share` / `resources:lock` respectively. A delegated `EDITOR` gains neither: editing content is not the same authority as deciding who may see it or freezing it.

An explicit `ResourceAccess.allowDownload` always outranks the `ORGANIZATION` default, so a per-person download restriction holds even on an organization-visible folder.

Locked resources reject mutations with `RESOURCE_LOCKED` (423) **before** the permission check, so an owner is told the real reason rather than being told they lack rights they actually hold.

Search, facets, and activity all scope to what the caller can see, including their counts. Resources a user cannot view answer `RESOURCE_NOT_FOUND`, never `403`.

`ipAddress` and `userAgent` in activity entries are returned to admins only.

New permission codes: `resources:share`, `resources:lock`, `resources:tag:create`.

## Account administration (Phase F1)

Reading users requires `users:read`; every mutation requires `users:manage`. Role changes accept only role codes present in the database.

Two guards cannot be bypassed by any permission, because they protect the system from reaching an unrecoverable state:

- at least one `ACTIVE` `SUPER_ADMIN` must remain (`LAST_SUPER_ADMIN`)
- an admin cannot disable their own account (`CANNOT_DISABLE_SELF`)

Activation, password reset, role change, and deactivation all increment `tokenVersion` and revoke refresh tokens, so a permission or credential change takes effect on existing sessions immediately instead of at the next token expiry.
