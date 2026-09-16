import {
  Clipboard, Download, Eye, FileArchive, FileUp, FolderInput, FolderPlus, History, Info, Link2,
  Lock, LockOpen, MessageSquareText, PenLine, Pin, PinOff, Share2, SquareArrowOutUpRight, Star,
  StarOff, Tag, Trash2, Upload, UserRoundCog, type LucideIcon,
} from 'lucide-react';
import { Sheet, SheetItem } from '@/components/ui/Sheet';
import type { DriveEntry } from '@/lib/drive';
import { visibleResourceActions } from '@/lib/interaction-policy';
import { RESOURCE_ACTION_CATALOG, actionLabel } from '@/lib/resource-action-catalog';

/**
 * แผ่นกระทำสำหรับมือถือ (F24-C)
 *
 * **ทำไมไม่ใช้เมนูคลิกขวาเดิม:** เมนูนั้นถูกวางตามพิกัดของเมาส์ ซึ่งบนจอสัมผัสคือ
 * ตำแหน่งนิ้วของผู้ใช้ เมนูจึงโผล่ใต้นิ้วที่กำลังบังอยู่ และรายการสูงราว 32px
 * เล็กเกินกว่าจะแตะได้แม่นยำ แผ่นล่างแก้ทั้งสองเรื่องพร้อมกัน
 *
 * **รายการที่แสดงมาจากสิทธิ์จริง** ใช้ visibleResourceActions ตัวเดียวกับเดสก์ท็อป
 * จึงไม่มีทางที่มือถือจะเสนอสิ่งที่เดสก์ท็อปไม่ยอมให้ทำ หรือกลับกัน
 */
const ICONS: Record<string, LucideIcon> = {
  open: FolderInput,
  'open-external': SquareArrowOutUpRight,
  'copy-external-link': Clipboard,
  'edit-external': Link2,
  preview: Eye,
  download: Download,
  'download-zip': FileArchive,
  'new-version': FileUp,
  'create-folder-inside': FolderPlus,
  'upload-here': Upload,
  favorite: Star,
  unfavorite: StarOff,
  pin: Pin,
  unpin: PinOff,
  tags: Tag,
  remark: MessageSquareText,
  share: Share2,
  lock: Lock,
  unlock: LockOpen,
  rename: PenLine,
  move: FolderInput,
  owner: UserRoundCog,
  details: Info,
  activity: History,
  trash: Trash2,
};

export function MobileActionSheet({
  entry,
  onClose,
  onAction,
}: {
  entry: DriveEntry | null;
  onClose: () => void;
  onAction: (action: string, entry: DriveEntry | null) => void;
}) {
  if (!entry) return null;

  const actions = visibleResourceActions(entry).filter((action) => action in RESOURCE_ACTION_CATALOG);

  return (
    <Sheet open title={entry.name} onClose={onClose}>
      {actions.map((action) => {
        const Icon = ICONS[action];
        return (
          <SheetItem
            key={action}
            icon={Icon ? <Icon className="h-4 w-4" /> : undefined}
            label={actionLabel(action)}
            tone={RESOURCE_ACTION_CATALOG[action]?.danger ? 'danger' : 'default'}
            onSelect={() => {
              onClose();
              onAction(action, entry);
            }}
          />
        );
      })}
    </Sheet>
  );
}
