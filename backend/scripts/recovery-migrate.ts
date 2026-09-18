import fsp from 'node:fs/promises';
import path from 'node:path';
import { prisma } from '../src/core/prisma.js';
import { copyVerifiedRecovery, loadLocalRecoveryIndex } from '../src/modules/storage/recovery-readiness.js';

const value = (flag: string): string | undefined => {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
};
const has = (flag: string): boolean => process.argv.includes(flag);
const source = value('--source');
const target = value('--target');
const execute = has('--execute');
const explicitDryRun = has('--dry-run');
const dryRun = !execute;
const usage = `Usage:\n  npm run recovery:migrate -- --source <verified-root> --target <candidate-root> [--dry-run] [--report <new-file>]\n  npm run recovery:migrate -- --source <verified-root> --target <candidate-root> --execute --confirm-verified-copy [--report <new-file>]\n\nDry-run is the default. The tool never changes env, DB rows, or deletes source.\n`;

if (has('--help')) { console.log(usage); process.exit(0); }
if (!source || !target || (execute && explicitDryRun)) { console.error(usage); process.exit(2); }
if (execute && !has('--confirm-verified-copy')) {
  console.error('Execute requires --confirm-verified-copy. The tool never changes env, DB rows, or deletes source.');
  process.exit(2);
}

const index = await loadLocalRecoveryIndex();
const report = await copyVerifiedRecovery(source, target, index, dryRun);
const json = JSON.stringify({ generatedAt: new Date().toISOString(), expectedObjects: index.length,
  expectedBytes: index.reduce((sum, item) => sum + item.size, 0), ...report }, null, 2) + '\n';
const output = value('--report');
if (output) {
  const reportPath = path.resolve(output);
  await fsp.mkdir(path.dirname(reportPath), { recursive: true });
  await fsp.writeFile(reportPath, json, { flag: 'wx' });
} else process.stdout.write(json);
await prisma.$disconnect();
process.exit(dryRun ? (report.sourceAudit.authoritative ? 0 : 1) : (report.readyForConfigSwitch ? 0 : 1));
