import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';
import {
  AUTH_CHANNEL_NAME,
  SESSION_LOCK_NAME,
  createAuthChannel,
  publishAuthEvent,
  runExclusive,
  subscribeAuthEvents,
  type BroadcastChannelLike,
} from './session-coordinator.ts';

/* ------------------------------------------------------------------ */
/* ตัวช่วยจำลองพฤติกรรมเบราว์เซอร์                                      */
/* ------------------------------------------------------------------ */

const tick = (ms = 5) => new Promise((resolve) => setTimeout(resolve, ms));

/** จำลอง navigator.locks ที่จัดคิวจริงตามชื่อ lock */
function createFakeLocks() {
  const tails = new Map<string, Promise<void>>();
  const seen: string[] = [];

  return {
    seen,
    async request<T>(name: string, _options: unknown, callback: () => Promise<T>): Promise<T> {
      seen.push(name);
      const previous = tails.get(name) ?? Promise.resolve();
      let release!: () => void;
      const current = new Promise<void>((resolve) => {
        release = resolve;
      });
      tails.set(name, previous.then(() => current));
      await previous;
      try {
        return await callback();
      } finally {
        release();
      }
    },
  };
}

/**
 * จำลองเซิร์ฟเวอร์ที่หมุน refresh token ทุกครั้งที่สำเร็จ
 * cookieJar เป็นตัวแทน cookie ที่ทุกแท็บในเบราว์เซอร์เดียวกันใช้ร่วมกัน
 */
function createRotatingServer() {
  const cookieJar = { value: 'cookie-0' };
  let validCookie = 'cookie-0';
  let rotations = 0;
  let calls = 0;

  async function handle(sentCookie: string) {
    calls += 1;
    await tick();
    if (sentCookie !== validCookie) return { authenticated: false as const };
    rotations += 1;
    validCookie = `cookie-${rotations}`;
    cookieJar.value = validCookie;
    return { authenticated: true as const, accessToken: `access-${rotations}` };
  }

  /** แท็บหนึ่งเรียก /auth/session โดยเบราว์เซอร์แนบ cookie ปัจจุบันไปให้ */
  const callSession = () => handle(cookieJar.value);

  return {
    callSession,
    get calls() {
      return calls;
    },
    get rotations() {
      return rotations;
    },
  };
}

/** จำลอง BroadcastChannel ที่ส่งถึงทุกแท็บยกเว้นผู้ส่ง (ตรงตามสเปกจริง) */
function createFakeChannelNetwork() {
  const peers = new Set<{ onmessage: ((event: { data: unknown }) => void) | null }>();

  return {
    factory(_name: string): BroadcastChannelLike {
      const peer: BroadcastChannelLike = {
        onmessage: null,
        postMessage(message: unknown) {
          for (const other of peers) {
            if (other === peer) continue;
            other.onmessage?.({ data: message });
          }
        },
        close() {
          peers.delete(peer);
        },
      };
      peers.add(peer);
      return peer;
    },
  };
}

/* ------------------------------------------------------------------ */
/* runExclusive                                                        */
/* ------------------------------------------------------------------ */

describe('runExclusive', () => {
  test('จัดคิวไม่ให้ task ทับกันเมื่อมี Web Locks', async () => {
    const locks = createFakeLocks();
    let running = 0;
    let maxConcurrent = 0;

    const task = async () => {
      running += 1;
      maxConcurrent = Math.max(maxConcurrent, running);
      await tick();
      running -= 1;
      return 'done';
    };

    await Promise.all([
      runExclusive(task, { locks }),
      runExclusive(task, { locks }),
      runExclusive(task, { locks }),
    ]);

    assert.equal(maxConcurrent, 1, 'ต้องมี task ทำงานทีละหนึ่งเท่านั้น');
    assert.deepEqual(locks.seen, [SESSION_LOCK_NAME, SESSION_LOCK_NAME, SESSION_LOCK_NAME]);
  });

  test('ทำงานได้ตามปกติเมื่อเบราว์เซอร์ไม่รองรับ Web Locks', async () => {
    let ran = 0;
    const result = await runExclusive(
      async () => {
        ran += 1;
        return 'ok';
      },
      { locks: null },
    );

    assert.equal(result, 'ok');
    assert.equal(ran, 1);
  });

  test('ถ้าขอ lock ไม่สำเร็จ ยังทำงานต่อได้ (fail-safe)', async () => {
    const failingLocks = {
      async request<T>(): Promise<T> {
        throw new Error('lock timeout');
      },
    };

    let ran = 0;
    const result = await runExclusive(
      async () => {
        ran += 1;
        return 'fallback';
      },
      { locks: failingLocks },
    );

    assert.equal(result, 'fallback');
    assert.equal(ran, 1, 'task ต้องทำงานหนึ่งครั้ง');
  });

  test('error จาก task ไม่ทำให้ task ถูกรันซ้ำ', async () => {
    const locks = createFakeLocks();
    let ran = 0;

    await assert.rejects(
      runExclusive(
        async () => {
          ran += 1;
          throw new Error('session failed');
        },
        { locks },
      ),
      /session failed/,
    );

    assert.equal(ran, 1, 'ห้ามรัน task ซ้ำเมื่อ task เองล้มเหลว');
  });
});

/* ------------------------------------------------------------------ */
/* Root cause + การแก้                                                  */
/* ------------------------------------------------------------------ */

describe('multi-tab bootstrap race', () => {
  test('ไม่มีการจัดคิว: สองแท็บ bootstrap พร้อมกันแล้วแท็บหนึ่งหลุดออกจากระบบ', async () => {
    const server = createRotatingServer();

    const [tabA, tabB] = await Promise.all([server.callSession(), server.callSession()]);

    const authenticated = [tabA, tabB].filter((r) => r.authenticated).length;
    assert.equal(authenticated, 1, 'นี่คืออาการของปัญหาที่ต้องแก้');
    assert.equal(server.rotations, 1);
  });

  test('มีการจัดคิว: สองแท็บ bootstrap พร้อมกันแล้วยังเข้าสู่ระบบทั้งคู่', async () => {
    const server = createRotatingServer();
    const locks = createFakeLocks();

    const [tabA, tabB] = await Promise.all([
      runExclusive(() => server.callSession(), { locks }),
      runExclusive(() => server.callSession(), { locks }),
    ]);

    assert.equal(tabA.authenticated, true);
    assert.equal(tabB.authenticated, true);
    assert.equal(server.calls, 2, 'แต่ละแท็บเรียกครั้งเดียวของตัวเอง');
    assert.equal(server.rotations, 2, 'หมุน token ทีละครั้งตามลำดับ');
  });

  test('สามแท็บพร้อมกันก็ยังเข้าสู่ระบบครบทุกแท็บ', async () => {
    const server = createRotatingServer();
    const locks = createFakeLocks();

    const results = await Promise.all(
      [1, 2, 3].map(() => runExclusive(() => server.callSession(), { locks })),
    );

    assert.ok(results.every((r) => r.authenticated), 'ทุกแท็บต้องยังอยู่ในระบบ');
    assert.equal(server.rotations, 3);
  });

  test('cookie ที่ใช้ไม่ได้ยังคงจบที่สถานะยังไม่ได้เข้าสู่ระบบ', async () => {
    const locks = createFakeLocks();

    const result = await runExclusive(async () => ({ authenticated: false as const }), { locks });

    assert.equal(result.authenticated, false, 'การจัดคิวต้องไม่กลบผลลัพธ์ที่ไม่ผ่านจริง');
  });
});

/* ------------------------------------------------------------------ */
/* Auth channel                                                        */
/* ------------------------------------------------------------------ */

describe('auth channel', () => {
  test('logout ส่งถึงแท็บอื่น แต่ไม่ส่งกลับหาตัวเอง', async () => {
    const network = createFakeChannelNetwork();
    const tabA = createAuthChannel({ channelFactory: network.factory, tabId: 'tab-a' });
    const tabB = createAuthChannel({ channelFactory: network.factory, tabId: 'tab-b' });
    const tabC = createAuthChannel({ channelFactory: network.factory, tabId: 'tab-c' });

    const received: string[] = [];
    const selfReceived: string[] = [];
    tabB.subscribe((event) => received.push(`B:${event.type}`));
    tabC.subscribe((event) => received.push(`C:${event.type}`));
    tabA.subscribe((event) => selfReceived.push(event.type));

    tabA.publish('LOGOUT');

    assert.deepEqual(received.sort(), ['B:LOGOUT', 'C:LOGOUT']);
    assert.deepEqual(selfReceived, [], 'ผู้ส่งต้องไม่ได้รับข้อความของตัวเอง');

    tabA.close();
    tabB.close();
    tabC.close();
  });

  test('เปลี่ยนรหัสผ่านและเข้าสู่ระบบก็ประกาศข้ามแท็บได้', () => {
    const network = createFakeChannelNetwork();
    const tabA = createAuthChannel({ channelFactory: network.factory, tabId: 'tab-a' });
    const tabB = createAuthChannel({ channelFactory: network.factory, tabId: 'tab-b' });

    const received: string[] = [];
    tabB.subscribe((event) => received.push(event.type));

    tabA.publish('PASSWORD_CHANGED');
    tabA.publish('LOGIN');

    assert.deepEqual(received, ['PASSWORD_CHANGED', 'LOGIN']);

    tabA.close();
    tabB.close();
  });

  test('ข้อความที่ประกาศมีแค่ type กับ at ไม่มี token หรือข้อมูลผู้ใช้', () => {
    const sent: unknown[] = [];
    const channel = createAuthChannel({
      channelFactory: () => ({
        onmessage: null,
        postMessage: (message: unknown) => sent.push(message),
        close: () => undefined,
      }),
    });

    channel.publish('LOGIN');

    assert.equal(sent.length, 1);
    const payload = sent[0] as Record<string, unknown>;
    assert.deepEqual(Object.keys(payload).sort(), ['at', 'from', 'type']);
    assert.equal(payload.type, 'LOGIN');
    assert.equal(typeof payload.at, 'number');
    assert.equal(typeof payload.from, 'string');

    // from เป็นรหัสสุ่มประจำแท็บเท่านั้น ต้องไม่ใช่อีเมลหรือรหัสผู้ใช้
    assert.ok(!String(payload.from).includes('@'));

    const serialized = JSON.stringify(payload).toLowerCase();
    for (const secret of ['token', 'cookie', 'password', 'refresh', 'hash', 'secret']) {
      assert.ok(!serialized.includes(secret), `ต้องไม่มีคำว่า ${secret} ในข้อความข้ามแท็บ`);
    }
  });

  test('ข้อความรูปแบบผิดถูกเพิกเฉย', () => {
    // เก็บ handler ไว้ใน box เพื่อไม่ให้ TypeScript แคบชนิดเป็น never จากค่าเริ่มต้น
    const box: { handler: ((event: { data: unknown }) => void) | null } = { handler: null };

    const channel = createAuthChannel({
      channelFactory: () => ({
        set onmessage(fn: ((event: { data: unknown }) => void) | null) {
          box.handler = fn;
        },
        get onmessage() {
          return box.handler;
        },
        postMessage: () => undefined,
        close: () => undefined,
      }),
    });

    const received: unknown[] = [];
    channel.subscribe((event) => received.push(event));

    const deliver = (data: unknown) => box.handler?.({ data });

    deliver(null);
    deliver('LOGOUT');
    deliver({ type: 'NOT_A_REAL_EVENT', at: Date.now(), from: 'other' });
    deliver({ type: 'LOGOUT' });
    deliver({ at: Date.now(), from: 'other' });
    deliver({ type: 'LOGOUT', at: Date.now() });

    assert.deepEqual(received, []);
  });

  test('เบราว์เซอร์ที่ไม่รองรับ BroadcastChannel ไม่ทำให้พัง', () => {
    const channel = createAuthChannel({ channelFactory: null });

    assert.equal(channel.available, false);
    assert.doesNotThrow(() => channel.publish('LOGOUT'));
    const unsubscribe = channel.subscribe(() => undefined);
    assert.doesNotThrow(() => unsubscribe());
    assert.doesNotThrow(() => channel.close());
  });

  test('publishAuthEvent ส่งถึงผู้รับแล้วปิดช่องของตัวเองทันที', () => {
    const network = createFakeChannelNetwork();
    const received: string[] = [];
    const unsubscribe = subscribeAuthEvents((event) => received.push(event.type), {
      channelFactory: network.factory,
      tabId: 'listener-tab',
    });

    publishAuthEvent('LOGOUT', { channelFactory: network.factory, tabId: 'sender-tab' });
    publishAuthEvent('LOGIN', { channelFactory: network.factory, tabId: 'sender-tab' });

    assert.deepEqual(received, ['LOGOUT', 'LOGIN']);
    unsubscribe();
  });

  test('ยกเลิกการรับฟังแล้วต้องไม่ได้รับข้อความอีก', () => {
    const network = createFakeChannelNetwork();
    const received: string[] = [];
    const unsubscribe = subscribeAuthEvents((event) => received.push(event.type), {
      channelFactory: network.factory,
      tabId: 'listener-tab',
    });

    publishAuthEvent('LOGOUT', { channelFactory: network.factory, tabId: 'sender-tab' });
    unsubscribe();
    publishAuthEvent('LOGIN', { channelFactory: network.factory, tabId: 'sender-tab' });

    assert.deepEqual(received, ['LOGOUT']);
  });

  /**
   * กันการถดถอย: ถ้าผู้ส่งกับผู้รับใช้ช่องเดียวกัน การ cleanup ของ Strict Mode
   * รอบแรกจะปิดช่องทิ้ง ทำให้แท็บนั้นไม่ได้รับข้อความอีกเลย
   */
  test('การ subscribe รอบใหม่หลัง unsubscribe ยังรับข้อความได้ (ปลอดภัยกับ Strict Mode)', () => {
    const network = createFakeChannelNetwork();
    const received: string[] = [];

    // รอบที่ Strict Mode สร้างแล้วทิ้ง
    const firstUnsubscribe = subscribeAuthEvents(() => received.push('first'), {
      channelFactory: network.factory,
      tabId: 'listener-tab',
    });
    firstUnsubscribe();

    // รอบจริงที่ยังอยู่
    const unsubscribe = subscribeAuthEvents((event) => received.push(event.type), {
      channelFactory: network.factory,
      tabId: 'listener-tab',
    });

    publishAuthEvent('LOGOUT', { channelFactory: network.factory, tabId: 'sender-tab' });

    assert.deepEqual(received, ['LOGOUT'], 'ผู้รับรอบที่สองต้องยังทำงานอยู่');
    unsubscribe();
  });

  test('แท็บไม่ตอบสนองต่อเหตุการณ์ที่ตัวเองประกาศ', () => {
    const network = createFakeChannelNetwork();
    const received: string[] = [];
    const unsubscribe = subscribeAuthEvents((event) => received.push(event.type), {
      channelFactory: network.factory,
      tabId: 'same-tab',
    });

    // ประกาศจากแท็บเดียวกัน (ช่องคนละตัว แต่เป็นแท็บเดิม)
    publishAuthEvent('LOGIN', { channelFactory: network.factory, tabId: 'same-tab' });
    assert.deepEqual(received, [], 'ต้องไม่ bootstrap ซ้ำจากเสียงของตัวเอง');

    // ประกาศจากแท็บอื่นต้องยังได้รับตามปกติ
    publishAuthEvent('LOGIN', { channelFactory: network.factory, tabId: 'other-tab' });
    assert.deepEqual(received, ['LOGIN']);

    unsubscribe();
  });

  test('publish/subscribe ไม่พังเมื่อเบราว์เซอร์ไม่รองรับ BroadcastChannel', () => {
    assert.doesNotThrow(() => publishAuthEvent('LOGOUT', { channelFactory: null }));
    const unsubscribe = subscribeAuthEvents(() => undefined, { channelFactory: null });
    assert.doesNotThrow(() => unsubscribe());
  });

  test('ชื่อช่องและชื่อ lock คงที่ตามที่ตกลงไว้', () => {
    assert.equal(AUTH_CHANNEL_NAME, 's2-nas-auth');
    assert.equal(SESSION_LOCK_NAME, 's2-nas-session-refresh');
  });
});

/* ------------------------------------------------------------------ */
/* Storage audit                                                       */
/* ------------------------------------------------------------------ */

describe('token storage audit', () => {
  const srcDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

  function sourceFiles(dir: string): string[] {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) return sourceFiles(full);
      return /\.(ts|tsx)$/.test(entry.name) && !entry.name.endsWith('.test.ts') ? [full] : [];
    });
  }

  test('ไม่มีการเขียน token ลง localStorage / sessionStorage / IndexedDB', () => {
    const offenders: string[] = [];

    for (const file of sourceFiles(srcDir)) {
      const lines = fs.readFileSync(file, 'utf8').split('\n');
      lines.forEach((line, index) => {
        const trimmed = line.trim();
        // ข้ามคอมเมนต์ทั้งบรรทัดเดียวและบล็อก ตรวจเฉพาะโค้ดที่ทำงานจริง
        if (trimmed.startsWith('*') || trimmed.startsWith('/*') || trimmed.startsWith('//')) return;
        const code = line.split('//')[0] ?? '';
        if (!/localStorage|sessionStorage|indexedDB/.test(code)) return;
        if (/token|refresh|credential|password/i.test(code)) {
          offenders.push(`${path.relative(srcDir, file)}:${index + 1}: ${line.trim()}`);
        }
      });
    }

    assert.deepEqual(offenders, [], 'ห้ามเก็บ token ใด ๆ ลง web storage');
  });

  test('web storage ถูกใช้กับค่าที่ไม่ใช่ความลับเท่านั้น', () => {
    const keys = new Set<string>();

    for (const file of sourceFiles(srcDir)) {
      const content = fs.readFileSync(file, 'utf8');
      for (const match of content.matchAll(/STORAGE_KEY\s*=\s*'([^']+)'/g)) {
        keys.add(match[1]!);
      }
    }

    // มีเพียงค่าความชอบส่วนตัวของผู้ใช้เท่านั้น ไม่มีข้อมูลยืนยันตัวตน
    assert.deepEqual([...keys].sort(), ['s2-nas-view', 's2-theme']);
  });
});
