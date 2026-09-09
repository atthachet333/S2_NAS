# Local embedding model

## รุ่นที่เลือก

- Model: `Xenova/paraphrase-multilingual-MiniLM-L12-v2` (ONNX conversion ของ
  `sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2`)
- License: Apache-2.0 (model); `@huggingface/transformers` runtime ใช้ Apache-2.0
- Languages: model card ระบุ 50+ ภาษา ฝึกจากคู่ประโยคที่แปลข้ามภาษากัน
- Dimensions: 384; maximum model context 512 tokens (มิติเท่าเดิม จึงไม่ต้องย้าย schema)
- Runtime: Transformers.js + ONNX Runtime Node, CPU, `q8`
- ขนาด provision จริงบนเครื่อง: ~470 MB (โมเดล q8 + tokenizer)

โมเดลนี้เป็นแบบ **สมมาตร** จึงไม่ใส่คำนำหน้าใด ๆ ก่อนเข้าโมเดล
(`SEMANTIC_PROMPT_CONVENTION = 'none'`) ใช้ mean pooling + L2 normalization และ cosine distance
ห้ามเทียบ vectors คนละ `modelVersion`

## ทำไมถึงเปลี่ยนจาก multilingual-e5-small

live QA พบว่า E5 จัดอันดับข้ามภาษาผิดบนเอกสารธุรกิจที่หัวข้อใกล้กัน คำค้นภาษาอังกฤษ
ไปเจอเอกสารภาษาอังกฤษที่ "คนละเรื่อง" ก่อนเอกสารภาษาไทยที่ตรงเรื่อง

วัดด้วยคลังประเมิน 12 เอกสาร / 19 คำค้น (ไทย+อังกฤษ พร้อมตัวลวงหัวข้อใกล้เคียง):

| โมเดล | มิติ | R@1 รวม | th→th | en→en | th→en | en→th |
|---|---|---|---|---|---|---|
| multilingual-e5-small q8 | 384 | 0.526 | 1.00 | 1.00 | 0.00 | 0.29 |
| multilingual-e5-small fp32 | 384 | 0.526 | 1.00 | 1.00 | 0.00 | 0.29 |
| multilingual-e5-base q8 | 768 | 0.474 | 1.00 | 1.00 | 0.00 | 0.14 |
| paraphrase-multilingual-mpnet-base-v2 q8 | 768 | 0.947 | 1.00 | 1.00 | 1.00 | 0.86 |
| **paraphrase-multilingual-MiniLM-L12-v2 q8** | **384** | **1.000** | **1.00** | **1.00** | **1.00** | **1.00** |

fp32 ให้ผลเท่ากับ q8 จึงยืนยันว่าไม่ใช่ปัญหาจากการ quantize แต่เป็นการจัดวาง
เวกเตอร์ข้ามภาษาของตระกูล E5 เอง และการขยายขนาดภายในตระกูลเดิมก็ไม่ช่วย

เลือกตัวที่ชนะทั้งคุณภาพและต้นทุน: มิติเท่าเดิม (ไม่ต้อง migrate vector) และ
throughput สูงกว่ารุ่น 768 มิติราวสองเท่า

## เกณฑ์ความเกี่ยวข้อง

`S2_NAS_SEMANTIC_MIN_SCORE` = **0.40** (cosine) วัดจากคลังจริง:

| | คะแนนสูงสุดของคำค้น |
|---|---|
| คำค้นที่ควรเจอ (19 ข้อ) | ต่ำสุด 0.4887 · มัธยฐาน 0.6944 |
| คำค้นที่ไม่ควรเจออะไรเลย (5 ข้อ) | สูงสุด 0.3055 · มัธยฐาน 0.0912 |

0.40 อยู่กึ่งกลางช่องว่าง เหลือกันชนราว 0.09 ทั้งสองด้าน ใช้เกณฑ์สัมบูรณ์อย่างเดียว
ไม่ใช้กฎ "คะแนนตกจากอันดับหนึ่ง" เพราะระยะห่างอันดับ 1–2 ของคำค้นที่ควรเจอต่ำสุด 0.0298
ซึ่งทับกับของคำค้นที่ไม่ควรเจอ (สูงสุด ~0.0155)

ค่านี้ผูกกับโมเดล เปลี่ยนโมเดลเมื่อไรต้องวัดใหม่เสมอ

## ติดตั้งและเปิดใช้

```powershell
cd backend
npm run semantic:model-install
```

คำสั่งนี้เป็นจุดเดียวที่อนุญาต network เพื่อ provision โมเดลไปยัง
`S2_NAS_EMBEDDING_MODEL_PATH` (default `./models/semantic/paraphrase-multilingual-minilm-l12-v2`)
weights ถูก ignore จาก Git จากนั้นตั้ง `S2_NAS_SEMANTIC_ENABLED=1` และ restart backend

Runtime ตั้ง `allowRemoteModels=false`, `local_files_only=true` และอ่านจาก cache path ที่กำหนดเท่านั้น
โมเดลหายหรือเสียทำให้ health เป็น `NOT_CONFIGURED`/`ERROR` แต่ backend ยังเริ่มและค้นแบบ lexical ได้

## ลำดับความสำคัญของการอนุมาน

โมเดลตัวเดียวถูกใช้ร่วมกัน การอนุมานจึงรันทีละงานผ่านคิวที่จัดลำดับ:
`INTERACTIVE` (คำค้นของผู้ใช้) > `FOREGROUND` > `BACKGROUND` (การทำดัชนี)

งานที่กำลังรันอยู่จะไม่ถูกตัดกลางคัน คำค้นจึงรออย่างมาก "หนึ่งแบตช์"
`S2_NAS_SEMANTIC_EMBED_BATCH` (default 4) จึงเป็นตัวกำหนดช่วงรอที่แย่ที่สุดโดยตรง
และ `S2_NAS_SEMANTIC_QUEUE_LIMIT` (default 64) กันคิวโตไม่จำกัด

วัดบนเครื่องจริงระหว่างไล่ทำดัชนีค้าง: แบตช์ 8 → คำค้น p95 ~2.6 วินาที, แบตช์ 4 → p95 ~1.2 วินาที
ขณะที่ระบบว่าง คำค้นใช้เวลา p50 ~19 มิลลิวินาที

## Operator commands

```powershell
npm run semantic:status
npm run semantic:reindex
npm run semantic:retry-failed
npm run semantic:run
```

เมื่อเปลี่ยน model/revision/dtype/prompt convention/pooling ให้เปลี่ยน `SEMANTIC_MODEL_VERSION`,
provision รุ่นใหม่, restart และสั่ง reindex — vectors เป็นข้อมูลอนุพันธ์ คิวรีกรองด้วย `modelVersion`
อยู่แล้ว ของเก่าจึงหายจากผลค้นหาทันทีโดยไม่ต้องลบ และ `enqueueSemanticIndex` จะสร้างใหม่ให้เอง
ระหว่าง rebuild ระบบยังใช้ lexical search ได้ตามปกติ
