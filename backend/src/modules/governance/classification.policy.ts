import type { ResourceClassification, ResourceVisibility } from '@prisma/client';

/**
 * นโยบายชั้นความลับ (F25-D)
 *
 * **ขอบเขตที่ตัดสินใจไว้อย่างจงใจ: ชั้นความลับคุม "การเปิดเผยออกนอกองค์กร" เท่านั้น**
 *
 * ระบบนี้มีสนามที่คุมการเข้าถึงภายในอยู่แล้วคือ `visibility`
 * (ORGANIZATION = คนในองค์กรที่มีสิทธิ์อ่านเห็นได้ · RESTRICTED = เฉพาะผู้ดูแล ผู้ได้รับสิทธิ์ตรง และแอดมิน)
 * ซึ่งถูกบังคับใช้ใน capabilities() และ visibilityScope() ของการค้นหา ผู้ช่วยเอกสาร และการจัดเก็บอัจฉริยะ
 *
 * ถ้าให้ชั้นความลับมาคุมการเข้าถึงภายในอีกชั้น จะกลายเป็นระบบสิทธิ์สองชุดที่ขัดกันเอง
 * และต้องมานิยามว่าจะเชื่อใครเมื่อสองสนามไม่ตรงกัน ซึ่งเป็นแหล่งของช่องโหว่โดยตรง
 *
 * **ช่องโหว่ที่นโยบายนี้ปิด:** ก่อน F25-D ลิงก์สาธารณะและพื้นที่ลูกค้าไม่เคยดู `visibility` เลย
 * (`resourceAvailableToGuests` ตรวจแค่ deletedAt กับ lifecycleState) เอกสารที่ถูกจำกัดภายใน
 * อย่างเข้มงวดจึงถูกเผยแพร่ออกสู่สาธารณะแบบไม่ระบุตัวตนได้ โดยไม่มีด่านใดทัดทาน
 *
 * **หลักการที่ห้ามละเมิด: ชั้นความลับลดสิทธิ์ได้อย่างเดียว ไม่เคยสร้างการเข้าถึงที่ไม่เคยมี**
 * การตั้งเป็น PUBLIC ไม่ได้เปิดให้ใครเข้าถึงอะไรเพิ่ม มันแค่ "อนุญาตให้สร้างลิงก์สาธารณะได้"
 * ส่วนใครจะเข้าถึงได้จริงยังขึ้นกับ visibility สิทธิ์โดยตรง และบทบาท ตามเดิมทุกประการ
 */

/** เรียงจากเปิดเผยได้มากที่สุดไปหาน้อยที่สุด - ใช้ตัดสินว่าการเปลี่ยนเป็นการลดหรือเพิ่มชั้น */
export const CLASSIFICATION_ORDER: ResourceClassification[] = [
  'PUBLIC',
  'INTERNAL',
  'CONFIDENTIAL',
  'RESTRICTED',
];

export function classificationRank(level: ResourceClassification): number {
  return CLASSIFICATION_ORDER.indexOf(level);
}

/** การเปลี่ยนนี้เป็นการ "ลดชั้นความลับ" หรือไม่ - ลดชั้น = เปิดเผยได้มากขึ้น = ต้องใช้สิทธิ์พิเศษ */
export function isDowngrade(from: ResourceClassification, to: ResourceClassification): boolean {
  return classificationRank(to) < classificationRank(from);
}

export function isUpgrade(from: ResourceClassification, to: ResourceClassification): boolean {
  return classificationRank(to) > classificationRank(from);
}

/**
 * ชั้นนี้ยอมให้มีลิงก์สาธารณะแบบไม่ระบุตัวตนหรือไม่
 *
 * มีเพียง PUBLIC เท่านั้น เพราะลิงก์สาธารณะคือการเปิดเอกสารให้ผู้ที่ไม่มีบัญชีเลย
 * ซึ่งเป็นการเปิดเผยที่กว้างที่สุดเท่าที่ระบบทำได้
 */
export function allowsAnonymousLink(level: ResourceClassification): boolean {
  return level === 'PUBLIC';
}

/**
 * ชั้นนี้ยอมให้ผู้ใช้ภายนอก (พื้นที่ลูกค้า) เข้าถึงหรือไม่
 *
 * PUBLIC และ INTERNAL ยอม แต่ **ยังต้องมีการแชร์โดยตรงอยู่ดี** พื้นที่ลูกค้าไม่เคยเปิดกว้าง
 * ด้วยตัวมันเอง ทุกการเข้าถึงมาจากสิทธิ์ที่มีคนตั้งใจให้ ชั้นความลับจึงเป็นเพดาน
 * ไม่ใช่ประตู ส่วน CONFIDENTIAL และ RESTRICTED ปิดช่องทางภายนอกทั้งหมด
 */
export function allowsExternalAccess(level: ResourceClassification): boolean {
  return level === 'PUBLIC' || level === 'INTERNAL';
}

/**
 * RESTRICTED ต้องสอดคล้องกับการจำกัดภายในด้วย
 *
 * **ทำไมต้องมีกฎนี้:** ถ้าไม่มี RESTRICTED กับ CONFIDENTIAL จะบังคับใช้เหมือนกันทุกอย่าง
 * ในขอบเขตการเปิดเผยออกนอก แล้ว RESTRICTED จะกลายเป็นป้ายที่ฟังดูเข้มกว่าแต่ไม่ได้ทำอะไรเพิ่ม
 * ซึ่งเป็นการโกหกผู้ใช้ กฎนี้ทำให้ RESTRICTED มีความหมายที่บังคับใช้ได้จริง:
 * "ปิดช่องทางภายนอกทั้งหมด **และ** ภายในต้องจำกัดอยู่แล้วด้วย"
 *
 * **ไม่แก้ visibility ให้เอง** เพราะการเปลี่ยน visibility คือการถอนสิทธิ์ของคนที่เคยเข้าถึงได้
 * ซึ่งต้องเป็นการตัดสินใจที่มีคนกดเอง ไม่ใช่ผลข้างเคียงของการตั้งป้าย
 */
export function requiresRestrictedVisibility(level: ResourceClassification): boolean {
  return level === 'RESTRICTED';
}

export function satisfiesVisibilityInvariant(
  level: ResourceClassification,
  visibility: ResourceVisibility,
): boolean {
  return !requiresRestrictedVisibility(level) || visibility === 'RESTRICTED';
}

export interface ClassificationRestrictions {
  /** ลิงก์สาธารณะถูกปิดโดยนโยบายชั้นความลับ */
  publicLinkBlocked: boolean;
  /** การเข้าถึงจากพื้นที่ลูกค้าถูกปิดโดยนโยบายชั้นความลับ */
  externalAccessBlocked: boolean;
  level: ResourceClassification;
}

export function classificationRestrictions(level: ResourceClassification): ClassificationRestrictions {
  return {
    publicLinkBlocked: !allowsAnonymousLink(level),
    externalAccessBlocked: !allowsExternalAccess(level),
    level,
  };
}

/** ป้ายภาษาไทยที่ใช้ตรงกันทุกที่ ทั้งหน้าจอ รายงาน และข้อความผิดพลาด */
export const CLASSIFICATION_LABEL: Record<ResourceClassification, string> = {
  PUBLIC: 'สาธารณะ',
  INTERNAL: 'ภายใน',
  CONFIDENTIAL: 'ลับ',
  RESTRICTED: 'จำกัดการเข้าถึง',
};

/**
 * ชั้นที่ผู้เยี่ยมชมแบบไม่ระบุตัวตนเห็นได้ - รูปแบบที่ส่งให้ฐานข้อมูลกรองได้โดยตรง
 *
 * คำนวณจาก allowsAnonymousLink ไม่ใช่เขียนรายชื่อซ้ำ ถ้าวันหนึ่งนโยบายเปลี่ยน
 * ตัวกรองใน SQL จะเปลี่ยนตามเอง ไม่กลายเป็นสำเนาที่ค้างอยู่กับกฎเมื่อวาน
 */
export const GUEST_VISIBLE_CLASSIFICATIONS: ResourceClassification[] =
  CLASSIFICATION_ORDER.filter(allowsAnonymousLink);

/**
 * ชั้นที่ผู้ใช้ภายนอก (พื้นที่ลูกค้า) เข้าถึงได้ - รูปแบบที่ส่งให้ฐานข้อมูลกรองได้โดยตรง (F26-A1)
 *
 * คู่ขนานกับ GUEST_VISIBLE_CLASSIFICATIONS และคำนวณจาก allowsExternalAccess ด้วยเหตุผลเดียวกัน
 * คือไม่เขียนรายชื่อชั้นซ้ำไว้อีกที่ ถ้านโยบายเปลี่ยน ตัวกรองใน SQL ต้องเปลี่ยนตามเอง
 *
 * สองช่องทางนี้แยกค่ากันจริง ๆ ไม่ใช่ค่าเดียวกันที่ตั้งชื่อสองชื่อ - ลิงก์ไม่ระบุตัวตนเปิดได้
 * เฉพาะชั้นสาธารณะ ส่วนพื้นที่ลูกค้าเปิดได้ถึงชั้นภายในด้วย เพราะมีบัญชีและมีการมอบสิทธิ์กำกับอยู่
 */
export const PORTAL_VISIBLE_CLASSIFICATIONS: ResourceClassification[] =
  CLASSIFICATION_ORDER.filter(allowsExternalAccess);
