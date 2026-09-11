import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/**
 * รันชุดทดสอบผู้ช่วยเอกสารกับโมเดลจริง (F21 ข้อ 22)
 *
 * ตั้งค่าเปิดใช้งานให้เฉพาะโปรเซสลูกเท่านั้น ไม่แตะไฟล์ .env เพราะการเปิดผู้ช่วยค้างไว้
 * ในสภาพแวดล้อมจริงหลังทดสอบเสร็จ คือการเปลี่ยนพฤติกรรมระบบโดยไม่ได้ตั้งใจ
 *
 * ใช้ไฟล์เทสต์เดียวโดยตั้งใจ ชุดนี้เรียกโมเดลจริงหลายครั้งและใช้เวลาเป็นนาที
 * จึงไม่ควรถูกลากไปรวมกับชุดปกติ
 */
// --longdoc รันเกณฑ์วัดเอกสารยาวแทนชุดเทสต์ โดยใช้กลไกเปิดใช้งานชั่วคราวตัวเดียวกัน
const longdoc = process.argv.includes('--longdoc');
const acceptance = process.argv.includes('--acceptance');
const contention = process.argv.includes('--contention');
const target = contention
  ? ['scripts/f21-contention.ts']
  : acceptance
  ? ['scripts/f21-acceptance.ts']
  : longdoc
  ? ['scripts/f21-longdoc.ts']
  : ['--test', '--test-concurrency=1', 'src/modules/assistant/f21.realmodel.test.ts'];

const child = spawn(process.execPath, [
  fileURLToPath(new URL('../node_modules/tsx/dist/cli.mjs', import.meta.url)),
  ...target,
], {
  stdio: 'inherit',
  env: { ...process.env, S2_NAS_ASSISTANT_ENABLED: '1', S2_NAS_ASSISTANT_PROVIDER: 'LLAMA_CPP' },
});
child.on('exit', (code) => process.exit(code ?? 1));
