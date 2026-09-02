import { useCallback, useState, type ReactNode } from 'react';
import type { DriveEntry } from '@/lib/drive';
import { ShareDialog } from '@/components/files/ShareDialog';
import { TagEditor } from '@/components/files/TagEditor';
import { RemarkDialog } from '@/components/files/RemarkDialog';
import { LockDialog } from '@/components/files/LockDialog';
import { useWorkspaceMarks } from './useWorkspaceMarks';
import { useDriveUi } from './useDriveUi';

type WorkspaceDialog = 'share' | 'tags' | 'remark' | 'lock';

const DIALOG_ACTIONS: Record<string, WorkspaceDialog> = {
  share: 'share',
  tags: 'tags',
  remark: 'remark',
  lock: 'lock',
  unlock: 'lock',
};

/**
 * การกระทำของ Phase E ที่ทุกหน้าใช้ร่วมกัน
 *
 * ไดร์ฟของฉัน รายการโปรด แชร์กับฉัน และผลค้นหา ล้วนแสดงทรัพยากรชุดเดียวกัน
 * จึงต้องมีเมนูและกล่องโต้ตอบชุดเดียวกันด้วย ไม่เช่นนั้นผู้ใช้จะเจอความสามารถ
 * ไม่เท่ากันโดยไม่มีเหตุผลที่อธิบายได้
 *
 * คืน `handled` เป็น true เมื่อจัดการ action นั้นแล้ว เพื่อให้หน้าที่เรียกรู้ว่า
 * ต้องทำต่อเองหรือไม่
 */
export function useWorkspaceActions() {
  const { toggleFavorite, togglePin } = useWorkspaceMarks();
  const { select, openDetails } = useDriveUi();
  const [dialog, setDialog] = useState<{ kind: WorkspaceDialog; entry: DriveEntry } | null>(null);

  const handleWorkspaceAction = useCallback(
    (action: string, entry: DriveEntry | null): boolean => {
      if (!entry) return false;

      if (action === 'favorite' || action === 'unfavorite') {
        toggleFavorite(entry.id, action === 'favorite');
        return true;
      }
      if (action === 'pin' || action === 'unpin') {
        togglePin(entry.id, action === 'pin');
        return true;
      }
      if (action === 'activity') {
        select(entry);
        openDetails('activity');
        return true;
      }

      const kind = DIALOG_ACTIONS[action];
      if (kind) {
        setDialog({ kind, entry });
        return true;
      }
      return false;
    },
    [toggleFavorite, togglePin, select, openDetails],
  );

  const close = useCallback(() => setDialog(null), []);

  const workspaceDialogs: ReactNode = dialog
    ? dialog.kind === 'share'
      ? <ShareDialog entry={dialog.entry} onClose={close} />
      : dialog.kind === 'tags'
        ? <TagEditor entry={dialog.entry} onClose={close} />
        : dialog.kind === 'remark'
          ? <RemarkDialog entry={dialog.entry} onClose={close} />
          : <LockDialog entry={dialog.entry} onClose={close} />
    : null;

  return { handleWorkspaceAction, workspaceDialogs };
}
