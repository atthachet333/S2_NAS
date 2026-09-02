import { Link } from 'react-router-dom';
import { AlertCircle, CheckCircle2, ChevronDown, Loader2, RotateCcw, Upload, X } from 'lucide-react';
import { useUploadQueue, type UploadItem } from '@/hooks/useUploadQueue';
import { FileTypeIcon } from './FileTypeIcon';
import { cn, formatBytes } from '@/lib/utils';

/**
 * แผงคิวอัปโหลด
 *
 * แสดงทุกไฟล์แยกรายการพร้อมความคืบหน้าจริงจากเบราว์เซอร์
 * รายการที่ต้องให้ผู้ใช้ตัดสินใจ (เนื้อหาซ้ำ / ชื่อซ้ำ) จะแสดงตัวเลือกในแถวนั้นเลย
 * ไม่มีการเขียนทับไฟล์เดิมโดยไม่ถาม
 */
export function UploadPanel() {
  const { items, isPanelOpen, closePanel, retry, remove, cancel, resolveDecision, clearFinished } = useUploadQueue();

  if (!isPanelOpen || items.length === 0) return null;

  const active = items.filter((item) => item.state === 'UPLOADING' || item.state === 'QUEUED').length;
  const done = items.filter((item) => item.state === 'SUCCESS').length;

  return (
    <section
      role="region"
      aria-label="คิวการอัปโหลด"
      className="fixed inset-x-0 bottom-0 z-[var(--z-dialog)] mx-auto w-full max-w-[440px] sm:inset-x-auto sm:right-5 sm:bottom-5"
    >
      <div className="s2-menu overflow-hidden rounded-t-2xl p-0 sm:rounded-2xl">
        <header className="flex items-center gap-2 border-b border-line px-4 py-3">
          <Upload className="h-4 w-4 text-brand-600" aria-hidden />
          <p className="flex-1 text-[13px] font-semibold text-navy-900">
            {active > 0 ? `กำลังอัปโหลด ${active} ไฟล์` : `อัปโหลดแล้ว ${done} ไฟล์`}
          </p>
          <button
            type="button"
            onClick={clearFinished}
            className="rounded-md px-2 py-1 text-[11px] text-navy-400 transition-colors hover:bg-navy-50 hover:text-navy-700"
          >
            ล้างรายการที่เสร็จแล้ว
          </button>
          <button
            type="button"
            onClick={closePanel}
            aria-label="ย่อแผงอัปโหลด"
            className="rounded-md p-1 text-navy-400 hover:bg-navy-50 hover:text-navy-700"
          >
            <ChevronDown className="h-4 w-4" />
          </button>
        </header>

        <ul className="max-h-[46vh] overflow-y-auto">
          {items.map((item) => (
            <li key={item.id} className="border-b border-line px-4 py-3 last:border-0">
              <Row item={item} onRetry={retry} onRemove={remove} onCancel={cancel} onDecide={resolveDecision} />
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

function Row({
  item,
  onRetry,
  onRemove,
  onCancel,
  onDecide,
}: {
  item: UploadItem;
  onRetry: (id: string) => void;
  onRemove: (id: string) => void;
  onCancel: (id: string) => void;
  onDecide: (id: string, choice: 'NEW_VERSION' | 'KEEP_BOTH' | 'ALLOW_DUPLICATE' | 'CANCEL') => void;
}) {
  return (
    <div>
      <div className="flex items-start gap-2.5">
        <FileTypeIcon name={item.file.name} kind="file" size="sm" mimeType={item.file.type} />

        <div className="min-w-0 flex-1">
          <p className="truncate text-[12.5px] font-medium text-navy-900">{item.file.name}</p>
          <p className="mt-0.5 truncate text-[10.5px] text-navy-400">
            {formatBytes(item.file.size)}
            {item.versionOfName ? ` · เวอร์ชันใหม่ของ ${item.versionOfName}` : ` · ไปยัง ${item.parentName}`}
          </p>
        </div>

        <StatusIcon state={item.state} />

        <div className="flex shrink-0 items-center gap-1">
          {item.state === 'FAILED' ? (
            <button
              type="button"
              onClick={() => onRetry(item.id)}
              aria-label={`ลองอัปโหลด ${item.file.name} อีกครั้ง`}
              className="rounded-md p-1 text-navy-400 hover:bg-navy-50 hover:text-navy-700"
            >
              <RotateCcw className="h-3.5 w-3.5" />
            </button>
          ) : null}
          {item.state === 'UPLOADING' || item.state === 'QUEUED' ? (
            <button
              type="button"
              onClick={() => onCancel(item.id)}
              aria-label={`ยกเลิกการอัปโหลด ${item.file.name}`}
              className="rounded-md p-1 text-navy-400 hover:bg-navy-50 hover:text-navy-700"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          ) : (
            <button
              type="button"
              onClick={() => onRemove(item.id)}
              aria-label={`นำ ${item.file.name} ออกจากรายการ`}
              className="rounded-md p-1 text-navy-400 hover:bg-navy-50 hover:text-navy-700"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      </div>

      {item.state === 'UPLOADING' ? (
        <div
          className="mt-2 h-1 w-full overflow-hidden rounded-full bg-navy-100"
          role="progressbar"
          aria-valuenow={item.progress}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label={`ความคืบหน้าการอัปโหลด ${item.file.name}`}
        >
          <div className="h-full rounded-full bg-brand-500 transition-[width]" style={{ width: `${item.progress}%` }} />
        </div>
      ) : null}

      {item.state === 'FAILED' && item.errorMessage ? (
        <p className="mt-2 flex items-start gap-1.5 rounded-lg bg-red-50 px-2 py-1.5 text-[11px] text-red-700">
          <AlertCircle className="mt-0.5 h-3 w-3 shrink-0" aria-hidden />
          {item.errorMessage}
        </p>
      ) : null}

      {item.state === 'NEEDS_DECISION' && item.decision ? (
        <Decision item={item} onDecide={onDecide} />
      ) : null}
    </div>
  );
}

function Decision({
  item,
  onDecide,
}: {
  item: UploadItem;
  onDecide: (id: string, choice: 'NEW_VERSION' | 'KEEP_BOTH' | 'ALLOW_DUPLICATE' | 'CANCEL') => void;
}) {
  const decision = item.decision!;
  const isDuplicate = decision.kind === 'DUPLICATE_CONTENT';

  return (
    <div className="mt-2 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2.5">
      <p className="text-[11.5px] font-semibold text-amber-800">
        {isDuplicate ? 'พบไฟล์ที่มีเนื้อหาเหมือนกันใน S2 NAS' : 'มีไฟล์ชื่อนี้อยู่แล้ว'}
      </p>
      <p className="mt-0.5 truncate text-[10.5px] text-amber-700">
        {isDuplicate ? 'ไฟล์เดิม: ' : 'ไฟล์ที่มีอยู่: '}
        {decision.existing.name}
      </p>

      <div className="mt-2 flex flex-wrap gap-1.5">
        {isDuplicate ? (
          <>
            <Link
              to="/files"
              className="rounded-lg border border-amber-300 bg-white px-2 py-1 text-[11px] font-medium text-amber-800"
            >
              ดูไฟล์เดิม
            </Link>
            <button
              type="button"
              onClick={() => onDecide(item.id, 'ALLOW_DUPLICATE')}
              className="rounded-lg bg-amber-600 px-2 py-1 text-[11px] font-medium text-white"
            >
              อัปโหลดต่อ
            </button>
          </>
        ) : (
          <>
            <button
              type="button"
              onClick={() => onDecide(item.id, 'NEW_VERSION')}
              className="rounded-lg bg-amber-600 px-2 py-1 text-[11px] font-medium text-white"
            >
              อัปโหลดเป็นเวอร์ชันใหม่
            </button>
            <button
              type="button"
              onClick={() => onDecide(item.id, 'KEEP_BOTH')}
              className="rounded-lg border border-amber-300 bg-white px-2 py-1 text-[11px] font-medium text-amber-800"
            >
              เก็บเป็นไฟล์ใหม่
            </button>
          </>
        )}
        <button
          type="button"
          onClick={() => onDecide(item.id, 'CANCEL')}
          className="rounded-lg px-2 py-1 text-[11px] text-amber-700"
        >
          ยกเลิก
        </button>
      </div>
    </div>
  );
}

function StatusIcon({ state }: { state: UploadItem['state'] }) {
  const common = 'h-4 w-4 shrink-0';
  if (state === 'UPLOADING') return <Loader2 className={cn(common, 'animate-spin text-brand-500')} aria-label="กำลังอัปโหลด" />;
  if (state === 'SUCCESS') return <CheckCircle2 className={cn(common, 'text-emerald-600')} aria-label="สำเร็จ" />;
  if (state === 'FAILED') return <AlertCircle className={cn(common, 'text-red-600')} aria-label="ล้มเหลว" />;
  if (state === 'NEEDS_DECISION') return <AlertCircle className={cn(common, 'text-amber-600')} aria-label="ต้องเลือก" />;
  if (state === 'CANCELLED') return <X className={cn(common, 'text-navy-300')} aria-label="ยกเลิกแล้ว" />;
  return <span className={cn(common, 'rounded-full border border-dashed border-navy-300')} aria-label="รอคิว" />;
}
