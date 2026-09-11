# RAG ของผู้ช่วยเอกสาร

ลำดับทำงานคือ question → resolve visible scope → recheck capabilities → current READY text indexes → semantic chunk candidates + lexical Thai/English candidates → diversity/budget selection → grounded prompt → local generation → strict JSON parse → citation validation → safe DTO

ค่าเริ่มต้น: candidates 40, evidence 10, ไม่เกิน 3 ชิ้นต่อ resource และข้อความ evidence รวม 24,000 ตัวอักษร Semantic ใช้ MiniLM ของ F20 และ MariaDB VECTOR/HNSW; lexical recall รองรับคำไทยไม่มีช่องว่างด้วยหน้าต่าง Unicode สี่ตัวอักษร Exact/current-version checks อยู่ใน backend

Summary/compare/extract ของ selected scope เพิ่มตัวอย่างข้อความแบบกระจายต้น/กลาง/ท้ายโดยไม่ยัดทั้งไฟล์ Compare สำรองหนึ่ง evidence ต่อเอกสารก่อนเติมตามคะแนน Library QA ไม่ส่งข้อความทั้งคลังเข้าโมเดล Archived รวมเฉพาะ thread ที่ระบุ `includeArchived`; trash ไม่เคยรวม

Context 8,192 tokens สำรอง output สูงสุด 768 tokens และใช้ประวัติ 6 ข้อความ การนับ token ใน provider รุ่นนี้เป็น conservative estimate; llama.cpp เป็นผู้บังคับ context จริง การสรุปเอกสารยาวเป็น sampled hierarchical precursor ยังไม่ใช่ multi-pass section summarization เต็มรูปแบบ จึงต้องวัดกับเอกสารยาวก่อนประกาศ F21 complete

