# Google Drive integration and semantic indexing

ไฟล์ที่ import/sync จาก Google ใน F19 สร้าง `ResourceVersion` และเดินผ่าน extraction queue เดียวกับไฟล์ NAS
เมื่อ effective text พร้อม F20 จึง enqueue semantic เอง Google credentials ไม่ถูกส่งให้ embedding provider และ
provider ไม่อ่าน OAuth ciphertext

เมื่อ Google content เปลี่ยน เวอร์ชันใหม่เป็น current และ vector เก่าถูกลบทันที; เวอร์ชันใหม่ค้น lexical ได้ระหว่าง
รอ embedding ถ้า sync ไม่เปลี่ยน version/fingerprint จะไม่ re-embed ดูคู่มือหลักใน F19 handoff/implementation notes
และ [SEMANTIC_INDEXING.md](SEMANTIC_INDEXING.md)
