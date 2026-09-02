import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import {
  ArrowRight,
  Download,
  FileUp,
  FolderPlus,
  RotateCcw,
  Upload,
  FolderTree,
  HardDrive,
  Layers,
  Lock,
  LockOpen,
  MessageSquareText,
  PenLine,
  Share2,
  Tag,
  Trash2,
  UserRoundCog,
  type LucideIcon,
} from 'lucide-react';
import { api, dashboardApi, fileApi } from '@/lib/api';
import { toDriveEntry } from '@/lib/drive';
import { FileTypeIcon } from '@/components/files/FileTypeIcon';
import { OwnerAvatar, ownerLabel } from '@/components/files/OwnerIdentity';
import { ResourceSourceBadge } from '@/components/files/ResourceSourceBadge';
import { StorageDonut } from '@/components/dashboard/StorageDonut';
import { ErrorState, TextSkeleton } from '@/components/ui/States';
import { formatBytes, formatRelativeTime } from '@/lib/utils';
import { useWorkspaceMarks } from '@/hooks/useWorkspaceMarks';
import { activityLabel } from '@/lib/activity-text';

/** เหตุการณ์ที่ระบบบันทึกไว้จริง พร้อมไอคอนกำกับให้อ่านเร็วขึ้น */
const ACTION_META: Record<string, { label: string; icon: LucideIcon; tone: string }> = {
  RESOURCE_FOLDER_CREATED: { label: 'สร้างโฟลเดอร์', icon: FolderPlus, tone: 'text-brand-600 bg-brand-50' },
  RESOURCE_RENAMED: { label: 'เปลี่ยนชื่อ', icon: PenLine, tone: 'text-navy-500 bg-navy-50' },
  RESOURCE_UPDATED: { label: 'แก้ไขข้อมูล', icon: PenLine, tone: 'text-navy-500 bg-navy-50' },
  RESOURCE_MOVED: { label: 'ย้ายตำแหน่ง', icon: FolderTree, tone: 'text-navy-500 bg-navy-50' },
  RESOURCE_OWNER_CHANGED: { label: 'เปลี่ยนผู้ดูแล', icon: UserRoundCog, tone: 'text-violet-500 bg-navy-50' },
  RESOURCE_SOFT_DELETED: { label: 'ย้ายไปถังขยะ', icon: Trash2, tone: 'text-red-500 bg-red-50' },
  RESOURCE_UPLOADED: { label: 'อัปโหลดไฟล์', icon: Upload, tone: 'text-brand-600 bg-brand-50' },
  RESOURCE_VERSION_CREATED: { label: 'เพิ่มเวอร์ชันใหม่', icon: FileUp, tone: 'text-indigo-500 bg-navy-50' },
  RESOURCE_DOWNLOADED: { label: 'ดาวน์โหลดไฟล์', icon: Download, tone: 'text-navy-500 bg-navy-50' },
  RESOURCE_TRASHED: { label: 'ย้ายไปถังขยะ', icon: Trash2, tone: 'text-red-500 bg-red-50' },
  RESOURCE_RESTORED: { label: 'กู้คืน', icon: RotateCcw, tone: 'text-emerald-600 bg-emerald-50' },
  RESOURCE_PERMANENTLY_DELETED: { label: 'ลบถาวร', icon: Trash2, tone: 'text-red-600 bg-red-50' },
  RESOURCE_ACCESS_GRANTED: { label: 'ให้สิทธิ์เข้าถึง', icon: Share2, tone: 'text-amber-600 bg-amber-50' },
  RESOURCE_ACCESS_REVOKED: { label: 'ยกเลิกสิทธิ์เข้าถึง', icon: Share2, tone: 'text-amber-600 bg-amber-50' },
  RESOURCE_TAG_ADDED: { label: 'เพิ่มแท็ก', icon: Tag, tone: 'text-navy-500 bg-navy-50' },
  RESOURCE_TAG_REMOVED: { label: 'ลบแท็ก', icon: Tag, tone: 'text-navy-500 bg-navy-50' },
  RESOURCE_REMARK_UPDATED: { label: 'แก้ไขหมายเหตุ', icon: MessageSquareText, tone: 'text-navy-500 bg-navy-50' },
  RESOURCE_LOCKED: { label: 'ล็อกทรัพยากร', icon: Lock, tone: 'text-amber-600 bg-amber-50' },
  RESOURCE_UNLOCKED: { label: 'ปลดล็อกทรัพยากร', icon: LockOpen, tone: 'text-emerald-600 bg-emerald-50' },
  OWNERSHIP_BULK_TRANSFERRED: { label: 'ส่งมอบความรับผิดชอบ', icon: UserRoundCog, tone: 'text-violet-500 bg-navy-50' },
};

export default function DashboardPage() {
  const summary = useQuery({ queryKey: ['dashboard-summary'], queryFn: dashboardApi.summary });
  const storage = useQuery({ queryKey: ['storage'], queryFn: api.storage, retry: 1 });
  const managed = useQuery({ queryKey: ['managed-storage'], queryFn: fileApi.managedStorage, retry: 1 });

  const totals = summary.data?.data.totals;
  const disk = storage.data?.data;
  const managedBytes = managed.data?.data.managedBytes;
  const { pinnedResources: pinned } = useWorkspaceMarks();

  return (
    <div className="space-y-7">
      <header>
        <h1 className="text-[26px] font-semibold leading-tight tracking-tight text-navy-900">Dashboard</h1>
        <p className="mt-1 text-[13px] text-navy-400">ภาพรวมพื้นที่จัดเก็บและทรัพยากรขององค์กร</p>
      </header>

      {/* ---------- แถวภาพรวม ---------- */}
      <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
        <Stat
          icon={Layers}
          label="ทรัพยากรทั้งหมด"
          value={totals ? `${totals.resources}` : null}
          hint={totals ? `โฟลเดอร์ ${totals.folders} · ไฟล์ ${totals.files}` : undefined}
          loading={summary.isPending}
          failed={summary.isError}
        />
        <Stat
          icon={FolderTree}
          label="โฟลเดอร์"
          value={totals ? `${totals.folders}` : null}
          hint={totals ? 'ในพื้นที่องค์กร' : undefined}
          loading={summary.isPending}
          failed={summary.isError}
        />
<Stat
          icon={HardDrive}
          label="ไฟล์ใน S2 NAS"
          value={managedBytes === undefined ? null : formatBytes(managedBytes)}
          hint={totals ? `${totals.files} ไฟล์` : undefined}
          loading={managed.isPending}
          failed={managed.isError}
        />
        <Stat
          icon={UserRoundCog}
          label="โฟลเดอร์ที่ฉันดูแล"
          value={totals ? `${totals.ownedByMe}` : null}
          hint={totals ? 'ในฐานะผู้ดูแลหลัก' : undefined}
          loading={summary.isPending}
          failed={summary.isError}
        />
      </div>

      {/* ---------- เนื้อหาหลัก ---------- */}
      <div className="grid grid-cols-1 items-start gap-5 xl:grid-cols-[minmax(0,1fr)_340px]">
        <div className="space-y-6">
          {/* ปักหมุดขึ้นก่อนของล่าสุด เพราะเป็นสิ่งที่ผู้ใช้เลือกเองว่ากำลังทำอยู่ */}
          {pinned.length > 0 ? (
            <section>
              <SectionHeader title="ปักหมุดไว้" action={{ to: '/files', label: 'ไปที่ไฟล์' }} />
              <ul className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
                {pinned.map((resource) => {
                  const entry = toDriveEntry(resource);
                  return (
                    <li key={resource.id}>
                      <Link
                        to={entry.kind === 'folder' ? `/files/${entry.id}` : `/files/${entry.parentId ?? ''}?focus=${entry.id}`}
                        className="s2-surface flex items-center gap-2.5 p-3 transition-colors hover:border-brand-300"
                      >
                        <FileTypeIcon name={entry.name} kind={entry.kind} resourceType={entry.resourceType} />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-[12.5px] font-medium text-navy-800">{entry.name}</span>
                          <span className="block truncate text-[10.5px] text-navy-400">ผู้ดูแล {entry.ownerName}</span>
                        </span>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </section>
          ) : null}

          <section>
            <SectionHeader title="ทรัพยากรล่าสุด" action={{ to: '/files', label: 'ดูทั้งหมด' }} />

            {summary.isPending ? (
              <div className="s2-resource-card mt-3 p-4">
                <TextSkeleton lines={4} />
              </div>
            ) : summary.isError ? (
              <ErrorState message="โหลดรายการทรัพยากรไม่สำเร็จ" onRetry={() => void summary.refetch()} />
            ) : summary.data.data.recentResources.length === 0 ? (
              <EmptyLine text="ยังไม่มีทรัพยากรในระบบ" />
            ) : (
              <ul className="mt-3 overflow-hidden rounded-2xl border border-[var(--s2-card-border)] bg-[var(--s2-layer-card)]">
                {summary.data.data.recentResources.map((resource) => {
                  const entry = toDriveEntry(resource);
                  return (
                    <li key={resource.id} className="border-b border-line last:border-0">
                      <Link
                        to={entry.kind === 'folder' ? `/files/${entry.id}` : '/files'}
                        className="group flex items-center gap-3 px-4 py-2.5 transition-colors hover:bg-[var(--s2-surface-soft)]"
                      >
                        <FileTypeIcon name={entry.name} kind={entry.kind} resourceType={entry.resourceType} size="sm" />

                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-[13px] font-medium text-navy-900">{entry.name}</span>
                          <span className="mt-0.5 flex items-center gap-1.5 text-[10.5px] text-navy-400">
                            <OwnerAvatar
                              owner={{ displayName: entry.ownerName, email: entry.ownerEmail }}
                              size="xs"
                            />
                            <span className="truncate">
                              {ownerLabel({ displayName: entry.ownerName, email: entry.ownerEmail })} · แก้ไข{' '}
                              {formatRelativeTime(entry.modifiedAt)}
                            </span>
                          </span>
                        </span>

                        <ResourceSourceBadge source={entry.source} hideManual />
                        <ArrowRight
                          className="h-3.5 w-3.5 shrink-0 text-navy-300 opacity-0 transition-opacity group-hover:opacity-100"
                          aria-hidden
                        />
                      </Link>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>

          <section>
            <SectionHeader
              title="กิจกรรมล่าสุด"
              caption={
                summary.data && !summary.data.data.activityScopeIsOrganization
                  ? 'เฉพาะบัญชีคุณ'
                  : undefined
              }
            />

            {summary.isPending ? (
              <div className="s2-resource-card mt-3 p-4">
                <TextSkeleton lines={4} />
              </div>
            ) : summary.isError ? (
              <ErrorState message="โหลดกิจกรรมไม่สำเร็จ" onRetry={() => void summary.refetch()} />
            ) : summary.data.data.recentActivity.length === 0 ? (
              <EmptyLine text="ยังไม่มีกิจกรรม" />
            ) : (
              <ul className="mt-3 overflow-hidden rounded-2xl border border-[var(--s2-card-border)] bg-[var(--s2-layer-card)]">
                {summary.data.data.recentActivity.map((event) => {
                  const meta = ACTION_META[event.action] ?? {
                    label: activityLabel(event.action),
                    icon: PenLine,
                    tone: 'text-navy-500 bg-navy-50',
                  };
                  const Icon = meta.icon;

                  return (
                    <li key={event.id} className="flex items-center gap-3 border-b border-line px-4 py-2.5 last:border-0">
                      <span
                        className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-lg ${meta.tone}`}
                      >
                        <Icon className="h-3.5 w-3.5" aria-hidden />
                      </span>

                      <div className="min-w-0 flex-1">
                        <p className="truncate text-[12.5px] text-navy-800">
                          <span className="font-medium">{meta.label}</span>
                          {event.resourceName ? (
                            <span className="text-navy-500"> · {event.resourceName}</span>
                          ) : null}
                        </p>
                        <p className="mt-0.5 truncate text-[10.5px] text-navy-400">
                          {event.actor ? ownerLabel(event.actor) : 'ไม่ทราบผู้ใช้'}
                        </p>
                      </div>

                      <span className="shrink-0 text-[10.5px] text-navy-400">
                        {formatRelativeTime(event.createdAt)}
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        </div>

        {/* ---------- พื้นที่จัดเก็บ ---------- */}
        <StorageDonut
          data={disk}
          managedBytes={managedBytes}
          isLoading={storage.isPending}
          isError={storage.isError}
        />
      </div>
    </div>
  );
}

function SectionHeader({
  title,
  caption,
  action,
}: {
  title: string;
  caption?: string;
  action?: { to: string; label: string };
}) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-t border-line pt-4">
      <div className="flex min-w-0 items-baseline gap-2">
        <h2 className="text-[13px] font-semibold text-navy-800">{title}</h2>
        {caption ? <span className="truncate text-[11px] text-navy-400">{caption}</span> : null}
      </div>
      {action ? (
        <Link to={action.to} className="shrink-0 text-[11.5px] text-brand-600 hover:underline">
          {action.label}
        </Link>
      ) : null}
    </div>
  );
}

function Stat({
  icon: Icon,
  label,
  value,
  hint,
  loading,
  failed,
}: {
  icon: LucideIcon;
  label: string;
  value: string | null;
  hint?: string;
  loading?: boolean;
  failed?: boolean;
}) {
  return (
    <article className="s2-resource-card flex flex-col px-4 py-3.5">
      <div className="flex items-center gap-2">
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[10px] bg-brand-50 text-brand-600">
          <Icon className="h-4 w-4" aria-hidden />
        </span>
        <p className="truncate text-[11.5px] text-navy-400">{label}</p>
      </div>

      <p className="mt-2.5 text-[22px] font-semibold leading-none text-navy-900">
        {loading ? (
          <span className="s2-skeleton inline-block h-5 w-12 align-middle" />
        ) : failed || value === null ? (
          '—'
        ) : (
          value
        )}
      </p>

      <p className="mt-1.5 truncate text-[10.5px] text-navy-400">
        {failed ? 'ยังไม่มีข้อมูล' : (hint ?? ' ')}
      </p>
    </article>
  );
}

function EmptyLine({ text }: { text: string }) {
  return <div className="s2-resource-card mt-3 px-4 py-6 text-center text-[12px] text-navy-400">{text}</div>;
}
