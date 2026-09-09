# RESTORE

หลัง restore semantic tables อาจว่างโดยตั้งใจ ให้เปิดระบบด้วย lexical search ก่อน ตรวจ model health แล้วใช้
`npm run semantic:reindex` และ worker rebuild จาก current `ResourceSearchIndex` ห้ามถือ vectors เป็นหลักฐานต้นฉบับ

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

---

## F15 - หลังกู้คืน ข้อมูลที่คนสร้าง

ตรวจสี่อย่างหลังการกู้คืน

```sql
-- 1. ชุดค้นหาที่บันทึกไว้
SELECT COUNT(*) FROM saved_searches;

-- 2. ประเภทเอกสาร
SELECT COUNT(*) FROM document_categories;

-- 3. เอกสารที่ถูกจัดประเภทไว้
SELECT COUNT(*) FROM resources WHERE documentCategoryId IS NOT NULL;

-- 4. สถานะการตรวจ OCR
SELECT reviewStatus, COUNT(*) FROM resource_search_index GROUP BY reviewStatus;
```

ข้อสี่ต้องมีทั้ง `VERIFIED` และ `CORRECTED` ถ้ามีการตรวจไปแล้วก่อนสำรอง

**อย่าคิดว่า "เดี๋ยวให้คนตรวจใหม่ก็ได้"** - การตรวจเอกสารหลายร้อยฉบับใหม่ทั้งหมด
คือการทำงานเดิมซ้ำที่ไม่มีใครยอมทำ และผลคือคิวที่ไม่มีวันว่าง

### จุดที่ต้องระวังเป็นพิเศษ

เอกสารที่ `reviewStatus = VERIFIED` ต้องกลับมาโดยที่ `textSource` ยังเป็น `OCR`
ถ้ากลับมาเป็น `HUMAN_CORRECTED` แปลว่าชุดสำรองหรือกระบวนการกู้คืนทำข้อมูลเพี้ยน

### การซ้อมกู้คืนที่บังคับ

`src/modules/backup/f15-restore.test.ts` สร้างชุดสำรองจริง กู้ดัมป์ลงฐานข้อมูลพัก
แล้วอ่านค่ากลับมาเทียบทีละรายการ รวมทั้งเทียบชื่อภาษาไทยผ่าน `HEX()` ทีละไบต์

ชุดทดสอบนี้ **ไม่ข้ามตัวเองเมื่อสำรองไม่ผ่าน**

---

## F16 - หลังกู้คืน สถานะการกำกับดูแล

```sql
-- 1. นโยบายการเก็บรักษา
SELECT COUNT(*) FROM retention_policies;

-- 2. เอกสารที่ถูกคุ้มครองอยู่
SELECT COUNT(*) FROM resources WHERE retentionUntil IS NOT NULL OR retentionForever = 1;

-- 3. เอกสารในคลัง
SELECT COUNT(*) FROM resources WHERE lifecycleState = 'ARCHIVED';

-- 4. การระงับการลบ (ต้องมีทั้งที่ยังมีผลและที่ปลดแล้ว)
SELECT isActive, COUNT(*) FROM legal_holds GROUP BY isActive;
```

### จุดที่ต้องระวัง

เอกสารที่เคยถูกระงับการลบ ต้องกลับมาโดยที่ `isActive = 1` ยังเป็น 1
ถ้ากลับมาเป็น 0 แปลว่าเอกสารสูญเสียการคุ้มครองเงียบ ๆ และอาจถูกลบในรอบเก็บกวาดถัดไป

`retentionForever = 1` ต้องกลับมาพร้อม `retentionUntil = NULL` ทั้งคู่
ถ้ามีค่าใดค่าหนึ่งเพี้ยน การตีความจะกลายเป็น "ไม่มีนโยบาย" ซึ่งตรงข้ามกับความจริง

### การซ้อมกู้คืนไม่แตะระบบจริง

ทุกอย่างเกิดในฐานข้อมูลพัก งานเก็บกวาดถังขยะไม่เคยทำงานกับสถานะที่กู้มา
ชุดทดสอบยืนยันด้วยว่าเอกสารในระบบจริงยังอยู่ครบหลังการซ้อม

## บันทึกการตรวจสอบหลังกู้คืน (F17)

การซ้อมตรวจว่า:

- **จำนวนเหตุการณ์ไม่ลดลง** จากตอนสำรอง
- เหตุการณ์ตัวอย่างกลับมาครบทุกฟิลด์: `action`, `userId`, `resourceId`, `ipAddress`, `userAgent`
- `metadata` ภาษาไทยกลับมาครบทุกตัวอักษร (ตรวจผ่าน HEX เพื่อไม่ให้การแปลงอักขระของ client บังปัญหา)
- บันทึกในระบบจริงยังอยู่ครบหลังการซ้อม

จำนวนเหตุการณ์ที่ลดลงแม้แถวเดียวคือสัญญาณว่าการกู้คืนไม่สมบูรณ์ และต้องหยุดตรวจก่อนใช้งานจริง

ดู `src/modules/backup/f17-restore.test.ts` และ [COMPLIANCE_AUDIT.md](COMPLIANCE_AUDIT.md)

## ลิงก์แชร์ภายนอกหลังกู้คืน (F18)

**คำถามสำคัญ: หลังกู้คืนระบบ ลิงก์เก่ายังใช้ได้ไหม**

**ใช้ได้** เพราะ `tokenHash` ถูกกู้คืนมาด้วย และนั่นเป็นพฤติกรรมที่ตั้งใจ
ลูกค้าที่ถือลิงก์อยู่ไม่ได้ทำอะไรผิด การกู้คืนระบบของเราไม่ควรทำให้เขาต้องโทรมาถาม
ว่าทำไมเอกสารเปิดไม่ได้

**ผลที่ต้องรู้ตัว**: ถ้ากู้คืนไปยังจุดก่อนที่จะมีคนกดยกเลิกลิงก์ ลิงก์นั้นจะกลับมาใช้ได้อีก
การกู้คืนจึงต้องตามด้วยการทบทวนรายการที่ `/admin/public-shares` ทันที
นี่เป็นขั้นตอนของมนุษย์ ไม่ใช่สิ่งที่ระบบเดาแทนได้

การซ้อมตรวจว่า:

- จำนวนลิงก์ไม่ลดลง
- `tokenHash` ของลิงก์ที่ใช้งานอยู่กลับมาตรงทุกไบต์
- สิทธิ์ เพดาน และตัวนับกลับมาครบ (โควตาที่ใช้ไปแล้วต้องไม่ถูกคืน)
- `passwordHash` กลับมาเป็นแฮช bcrypt ที่ใช้ได้จริง
- ลิงก์ที่ยกเลิกแล้วยังถูกยกเลิก และรู้ว่าใครยกเลิก
- ลิงก์ที่หมดอายุแล้วยังหมดอายุ
- ทุกแถวเก็บแฮชยาว 64 อักขระ ไม่ใช่โทเคนดิบยาว 43
- ชื่อกำกับภาษาไทยกลับมาครบทุกตัวอักษร

ดู `src/modules/backup/f18-restore.test.ts`
