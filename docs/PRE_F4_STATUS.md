# PRE-F4 STATUS

**CODE COMPLETE / AUTOMATED VERIFIED — authenticated browser QA outstanding.**

Date of record: 2026-09-03.

## Automated verification (passing)

| Gate | Result |
| --- | --- |
| Backend tests | 227 passed |
| Frontend tests | 113 passed |
| Total | 340 passed, 0 failed |
| `npm run typecheck` | clean |
| `npm run build` | clean (pre-existing >500 kB chunk warning only) |
| `npx prisma migrate status` | 7 migrations, up to date |
| Drift (live datasource → datamodel) | no difference detected |
| MariaDB | CONNECTED |
| Storage | READY |

No schema change and no new migration were required for any Pre-F4 work.

## Delivered in Pre-F4

- **My Drive rename** — ไฟล์ของฉัน → ไดร์ฟของฉัน, resolved through `lib/drive-labels.ts`. The competing root name "รากองค์กร" was also removed from FolderPicker, DetailsDrawer, and the trash listing, so exactly one name for a drive root exists.
- **System Drive** — `/system-drive` and `/system-drive/:folderId` reuse `FilesPage` via a `driveRoot` prop rather than a duplicated page. `driveScope` is wired through list, folder create, external create, move, and upload.
- **System Drive enforcement** — `capabilities()` cuts the "organization-visible ⇒ editable" path for `SYSTEM_DRIVE`, and broad permissions (`resources:share`, `resources:lock`, `resources:owner:manage`) no longer unlock share/lock/transfer there. See [SYSTEM_DRIVE.md](./SYSTEM_DRIVE.md).
- **Standard resource table** — ชื่อไฟล์ · ผู้อัปโหลด · ผู้ดูแล · ต้นทาง · ปลายทาง · วันที่อัปโหลด · แก้ไขล่าสุด · ขนาด, with logical destinations only.
- **Select All** — tri-state, scoped to loaded rows only.
- **Trash retention** — per-resource expiry at `deletedAt + S2_NAS_TRASH_RETENTION_DAYS` (default 14), swept by a worker; banner and per-row countdown both driven by the value the server reports. See [TRASH.md](./TRASH.md).
- **Drive-aware FolderPicker** — separate roots per drive, admin-only cross-drive destinations mirroring `CROSS_DRIVE_MOVE_DENIED`, current/destination display, same-location disabled.
- **Upload queue hotfix** — `--z-upload: 55` places the queue below `--z-context: 60` (it previously borrowed `--z-dialog: 80` and covered the context menu); SUCCESS rows auto-dismiss after `UPLOAD_SUCCESS_AUTO_DISMISS_MS` (15 s) from their own `succeededAt`, via a single sweep timer.

## Outstanding: authenticated browser QA

**Status: NOT TESTED. This must not be recorded as PASS.**

### Why

The in-app Browser pane is a separate browser from the developer's Chrome, with its own cookie jar. Signing in to Chrome does not establish a session in the pane, and the pane consistently returns:

```
POST /api/auth/session → {"success":true,"data":{"authenticated":false}}
```

Cookie storage in the pane was verified working (a probe cookie wrote and read back), so this is session isolation, not a browser defect. The Claude in Chrome extension — which would reach the already-authenticated browser — was not connected.

### Not verified

- Context menu rendering above the upload queue in the running app (the z-order is asserted in CSS and by test, but was never observed on screen)
- Context menu viewport clamping against a visible upload queue
- SUCCESS auto-dismiss at ~15 s, and panel auto-close on the last row
- Mixed queue (SUCCESS disappears, FAILED and NEEDS_DECISION remain)
- `/dashboard`, `/files`, `/system-drive`, `/shared`, `/recent`, `/favorites`, `/trash`, `/admin/integrations` and both nested routes under hard reload
- Drive-aware FolderPicker as rendered
- Table columns and semantics against real rows
- Select All tri-state in the running list and grid
- Trash retention banner and per-row countdown against real trashed rows
- Responsive at 1920×1080, 1440×900, 1366×768, 375px
- Light / Dark / System themes
- Auth regression (hard reload, session restore, multi-tab restore)

### Verified without a session

Fresh-tab console on the unauthenticated route: **0 errors, 0 warnings** (`[vite]` connect messages and the React DevTools informational line only).

### How to clear this item

Sign in at `http://localhost:8888` **inside the Browser pane**, confirm `POST /api/auth/session` returns `authenticated: true`, then run the checklist above.

## Known limitations (accepted, not defects)

- ปลายทาง on `/recent`, `/shared`, and `/favorites` shows the drive level only. Those endpoints return no ancestor chain, and a fabricated path would be worse than a shorter true one. A batched ancestor lookup in the DTO would be required to show full paths.
- FolderPicker is locked to a single drive for trash-restore and admin-integrations because neither endpoint accepts a `driveScope`; restore keeps the resource's own drive.
- The README phase table is stale relative to the delivered F-series work.
