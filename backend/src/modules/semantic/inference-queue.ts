/**
 * คิวจัดลำดับความสำคัญของการเรียกโมเดล (F20)
 *
 * **ปัญหาที่แก้:** โมเดล ONNX ตัวเดียวถูกใช้ร่วมกันทั้งระบบ และการอนุมานถูกต่อคิว
 * แบบมาก่อนได้ก่อน เมื่อการทำดัชนีเบื้องหลังมีงานค้างหลายร้อยชิ้น คำค้นของผู้ใช้
 * จะไปต่อท้ายแถวนั้น แล้วรอเป็นนาที - วัดได้จริงว่า /api/health และการค้นหา
 * หมดเวลาไปหลายนาทีระหว่างการไล่ทำดัชนี
 *
 * งานเบื้องหลังรอได้ ผู้ใช้ที่กำลังพิมพ์คำค้นอยู่รอไม่ได้ คิวนี้จึงจัดลำดับตาม
 * ความสำคัญ ไม่ใช่ตามเวลาที่มาถึง
 *
 * **ไม่ยกเลิกงานที่กำลังทำอยู่** การตัดกลางคันระหว่าง ONNX session ไม่ปลอดภัย
 * งานที่รันอยู่จะจบก่อนเสมอ แล้วช่องถัดไปจึงเป็นของงานที่สำคัญที่สุดที่รออยู่
 * เพราะแต่ละแบตช์ถูกจำกัดขนาดไว้ ช่วงรอที่แย่ที่สุดจึงเป็นแค่หนึ่งแบตช์
 */

export type InferencePriority = 'INTERACTIVE' | 'FOREGROUND' | 'BACKGROUND';

/** เลขน้อย = สำคัญกว่า */
const RANK: Record<InferencePriority, number> = {
  INTERACTIVE: 0,
  FOREGROUND: 1,
  BACKGROUND: 2,
};

export class InferenceQueueFullError extends Error {
  readonly code = 'SEMANTIC_QUEUE_FULL';

  constructor(limit: number) {
    super(`คิวการอนุมาน semantic เต็ม (สูงสุด ${limit} งาน)`);
    this.name = 'InferenceQueueFullError';
  }
}

interface Waiter<T = unknown> {
  priority: InferencePriority;
  sequence: number;
  task: () => Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

export interface InferenceQueueStats {
  running: boolean;
  waiting: number;
  waitingByPriority: Record<InferencePriority, number>;
}

export class PriorityInferenceQueue {
  private readonly waiters: Waiter<never>[] = [];
  private sequence = 0;
  private running = false;

  /**
   * คิวมีเพดานเสมอ
   *
   * คิวที่ไม่มีขอบเขตจะกลายเป็นที่ซ่อนของงานค้างจนหน่วยความจำหมด และผู้เรียก
   * ก็ไม่มีทางรู้ว่าระบบตามงานไม่ทันแล้ว การปฏิเสธอย่างชัดเจนตรงไปตรงมากว่า
   */
  constructor(private readonly maxWaiting = 64) {}

  stats(): InferenceQueueStats {
    const waitingByPriority: Record<InferencePriority, number> = {
      INTERACTIVE: 0, FOREGROUND: 0, BACKGROUND: 0,
    };
    for (const waiter of this.waiters) waitingByPriority[waiter.priority] += 1;
    return { running: this.running, waiting: this.waiters.length, waitingByPriority };
  }

  submit<T>(priority: InferencePriority, task: () => Promise<T>): Promise<T> {
    if (this.waiters.length >= this.maxWaiting) {
      return Promise.reject(new InferenceQueueFullError(this.maxWaiting));
    }
    return new Promise<T>((resolve, reject) => {
      this.waiters.push({
        priority, sequence: this.sequence++, task, resolve, reject,
      } as unknown as Waiter<never>);
      void this.pump();
    });
  }

  /**
   * เลือกงานถัดไป: สำคัญที่สุดก่อน ถ้าเท่ากันให้มาก่อนได้ก่อน
   *
   * งานเบื้องหลังจึงไม่อดตาย - เมื่อไม่มีคำค้นค้างอยู่ มันได้ช่องทันที
   */
  private takeNext(): Waiter<never> | null {
    if (this.waiters.length === 0) return null;
    let best = 0;
    for (let index = 1; index < this.waiters.length; index += 1) {
      const candidate = this.waiters[index]!;
      const current = this.waiters[best]!;
      if (RANK[candidate.priority] < RANK[current.priority] ||
        (RANK[candidate.priority] === RANK[current.priority] && candidate.sequence < current.sequence)) {
        best = index;
      }
    }
    return this.waiters.splice(best, 1)[0]!;
  }

  private async pump(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      for (;;) {
        const waiter = this.takeNext();
        if (!waiter) return;
        try {
          waiter.resolve((await waiter.task()) as never);
        } catch (error) {
          // ความล้มเหลวของงานหนึ่งต้องไม่ทำให้คิวค้างถาวร
          waiter.reject(error);
        }
      }
    } finally {
      this.running = false;
    }
  }
}
