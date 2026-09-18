import fsp from 'node:fs/promises';
import path from 'node:path';
import { prisma } from '../src/core/prisma.js';
import { loadLocalRecoveryIndex } from '../src/modules/storage/recovery-readiness.js';

const value = (flag: string): string | undefined => {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
};
const has = (flag: string): boolean => process.argv.includes(flag);
const usage = `Usage: npm run recovery:index -- [--json|--csv] [--output <path>]\n`;

if (has('--help')) { console.log(usage); process.exit(0); }
if (has('--json') && has('--csv')) { console.error('Choose --json or --csv, not both.'); process.exit(2); }

const entries = await loadLocalRecoveryIndex();
const csv = has('--csv');
const escape = (input: string | number): string => `"${String(input).replaceAll('"', '""')}"`;
const body = csv
  ? [
      ['resourceVersionId', 'resourceId', 'storageKey', 'size', 'sha256', 'createdAt'].join(','),
      ...entries.map((item) => [item.resourceVersionId, item.resourceId, item.storageKey,
        item.size, item.sha256, item.createdAt].map(escape).join(',')),
    ].join('\n') + '\n'
  : JSON.stringify({ generatedAt: new Date().toISOString(), storageProvider: 'LOCAL',
      objectCount: entries.length, totalBytes: entries.reduce((sum, item) => sum + item.size, 0), entries }, null, 2) + '\n';

const output = value('--output');
if (output) {
  const target = path.resolve(output);
  await fsp.mkdir(path.dirname(target), { recursive: true });
  await fsp.writeFile(target, body, { flag: 'wx' });
  console.error(`[RECOVERY INDEX] wrote ${entries.length} LOCAL rows to ${target}`);
} else {
  process.stdout.write(body);
}
await prisma.$disconnect();
