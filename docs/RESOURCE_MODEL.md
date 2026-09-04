# RESOURCE MODEL

## External resources (F2)

`GOOGLE_SHEET`, `GOOGLE_DOC`, `GOOGLE_DRIVE`, and `WEB_LINK` use the same `Resource` hierarchy as files and folders. Their URL is stored in `externalUrl`, while `externalProvider` is normalized by the server. They have no physical file or size and keep the same S2 NAS identity through URL edits, moves, trash, and restore. See [EXTERNAL_RESOURCES.md](./EXTERNAL_RESOURCES.md).

`Resource.id` is the stable logical identity for folders and files. Rename, move, owner transfer, new versions, trash, and restore do not change it. `parentId = null` is the organization root; the hierarchy is database metadata and is independent of physical storage.

Active sibling names are unique through `siblingKey`. Names are trimmed, whitespace-collapsed, NFC normalized, and reject `.`, `..`, path separators, control/format characters, and Windows reserved device names. Thai and other Unicode names are supported.

Files have current metadata on `Resource` and immutable history in `ResourceVersion`. Each version has a separate opaque `storageKey`, byte size, SHA-256 checksum, MIME type, uploader, and version number. Neither `storageKey` nor a physical path is part of any DTO.

## Drive scope

Every resource carries `driveScope` (`MY_DRIVE` | `SYSTEM_DRIVE`). It is assigned by the server: inherited from the parent folder when one exists, otherwise taken from the drive root the request targets, subject to that drive's create policy. Clients cannot override it. Moving a folder propagates the new scope to its whole subtree. See [SYSTEM_DRIVE.md](./SYSTEM_DRIVE.md).

## Organization policy

- The organization owns the namespace and managed files.
- `createdById` is the historical uploader/creator.
- `ownerId` is the person responsible for the resource. An uploaded file inherits the parent folder's owner.
- Transferring a folder owner changes responsibility only. It does not change IDs, version rows, uploader history, storage keys, physical placement, or visibility policy.
- New children inherit the parent visibility: `ORGANIZATION` or `RESTRICTED`.

Trash is a subtree soft-delete: `deletedAt`, `deletedById`, and `trashedFromId` preserve state and original location. Permanent delete removes every descendant version from storage before deleting metadata.

## Workspace metadata (Phase E)

- `remark` (max 1000 chars) is descriptive text on the resource. Its content is never written to the activity log; only "set" vs "cleared" is recorded.
- `isLocked`, `lockedAt`, `lockedById`, `lockReason` freeze a resource against modification. See [RESOURCE_LOCK.md](RESOURCE_LOCK.md).
- `ResourceTag` links a resource to organization-wide `Tag` rows. See [TAGS.md](TAGS.md).
- `UserFavorite` and `UserPinnedResource` are per-user and private. They are not part of the resource DTO; the client loads them once and joins them to whatever is on screen.
- `ResourceAccess` carries `accessLevel` and `allowDownload` per user. See [SHARING.md](SHARING.md).

All modules share one `resourceInclude` definition exported from `resource.service.ts`. Per-module copies previously drifted and produced DTOs that were missing fields.

## ResourceSearchIndex (F12)

ข้อความที่สกัดจากไฟล์เพื่อให้ค้นหาจากเนื้อในเอกสารได้ **หนึ่งแถวต่อหนึ่งเวอร์ชัน**

เป็น **ข้อมูลที่สร้างใหม่ได้** ไม่ใช่ข้อมูลต้นฉบับ - ระบบทำงานได้ครบทุกอย่างแม้ตารางนี้ว่างเปล่า
ไฟล์ยังเปิดและดาวน์โหลดได้ และค้นจากชื่อไฟล์ แท็ก หมายเหตุ ยังได้เหมือนเดิม

การค้นหาปกติเทียบ `versionNumber` กับ `Resource.currentVersion` เสมอ
เนื้อหาของเวอร์ชันเก่ายังอยู่ในตารางเพื่อการตรวจสอบ แต่ไม่มีทางถูกคืนเป็นผลลัพธ์ปัจจุบัน

`ON DELETE CASCADE` จากทั้ง `Resource` และ `ResourceVersion` - การลบถาวรไม่ทิ้งข้อความที่สกัดไว้ค้างอยู่

ข้อความที่สกัดได้มีความลับเท่ากับตัวเอกสารต้นทาง ดู [SEARCH_INDEXING.md](SEARCH_INDEXING.md)
