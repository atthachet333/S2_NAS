import type { Readable } from 'node:stream';

/**
 * สัญญาของผู้ให้บริการพื้นที่จัดเก็บ (F23-A/B)
 *
 * **เหตุผลที่ต้องมีสัญญานี้:** ชั้นธุรกิจของ NAS ไม่ควรรู้ว่าไบต์ของไฟล์ไปอยู่ที่ไหน
 * ก่อนหน้านี้การอ่านเขียนไฟล์เป็นฟังก์ชันอิสระที่ผูกกับ node:fs โดยตรง และ
 * `resolveStorageKey` ที่แปลงคีย์เป็นเส้นทางบนดิสก์ถูกเรียกจากหลายโมดูล
 * ทุกจุดแบบนั้นคือที่ที่ผู้ให้บริการรายใหม่จะพัง
 *
 * **สิ่งที่สัญญานี้ไม่ทำ:** ไม่ตัดสินใจเรื่องสิทธิ์ ผู้เรียกต้องตรวจสิทธิ์ให้เสร็จก่อนเสมอ
 * ผู้ให้บริการเห็นเพียงคีย์ ไม่รู้ว่าใครขอและไม่มีหน้าที่ถาม
 *
 * **ไม่มี move() โดยตั้งใจ:** การย้ายโฟลเดอร์ใน NAS เป็นการเปลี่ยน metadata เท่านั้น
 * ลำดับชั้นที่ผู้ใช้เห็นไม่ใช่ลำดับชั้นของที่เก็บจริง การเพิ่ม move() เข้ามาในสัญญา
 * จะเปิดทางให้มีคนเผลอคัดลอกไฟล์หลายกิกะไบต์เพราะผู้ใช้ลากไฟล์ข้ามโฟลเดอร์
 */

export type StorageProviderKind = 'LOCAL' | 'S3';

export interface StorageStat {
  size: number;
  mtime: Date;
}

/**
 * สถานะของพื้นที่จัดเก็บ
 *
 * แยก NOT_CONFIGURED ออกจาก UNAVAILABLE เพราะสองอย่างนี้ต้องการการแก้ต่างกัน
 * อันแรกคือยังไม่ได้ตั้งค่า อันหลังคือตั้งค่าแล้วแต่ติดต่อไม่ได้
 */
export type StorageHealthStatus = 'READY' | 'NOT_CONFIGURED' | 'DEGRADED' | 'UNAVAILABLE';

export interface StorageHealth {
  status: StorageHealthStatus;
  /** ข้อความอธิบายที่ปลอดภัยต่อการแสดงผล ห้ามมีความลับหรือเส้นทางเต็ม */
  detail?: string;
}

/** ผลของการเขียนวัตถุหนึ่งชิ้น - ขนาดและ checksum ที่วัดจากไบต์จริง */
export interface StoredObject {
  size: number;
  checksum: string;
}

/** ไฟล์ที่พักไว้ระหว่างอัปโหลด พร้อมค่าที่วัดได้ตอนสตรีมผ่าน */
export interface StagedObject {
  path: string;
  size: number;
  checksum: string;
}

export interface StorageProvider {
  readonly kind: StorageProviderKind;

  /**
   * สร้างคีย์ของวัตถุใหม่
   *
   * คีย์เป็นตัวระบุภายในล้วน ๆ ไม่ขึ้นกับชื่อไฟล์ที่ผู้ใช้ตั้ง และไม่เปลี่ยนตามโฟลเดอร์
   * ที่ไฟล์ถูกแสดง การเปลี่ยนชื่อไฟล์หรือย้ายโฟลเดอร์จึงไม่แตะไบต์แม้แต่ไบต์เดียว
   */
  createStorageKey(resourceId: string): string;

  /** เตรียมที่ทางของทรัพยากรก่อนเขียนวัตถุชิ้นแรก - ผู้ให้บริการที่ไม่ต้องเตรียมอะไรก็ทำว่าง ๆ ได้ */
  prepare(resourceId: string): Promise<void>;

  /** เขียนวัตถุจากสตรีม พร้อมคืนขนาดและ checksum ที่วัดจากไบต์ที่เขียนจริง */
  put(key: string, source: Readable): Promise<StoredObject>;

  /**
   * ย้ายไฟล์ที่พักไว้เข้าเป็นวัตถุจริง
   *
   * แยกจาก put() เพราะเส้นทางอัปโหลดของ NAS พักไฟล์ไว้ก่อนเพื่อคำนวณ checksum
   * ตรวจชนิดไฟล์จริง และตรวจเนื้อหาซ้ำ ก่อนจะตัดสินใจว่าจะเก็บหรือทิ้ง
   * ผู้ให้บริการบนดิสก์เดียวกันจึงทำได้ด้วยการ rename ซึ่งเร็วและไม่ต้องอ่านซ้ำ
   */
  commitStaged(key: string, staged: StagedObject): Promise<void>;

  getStream(key: string): Promise<Readable>;

  /** ช่วงไบต์แบบรวมปลายทั้งสองด้าน ตรงกับความหมายของ HTTP Range */
  getRangeStream(key: string, start: number, end: number): Promise<Readable>;

  stat(key: string): Promise<StorageStat | null>;

  exists(key: string): Promise<boolean>;

  /** คืน true เมื่อวัตถุไม่เหลืออยู่แล้ว รวมถึงกรณีที่ไม่มีมาตั้งแต่ต้น */
  delete(key: string): Promise<boolean>;

  copy(fromKey: string, toKey: string): Promise<void>;

  /** เก็บกวาดทุกวัตถุของทรัพยากรหนึ่งเมื่อไม่มีเวอร์ชันเหลือแล้ว */
  removeResourceScope(resourceId: string): Promise<void>;

  health(): Promise<StorageHealth>;

  /**
   * เส้นทางบนดิสก์ของวัตถุ ถ้ามี - ช่องทางเข้ากันได้สำหรับผู้บริโภคที่ต้องการ path จริง
   *
   * **ห้ามใช้เป็น API ของชั้นธุรกิจ** มีไว้สำหรับตัวสกัดข้อความและ OCR ซึ่งเรียก
   * ไลบรารีและโปรแกรมภายนอกที่รับได้เฉพาะเส้นทางไฟล์เท่านั้น ผู้ให้บริการที่ไม่มี
   * ไฟล์บนดิสก์ต้องคืน null อย่างซื่อตรง แล้วให้ผู้เรียกจัดการเอง ไม่ใช่แกล้งมีเส้นทางปลอม
   */
  localPathFor(key: string): string | null;
}
