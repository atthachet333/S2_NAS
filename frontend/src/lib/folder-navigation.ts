import type { BreadcrumbNode } from './drive';

/**
 * ปลายทางของการขึ้นไปหนึ่งชั้น (F24-C)
 *
 * **แยกออกมาเป็นฟังก์ชันบริสุทธิ์** เพราะกรณีขอบของมันไม่ชัดเจนจากการอ่านโค้ดหน้าจอ:
 * อยู่ที่รากแล้วจะขึ้นไปไหน อยู่ลึกหนึ่งชั้นจะกลับไปที่รากหรือที่โฟลเดอร์แม่
 * และโฟลเดอร์แม่ที่ไม่มีรหัสหมายถึงอะไร ทั้งหมดนี้ทดสอบได้โดยไม่ต้องมีหน้าจอ
 */
export interface ParentDestination {
  /** เส้นทางที่ควรไปเมื่อกดย้อนกลับ */
  to: string;
  /** ชื่อของที่ที่จะไป ใช้บอกผู้ใช้ผ่านป้ายกำกับ */
  label: string;
  /** อยู่บนสุดแล้ว ไม่มีที่ให้ขึ้นไปอีก */
  atRoot: boolean;
}

export function parentDestination(
  nodes: readonly BreadcrumbNode[],
  rootTo: string,
  rootLabel = 'ระดับบนสุด',
): ParentDestination {
  // ไม่มีชั้นใดเลย แปลว่ากำลังอยู่ที่รากของไดร์ฟ
  if (nodes.length === 0) return { to: rootTo, label: rootLabel, atRoot: true };

  const parent = nodes[nodes.length - 2];
  if (!parent) return { to: rootTo, label: rootLabel, atRoot: false };

  /**
   * โฟลเดอร์แม่ที่ไม่มีรหัส คือรากของไดร์ฟที่ถูกใส่มาในเส้นทางเพื่อการแสดงผล
   * ไม่ใช่โฟลเดอร์จริงที่เปิดเข้าไปได้
   */
  return parent.id
    ? { to: `${rootTo}/${parent.id}`, label: parent.name, atRoot: false }
    : { to: rootTo, label: parent.name, atRoot: false };
}
