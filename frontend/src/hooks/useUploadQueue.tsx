import {
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { uploadFile, uploadNewVersion, UploadError } from '@/lib/upload';
import { ApiError, smartFilingApi } from '@/lib/api';
import { uploadErrorText } from '@/lib/error-text';
import { useToast } from './useToast';
import { UploadQueueContext, type UploadItem, type UploadQueueValue } from './uploadQueueContext';
import { UPLOAD_SWEEP_INTERVAL_MS, sweepUploadQueue } from '@/lib/upload-queue-policy';

export type { UploadItem, UploadState } from './uploadQueueContext';

let nextId = 1;

export function UploadQueueProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<UploadItem[]>([]);
  const [isPanelOpen, setPanelOpen] = useState(false);
  const controllers = useRef(new Map<string, AbortController>());
  /** ผู้ใช้กำลังชี้/โฟกัสอยู่ในแผง - เลื่อนการเก็บกวาดออกไปก่อน */
  const interacting = useRef(false);
  const queryClient = useQueryClient();
  const { notify } = useToast();

  const patch = useCallback((id: string, changes: Partial<UploadItem>) => {
    setItems((current) => current.map((item) => (item.id === id ? { ...item, ...changes } : item)));
  }, []);

  /** ทำให้ทุกมุมมองที่เกี่ยวข้องเห็นผลทันทีโดยไม่ต้องรีโหลดหน้า */
  const refreshViews = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: ['drive'] });
    void queryClient.invalidateQueries({ queryKey: ['resource'] });
    void queryClient.invalidateQueries({ queryKey: ['dashboard-summary'] });
    void queryClient.invalidateQueries({ queryKey: ['managed-storage'] });
    void queryClient.invalidateQueries({ queryKey: ['versions'] });
    void queryClient.invalidateQueries({ queryKey: ['trash'] });
    void queryClient.invalidateQueries({ queryKey: ['folder-picker'] });
  }, [queryClient]);

  const run = useCallback(
    async (
      item: UploadItem,
      overrides: { onNameConflict?: 'NEW_VERSION' | 'KEEP_BOTH'; allowDuplicateContent?: boolean } = {},
    ) => {
      const controller = new AbortController();
      controllers.current.set(item.id, controller);
      patch(item.id, { state: 'UPLOADING', progress: 0, errorCode: undefined, errorMessage: undefined, decision: undefined });

      try {
        const options = {
          file: item.file,
          parentId: item.parentId,
          signal: controller.signal,
          onProgress: (percent: number) => patch(item.id, { progress: percent }),
          ...overrides,
        };

        let uploaded: Awaited<ReturnType<typeof uploadFile>> | undefined;
        if (item.versionOfId) {
          await uploadNewVersion(item.versionOfId, options);
        } else {
          uploaded = await uploadFile(options);
        }

        patch(item.id, { state: 'SUCCESS', progress: 100, succeededAt: Date.now() });
        refreshViews();
        /**
         * จัดเก็บอัจฉริยะทำงานแยกจากการอัปโหลด
         *
         * ไม่ await โดยตั้งใจ คำขออัปโหลดจบไปแล้วและต้องไม่รอการวิเคราะห์
         * ซึ่งใช้เวลาหลายร้อยมิลลิวินาทีและอาจล้มเหลวได้โดยไม่กระทบไฟล์ที่อัปโหลดสำเร็จ
         */
        if (!item.versionOfId && uploaded?.resource?.id) {
          void analyseAfterUpload(uploaded.resource.id, notify);
        }
      } catch (error) {
        if (!(error instanceof UploadError)) {
          patch(item.id, { state: 'FAILED', errorCode: 'FILE_UPLOAD_FAILED', errorMessage: uploadErrorText('FILE_UPLOAD_FAILED') });
          return;
        }

        if (error.code === 'UPLOAD_CANCELLED') {
          patch(item.id, { state: 'CANCELLED' });
          return;
        }

        // สองกรณีนี้ไม่ใช่ความล้มเหลว แต่ต้องให้ผู้ใช้เลือกก่อนไปต่อ
        const details = error.details as { existing?: { id: string; name: string; type?: string } } | undefined;
        if (error.code === 'DUPLICATE_CONTENT' && details?.existing) {
          patch(item.id, {
            state: 'NEEDS_DECISION',
            decision: { kind: 'DUPLICATE_CONTENT', existing: details.existing },
          });
          setPanelOpen(true);
          return;
        }
        if (error.code === 'FILE_NAME_EXISTS' && details?.existing) {
          patch(item.id, {
            state: 'NEEDS_DECISION',
            decision: {
              kind: 'NAME_EXISTS',
              existing: { ...details.existing, type: details.existing.type ?? 'FILE' },
            },
          });
          setPanelOpen(true);
          return;
        }

        patch(item.id, {
          state: 'FAILED',
          errorCode: error.code,
          errorMessage: uploadErrorText(error.code, error.message),
        });
      } finally {
        controllers.current.delete(item.id);
      }
    },
    [patch, refreshViews],
  );

  /**
   * เก็บกวาดแถวที่อัปโหลดสำเร็จและหมดอายุแล้ว
   *
   * ใช้ตัวจับเวลาตัวเดียวกวาดทั้งคิว ไม่ใช่ตัวจับเวลาต่อแถว
   * จึงเป็นไปไม่ได้ที่แถวหนึ่งจะมีตัวจับเวลาซ้อนกันหลายตัว แม้จะ re-render กี่ครั้งก็ตาม
   * อายุยังคงเป็นของแต่ละแถวเอง เพราะคำนวณจาก succeededAt ของแถวนั้น
   */
  useEffect(() => {
    const sweep = () => {
      // ระหว่างที่ผู้ใช้กำลังใช้งานแผงอยู่ ให้เลื่อนออกไปก่อน ไม่ลบของหายไปใต้มือ
      if (interacting.current) return;

      setItems((current) => {
        const focusedId =
          typeof document === 'undefined'
            ? null
            : (document.activeElement?.closest('[data-upload-id]') as HTMLElement | null)?.dataset.uploadId ?? null;

        const { remaining, dismissed, shouldClosePanel } = sweepUploadQueue(current, Date.now(), focusedId);
        if (dismissed.length === 0) return current;
        if (shouldClosePanel) setPanelOpen(false);
        return remaining;
      });
    };

    const timer = setInterval(sweep, UPLOAD_SWEEP_INTERVAL_MS);
    return () => clearInterval(timer);
  }, []);

  /** อัปโหลดทีละไฟล์ตามลำดับ เพื่อให้ความคืบหน้าอ่านง่ายและไม่ถล่มเซิร์ฟเวอร์ */
  const drain = useCallback(
    async (queued: UploadItem[]) => {
      let succeeded = 0;
      for (const item of queued) {
        const before = succeeded;
        await run(item);
        setItems((current) => {
          const latest = current.find((row) => row.id === item.id);
          if (latest?.state === 'SUCCESS') succeeded = before + 1;
          return current;
        });
      }

      if (succeeded > 0) {
        notify({
          tone: 'success',
          title: succeeded === 1 ? 'อัปโหลดสำเร็จ' : `อัปโหลด ${succeeded} ไฟล์เรียบร้อยแล้ว`,
        });
      }
    },
    [run, notify],
  );

  const enqueue = useCallback(
    (files: File[], target: { parentId: string | null; parentName: string }) => {
      if (files.length === 0) return;
      const queued: UploadItem[] = files.map((file) => ({
        id: `upload-${nextId++}`,
        file,
        parentId: target.parentId,
        parentName: target.parentName,
        state: 'QUEUED',
        progress: 0,
      }));

      setItems((current) => [...current, ...queued]);
      setPanelOpen(true);
      void drain(queued);
    },
    [drain],
  );

  const enqueueVersion = useCallback(
    (file: File, target: { resourceId: string; resourceName: string }) => {
      const item: UploadItem = {
        id: `upload-${nextId++}`,
        file,
        parentId: null,
        parentName: target.resourceName,
        state: 'QUEUED',
        progress: 0,
        versionOfId: target.resourceId,
        versionOfName: target.resourceName,
      };

      setItems((current) => [...current, item]);
      setPanelOpen(true);
      void (async () => {
        await run(item);
        notify({ tone: 'success', title: 'อัปโหลดเวอร์ชันใหม่แล้ว' });
      })();
    },
    [run, notify],
  );

  const value = useMemo<UploadQueueValue>(
    () => ({
      items,
      isPanelOpen,
      activeCount: items.filter((item) => item.state === 'UPLOADING' || item.state === 'QUEUED').length,
      enqueue,
      enqueueVersion,
      retry(id) {
        const item = items.find((row) => row.id === id);
        if (item) void run(item);
      },
      remove(id) {
        controllers.current.get(id)?.abort();
        setItems((current) => current.filter((row) => row.id !== id));
      },
      cancel(id) {
        controllers.current.get(id)?.abort();
        patch(id, { state: 'CANCELLED' });
      },
      resolveDecision(id, choice) {
        const item = items.find((row) => row.id === id);
        if (!item) return;

        if (choice === 'CANCEL') {
          patch(id, { state: 'CANCELLED', decision: undefined });
          return;
        }
        if (choice === 'ALLOW_DUPLICATE') {
          void run(item, { allowDuplicateContent: true });
          return;
        }
        void run(item, { onNameConflict: choice, allowDuplicateContent: true });
      },
      clearFinished() {
        setItems((current) =>
          current.filter((item) => item.state === 'UPLOADING' || item.state === 'QUEUED' || item.state === 'NEEDS_DECISION'),
        );
      },
      pauseAutoDismiss: () => { interacting.current = true; },
      resumeAutoDismiss: () => { interacting.current = false; },
      openPanel: () => setPanelOpen(true),
      closePanel: () => setPanelOpen(false),
    }),
    [items, isPanelOpen, enqueue, enqueueVersion, run, patch],
  );

  return <UploadQueueContext.Provider value={value}>{children}</UploadQueueContext.Provider>;
}

/**
 * วิเคราะห์ตำแหน่งจัดเก็บหลังอัปโหลดเสร็จ (F22-F6)
 *
 * **ยิงแล้วไม่รอผล** การอัปโหลดถือว่าสำเร็จไปแล้วก่อนหน้านี้ ฟังก์ชันนี้จึงไม่มีสิทธิ์
 * ทำให้ผลการอัปโหลดเปลี่ยนไปไม่ว่าจะเกิดอะไรขึ้น ผู้ใช้เห็นไฟล์ของตัวเองทันที
 * ส่วนข้อเสนอตามมาทีหลังเมื่อพร้อม
 *
 * **ล้มเหลวแล้วเงียบ** ปิดความสามารถอยู่ โมเดลไม่พร้อม หรือวิเคราะห์ไม่สำเร็จ
 * ล้วนไม่ใช่เรื่องที่ต้องรบกวนคนที่เพิ่งอัปโหลดไฟล์สำเร็จ การขึ้นข้อความผิดพลาด
 * สำหรับส่วนเสริมที่ไม่ได้เปิดใช้งาน จะทำให้ผู้ใช้คิดว่าการอัปโหลดมีปัญหา
 *
 * **รอให้การสกัดข้อความเสร็จก่อนค่อยสรุป**
 * เซิร์ฟเวอร์ตอบ SMART_FILING_TEXT_NOT_READY เมื่อไฟล์ที่เพิ่งอัปโหลดยังไม่ถูกทำดัชนี
 * ถ้าถือเอาจังหวะนั้นเป็นคำตอบ ผู้ใช้จะได้ข้อความว่า "ยังไม่พบตำแหน่งที่เหมาะสม"
 * ทั้งที่ระบบยังไม่ได้อ่านเอกสารเลย จึงรอเป็นรอบ ๆ แล้วเงียบไปถ้ายังไม่พร้อมจริง ๆ
 *
 * **งบเวลาที่รอมาจากของจริง** ตัวสกัดข้อความทำงานเป็นรอบทุก 15 วินาที
 * (S2_NAS_EXTRACT_POLL_SECONDS) วัดกับเซิร์ฟเวอร์จริงได้เวลาจนข้อเสนอพร้อม p95 ≈ 15 วินาที
 * งบ 14 รอบ × 2.5 วินาที ≈ 35 วินาที จึงครอบคลุมหนึ่งรอบเต็มพร้อมเวลาสกัดและเผื่อไว้
 */
const TEXT_WAIT_ATTEMPTS = 14;
const TEXT_WAIT_INTERVAL_MS = 2500;

async function analyseAfterUpload(
  resourceId: string,
  notify: (input: { tone: 'success' | 'info'; title: string; description?: string }) => void,
): Promise<void> {
  try {
    let attempt = 0;
    let analysed: Awaited<ReturnType<typeof smartFilingApi.analyze>> | null = null;
    for (;;) {
      try {
        analysed = await smartFilingApi.analyze(resourceId);
        break;
      } catch (error) {
        const notReady = error instanceof ApiError && error.code === 'SMART_FILING_TEXT_NOT_READY';
        if (!notReady || (attempt += 1) >= TEXT_WAIT_ATTEMPTS) throw error;
        await new Promise((resolve) => { setTimeout(resolve, TEXT_WAIT_INTERVAL_MS); });
      }
    }
    const result = analysed.data;
    if (result.resultLevel === 'NO_SUGGESTION') {
      notify({ tone: 'info', title: 'ยังไม่พบตำแหน่งที่เหมาะสม', description: 'เอกสารอยู่ที่เดิม เลือกโฟลเดอร์เองได้จากรายละเอียดไฟล์' });
      return;
    }
    const label = result.destination?.pathLabel || result.client?.label || '';
    notify({ tone: 'info', title: 'พบตำแหน่งที่แนะนำ', description: label ? `${label} · เปิดรายละเอียดไฟล์เพื่อยืนยัน` : 'เปิดรายละเอียดไฟล์เพื่อดูข้อเสนอ' });
  } catch {
    /* ส่วนเสริมที่ล้มเหลวต้องไม่รบกวนผลการอัปโหลดที่สำเร็จไปแล้ว */
  }
}

export function useUploadQueue(): UploadQueueValue {
  const value = useContext(UploadQueueContext);
  if (!value) throw new Error('useUploadQueue ต้องอยู่ภายใน UploadQueueProvider');
  return value;
}
