# การค้นหาตามความหมาย (F20)

F20 เพิ่ม semantic search เป็นดัชนีอนุพันธ์ข้าง `ResourceSearchIndex`; การค้นหาตรงตามคำเดิมไม่ถูกแทนที่
และไม่มีการสรุป ตอบคำถาม จัดประเภท หรือย้ายไฟล์อัตโนมัติ

## โหมดค้นหา

- `LEXICAL` — ชื่อ แท็ก หมายเหตุ และข้อความที่ตรงตามคำแบบเดิม
- `SEMANTIC` — ความหมายของเนื้อหาเอกสาร พร้อมคง exact filename เป็นผลสำคัญ
- `HYBRID` — ค่าเริ่มต้นของหน้า Search รวมอันดับด้วย RRF (`k=60`, lexical weight `1.35`)

API เดิมที่ไม่ส่ง `mode` ยังคง `LEXICAL` เพื่อความเข้ากันได้ย้อนหลัง และ Saved Search เดิมถูก migrate เป็น
`LEXICAL` หน้า Search เก็บ `mode` ใน URL และ default เป็น `HYBRID`

ผล semantic แสดงป้าย “เนื้อหามีความหมายใกล้เคียง” กับ snippet ข้อความล้วนจาก chunk ที่ตรง
ไม่แสดง cosine score และไม่สร้าง highlight ปลอมเมื่อคำค้นไม่อยู่ในข้อความจริง

## การตกกลับอย่างปลอดภัย

ถ้าโมเดลหรือ vector store ไม่พร้อม `HYBRID` จะตกกลับไป `LEXICAL` พร้อมข้อความแจ้งแบบไม่รบกวน
การ login, upload, download, preview และ lexical search ไม่ขึ้นกับ semantic search

Portal semantic ถูกเลื่อนไว้หลัง F20 เพราะการทำซ้ำ recursive-grant filtering ใน vector query เพิ่มความเสี่ยง
ส่วน public/guest share ไม่มี semantic endpoint โดยตั้งใจ

ดู [SEMANTIC_INDEXING.md](SEMANTIC_INDEXING.md), [EMBEDDING_MODEL.md](EMBEDDING_MODEL.md)
และ [SEMANTIC_SEARCH_SECURITY.md](SEMANTIC_SEARCH_SECURITY.md)
# F21 reuse

ผู้ช่วยเอกสารใช้ semantic candidates ของ F20 หลัง backend สร้างรายการ Resource ID ที่อนุญาตแล้ว MiniLM ทำ embeddings/retrieval เท่านั้นและไม่ใช้สร้างคำตอบ ดู `DOCUMENT_ASSISTANT_RAG.md`
