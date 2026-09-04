# SYSTEM DRIVE

S2 NAS has two logical drive roots. Every `Resource` row carries a denormalized `driveScope` (`MY_DRIVE` | `SYSTEM_DRIVE`) so any single row is enough to decide policy without walking the hierarchy.

| Drive | Label | Route |
| --- | --- | --- |
| `MY_DRIVE` | ไดร์ฟของฉัน | `/files`, `/files/:folderId` |
| `SYSTEM_DRIVE` | ไดร์ฟของระบบ | `/system-drive`, `/system-drive/:folderId` |

## My Drive semantics

"ไดร์ฟของฉัน" is a working and responsibility area, not personal property. `ownerId` names the person responsible; the company still owns the data. Renaming the label from "ไฟล์ของฉัน" was a deliberate correction: users read "files" as a private folder, which is the wrong mental model for a company namespace.

## System Drive semantics

One organization-wide shared drive. It is readable by the whole organization and **not writable by default**.

My Drive uses the rule "visible to the organization (`ORGANIZATION`) implies editable". Carried into the System Drive, that rule would let every employee edit the company handbook and shared forms. `capabilities()` therefore cuts the "visible = editable" path for `SYSTEM_DRIVE` rows.

### Default rights for eligible internal users

`VIEW`, `PREVIEW`, `DOWNLOAD` — granted through `resources:read` (see `canViewSystemDrive`). Future external/customer account types must not receive this automatically.

### Create / upload

`SUPER_ADMIN`, `ADMIN`, or the explicit `system-drive:write` permission (`canCreateInSystemDrive`). Enforced on folder creation, external-resource creation, and file upload, both at the drive root and inside any System Drive folder.

### Denied to normal users

rename, move, delete, trash, share, transfer owner, lock, permanent delete. A broad permission such as `resources:share`, `resources:lock`, or `resources:owner:manage` does **not** unlock these inside the System Drive; only an admin or a direct `OWNER`/`EDITOR` grant on that resource does.

Cross-drive moves are reserved for admins (`assertCanMoveAcrossDrives`) and always write a `RESOURCE_DRIVE_CHANGED` audit row, because moving between drives changes the organization's access boundary rather than merely tidying files. Moving a folder propagates `driveScope` to the whole branch so no descendant is left under the old drive's policy.

## Enforcement

The backend is the only authority: `backend/src/modules/resources/system-drive.ts` plus `capabilities()` in `resource.service.ts`. `frontend/src/lib/system-drive.ts` mirrors the same rules solely to avoid showing buttons that would be rejected; if the two ever disagree, the backend is correct.

## Naming

Root-level rows in both drives share `parentId = null`, so `siblingKey` binds the drive into the key for roots (`<driveScope>:ROOT:<normalizedName>`). A folder named "คู่มือบริษัท" can therefore exist at the root of both drives without colliding on the unique constraint.

## Creating resources (F8)

The System Drive supports the same seven creation actions as My Drive, through the **same components and services** — there is no second creation system:

สร้างโฟลเดอร์ · อัปโหลดไฟล์ · อัปโหลดโฟลเดอร์ · เพิ่ม Google Sheet · เพิ่ม Google Doc · เพิ่ม Google Drive · เพิ่มลิงก์

`+ ใหม่` opens the shared `NewMenu` and never jumps straight to folder creation; a folder is created only after choosing สร้างโฟลเดอร์. The same actions appear on empty-space right-click, filtered by capability. A separate อัปโหลด button remains as a shortcut to file upload.

Physical files always go through อัปโหลดไฟล์ — there are deliberately no per-type buttons (image, PDF, Word…). The existing MIME pipeline decides what the stored resource turns out to be.

### Drive-scope inheritance

The backend, not the client, decides where a resource lands:

- **With a parent** — the resource inherits the parent's `driveScope`. A client sending `MY_DRIVE` while creating inside a System Drive folder still gets `SYSTEM_DRIVE`. Tested for folders, external resources, and uploads.
- **At a drive root** — the route context supplies the scope, and creating at the System Drive root additionally requires `canCreateInSystemDrive`.

So a client cannot spoof `driveScope` to escape policy in either direction.

### Folder upload

`อัปโหลดโฟลเดอร์` uses the browser's directory picker and preserves the local hierarchy:

```
Company Assets/Logos/logo.png   →   ไดร์ฟของระบบ / Company Assets / Logos / logo.png
```

Every path segment is validated with the same rules as `validateResourceName` (no traversal, no absolute paths, no control characters, no Windows reserved names, ≤191 chars, Thai and Unicode fully supported). An unsafe segment rejects that file and reports why — names are never silently "repaired", because a quietly renamed file lands somewhere the user did not intend.

Folders are created parent-first, existing folders are reused rather than duplicated, and the files themselves go through the unchanged Phase D upload queue — progress, checksums, duplicate detection, name-conflict and version decisions all behave exactly as for a normal upload.

## Destination display

The "ปลายทาง" column shows a logical S2 NAS path only, e.g. `ไดร์ฟของระบบ / คู่มือบริษัท`. Physical paths and `storageKey` are never exposed in any DTO or UI surface.

## External accounts (F10)

`canViewSystemDrive()` refuses `EXTERNAL` accounts regardless of the roles they hold. A client never sees the drive itself or anything at its root.

A System Drive folder can still be shared with a client under the existing sharing policy, which limits that decision to administrators and the folder's own responsible owner. The client then reaches that subtree — and only that subtree — through /portal, with the breadcrumb trimmed to start at the shared folder. Granting อัปโหลดได้ on such a folder does let the client upload into it; that is treated as a decision already made at the moment of sharing, by someone the policy allows to make it. See [CLIENT_PORTAL.md](CLIENT_PORTAL.md).
