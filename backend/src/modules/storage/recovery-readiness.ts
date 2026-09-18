import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { prisma } from '../../core/prisma.js';

export interface RecoveryIndexEntry {
  resourceVersionId: string;
  resourceId: string;
  storageKey: string;
  size: number;
  sha256: string;
  createdAt: string;
}

export type CandidateFindingKind =
  | 'UNSAFE_STORAGE_KEY'
  | 'MISSING'
  | 'SIZE_MISMATCH'
  | 'CHECKSUM_MISMATCH'
  | 'EXTRA_FILE'
  | 'DUPLICATE_CANDIDATE';

export interface CandidateFinding {
  kind: CandidateFindingKind;
  resourceVersionId?: string;
  storageKey?: string;
  detail?: string;
}

export interface CandidateAuditReport {
  root: string;
  readOnly: true;
  checksumVerified: boolean;
  expectedObjects: number;
  expectedBytes: number;
  candidateObjectsFound: number;
  exactStorageKeyMatches: number;
  sizeMatches: number;
  sha256Matches: number;
  missingObjects: number;
  checksumFailures: number;
  duplicateRecoveredCandidates: number;
  extraFiles: number;
  bytesRead: number;
  authoritative: boolean;
  findings: CandidateFinding[];
}

export interface VerifiedCopyReport {
  sourceRoot: string;
  targetRoot: string;
  dryRun: boolean;
  sourceAudit: CandidateAuditReport;
  targetAudit?: CandidateAuditReport;
  copiedObjects: number;
  reusedVerifiedObjects: number;
  copiedBytes: number;
  failedCopies: number;
  sourcePreserved: true;
  databaseModified: false;
  configurationModified: false;
  readyForConfigSwitch: boolean;
  failures: Array<{ storageKey: string; reason: string }>;
}

/** The recovery index is deliberately limited to non-secret validation fields. */
export async function loadLocalRecoveryIndex(): Promise<RecoveryIndexEntry[]> {
  const rows = await prisma.resourceVersion.findMany({
    where: { storageProvider: 'LOCAL' },
    select: { id: true, resourceId: true, storageKey: true, size: true, checksum: true, createdAt: true },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });
  return rows.map((row) => ({
    resourceVersionId: row.id,
    resourceId: row.resourceId,
    storageKey: row.storageKey,
    size: Number(row.size),
    sha256: row.checksum.toLowerCase(),
    createdAt: row.createdAt.toISOString(),
  }));
}

/** Resolve an opaque storage key without permitting absolute paths or traversal. */
export function candidatePath(root: string, storageKey: string): string {
  const normalizedKey = storageKey.replaceAll('\\', '/');
  if (!normalizedKey.startsWith('resources/') || path.posix.isAbsolute(normalizedKey)) {
    throw new Error('storageKey must be a relative resources/ key');
  }
  const normalized = path.posix.normalize(normalizedKey);
  if (normalized !== normalizedKey || normalized.split('/').includes('..')) {
    throw new Error('storageKey contains unsafe path segments');
  }
  const absoluteRoot = path.resolve(root);
  const target = path.resolve(absoluteRoot, ...normalized.split('/'));
  const relative = path.relative(absoluteRoot, target);
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('storageKey escapes candidate root');
  }
  return target;
}

async function measureFile(filePath: string): Promise<{ size: number; sha256: string }> {
  const hash = crypto.createHash('sha256');
  let size = 0;
  const stream = fs.createReadStream(filePath);
  for await (const chunk of stream) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    hash.update(buffer);
  }
  return { size, sha256: hash.digest('hex') };
}

async function listFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop()!;
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fsp.readdir(current, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    for (const entry of entries) {
      const child = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(child);
      else if (entry.isFile()) files.push(child);
    }
  }
  return files;
}

/**
 * Audit an arbitrary recovered/candidate root. This function only opens files for
 * reading and never creates, changes, renames, or removes filesystem entries.
 */
export async function auditCandidateRoot(
  root: string,
  index: RecoveryIndexEntry[],
  options: { checksum?: boolean; extras?: boolean } = {},
): Promise<CandidateAuditReport> {
  const checksum = options.checksum !== false;
  const report: CandidateAuditReport = {
    root: path.resolve(root), readOnly: true, checksumVerified: checksum,
    expectedObjects: index.length,
    expectedBytes: index.reduce((sum, item) => sum + item.size, 0),
    candidateObjectsFound: 0, exactStorageKeyMatches: 0, sizeMatches: 0, sha256Matches: 0,
    missingObjects: 0, checksumFailures: 0, duplicateRecoveredCandidates: 0,
    extraFiles: 0, bytesRead: 0, authoritative: false, findings: [],
  };

  const expectedKeys = new Set(index.map((item) => item.storageKey.replaceAll('\\', '/')));
  const expectedBasenames = new Map<string, number>();
  for (const item of index) {
    const name = path.posix.basename(item.storageKey.replaceAll('\\', '/'));
    expectedBasenames.set(name, (expectedBasenames.get(name) ?? 0) + 1);
  }
  const resourceRoot = path.join(report.root, 'resources');
  const allFiles = options.extras === false ? [] : await listFiles(resourceRoot);
  const byBasename = new Map<string, string[]>();
  for (const file of allFiles) {
    const name = path.basename(file);
    byBasename.set(name, [...(byBasename.get(name) ?? []), file]);
    const relative = path.relative(report.root, file).split(path.sep).join('/');
    if (!expectedKeys.has(relative)) {
      report.extraFiles += 1;
      report.findings.push({ kind: 'EXTRA_FILE', storageKey: relative });
    }
  }

  for (const [name, expectedCount] of expectedBasenames) {
    const recoveredCount = byBasename.get(name)?.length ?? 0;
    if (recoveredCount > expectedCount) {
      const duplicateCount = recoveredCount - expectedCount;
      report.duplicateRecoveredCandidates += duplicateCount;
      report.findings.push({ kind: 'DUPLICATE_CANDIDATE', storageKey: name,
        detail: `${duplicateCount} additional same-name candidate(s)` });
    }
  }

  for (const item of index) {
    let filePath: string;
    try {
      filePath = candidatePath(report.root, item.storageKey);
    } catch (error) {
      report.findings.push({ kind: 'UNSAFE_STORAGE_KEY', resourceVersionId: item.resourceVersionId,
        storageKey: item.storageKey, detail: (error as Error).message });
      report.missingObjects += 1;
      continue;
    }

    let stat: import('node:fs').Stats;
    try {
      stat = await fsp.stat(filePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      report.missingObjects += 1;
      report.findings.push({ kind: 'MISSING', resourceVersionId: item.resourceVersionId,
        storageKey: item.storageKey });
      continue;
    }
    if (!stat.isFile()) {
      report.missingObjects += 1;
      report.findings.push({ kind: 'MISSING', resourceVersionId: item.resourceVersionId,
        storageKey: item.storageKey, detail: 'candidate is not a regular file' });
      continue;
    }

    report.candidateObjectsFound += 1;
    report.exactStorageKeyMatches += 1;
    if (stat.size !== item.size) {
      report.findings.push({ kind: 'SIZE_MISMATCH', resourceVersionId: item.resourceVersionId,
        storageKey: item.storageKey, detail: `candidate=${stat.size} expected=${item.size}` });
      continue;
    }
    report.sizeMatches += 1;
    if (!checksum) continue;
    const measured = await measureFile(filePath);
    report.bytesRead += measured.size;
    if (measured.sha256 !== item.sha256) {
      report.checksumFailures += 1;
      report.findings.push({ kind: 'CHECKSUM_MISMATCH', resourceVersionId: item.resourceVersionId,
        storageKey: item.storageKey });
      continue;
    }
    report.sha256Matches += 1;
  }

  report.authoritative = checksum
    && report.expectedObjects > 0
    && report.missingObjects === 0
    && report.checksumFailures === 0
    && report.exactStorageKeyMatches === report.expectedObjects
    && report.sizeMatches === report.expectedObjects
    && report.sha256Matches === report.expectedObjects;
  return report;
}

/**
 * Copy only after every source object is checksum-authoritative. Existing target
 * objects are reused only when their size and checksum already match. Nothing is
 * overwritten and source data is never deleted.
 */
export async function copyVerifiedRecovery(
  sourceRoot: string,
  targetRoot: string,
  index: RecoveryIndexEntry[],
  dryRun: boolean,
): Promise<VerifiedCopyReport> {
  const source = path.resolve(sourceRoot);
  const target = path.resolve(targetRoot);
  if (source === target) throw new Error('source and target roots must differ');
  const nested = (parent: string, child: string): boolean => {
    const relative = path.relative(parent, child);
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
  };
  if (nested(source, target) || nested(target, source)) {
    throw new Error('source and target roots must not contain one another');
  }

  const sourceAudit = await auditCandidateRoot(source, index, { checksum: true, extras: true });
  const report: VerifiedCopyReport = {
    sourceRoot: source, targetRoot: target, dryRun, sourceAudit,
    copiedObjects: 0, reusedVerifiedObjects: 0, copiedBytes: 0, failedCopies: 0,
    sourcePreserved: true, databaseModified: false, configurationModified: false,
    readyForConfigSwitch: false, failures: [],
  };
  if (!sourceAudit.authoritative || sourceAudit.sha256Matches !== index.length) return report;
  if (dryRun) return report;

  for (const item of index) {
    const sourcePath = candidatePath(source, item.storageKey);
    const targetPath = candidatePath(target, item.storageKey);
    try {
      let existing: import('node:fs').Stats | null = null;
      try { existing = await fsp.stat(targetPath); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      if (existing) {
        const measured = await measureFile(targetPath);
        if (measured.size !== item.size || measured.sha256 !== item.sha256) {
          throw new Error('target exists but is not checksum-identical; refusing overwrite');
        }
        report.reusedVerifiedObjects += 1;
        continue;
      }

      await fsp.mkdir(path.dirname(targetPath), { recursive: true });
      await pipeline(fs.createReadStream(sourcePath), fs.createWriteStream(targetPath, { flags: 'wx' }));
      const measured = await measureFile(targetPath);
      if (measured.size !== item.size || measured.sha256 !== item.sha256) {
        throw new Error('post-copy verification failed');
      }
      report.copiedObjects += 1;
      report.copiedBytes += measured.size;
    } catch (error) {
      report.failedCopies += 1;
      report.failures.push({ storageKey: item.storageKey, reason: (error as Error).message });
    }
  }

  report.targetAudit = await auditCandidateRoot(target, index, { checksum: true, extras: true });
  report.readyForConfigSwitch = report.failedCopies === 0 && report.targetAudit.authoritative;
  return report;
}
