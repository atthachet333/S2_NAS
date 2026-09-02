# RESOURCE MODEL

`Resource.id` is the stable logical identity for folders and files. Rename, move, owner transfer, new versions, trash, and restore do not change it. `parentId = null` is the organization root; the hierarchy is database metadata and is independent of physical storage.

Active sibling names are unique through `siblingKey`. Names are trimmed, whitespace-collapsed, NFC normalized, and reject `.`, `..`, path separators, control/format characters, and Windows reserved device names. Thai and other Unicode names are supported.

Files have current metadata on `Resource` and immutable history in `ResourceVersion`. Each version has a separate opaque `storageKey`, byte size, SHA-256 checksum, MIME type, uploader, and version number. Neither `storageKey` nor a physical path is part of any DTO.

## Organization policy

- The organization owns the namespace and managed files.
- `createdById` is the historical uploader/creator.
- `ownerId` is the person responsible for the resource. An uploaded file inherits the parent folder's owner.
- Transferring a folder owner changes responsibility only. It does not change IDs, version rows, uploader history, storage keys, physical placement, or visibility policy.
- New children inherit the parent visibility: `ORGANIZATION` or `RESTRICTED`.

Trash is a subtree soft-delete: `deletedAt`, `deletedById`, and `trashedFromId` preserve state and original location. Permanent delete removes every descendant version from storage before deleting metadata.
