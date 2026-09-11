# RESOURCE MODEL

## Semantic derived index (F20)

`Resource`/`ResourceVersion` เป็น business truth เช่นเดิม `SemanticDocumentIndex` และ `SemanticChunk` เป็น cache
ที่ลบ/rebuild ได้ ผูก version และ cascade เมื่อ resource ถูกลบ ดู [SEMANTIC_INDEXING.md](./SEMANTIC_INDEXING.md)

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

## F13 - ข้อมูลประกอบของ OCR

`ResourceSearchIndex` ถูกขยายแทนการสร้างตารางใหม่ - OCR ผลิต "ข้อความที่ค้นหาได้"
เหมือนกับการสกัดปกติ จึงควรอยู่ที่เดียวกัน

`textSource` (`NATIVE_TEXT` | `OCR`) บันทึกที่มาของข้อความ ซึ่งจำเป็นเพราะข้อความจาก OCR
เป็นการคาดเดา และผู้ใช้ควรรู้ว่ากำลังเชื่ออะไรอยู่

`jobKind` (`EXTRACT` | `OCR`) แยกชนิดงานในคิวเดียวกัน

ยังคง **หนึ่งแถวต่อหนึ่งเวอร์ชัน** และยังเป็น **ข้อมูลที่สร้างใหม่ได้**
ดู [OCR.md](OCR.md)

---

## F15 - ประเภทเอกสารและสถานะการตรวจ

`Resource.documentCategoryId` เป็น nullable และอ้างไปยัง `DocumentCategory`
`null` แปลว่า **ยังไม่ได้จัดประเภท** ไม่ใช่ "ไม่มีประเภท"

`onDelete: SetNull` - ประเภทที่ถูกลบไม่ทำให้เอกสารหาย แต่ระบบไม่อนุญาตให้ลบประเภท
ที่ยังมีเอกสารใช้อยู่ตั้งแต่ชั้นบริการอยู่แล้ว

`ResourceSearchIndex` เพิ่มสามฟิลด์ของการตรวจ: `reviewStatus` `reviewedById`
`reviewedAt` ซึ่งแยกจาก `correctedById`/`correctedAt` ของ F14 เพราะ
"ตรวจแล้วถูก" กับ "ตรวจแล้วแก้" เป็นคนละเหตุการณ์กัน

`SavedSearch` เป็นตารางใหม่ที่ผูกกับผู้ใช้แบบ `onDelete: Cascade`
ชุดค้นหาเป็นของส่วนตัว ไม่มีความหมายเมื่อเจ้าของถูกลบ

ดู [DOCUMENT_CLASSIFICATION.md](DOCUMENT_CLASSIFICATION.md)

---

## F16 - วงจรชีวิตและการคุ้มครอง

`Resource` เพิ่มฟิลด์สองกลุ่มที่ **แยกจาก `deletedAt` โดยสิ้นเชิง**

```
lifecycleState (ACTIVE | ARCHIVED) · archivedAt · archivedById
retentionPolicyId · retentionStartAt · retentionStartBasis
retentionUntil · retentionForever
```

`retentionUntil` เป็น **ภาพนิ่ง** ที่คำนวณตอนกำหนดนโยบาย ไม่คำนวณใหม่จากนโยบาย
ทุกครั้งที่อ่าน - การแก้นิยามนโยบายจึงไม่เปลี่ยนวันหมดอายุของเอกสารที่กำหนดไว้แล้ว

`retentionForever` แยก "เก็บถาวร" ออกจาก "ไม่มีนโยบาย" ซึ่งทั้งคู่มี
`retentionUntil = null` เหมือนกันแต่ความหมายตรงข้าม

`LegalHold` เป็นตารางแยก หนึ่งแถวต่อการวางหนึ่งครั้ง ไม่ใช่ธงบนทรัพยากร
`onDelete: Cascade` จาก `Resource` - ประวัติหายพร้อมเอกสารเท่านั้น

`DocumentCategory.defaultRetentionPolicyId` ใช้เป็นค่าตั้งต้นเมื่อจัดประเภท
เฉพาะกับเอกสารที่ยังไม่มีนโยบายของตัวเอง

ดู [DOCUMENT_LIFECYCLE.md](DOCUMENT_LIFECYCLE.md)

## PublicShareLink (F18)

ลิงก์แชร์ภายนอกเป็นตารางของตัวเอง **ไม่ได้ใช้ `ResourceAccess` ร่วม**

`ResourceAccess` บังคับให้มี `userId` และมีคีย์เอกลักษณ์ `(resourceId, userId)`
ซึ่งแปลว่ามันคือ "การมอบสิทธิ์ให้คนที่ระบบรู้จัก" โดยนิยาม
การยัดลิงก์แขกลงไปจะบังคับให้ต้องสร้าง User ปลอมสำหรับแขกทุกคน
แล้วเส้นแบ่งระหว่างพื้นที่ลูกค้ากับลิงก์แขกจะพังทันที

```
PublicShareLink
  resourceId  → Resource (Cascade)
  createdById → User (Restrict)
  revokedById → User (SetNull)
  tokenHash UNIQUE
```

`Cascade` บน `resourceId` ทำให้การลบทรัพยากรถาวรไม่ทิ้งสิทธิ์ที่ไร้เจ้าของไว้
`Restrict` บน `createdById` ใช้เกณฑ์เดียวกับ `ResourceAccess` - ผู้ใช้ในระบบนี้ถูกปิดใช้งาน ไม่ถูกลบ

ดัชนี: `tokenHash` (UNIQUE ใช้ค้นทุกคำขอของแขก) · `resourceId` · `createdById` ·
`expiresAt` และ `revokedAt` (ใช้โดยตัวกรองสถานะของหน้าผู้ดูแล)

ดู [PUBLIC_SHARE_LINKS.md](PUBLIC_SHARE_LINKS.md)
# Assistant records

`AssistantThread` เป็นของผู้ใช้หนึ่งคนและเก็บ scope; selected scope เชื่อม Resource ผ่าน `AssistantThreadResource` ข้อความเก็บเฉพาะ USER/ASSISTANT ที่มองเห็น และ `AssistantCitation` เก็บ stable resource/version reference กับ snippet จำกัด ไม่เก็บ retrieved context หรือ prompt
