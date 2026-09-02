# DEVELOPMENT

## เริ่มต้น

```bash
npm install
```

```bash
npm run dev
```

| ส่วน | URL |
| --- | --- |
| Frontend | http://localhost:8888 |
| Backend | http://localhost:8889 |
| Health | http://localhost:8889/api/health |

## คำสั่งที่ใช้บ่อย

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

```bash
npm --prefix backend run prisma:generate
```

## CMD Logging

Backend ตอน start

```
============================================================
 S2 NAS
 ระบบจัดเก็บเอกสารและไฟล์บนเซิร์ฟเวอร์
============================================================

[SERVER] Environment : development
[SERVER] Backend     : http://localhost:8889
[SERVER] API         : http://localhost:8889/api
[SERVER] Health      : http://localhost:8889/api/health

[DATABASE] MariaDB   : CONNECTED

[STORAGE] Status     : READY
[STORAGE] Path       : <storage root>

[S2 NAS] Backend ready
============================================================
```

Request log ระหว่างพัฒนา

```
[12:35:20] INFO  GET    /api/documents 200 32ms
```

เมื่อรัน `npm run dev` จาก root, concurrently จะเติม prefix `[BACKEND]` และ `[FRONTEND]` ให้แต่ละบรรทัด

## แนวทางการเขียนโค้ด

### Backend

- หนึ่ง feature เท่ากับหนึ่งโฟลเดอร์ใน `src/modules`
- validate input ด้วย Zod ทุก endpoint
- โยน `AppError` เพื่อให้ error handler กลางจัดรูปแบบให้
- เข้าถึงไฟล์ผ่าน `resolveInsideStorage()` เท่านั้น

### Frontend

- ดึงข้อมูลด้วย TanStack Query ผ่าน `lib/api.ts`
- ทุกหน้าต้องมี loading, empty, error, success
- ใช้ `LoadingState`, `EmptyState`, `ErrorState` จาก `components/ui/States.tsx`
- ห้ามแสดงข้อมูลปลอมเพื่อให้หน้าดูเต็ม ให้ใช้ empty state แทน

## Font

ทั้งระบบใช้ Kodchasan ผ่าน `@fontsource/kodchasan` ที่ import ใน `src/styles/index.css`
ห้ามเปลี่ยน font หลักและห้ามโหลดจาก Google Fonts ตอน runtime

## ตัวแปรที่ห้ามเปลี่ยน

| รายการ | ค่า |
| --- | --- |
| ชื่อระบบ | S2 NAS |
| Subtitle | ระบบจัดเก็บเอกสารและไฟล์บนเซิร์ฟเวอร์ |
| Frontend port | 8888 |
| Backend port | 8889 |
| Font | Kodchasan |
| Database | MariaDB |

## Test

```bash
npm test
```

ครอบคลุมในตอนนี้: storage path traversal, storage read/write, health endpoint,
รูปแบบ error กลาง และการยืนยันว่า storage ไม่ถูก serve เป็น static directory
