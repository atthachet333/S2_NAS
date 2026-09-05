# RESTORE

Restore is far more dangerous than backup: it overwrites data that is still in use. F5 therefore stops at **"staged and proven"**. There is no one-click production cutover, and nothing in the UI or API writes to the live system.

## Staged restore

Every step happens in a temporary database and a temporary directory:

| | Location |
| --- | --- |
| Database | `S2_NAS_RESTORE_DB_PREFIX` + backup id (default `test_s2nas_restore_<id>`) |
| Files | `S2_NAS_RESTORE_STAGE_ROOT/stage-<id>` |

The live database and live storage are not written at any point.

### Why the `test_` prefix

The application's database account holds `ALL PRIVILEGES` on `s2_nas` only. It cannot create arbitrary databases, but MariaDB grants `CREATE`/`DROP` on the `test_%` namespace to `PUBLIC` by default, so staging databases live there. Change `S2_NAS_RESTORE_DB_PREFIX` if your deployment grants the account a different namespace.

## Two hard safety rules

The dump is generated **without** `--databases`. That flag embeds `CREATE DATABASE s2_nas` and `USE s2_nas` in the file, and an import of such a dump ignores the database named on the command line and writes to the embedded one — silently overwriting production while appearing to target staging. This is enforced twice:

1. `assertDumpHasNoDatabaseSwitch` rejects any dump containing `USE` or `CREATE DATABASE`, both when written and again before import.
2. `importDump` refuses outright when the target database equals the live database (`RESTORE_TARGET_IS_LIVE`).

## 1. Precheck

Changes nothing, anywhere. Fails closed if any of these do not hold:

- backup exists and is `COMPLETED`
- manifest parses and is a supported version
- manifest checksum matches the value recorded at creation
- dump checksum matches
- every storage object is present and matches its checksum
- no unsafe path (`..`, absolute, drive-qualified) appears in the manifest
- enough free disk for staging (skipped, not faked, on filesystems that do not report it)

## 2. Stage

Creates the staging database, imports the dump, copies every object into the staging directory, and re-verifies size and SHA-256 for each one.

## 3. Reconcile

Checks the restored database against the restored files in **both** directions:

- every `resource_versions` row has a file of the right size and checksum
- every staged file is referenced by a row

`missing`, size mismatch, and checksum mismatch fail. **Orphans do not** — they are the expected, harmless result of the backup ordering described in [BACKUP.md](./BACKUP.md).

## Manual production cutover

Not automated, and deliberately so: an automatic cutover without a proven rollback path can turn a recoverable incident into an unrecoverable one.

Before starting, confirm the restore has been staged and reconciled clean.

1. **Announce downtime** and stop the S2 NAS backend. Do not attempt a live cutover.
2. **Create a rollback point** — take a fresh backup of the current state *and verify it*. This is the state you return to if the cutover goes wrong. Skipping this step is the single most common way a restore becomes a disaster.
3. **Snapshot current storage** by moving (not deleting) `S2_NAS_STORAGE_ROOT` aside, e.g. to `storage.pre-restore`.
4. **Restore the database** into the live database from the staged database, or import the dump directly into it. This is the irreversible step.
5. **Restore the files** by copying the staged directory into `S2_NAS_STORAGE_ROOT`.
6. **Verify before reopening**: `npx prisma migrate status` reports up to date, drift shows no difference, the app starts, and a spot check of resources, versions, trash, and both drives looks right.
7. **Reopen access.** Keep the rollback backup and `storage.pre-restore` until you are confident.

### Rollback

If step 6 fails: stop the backend, restore the step-2 backup, move `storage.pre-restore` back, and reopen. This works only if step 2 was actually done.

## What restore does not bring back

The restore environment must already have working application code, a valid `.env` with the correct secrets, a MariaDB server, a storage root, and a backup root. Backups contain **no** secrets or deployment configuration — see [BACKUP.md](./BACKUP.md).

A restored database contains integration credential **hashes** exactly as of backup time. Revoked stays revoked, active stays active. No plaintext secret is recoverable, because none is stored.

## Automated rehearsal

A weekly staged restore proves the newest backup is still restorable without any cutover. See [RESTORE_REHEARSAL.md](./RESTORE_REHEARSAL.md).

## Cleaning up

`npm run backup:discard-stage -- <backupId>` drops the staging database and removes the staging directory. Staging areas are working space, not something to keep.

## F12 - หลังกู้คืน ดัชนีข้อความ

หลังกู้คืน ระบบใช้งานได้ทันทีโดยไม่ต้องรอการทำดัชนี

ถ้าแถวดัชนีหายหรือไม่ครบ:

- ไฟล์ทุกไฟล์ยังเปิดและดาวน์โหลดได้ตามปกติ
- ค้นจากชื่อไฟล์ แท็ก และหมายเหตุยังได้เหมือนเดิม
- **ค้นจากเนื้อในเอกสารเท่านั้นที่ยังใช้ไม่ได้** จนกว่าจะทำดัชนีใหม่

รอบกู้คืนตอนเริ่มระบบจะสร้างแถวที่ขาดหายให้เองครั้งละไม่เกิน 500 แถว
หรือผู้ดูแลสั่ง `POST /api/admin/search-index/reindex-all` เพื่อเข้าคิวทั้งระบบก็ได้

การทำดัชนีใหม่ไม่แตะไฟล์จริงเลย - อ่านอย่างเดียว

## F13 - หลังกู้คืน ข้อความจาก OCR

ถ้าแถวดัชนีของ OCR หายไป ไฟล์ต้นฉบับยังอยู่ครบและใช้งานได้ทุกอย่าง
เพียงแต่ค้นจากเนื้อในเอกสารสแกนไม่ได้จนกว่าจะสั่ง OCR ใหม่

การสั่ง OCR ใหม่**ไม่แตะไฟล์ต้นฉบับเลย** - อ่านอย่างเดียว และผลลัพธ์เขียนลงดัชนีเท่านั้น

ผู้ดูแลสั่งได้จาก `npm run ocr:eligible` แล้ว `npm run ocr:run -- <resourceId>`
หรือจากหน้าผู้ดูแลผ่าน `POST /api/admin/ocr/bulk`

---

## F14 - หลังกู้คืน ข้อความที่คนตรวจแก้

ต่างจากดัชนีข้อความและผลของ OCR ที่สร้างใหม่ได้ - **ข้อความที่คนตรวจแก้ต้องกลับมาครบ**

หลังการกู้คืน ให้ตรวจสามอย่าง

```sql
-- 1. จำนวนเอกสารที่ถูกตรวจแก้
SELECT COUNT(*) FROM resource_search_index WHERE textSource = 'HUMAN_CORRECTED';

-- 2. ประวัติการแก้ยังอยู่ครบ
SELECT COUNT(*) FROM resource_text_corrections;

-- 3. ไม่มีแถวที่บอกว่าแก้แล้วแต่ไม่มีข้อความ
SELECT COUNT(*) FROM resource_search_index
WHERE textSource = 'HUMAN_CORRECTED' AND (extractedText IS NULL OR extractedText = '');
```

ข้อสามต้องได้ `0` เสมอ ถ้าไม่ใช่ แปลว่าชุดสำรองไม่สมบูรณ์ - **อย่าตัดสินใจว่า
"เดี๋ยวสั่ง OCR ใหม่ก็ได้"** เพราะ OCR จะให้ผลดิบกลับมา ไม่ใช่ฉบับที่คนแก้ไว้

### การซ้อมกู้คืนที่บังคับ

`src/modules/backup/correction-restore.test.ts` สร้างชุดสำรองจริง กู้ดัมป์ลง
ฐานข้อมูลพัก แล้วเทียบข้อความภาษาไทยทีละไบต์ผ่าน `HEX()` - ไม่ใช่แค่เทียบความยาว
เพราะข้อความไทยที่ encoding เพี้ยนจะยาวเท่าเดิมแต่อ่านไม่ออก

ชุดทดสอบนี้ **ไม่ข้ามตัวเองเมื่อสำรองไม่ผ่าน** ถ้าสำรองไม่ได้ ข้อความที่คนแก้
ก็ไม่ได้รับการปกป้อง ซึ่งเป็นความล้มเหลวของสิ่งที่ต้องพิสูจน์พอดี
