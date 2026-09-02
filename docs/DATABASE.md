# DATABASE

## ระบบฐานข้อมูล

- MariaDB (Prisma ใช้ provider `mysql`)
- ใช้เก็บ **metadata เท่านั้น**
- ห้ามเก็บไฟล์เอกสารเป็น BLOB

| Environment | Database |
| --- | --- |
| Development | `s2_nas_dev` |
| Production | `s2_nas` |

ตั้งค่าที่ `backend/.env`

```
DATABASE_URL="mysql://USER:PASSWORD@HOST:3306/s2_nas_dev"
```

## Migration

ห้ามใช้ `prisma db push` เป็น workflow ของ production

```bash
npm run prisma:migrate
```

```bash
npm --prefix backend run prisma:deploy
```

| คำสั่ง | ใช้เมื่อ |
| --- | --- |
| `prisma migrate dev` | development เท่านั้น |
| `prisma migrate deploy` | production |
| `prisma generate` | หลังแก้ schema ทุกครั้ง |

## Schema ปัจจุบัน (Phase A)

| Model | หน้าที่ |
| --- | --- |
| `User` | ผู้ใช้ HUMAN/SERVICE, สถานะ และ password hash |
| `Role`, `Permission` | RBAC catalog |
| `UserRole`, `RolePermission` | ความสัมพันธ์ผู้ใช้ บทบาท และสิทธิ์ |
| `RefreshToken` | hash ของ refresh session พร้อม expiry/revocation |
| `ActivityLog` | audit สำหรับ login และการจัดการบัญชี |
| `SystemSetting` | ค่าตั้งค่าระบบแบบ key-value |

Migration เริ่มต้น: `20260901084500_phase_a_identity_access`

## Schema ที่จะเพิ่ม (Phase 2 เป็นต้นไป)

| กลุ่ม | Model |
| --- | --- |
| ผู้ใช้และสิทธิ์ | `User`, `Role`, `Permission`, `UserRole` |
| ไฟล์และโฟลเดอร์ | `Folder`, `Document`, `DocumentVersion`, `Tag`, `DocumentTag`, `Favorite` |
| การทำงานร่วมกัน | `DocumentShare` (OWNER / EDITOR / VIEWER) |
| ระบบ | `ActivityLog`, `SystemSetting`, `StorageStat`, `BackupLog` |

### ฟิลด์หลักของ `Document`

| ฟิลด์ | คำอธิบาย |
| --- | --- |
| `originalName` | ชื่อไฟล์ที่ผู้ใช้อัปโหลด |
| `storedName` | ชื่อไฟล์ที่ระบบสร้าง (safe filename) |
| `extension`, `mimeType`, `size` | ข้อมูลไฟล์ |
| `storagePath` | path ภายใน storage root (ห้ามส่งให้ browser) |
| `checksum` | SHA-256 ใช้ตรวจไฟล์ซ้ำ |
| `folderId` | โฟลเดอร์ที่ไฟล์อยู่ (null = ระดับบนสุด) |
| `uploadedBy`, `version` | ผู้อัปโหลดและเวอร์ชันปัจจุบัน |
| `deletedAt` | soft delete |

## Seed

รายชื่อผู้ใช้เริ่มต้นอยู่ที่ `backend/src/config/seed-users.ts`
อีเมลถูก normalize เป็นตัวพิมพ์เล็ก และอีเมลที่รูปแบบยังไม่ยืนยันจะไม่ถูก seed
(ดู `UNCONFIRMED_SEED_EMAILS`)

รหัสผ่านมาจาก environment เท่านั้น

```
SEED_ADMIN_EMAIL=
SEED_ADMIN_PASSWORD=
```

ห้าม hardcode รหัสผ่านใน source code และต้องตั้ง `mustChangePassword = true`
