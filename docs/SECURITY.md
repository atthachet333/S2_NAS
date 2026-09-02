# SECURITY

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
