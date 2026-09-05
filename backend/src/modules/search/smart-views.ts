/**
 * มุมมองอัจฉริยะ
 *
 * เป็น "ชุดเงื่อนไขสำเร็จรูป" ไม่ใช่โฟลเดอร์
 *
 * ไม่มีการคัดลอกหรือย้ายทรัพยากรใด ๆ เอกสารหนึ่งฉบับปรากฏในหลายมุมมองพร้อมกันได้
 * และหายไปจากมุมมองเองเมื่อสถานะของมันเปลี่ยน โดยไม่ต้องมีใครมาจัดระเบียบ
 *
 * ทุกมุมมองเดินผ่าน searchResources() ตัวเดียวกับการค้นหาปกติ จึงผ่านด่านสิทธิ์
 * ชุดเดียวกันทั้งหมด มุมมองอัจฉริยะไม่ใช่ทางลัดข้ามสิทธิ์ และไม่มีสิทธิ์พิเศษใด ๆ
 */
import type { SearchFilters } from './search-filters.js';

export interface SmartView {
  /** ใช้ใน URL - คงที่ แม้ชื่อที่แสดงจะถูกแก้ */
  slug: string;
  name: string;
  /** อธิบายให้ผู้ใช้รู้ว่ามุมมองนี้คัดอะไรมา ไม่ใช่ให้เดาเอาเอง */
  description: string;
  filters: SearchFilters;
  /**
   * ต้องแทนที่ ownerId ด้วยรหัสของผู้เรียกหรือไม่
   *
   * เก็บเป็นธงแทนการฝังรหัสผู้ใช้ไว้ในค่าคงที่ เพราะค่าคงที่ถูกสร้างครั้งเดียว
   * ตอนโหลดโมดูล ส่วนผู้เรียกเปลี่ยนไปทุกคำขอ
   */
  scopeToViewer?: boolean;
}

/**
 * มุมมองที่มากับระบบ
 *
 * จงใจให้มีจำนวนน้อยและทุกอันตอบคำถามที่คนถามจริง ๆ ในการทำงานประจำวัน
 * การใส่มุมมองสำเร็จรูปมาสามสิบอันจะทำให้ไม่มีใครใช้อันไหนเลย
 */
export const SMART_VIEWS: SmartView[] = [
  {
    slug: 'needs-review',
    name: 'ต้องตรวจ OCR',
    description: 'เอกสารที่เครื่องอ่านข้อความมาแล้ว แต่ยังไม่มีคนตรวจ',
    // ไม่รวมเอกสารที่มีข้อความอยู่ในไฟล์จริง เพราะไม่ได้ผ่านการเดาของเครื่อง
    filters: { ocrState: 'OCR_DONE', textSource: 'OCR', sort: 'oldest' },
  },
  {
    slug: 'ocr-failed',
    name: 'OCR ล้มเหลว',
    description: 'เอกสารที่สั่งอ่านข้อความแล้วไม่สำเร็จ ต้องมีคนเข้าไปจัดการ',
    filters: { ocrState: 'FAILED', sort: 'newest' },
  },
  {
    slug: 'reviewed',
    name: 'ตรวจแก้แล้ว',
    description: 'เอกสารที่มีคนอ่านด้วยตาแล้วยืนยันหรือแก้ข้อความให้ถูกต้อง',
    filters: { ocrState: 'REVIEWED', sort: 'newest' },
  },
  {
    slug: 'client-uploads',
    name: 'ลูกค้าอัปโหลด',
    description: 'ไฟล์ที่ผู้ใช้ภายนอกส่งเข้ามาผ่านพื้นที่ลูกค้า',
    filters: { sourceType: 'EXTERNAL_UPLOAD', sort: 'newest' },
  },
  {
    slug: 'recent',
    name: 'ไฟล์ล่าสุด',
    description: 'ไฟล์ที่เพิ่งอัปโหลดเข้ามาใน 7 วันที่ผ่านมา',
    filters: { uploadedPreset: 'last7', sort: 'newest' },
  },
  {
    slug: 'large-files',
    name: 'ไฟล์ขนาดใหญ่',
    description: 'ไฟล์ที่กินพื้นที่มากที่สุด ใช้ตรวจก่อนพื้นที่เต็ม',
    filters: { sort: 'largest' },
  },
  {
    slug: 'untagged',
    name: 'เอกสารที่ไม่มี Tag',
    description: 'เอกสารที่ยังไม่ถูกจัดระเบียบ มักเป็นของที่ตกหล่นจากขั้นตอนปกติ',
    filters: { untaggedOnly: true, sort: 'newest' },
  },
  {
    slug: 'uncategorized',
    name: 'ยังไม่ระบุประเภทเอกสาร',
    description: 'เอกสารที่ยังไม่ได้กำหนดประเภท',
    filters: { uncategorizedOnly: true, sort: 'newest' },
  },
  {
    slug: 'my-responsibility',
    name: 'เอกสารที่ฉันดูแล',
    description: 'เอกสารที่คุณเป็นผู้ดูแล ไม่ใช่เอกสารที่คุณเป็นคนอัปโหลด',
    /**
     * ใช้ "ผู้ดูแล" (ownerId) ไม่ใช่ "ผู้สร้าง" (createdById)
     *
     * สองอย่างนี้ต่างกันและมักไม่ใช่คนเดียวกัน - ธุรการอัปโหลดเอกสารให้ฝ่ายบัญชี
     * คนที่ต้องรับผิดชอบคือฝ่ายบัญชี ไม่ใช่ธุรการที่กดอัปโหลด
     */
    filters: { sort: 'newest' },
    scopeToViewer: true,
  },
];

export function findSmartView(slug: string): SmartView | null {
  return SMART_VIEWS.find((view) => view.slug === slug) ?? null;
}

/** ตัวกรองของมุมมอง หลังผูกกับผู้เรียกแล้ว */
export function smartViewFilters(view: SmartView, viewerId: string): SearchFilters {
  return view.scopeToViewer ? { ...view.filters, ownerId: viewerId } : { ...view.filters };
}
