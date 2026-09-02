# BACKUP

Phase 1 วางสถาปัตยกรรมไว้ ระบบสำรองข้อมูลจริงเปิดใช้งานใน Phase 6

## ขอบเขต

Backup ต้องครอบคลุมสองส่วน

1. **Database backup** — dump ของ MariaDB
2. **File storage backup** — ไฟล์จริงทั้งหมดใต้ `S2_NAS_STORAGE_ROOT`

การสำรองเฉพาะฐานข้อมูลอย่างเดียวถือว่าไม่สมบูรณ์ เพราะไฟล์เอกสารไม่ได้อยู่ในฐานข้อมูล

## BackupLog

| ฟิลด์ | ความหมาย |
| --- | --- |
| `startAt` | เวลาเริ่ม |
| `finishAt` | เวลาเสร็จ |
| `status` | `RUNNING`, `SUCCESS`, `FAILED` |
| `size` | ขนาดของ backup |
| `type` | `DATABASE`, `STORAGE`, `FULL` |
| `message` | รายละเอียดหรือสาเหตุที่ล้มเหลว |

## หน้า Backup แสดง

- Backup ล่าสุด
- สถานะ
- ขนาด
- เวลาที่ใช้

## แนวปฏิบัติ

- เก็บ backup ไว้คนละไดรฟ์กับ storage หลัก
- ทดสอบการกู้คืนเป็นระยะ ไม่ใช่แค่ backup แล้วจบ
- ไฟล์ backup ต้องไม่เข้าถึงได้จาก web
