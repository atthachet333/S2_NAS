import { type ReactNode } from 'react';
import { driveRootLabel } from '@/lib/drive-labels';
import { useQuery } from '@tanstack/react-query';
import { Download, Eye, Info, Lock, MessageSquareText, Share2, ShieldCheck, SquareArrowOutUpRight, Star, Tag, X } from 'lucide-react';
import { workspaceApi } from '@/lib/api';
import { ActivityTimeline } from './ActivityTimeline';
import { useWorkspaceMarks } from '@/hooks/useWorkspaceMarks';
import { useWorkspaceActions } from '@/hooks/useWorkspaceActions';
import { useDriveUi } from '@/hooks/useDriveUi';
import { getFileTypeStyle } from '@/lib/file-types';
import { cn, formatBytes, formatDateTime, formatRelativeTime } from '@/lib/utils';
import { EmptyState } from '@/components/ui/States';
import { FileTypeIcon } from './FileTypeIcon';
import { OwnerIdentity } from './OwnerIdentity';
import { ResourceSourceBadge, sourceLabel } from './ResourceSourceBadge';
import { VersionList } from './VersionList';
import { OcrPanel } from './OcrPanel';
import { downloadResource } from '@/lib/download';
import { isPreviewable } from '@/lib/file-types';
import { useToast } from '@/hooks/useToast';
import { externalResourceLabel, isExternalEntry, openExternalUrl } from '@/lib/external-resources';

/**
 * แผงรายละเอียด V5
 *
 * แสดงเฉพาะข้อมูลจริงจาก API เท่านั้น ไม่มีข้อความสมมติ
 * แท็บการเข้าถึงอ่านรายชื่อผู้มีสิทธิ์จริง และแท็บกิจกรรมอ่านบันทึกจริงของทรัพยากรนี้
 */
export function DetailsDrawer() {
  const { detailsOpen, closeDetails, selected, detailsTab, setDetailsTab } = useDriveUi();
  const { notify } = useToast();
  const { favoriteIds, toggleFavorite } = useWorkspaceMarks();
  const { handleWorkspaceAction, workspaceDialogs } = useWorkspaceActions();
  const tab = detailsTab;
  const setTab = setDetailsTab;

  // อ่านรายชื่อผู้เข้าถึงเมื่อเปิดแท็บนั้นจริง ๆ เท่านั้น
  const access = useQuery({
    queryKey: ['access', selected?.id],
    queryFn: () => workspaceApi.access(selected!.id),
    enabled: detailsOpen && tab === 'access' && Boolean(selected),
  });

  if (!detailsOpen) return null;

  const isFolder = selected?.kind === 'folder';
  const isExternal = selected ? isExternalEntry(selected) : false;
  const isFavorite = selected ? favoriteIds.has(selected.id) : false;

  // แท็บเวอร์ชันมีความหมายเฉพาะกับไฟล์เท่านั้น
  const tabs: Array<{ id: typeof tab; label: string }> = [
    { id: 'details', label: 'รายละเอียด' },
    ...(isFolder || isExternal ? [] : [{ id: 'versions' as const, label: 'เวอร์ชัน' }]),
    { id: 'access', label: 'การเข้าถึง' },
    { id: 'activity', label: 'กิจกรรม' },
  ];

  return (
    <aside
      className="fixed inset-0 z-[var(--z-context)] flex flex-col border-l border-line bg-[var(--s2-surface)] shadow-pop [animation:s2-drawer-in_.2s_ease-out] sm:left-auto sm:w-[370px] lg:static lg:z-auto lg:shadow-none"
      aria-label="รายละเอียดทรัพยากร"
    >
      <div className="flex min-h-16 shrink-0 items-center gap-3 border-b border-line px-4">
        {selected ? (
          <FileTypeIcon name={selected.name} kind={selected.kind} resourceType={selected.resourceType} />
        ) : (
          <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-navy-50 text-navy-400">
            <Info className="h-4 w-4" aria-hidden />
          </span>
        )}

        <div className="min-w-0 flex-1">
          <p className="truncate text-[13.5px] font-semibold text-navy-900">
            {selected ? selected.name : 'รายละเอียด'}
          </p>
          {selected ? (
            <div className="mt-1 flex items-center gap-1.5">
              <ResourceSourceBadge source={selected.source} />
              {selected.isLocked ? (
                <span className="inline-flex items-center gap-1 text-[10px] text-navy-400">
                  <Lock className="h-3 w-3" aria-hidden />
                  ล็อกไว้
                </span>
              ) : null}
            </div>
          ) : (
            <p className="mt-0.5 text-[10.5px] text-navy-400">เลือกทรัพยากรเพื่อดูข้อมูล</p>
          )}
        </div>

        <button
          type="button"
          onClick={closeDetails}
          className="rounded-lg p-1.5 text-navy-400 hover:bg-navy-50 hover:text-navy-700"
          aria-label="ปิดแผงรายละเอียด"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {selected ? (
        <>
          <div className="flex shrink-0 gap-1 border-b border-line px-3">
            {tabs.map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => setTab(item.id)}
                aria-current={tab === item.id ? 'true' : undefined}
                className={cn(
                  'relative px-3 py-2.5 text-[12.5px] transition-colors',
                  tab === item.id
                    ? 'font-semibold text-brand-700 after:absolute after:inset-x-2 after:bottom-0 after:h-0.5 after:rounded-full after:bg-brand-600'
                    : 'text-navy-500 hover:text-navy-800',
                )}
              >
                {item.label}
              </button>
            ))}
          </div>

          <div className="flex-1 overflow-y-auto px-4 py-4">
            {tab === 'details' ? (
              <div className="space-y-4">
                {!isFolder && !isExternal ? (
                  <div className="grid gap-2">
                    {isPreviewable(selected.name, selected.mimeType) ? (
                      <button type="button" className="s2-btn s2-btn-outline w-full" onClick={() => window.dispatchEvent(new CustomEvent('s2-preview-resource', { detail: { id: selected.id } }))}>
                        <Eye className="h-4 w-4" aria-hidden />
                        ดูตัวอย่าง
                      </button>
                    ) : null}
                    {selected.capabilities.canDownload ? (
                      <button type="button" className="s2-btn s2-btn-primary w-full" onClick={() => {
                        void downloadResource(selected.id, selected.name).catch((error: unknown) => notify({ tone: 'error', title: error instanceof Error ? error.message : 'ดาวน์โหลดไม่สำเร็จ' }));
                      }}>
                        <Download className="h-4 w-4" aria-hidden />
                        ดาวน์โหลดไฟล์ต้นฉบับ
                      </button>
                    ) : null}
                  </div>
                ) : null}
                {isExternal && selected.externalUrl ? (
                  <button type="button" className="s2-btn s2-btn-primary w-full" onClick={() => openExternalUrl(selected.externalUrl!)}>
                    <SquareArrowOutUpRight className="h-4 w-4" aria-hidden />เปิดลิงก์ในแท็บใหม่
                  </button>
                ) : null}
                <div className="flex flex-wrap gap-1.5">
                  <QuickAction
                    icon={<Star className={cn('h-3.5 w-3.5', isFavorite && 'fill-current')} />}
                    label={isFavorite ? 'อยู่ในรายการโปรด' : 'เพิ่มในรายการโปรด'}
                    active={isFavorite}
                    onClick={() => toggleFavorite(selected.id, !isFavorite)}
                  />
                  {selected.capabilities.canEdit ? (
                    <QuickAction
                      icon={<Tag className="h-3.5 w-3.5" />}
                      label="แท็ก"
                      onClick={() => handleWorkspaceAction('tags', selected)}
                    />
                  ) : null}
                  {selected.capabilities.canEdit ? (
                    <QuickAction
                      icon={<MessageSquareText className="h-3.5 w-3.5" />}
                      label="หมายเหตุ"
                      onClick={() => handleWorkspaceAction('remark', selected)}
                    />
                  ) : null}
                  {selected.capabilities.canShare ? (
                    <QuickAction
                      icon={<Share2 className="h-3.5 w-3.5" />}
                      label="สิทธิ์เข้าถึง"
                      onClick={() => handleWorkspaceAction('share', selected)}
                    />
                  ) : null}
                  {selected.capabilities.canLock ? (
                    <QuickAction
                      icon={<Lock className="h-3.5 w-3.5" />}
                      label={selected.isLocked ? 'ปลดล็อก' : 'ล็อก'}
                      onClick={() => handleWorkspaceAction(selected.isLocked ? 'unlock' : 'lock', selected)}
                    />
                  ) : null}
                </div>

              <dl className="space-y-3 text-[12.5px]">
                <Row label="ผู้ดูแลพื้นที่">
                  <OwnerIdentity
                    owner={{ displayName: selected.ownerName, email: selected.ownerEmail }}
                    caption={selected.ownerEmail}
                    size="sm"
                  />
                </Row>
                {selected.createdByIntegrationApp ? (
                  <Row label="สร้างโดย">
                    <span className="text-right">
                      <span className="block font-semibold text-navy-800">{selected.createdByIntegrationApp.name}</span>
                      <span className="block text-[10px] text-navy-400">Connected App</span>
                    </span>
                  </Row>
                ) : !isFolder && selected.uploadedBy ? (
                  <Row label={isExternal ? 'สร้างโดย' : 'อัปโหลดโดย'}>
                    <OwnerIdentity
                      owner={selected.uploadedBy}
                      caption={selected.uploadedBy.email}
                      size="sm"
                    />
                  </Row>
                ) : null}
                <Row label="ประเภท">
                  {isFolder ? 'โฟลเดอร์' : externalResourceLabel(selected.resourceType) ?? getFileTypeStyle(selected.name).label}
                </Row>
                <Row label="ตำแหน่ง">{selected.parentId ? 'ภายในโฟลเดอร์' : driveRootLabel(selected.driveRoot)}</Row>
                <Row label="ต้นทาง">{sourceLabel(selected.source)}</Row>
                {selected.sourceEntityType || selected.sourceEntityId ? (
                  <Row label="รายการต้นทาง">
                    {[selected.sourceEntityType, selected.sourceEntityId].filter(Boolean).join(' · ')}
                  </Row>
                ) : null}
                {selected.sourceUrl ? (
                  <Row label="ลิงก์ต้นทาง">
                    <a href={selected.sourceUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-brand-600 hover:underline">
                      เปิดใน {selected.createdByIntegrationApp?.name ?? selected.sourceSystem ?? 'ระบบต้นทาง'}
                      <SquareArrowOutUpRight className="h-3.5 w-3.5" />
                    </a>
                  </Row>
                ) : null}
                <Row label="ขนาด">
                  {isExternal ? '—' : isFolder
                    ? selected.itemCount === undefined
                      ? '—'
                      : `${selected.itemCount} รายการ`
                    : formatBytes(selected.sizeBytes)}
                </Row>
                {isExternal && selected.externalUrl ? <Row label="URL"><a href={selected.externalUrl} target="_blank" rel="noopener noreferrer" className="block max-w-44 truncate text-brand-600 hover:underline">{selected.externalUrl}</a></Row> : null}
                {isExternal && selected.externalProvider ? <Row label="ผู้ให้บริการ">{selected.externalProvider}</Row> : null}
                {isExternal && selected.resourceType !== 'WEB_LINK' ? <p className="rounded-xl border border-line bg-[var(--s2-surface-soft)] px-3 py-2 text-[10.5px] leading-relaxed text-navy-500">สิทธิ์ใน S2 NAS และสิทธิ์ของ Google เป็นคนละส่วนกัน</p> : null}
                <Row label="สร้างเมื่อ" title={formatDateTime(selected.createdAt)}>
                  {formatRelativeTime(selected.createdAt)}
                </Row>
                <Row label="แก้ไขล่าสุด" title={formatDateTime(selected.modifiedAt)}>
                  {formatRelativeTime(selected.modifiedAt)}
                </Row>
                {!isFolder && selected.currentVersion ? (
                  <Row label="เวอร์ชันปัจจุบัน">{`v${selected.currentVersion}`}</Row>
                ) : null}
                {selected.remark ? <Row label="หมายเหตุ">{selected.remark}</Row> : null}
                {selected.tags.length > 0 ? (
                  <Row label="แท็ก">
                    <span className="flex flex-wrap justify-end gap-1">
                      {selected.tags.map((tag) => (
                        <span
                          key={tag.id}
                          className="rounded-md border border-line bg-[var(--s2-surface-soft)] px-1.5 py-0.5 text-[10.5px] font-normal text-navy-500"
                        >
                          {tag.name}
                        </span>
                      ))}
                    </span>
                  </Row>
                ) : null}
                <Row label="สถานะ">{selected.isLocked ? 'ล็อกไว้' : 'แก้ไขได้'}</Row>
                {selected.isLocked ? (
                  <>
                    <Row label="เหตุผลที่ล็อก">{selected.lockReason ?? 'ไม่ได้ระบุ'}</Row>
                    {selected.lockedByName ? (
                      <Row label="ล็อกโดย" title={selected.lockedAt ? formatDateTime(selected.lockedAt) : undefined}>
                        {selected.lockedByName}
                      </Row>
                    ) : null}
                  </>
                ) : null}
              </dl>
              </div>
            ) : tab === 'versions' ? (
              <div className="space-y-3">
                {/* OCR อยู่คู่กับเวอร์ชัน เพราะทั้งคู่เป็นเรื่องของ "เนื้อในไฟล์" */}
                <OcrPanel entry={selected} />
                <VersionList entry={selected} />
              </div>
            ) : tab === 'access' ? (
              <div className="space-y-4">
                <div>
                  <p className="s2-section-title">ผู้ดูแลหลัก</p>
                  <div className="mt-2 rounded-xl border border-line bg-[var(--s2-surface-soft)] px-3 py-2.5">
                    <OwnerIdentity
                      owner={{ displayName: selected.ownerName, email: selected.ownerEmail }}
                      caption={selected.ownerEmail}
                      size="md"
                    />
                  </div>
                </div>

                <div className="flex items-start gap-2.5 rounded-xl border border-line bg-[var(--s2-surface-soft)] px-3 py-2.5">
                  <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-navy-400" aria-hidden />
                  <p className="text-[11.5px] leading-relaxed text-navy-500">
                    {selected.visibility === 'RESTRICTED'
                      ? 'จำกัดเฉพาะผู้ที่ได้รับสิทธิ์ ผู้ดูแลหลัก และผู้ดูแลระบบ'
                      : 'ผู้ใช้ที่เปิดใช้งานในองค์กรเปิดดูได้ตามค่าเริ่มต้น'}
                  </p>
                </div>

                <div>
                  <div className="flex items-center justify-between gap-2">
                    <p className="s2-section-title">ผู้ที่ได้รับสิทธิ์รายบุคคล</p>
                    {selected.capabilities.canShare ? (
                      <button
                        type="button"
                        onClick={() => handleWorkspaceAction('share', selected)}
                        className="text-[11.5px] text-brand-700 underline-offset-2 hover:underline"
                      >
                        จัดการ
                      </button>
                    ) : null}
                  </div>

                  {access.isPending ? (
                    <p className="mt-2 text-[11.5px] text-navy-400">กำลังโหลด…</p>
                  ) : (access.data?.data.grants.length ?? 0) === 0 ? (
                    <p className="mt-2 rounded-xl border border-dashed border-line px-3 py-3 text-[11.5px] leading-relaxed text-navy-400">
                      ยังไม่มีการให้สิทธิ์รายบุคคลกับทรัพยากรนี้
                    </p>
                  ) : (
                    <ul className="mt-2 divide-y divide-line rounded-xl border border-line">
                      {(access.data?.data.grants ?? []).map((grant) => (
                        <li key={grant.userId} className="flex items-center gap-2 px-3 py-2.5">
                          <div className="min-w-0 flex-1">
                            <OwnerIdentity owner={grant.user} caption={grant.user.email} size="sm" />
                          </div>
                          <span className="shrink-0 rounded-md border border-line bg-[var(--s2-surface-soft)] px-1.5 py-0.5 text-[10.5px] text-navy-500">
                            {grant.accessLevel === 'EDITOR' ? 'แก้ไขได้' : 'เปิดดูได้'}
                          </span>
                          {!grant.allowDownload ? (
                            <span className="shrink-0 text-[10px] text-navy-400">ห้ามดาวน์โหลด</span>
                          ) : null}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>

                <div>
                  <p className="s2-section-title">สิ่งที่คุณทำได้</p>
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {(
                      [
                        ['เปิดดู', selected.capabilities.canView],
                        ['แก้ไข', selected.capabilities.canEdit],
                        ['เปลี่ยนชื่อ', selected.capabilities.canRename],
                        ['ย้าย', selected.capabilities.canMove],
                        ['เปลี่ยนผู้ดูแล', selected.capabilities.canTransferOwner],
                        ['ลบ', selected.capabilities.canDelete],
                      ] as const
                    )
                      .filter(([, allowed]) => allowed)
                      .map(([label]) => (
                        <span
                          key={label}
                          className="rounded-md border border-line bg-[var(--s2-surface-soft)] px-1.5 py-0.5 text-[10.5px] text-navy-500"
                        >
                          {label}
                        </span>
                      ))}
                  </div>
                </div>
              </div>
            ) : (
              <ActivityTimeline resourceId={selected.id} />
            )}
          </div>
        </>
      ) : (
        <div className="flex-1 overflow-y-auto">
          <EmptyState
            icon={<Info className="h-6 w-6" aria-hidden />}
            title="ยังไม่ได้เลือกทรัพยากร"
            description="เลือกโฟลเดอร์หรือไฟล์เพื่อดูผู้ดูแล ต้นทาง และรายละเอียดอื่น"
          />
        </div>
      )}

      {workspaceDialogs}
    </aside>
  );
}

function Row({ label, children, title }: { label: string; children: ReactNode; title?: string }) {
  return (
    <div className="flex items-start justify-between gap-4 border-b border-line pb-3 last:border-b-0">
      <dt className="shrink-0 pt-0.5 text-navy-400">{label}</dt>
      <dd className="min-w-0 break-words text-right font-medium text-navy-800" title={title}>
        {children}
      </dd>
    </div>
  );
}

function QuickAction({
  icon,
  label,
  active,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  active?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        'inline-flex items-center gap-1.5 rounded-lg border px-2 py-1 text-[11.5px] transition-colors',
        active
          ? 'border-amber-200 bg-amber-50 text-amber-700'
          : 'border-line text-navy-500 hover:bg-navy-50 hover:text-navy-800',
      )}
    >
      {icon}
      {label}
    </button>
  );
}
