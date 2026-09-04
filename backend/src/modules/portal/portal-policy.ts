import type { ResourceAccessLevel, ResourceType } from '@prisma/client';

/**
 * นโยบายของผู้ใช้งานภายนอก (ลูกค้า)
 *
 * โมดูลนี้เป็นฟังก์ชันบริสุทธิ์ล้วน ไม่แตะฐานข้อมูล เพื่อให้กติกาความปลอดภัยของเฟสนี้
 * ถูกทดสอบได้ครบทุกเส้นทางโดยไม่ต้องพึ่งข้อมูลจริง
 *
 * หลักสำคัญสามข้อ:
 *
 *   1. ชนิดบัญชีมีน้ำหนักเหนือบทบาทเสมอ
 *      บัญชี EXTERNAL ที่เผลอได้รับบทบาทภายในกว้าง ๆ ก็ยังทำได้เท่าที่นโยบายนี้อนุญาต
 *      สิทธิ์ของผู้ใช้ภายนอกจึงไม่ได้มาจากชื่อบทบาท แต่มาจากการแชร์รายทรัพยากรเท่านั้น
 *
 *   2. ไม่มีสิทธิ์โดยปริยาย
 *      ไม่มีอะไรที่ "เห็นได้เพราะเป็นขององค์กร" สำหรับผู้ใช้ภายนอก
 *      เห็นได้เฉพาะสิ่งที่ถูกแชร์ให้โดยตรง และสิ่งที่อยู่ใต้โฟลเดอร์ที่ถูกแชร์ให้เท่านั้น
 *
 *   3. อ่านและเพิ่ม ไม่ลบและไม่แก้
 *      ผู้ใช้ภายนอกเปลี่ยนแปลงของเดิมไม่ได้เลย แม้แต่ไฟล์ที่ตัวเองอัปโหลดขึ้นมา
 *      การควบคุมเอกสารยังเป็นของบุคลากรภายในเสมอ
 */

/** บทบาทในพื้นที่ลูกค้า - จงใจมีเพียงสองระดับ ไม่สะท้อนบทบาทภายในแบบหนึ่งต่อหนึ่ง */
export type PortalRole = 'VIEWER' | 'CONTRIBUTOR';

export const PORTAL_ROLE_LABEL: Record<PortalRole, string> = {
  VIEWER: 'ดูอย่างเดียว',
  CONTRIBUTOR: 'อัปโหลดได้',
};

/** ชนิดบัญชีที่นโยบายนี้บังคับใช้ */
export function isExternalUser(user: { type?: string | null } | null | undefined): boolean {
  return user?.type === 'EXTERNAL';
}

/**
 * แปลงระดับสิทธิ์ภายในเป็นบทบาทในพื้นที่ลูกค้า
 *
 * ระดับ EDITOR ภายในแปลว่า "แก้ไขเนื้อหาได้" แต่สำหรับผู้ใช้ภายนอกจะถูกลดรูปเหลือ
 * "เพิ่มไฟล์ใหม่ได้" เท่านั้น การแก้ไข/ลบ/ย้ายของเดิมไม่ถูกส่งต่อมาด้วย
 * OWNER ไม่ควรถูกมอบให้ผู้ใช้ภายนอกอยู่แล้ว แต่ถ้าเกิดขึ้นก็ถูกลดรูปเท่ากับ CONTRIBUTOR
 */
export function portalRoleFor(accessLevel: ResourceAccessLevel): PortalRole {
  return accessLevel === 'VIEWER' ? 'VIEWER' : 'CONTRIBUTOR';
}

/** ระดับสิทธิ์ที่มอบให้ผู้ใช้ภายนอกได้ - ความเป็นผู้ดูแลหลักไม่อยู่ในชุดนี้โดยตั้งใจ */
export const EXTERNAL_GRANTABLE_LEVELS = ['VIEWER', 'EDITOR'] as const;
export type ExternalGrantLevel = (typeof EXTERNAL_GRANTABLE_LEVELS)[number];

/**
 * สิทธิ์ยังมีผลอยู่หรือไม่ ณ เวลาที่ตรวจ
 *
 * expiresAt = null แปลว่าไม่หมดอายุ
 * การตรวจเทียบกับเวลาปัจจุบันทุกครั้งที่มีคำขอ ทำให้สิทธิ์ที่หมดอายุถูกปฏิเสธทันที
 * โดยไม่ต้องรอรอบเก็บกวาด และไม่ต้องให้ผู้ใช้ออกจากระบบก่อน
 */
export function isGrantActive(
  grant: { expiresAt?: Date | null } | null | undefined,
  now: Date = new Date(),
): boolean {
  if (!grant) return false;
  if (!grant.expiresAt) return true;
  return grant.expiresAt.getTime() > now.getTime();
}

export interface ExternalCapabilities {
  canView: boolean;
  canDownload: boolean;
  canUpload: boolean;
  /** ทุกค่าต่อจากนี้เป็น false เสมอในเฟสนี้ - ประกาศไว้ให้เห็นชัดว่าเป็นการตัดสินใจ ไม่ใช่การลืม */
  canRename: false;
  canMove: false;
  canDelete: false;
  canShare: false;
  canLock: false;
  canTransferOwner: false;
  canCreateFolder: false;
  canSeeVersionHistory: false;
  canSeeTrash: false;
}

/**
 * ความสามารถของผู้ใช้ภายนอกบนทรัพยากรหนึ่งชิ้น
 *
 * ทุกอย่างที่เปลี่ยนแปลงของเดิมถูกปิดตายไว้ที่ระดับชนิดข้อมูล ไม่ใช่แค่ค่าที่คำนวณได้
 * ผู้ที่แก้ไขโค้ดนี้ในอนาคตจึงต้องแก้สัญญาของฟังก์ชันก่อน ไม่ใช่แก้เงื่อนไขผ่าน ๆ
 */
export function externalCapabilities(input: {
  role: PortalRole;
  allowDownload: boolean;
  resourceType: ResourceType;
  isLocked: boolean;
}): ExternalCapabilities {
  const isFile = input.resourceType === 'FILE';
  const isFolder = input.resourceType === 'FOLDER';

  return {
    canView: true,
    // ดาวน์โหลดได้เฉพาะไฟล์จริง และเฉพาะเมื่อผู้แชร์เปิดสิทธิ์นั้นไว้
    canDownload: isFile && input.allowDownload,
    /**
     * อัปโหลดเข้าโฟลเดอร์ที่ได้รับสิทธิ์ CONTRIBUTOR เท่านั้น
     * โฟลเดอร์ที่ถูกล็อกไว้ห้ามเปลี่ยนแปลง การล็อกเป็นการตัดสินใจของฝ่ายภายใน
     * ซึ่งมีน้ำหนักเหนือสิทธิ์ที่เคยมอบให้ลูกค้า
     */
    canUpload: isFolder && input.role === 'CONTRIBUTOR' && !input.isLocked,
    canRename: false,
    canMove: false,
    canDelete: false,
    canShare: false,
    canLock: false,
    canTransferOwner: false,
    canCreateFolder: false,
    canSeeVersionHistory: false,
    canSeeTrash: false,
  };
}

/**
 * ชนิดทรัพยากรที่แสดงในพื้นที่ลูกค้าได้
 *
 * SYSTEM_FILE และ SHORTCUT เป็นกลไกภายใน ไม่ควรโผล่ในสายตาลูกค้า
 */
const PORTAL_VISIBLE_TYPES: readonly ResourceType[] = [
  'FILE',
  'FOLDER',
  'GOOGLE_SHEET',
  'GOOGLE_DOC',
  'GOOGLE_DRIVE',
  'WEB_LINK',
];

export function isPortalVisibleType(type: ResourceType): boolean {
  return PORTAL_VISIBLE_TYPES.includes(type);
}

/**
 * ป้ายกำกับที่มนุษย์อ่านรู้เรื่องของแหล่งที่มา "ลูกค้าอัปโหลด"
 * ค่าดิบของ enum ไม่ควรหลุดออกไปที่หน้าจอ
 */
export const EXTERNAL_UPLOAD_LABEL = 'ลูกค้าอัปโหลด';

/** การกระทำที่ต้องบันทึกไว้เสมอเมื่อเกิดจากผู้ใช้ภายนอก */
export const EXTERNAL_AUDIT_ACTIONS = {
  LOGIN: 'EXTERNAL_LOGIN',
  VIEWED: 'EXTERNAL_RESOURCE_VIEWED',
  DOWNLOADED: 'EXTERNAL_RESOURCE_DOWNLOADED',
  UPLOADED: 'EXTERNAL_FILE_UPLOADED',
  ACCESS_GRANTED: 'EXTERNAL_ACCESS_GRANTED',
  ACCESS_REVOKED: 'EXTERNAL_ACCESS_REVOKED',
} as const;
