# Semantic indexing

## ข้อมูลและวงจรชีวิต

`SemanticDocumentIndex` เป็นคิว/สถานะต่อ `ResourceVersion`; `SemanticChunk` เก็บ resource/version,
ลำดับ chunk, UTF-16 offsets, model version, SHA-256 fingerprint, effective text source และ `VECTOR(384)`
แต่ไม่เก็บสำเนาข้อความ เอกสารหนึ่งฉบับมีได้สูงสุด 256 chunks โดยค่าเริ่มต้น

ข้อความที่ฝังคือ effective `ResourceSearchIndex.extractedText`: เมื่อแก้ OCR แล้วจึงเป็น
`HUMAN_CORRECTED`; มิฉะนั้นใช้ OCR หรือ native text ตามสถานะที่มีผลอยู่จริง การกด VERIFIED โดยไม่แก้ข้อความ
ไม่สร้าง embedding ใหม่

เมื่อเวอร์ชันใหม่เป็น current ดัชนีเวอร์ชันเก่าถูกลบทันที ก่อนงานใหม่เสร็จ Query ยังตรวจ
`SemanticDocumentIndex.versionNumber = Resource.currentVersion` ซ้ำอีกชั้น การลบถาวร cascade ทั้งสองตาราง

## Chunking และ fingerprint

ใช้ `Intl.Segmenter` ระดับประโยคสำหรับไทย/อังกฤษ, รักษาย่อหน้า/บรรทัด และวัดขนาดด้วย tokenizer จริงของโมเดล
chunk ใหญ่ถูกแบ่งแบบ binary-search บน Unicode code points จึงไม่ตัด surrogate pair; ค่าเริ่มต้น 448 tokens
ซ้อน 64 tokens คง offsets เพื่อสร้าง snippet หลัง authorization

document fingerprint = SHA-256(modelVersion + effective text ที่ normalize เฉพาะ NFC/line endings)
และ chunk fingerprint รวม model version เช่นกัน ข้อความหรือโมเดลเดิมจึงข้ามการฝังซ้ำได้

## Queue

Extract/OCR ทำก่อน แล้ว enqueue semantic แยกต่างหาก Worker ใช้คิวฐานข้อมูล, concurrency 1,
ครั้งละไม่เกินสามงาน, timeout 180 วินาที และลองไม่เกินสามครั้ง งานค้างเกิน 30 นาทีถูก reconcile
การเริ่มระบบตรวจครั้งละไม่เกิน 500 current searchable versions

สถานะคือ `PENDING`, `PROCESSING`, `READY`, `FAILED`; ความล้มเหลวไม่กระทบไฟล์หรือ lexical index
การ correction save/reset ลบ vectors เดิมแล้วเข้าคิวใหม่ ส่วน rename/tag/remark/retention ไม่ re-embed

MariaDB 12.3 ใช้ cosine `VECTOR INDEX` (modified HNSW, `M=8`) สำหรับ corpus กว้าง และ exact native-vector
distance สำหรับ authorization scope ที่แคบไม่เกิน 2,000 resources เพื่อความแน่นอนของ relational filter
ทั้งสองทางคำนวณใน MariaDB ไม่ดึง float arrays มาสแกนใน Node
# F21

F21 ไม่เปลี่ยน VECTOR/HNSW schema และใช้เฉพาะ chunk ของ current ResourceVersion/effective text การแก้ OCR ทำให้ semantic index ถูกสร้างใหม่ตามกลไก F20 เดิม
