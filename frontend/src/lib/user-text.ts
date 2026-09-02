/**
 * คำอธิบายสถานะบัญชีผู้ใช้
 *
 * แยกเป็นโมดูลอิสระเพื่อให้ทดสอบได้ตรง ๆ และให้ทุกหน้าที่แสดงผู้ใช้พูดภาษาเดียวกัน
 * สถานะทั้งสี่มาจาก enum จริงในฐานข้อมูล ไม่ได้ประดิษฐ์เพิ่ม
 */

export type UserStatusCode = 'INVITED' | 'ACTIVE' | 'SUSPENDED' | 'DISABLED';

export type StatusTone = 'positive' | 'neutral' | 'warning' | 'danger';

interface StatusMeta {
  label: string;
  tone: StatusTone;
  hint: string;
}

const STATUS_TEXT: Record<UserStatusCode, StatusMeta> = {
  ACTIVE: {
    label: 'เปิดใช้งาน',
    tone: 'positive',
    hint: 'เข้าสู่ระบบได้ และรับการแชร์ทรัพยากรได้',
  },
  INVITED: {
    label: 'รอเปิดใช้งาน',
    tone: 'warning',
    hint: 'ยังเข้าสู่ระบบไม่ได้ ต้องให้ผู้ดูแลตั้งรหัสผ่านชั่วคราวก่อน',
  },
  SUSPENDED: {
    label: 'ระงับชั่วคราว',
    tone: 'warning',
    hint: 'เข้าสู่ระบบไม่ได้ชั่วคราว',
  },
  DISABLED: {
    label: 'ปิดใช้งาน',
    tone: 'danger',
    hint: 'เข้าสู่ระบบไม่ได้ และรับการแชร์ใหม่ไม่ได้',
  },
};

export function userStatusLabel(status: string): string {
  return STATUS_TEXT[status as UserStatusCode]?.label ?? status;
}

export function userStatusTone(status: string): StatusTone {
  return STATUS_TEXT[status as UserStatusCode]?.tone ?? 'neutral';
}

export function userStatusHint(status: string): string {
  return STATUS_TEXT[status as UserStatusCode]?.hint ?? '';
}

/** เปิดใช้งานได้เฉพาะบัญชีที่ยังเข้าสู่ระบบไม่ได้ */
export function canActivate(status: string): boolean {
  return status !== 'ACTIVE';
}

/** ปิดได้เฉพาะบัญชีที่ยังใช้งานอยู่ และต้องไม่ใช่ตัวเอง */
export function canDisable(status: string, isSelf: boolean): boolean {
  return status === 'ACTIVE' && !isSelf;
}
