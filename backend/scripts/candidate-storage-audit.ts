import fsp from 'node:fs/promises';
import path from 'node:path';
import { prisma } from '../src/core/prisma.js';
import { auditCandidateRoot, loadLocalRecoveryIndex } from '../src/modules/storage/recovery-readiness.js';

const value = (flag: string): string | undefined => {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
};
const root = value('--root');
if (!root || process.argv.includes('--help')) {
  console.log('Usage: npm run recovery:audit -- --root <candidate-storage-root> [--no-checksum] [--report <new-file>]');
  process.exit(root ? 0 : 2);
}

const index = await loadLocalRecoveryIndex();
const report = await auditCandidateRoot(root, index, {
  checksum: !process.argv.includes('--no-checksum'), extras: true,
});
const json = JSON.stringify({ generatedAt: new Date().toISOString(), ...report }, null, 2) + '\n';
const output = value('--report');
if (output) {
  const target = path.resolve(output);
  await fsp.mkdir(path.dirname(target), { recursive: true });
  await fsp.writeFile(target, json, { flag: 'wx' });
} else process.stdout.write(json);
await prisma.$disconnect();
process.exit(report.authoritative ? 0 : 1);
