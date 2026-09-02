# ARCHITECTURE

## ภาพรวม

S2 NAS แยกออกเป็นสองส่วนที่ deploy แยกกันได้

```
Browser
  │  http://localhost:8888
  ▼
Frontend (React + Vite)
  │  proxy /api
  ▼
Backend (Fastify)  http://localhost:8889
  ├── MariaDB        เก็บ metadata เท่านั้น
  └── File Storage   เก็บไฟล์จริง (S2_NAS_STORAGE_ROOT)
```

หลักการสำคัญ

1. Database เก็บ **metadata** เท่านั้น ห้ามเก็บ PDF / Excel / รูปเป็น BLOB
2. ไฟล์จริงอยู่บน file storage ของ server
3. Frontend **ไม่รู้จัก physical path** ของ server ทุก path ถูกแปลงเป็น document id
4. ทุกการเข้าถึงไฟล์ผ่าน backend ที่ตรวจสิทธิ์ก่อนเสมอ

## Backend layer

| Layer | ตำแหน่ง | หน้าที่ |
| --- | --- | --- |
| config | `src/config` | อ่านและตรวจ environment, branding |
| core | `src/core` | logger, banner, storage, database, error กลาง |
| plugins | `src/plugins` | request logging, error handler |
| modules | `src/modules/<feature>` | route + service + test ของแต่ละ feature |

แต่ละ module มีรูปแบบเดียวกัน

```

Phase A เพิ่ม identity boundary: React เก็บ access token ใน memory, backend rotate opaque
refresh token ผ่าน HttpOnly cookie, และ Prisma เก็บเฉพาะ token hash ทุก protected route ตรวจ
สถานะผู้ใช้, token version และ permission จาก MariaDB
modules/documents/
├── documents.routes.ts     กำหนด HTTP route
├── documents.service.ts    business logic
├── documents.schema.ts     Zod schema
└── documents.test.ts
```

## Frontend layer

| Layer | ตำแหน่ง | หน้าที่ |
| --- | --- | --- |
| pages | `src/pages` | หนึ่งไฟล์ต่อหนึ่งหน้า |
| components/layout | sidebar, header, app shell |
| components/ui | ชิ้นส่วนที่ใช้ซ้ำ เช่น Card, สถานะ loading/empty/error |
| components/\<feature\> | ชิ้นส่วนเฉพาะหน้า เช่น dashboard |
| lib | api client, utility |

ทุกหน้าที่ดึงข้อมูลต้องรองรับสี่สถานะ: loading, empty, error, success
ห้ามปล่อยหน้าขาว และห้ามแสดง `undefined`, `NaN` หรือ error object ให้ผู้ใช้

## Startup sequence ของ backend

1. อ่านและตรวจ environment (ผิด → หยุดพร้อมข้อความชัดเจน)
2. ตรวจ storage: มีโฟลเดอร์ อ่านได้ เขียนได้ (เขียนไม่ได้ → หยุด)
3. ตรวจการเชื่อมต่อ MariaDB
   - production หรือ `STRICT_DB_STARTUP=true` → เชื่อมต่อไม่ได้แล้วหยุด
   - development → รายงานเป็นคำเตือนและทำงานต่อ
4. เปิด HTTP server และแสดง banner

## รองรับอนาคต

- Preview ของ Excel / Word เพิ่มเป็น renderer module ใหม่ได้โดยไม่แตะ storage layer
- Search แยกเป็น service ของตัวเอง เพื่อรองรับการค้นหา invoice number / vendor ภายหลัง
- OCR และ AI เป็น worker แยก อ่านไฟล์จาก storage แล้วเขียน metadata กลับเข้า database
