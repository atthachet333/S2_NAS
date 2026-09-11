# ความปลอดภัยผู้ช่วยเอกสาร

Invariant สำคัญคือ authorization ต้องเสร็จก่อนอ่านข้อความ ผู้ช่วยใช้ `visibilityScope` แล้วตรวจซ้ำด้วย `capabilities().canView`; หลังจากนั้นจึงอ่าน `ResourceSearchIndex.extractedText` และส่งเฉพาะ evidence ที่อนุญาตให้ provider การเพิกถอนสิทธิ์มีผลกับคำถามถัดไปทันทีแม้ thread เดิมยังอยู่

เอกสารเป็นข้อมูลที่ไม่น่าเชื่อถือ ไม่ใช่คำสั่ง System prompt ห้ามทำตามคำสั่งในเอกสาร เปิดเผย prompt หรือเติมข้อเท็จจริงจากความรู้ทั่วไป Provider ไม่มี filesystem, database, shell หรือ action tools

Backend ตั้งชื่อหลักฐาน `E1…En` และยอมรับ citation เฉพาะ ID ในชุดนั้น Unknown/missing citation ทำให้คำตอบล้มเหลวและไม่บันทึก assistant message Citation DTO มีเฉพาะ Resource ID, ResourceVersion ID, ชื่อแสดงผล, chunk/offset เมื่อมี, text source และ snippet จำกัด 500 ตัวอักษร ไม่มี vector, storage key, path, prompt หรือ credential

คำถาม คำตอบ chunk และ prompt ไม่ถูกเขียนลง global audit/log Audit เก็บเพียง user/thread operation, duration, citation count และ error code ข้อความผู้ใช้/ผู้ช่วยอยู่ใน private thread เท่านั้น Retrieved chunks ไม่ถูกเก็บใน chat tables

การทดสอบครอบคลุม citation ปลอม, prompt injection, thread ownership, unauthorized selected resource และ access revoke เส้นทาง `/api/assistant/*` ทุกเส้นทางเป็น internal-authenticated; ไม่มี `/api/public/*` หรือ `/api/portal/*` สำหรับ AI

