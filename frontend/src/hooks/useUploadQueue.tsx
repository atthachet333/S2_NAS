import {
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { uploadFile, uploadNewVersion, UploadError } from '@/lib/upload';
import { uploadErrorText } from '@/lib/error-text';
import { useToast } from './useToast';
import { UploadQueueContext, type UploadItem, type UploadQueueValue } from './uploadQueueContext';

export type { UploadItem, UploadState } from './uploadQueueContext';

let nextId = 1;

export function UploadQueueProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<UploadItem[]>([]);
  const [isPanelOpen, setPanelOpen] = useState(false);
  const controllers = useRef(new Map<string, AbortController>());
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

        if (item.versionOfId) {
          await uploadNewVersion(item.versionOfId, options);
        } else {
          await uploadFile(options);
        }

        patch(item.id, { state: 'SUCCESS', progress: 100 });
        refreshViews();
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
      openPanel: () => setPanelOpen(true),
      closePanel: () => setPanelOpen(false),
    }),
    [items, isPanelOpen, enqueue, enqueueVersion, run, patch],
  );

  return <UploadQueueContext.Provider value={value}>{children}</UploadQueueContext.Provider>;
}

export function useUploadQueue(): UploadQueueValue {
  const value = useContext(UploadQueueContext);
  if (!value) throw new Error('useUploadQueue ต้องอยู่ภายใน UploadQueueProvider');
  return value;
}
