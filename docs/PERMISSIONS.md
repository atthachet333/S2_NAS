# PERMISSIONS

The backend enforces every protected operation; hidden or disabled UI controls are not authorization.

`ORGANIZATION` resources are visible to active authenticated users with `resources:read`. `RESTRICTED` resources require admin status, primary ownership, or direct access. Mutations additionally require the corresponding role permission and owner/editor/admin authority. Downloads require `canDownload`; direct grants can separately control `allowDownload`.

ZIP uses fail-whole policy A. Every selected root and every active descendant is independently re-authorized. A folder needs `canView`; a file needs `canDownload`. Any failure returns `RESOURCE_ACCESS_DENIED`, and no partial archive is sent. Trashed/deleted resources are excluded and cannot be previewed, downloaded, version-downloaded, or included in ZIP.

Restore requires delete/restore authority on the trashed item and edit authority on an explicitly selected destination. Name conflicts require a valid new name. A missing original parent never silently falls back to root.

Permanent delete requires the item already be in trash and delete authority. All descendant versions are handled server-side.
