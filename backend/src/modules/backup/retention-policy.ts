/**
 * นโยบายเก็บชุดสำรองในเครื่อง
 *
 * ฟังก์ชันบริสุทธิ์ล้วน - รับรายการเข้ามาแล้วบอกว่าลบตัวไหนได้บ้าง
 * ไม่แตะดิสก์และไม่แตะฐานข้อมูล จึงพิสูจน์กติกาที่อันตรายที่สุดได้โดยไม่ต้องลบของจริง
 */

export interface RetentionCandidate {
  id: string;
  status: 'PENDING' | 'RUNNING' | 'COMPLETED' | 'FAILED';
  startedAt: Date;
}

export interface RetentionPolicy {
  retentionDays: number;
  minimumKeepCount: number;
}

export interface RetentionPlan {
  deletable: string[];
  keptForMinimum: number;
  eligibleCount: number;
}

/**
 * ตัดสินว่าชุดสำรองใดลบได้
 *
 * กติกาที่ห้ามผิดพลาด เรียงตามความสำคัญ:
 *   1. ลบได้เฉพาะชุดที่ COMPLETED - งานที่ยังทำอยู่หรือชุดที่ล้มเหลวไม่ใช่เป้าหมายของนโยบายนี้
 *   2. ต้องเหลือชุดที่ใช้ได้อย่างน้อยตามจำนวนขั้นต่ำเสมอ แม้ทุกชุดจะเก่ากว่ากำหนดแล้ว
 *   3. ต้องไม่ลบชุดที่ใช้ได้ชุดสุดท้ายเด็ดขาด ต่อให้ตั้งค่าขั้นต่ำเป็นศูนย์ก็ตาม
 *   4. ลบชุดเก่าที่สุดก่อน
 *
 * ข้อ 3 เป็นด่านสุดท้าย: การตั้งค่าผิดพลาดต้องไม่นำไปสู่ระบบที่ไม่มีชุดสำรองเหลือเลย
 */
export function planRetention(
  backups: RetentionCandidate[],
  policy: RetentionPolicy,
  now: Date,
): RetentionPlan {
  const cutoff = now.getTime() - policy.retentionDays * 24 * 60 * 60 * 1000;

  // เก่า → ใหม่ เพื่อให้ลบตัวเก่าที่สุดก่อนเสมอ
  const completed = backups
    .filter((backup) => backup.status === 'COMPLETED')
    .sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime());

  const expired = completed.filter((backup) => backup.startedAt.getTime() < cutoff);

  /**
   * จำนวนที่ลบได้จริง = จำนวนที่หมดอายุ แต่ต้องไม่ทำให้ชุดที่เหลือน้อยกว่าขั้นต่ำ
   * และไม่ว่ากรณีใดต้องเหลืออย่างน้อยหนึ่งชุดเสมอ
   */
  const floor = Math.max(policy.minimumKeepCount, 1);
  const maxDeletable = Math.max(0, completed.length - floor);
  const deletable = expired.slice(0, maxDeletable).map((backup) => backup.id);

  return {
    deletable,
    keptForMinimum: expired.length - deletable.length,
    eligibleCount: expired.length,
  };
}
