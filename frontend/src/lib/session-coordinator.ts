/**
 * S2 NAS - Cross-tab session coordinator
 *
 * ปัญหาที่แก้: refresh token หมุนทุกครั้งที่เรียก /auth/session หรือ /auth/refresh
 * ถ้าหลายแท็บ bootstrap พร้อมกัน แท็บที่สองจะส่ง cookie ใบเดิมที่เพิ่งถูกหมุนไปแล้ว
 * แล้วถูกปฏิเสธ ทำให้ผู้ใช้หลุดออกจากระบบทั้งที่ session ยังใช้งานได้
 *
 * วิธีแก้: จัดคิวให้เรียกทีละแท็บด้วย Web Locks
 * เมื่อแท็บ A หมุน cookie เสร็จ เบราว์เซอร์จะเก็บ cookie ใบใหม่ให้ทุกแท็บทันที
 * แท็บ B ที่รอคิวอยู่จึงส่ง cookie ใบใหม่และผ่านตามปกติ
 *
 * ผลที่ตามมาสำคัญ: ไม่ต้องส่ง access token ข้ามแท็บเลย แต่ละแท็บได้ token ของตัวเอง
 * จากเซิร์ฟเวอร์โดยตรง และ refresh token ยังอยู่ใน HttpOnly cookie เท่านั้น
 *
 * ข้อมูลที่ประกาศข้ามแท็บมีแค่ชนิดเหตุการณ์กับเวลาเท่านั้น
 * ไม่มี token ไม่มีข้อมูลผู้ใช้ ไม่มีความลับใด ๆ
 */

/** ชื่อช่องสื่อสารระหว่างแท็บ */
export const AUTH_CHANNEL_NAME = 's2-nas-auth';

/** ชื่อ lock ที่ใช้จัดคิวการกู้คืน/ต่ออายุ session */
export const SESSION_LOCK_NAME = 's2-nas-session-refresh';

/** รอคิวนานสุดก่อนยอมทำงานเองโดยไม่ถือ lock */
export const LOCK_TIMEOUT_MS = 5_000;

export type AuthEventType = 'LOGIN' | 'LOGOUT' | 'PASSWORD_CHANGED';

export interface AuthEvent {
  type: AuthEventType;
  /** เวลาที่เกิดเหตุการณ์ ใช้ลำดับเหตุการณ์และตัดข้อความเก่าทิ้ง */
  at: number;
  /** รหัสสุ่มประจำแท็บ ใช้กรองข้อความของตัวเองเท่านั้น ไม่ผูกกับผู้ใช้หรือ session */
  from: string;
}

/**
 * รหัสประจำแท็บ สร้างใหม่ทุกครั้งที่โหลดหน้า
 *
 * BroadcastChannel ไม่ส่งข้อความกลับไปยัง "อ็อบเจกต์" ที่ส่ง แต่ยังส่งถึงช่องอื่น
 * ในแท็บเดียวกัน เนื่องจากการประกาศใช้ช่องชั่วคราวคนละตัวกับช่องที่ใช้รับ
 * แท็บผู้ส่งจึงได้ยินเสียงตัวเองและ bootstrap ซ้ำโดยไม่จำเป็น รหัสนี้ใช้กรองกรณีนั้นออก
 */
const TAB_ID = (() => {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
  } catch {
    /* ใช้ค่าสำรองด้านล่าง */
  }
  return `tab-${Math.random().toString(36).slice(2)}-${Date.now()}`;
})();

/* ------------------------------------------------------------------ */
/* Web Locks                                                           */
/* ------------------------------------------------------------------ */

interface LockManagerLike {
  request<T>(
    name: string,
    options: { mode?: 'exclusive' | 'shared'; signal?: AbortSignal },
    callback: () => Promise<T>,
  ): Promise<T>;
}

export interface CoordinatorDeps {
  /** ใส่เองได้เพื่อการทดสอบ ค่า null คือ "เบราว์เซอร์นี้ไม่รองรับ" */
  locks?: LockManagerLike | null;
  channelFactory?: ((name: string) => BroadcastChannelLike) | null;
  timeoutMs?: number;
  /** ใส่เองได้เพื่อจำลองหลายแท็บในการทดสอบ ปกติใช้รหัสประจำแท็บจริง */
  tabId?: string;
}

function defaultLocks(): LockManagerLike | null {
  if (typeof navigator === 'undefined') return null;
  const locks = (navigator as Navigator & { locks?: LockManagerLike }).locks;
  return locks && typeof locks.request === 'function' ? locks : null;
}

function abortSignalAfter(ms: number): AbortSignal | undefined {
  if (typeof AbortSignal === 'undefined') return undefined;
  if (typeof AbortSignal.timeout === 'function') return AbortSignal.timeout(ms);
  if (typeof AbortController === 'undefined') return undefined;
  const controller = new AbortController();
  setTimeout(() => controller.abort(), ms);
  return controller.signal;
}

/**
 * รัน task โดยให้มีแท็บเดียวทำงานพร้อมกันทั้ง origin
 *
 * ถ้าเบราว์เซอร์ไม่รองรับ Web Locks หรือรอคิวนานเกินกำหนด จะยอมให้ทำงานเองทันที
 * เพื่อไม่ให้การยืนยันตัวตนค้าง (fail-safe ไม่ใช่ fail-closed)
 */
export async function runExclusive<T>(task: () => Promise<T>, deps: CoordinatorDeps = {}): Promise<T> {
  const locks = deps.locks === undefined ? defaultLocks() : deps.locks;
  if (!locks) return task();

  // แยกให้ชัดว่า error มาจากการรอ lock หรือมาจากตัว task เอง
  // ถ้า task เริ่มทำงานไปแล้ว ห้ามรันซ้ำเด็ดขาด
  let taskStarted = false;
  const guarded = () => {
    taskStarted = true;
    return task();
  };

  try {
    return await locks.request(
      SESSION_LOCK_NAME,
      { mode: 'exclusive', signal: abortSignalAfter(deps.timeoutMs ?? LOCK_TIMEOUT_MS) },
      guarded,
    );
  } catch (error) {
    if (taskStarted) throw error;
    // ขอ lock ไม่สำเร็จ (timeout หรือเบราว์เซอร์ปฏิเสธ) ทำงานเองโดยไม่ถือ lock
    return task();
  }
}

/* ------------------------------------------------------------------ */
/* BroadcastChannel                                                    */
/* ------------------------------------------------------------------ */

export interface BroadcastChannelLike {
  postMessage(message: unknown): void;
  close(): void;
  onmessage: ((event: { data: unknown }) => void) | null;
}

export interface AuthChannel {
  publish(type: AuthEventType): void;
  subscribe(listener: (event: AuthEvent) => void): () => void;
  close(): void;
  readonly available: boolean;
}

const NOOP_CHANNEL: AuthChannel = {
  publish: () => undefined,
  subscribe: () => () => undefined,
  close: () => undefined,
  available: false,
};

function defaultChannelFactory(name: string): BroadcastChannelLike | null {
  if (typeof BroadcastChannel === 'undefined') return null;
  return new BroadcastChannel(name) as unknown as BroadcastChannelLike;
}

function isAuthEvent(value: unknown): value is AuthEvent {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<AuthEvent>;
  return (
    (candidate.type === 'LOGIN' || candidate.type === 'LOGOUT' || candidate.type === 'PASSWORD_CHANGED') &&
    typeof candidate.at === 'number' &&
    typeof candidate.from === 'string'
  );
}

/**
 * ช่องประกาศเหตุการณ์ยืนยันตัวตนระหว่างแท็บ
 *
 * ส่งเฉพาะ { type, at, from } เท่านั้น ห้ามใส่ token, cookie, รหัสผ่าน หรือข้อมูลผู้ใช้
 * ถ้าเบราว์เซอร์ไม่รองรับ BroadcastChannel จะคืนช่องเปล่าที่ไม่ทำอะไร
 * แต่ละแท็บยังทำงานได้ตามปกติ เพียงแค่ไม่ซิงก์กันทันที
 */
export function createAuthChannel(deps: CoordinatorDeps = {}): AuthChannel {
  const factory = deps.channelFactory === undefined ? defaultChannelFactory : deps.channelFactory;
  const channel = factory ? factory(AUTH_CHANNEL_NAME) : null;
  if (!channel) return NOOP_CHANNEL;

  const tabId = deps.tabId ?? TAB_ID;

  const listeners = new Set<(event: AuthEvent) => void>();

  channel.onmessage = (event) => {
    if (!isAuthEvent(event.data)) return;
    for (const listener of listeners) listener(event.data);
  };

  return {
    available: true,
    publish(type) {
      try {
        channel.postMessage({ type, at: Date.now(), from: tabId } satisfies AuthEvent);
      } catch {
        // แท็บกำลังถูกปิดหรือช่องถูกปิดไปแล้ว ไม่ใช่เรื่องที่ต้องทำให้ผู้ใช้เห็น
      }
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    close() {
      listeners.clear();
      try {
        channel.close();
      } catch {
        /* ปิดซ้ำไม่เป็นไร */
      }
    },
  };
}

/**
 * ประกาศเหตุการณ์หนึ่งครั้งแล้วปิดช่องทันที
 *
 * แยกออกจากช่องที่ใช้รับข้อความ เพื่อไม่ให้การประกาศผูกกับวงจรชีวิตของ component
 * (React Strict Mode ใน development จะ mount/unmount รอบพิเศษ ถ้าใช้ช่องเดียวกัน
 * การ cleanup รอบแรกจะปิดช่องทิ้งจนแท็บนั้นไม่ได้รับข้อความอีกเลย)
 */
export function publishAuthEvent(type: AuthEventType, deps: CoordinatorDeps = {}): void {
  const channel = createAuthChannel(deps);
  if (!channel.available) return;
  channel.publish(type);
  channel.close();
}

/**
 * รับฟังเหตุการณ์ยืนยันตัวตนจากแท็บอื่น
 * คืนฟังก์ชันสำหรับยกเลิกการรับฟังพร้อมปิดช่องให้เรียบร้อย
 */
export function subscribeAuthEvents(
  listener: (event: AuthEvent) => void,
  deps: CoordinatorDeps = {},
): () => void {
  const channel = createAuthChannel(deps);
  if (!channel.available) return () => undefined;

  const tabId = deps.tabId ?? TAB_ID;
  channel.subscribe((event) => {
    // ไม่ต้องตอบสนองต่อเหตุการณ์ที่แท็บนี้เป็นคนประกาศเอง
    if (event.from === tabId) return;
    listener(event);
  });
  return () => channel.close();
}
