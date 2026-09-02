import { createContext } from 'react';

export type UploadState = 'QUEUED' | 'UPLOADING' | 'SUCCESS' | 'FAILED' | 'CANCELLED' | 'NEEDS_DECISION';

export interface UploadItem {
  id: string;
  file: File;
  parentId: string | null;
  parentName: string;
  state: UploadState;
  progress: number;
  errorCode?: string;
  errorMessage?: string;
  decision?:
    | { kind: 'DUPLICATE_CONTENT'; existing: { id: string; name: string } }
    | { kind: 'NAME_EXISTS'; existing: { id: string; name: string; type: string } };
  versionOfId?: string;
  versionOfName?: string;
}

export interface UploadQueueValue {
  items: UploadItem[];
  isPanelOpen: boolean;
  activeCount: number;
  enqueue(files: File[], target: { parentId: string | null; parentName: string }): void;
  enqueueVersion(file: File, target: { resourceId: string; resourceName: string }): void;
  retry(id: string): void;
  remove(id: string): void;
  cancel(id: string): void;
  resolveDecision(id: string, choice: 'NEW_VERSION' | 'KEEP_BOTH' | 'ALLOW_DUPLICATE' | 'CANCEL'): void;
  clearFinished(): void;
  openPanel(): void;
  closePanel(): void;
}

export const UploadQueueContext = createContext<UploadQueueValue | null>(null);
