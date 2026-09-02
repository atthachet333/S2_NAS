# API

Base URL: `http://localhost:8889/api`
Frontend เรียกผ่าน `/api` และ Vite proxy ไปยัง backend ให้อัตโนมัติ

## รูปแบบการตอบกลับ

สำเร็จ

```json
{ "success": true, "data": { } }
```

ผิดพลาด

```json
{
  "success": false,
  "error": {
    "code": "DOCUMENT_NOT_FOUND",
    "message": "ไม่พบเอกสาร"
  }
}
```

`details` ที่ `AppError` กำหนดไว้อย่างตั้งใจ (เช่น restore conflict reason) อาจส่งให้ client ได้ทุก environment; stack trace และ error ภายในไม่ถูกส่ง

## Phase D file operations

ทุก endpoint ด้านล่างต้องมี Bearer access token และตรวจสิทธิ์ที่ backend

| Method | Endpoint | รายละเอียด |
| --- | --- | --- |
| POST | `/api/resources/upload` | multipart upload ไฟล์ใหม่ พร้อม duplicate decision fields |
| POST | `/api/resources/:id/versions` | อัปโหลดเวอร์ชันใหม่โดยคง Resource ID |
| GET | `/api/resources/:id/versions` | ประวัติเวอร์ชันที่ไม่เปิดเผย storage key |
| GET | `/api/resources/:id/content?version=N` | inline content ที่ MIME allowlist อนุญาต |
| GET | `/api/resources/:id/download?version=N` | ดาวน์โหลด current/old version |
| GET | `/api/resources/:id/download-zip` | stream ZIP ของโฟลเดอร์ |
| POST | `/api/resources/download-zip` | stream ZIP ของ `resourceIds` แบบผสม |
| GET | `/api/resources-recent` | รายการ active ล่าสุดตามสิทธิ์ |
| GET | `/api/trash` | รายการรากในถังขยะ |
| POST | `/api/resources/:id/trash` | soft-delete subtree |
| POST | `/api/resources/:id/restore` | restore พร้อม `newName`/`targetParentId` เมื่อจำเป็น |
| GET | `/api/resources/:id/permanent-delete-preview` | จำนวนที่จะลบจริง |
| DELETE | `/api/resources/:id/permanent` | ลบ subtree และ physical versions ถาวร |
| GET | `/api/system/managed-storage` | managed resource bytes ไม่ใช่ disk usage |

ZIP ใช้ policy fail-whole และตอบ `ZIP_TOO_LARGE` (413) เมื่อเกิน count หรือ aggregate byte limit. ชื่อไฟล์ใช้ `Content-Disposition` แบบ ASCII fallback + UTF-8 `filename*`.

## Authentication (Phase A)

| Method | Endpoint | รายละเอียด |
| --- | --- | --- |
| POST | `/api/auth/login` | รับ email/password, คืน access token และตั้ง HttpOnly refresh cookie |
| POST | `/api/auth/refresh` | rotate refresh token และคืน access token ใหม่ |
| POST | `/api/auth/session` | กู้คืน session ตอนเปิดแอปจาก refresh cookie ตอบ 200 เสมอ พร้อม `authenticated: true/false` |
| POST | `/api/auth/logout` | revoke refresh token และล้าง cookie |
| GET | `/api/auth/me` | ข้อมูลผู้ใช้ บทบาท และสิทธิ์ปัจจุบัน |
| POST | `/api/auth/change-password` | เปลี่ยนรหัสผ่าน, revoke session เดิมทั้งหมด |
| GET/POST/PATCH | `/api/users`, `/api/users/:id` | ดู สร้าง invitation และจัดการผู้ใช้ (RBAC) |
| GET | `/api/roles`, `/api/permissions` | role/permission catalog (RBAC) |

ส่ง access token ด้วย `Authorization: Bearer <token>` ห้ามเก็บ refresh tokenใน JavaScript

### Session bootstrap กับ /auth/refresh ต่างกันอย่างไร

| | `/auth/session` | `/auth/refresh` |
| --- | --- | --- |
| ใช้เมื่อ | เปิดแอปครั้งแรก | ต่ออายุ session ระหว่างใช้งาน |
| ไม่มี cookie / cookie ใช้ไม่ได้ | `200` + `authenticated: false` (และล้าง cookie ทิ้ง) | `401` |
| cookie ใช้ได้ | `200` + `authenticated: true` + access token (rotate cookie) | `200` + access token (rotate cookie) |

เหตุผลที่ `/auth/session` ไม่ตอบ 401: การเปิดเว็บโดยยังไม่ได้เข้าสู่ระบบเป็นเหตุการณ์ปกติ
ถ้าตอบ 401 เบราว์เซอร์จะบันทึกเป็น console error ทุกครั้งที่เปิดหน้าเว็บ


### การประสานงานระหว่างแท็บ (cross-tab)

refresh token หมุนทุกครั้งที่เรียกสำเร็จ ถ้าหลายแท็บ bootstrap พร้อมกัน
แท็บที่สองจะส่ง cookie ใบเดิมที่เพิ่งถูกหมุนไปแล้วและถูกปฏิเสธ ผู้ใช้จึงหลุดจากระบบทั้งที่ session ยังดีอยู่

ฝั่ง client แก้ด้วยการจัดคิว ไม่ใช่ลดความเข้มงวดฝั่งเซิร์ฟเวอร์

| กลไก | ชื่อ | หน้าที่ |
| --- | --- | --- |
| Web Locks | `s2-nas-session-refresh` | ให้มีแท็บเดียวเรียก `/auth/session` ได้ในแต่ละช่วงเวลา แท็บถัดไปรอคิวแล้วจึงใช้ cookie ใบใหม่ |
| BroadcastChannel | `s2-nas-auth` | ประกาศ `LOGIN` / `LOGOUT` / `PASSWORD_CHANGED` ให้แท็บอื่นปรับสถานะตาม |

ข้อความที่ประกาศมีเพียง `{ type, at, from }` โดย `from` เป็นรหัสสุ่มประจำแท็บสำหรับกรองเสียงของตัวเอง
**ไม่มีการส่ง token ข้ามแท็บ** แต่ละแท็บขอ access token ของตัวเองจากเซิร์ฟเวอร์โดยตรง

ถ้าเบราว์เซอร์ไม่รองรับ Web Locks หรือ BroadcastChannel ระบบจะทำงานแบบเดิมได้ตามปกติ
เพียงแต่ไม่ซิงก์ข้ามแท็บ (fail-safe ไม่ใช่ fail-closed)

refresh cookie (HttpOnly) เป็นแหล่งข้อมูล session ที่เชื่อถือได้เพียงแหล่งเดียว
ฝั่ง client ไม่มีสถานะใดที่ขัดขวางการกู้คืน session ได้ cookie ที่ยังใช้งานได้จะกู้คืนผู้ใช้เสมอ
แม้ localStorage จะถูกล้างจนหมด และห้ามเก็บ token ใด ๆ ลง localStorage / sessionStorage


## Endpoint ระบบ

### GET /api/health

ตรวจสถานะระบบ

```json
{
  "status": "ok",
  "service": "S2 NAS",
  "database": "connected",
  "storage": "ready",
  "uptime": 12345,
  "timestamp": "2026-09-01T07:00:00.000Z"
}
```

| ฟิลด์ | ค่าที่เป็นไปได้ |
| --- | --- |
| `status` | `ok`, `degraded`, `error` |
| `database` | `connected`, `disconnected`, `not_configured` |
| `storage` | `ready`, `read_only`, `unavailable` |

HTTP status: `200` เมื่อ `ok` หรือ `degraded`, `503` เมื่อ `error`

### GET /api/system/info

ข้อมูลระบบสำหรับแสดงผล

```json
{
  "success": true,
  "data": {
    "service": "S2 NAS",
    "subtitle": "ระบบจัดเก็บเอกสารและไฟล์บนเซิร์ฟเวอร์",
    "environment": "development",
    "version": "0.1.0",
    "phase": 1,
    "uptime": 120,
    "database": "CONNECTED",
    "maxUploadSizeMb": 100
  }
}
```

### GET /api/system/storage

พื้นที่จัดเก็บ ส่งกลับเฉพาะตัวเลข ไม่ส่ง physical path

```json
{
  "success": true,
  "data": {
    "status": "READY",
    "readable": true,
    "writable": true,
    "totalBytes": 5497558138880,
    "usedBytes": 1627389952000,
    "freeBytes": 3870168186880
  }
}
```

## Endpoint ตามแผน

| Phase | Endpoint |
| --- | --- |
| 3 | `POST /api/files/upload`, `GET /api/files`, `GET /api/files/:id`, `GET /api/files/:id/download`, `GET /api/files/:id/preview`, `POST /api/folders`, `GET /api/search`, `GET /api/trash` |
| 4 | `PATCH /api/files/:id/move`, `POST /api/files/:id/copy`, `POST /api/files/:id/favorite`, `GET /api/favorites`, `GET /api/recent` |
| 5 | `POST /api/files/:id/share`, `GET /api/shared`, `GET /api/files/:id/versions`, `GET /api/activity` |
| 6 | `GET /api/backup`, `POST /api/backup/run`, `GET /api/settings` |

## Error code ที่ใช้อยู่

| Code | HTTP | ความหมาย |
| --- | --- | --- |
| `ROUTE_NOT_FOUND` | 404 | ไม่พบเส้นทาง |
| `VALIDATION_ERROR` | 422 | ข้อมูลที่ส่งมาไม่ถูกต้อง |
| `INVALID_PATH` | 400 | เส้นทางไฟล์ไม่ถูกต้อง |
| `UNAUTHORIZED` | 401 | ยังไม่ได้เข้าสู่ระบบ |
| `FORBIDDEN` | 403 | ไม่มีสิทธิ์เข้าถึง |
| `RESOURCE_ACCESS_DENIED` | 403 | ไม่มีสิทธิ์ต่อ resource หรือ descendant |
| `ZIP_TOO_LARGE` | 413 | ZIP เกินจำนวนหรือขนาดรวมที่กำหนด |
| `TRASH_RESTORE_CONFLICT` | 409 | ต้องตั้งชื่อใหม่หรือเลือกปลายทาง restore |
| `INTERNAL_ERROR` | 500 | ข้อผิดพลาดภายในระบบ |
