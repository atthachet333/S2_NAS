import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/**
 * รันชุดทดสอบการจัดเก็บอัจฉริยะโดยเปิดสวิตช์ให้เฉพาะโปรเซสลูก (F22)
 *
 * ไม่แตะไฟล์ .env เพราะการเปิดความสามารถค้างไว้หลังทดสอบเสร็จ
 * คือการเปลี่ยนพฤติกรรมของระบบจริงโดยไม่ได้ตั้งใจ
 */
const child = spawn(process.execPath, [
  fileURLToPath(new URL('../node_modules/tsx/dist/cli.mjs', import.meta.url)),
  '--test', '--test-concurrency=1',
  'src/modules/filing/filing.service.test.ts',
  'src/modules/filing/llm-assist.test.ts',
], { stdio: 'inherit', env: { ...process.env, S2_NAS_SMART_FILING_ENABLED: '1', S2_NAS_SMART_FILING_LLM_ENABLED: '1' } });
child.on('exit', (code) => process.exit(code ?? 1));
