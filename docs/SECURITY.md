# SECURITY

## Semantic search

โมเดล ONNX ทำงาน local-only และ API กรอง authorization ก่อนคืน candidate/snippet ไม่มี endpoint คืน vector
ไม่มี semantic สำหรับ external portal หรือ public guest ดู [SEMANTIC_SEARCH_SECURITY.md](SEMANTIC_SEARCH_SECURITY.md)

## การเข้าถึงไฟล์

- ห้าม serve storage เป็น static public directory
- `http://server/storage/file.pdf` ต้องเข้าถึงไม่ได้
- ดาวน์โหลดผ่าน `GET /api/resources/:id/download` เท่านั้น
- ก่อน stream ไฟล์ backend ต้อง authenticate → authorize → ตรวจสิทธิ์ระดับเอกสาร

## Path traversal

ทุก path ผ่าน `resolveInsideStorage()` ซึ่งปฏิเสธ path ที่ resolve ออกนอก storage root
มี unit test ครอบคลุมกรณี `../../file.pdf`, path ที่ซ่อน `..` กลางทาง และ absolute path ของ drive อื่น

ห้ามเชื่อ original filename ที่ผู้ใช้ส่งมาเป็น path เด็ดขาด

## Upload

ตรวจก่อนรับไฟล์ทุกครั้ง

| รายการ | วิธีตรวจ |
| --- | --- |
| นามสกุลไฟล์ | allowlist |
| MIME type | ตรวจกับนามสกุล |
| ขนาดไฟล์ | `S2_NAS_MAX_UPLOAD_BYTES` (fallback: `MAX_UPLOAD_SIZE_MB`) |
| ชื่อไฟล์ | sanitize แล้วสร้าง safe filename ใหม่ |
| ไฟล์ซ้ำ | SHA-256 |

## Authentication (Phase 2)

- รหัสผ่านเก็บเป็น hash เท่านั้น (bcrypt หรือ argon2)
- Access token อายุสั้น, refresh token แยกความลับกัน
- Secret มาจาก environment ห้าม commit
- รองรับปิดการใช้งานผู้ใช้ และบันทึก last login

## สิ่งที่ห้าม log

- รหัสผ่าน
- JWT และ refresh token
- รหัสผ่านฐานข้อมูลและ connection string
- ข้อมูลส่วนบุคคลที่ไม่จำเป็น

Logger ตั้ง redact ไว้แล้วที่ `backend/src/core/logger.ts`
และการรายงาน error ของฐานข้อมูลมีการปิดบัง connection string ก่อนแสดงผลเสมอ

## Error handling

- Client ได้รับเฉพาะ `code` และ `message` ภาษาไทย
- Stack trace อยู่ใน server log เท่านั้น
- Production ไม่ส่ง `details`

## Header ความปลอดภัย

ใช้ `@fastify/helmet` และ CORS จำกัดเฉพาะ origin ที่กำหนดใน `CORS_ORIGIN`

## ZIP และ scanner

- Archive path สร้างจากชื่อ Resource ที่ validate แล้วเท่านั้น ไม่ใช้ storage key หรือ input path
- ทุก descendant ถูก authorize ซ้ำ; พบรายการใดไม่มีสิทธิ์จะยกเลิก ZIP ทั้งชุด
- จำกัดทั้งจำนวนรายการและ uncompressed metadata bytes ก่อน stream
- สถานะ file security scanner คือ `NOT_CONFIGURED`; ห้ามแสดง badge หรืออ้างว่าสแกนไวรัสแล้ว
- จุดเชื่อม ClamAV ในอนาคตอยู่ก่อน commit staged upload

## Share

- Phase แรกแชร์ภายในระบบเท่านั้น
- รองรับ `expiresAt` สำหรับลิงก์หมดอายุ
- ห้ามเปิด public share ที่ไม่มีการตรวจสิทธิ์เป็นค่า default

## บันทึกการตรวจสอบ (F17)

- `/admin/audit` ต้องมี `system:audit:view` การส่งออกต้องมี `system:audit:export` แยกอีกใบ
- บัญชี EXTERNAL และ SERVICE เข้าไม่ถึงเลย กันสองชั้น (`requireInternal` + `canViewAudit`)
- ไม่มี API แก้หรือลบเหตุการณ์ - บันทึกที่แก้ได้ไม่ใช่หลักฐาน
- ไม่ส่ง `ActivityLog.metadata` ดิบออกไป ทุกฟิลด์ผ่านบัญชีอนุญาตรายเหตุการณ์ + ตัวกรองคำต้องห้าม
- ห้ามหลุด: รหัสผ่าน แฮช refresh/access token Authorization header client secret credential hash storageKey เส้นทางไฟล์จริง
- ไม่ค้นเนื้อหาเอกสารหรือข้อความ OCR - สิทธิ์ตรวจสอบต้องไม่กลายเป็นสิทธิ์อ่านทุกเอกสาร
- IP แสดงเฉพาะผู้มีสิทธิ์ตรวจสอบ user agent สรุปในระบบเอง ไม่ส่งออกไปบริการภายนอก
- CSV ป้องกันสูตร spreadsheet (`= + - @`) และครอบอัญประกาศทุกค่า
- การส่งออกทุกครั้งถูกบันทึกเป็น `AUDIT_LOG_EXPORTED`
- ตัวกรองที่ถูกแก้ใน URL หรือ body ไม่ขยายสิทธิ์ และไม่มี IDOR ที่ `GET /audit/events/:id`

ดู [COMPLIANCE_AUDIT.md](COMPLIANCE_AUDIT.md)

## ลิงก์แชร์ภายนอก (F18)

- โทเคน 256 บิตจาก `crypto.randomBytes` เข้ารหัส base64url
- ฐานข้อมูลเก็บ **SHA-256 ของโทเคนเท่านั้น** โทเคนดิบปรากฏครั้งเดียวตอนสร้าง
- รหัสผ่านของลิงก์ใช้ bcrypt ตัวเดียวกับรหัสผ่านผู้ใช้ ไม่มีเส้นทางอ่านกลับ
- ห้ามหลุด: โทเคนดิบ tokenHash passwordHash storageKey เส้นทางไฟล์จริง
- ขอบเขตโฟลเดอร์ตรวจด้วยการไต่สายบรรพบุรุษที่เซิร์ฟเวอร์ - แก้ id ใน URL ไม่ทำให้หลุดกิ่ง
- ตรวจรหัสผ่านจำกัด 10 ครั้ง/5 นาที ต่อ (IP + โทเคน)
- เส้นทางแขกส่ง `Referrer-Policy: no-referrer`, `Cache-Control: private, no-store`, `X-Robots-Tag: noindex`
- ไม่มีสคริปต์หรือทรัพยากรจากภายนอกบนหน้าของแขก ไม่มีเครื่องมือวิเคราะห์ที่ได้เห็น URL
- **ไม่ผ่อน CORS ทั่วระบบ** หน้าของแขกเป็น same-origin
- ทุกความล้มเหลวตอบข้อความเดียวกันว่า "ลิงก์นี้ไม่สามารถใช้งานได้แล้ว"
- การยกเลิกมีผลทันที ทุกคำขออ่านสถานะลิงก์ใหม่เสมอ
- โควตาดาวน์โหลดจองแบบอะตอมมิกในคำสั่ง UPDATE เดียว
- แขกไม่กลายเป็นผู้ใช้: ไม่มีแถว User ไม่มี UserIdentity ไม่มี session ภายใน

ดู [PUBLIC_SHARE_SECURITY.md](PUBLIC_SHARE_SECURITY.md)
# Document Assistant

F21 บังคับ authorization-before-retrieval, internal accounts only, local inference และ validated evidence aliases ดู `DOCUMENT_ASSISTANT_SECURITY.md` ไม่มี model tools หรือ autonomous writes
