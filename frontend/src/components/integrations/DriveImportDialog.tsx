import { useState } from 'react';
import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Check,
  ChevronRight,
  FileText,
  Folder,
  Loader2,
  Search,
  X,
} from 'lucide-react';
import { ApiError, googleDriveApi, type DriveEntryDto, type DriveImportSummaryDto } from '@/lib/api';
import { ENTRY_KIND, IMPORT_MODE, entrySizeText } from '@/lib/google-drive';
import { FolderPicker } from '@/components/files/FolderPicker';
import { useToast } from '@/hooks/useToast';

/**
 * เบราว์เซอร์ของ Google Drive และการนำเข้า (F19)
 *
 * รายการทั้งหมดมาจากเซิร์ฟเวอร์ - หน้าจอไม่เคยได้ access token ของ Google
 * และเรียก Drive API เองไม่ได้ ถ้าเรียกตรง token จะอยู่ในหน่วยความจำของเบราว์เซอร์
 * และเดินทางผ่านทุกส่วนขยายที่ผู้ใช้ติดตั้งไว้
 */

const ERROR_TEXT: Record<string, string> = {
  GOOGLE_DRIVE_NOT_CONNECTED: 'ยังไม่ได้เชื่อมต่อ Google Drive',
  GOOGLE_DRIVE_REAUTH_REQUIRED: 'ต้องเชื่อมต่อ Google Drive ใหม่',
  GOOGLE_DRIVE_TOO_MANY: 'เลือกได้ครั้งละไม่เกิน 100 รายการ',
  GOOGLE_DRIVE_NO_SELECTION: 'ยังไม่ได้เลือกไฟล์',
};

const message = (error: unknown, fallback: string) =>
  error instanceof ApiError ? (ERROR_TEXT[error.code] ?? error.message ?? fallback) : fallback;

export function DriveImportDialog({
  onClose,
  syncCapable,
}: {
  onClose: () => void;
  syncCapable: boolean;
}) {
  const { notify } = useToast();
  const queryClient = useQueryClient();

  const [folders, setFolders] = useState<Array<{ id: string; name: string }>>([]);
  const [search, setSearch] = useState('');
  const [term, setTerm] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [destination, setDestination] = useState<string | null>(null);
  /** ไดร์ฟที่เลือกได้ขึ้นกับสิทธิ์ - ตัวเลือกจะแสดงไดร์ฟที่เลือกไม่ได้แบบปิดไว้ ไม่ซ่อนเงียบ ๆ */
  const [driveRoot, setDriveRoot] = useState<'MY_DRIVE' | 'SYSTEM_DRIVE'>('MY_DRIVE');
  const [mode, setMode] = useState<'IMPORT_ONCE' | 'SYNCED'>('IMPORT_ONCE');
  const [summary, setSummary] = useState<DriveImportSummaryDto | null>(null);

  const folder = folders.at(-1) ?? null;
  const files = useInfiniteQuery({
    queryKey: ['drive-files', folder?.id ?? 'root', term],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) => {
      const query = new URLSearchParams();
      if (folder) query.set('folderId', folder.id);
      if (term) query.set('q', term);
      if (pageParam) query.set('pageToken', pageParam);
      return googleDriveApi.files(query);
    },
    getNextPageParam: (lastPage) => lastPage.data.nextPageToken ?? undefined,
    retry: false,
  });

  const runImport = useMutation({
    mutationFn: () =>
      googleDriveApi.import({
        fileIds: [...selected],
        destinationParentId: destination,
        driveScope: driveRoot,
        mode,
      }),
    onSuccess: (result) => {
      setSummary(result.data);
      setSelected(new Set());
      // รายการไฟล์ในพื้นที่ทำงานใช้คีย์ drive - ไม่ใช่ resources
      void queryClient.invalidateQueries({ queryKey: ['drive'] });
    },
    onError: (error) => notify({ tone: 'error', title: message(error, 'นำเข้าไม่สำเร็จ') }),
  });

  const toggle = (entry: DriveEntryDto) => {
    if (!ENTRY_KIND[entry.kind].importable) return;
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(entry.id)) next.delete(entry.id);
      else next.add(entry.id);
      return next;
    });
  };

  const items = files.data?.pages.flatMap((page) => page.data.items) ?? [];

  return (
    <div
      className="fixed inset-0 z-[var(--z-dialog)] flex items-center justify-center bg-[var(--s2-overlay)] p-3 backdrop-blur-sm"
      onMouseDown={onClose}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="drive-import-title"
        className="flex max-h-[90vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-line bg-[var(--s2-elevated)] shadow-pop"
        onMouseDown={(mouse) => mouse.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3 border-b border-line p-4">
          <div className="min-w-0">
            <h2 id="drive-import-title" className="text-sm font-semibold text-navy-800">
              นำเข้าจาก Google Drive
            </h2>
            <p className="mt-0.5 text-[11.5px] text-navy-400">
              {folders.length ? `ไดร์ฟของฉัน / ${folders.map((entry) => entry.name).join(' / ')}` : 'ไดร์ฟของฉัน'}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="ปิด"
            className="s2-btn s2-btn-ghost h-8 w-8 shrink-0 p-0"
          >
            <X className="h-4 w-4" aria-hidden />
          </button>
        </div>

        {/* ---------- ผลลัพธ์หลังนำเข้า ---------- */}
        {summary ? (
          <div className="flex-1 overflow-y-auto p-4">
            <p className="text-[13px] font-medium text-navy-800">
              นำเข้าสำเร็จ {summary.imported} · ข้าม {summary.skipped} · ล้มเหลว {summary.failed}
            </p>

            <ul className="mt-3 space-y-1.5">
              {summary.items.map((item) => (
                <li
                  key={item.googleFileId}
                  className="flex items-start justify-between gap-2 rounded-lg border border-line px-2.5 py-2 text-[12px]"
                >
                  <span className="min-w-0 flex-1 truncate text-navy-700">{item.name}</span>
                  <span
                    className={`shrink-0 text-[11px] ${
                      item.outcome === 'IMPORTED'
                        ? 'text-[var(--s2-success-ring)]'
                        : item.outcome === 'SKIPPED'
                          ? 'text-navy-400'
                          : 'text-[var(--s2-danger-ring)]'
                    }`}
                  >
                    {item.outcome === 'IMPORTED'
                      ? 'สำเร็จ'
                      : item.outcome === 'SKIPPED'
                        ? 'ข้าม'
                        : 'ล้มเหลว'}
                  </span>
                  {/* เหตุผลที่ปลอดภัยต่อการแสดง - ไม่ใช่ข้อความดิบจาก Google */}
                  {item.reason ? (
                    <span className="w-full shrink-0 text-[11px] text-navy-400">{item.reason}</span>
                  ) : null}
                </li>
              ))}
            </ul>

            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setSummary(null)}
                className="s2-btn s2-btn-outline h-9 text-[12.5px]"
              >
                นำเข้าเพิ่ม
              </button>
              <button type="button" onClick={onClose} className="s2-btn s2-btn-primary h-9 text-[12.5px]">
                เสร็จสิ้น
              </button>
            </div>
          </div>
        ) : (
          <>
            {/* ---------- ค้นหาและเส้นทาง ---------- */}
            <div className="flex flex-wrap items-center gap-2 border-b border-line p-3">
              {folder ? (
                <button
                  type="button"
                  onClick={() => setFolders((current) => current.slice(0, -1))}
                  className="s2-btn s2-btn-ghost h-8 text-[12px]"
                >
                  ← ย้อนกลับ
                </button>
              ) : null}

              <label className="relative min-w-0 flex-1">
                <Search
                  className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-navy-300"
                  aria-hidden
                />
                <input
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') setTerm(search.trim());
                  }}
                  placeholder="ค้นหาชื่อไฟล์ใน Google Drive"
                  aria-label="ค้นหาใน Google Drive"
                  className="s2-input h-8 pl-8 text-[12px]"
                />
              </label>
            </div>

            {/* ---------- รายการ ---------- */}
            <div className="min-h-0 flex-1 overflow-y-auto">
              {files.isPending ? (
                <div className="flex justify-center py-12 text-navy-400">
                  <Loader2 className="h-5 w-5 animate-spin" aria-hidden />
                </div>
              ) : files.isError ? (
                <p className="px-4 py-12 text-center text-[12.5px] text-navy-400">
                  {message(files.error, 'อ่านรายการจาก Google Drive ไม่สำเร็จ')}
                </p>
              ) : items.length === 0 ? (
                <p className="px-4 py-12 text-center text-[12.5px] text-navy-400">
                  {term ? 'ไม่พบไฟล์ที่ตรงกับคำค้น' : 'โฟลเดอร์นี้ว่างเปล่า'}
                </p>
              ) : (
                <ul>
                  {items.map((entry) => {
                    const kind = ENTRY_KIND[entry.kind];
                    const checked = selected.has(entry.id);

                    return (
                      <li key={entry.id} className="border-b border-line last:border-0">
                        <div className="flex items-center gap-2.5 px-4 py-2.5">
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={() => toggle(entry)}
                            disabled={!kind.importable}
                            aria-label={`เลือก ${entry.name}`}
                            className="h-3.5 w-3.5 shrink-0 rounded border-line disabled:opacity-40"
                          />

                          {entry.kind === 'FOLDER' ? (
                            <Folder className="h-4 w-4 shrink-0 text-navy-400" aria-hidden />
                          ) : (
                            <FileText className="h-4 w-4 shrink-0 text-navy-400" aria-hidden />
                          )}

                          <span className="min-w-0 flex-1 truncate text-[12.5px] text-navy-800">
                            {entry.name}
                          </span>

                          <span className="shrink-0 text-[11px] text-navy-400">
                            {entrySizeText(entry)}
                          </span>

                          {/* เข้าไปดูข้างในโฟลเดอร์ได้ โดยไม่เสียการเลือกที่ทำไว้ */}
                          {entry.kind === 'FOLDER' ? (
                            <button
                              type="button"
                              onClick={() => setFolders((current) => [...current, { id: entry.id, name: entry.name }])}
                              aria-label={`เปิด ${entry.name}`}
                              className="s2-btn s2-btn-ghost h-7 w-7 shrink-0 p-0"
                            >
                              <ChevronRight className="h-3.5 w-3.5" aria-hidden />
                            </button>
                          ) : null}
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}

              {files.hasNextPage ? (
                <div className="flex justify-center border-t border-line p-3">
                  <button
                    type="button"
                    onClick={() => void files.fetchNextPage()}
                    disabled={files.isFetchingNextPage}
                    className="s2-btn s2-btn-outline h-8 gap-1.5 text-[12px] disabled:opacity-60"
                  >
                    {files.isFetchingNextPage ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : null}
                    โหลดรายการเพิ่ม
                  </button>
                </div>
              ) : null}
            </div>

            {/* ---------- ปลายทางและโหมด ---------- */}
            <div className="space-y-3 border-t border-line p-4">
              <div>
                <p className="text-[11.5px] font-medium text-navy-600">ปลายทางใน S2 NAS</p>
                <div className="mt-1.5">
                  <FolderPicker
                    value={destination}
                    onChange={setDestination}
                    driveRoot={driveRoot}
                    onDriveRootChange={setDriveRoot}
                    selectableDriveRoots={['MY_DRIVE', 'SYSTEM_DRIVE']}
                    disabledDriveReason="การนำเข้าเข้าไดร์ฟของระบบต้องมีสิทธิ์เขียนในไดร์ฟนั้น"
                  />
                </div>
              </div>

              <fieldset>
                <legend className="text-[11.5px] font-medium text-navy-600">โหมดการนำเข้า</legend>
                <div className="mt-1.5 space-y-1.5">
                  {(['IMPORT_ONCE', 'SYNCED'] as const).map((value) => (
                    <label key={value} className="flex items-start gap-2">
                      <input
                        type="radio"
                        name="drive-import-mode"
                        checked={mode === value}
                        onChange={() => setMode(value)}
                        disabled={value === 'SYNCED' && !syncCapable}
                        className="mt-0.5 h-3.5 w-3.5 shrink-0 border-line"
                      />
                      <span className="min-w-0">
                        <span className="block text-[12.5px] text-navy-800">
                          {IMPORT_MODE[value].label}
                        </span>
                        {/* ความต่างของสองโหมดต้องอ่านแล้วเข้าใจทันที เลือกผิดผลต่างกันมาก */}
                        <span className="block text-[11px] leading-relaxed text-navy-400">
                          {IMPORT_MODE[value].description}
                          {value === 'SYNCED' && !syncCapable
                            ? ' ต้องเชื่อมต่อใหม่และอนุญาตการเข้าถึงต่อเนื่องก่อนใช้โหมดนี้'
                            : ''}
                        </span>
                      </span>
                    </label>
                  ))}
                </div>
              </fieldset>

              <div className="flex items-center justify-between gap-2">
                <span className="text-[11.5px] text-navy-400">เลือกแล้ว {selected.size} รายการ</span>
                <button
                  type="button"
                  onClick={() => runImport.mutate()}
                  disabled={selected.size === 0 || runImport.isPending}
                  className="s2-btn s2-btn-primary h-9 gap-1.5 text-[12.5px] disabled:opacity-50"
                >
                  {runImport.isPending ? (
                    <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                  ) : (
                    <Check className="h-4 w-4" aria-hidden />
                  )}
                  นำเข้า
                </button>
              </div>
            </div>
          </>
        )}
      </section>
    </div>
  );
}
