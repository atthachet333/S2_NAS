/**
 * ที่เก็บเหตุการณ์เชิญติดตั้งของเบราว์เซอร์ (F24-J)
 *
 * **ทำไมต้องเป็นตัวเดียวระดับโมดูล ไม่ใช่ useEffect ในคอมโพเนนต์:**
 * เบราว์เซอร์ยิง beforeinstallprompt **ครั้งเดียว และยิงเร็วมาก** ราวจังหวะที่หน้าโหลดเสร็จ
 * ถ้าตัวรับเหตุการณ์ถูกติดตั้งตอนที่ผู้ใช้เปิดเมนู ซึ่งอาจเป็นนาทีต่อมาหรือไม่เปิดเลย
 * เหตุการณ์นั้นก็ผ่านไปแล้ว และปุ่มติดตั้งจะไม่มีวันปรากฏ
 *
 * ตัวรับจึงเริ่มทำงานตั้งแต่โมดูลนี้ถูกโหลด ซึ่งเกิดขึ้นพร้อมกับเปลือกแอป
 * และเก็บเหตุการณ์ไว้ให้คอมโพเนนต์ที่ถูกสร้างทีหลังมาอ่านได้
 */

export interface InstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

let captured: InstallPromptEvent | null = null;
let installed = false;
const listeners = new Set<() => void>();

function announce(): void {
  for (const listener of listeners) listener();
}

if (typeof window !== 'undefined') {
  window.addEventListener('beforeinstallprompt', (event) => {
    // กันแถบเชิญของเบราว์เซอร์ไว้ก่อน เราจะเสนอในที่ที่ผู้ใช้หาเจอและในจังหวะที่เหมาะกว่า
    event.preventDefault();
    captured = event as InstallPromptEvent;
    announce();
  });
  window.addEventListener('appinstalled', () => {
    captured = null;
    installed = true;
    announce();
  });
}

export function subscribeToInstallPrompt(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function hasInstallPrompt(): boolean {
  return captured !== null;
}

export function wasInstalledThisSession(): boolean {
  return installed;
}

/**
 * เรียกกล่องติดตั้งของเบราว์เซอร์
 *
 * เหตุการณ์ที่เก็บไว้ใช้ได้ครั้งเดียว หลังใช้แล้วต้องทิ้ง เบราว์เซอร์จะยิงมาใหม่เอง
 * ถ้าแอปยังติดตั้งได้อยู่
 */
export async function runInstallPrompt(): Promise<'accepted' | 'dismissed' | 'unavailable'> {
  const event = captured;
  if (!event) return 'unavailable';
  await event.prompt();
  const { outcome } = await event.userChoice;
  captured = null;
  announce();
  return outcome;
}

/** ใช้ในชุดทดสอบเท่านั้น - ล้างสถานะที่ค้างระหว่างเคส */
export function resetInstallPromptForTesting(): void {
  captured = null;
  installed = false;
}
