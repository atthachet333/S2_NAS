import { Prisma } from '@prisma/client';
import { prisma } from '../../core/prisma.js';
import { activeGrantMap, portalResourceSelect, type PortalResource } from './portal-access.js';
import { isPortalVisibleType, type PortalRole } from './portal-policy.js';
import { contentMatchResourceIds } from '../search/content-match.js';

/**
 * การค้นหาในพื้นที่ลูกค้า - ลึกได้ทุกชั้นใต้โฟลเดอร์ที่ได้รับสิทธิ์
 *
 * หลักการที่ตัดสินวิธีทำ:
 *
 *   1. เริ่มจาก "สิ่งที่เข้าถึงได้" ไม่ใช่ "ทุกอย่างแล้วค่อยกรอง"
 *      การค้นทั้งระบบแล้วกรองทีหลังคือรูปแบบที่พลาดครั้งเดียวก็รั่ว
 *      ที่นี่การไล่ลำดับชั้นเริ่มที่รากที่ได้รับสิทธิ์เสมอ ผลลัพธ์ที่เข้าถึงไม่ได้
 *      จึงไม่เคยถูกดึงขึ้นมาตั้งแต่แรก ไม่ใช่ถูกดึงขึ้นมาแล้วซ่อน
 *
 *   2. ไม่ตรวจสิทธิ์ทีละแถว
 *      การเรียกตรวจสิทธิ์ต่อผลลัพธ์หนึ่งรายการ (N+1) ทำให้การค้นหาช้าลงตามจำนวนเอกสาร
 *      recursive CTE ทำงานเดียวจบ และคืน "เส้นทางเต็ม" ของแต่ละรายการมาด้วย
 *      สิทธิ์ที่มีผลจึงคำนวณได้จากเส้นทางนั้นในหน่วยความจำ โดยไม่ต้องถามฐานข้อมูลซ้ำ
 *
 *   3. ทรัพยากรที่ถูกลบตัดทั้งสาย
 *      การไล่ลงข้างล่างผ่านเฉพาะโหนดที่ยังไม่ถูกลบ ของที่อยู่ใต้โฟลเดอร์ในถังขยะ
 *      จึงไม่มีทางโผล่ในผลการค้นหา แม้ตัวมันเองจะยังไม่ถูกทำเครื่องหมายว่าลบ
 */

/** ความลึกสูงสุดที่ไล่ลงไป - กันโครงสร้างผิดปกติหรือวงจรไม่ให้วนไม่รู้จบ */
const MAX_SEARCH_DEPTH = 32;

/** จำนวนแถวสูงสุดที่ดึงจากฐานข้อมูลก่อนคัดกรองชนิดและตัดให้เหลือตามที่ผู้เรียกขอ */
const CANDIDATE_LIMIT = 300;

export const MIN_SEARCH_LENGTH = 2;

export interface PortalSearchHit {
  resource: PortalResource;
  role: PortalRole;
  allowDownload: boolean;
  /** เส้นทางจากรากที่ได้รับสิทธิ์ลงมาถึงรายการนี้ - ชั้นเหนือรากถูกตัดทิ้งแล้ว */
  path: Array<{ id: string; name: string }>;
  /** จริงเมื่อรายการนี้ตรงเพราะเนื้อในเอกสาร ไม่ใช่เพราะชื่อ */
  contentMatch: boolean;
}

/**
 * อักขระพิเศษของ LIKE ต้อง escape ก่อนเสมอ
 * มิฉะนั้นคำค้นที่มี % จะกลายเป็น "ตรงกับทุกอย่าง" ซึ่งไม่ใช่สิ่งที่ผู้ใช้ขอ
 *
 * ใช้ ! เป็นตัว escape แทน backslash โดยตั้งใจ
 * backslash ต้องถูก escape ซ้ำทั้งในสตริงของ TypeScript และในสตริงของ SQL
 * ซึ่งอ่านผิดง่ายและเคยทำให้คำสั่งพังมาแล้ว
 */
function escapeLike(value: string): string {
  return value.replace(/[!%_]/g, (match) => `!${match}`);
}

interface TreeRow {
  id: string;
  pathIds: string;
}

/**
 * ค้นหาภายในขอบเขตที่ลูกค้าเข้าถึงได้จริง
 *
 * คืนผลที่ผ่านการอนุญาตแล้วทั้งหมด ผู้เรียกไม่ต้องตรวจสิทธิ์ซ้ำ
 * (แต่การตรวจซ้ำก็ไม่ผิด - เส้นทางเปิดเอกสารจริงยังผ่าน resolvePortalAccess เสมอ)
 */
export async function searchGrantedSubtrees(
  userId: string,
  term: string,
  now: Date = new Date(),
  limit = 50,
): Promise<PortalSearchHit[]> {
  const query = term.trim();
  if (query.length < MIN_SEARCH_LENGTH) return [];

  const grants = await activeGrantMap(userId, now);
  if (grants.size === 0) return [];

  const rootIds = [...grants.keys()];
  const pattern = `%${escapeLike(query)}%`;

  /**
   * รหัสของเอกสารที่เนื้อในตรงกับคำค้น
   *
   * รายการนี้ยังไม่ผ่านการตรวจสิทธิ์ - มันถูกใช้เป็นเงื่อนไขเพิ่มเติมภายในการไล่ลำดับชั้น
   * ที่เริ่มจากรากที่ได้รับสิทธิ์เท่านั้น เอกสารของลูกค้ารายอื่นจึงถูกตัดออกด้วยโครงสร้าง
   * ของคำสั่ง ไม่ใช่ด้วยการกรองทีหลัง
   */
  const contentIds = await contentMatchResourceIds(query);
  const contentSet = new Set(contentIds);

  /**
   * ไล่จากรากที่ได้รับสิทธิ์ลงไปทุกชั้น พร้อมสะสมเส้นทางไว้ในคอลัมน์เดียว
   *
   * เงื่อนไข deletedAt IS NULL อยู่ทั้งในจุดเริ่มและในขั้นการไล่ลง
   * โฟลเดอร์ที่ถูกลบจึงตัดทั้งกิ่งทันที ไม่ใช่แค่ตัวมันเองหายไป
   *
   * รากหลายอันรวมกันได้เองโดยธรรมชาติ และ DISTINCT ตัดรายการซ้ำ
   * ที่เกิดจากรากซ้อนกัน (แชร์ทั้งโฟลเดอร์แม่และโฟลเดอร์ลูกให้คนเดียวกัน)
   */
  const rows = await prisma.$queryRaw<TreeRow[]>(Prisma.sql`
    WITH RECURSIVE portal_tree AS (
      SELECT
        r.id            AS id,
        r.name          AS name,
        1               AS depth,
        CAST(r.id AS CHAR(2048)) AS pathIds
      FROM resources r
      WHERE r.id IN (${Prisma.join(rootIds)})
        AND r.deletedAt IS NULL

      UNION ALL

      SELECT
        c.id,
        c.name,
        t.depth + 1,
        CAST(CONCAT(t.pathIds, '/', c.id) AS CHAR(2048))
      FROM resources c
      INNER JOIN portal_tree t ON c.parentId = t.id
      WHERE c.deletedAt IS NULL
        AND t.depth < ${MAX_SEARCH_DEPTH}
    )
    SELECT DISTINCT id, pathIds
    FROM portal_tree
    WHERE name LIKE ${pattern} ESCAPE '!'
       ${contentIds.length > 0 ? Prisma.sql`OR id IN (${Prisma.join(contentIds)})` : Prisma.empty}
    LIMIT ${CANDIDATE_LIMIT}
  `);

  if (rows.length === 0) return [];

  /**
   * รายการซ้ำเกิดได้เมื่อรากหนึ่งอยู่ใต้อีกรากหนึ่ง - เก็บเส้นทางที่สั้นที่สุดไว้
   * เพราะเส้นทางที่สั้นกว่าคือเส้นทางจากรากที่ผู้ใช้เห็นจริง
   */
  const bestPath = new Map<string, string[]>();
  for (const row of rows) {
    const path = row.pathIds.split('/');
    const current = bestPath.get(row.id);
    if (!current || path.length < current.length) bestPath.set(row.id, path);
  }

  const hitIds = [...bestPath.keys()];
  const allPathIds = [...new Set([...bestPath.values()].flat())];

  // สองคำสั่ง ไม่ขึ้นกับจำนวนผลลัพธ์ - ไม่มีการถามฐานข้อมูลทีละแถว
  const [resources, names] = await Promise.all([
    prisma.resource.findMany({ where: { id: { in: hitIds } }, select: portalResourceSelect }),
    prisma.resource.findMany({ where: { id: { in: allPathIds } }, select: { id: true, name: true } }),
  ]);

  const nameById = new Map(names.map((row) => [row.id, row.name]));
  const results: PortalSearchHit[] = [];

  for (const resource of resources) {
    if (!isPortalVisibleType(resource.type)) continue;
    const path = bestPath.get(resource.id);
    if (!path) continue;

    /**
     * สิทธิ์ที่มีผลคือสิทธิ์ที่ใกล้ตัวทรัพยากรที่สุด (กติกาเดียวกับ resolvePortalAccess)
     * ส่วนรากของเส้นทางที่แสดงคือสิทธิ์ที่ไกลที่สุดในสายเดียวกัน
     */
    let effective: { role: PortalRole; allowDownload: boolean } | undefined;
    let rootIndex = -1;
    for (let index = 0; index < path.length; index += 1) {
      const grant = grants.get(path[index]!);
      if (!grant) continue;
      if (rootIndex < 0) rootIndex = index;
      effective = grant;
    }
    if (!effective || rootIndex < 0) continue;

    results.push({
      resource,
      role: effective.role,
      allowDownload: effective.allowDownload,
      contentMatch: contentSet.has(resource.id),
      path: path
        .slice(rootIndex)
        .map((id) => ({ id, name: nameById.get(id) ?? '' }))
        .filter((node) => node.name !== ''),
    });
  }

  // เรียงตามความใหม่ เพื่อให้สิ่งที่เพิ่งเปลี่ยนแปลงอยู่บนสุด
  results.sort((a, b) => b.resource.updatedAt.getTime() - a.resource.updatedAt.getTime());
  return results.slice(0, limit);
}
