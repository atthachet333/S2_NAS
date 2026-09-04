/**
 * การอัปโหลดทั้งโฟลเดอร์
 *
 * เบราว์เซอร์ให้ไฟล์มาพร้อม webkitRelativePath เช่น "Company Assets/Logos/logo.png"
 * หน้าที่ของโมดูลนี้คือแปลงเส้นทางเหล่านั้นเป็นโครงสร้างโฟลเดอร์ที่ปลอดภัย
 *
 * ทุกอย่างที่นี่เป็นฟังก์ชันบริสุทธิ์ เพราะเส้นทางที่มาจากเครื่องผู้ใช้คืออินพุตที่ไม่น่าไว้ใจ
 * และต้องพิสูจน์ได้ว่ากันการหลุดออกนอกปลายทางได้จริงโดยไม่ต้องอัปโหลดของจริง
 */

/** ชื่อสงวนของ Windows - ใช้เป็นชื่อโฟลเดอร์หรือไฟล์ไม่ได้ */
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu;

/**
 * ชื่อหนึ่งส่วนของเส้นทางใช้ได้หรือไม่
 *
 * กติกาเดียวกับ validateResourceName ของ backend เพื่อไม่ให้หน้าจอยอมรับสิ่งที่เซิร์ฟเวอร์จะปฏิเสธ
 * รองรับชื่อภาษาไทยและ Unicode อื่นเต็มที่ - ตัดเฉพาะสิ่งที่อันตรายจริง
 */
export function isSafeSegment(segment: string): boolean {
  const name = segment.trim();
  if (!name || name === '.' || name === '..') return false;
  if (name.length > 191) return false;
  if (/[\\/]/u.test(name)) return false;
  // อักขระควบคุมและอักขระจัดรูปแบบมองไม่เห็น แต่ทำให้ชื่อไฟล์กำกวมได้
  if (/[\p{Cc}\p{Cf}]/u.test(name)) return false;
  if (RESERVED.test(name)) return false;
  return true;
}

export interface PlannedFile {
  file: File;
  /** ส่วนของโฟลเดอร์ที่ต้องมีก่อน ไม่รวมชื่อไฟล์ */
  directory: string[];
}

export interface FolderUploadPlan {
  /** ทุกโฟลเดอร์ที่ต้องสร้าง เรียงจากตื้นไปลึก เพื่อให้สร้างแม่ก่อนลูกเสมอ */
  directories: string[][];
  files: PlannedFile[];
  /** ไฟล์ที่ถูกปฏิเสธพร้อมเหตุผล - ต้องรายงาน ไม่ใช่ทิ้งเงียบ ๆ */
  rejected: Array<{ path: string; reason: string }>;
  rootName: string | null;
}

/** เส้นทางสัมพัทธ์ของไฟล์ที่เบราว์เซอร์ให้มา (ถ้าไม่มีถือว่าเป็นไฟล์เดี่ยว) */
export function relativePathOf(file: File): string {
  const value = (file as File & { webkitRelativePath?: string }).webkitRelativePath;
  return value && value.length > 0 ? value : file.name;
}

/**
 * วางแผนการอัปโหลดจากรายการไฟล์ที่เลือก
 *
 * ปฏิเสธทั้งไฟล์เมื่อมีส่วนใดของเส้นทางไม่ปลอดภัย ไม่พยายาม "ซ่อม" ชื่อให้
 * การเดาชื่อแทนผู้ใช้ทำให้ไฟล์ไปโผล่ในที่ที่เขาไม่ได้ตั้งใจ ซึ่งแย่กว่าการบอกว่าทำไม่ได้
 */
export function planFolderUpload(files: File[]): FolderUploadPlan {
  const directories: string[][] = [];
  const seenDirectories = new Set<string>();
  const planned: PlannedFile[] = [];
  const rejected: Array<{ path: string; reason: string }> = [];
  let rootName: string | null = null;

  for (const file of files) {
    const relative = relativePathOf(file);

    // เส้นทางแบบ absolute ไม่มีทางมาจากการเลือกโฟลเดอร์ปกติ จึงปฏิเสธทันที
    if (/^[a-zA-Z]:/.test(relative) || relative.startsWith('/') || relative.startsWith('\\')) {
      rejected.push({ path: relative, reason: 'เส้นทางแบบเต็มไม่ได้รับอนุญาต' });
      continue;
    }

    const segments = relative.split('/').filter((segment) => segment !== '');
    const fileName = segments.pop();
    if (!fileName) {
      rejected.push({ path: relative, reason: 'ไม่พบชื่อไฟล์' });
      continue;
    }

    const unsafe = [...segments, fileName].find((segment) => !isSafeSegment(segment));
    if (unsafe !== undefined) {
      rejected.push({ path: relative, reason: `ชื่อไม่ถูกต้อง: ${unsafe}` });
      continue;
    }

    const directory = segments.map((segment) => segment.trim());
    if (directory.length > 0 && rootName === null) rootName = directory[0]!;

    // ลงทะเบียนทุกระดับของเส้นทาง เพื่อให้โฟลเดอร์แม่ถูกสร้างก่อนเสมอ
    for (let depth = 1; depth <= directory.length; depth += 1) {
      const branch = directory.slice(0, depth);
      const key = branch.join('/');
      if (seenDirectories.has(key)) continue;
      seenDirectories.add(key);
      directories.push(branch);
    }

    planned.push({ file, directory });
  }

  // ตื้นก่อนลึก - สร้างแม่ให้เสร็จก่อนลูกเสมอ
  directories.sort((a, b) => a.length - b.length || a.join('/').localeCompare(b.join('/')));

  return { directories, files: planned, rejected, rootName };
}

/** จัดกลุ่มไฟล์ตามโฟลเดอร์ปลายทาง เพื่อส่งเข้าคิวอัปโหลดทีละกลุ่ม */
export function groupByDirectory(files: PlannedFile[]): Map<string, File[]> {
  const groups = new Map<string, File[]>();
  for (const item of files) {
    const key = item.directory.join('/');
    const bucket = groups.get(key);
    if (bucket) bucket.push(item.file);
    else groups.set(key, [item.file]);
  }
  return groups;
}

/** ข้อความสรุปสำหรับผู้ใช้ - บอกจำนวนจริง ไม่ปัดเศษและไม่ซ่อนของที่ถูกปฏิเสธ */
export function describePlan(plan: FolderUploadPlan): string {
  const parts = [`${plan.files.length} ไฟล์`];
  if (plan.directories.length > 0) parts.push(`${plan.directories.length} โฟลเดอร์`);
  if (plan.rejected.length > 0) parts.push(`ข้าม ${plan.rejected.length} รายการที่ชื่อไม่ถูกต้อง`);
  return parts.join(' · ');
}
