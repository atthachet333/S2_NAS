# F21 final report — AI Document Assistant

วันที่ตรวจ: 9 กันยายน 2026  
Baseline: `3812c40bac96bb22c13b6090676978118e8da559` (F20)  
Release state: **implemented, feature-flagged off, not accepted as COMPLETE**

1. **Generative models evaluated:** Qwen3-4B-Instruct Q4_K_M และ Qwen2.5-3B-Instruct Q4_K_M จาก official Qwen GGUF repositories ทดสอบจริงผ่าน llama.cpp CPU runtime ใช้ prompt/evidence cases เดียวกัน Phi-4-mini ถูกสำรวจแต่ตัดออกเพราะไม่มี official GGUF artifact สำหรับ bake-off นี้
2. **Final model selected:** Qwen3-4B-Instruct เพราะรักษาค่าจากหลักฐานไทยและข้ามภาษาได้ดีกว่า Qwen2.5-3B แม้ช้ากว่า
3. **Model license:** Qwen3-4B official repository ระบุ Apache-2.0; Qwen2.5-3B candidate ใช้ Qwen Research license
4. **Model size:** รุ่นที่เลือก 2,497,280,256 bytes; candidate 2,104,932,768 bytes
5. **Quantization:** Q4_K_M ทั้งสองรุ่น SHA-256 ของรุ่นที่เลือกคือ `7485fe6f11af29433bc51cab58009521f205840f5b4ae3a32fa7f92e8534fdf5`
6. **Context window:** โมเดลรองรับมากกว่าที่ระบบใช้; F21 จำกัด runtime ที่ 8,192 tokens และ output 768 tokens
7. **RAM:** เครื่องมี RAM 31.7 GB แต่ยังไม่ได้เก็บ peak working-set ของ cold/warm generation จึงยังไม่ผ่าน resource acceptance
8. **Cold load:** ยังไม่ได้แยกวัด cold model-load time อย่างน่าเชื่อถือ
9. **Tokens/sec:** Qwen3 prompt 54–58 tok/s และ generation 8–10 tok/s; Qwen2.5 prompt 74–76 tok/s และ generation 11–13 tok/s ในชุด bake-off
10. **Runtime/provider architecture:** official llama.cpp Windows CPU build `b10868`; backend spawn `llama-cli` โดยตรงแบบ no-shell พร้อม timeout/abort และ strict parser
11. **Offline proof:** generation เรียก local executable/model path เท่านั้น ไม่มี HTTP client หรือ cloud provider ใน generation path; installer เป็น operator actionแยกจาก startup
12. **Provider abstraction:** `DocumentAssistantProvider` แยก model info, health และ grounded generation; มี llama.cpp และ deterministic fake implementation
13. **RAG architecture:** authorize → retrieve current-version chunks → hybrid rank/diversify → bounded evidence aliases → local generation → citation validation → persist user-visible result
14. **Retrieval strategy:** reuse F20 semantic chunks และเพิ่ม Thai-aware lexical windows; รองรับ CURRENT, SELECTED และ LIBRARY scope
15. **Evidence selection:** สูงสุด 10 evidence, 3 chunks/resource; compare พยายามคงอย่างน้อยหนึ่งหลักฐานต่อ resource; summary sample ต้น/กลาง/ท้าย
16. **Context budget:** evidence text รวมสูงสุด 24,000 characters, history 6 messages, context 8,192 tokens การนับก่อน provider เป็น conservative estimate
17. **Citation architecture:** citation เก็บ resourceId, resourceVersionId, evidenceId, offsets, text source และ bounded snippet โดยไม่เผย storage path
18. **Citation validation:** server ยอมรับเฉพาะ evidence aliases ที่ส่งเข้า model; invented/empty citations ถูกปฏิเสธก่อน persist
19. **No-evidence handling:** retrieval ที่ว่างตอบ `ไม่พบข้อมูลนี้ในเอกสารที่คุณมีสิทธิ์เข้าถึง` และศูนย์ citations โดยไม่เรียก model; exact identifier gate ป้องกัน amount/date อื่นถูกใช้แทนเลขบัญชี/เลขผู้เสียภาษี
20. **Prompt injection defense:** evidence ถูกประกาศเป็น untrusted data, ไม่มี tools, ห้ามทำตามคำสั่งในเอกสาร และ validate output ซ้ำ; automated และ real-model injection smoke ผ่าน
21. **One-document Q&A:** CURRENT scope และปุ่มจาก Details drawer ถูก implement; automated authorized-current-evidence case ผ่าน
22. **Multi-document Q&A:** SELECTED scope สูงสุด 20 resources, re-authorize ทุกข้อ; UI multi-select มี “ถาม AI”
23. **Library Q&A:** LIBRARY scope ค้นเฉพาะ resources ที่ caller อ่านได้; ยังไม่มี large-library real-model acceptance run
24. **Summarization:** quick prompt และ retrieval sampling ต้น/กลาง/ท้ายใช้งานได้ แต่ยังเป็น hierarchical precursor ไม่ใช่ full multi-pass long-document summarizer
25. **Extraction:** grounded free-text key-fact extraction ใช้ pipeline เดียวกัน; ไม่มี autonomous/legal/accounting decision และยังไม่มี dedicated structured form schema
26. **Comparison:** selected scope ใส่ document labels และ diversity ต่อ resource; ยังไม่มี conflict-detection evaluation corpus ครบ
27. **Follow-up conversation:** ส่ง history ที่ bounded 6 messages และ re-authorize scope ทุก turn
28. **Thread persistence:** normalized thread/message/citation tables; เก็บเฉพาะข้อความที่ผู้ใช้เห็น ไม่เก็บ retrieved context/system prompt
29. **Thread authorization:** thread เป็นของ user เดียว; cross-user read ถูกปฏิเสธใน test
30. **Access-revocation behavior:** follow-up ประเมินสิทธิ์ใหม่; automated revocation test ผ่าน
31. **Current-version behavior:** retrieval/citation ใช้ current ResourceVersion เท่านั้นและต้องมี READY index
32. **OCR/HUMAN_CORRECTED behavior:** reuse effective-text priority `HUMAN_CORRECTED > OCR > NATIVE_TEXT`; citation เก็บ source จริง ยังไม่มี real-model OCR confidence corpus run แยก
33. **Google Drive behavior:** ใช้ resource/version/index หลัง import/sync เท่านั้น ไม่มี Google API ระหว่าง Q&A; dedicated sync-change assistant QA ยังไม่ครบ
34. **Portal decision:** F21 internal-only; Client Portal คง lexical และไม่มี assistant
35. **Public-share isolation:** routes อยู่ internal API เท่านั้น; regression route isolation ผ่าน ไม่มี guest generative endpoint
36. **Thai real-model QA:** Qwen3 ตอบกำหนดส่ง `30 กันยายน 2569` ตรงหลักฐานและอ้าง E1
37. **English real-model QA:** Qwen3 ตอบอังกฤษจากหลักฐานและรักษาค่า `30 September 2569`
38. **Cross-language QA:** Qwen3 ผ่าน; Qwen2.5 แปลง พ.ศ. 2569 เป็น 2027 ผิด จึงไม่ถูกเลือก
39. **Hallucination QA:** raw Qwen3 no-evidence adversarial case ตอบจำนวนเงินเป็นเลขบัญชีผิด แต่ full application gate หยุดก่อน generation และ automated test ผ่าน จุดอ่อน raw modelนี้เป็นเหตุผลให้ยังไม่ประกาศ complete
40. **Prompt-injection QA:** real Qwen3 smoke ไม่ทำตาม malicious E2 และอ้างเฉพาะ E1; automated prompt contract test ผ่าน
41. **Citation-accuracy QA:** real smoke citation E1 ถูก; validator tests ครอบคลุม invented alias แต่ยังไม่มี corpus-wide precision score
42. **CPU contention:** ยังไม่ได้วัดผลกระทบต่อ F20/login/upload/OCR ระหว่าง sustained generation จึงยังไม่ผ่าน acceptance
43. **Retrieval latency:** focused end-to-end fake-provider evidence testประมาณ 1.16 s แต่ยังไม่ได้แยก retrieval p50/p95 บน 500-document corpus
44. **First-token latency:** non-streaming F21 ไม่ expose first token และยังไม่ได้เก็บ llama.cpp first-token metric แยก
45. **Generation latency:** Qwen3 bake-off 12.9–13.3 s/case; real smoke ประมาณ 10.8 s; Qwen2.5 9.0–10.9 s/case
46. **Tokens/sec:** เหมือนข้อ 9; selected Qwen3 วัด prompt 54–58 tok/s และ generation 8–10 tok/s
47. **Assistant queue:** global concurrency 1, queue limit 5, timeout 180 s; health แสดง active/queued; queue-full fail closed
48. **Admin UI:** แสดง enabled/installed/status/model/quantization/context/local/queue โดยไม่เผย model path
49. **User UX:** responsive assistant panel, three scopes, search-result/selected-file/detail entry points, selected chips, quick prompts, private thread history/delete, plain-text answer, copy, citations และ Thai states
50. **Browser QA:** authenticated live browser ตรวจ selected-file action, panel, scope, disabled-state, disabled submit และ empty private-history surface ผ่าน แต่ยังไม่ได้ run enabled real-answer/citation-click flow เพราะ feature flag คง off
51. **Responsive QA:** live viewport 390×844 แสดง full-screen assistant และ 1440×900 แสดง 440 px right-side panel ได้ถูกต้อง
52. **Theme QA:** live visual QA ของ panel ผ่านทั้ง dark และ light themes; high-contrast/system variants และ enabled-answer content ยังไม่ได้ตรวจครบ
53. **Security/privacy:** authorization-before-text, local inference, no tools/writes, no secret/path fields, bounded persistence และ plain-text rendering ถูก implement/test
54. **Audit:** events ครอบคลุม thread-created, answer-generated และ generation-failed ตาม brief; metadata มีเฉพาะ scope/count/timing/status/error code ไม่บันทึก question/answer/evidence body การลบ thread ไม่สร้าง audit event เพิ่ม
55. **Backup/restore:** verified pre-migration backup `cmtthuu2g0001wqis8z731chn` มี 1,750 files, DB dump 82.7 MB, รวมประมาณ 1.3 GB; post-migration backup/restore rehearsal ของ F21 tables ยังไม่ทำ
56. **Backend default tests:** full regression หลัง route integrationผ่าน 856 tests, 176 suites, 0 failure, 0 skipped, durationประมาณ 10m57s
57. **Backend assistant-enabled tests:** focused F21 suite rerun หลัง parser cleanup ผ่าน 9 tests, 2 suites, 0 failure/skip; real provider smoke ผ่าน แต่ยังไม่ใช่ full suite ที่เปิด real model ทุก test
58. **Frontend tests:** 302 tests, 0 failure, 0 skipped
59. **Typecheck:** root backend + frontend typecheck ผ่านหลัง final parser cleanup
60. **Builds:** backend TypeScript build และ frontend Vite production build ผ่าน; มี Vite chunk-size warning เดิม
61. **Migration:** `20260909120000_phase_f21_document_assistant` deploy ผ่าน; database reports 22 migrations and up to date
62. **Drift:** ไม่มี F21 drift; known F20 MariaDB HNSW vector index เป็น drift ที่ Prisma schema express ไม่ได้และ smoke checkerระบุไว้
63. **Empty-DB replay:** ผ่านโดยใช้ migration smoke; F20 vector index exception ถูกตรวจแบบ explicit
64. **Cleanup:** disposable F15 browser fixture ถูกลบครบ (ผู้ใช้ 1, resources 5); model/runtime/candidate weights gitignored; assistant ยัง `S2_NAS_ASSISTANT_ENABLED=0`; ไม่มี deploy, file move, F22 work หรือ commit
65. **Known limitations:** full long-document hierarchy, structured extraction schema, cache/invalidation, regenerate/stop/export/feedback, peak RAM/cold-load/CPU contention, large-library metrics, post-migration restore, high-contrast และ enabled real-answer browser flow ยังไม่ครบ
66. **Exact uncommitted files:** ดูรายการ canonical จาก `git status --short` ด้านล่าง; model weights/runtime ถูก ignore โดยตั้งใจและมีเพียง `.gitkeep` ใน Git
67. **Whether F21 is COMPLETE:** **ไม่ COMPLETE** ตามเกณฑ์ข้อ 160 เพราะข้อ 7–8, 24–25, 33, 39, 41–44, 50, 52, 55 และ 65 ยังมี acceptance gaps Feature flag ต้องคง off
68. **Recommended F22 boundary:** หยุดที่ F21 จน acceptance gaps ปิดทั้งหมด F22 ภายหลังควรรับเฉพาะ assistant-produced suggestions ที่มี evidence และ explicit human confirmation; ห้าม auto-move/auto-folder/autonomous filing ในงานนี้

## Exact uncommitted files (`git status --short`)

```text
 M .gitignore
 M backend/package.json
 M backend/prisma/schema.prisma
 M backend/src/app.ts
 M backend/src/config/env.ts
 M backend/src/modules/audit/event-catalog.ts
 M backend/src/modules/health/health.routes.ts
 M backend/src/modules/semantic/vector-search.ts
 M backend/src/server.ts
 M docs/BACKUP.md
 M docs/CLIENT_PORTAL.md
 M docs/DISASTER_RECOVERY.md
 M docs/GOOGLE_DRIVE_INTEGRATION.md
 M docs/RESOURCE_MODEL.md
 M docs/RESTORE.md
 M docs/SECURITY.md
 M docs/SEMANTIC_INDEXING.md
 M docs/SEMANTIC_SEARCH.md
 M frontend/src/components/files/DetailsDrawer.tsx
 M frontend/src/components/layout/AppShell.tsx
 M frontend/src/lib/api.ts
 M frontend/src/pages/FilesPage.tsx
 M frontend/src/pages/SearchPage.tsx
 M frontend/src/pages/admin/AdminSettingsPage.tsx
 M package.json
?? backend/models/assistant/.gitkeep
?? backend/prisma/migrations/20260909120000_phase_f21_document_assistant/migration.sql
?? backend/scripts/assistant-cli.ts
?? backend/src/modules/assistant/assistant.routes.ts
?? backend/src/modules/assistant/assistant.service.ts
?? backend/src/modules/assistant/assistant.test.ts
?? backend/src/modules/assistant/f21.test.ts
?? backend/src/modules/assistant/fake.provider.ts
?? backend/src/modules/assistant/generation-queue.ts
?? backend/src/modules/assistant/llama-cpp.provider.ts
?? backend/src/modules/assistant/provider-instance.ts
?? backend/src/modules/assistant/provider.ts
?? backend/src/modules/assistant/rag.service.ts
?? docs/DOCUMENT_ASSISTANT.md
?? docs/DOCUMENT_ASSISTANT_MODEL.md
?? docs/DOCUMENT_ASSISTANT_RAG.md
?? docs/DOCUMENT_ASSISTANT_SECURITY.md
?? docs/F21_FINAL_REPORT.md
?? frontend/src/components/assistant/AssistantPanel.tsx
```

## Operator commands

```powershell
npm run assistant:status
npm run assistant:model:install
npm run assistant:test
npm run assistant:bakeoff
```

หลัง acceptance ครบจึงตั้ง `S2_NAS_ASSISTANT_ENABLED=1` และ restart backend Business backup ไม่รวม model weights; หลัง restore ต้อง provision runtime/model ใหม่และตรวจ SHA-256
