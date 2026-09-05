# DISASTER RECOVERY

What it takes to bring S2 NAS back, and what the backup system does *not* cover.

## Responsibility split

| Asset | Covered by S2 NAS backup | Owner |
| --- | --- | --- |
| MariaDB metadata | Yes | backup system |
| Managed file bytes, all versions | Yes | backup system |
| Trash state, drive scope, tags, sharing, locks | Yes (in the dump) | backup system |
| System settings overrides | Yes | backup system |
| Integration app metadata + credential hashes | Yes | backup system |
| `backend/.env`, JWT/refresh secrets, DB password | **No** | operations |
| Application source and build | **No** | version control / deployment |
| MariaDB server, OS, storage volume | **No** | infrastructure |
| Backup archives themselves | **No** | operations (offsite copy) |

The most common recovery failure is not a corrupt backup — it is a valid backup that cannot be used because the `.env` and its secrets were never backed up. **Back up deployment configuration separately, and store it apart from the data backup.**

If `JWT_ACCESS_SECRET` / `JWT_REFRESH_SECRET` are lost, data still restores; every existing session is simply invalidated and users log in again. If the database password is lost, nothing restores until it is reset on the server.

## Before an incident

- Run backups regularly and **verify** them (`npm run backup:verify -- <id>`). A backup that has never been verified is an assumption.
- A weekly automated rehearsal now proves restorability on its own (see [RESTORE_REHEARSAL.md](./RESTORE_REHEARSAL.md)); `npm run backup:stage-restore -- <id>` remains available for an on-demand check.
- Keep `S2_NAS_BACKUP_ROOT` on a different physical volume from `S2_NAS_STORAGE_ROOT`, and copy backups offsite. A backup on the same disk does not survive that disk.
- Store `.env` and secrets in a password manager or secret store, not next to the backups.

## Recovery scenarios

**Accidental deletion of a few files.** Do not restore the whole system. Items in trash restore from `/trash`; past versions restore from the resource's version history. Whole-system restore for a handful of files loses everything created since the backup.

**Database corruption, files intact.** Stage a restore, reconcile, then follow the manual cutover in [RESTORE.md](./RESTORE.md) for the database only, keeping current storage. Reconciliation will report orphan files for anything uploaded after the backup — those rows are gone, though the bytes remain.

**Storage loss, database intact.** The database still references every file. Restore files from the backup; reconciliation names anything unrecoverable. Files uploaded after the backup are gone and their rows will point at nothing — remove those rows deliberately rather than leaving broken references.

**Total loss.** Rebuild the host, install MariaDB and the app, restore `.env` from your secret store, create the database, then follow the manual cutover. Verify with `prisma migrate status` and a drift check before reopening access.

## Recovery objectives

Not formally defined yet, and they should be. Two decisions are needed:

- **RPO** — acceptable data loss, which sets backup frequency. There is no scheduler yet; backups are manual or externally scheduled.
- **RTO** — acceptable downtime, which sets how much of the cutover should be rehearsed or scripted.

## Known limitations

- Scheduling and local retention are automated (see [BACKUP_SCHEDULING.md](./BACKUP_SCHEDULING.md)). Offsite copying is verified at the destination but remote deletion remains manual (see [OFFSITE_BACKUP.md](./OFFSITE_BACKUP.md)).
- No production cutover automation and therefore no automated rollback. Rollback depends on the operator taking a fresh verified backup first (step 2 of the cutover).
- Backups are not encrypted at rest. They contain no secrets, but they do contain all company file content — protect the backup root accordingly.
- The operation lock is per process; a multi-process deployment needs a database-level lock.
- Restore staging needs a database namespace the app account may create (`test_` by default).

## F12 - ดัชนีข้อความไม่อยู่ในเส้นทางวิกฤต

เมื่อกู้ระบบกลับมาหลังเหตุการณ์ร้ายแรง **อย่ารอการทำดัชนีข้อความ**

ลำดับความสำคัญไม่เปลี่ยน: ฐานข้อมูล → ไฟล์จริง → ตรวจ checksum → เปิดให้ใช้งาน

การค้นจากเนื้อในเอกสารเป็นสิ่งสุดท้ายที่ควรกังวล มันสร้างใหม่ได้ทั้งหมดจากไฟล์ที่กู้มาแล้ว
และระบบให้บริการได้ครบทุกอย่างระหว่างที่คิวยังทำงานอยู่เบื้องหลัง

ถ้าตัวสกัดข้อความมีปัญหาจนรบกวนการกู้ระบบ ให้ตั้ง `S2_NAS_EXTRACT_ENABLED=0`
แล้วเปิดกลับภายหลัง - ไม่มีข้อมูลใดสูญหายจากการปิดมัน

## F13 - OCR ไม่อยู่ในเส้นทางวิกฤต

เช่นเดียวกับดัชนีข้อความ **อย่ารอ OCR ตอนกู้ระบบ**

ถ้าเครื่องมือ OCR ไม่พร้อมหลังกู้ระบบ ตั้ง `S2_NAS_OCR_ENABLED=0` ไว้ก่อน
ระบบให้บริการได้ครบทุกอย่าง แล้วค่อยเปิดกลับเมื่อพร้อม

OCR ไม่เคยเป็นเงื่อนไขของการเริ่มระบบ และไม่มีข้อมูลใดสูญหายจากการปิดมัน
