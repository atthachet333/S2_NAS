import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  Database,
  Download,
  FileText,
  KeyRound,
  Loader2,
  Plug,
  ScanText,
  Settings,
  ShieldAlert,
  Users,
  X,
} from 'lucide-react';
import { PageTitle } from '@/components/ui/PageTitle';
import { EmptyState } from '@/components/ui/States';
import { ApiError, auditApi, authorizedFetch, type AuditEventDto } from '@/lib/api';
import {
  ACTOR_TYPE_LABELS,
  DATE_PRESETS,
  TONE_CLASS,
  auditChips,
  auditFiltersFromParams,
  formatDateTime,
  resolveDatePreset,
  resourceLabel,
  type AuditFilters,
} from '@/lib/audit';
import { useToast } from '@/hooks/useToast';

/**
 * บันทึกกิจกรรมและการตรวจสอบ
 *
 * เป็นเครื่องมือของผู้ตรวจสอบ ไม่ใช่แดชบอร์ด - ไม่มีการ์ดตัวเลขใหญ่ ๆ
 * สิ่งที่คนเปิดหน้านี้ต้องการคือ "หาเหตุการณ์ให้เจอ" ไม่ใช่ภาพรวมสวยงาม
 *
 * ตัวกรองอยู่บน URL ทั้งหมด เพื่อให้ส่งลิงก์ต่อกันระหว่างการสืบสวนได้
 */

const CATEGORY_ICONS: Record<string, typeof FileText> = {
  AUTH: KeyRound,
  FILE: FileText,
  SHARING: Users,
  CLIENT: Users,
  OCR: ScanText,
  GOVERNANCE: ShieldAlert,
  BACKUP: Database,
  INTEGRATION: Plug,
  SYSTEM: Settings,
};

const ERROR_TEXT: Record<string, string> = {
  AUDIT_DENIED: 'คุณไม่มีสิทธิ์เข้าถึงบันทึกการตรวจสอบ',
  AUDIT_EXPORT_DENIED: 'คุณไม่มีสิทธิ์ส่งออกบันทึกการตรวจสอบ',
  AUDIT_EXPORT_TOO_LARGE: 'ผลลัพธ์มากเกินไป กรุณาแคบช่วงวันที่หรือเพิ่มตัวกรอง',
};

const message = (error: unknown, fallback: string) =>
  error instanceof ApiError ? (ERROR_TEXT[error.code] ?? error.message ?? fallback) : fallback;

export default function AdminAuditPage() {
  const [params, setParams] = useSearchParams();
  const { notify } = useToast();
  const [selected, setSelected] = useState<AuditEventDto | null>(null);
  const [exporting, setExporting] = useState(false);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [pages, setPages] = useState<string[]>([]);

  const filters = auditFiltersFromParams(params);

  const catalog = useQuery({
    queryKey: ['audit-catalog'],
    queryFn: auditApi.catalog,
    staleTime: 10 * 60_000,
  });

  const cursor = pages[pages.length - 1];
  const queryString = useMemo(() => {
    const next = new URLSearchParams(params);
    next.set('limit', '50');
    if (cursor) next.set('cursor', cursor);
    return next;
  }, [params, cursor]);

  const events = useQuery({
    queryKey: ['audit-events', queryString.toString()],
    queryFn: () => auditApi.events(queryString),
    enabled: catalog.data?.data.canView !== false,
  });

  const setFilter = (key: string, value: string | null) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    setParams(next, { replace: true });
    // เปลี่ยนตัวกรอง = ผลชุดใหม่ ตำแหน่งหน้าเดิมจึงไม่มีความหมายอีกต่อไป
    setPages([]);
  };

  const clearFilters = () => {
    setParams(new URLSearchParams(), { replace: true });
    setPages([]);
  };

  /** ช่วงวันที่สำเร็จรูปถูกแปลงเป็นวันจริงก่อนเขียนลง URL */
  const applyDatePreset = (preset: string) => {
    const next = new URLSearchParams(params);
    if (!preset) {
      next.delete('from');
      next.delete('to');
    } else {
      const { from } = resolveDatePreset(preset);
      if (from) next.set('from', from);
      else next.delete('from');
      next.delete('to');
    }
    setParams(next, { replace: true });
    setPages([]);
  };

  const exportCsv = async () => {
    setExporting(true);
    try {
      const body: AuditFilters = { ...filters };
      const response = await authorizedFetch(auditApi.exportPath, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        const payload = await response.json().catch(() => null);
        throw new ApiError(
          payload?.error?.code ?? 'EXPORT_FAILED',
          payload?.error?.message ?? 'ส่งออกไม่สำเร็จ',
          response.status,
        );
      }

      /**
       * ชื่อไฟล์มาจาก header ที่เซิร์ฟเวอร์กำหนด ไม่ใช่จากหน้าจอ
       * หน้าจอเพียงแต่รับไฟล์แล้วบันทึกลงเครื่องผู้ใช้
       */
      const disposition = response.headers.get('Content-Disposition') ?? '';
      const match = /filename="([^"]+)"/.exec(disposition);
      const filename = match?.[1] ?? 's2-nas-audit.csv';

      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = filename;
      link.click();
      URL.revokeObjectURL(url);

      notify({
        tone: 'success',
        title: `ส่งออก ${response.headers.get('X-Audit-Row-Count') ?? ''} รายการแล้ว`,
      });
    } catch (error) {
      notify({ tone: 'error', title: message(error, 'ส่งออกไม่สำเร็จ') });
    } finally {
      setExporting(false);
    }
  };

  const meta = catalog.data?.data;
  const chips = auditChips(filters, {
    presets: new Map((meta?.presets ?? []).map((p) => [p.slug, p.name])),
    categories: new Map((meta?.categories ?? []).map((c) => [c.code, c.label])),
    events: new Map((meta?.events ?? []).map((e) => [e.code, e.label])),
  });

  if (meta && !meta.canView) {
    return (
      <div className="space-y-4">
        <PageTitle title="บันทึกกิจกรรมและการตรวจสอบ" description="เครื่องมือค้นหาและตรวจสอบเหตุการณ์ในระบบ" />
        <EmptyState
          icon={<ShieldAlert className="h-6 w-6" aria-hidden />}
          title="คุณไม่มีสิทธิ์เข้าถึงบันทึกการตรวจสอบ"
          description="บันทึกนี้รวมข้อมูลว่าใครเปิดดูเอกสารใดเมื่อไร จึงจำกัดไว้เฉพาะผู้ที่ได้รับสิทธิ์"
        />
      </div>
    );
  }

  const items = events.data?.data.items ?? [];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <PageTitle
          title="บันทึกกิจกรรมและการตรวจสอบ"
          description="ค้นหาและตรวจสอบเหตุการณ์ทั้งหมดที่ระบบบันทึกไว้"
        />
        {meta?.canExport ? (
          <button
            type="button"
            onClick={() => void exportCsv()}
            disabled={exporting}
            className="s2-btn s2-btn-outline h-9 gap-1.5 text-[12.5px] disabled:opacity-60"
          >
            {exporting ? (
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
            ) : (
              <Download className="h-4 w-4" aria-hidden />
            )}
            ส่งออก CSV
          </button>
        ) : null}
      </div>

      {/* ---------- ชุดสำเร็จรูป ---------- */}
      <div className="flex flex-wrap gap-1.5">
        {(meta?.presets ?? []).map((preset) => (
          <button
            key={preset.slug}
            type="button"
            title={preset.description}
            onClick={() => setFilter('preset', preset.slug === 'all' ? null : preset.slug)}
            aria-pressed={(filters.preset ?? 'all') === preset.slug}
            className={`rounded-lg border px-2.5 py-1 text-[11.5px] ${
              (filters.preset ?? 'all') === preset.slug
                ? 'border-brand-300 bg-brand-50 font-medium text-brand-700'
                : 'border-line text-navy-600 hover:bg-[var(--s2-surface-soft)]'
            }`}
          >
            {preset.name}
          </button>
        ))}
      </div>

      {/* ---------- ตัวกรอง ---------- */}
      {/*
        บนจอแคบตัวกรองอยู่ในแผ่นที่เลื่อนขึ้นมา
        ถ้าปล่อยให้กางอยู่ตลอด ผลลัพธ์จะถูกดันตกจอไปหมด และหน้านี้มีไว้เพื่อดูผลลัพธ์
      */}
      <button
        type="button"
        onClick={() => setFiltersOpen(true)}
        className="s2-btn s2-btn-outline h-9 w-full text-[12.5px] lg:hidden"
      >
        ตัวกรองและช่วงเวลา
      </button>

      {filtersOpen ? (
        <div
          className="fixed inset-0 z-[var(--z-dialog)] bg-[var(--s2-overlay)] lg:hidden"
          onMouseDown={() => setFiltersOpen(false)}
          aria-hidden
        />
      ) : null}

      <div
        className={`${
          filtersOpen
            ? 'fixed inset-x-0 bottom-0 z-[var(--z-dialog)] max-h-[80vh] overflow-y-auto rounded-t-2xl bg-[var(--s2-elevated)] shadow-pop'
            : 'hidden'
        } grid grid-cols-1 gap-2.5 border border-line p-3 sm:grid-cols-2 lg:static lg:grid lg:max-h-none lg:overflow-visible lg:rounded-xl lg:bg-[var(--s2-surface-soft)] lg:shadow-none lg:grid-cols-4`}
      >
        <div className="flex items-center justify-between sm:col-span-2 lg:hidden">
          <span className="text-[12.5px] font-medium text-navy-700">ตัวกรอง</span>
          <button
            type="button"
            onClick={() => setFiltersOpen(false)}
            aria-label="ปิดตัวกรอง"
            className="s2-btn s2-btn-ghost h-8 w-8 p-0"
          >
            <X className="h-4 w-4" aria-hidden />
          </button>
        </div>

        <label className="flex flex-col gap-1">
          <span className="text-[11px] font-medium text-navy-500">ค้นหา</span>
          <input
            defaultValue={filters.q ?? ''}
            key={filters.q ?? ''}
            onKeyDown={(event) => {
              if (event.key === 'Enter') setFilter('q', event.currentTarget.value.trim() || null);
            }}
            placeholder="ชื่อผู้ดำเนินการ อีเมล หรือเหตุการณ์"
            className="s2-input h-8 text-[12px]"
          />
        </label>

        <label className="flex flex-col gap-1">
          <span className="text-[11px] font-medium text-navy-500">หมวดหมู่</span>
          <select
            value={filters.category ?? ''}
            onChange={(event) => setFilter('category', event.target.value || null)}
            className="s2-input h-8 text-[12px]"
          >
            <option value="">ทั้งหมด</option>
            {(meta?.categories ?? []).map((category) => (
              <option key={category.code} value={category.code}>
                {category.label}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1">
          <span className="text-[11px] font-medium text-navy-500">เหตุการณ์</span>
          <select
            value={filters.action ?? ''}
            onChange={(event) => setFilter('action', event.target.value || null)}
            className="s2-input h-8 text-[12px]"
          >
            <option value="">ทั้งหมด</option>
            {(meta?.events ?? []).map((event) => (
              <option key={event.code} value={event.code}>
                {event.label}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1">
          <span className="text-[11px] font-medium text-navy-500">ประเภทผู้ดำเนินการ</span>
          <select
            value={filters.actorType ?? ''}
            onChange={(event) => setFilter('actorType', event.target.value || null)}
            className="s2-input h-8 text-[12px]"
          >
            <option value="">ทั้งหมด</option>
            {Object.entries(ACTOR_TYPE_LABELS).map(([code, label]) => (
              <option key={code} value={code}>
                {label}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1">
          <span className="text-[11px] font-medium text-navy-500">ช่วงเวลา</span>
          <select
            value={filters.from ? 'custom' : ''}
            onChange={(event) => applyDatePreset(event.target.value)}
            className="s2-input h-8 text-[12px]"
          >
            <option value="">ทุกช่วงเวลา</option>
            {Object.entries(DATE_PRESETS)
              .filter(([key]) => key !== 'custom')
              .map(([key, label]) => (
                <option key={key} value={key}>
                  {label}
                </option>
              ))}
          </select>
        </label>

        <label className="flex items-end gap-2 text-[12px] text-navy-600">
          <input
            type="checkbox"
            checked={filters.failuresOnly === true}
            onChange={(event) => setFilter('failuresOnly', event.target.checked ? 'true' : null)}
            className="mb-2 h-3.5 w-3.5 rounded border-line"
          />
          <span className="mb-1.5">เฉพาะที่ล้มเหลว/ถูกปฏิเสธ</span>
        </label>
      </div>

      {/* ---------- ป้ายตัวกรอง ---------- */}
      {chips.length > 0 ? (
        <div className="flex flex-wrap items-center gap-2">
          {chips.map((chip) => (
            <button
              key={chip.key}
              type="button"
              onClick={() => setFilter(chip.key, null)}
              aria-label={`ล้างตัวกรอง ${chip.label}`}
              className="inline-flex items-center gap-1 rounded-full border border-brand-200 bg-brand-50 py-1 pl-2.5 pr-1.5 text-[11.5px] text-brand-700"
            >
              {chip.label}
              <X className="h-3 w-3" aria-hidden />
            </button>
          ))}
          <button
            type="button"
            onClick={clearFilters}
            className="text-[11.5px] text-navy-400 underline-offset-2 hover:underline"
          >
            ล้างตัวกรอง
          </button>
        </div>
      ) : null}

      {/* ---------- ตารางเหตุการณ์ ---------- */}
      {events.isPending ? (
        <div className="flex justify-center py-16 text-navy-400">
          <Loader2 className="h-6 w-6 animate-spin" aria-hidden />
        </div>
      ) : events.isError ? (
        <EmptyState
          icon={<ShieldAlert className="h-6 w-6" aria-hidden />}
          title={message(events.error, 'โหลดบันทึกไม่สำเร็จ')}
        />
      ) : items.length === 0 ? (
        <EmptyState
          icon={<FileText className="h-6 w-6" aria-hidden />}
          title="ไม่พบบันทึกกิจกรรมที่ตรงกับตัวกรองนี้"
          description="ลองขยายช่วงเวลา หรือล้างตัวกรองบางอย่างออก"
          action={
            <button type="button" onClick={clearFilters} className="s2-btn s2-btn-outline h-8 text-[12px]">
              ล้างตัวกรอง
            </button>
          }
        />
      ) : (
        <>
          {/* บนจอแคบเป็นการ์ดเรียงลง บนจอกว้างเป็นตาราง - ไม่มีตารางที่เลื่อนออกนอกจอ */}
          <ul className="overflow-hidden rounded-xl border border-line">
            <li className="hidden gap-3 border-b border-line bg-[var(--s2-surface-soft)] px-3 py-2 text-[11px] font-medium text-navy-500 lg:grid lg:grid-cols-[150px_minmax(0,1fr)_150px_minmax(0,1fr)_110px]">
              <span>เวลา</span>
              <span>เหตุการณ์</span>
              <span>ผู้ดำเนินการ</span>
              <span>ทรัพยากร</span>
              <span>หมวดหมู่</span>
            </li>

            {items.map((event) => {
              const Icon = CATEGORY_ICONS[event.category] ?? FileText;
              const resource = resourceLabel(event.resource);
              return (
                <li key={event.id} className="border-b border-line last:border-0">
                  <button
                    type="button"
                    onClick={() => setSelected(event)}
                    className="flex w-full flex-col gap-1 px-3 py-2.5 text-left hover:bg-[var(--s2-surface-soft)] lg:grid lg:grid-cols-[150px_minmax(0,1fr)_150px_minmax(0,1fr)_110px] lg:items-center lg:gap-3"
                  >
                    <span className="text-[11px] text-navy-400">{formatDateTime(event.createdAt)}</span>

                    <span className="flex items-center gap-1.5 text-[12.5px] text-navy-800">
                      <Icon className="h-3.5 w-3.5 shrink-0 text-navy-400" aria-hidden />
                      <span className="truncate">{event.label}</span>
                    </span>

                    <span className="truncate text-[11.5px] text-navy-600">
                      {event.actor.displayName}
                    </span>

                    <span className="truncate text-[11.5px] text-navy-500">
                      {resource ?? '—'}
                    </span>

                    <span
                      className={`inline-flex w-fit rounded-md border px-1.5 py-0.5 text-[10.5px] ${
                        TONE_CLASS[event.tone] ?? TONE_CLASS.NEUTRAL
                      }`}
                    >
                      {(meta?.categories ?? []).find((c) => c.code === event.category)?.label ??
                        event.category}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>

          {/* ---------- การเลื่อนหน้า ---------- */}
          <div className="flex items-center justify-between gap-2">
            <button
              type="button"
              disabled={pages.length === 0}
              onClick={() => setPages((list) => list.slice(0, -1))}
              className="s2-btn s2-btn-ghost h-8 text-[12px] disabled:opacity-40"
            >
              ก่อนหน้า
            </button>
            <span className="text-[11.5px] text-navy-400">
              แสดง {items.length} รายการ
              {events.data?.data.hasMore ? ' · ยังมีเพิ่มเติม' : ''}
            </span>
            <button
              type="button"
              disabled={!events.data?.data.nextCursor}
              onClick={() =>
                setPages((list) => [...list, events.data!.data.nextCursor!])
              }
              className="s2-btn s2-btn-ghost h-8 text-[12px] disabled:opacity-40"
            >
              ถัดไป
            </button>
          </div>
        </>
      )}

      {selected ? (
        <EventDetails
          event={selected}
          categoryLabel={
            (meta?.categories ?? []).find((c) => c.code === selected.category)?.label ?? selected.category
          }
          onClose={() => setSelected(null)}
        />
      ) : null}
    </div>
  );
}

/**
 * รายละเอียดของเหตุการณ์
 *
 * ไม่แสดง JSON ดิบ - ทุกฟิลด์ที่เห็นผ่านบัญชีอนุญาตของเหตุการณ์นั้นมาแล้วจากเซิร์ฟเวอร์
 * รหัสดิบแสดงไว้ให้ผู้ดูแลที่ต้องการความแม่นยำ แต่ไม่ใช่สิ่งแรกที่ตาไปเจอ
 */
function EventDetails({
  event,
  categoryLabel,
  onClose,
}: {
  event: AuditEventDto;
  categoryLabel: string;
  onClose: () => void;
}) {
  const rows: Array<[string, string]> = [
    ['เวลา', formatDateTime(event.createdAt)],
    ['เหตุการณ์', event.label],
    ['หมวดหมู่', categoryLabel],
    ['ผู้ดำเนินการ', event.actor.displayName],
    ['ประเภทผู้ใช้', ACTOR_TYPE_LABELS[event.actor.type] ?? event.actor.type],
  ];
  if (event.actor.email) rows.push(['อีเมล', event.actor.email]);
  if (event.resource) rows.push(['ทรัพยากร', resourceLabel(event.resource) ?? '—']);
  if (event.ipAddress) rows.push(['IP', event.ipAddress]);
  if (event.userAgent) rows.push(['อุปกรณ์', event.userAgent]);

  return (
    <div
      className="fixed inset-0 z-[var(--z-dialog)] flex items-center justify-center bg-[var(--s2-overlay)] p-3 backdrop-blur-sm"
      onMouseDown={onClose}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="audit-detail-title"
        className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-2xl border border-line bg-[var(--s2-elevated)] p-5 shadow-pop"
        onMouseDown={(mouse) => mouse.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3">
          <h2 id="audit-detail-title" className="text-sm font-semibold text-navy-800">
            {event.label}
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="ปิด"
            className="s2-btn s2-btn-ghost h-8 w-8 shrink-0 p-0"
          >
            <X className="h-4 w-4" aria-hidden />
          </button>
        </div>

        <dl className="mt-3 space-y-1.5 text-[12px]">
          {rows.map(([key, value]) => (
            <div key={key} className="flex justify-between gap-3">
              <dt className="shrink-0 text-navy-400">{key}</dt>
              {/* แสดงผ่าน children ของ React เสมอ - ชื่อที่มี HTML จึงเป็นข้อความล้วน */}
              <dd className="min-w-0 break-words text-right text-navy-700">{value}</dd>
            </div>
          ))}
        </dl>

        {Object.keys(event.details).length > 0 ? (
          <div className="mt-3 rounded-lg bg-[var(--s2-surface-soft)] p-2.5">
            <p className="text-[11px] font-medium text-navy-500">รายละเอียดเพิ่มเติม</p>
            <dl className="mt-1 space-y-1 text-[11.5px]">
              {Object.entries(event.details).map(([key, value]) => (
                <div key={key} className="flex justify-between gap-3">
                  <dt className="shrink-0 text-navy-400">{key}</dt>
                  <dd className="min-w-0 break-words text-right text-navy-700">{String(value)}</dd>
                </div>
              ))}
            </dl>
          </div>
        ) : null}

        <p className="mt-3 text-[10.5px] text-navy-400">
          รหัสเหตุการณ์: <code className="font-mono">{event.action}</code>
        </p>
      </section>
    </div>
  );
}
