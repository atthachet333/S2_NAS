import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from 'node:crypto';
import { AppError } from '../../core/errors.js';

/**
 * การเข้ารหัสข้อมูลรับรองของการเชื่อมต่อภายนอก (F19)
 *
 * refresh token ของ Google คือกุญแจที่เปิด Google Drive ของพนักงานได้นานหลายเดือน
 * ฐานข้อมูลที่รั่วโดยเก็บมันไว้เป็นข้อความธรรมดา = Drive ของทุกคนรั่วไปพร้อมกัน
 *
 * ใช้ AES-256-GCM ซึ่งเป็นการเข้ารหัสแบบยืนยันตัวตน (authenticated encryption)
 * ไม่ใช่แค่ปกปิดเนื้อหา แต่ยังตรวจจับได้ด้วยว่ามีใครแก้ไบต์ในฐานข้อมูลหรือไม่
 * โหมดที่ไม่ยืนยันตัวตน เช่น CBC เปิดช่องให้แก้ ciphertext แล้ว plaintext เปลี่ยนตาม
 * โดยที่ระบบไม่รู้ตัว
 */

/** AES-256 ต้องการกุญแจ 32 ไบต์พอดี ไม่มีการยืดหรือตัดให้เอง */
const KEY_BYTES = 32;

/** ความยาว IV ที่แนะนำสำหรับ GCM - 96 บิต ให้ประสิทธิภาพและความปลอดภัยดีที่สุด */
const IV_BYTES = 12;

/** แท็กยืนยันตัวตนของ GCM */
const TAG_BYTES = 16;

/** เวอร์ชันของรูปแบบ - เผื่อวันหนึ่งต้องเปลี่ยนอัลกอริทึมโดยยังอ่านของเก่าได้ */
const FORMAT = 'v1';

/**
 * ตรวจกุญแจว่าใช้งานได้จริง
 *
 * รับเป็น base64 หรือ hex ที่ถอดแล้วได้ 32 ไบต์พอดี
 *
 * **ไม่สร้างกุญแจใหม่ให้อัตโนมัติเมื่อไม่พบ** เพราะกุญแจใหม่จะทำให้ข้อมูลรับรอง
 * ที่เข้ารหัสไว้เดิมอ่านไม่ออกทั้งหมด และระบบจะดู "ทำงานปกติ" จนกว่าจะมีคนกดซิงก์
 * แล้วพบว่าทุกการเชื่อมต่อพังพร้อมกันโดยไม่มีใครรู้สาเหตุ
 */
export function parseEncryptionKey(raw: string | undefined): Buffer | null {
  if (!raw) return null;

  const value = raw.trim();
  if (value.length === 0) return null;

  // hex ยาว 64 ตัวอักษร = 32 ไบต์
  const fromHex = /^[0-9a-fA-F]{64}$/.test(value) ? Buffer.from(value, 'hex') : null;
  if (fromHex?.length === KEY_BYTES) return fromHex;

  try {
    const fromBase64 = Buffer.from(value, 'base64');
    if (fromBase64.length === KEY_BYTES) return fromBase64;
  } catch {
    /* ไม่ใช่ base64 ที่ถูกต้อง */
  }

  return null;
}

export class CredentialCipher {
  private readonly key: Buffer;

  constructor(key: Buffer) {
    if (key.length !== KEY_BYTES) {
      throw new Error(`กุญแจเข้ารหัสต้องยาว ${KEY_BYTES} ไบต์ แต่ได้ ${key.length}`);
    }
    this.key = key;
  }

  /**
   * เข้ารหัสข้อความลับ
   *
   * IV สุ่มใหม่ทุกครั้ง - นี่ไม่ใช่ทางเลือก แต่เป็นข้อบังคับของ GCM
   * การใช้ IV ซ้ำกับกุญแจเดิมทำให้กู้ plaintext ได้โดยไม่ต้องรู้กุญแจเลย
   *
   * ผลพลอยได้: การเข้ารหัสค่าเดิมสองครั้งได้ ciphertext ต่างกัน ผู้ที่เห็นฐานข้อมูล
   * จึงบอกไม่ได้ว่าผู้ใช้สองคนมี token เดียวกันหรือไม่
   */
  encrypt(plaintext: string): string {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();

    return [FORMAT, iv.toString('base64'), tag.toString('base64'), ciphertext.toString('base64')].join(
      ':',
    );
  }

  /**
   * ถอดรหัส
   *
   * โยนข้อผิดพลาดเมื่อกุญแจผิด รูปแบบผิด หรือไบต์ถูกแก้ - ไม่คืนค่าที่เดาเอา
   *
   * ผู้เรียกต้องแปลผลนี้เป็น "ต้องเชื่อมต่อใหม่" ไม่ใช่ "ลบข้อมูลทิ้ง"
   * กุญแจที่หายไปเป็นปัญหาของการดำเนินงาน ไม่ใช่เหตุผลให้ทำลายข้อมูลของผู้ใช้
   */
  decrypt(payload: string): string {
    const parts = payload.split(':');
    if (parts.length !== 4 || parts[0] !== FORMAT) {
      throw new AppError('CREDENTIAL_UNREADABLE', 'ข้อมูลรับรองอ่านไม่ได้', 500);
    }

    const iv = Buffer.from(parts[1]!, 'base64');
    const tag = Buffer.from(parts[2]!, 'base64');
    const ciphertext = Buffer.from(parts[3]!, 'base64');

    if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) {
      throw new AppError('CREDENTIAL_UNREADABLE', 'ข้อมูลรับรองอ่านไม่ได้', 500);
    }

    try {
      const decipher = createDecipheriv('aes-256-gcm', this.key, iv);
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
    } catch {
      /**
       * ถึงตรงนี้แปลว่ากุญแจผิดหรือไบต์ถูกแก้ - GCM แยกสองกรณีนี้ไม่ได้ และไม่ควรแยก
       * เพราะการบอกผู้โจมตีว่า "กุญแจถูกแต่ข้อมูลเสีย" ก็เป็นข้อมูลอย่างหนึ่ง
       */
      throw new AppError('CREDENTIAL_UNREADABLE', 'ข้อมูลรับรองอ่านไม่ได้', 500);
    }
  }
}

/**
 * ตัวเข้ารหัสของทั้งระบบ
 *
 * สร้างครั้งเดียวตอนเริ่มระบบ ถ้าไม่มีกุญแจก็เป็น null และการเชื่อมต่อ Google Drive
 * จะถูกปิดทั้งฟีเจอร์ แทนที่จะทำงานครึ่ง ๆ กลาง ๆ แล้วเก็บ token เป็นข้อความธรรมดา
 */
let cipher: CredentialCipher | null = null;
let configured = false;

export function initCredentialCipher(rawKey: string | undefined): { ready: boolean; reason?: string } {
  configured = true;
  const key = parseEncryptionKey(rawKey);

  if (!key) {
    cipher = null;
    return {
      ready: false,
      reason: rawKey
        ? 'กุญแจเข้ารหัสไม่ถูกต้อง - ต้องเป็น base64 หรือ hex ที่ถอดแล้วได้ 32 ไบต์'
        : 'ยังไม่ได้ตั้งค่ากุญแจเข้ารหัสข้อมูลรับรอง',
    };
  }

  cipher = new CredentialCipher(key);
  return { ready: true };
}

export function credentialCipher(): CredentialCipher {
  if (!configured) initCredentialCipher(process.env.S2_NAS_INTEGRATION_ENCRYPTION_KEY);
  if (!cipher) {
    throw new AppError(
      'INTEGRATION_ENCRYPTION_UNAVAILABLE',
      'ยังไม่ได้ตั้งค่ากุญแจเข้ารหัสข้อมูลรับรอง จึงใช้การเชื่อมต่อภายนอกไม่ได้',
      503,
    );
  }
  return cipher;
}

export function credentialCipherReady(): boolean {
  if (!configured) initCredentialCipher(process.env.S2_NAS_INTEGRATION_ENCRYPTION_KEY);
  return cipher !== null;
}

/** ใช้ในชุดทดสอบเพื่อสลับกุญแจโดยไม่ต้องแตะสิ่งแวดล้อมจริง */
export function setCredentialCipherForTest(key: Buffer | null): void {
  configured = true;
  cipher = key ? new CredentialCipher(key) : null;
}

/**
 * เทียบค่าลับแบบไม่ให้เวลาบอกใบ้ - ใช้กับ state ของ OAuth
 */
export function secretEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}
