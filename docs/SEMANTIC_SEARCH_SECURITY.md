# Semantic search security

## Privacy boundary

ข้อความเอกสาร/chunk/query อยู่ใน backend เครื่องเดียว ไม่มี external AI API, telemetry, crash payload หรือ log
ไม่มี endpoint ส่ง vector/raw chunk และ query embeddings คำนวณในหน่วยความจำแล้วทิ้ง

ก่อน vector query backend สร้างรายการ resource IDs ด้วย `visibilityScope()` และตัวกรอง F15 ทั้งหมด แล้วจึงส่ง
เฉพาะ IDs ที่อนุญาตเข้า MariaDB Snippet อ่านจาก `ResourceSearchIndex` หลัง capabilities recheck เท่านั้น
vectors ของ current version เท่านั้นที่ query-visible; trash ถูกตัด, archive/lifecycle filter, drive, shares, owner,
uploader, category, tag, dates, OCR/text source, retention และ Legal Hold ใช้กติกาเดิม

บัญชี EXTERNAL ถูก `requireInternal` กันจาก `/api/search`; Portal ใช้ lexical route เดิมและไม่ใช้ semantic service
F18 public guest routesไม่มี semantic search หรือ anonymous vector query

## Derived-data and recovery

semantic tables ไม่ใช่ business truth `mariadb-dump` เก็บ table definition แต่ใช้ `--ignore-table-data`
กับ `semantic_document_indexes` และ `semantic_chunks` Restore จึงคืน Resource/Version/search text ก่อน แล้ว operator
ใช้ `semantic:reindex` สร้าง cache ใหม่ ระหว่างนั้น lexical search ยังพร้อม

Audit บันทึกเฉพาะ queued/ready/failed/reindex, resource id, model version, chunk count และ error code ที่ปลอดภัย
ไม่บันทึกข้อความ คำค้น chunk vector หรือ path ของโมเดล Admin API ก็ไม่คืน filesystem path

## Limits

ค่าเริ่มต้น: effective text 400,000 characters, 256 chunks/document, 448 tokens/chunk, overlap 64,
candidate 200, worker 1, job timeout 180 วินาที, attempts 3 เอกสารผิดปกติจึงไม่กินทรัพยากรไร้ขอบเขต

การ QA ใช้ fixture 10,000 chunks แบบ disposable: สร้าง index 3.6 วินาที, first query 1.01 วินาที,
warm p50 1.01 วินาที และ warm p95 1.02 วินาทีบนเครื่องทดสอบปัจจุบัน ตัวเลขนี้เป็น measurement ไม่ใช่ SLA
