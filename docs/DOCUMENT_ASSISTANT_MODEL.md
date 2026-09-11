# โมเดลผู้ช่วยเอกสาร

## สถาปัตยกรรมและการติดตั้ง

`DocumentAssistantProvider` แยก model/runtime ออกจาก retrieval และ security มี `LlamaCppDocumentAssistantProvider` สำหรับ runtime จริงและ `FakeDocumentAssistantProvider` สำหรับชุดทดสอบ deterministic เท่านั้น Normal startup ไม่ดาวน์โหลดและไม่โหลดโมเดล

```powershell
npm run assistant:model:install
npm run assistant:status
# หลัง real-model QA จึงตั้ง S2_NAS_ASSISTANT_ENABLED=1 แล้ว restart backend
npm run assistant:test
```

ตัวติดตั้งดาวน์โหลด Windows CPU runtime จาก [official llama.cpp releases](https://github.com/ggml-org/llama.cpp/releases/) และ `Qwen/Qwen3-4B-GGUF` Q4_K_M จาก [official Qwen3 repository](https://huggingface.co/Qwen/Qwen3-4B-GGUF) ไป `backend/models/assistant/` (gitignored) พร้อมรายงาน SHA-256 Model weights ไม่อยู่ใน Git หรือ business-data backup และต้อง provision ใหม่หลัง restore

Environment สำคัญ: `S2_NAS_ASSISTANT_MODEL_PATH`, `S2_NAS_ASSISTANT_LLAMA_BIN`, context/output limits, timeout และ queue limit สถานะคือ READY / NOT_CONFIGURED / LOADING / ERROR การไม่มีโมเดลไม่กระทบ login, files, OCR, F20 หรือ Google Drive

## Bake-off บนเครื่องจริง

ทดสอบแบบ CPU-only ด้วย official llama.cpp build `b10868` บนเครื่อง RAM 31.7 GB เปรียบเทียบ official GGUF สองรุ่น ([Qwen3-4B](https://huggingface.co/Qwen/Qwen3-4B-GGUF), [Qwen2.5-3B-Instruct](https://huggingface.co/Qwen/Qwen2.5-3B-Instruct-GGUF)) โดยใช้ prompt/context เดียวกัน:

| รุ่น | License / ขนาด | ไทยจากหลักฐานไทย | อังกฤษจากหลักฐานไทย | no-evidence adversarial | ความเร็วโดยประมาณ |
|---|---|---|---|---|---|
| Qwen3-4B-Instruct Q4_K_M | Apache-2.0 / 2.50 GB | ผ่าน; รักษา `30 กันยายน 2569` | ผ่าน; รักษาปี `2569` | raw model ตอบจำนวนเงินผิดเป็นเลขบัญชี | prompt 54–58 tok/s, generation 8–10 tok/s, 12.9–13.3 s/case |
| Qwen2.5-3B-Instruct Q4_K_M | Qwen Research / 2.10 GB | ผ่านและกระชับ | ไม่ผ่าน; แปลง พ.ศ. 2569 เป็น 2027 | ปฏิเสธถูก แต่ส่ง evidence id เกินมา | prompt 74–76 tok/s, generation 11–13 tok/s, 9.0–10.9 s/case |

เลือก **Qwen3-4B-Instruct Q4_K_M** เพราะรักษาค่าจากหลักฐานข้ามภาษาได้ดีกว่า แม้ช้ากว่า Qwen2.5-3B จุดอ่อน no-evidence ของ raw model จึงถูกบังคับซ้ำที่ application layer: retrieval exact-field gate ปฏิเสธคำถามเลขบัญชีเมื่อไม่มี identifier evidence และ validator ไม่ยอม persist citation/คำตอบที่ไม่ได้อ้าง evidence alias ที่ส่งให้โมเดล

Artifact ที่ provision แล้ว:

- `model.gguf` ขนาด 2,497,280,256 bytes, SHA-256 `7485fe6f11af29433bc51cab58009521f205840f5b4ae3a32fa7f92e8534fdf5`
- llama.cpp official Windows CPU runtime build `b10868`
- context ที่ระบบใช้ 8,192 tokens; output limit 768 tokens

`npm run assistant:test` ผ่าน real-model smoke: ตอบกำหนดส่งภาษาไทยตรงหลักฐาน, อ้างเฉพาะ `E1`, และไม่ทำตาม prompt injection ใน `E2` ใช้เวลาประมาณ 10.8 วินาที Assistant ยังตั้ง `S2_NAS_ASSISTANT_ENABLED=0` เพื่อ fail closed จนกว่าจะผ่าน acceptance ที่ยังค้างด้านล่าง

ยังไม่วัด peak RAM, cold-load/first-token แยกเฟส, long-document hierarchical quality และ browser acceptance ครบทุก viewport ดังนั้นผล bake-off นี้เป็นหลักฐานประกอบการเลือกโมเดล ไม่ใช่การประกาศ F21 complete
