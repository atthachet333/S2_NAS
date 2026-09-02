import { useState, type ReactNode } from 'react';
import { Download, Eye, Info, Lock, ShieldCheck, X } from 'lucide-react';
import { useDriveUi } from '@/hooks/useDriveUi';
import { getFileTypeStyle } from '@/lib/file-types';
import { cn, formatBytes, formatDateTime, formatRelativeTime } from '@/lib/utils';
import { EmptyState } from '@/components/ui/States';
import { FileTypeIcon } from './FileTypeIcon';
import { OwnerIdentity } from './OwnerIdentity';
import { ResourceSourceBadge, sourceLabel } from './ResourceSourceBadge';
import { VersionList } from './VersionList';
import { downloadResource } from '@/lib/download';
import { isPreviewable } from '@/lib/file-types';
import { useToast } from '@/hooks/useToast';

type DetailsTab = 'details' | 'versions' | 'access' | 'activity';

/**
 * แผงรายละเอียด V3
 *
 * แสดงเฉพาะข้อมูลจริงจาก Resource API เท่านั้น
 * แท็บเวอร์ชันถูกตัดออกจนกว่าระบบเวอร์ชันจะรองรับจริง
 */
export function DetailsDrawer() {
  const { detailsOpen, closeDetails, selected } = useDriveUi();
  const { notify } = useToast();
  const [tab, setTab] = useState<DetailsTab>('details');

  if (!detailsOpen) return null;

  const isFolder = selected?.kind === 'folder';

  // แท็บเวอร์ชันมีความหมายเฉพาะกับไฟล์เท่านั้น
  const tabs: Array<{ id: DetailsTab; label: string }> = [
    { id: 'details', label: 'รายละเอียด' },
    ...(isFolder ? [] : [{ id: 'versions' as const, label: 'เวอร์ชัน' }]),
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
          <FileTypeIcon name={selected.name} kind={selected.kind} />
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
                {!isFolder ? (
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
              <dl className="space-y-3 text-[12.5px]">
                <Row label="ผู้ดูแลพื้นที่">
                  <OwnerIdentity
                    owner={{ displayName: selected.ownerName, email: selected.ownerEmail }}
                    caption={selected.ownerEmail}
                    size="sm"
                  />
                </Row>
                {!isFolder && selected.uploadedBy ? (
                  <Row label="อัปโหลดโดย">
                    <OwnerIdentity
                      owner={selected.uploadedBy}
                      caption={selected.uploadedBy.email}
                      size="sm"
                    />
                  </Row>
                ) : null}
                <Row label="ประเภท">
                  {isFolder ? 'โฟลเดอร์' : getFileTypeStyle(selected.name).label}
                </Row>
                <Row label="ตำแหน่ง">{selected.parentId ? 'ภายในโฟลเดอร์' : 'รากองค์กร'}</Row>
                <Row label="ต้นทาง">{sourceLabel(selected.source)}</Row>
                <Row label="ขนาด">
                  {isFolder
                    ? selected.itemCount === undefined
                      ? '—'
                      : `${selected.itemCount} รายการ`
                    : formatBytes(selected.sizeBytes)}
                </Row>
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
                <Row label="สถานะ">{selected.isLocked ? 'ล็อกไว้' : 'แก้ไขได้'}</Row>
              </dl>
              </div>
            ) : tab === 'versions' ? (
              <VersionList entry={selected} />
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

                <div>
                  <p className="s2-section-title">สิทธิ์เพิ่มเติม</p>
                  <div className="mt-2 flex items-start gap-2.5 rounded-xl border border-dashed border-line px-3 py-3">
                    <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-navy-300" aria-hidden />
                    <p className="text-[11.5px] leading-relaxed text-navy-400">
                      ยังไม่มีการให้สิทธิ์รายบุคคลกับทรัพยากรนี้ ขณะนี้เข้าถึงได้ผ่านผู้ดูแลหลัก
                      และสิทธิ์ตามบทบาทของผู้ใช้เท่านั้น
                    </p>
                  </div>
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
              <EmptyState
                title="ยังไม่มีบันทึกกิจกรรม"
                description="ประวัติการเข้าถึงและแก้ไขของทรัพยากรนี้จะแสดงเมื่อเปิดใช้งาน Activity Log"
                className="py-10"
              />
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
