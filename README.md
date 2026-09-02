# S2 NAS

**ระบบจัดเก็บเอกสารและไฟล์บนเซิร์ฟเวอร์**

พื้นที่จัดเก็บไฟล์ของบริษัท ใช้งานคล้าย Google Drive / OneDrive / Dropbox
แต่ไฟล์ทั้งหมดอยู่บน storage ของเซิร์ฟเวอร์ขององค์กร ไม่ใช่เครื่องของพนักงานแต่ละคน

โฟลเดอร์คือโมเดลการจัดระเบียบหลัก ผู้ใช้ต้อง สร้างโฟลเดอร์ อัปโหลด เปิดดู ดาวน์โหลด และแชร์ ได้เร็วที่สุด

---

## สถานะปัจจุบัน

| Phase | ขอบเขต | สถานะ |
| --- | --- | --- |
| 1 | โครงสร้างโปรเจกต์ / CMD Logging / Health Check / Dashboard Shell | เสร็จแล้ว |
| 1.5 | Redesign เป็น file manager: ตัด sidebar, top navigation, admin แยกส่วน | เสร็จแล้ว |
| A | MariaDB, Prisma, Authentication, Users, Roles, Permissions | เสร็จแล้ว (ต้องตั้ง `SEED_ADMIN_PASSWORD` ก่อน login ครั้งแรก) |
| B | Redesign V2, Light/Dark/System Theme, Main/Admin Shell | เสร็จแล้ว |
| 3 | File Storage, Upload, Download, Preview, Search, Trash | ยังไม่เริ่ม |
| 4 | Folder tree, ย้าย/ทำสำเนา, รายการโปรด | ยังไม่เริ่ม |
| 5 | Sharing (OWNER/EDITOR/VIEWER), Versions, Activity Log | ยังไม่เริ่ม |
| 6 | Backup, Storage Monitor, Settings | ยังไม่เริ่ม |
| 7 | Production Hardening, Security, Tests, Documentation | ยังไม่เริ่ม |

---

## ความต้องการของระบบ

- Node.js 20 ขึ้นไป (พัฒนาและทดสอบบน Node 24)
- MariaDB (จำเป็นตั้งแต่ Phase 2)
- npm 10 ขึ้นไป

## ติดตั้ง

```bash
npm install
```

คำสั่งนี้ติดตั้ง dependency ของทั้ง `backend/` และ `frontend/` ให้อัตโนมัติ

ตั้งค่า environment ของ backend:

```bash
cd backend
copy .env.example .env
```

แล้วแก้ `DATABASE_URL`, `S2_NAS_STORAGE_ROOT` และ JWT secret ให้ตรงกับเครื่องที่ใช้งาน

## รันระบบ

```bash
npm run dev
```

| ส่วน | URL |
| --- | --- |
| Frontend | http://localhost:8888 |
| Backend | http://localhost:8889 |
| API | http://localhost:8889/api |
| Health | http://localhost:8889/api/health |

Frontend proxy `/api` ไปยัง backend ที่ port 8889 ให้อัตโนมัติ

คำสั่งอื่น:

```bash
npm run dev:backend
```

```bash
npm run dev:frontend
```

```bash
npm run typecheck
```

```bash
npm test
```

เตรียมฐานข้อมูลและข้อมูลสิทธิ์ครั้งแรก:

```bash
npm --prefix backend run prisma:deploy
npm --prefix backend run prisma:seed
```

ระบบ seed จะสร้าง role/permission และบัญชีที่กำหนดไว้แบบ idempotent บัญชีอื่นเป็น
`INVITED` และไม่มีรหัสผ่าน ส่วนบัญชีที่ตรงกับ `SEED_ADMIN_EMAIL` จะเปิดใช้งานต่อเมื่อ
กำหนด `SEED_ADMIN_PASSWORD` แล้วเท่านั้น

## โครงสร้างโปรเจกต์

```
s2-nas/
├── backend/            Fastify + TypeScript + Prisma
│   ├── prisma/         Prisma schema และ migration
│   ├── src/
│   │   ├── config/     environment และ branding
│   │   ├── core/       logger, banner, storage, database, error
│   │   ├── modules/    แยกตาม feature (health, system, ...)
│   │   └── plugins/    request logging, error handler
│   ├── storage/        ไฟล์จริง (dev) - ไม่เข้า git
│   └── logs/
├── frontend/           React + TypeScript + Vite + Tailwind
│   └── src/
│       ├── components/ layout, files, ui
│       ├── pages/       files, shared, recent, favorites, trash, admin
│       ├── hooks/       drive ui, view mode, toast
│       └── lib/         api client, drive types, file types, utils
├── docs/
└── package.json
```

## เอกสารประกอบ

| ไฟล์ | เนื้อหา |
| --- | --- |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | ภาพรวมสถาปัตยกรรม |
| [docs/UX.md](docs/UX.md) | Information architecture และโครงสร้างหน้าจอ |
| [docs/DATABASE.md](docs/DATABASE.md) | ฐานข้อมูลและ Prisma |
| [docs/FILE_STORAGE.md](docs/FILE_STORAGE.md) | โครงสร้างการเก็บไฟล์ |
| [docs/API.md](docs/API.md) | รายการ API |
| [docs/SECURITY.md](docs/SECURITY.md) | แนวปฏิบัติด้านความปลอดภัย |
| [docs/PERMISSIONS.md](docs/PERMISSIONS.md) | บทบาทและสิทธิ์ |
| [docs/BACKUP.md](docs/BACKUP.md) | การสำรองข้อมูล |
| [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) | การนำขึ้น server |
| [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) | คู่มือนักพัฒนา |

## ข้อกำหนดที่ห้ามเปลี่ยน

- ชื่อระบบ **S2 NAS** และ subtitle **ระบบจัดเก็บเอกสารและไฟล์บนเซิร์ฟเวอร์**
- Font หลักทั้งระบบคือ **Kodchasan** (ติดตั้งผ่าน `@fontsource/kodchasan`)
- Frontend port **8888** / Backend port **8889**
- ฐานข้อมูลคือ **MariaDB** และเก็บเฉพาะ metadata
- ไฟล์จริงเก็บบน file storage ห้ามเก็บเป็น BLOB และห้ามเปิด storage เป็น public static directory
