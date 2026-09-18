import type { ResourceAccessLevel, ResourceClassification } from '@prisma/client';
import { prisma } from '../../core/prisma.js';
import { notFound } from '../../core/errors.js';
import type { AuthUser } from '../auth/auth.service.js';
import { capabilities, resourceInclude } from '../resources/resource.service.js';
import { isPortalVisibleType, portalRoleFor } from '../portal/portal-policy.js';
import { shareStatus, toShareDto } from './public-share.service.js';
import { allowsAnonymousLink, allowsExternalAccess, classificationRestrictions } from '../governance/classification.policy.js';
import { mergeGrants, workflowGrantsForResources } from '../workflow/workflow-access.js';

/**
 * WORKFLOW = สิทธิ์ที่มีอยู่เพราะมีคำขอความร่วมมือจากภายนอกเป็นเหตุ (F26-B)
 *
 * **ไม่ใช่เส้นทางการเข้าถึงที่สอง** สิทธิ์ยังเป็นแถว ResourceAccess แถวเดิม แหล่งนี้
 * เพียงอธิบายว่าแถวนั้นเกิดขึ้นเพราะอะไร ถ้าไม่มีป้ายนี้ ผู้ตรวจสอบจะเห็นสิทธิ์ของ
 * บัญชีภายนอกโผล่มาโดยไม่มีที่มา แล้วต้องเดาเอง หรือแย่กว่านั้นคือเพิกถอนทิ้ง
 * เพราะดูเหมือนไม่มีใครเป็นเจ้าของ
 */
type EvidenceSource = 'OWNER' | 'DIRECT' | 'INHERITED' | 'ROLE' | 'WORKFLOW';

export interface AccessEvidence {
  source: EvidenceSource;
  role: 'OWNER' | 'EDITOR' | 'VIEWER' | 'CONTRIBUTOR';
  sourceResourceId: string;
  sourceResourceName: string;
  allowDownload: boolean;
  expiresAt: string | null;
  active: boolean;
}

export interface EffectiveAccessEntry {
  subjectType: 'USER';
  channel: 'INTERNAL' | 'PORTAL';
  subject: {
    id: string;
    displayName: string;
    email: string;
    organizationName: string | null;
  };
  effectiveRole: 'OWNER' | 'EDITOR' | 'VIEWER' | 'CONTRIBUTOR';
  allowDownload: boolean;
  source: EvidenceSource;
  usable: boolean;
  /**
   * CLASSIFICATION_RESTRICTED = "ได้รับสิทธิ์ไว้จริง แต่นโยบายชั้นความลับปิดช่องทางนั้นอยู่" (F25-D)
   *
   * แยกจาก EXPIRED และ RESOURCE_UNAVAILABLE เพราะวิธีแก้ต่างกันคนละเรื่อง
   * หมดอายุ = ต่ออายุสิทธิ์ · ทรัพยากรไม่พร้อม = กู้คืนหรือเอาออกจากคลัง
   * · ติดชั้นความลับ = ตัดสินใจเรื่องการเปิดเผย ซึ่งเป็นการตัดสินใจเชิงนโยบาย ไม่ใช่การกดปุ่มแก้
   */
  status: 'ACTIVE' | 'PRINCIPAL_INACTIVE' | 'EXPIRED' | 'RESOURCE_UNAVAILABLE' | 'CLASSIFICATION_RESTRICTED';
  evidence: AccessEvidence[];
}

interface ChainNode {
  id: string;
  name: string;
  parentId: string | null;
  deletedAt: Date | null;
  lifecycleState: 'ACTIVE' | 'ARCHIVED';
  classification: ResourceClassification;
}

/**
 * Loads the complete ancestor chain in one database round trip. This mirrors the
 * portal's nearest-grant-wins rule without issuing one query per folder level.
 */
export async function ancestorChain(resourceId: string): Promise<ChainNode[]> {
  return prisma.$queryRaw<ChainNode[]>`
    WITH RECURSIVE resource_chain AS (
      SELECT id, name, parentId, deletedAt, lifecycleState, classification, 0 AS depth
      FROM resources WHERE id = ${resourceId}
      UNION ALL
      SELECT parent.id, parent.name, parent.parentId, parent.deletedAt, parent.lifecycleState, parent.classification, child.depth + 1
      FROM resources parent
      INNER JOIN resource_chain child ON child.parentId = parent.id
      WHERE child.depth < 63
    )
    SELECT id, name, parentId, deletedAt, lifecycleState, classification FROM resource_chain ORDER BY depth ASC
  `;
}

const roleRank: Record<ResourceAccessLevel, number> = { OWNER: 3, EDITOR: 2, VIEWER: 1 };

export async function effectiveAccessReview(resourceId: string, now = new Date()) {
  const resource = await prisma.resource.findFirst({
    where: { id: resourceId, deletedAt: null },
    include: resourceInclude,
  });
  if (!resource) throw notFound('RESOURCE_NOT_FOUND', 'ไม่พบทรัพยากร');

  const chain = await ancestorChain(resourceId);
  const chainIds = chain.map((node) => node.id);
  const [grants, internalUsers, publicLinks, workflows] = await Promise.all([
    prisma.resourceAccess.findMany({
      where: { resourceId: { in: chainIds } },
      include: {
        user: { select: { id: true, displayName: true, email: true, type: true, status: true, organizationName: true } },
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    }),
    prisma.user.findMany({
      where: { type: 'INTERNAL' },
      select: {
        id: true, email: true, displayName: true, type: true, status: true,
        organizationName: true, mustChangePassword: true,
        roles: { select: { role: { select: { code: true, permissions: { select: { permission: { select: { code: true } } } } } } } },
      },
      orderBy: [{ displayName: 'asc' }, { id: 'asc' }],
    }),
    prisma.publicShareLink.findMany({
      where: { resourceId: { in: chainIds } },
      include: { resource: { select: { name: true, type: true, deletedAt: true, lifecycleState: true, classification: true } } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    }),
    /*
     * สิทธิ์จากคำขอความร่วมมือที่ยังเปิดใช้งาน - อ่านผ่านตัวช่วยตัวเดียวกับที่ด่าน
     * พื้นที่ลูกค้าใช้ (F26-B1) ถ้ารายงานคำนวณเองแยกต่างหาก มันจะค่อย ๆ ตอบต่างจาก
     * สิ่งที่ระบบบังคับใช้จริง ซึ่งคือข้อบกพร่องที่ F26-A เจอมาแล้วครั้งหนึ่ง
     */
    workflowGrantsForResources(chainIds, now),
  ]);

  /** สิทธิ์จากคำขอ จัดกลุ่มตามผู้รับงาน เพื่อรวมกับสิทธิ์ที่มอบด้วยมือทีหลัง */
  const workflowByUser = new Map<string, typeof workflows>();
  for (const workflow of workflows) {
    const list = workflowByUser.get(workflow.userId) ?? [];
    list.push(workflow);
    workflowByUser.set(workflow.userId, list);
  }

  /**
   * เส้นทางจากรากของลิงก์ลงมาถึงทรัพยากรนี้ ผ่านได้หรือไม่ (F25-D)
   *
   * สะท้อนการไต่ของแขกใน resolveWithinScope แบบหนึ่งต่อหนึ่ง: ทุกชั้นต้องยังอยู่ ไม่ถูกเก็บเข้าคลัง
   * และต้องยอมให้เปิดเผยแบบไม่ระบุตัวตน ถ้าตรงนี้กับด่านรับแขกตอบไม่ตรงกันเมื่อไร
   * รายงานจะบอกผู้ดูแลว่าลิงก์ใช้ได้ทั้งที่ลูกค้ากดแล้วเจอหน้าปฏิเสธ
   *
   * แยกสองสาเหตุออกจากกัน เพราะ "เอกสารถูกเก็บเข้าคลัง" กับ "นโยบายปิดไว้" แก้คนละทาง
   */
  function pathVerdict(linkResourceId: string): 'OK' | 'UNAVAILABLE' | 'CLASSIFICATION' {
    const sourceIndex = chainIds.indexOf(linkResourceId);
    if (sourceIndex < 0) return 'UNAVAILABLE';
    const path = chain.slice(0, sourceIndex + 1);
    if (!path.every((node) => node.deletedAt === null && node.lifecycleState === 'ACTIVE')) return 'UNAVAILABLE';
    if (!path.every((node) => allowsAnonymousLink(node.classification))) return 'CLASSIFICATION';
    return 'OK';
  }

  const directByUser = new Map(grants.filter((grant) => grant.resourceId === resourceId).map((grant) => [grant.userId, grant]));
  const entries: EffectiveAccessEntry[] = [];

  for (const row of internalUsers) {
    const direct = directByUser.get(row.id);
    const activeDirect = direct && (!direct.expiresAt || direct.expiresAt.getTime() > now.getTime()) ? direct : undefined;
    const auth: AuthUser = {
      id: row.id,
      email: row.email,
      displayName: row.displayName,
      type: row.type,
      status: row.status,
      mustChangePassword: row.mustChangePassword,
      roles: row.roles.map((item) => item.role.code),
      permissions: [...new Set(row.roles.flatMap((item) => item.role.permissions.map((p) => p.permission.code)))],
    };
    const caps = capabilities(resource, auth);
    const isOwner = resource.ownerId === row.id;
    const usable = row.status === 'ACTIVE' && caps.canView;
    if (!usable && !isOwner && !direct) continue;

    const evidence: AccessEvidence[] = [];
    if (isOwner) evidence.push({ source: 'OWNER', role: 'OWNER', sourceResourceId: resource.id, sourceResourceName: resource.name, allowDownload: resource.type === 'FILE', expiresAt: null, active: row.status === 'ACTIVE' });
    if (direct) evidence.push({ source: 'DIRECT', role: direct.accessLevel, sourceResourceId: resource.id, sourceResourceName: resource.name, allowDownload: direct.allowDownload, expiresAt: direct.expiresAt?.toISOString() ?? null, active: Boolean(activeDirect) && row.status === 'ACTIVE' });
    const roleDerived = caps.canView && !isOwner && (!activeDirect || row.roles.some((item) => item.role.code === 'ADMIN' || item.role.code === 'SUPER_ADMIN') || resource.visibility === 'ORGANIZATION' || resource.driveScope === 'SYSTEM_DRIVE');
    if (roleDerived) evidence.push({ source: 'ROLE', role: caps.canEdit ? 'EDITOR' : 'VIEWER', sourceResourceId: resource.id, sourceResourceName: resource.name, allowDownload: caps.canDownload, expiresAt: null, active: row.status === 'ACTIVE' });

    const source: EvidenceSource = isOwner ? 'OWNER' : activeDirect ? 'DIRECT' : 'ROLE';
    const expired = Boolean(direct && !activeDirect);
    entries.push({
      subjectType: 'USER', channel: 'INTERNAL',
      subject: { id: row.id, displayName: row.displayName, email: row.email, organizationName: row.organizationName },
      effectiveRole: isOwner ? 'OWNER' : caps.canEdit ? 'EDITOR' : activeDirect?.accessLevel ?? direct?.accessLevel ?? 'VIEWER',
      allowDownload: usable && caps.canDownload,
      source, usable,
      status: row.status !== 'ACTIVE' ? 'PRINCIPAL_INACTIVE' : usable ? 'ACTIVE' : expired ? 'EXPIRED' : 'RESOURCE_UNAVAILABLE',
      evidence,
    });
  }

  const externalGroups = new Map<string, typeof grants>();
  for (const grant of grants) {
    if (grant.user.type !== 'EXTERNAL') continue;
    const group = externalGroups.get(grant.userId) ?? [];
    group.push(grant);
    externalGroups.set(grant.userId, group);
  }

  /*
   * ผู้รับงานที่ได้สิทธิ์จาก "คำขออย่างเดียว" ต้องอยู่ในรายงานด้วย (F26-B1)
   *
   * ตั้งแต่คำขอเลิกเขียนทับแถว ResourceAccess ผู้รับงานจำนวนหนึ่งจะไม่มีแถวสิทธิ์เลย
   * ถ้ารายงานยังไล่จากแถวสิทธิ์อย่างเดียว คนเหล่านั้นจะเข้าถึงเอกสารได้โดยไม่ปรากฏใน
   * รายงานการตรวจสอบ - ซึ่งคือ "เส้นทางที่มองไม่เห็น" ที่ห้ามเกิดขึ้นเด็ดขาด
   */
  const workflowOnlyUserIds = [...workflowByUser.keys()].filter((id) => !externalGroups.has(id));
  const workflowOnlySubjects = workflowOnlyUserIds.length
    ? await prisma.user.findMany({
        where: { id: { in: workflowOnlyUserIds } },
        select: { id: true, displayName: true, email: true, type: true, status: true, organizationName: true },
      })
    : [];

  type ExternalSubject = (typeof grants)[number]['user'];
  const externalSubjects: Array<{ subject: ExternalSubject; subjectGrants: typeof grants }> = [
    ...[...externalGroups.values()].map((group) => ({ subject: group[0]!.user, subjectGrants: group })),
    ...workflowOnlySubjects.map((subject) => ({ subject, subjectGrants: [] as typeof grants })),
  ];

  for (const { subject, subjectGrants } of externalSubjects) {
    const ordered = subjectGrants.sort((a, b) => chainIds.indexOf(a.resourceId) - chainIds.indexOf(b.resourceId));
    const nearestActive = ordered.find((grant) => !grant.expiresAt || grant.expiresAt.getTime() > now.getTime());
    const subjectWorkflows = workflowByUser.get(subject.id) ?? [];
    const chainUsable = chain.length > 0 && chain.every((node) => node.deletedAt === null) && isPortalVisibleType(resource.type);
    /*
     * ชั้นความลับเป็น "เพดาน" ที่ทับผลลัพธ์ทีหลัง ไม่ได้เข้าไปยุ่งกับการคำนวณสิทธิ์ (F25-D)
     *
     * คำนวณสิทธิ์ให้เสร็จก่อนตามกฎเดิมทุกข้อ แล้วค่อยถามว่านโยบายยอมให้ใช้ช่องทางนี้ไหม
     * เขียนแบบนี้เพราะหลักฐานด้านล่างต้องยังบอกความจริงว่า "ใครได้รับสิทธิ์อะไรไว้"
     * ผู้ตรวจสอบที่เห็นตารางว่างจะสรุปผิดว่าไม่เคยมีใครถูกมอบสิทธิ์ ทั้งที่มีและยังอยู่
     */
    const classificationBlocksPortal = !allowsExternalAccess(resource.classification);

    /*
     * รวมสองแหล่งด้วยตัวช่วยตัวเดียวกับที่ activeGrantMap ใช้ (F26-B1)
     *
     * ผลลัพธ์ที่รายงานแสดง ต้องเป็นผลลัพธ์เดียวกับที่ลูกค้าได้รับจริง ถ้าคำนวณคนละทาง
     * รายงานจะกลายเป็นความเห็น ไม่ใช่หลักฐาน
     */
    const merged = mergeGrants(
      nearestActive
        ? { accessLevel: nearestActive.accessLevel, allowDownload: nearestActive.allowDownload, expiresAt: nearestActive.expiresAt }
        : null,
      subjectWorkflows,
    );
    const grantedUsable = subject.status === 'ACTIVE' && merged !== null && chainUsable;
    const usable = grantedUsable && !classificationBlocksPortal;
    /*
     * สองที่มาเป็นหลักฐานคนละชิ้น **ไม่ยุบรวมกัน** (F26-B1)
     *
     * ถ้ายุบเป็นชิ้นเดียว ผู้ตรวจสอบจะเห็นแค่ "เข้าถึงได้ระดับนี้" โดยไม่รู้ว่าส่วนไหน
     * เป็นสิทธิ์ถาวรที่ผู้ดูแลตั้งใจมอบ และส่วนไหนจะหายไปเองเมื่องานจบ ซึ่งเป็นความต่าง
     * ที่ตัดสินว่าต้องไปเพิกถอนด้วยมือหรือแค่รอ
     */
    const evidence: AccessEvidence[] = [
      ...ordered.map<AccessEvidence>((grant) => {
        const node = chain.find((candidate) => candidate.id === grant.resourceId)!;
        const active = (!grant.expiresAt || grant.expiresAt.getTime() > now.getTime()) && subject.status === 'ACTIVE';
        return {
          source: grant.resourceId === resourceId ? 'DIRECT' : 'INHERITED',
          role: portalRoleFor(grant.accessLevel), sourceResourceId: grant.resourceId,
          sourceResourceName: node?.name ?? 'Unknown', allowDownload: grant.allowDownload,
          expiresAt: grant.expiresAt?.toISOString() ?? null, active,
        };
      }),
      ...subjectWorkflows.map<AccessEvidence>((workflow) => {
        const node = chain.find((candidate) => candidate.id === workflow.resourceId);
        return {
          source: 'WORKFLOW',
          role: portalRoleFor(workflow.accessLevel),
          sourceResourceId: workflow.resourceId,
          sourceResourceName: node?.name ?? resource.name,
          allowDownload: workflow.allowDownload,
          expiresAt: workflow.expiresAt?.toISOString() ?? null,
          // คัดเฉพาะคำขอที่ยังเปิดใช้งานมาตั้งแต่ต้นแล้ว เหลือเพียงสถานะบัญชีที่ต้องตรวจ
          active: subject.status === 'ACTIVE',
        };
      }),
    ];
    entries.push({
      subjectType: 'USER', channel: 'PORTAL',
      subject: { id: subject.id, displayName: subject.displayName, email: subject.email, organizationName: subject.organizationName },
      effectiveRole: portalRoleFor(
        merged?.accessLevel
          ?? ordered.sort((a, b) => roleRank[b.accessLevel] - roleRank[a.accessLevel])[0]?.accessLevel
          ?? 'VIEWER',
      ),
      allowDownload: usable && Boolean(merged?.allowDownload),
      /*
       * แหล่งที่แสดงเป็นผลสรุป เลือกที่มาที่อธิบายผลลัพธ์ได้ตรงที่สุด
       * คำขอมาก่อนเพราะมันคือสิ่งที่ทำให้ระดับสิทธิ์สูงขึ้นในกรณีที่รวมแล้วสูงกว่าเดิม
       */
      source: subjectWorkflows.length > 0 && !nearestActive
        ? 'WORKFLOW'
        : nearestActive?.resourceId === resourceId
          ? 'DIRECT'
          : nearestActive
            ? 'INHERITED'
            : 'WORKFLOW',
      usable,
      status: subject.status !== 'ACTIVE' ? 'PRINCIPAL_INACTIVE' : usable ? 'ACTIVE' : grantedUsable && classificationBlocksPortal ? 'CLASSIFICATION_RESTRICTED' : merged ? 'RESOURCE_UNAVAILABLE' : 'EXPIRED',
      evidence,
    });
  }

  return {
    resource: {
      id: resource.id, name: resource.name, type: resource.type,
      visibility: resource.visibility, driveScope: resource.driveScope,
      classification: resource.classification,
      classifiedAt: resource.classifiedAt,
    },
    /**
     * ข้อจำกัดจากชั้นความลับ แยกเป็นก้อนของตัวเอง ไม่ปนกับหลักฐานการแชร์ (F25-D)
     *
     * หลักฐานการแชร์ตอบว่า "ใครถูกมอบสิทธิ์อะไรไว้" ซึ่งเป็นข้อเท็จจริงในอดีตที่แก้ไม่ได้
     * ส่วนก้อนนี้ตอบว่า "นโยบายวันนี้ปิดอะไรอยู่" ซึ่งเปลี่ยนได้ทุกเมื่อ
     * ถ้ายุบสองอย่างนี้เข้าด้วยกัน การเปลี่ยนนโยบายจะดูเหมือนการลบประวัติการแชร์
     */
    classificationPolicy: classificationRestrictions(resource.classification),
    policy: {
      internalInheritance: false,
      portalInheritance: 'NEAREST_ACTIVE_GRANT_WINS',
      internalMerge: 'RUNTIME_CAPABILITIES_WITH_DIRECT_DOWNLOAD_OVERRIDE',
    },
    entries,
    publicLinks: publicLinks.map((link) => {
      const verdict = pathVerdict(link.resourceId);
      const dto = toShareDto(link, link.resource);
      return {
        ...dto,
        status:
          dto.status !== 'ACTIVE' || verdict === 'OK'
            ? dto.status
            : verdict === 'CLASSIFICATION'
              ? ('CLASSIFICATION_RESTRICTED' as const)
              : ('RESOURCE_UNAVAILABLE' as const),
        source: link.resourceId === resourceId ? 'DIRECT' as const : 'INHERITED' as const,
        sourceResourceId: link.resourceId,
        sourceResourceName: link.resource.name,
      };
    }),
    summary: {
      effectiveUsers: entries.filter((entry) => entry.usable).length,
      assignedButInactive: entries.filter((entry) => !entry.usable).length,
      activePublicLinks: publicLinks.filter(
        (link) => shareStatus(link, link.resource, now) === 'ACTIVE' && pathVerdict(link.resourceId) === 'OK',
      ).length,
      portalUsers: entries.filter((entry) => entry.channel === 'PORTAL' && entry.usable).length,
    },
    generatedAt: now.toISOString(),
  };
}

export function neutralizeCsvCell(value: unknown): string {
  const raw = value === null || value === undefined ? '' : String(value);
  const safe = /^[=+\-@]/u.test(raw) ? `'${raw}` : raw;
  return `"${safe.replace(/"/gu, '""')}"`;
}

export function accessReviewCsv(review: Awaited<ReturnType<typeof effectiveAccessReview>>): string {
  const header = ['subject', 'email', 'channel', 'effectiveRole', 'source', 'inheritedFrom', 'allowDownload', 'expiresAt', 'status'];
  const rows = review.entries.map((entry) => {
    const inherited = entry.evidence.filter((e) => e.source === 'INHERITED').map((e) => e.sourceResourceName).join(' > ');
    const expiries = entry.evidence.map((e) => e.expiresAt).filter(Boolean).join(' | ');
    return [entry.subject.displayName, entry.subject.email, entry.channel, entry.effectiveRole, entry.source, inherited, entry.allowDownload, expiries, entry.status];
  });
  return `\uFEFF${[header, ...rows].map((row) => row.map(neutralizeCsvCell).join(',')).join('\r\n')}\r\n`;
}
