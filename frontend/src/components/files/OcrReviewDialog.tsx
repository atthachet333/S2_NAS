import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Check, ClipboardCopy, Download, History, Loader2, RotateCcw, X } from 'lucide-react';
import { ApiError, authorizedFetch, fileApi, resourceApi } from '@/lib/api';
import type { DriveEntry } from '@/lib/drive';
import { useToast } from '@/hooks/useToast';

/**
 * กล่องตรวจแก้ข้อความของเอกสาร
 *
 * วางเอกสารต้นฉบับไว้ข้างข้อความ เพราะการตรวจแก้คือการ "เทียบ" ไม่ใช่การพิมพ์ใหม่
 * ถ้าต้องสลับหน้าจอไปมาระหว่างภาพกับข้อความ คนจะเลิกแก้ตั้งแต่เอกสารแผ่นที่สอง
 *
 * บนจอแคบวางซ้อนกันแทน เพราะสองคอลัมน์บนจอ 375px แปลว่าอ่านไม่ได้ทั้งคู่
 *
 * ตัวแก้ไขเป็นข้อความล้วนล้วน ๆ ไม่มีตัวหนา ไม่มีหัวข้อ ไม่มี markdown
 * สิ่งที่เก็บคือ "ข้อความที่อยู่ในเอกสาร" สำหรับให้ค้นหาเจอ ไม่ใช่เอกสารฉบับใหม่
 * การเปิดให้จัดรูปแบบจะทำให้ข้อความที่เก็บกับข้อความที่ค้นหาต่างกันโดยไม่จำเป็น
 */

/** ชนิดที่แสดงตัวอย่างคู่กับข้อความได้ */
function previewKind(entry: DriveEntry): 'PDF' | 'IMAGE' | 'NONE' {
  const ext = entry.name.split('.').pop()?.toLowerCase() ?? '';
  if (ext === 'pdf') return 'PDF';
  if (['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'tif', 'tiff'].includes(ext)) return 'IMAGE';
  return 'NONE';
}

const ERROR_TEXT: Record<string, string> = {
  OCR_CORRECTION_CONFLICT: 'ข้อความนี้ถูกแก้ไขโดยผู้ใช้อื่นแล้ว กรุณาโหลดข้อมูลล่าสุดก่อนบันทึกอีกครั้ง',
  OCR_CORRECTION_DENIED: 'คุณไม่มีสิทธิ์ตรวจแก้ข้อความของไฟล์นี้',
  OCR_CORRECTION_EMPTY: 'ข้อความที่ตรวจแก้ต้องไม่ว่าง',
  OCR_TEXT_NOT_FOUND: 'ไฟล์นี้ยังไม่มีข้อความให้ตรวจแก้',
  RESOURCE_ACCESS_DENIED: 'คุณไม่มีสิทธิ์ดำเนินการนี้',
  RESOURCE_NOT_FOUND: 'ไม่พบไฟล์นี้แล้ว',
  RESOURCE_LOCKED: 'ไฟล์นี้ถูกล็อกอยู่ จึงแก้ไขข้อความไม่ได้',
};

const messageOf = (error: unknown, fallback: string): string => {
  if (error instanceof ApiError) return ERROR_TEXT[error.code] ?? error.message ?? fallback;
  return fallback;
};

export function OcrReviewDialog({ entry, onClose }: { entry: DriveEntry; onClose: () => void }) {
  const queryClient = useQueryClient();
  const { notify } = useToast();
  const closeRef = useRef<HTMLButtonElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  const [draft, setDraft] = useState('');
  /** เลขรุ่นที่ฟอร์มนี้ถืออยู่ - ใช้ตรวจว่ามีคนอื่นบันทึกแทรกเข้ามาหรือไม่ */
  const [baseRevision, setBaseRevision] = useState(0);
  const [loadedFor, setLoadedFor] = useState<string | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [objectUrl, setObjectUrl] = useState<string | null>(null);

  const kind = previewKind(entry);

  const text = useQuery({
    queryKey: ['ocr-text', entry.id],
    queryFn: () => resourceApi.ocrText(entry.id),
  });

  const history = useQuery({
    queryKey: ['ocr-text-history', entry.id],
    queryFn: () => resourceApi.ocrTextHistory(entry.id),
    enabled: showHistory,
  });

  const data = text.data?.data ?? null;

  /**
   * เติมข้อความลงในช่องแก้ไขเพียงครั้งเดียวต่อการเปิดหนึ่งครั้ง
   *
   * ถ้าเติมใหม่ทุกครั้งที่ query refetch ข้อความที่ผู้ใช้กำลังพิมพ์ค้างไว้จะหายไป
   * ต่อหน้าต่อตา ซึ่งเป็นการสูญเสียงานที่ไม่มีทางกู้คืน
   */
  useEffect(() => {
    if (!data || loadedFor === entry.id) return;
    setDraft(data.text);
    setBaseRevision(data.correctionRevision);
    setLoadedFor(entry.id);
  }, [data, entry.id, loadedFor]);

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onCloseRef.current();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      previousFocus?.focus();
    };
  }, []);

  // ตัวอย่างเอกสารดึงผ่าน endpoint ที่ตรวจสิทธิ์แล้ว ไม่ใช่ URL ที่เดาได้จากภายนอก
  useEffect(() => {
    if (kind === 'NONE') return;
    let active = true;
    let created: string | null = null;

    void authorizedFetch(fileApi.contentPath(entry.id))
      .then(async (response) => {
        if (!response.ok) throw new Error(String(response.status));
        const blob = await response.blob();
        if (!active) return;
        created = URL.createObjectURL(blob);
        setObjectUrl(created);
      })
      .catch(() => {
        /* ตัวอย่างเปิดไม่ได้ไม่ควรขวางการตรวจแก้ - ช่องข้อความยังใช้ได้ตามปกติ */
      });

    return () => {
      active = false;
      if (created) URL.revokeObjectURL(created);
    };
  }, [entry.id, kind]);

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['ocr-text', entry.id] });
    void queryClient.invalidateQueries({ queryKey: ['ocr-text-history', entry.id] });
    void queryClient.invalidateQueries({ queryKey: ['ocr', entry.id] });
    // ผลการค้นหาเก่าอ้างข้อความชุดเดิม จึงต้องถือว่าใช้ไม่ได้แล้ว
    void queryClient.invalidateQueries({ queryKey: ['search'] });
  };

  const save = useMutation({
    mutationFn: () => resourceApi.saveOcrText(entry.id, { text: draft, expectedRevision: baseRevision }),
    onSuccess: (result) => {
      setBaseRevision(result.data.correctionRevision);
      setConflict(false);
      invalidate();
      notify({
        tone: 'success',
        title: 'บันทึกข้อความที่ตรวจแก้แล้ว',
        description: 'ผลการค้นหาจะใช้ข้อความฉบับนี้ตั้งแต่นี้ไป',
      });
    },
    onError: (error) => {
      const isConflict = error instanceof ApiError && error.code === 'OCR_CORRECTION_CONFLICT';
      setConflict(isConflict);
      notify({ tone: 'error', title: messageOf(error, 'บันทึกไม่สำเร็จ') });
    },
  });

  const reset = useMutation({
    mutationFn: () => resourceApi.resetOcrText(entry.id),
    onSuccess: () => {
      setLoadedFor(null);
      setConflict(false);
      invalidate();
      notify({ tone: 'success', title: 'กลับไปใช้ผล OCR เดิมแล้ว' });
    },
    onError: (error) => notify({ tone: 'error', title: messageOf(error, 'ยกเลิกการตรวจแก้ไม่สำเร็จ') }),
  });

  /** โหลดข้อความล่าสุดมาทับ - ทางออกของกรณีที่มีคนอื่นบันทึกแทรกเข้ามา */
  const reload = async () => {
    setLoadedFor(null);
    setConflict(false);
    await queryClient.invalidateQueries({ queryKey: ['ocr-text', entry.id] });
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(draft);
      notify({ tone: 'success', title: 'คัดลอกข้อความแล้ว' });
    } catch {
      notify({ tone: 'error', title: 'คัดลอกไม่สำเร็จ เบราว์เซอร์ไม่อนุญาต' });
    }
  };

  /**
   * ดาวน์โหลดเป็นไฟล์ข้อความล้วน
   *
   * ตั้งใจไม่ทำเป็น DOCX - สิ่งที่เก็บคือข้อความ ไม่ใช่เอกสารที่มีรูปแบบ
   * การห่อด้วย DOCX จะทำให้ดูเหมือนเป็นเอกสารฉบับทางการที่ระบบรับรอง ซึ่งไม่จริง
   */
  const downloadText = () => {
    const blob = new Blob([draft], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${entry.name.replace(/\.[^.]+$/, '')}.txt`;
    link.click();
    URL.revokeObjectURL(url);
  };

  const canEdit = data?.canEdit ?? false;
  const dirty = data !== null && draft !== data.text;
  const overLimit = data !== null && draft.length > data.maxCharacters;
  const staleRevision = data !== null && data.correctionRevision !== baseRevision;

  const meta = useMemo(() => {
    if (!data) return null;
    const parts: string[] = [`${draft.length.toLocaleString('th-TH')} ตัวอักษร`];
    if (data.corrected && data.correctedBy) {
      parts.push(`ตรวจแก้ล่าสุดโดย ${data.correctedBy.name}`);
    }
    if (data.truncated) parts.push('ข้อความยาวเกินเพดาน จึงเก็บได้ไม่ครบทั้งฉบับ');
    return parts.join(' · ');
  }, [data, draft.length]);

  return (
    <div
      className="fixed inset-0 z-[var(--z-dialog)] flex items-center justify-center bg-[var(--s2-overlay)] p-2 backdrop-blur-sm sm:p-3"
      onMouseDown={onClose}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="ocr-review-title"
        className="flex h-[95vh] w-full max-w-6xl flex-col overflow-hidden rounded-2xl border border-line bg-[var(--s2-elevated)] shadow-pop"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="flex items-start justify-between gap-3 border-b border-line px-4 py-3">
          <div className="min-w-0">
            <h2 id="ocr-review-title" className="truncate text-sm font-semibold text-navy-800">
              ตรวจแก้ข้อความ · {entry.name}
            </h2>
            {meta ? <p className="mt-0.5 truncate text-[11px] text-navy-400">{meta}</p> : null}
          </div>
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            aria-label="ปิด"
            className="s2-btn s2-btn-ghost h-8 w-8 shrink-0 p-0"
          >
            <X className="h-4 w-4" aria-hidden />
          </button>
        </header>

        {text.isPending ? (
          <div className="flex flex-1 items-center justify-center text-navy-400">
            <Loader2 className="h-5 w-5 animate-spin" aria-hidden />
          </div>
        ) : text.isError ? (
          <div className="flex flex-1 items-center justify-center px-6 text-center text-[12.5px] text-navy-500">
            {messageOf(text.error, 'เปิดข้อความไม่สำเร็จ')}
          </div>
        ) : !data?.available ? (
          <div className="flex flex-1 items-center justify-center px-6 text-center text-[12.5px] text-navy-500">
            ไฟล์นี้ยังไม่มีข้อความให้ตรวจแก้ กรุณาสั่งอ่านข้อความด้วย OCR ก่อน
          </div>
        ) : (
          <>
            {/* บนจอแคบวางซ้อนกัน บนจอกว้างวางคู่กันเพื่อให้เทียบได้โดยไม่ต้องสลับหน้า */}
            <div className="grid min-h-0 flex-1 grid-cols-1 gap-3 overflow-y-auto p-3 lg:grid-cols-2 lg:overflow-hidden">
              <div className="flex min-h-[240px] flex-col overflow-hidden rounded-xl border border-line bg-[var(--s2-surface-soft)] lg:min-h-0">
                <p className="border-b border-line px-3 py-1.5 text-[11px] font-semibold text-navy-600">
                  เอกสารต้นฉบับ
                </p>
                <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto p-2">
                  {kind === 'PDF' && objectUrl ? (
                    <iframe src={objectUrl} title={entry.name} className="h-full w-full rounded-lg bg-white" />
                  ) : kind === 'IMAGE' && objectUrl ? (
                    <img src={objectUrl} alt={entry.name} className="max-h-full max-w-full rounded-lg object-contain" />
                  ) : (
                    <p className="px-4 text-center text-[11.5px] text-navy-400">
                      {kind === 'NONE' ? 'ไฟล์ชนิดนี้แสดงตัวอย่างไม่ได้' : 'กำลังเปิดเอกสาร…'}
                    </p>
                  )}
                </div>
              </div>

              <div className="flex min-h-[280px] flex-col overflow-hidden rounded-xl border border-line lg:min-h-0">
                <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-3 py-1.5">
                  <p className="text-[11px] font-semibold text-navy-600">
                    ข้อความในเอกสาร
                    {data.corrected ? (
                      <span className="ml-1.5 rounded-md border border-emerald-200 bg-emerald-50 px-1.5 py-0.5 text-[10px] font-normal text-emerald-700">
                        ตรวจแก้แล้ว
                      </span>
                    ) : null}
                  </p>
                  <div className="flex items-center gap-1">
                    <button type="button" onClick={copy} className="s2-btn s2-btn-ghost h-7 gap-1 px-2 text-[11px]">
                      <ClipboardCopy className="h-3.5 w-3.5" aria-hidden />
                      คัดลอก
                    </button>
                    <button type="button" onClick={downloadText} className="s2-btn s2-btn-ghost h-7 gap-1 px-2 text-[11px]">
                      <Download className="h-3.5 w-3.5" aria-hidden />
                      .txt
                    </button>
                    <button
                      type="button"
                      onClick={() => setShowHistory((value) => !value)}
                      aria-expanded={showHistory}
                      className="s2-btn s2-btn-ghost h-7 gap-1 px-2 text-[11px]"
                    >
                      <History className="h-3.5 w-3.5" aria-hidden />
                      ประวัติ
                    </button>
                  </div>
                </div>

                {/* ข้อความล้วนเสมอ - แสดงผ่าน value ของ React ไม่ใช่ innerHTML */}
                <textarea
                  value={draft}
                  onChange={(event) => setDraft(event.target.value)}
                  readOnly={!canEdit}
                  spellCheck={false}
                  aria-label="ข้อความในเอกสาร"
                  lang="th"
                  className="min-h-[220px] flex-1 resize-none bg-transparent px-3 py-2 font-mono text-[12.5px] leading-relaxed text-navy-800 outline-none read-only:text-navy-500 lg:min-h-0"
                />

                {showHistory ? (
                  <div className="max-h-40 overflow-y-auto border-t border-line px-3 py-2">
                    {history.isPending ? (
                      <p className="text-[11px] text-navy-400">กำลังโหลดประวัติ…</p>
                    ) : (history.data?.data.length ?? 0) === 0 ? (
                      <p className="text-[11px] text-navy-400">ยังไม่มีการตรวจแก้</p>
                    ) : (
                      <ul className="space-y-1">
                        {history.data?.data.map((row) => (
                          <li key={row.revision} className="flex items-baseline justify-between gap-2 text-[11px]">
                            <span className="truncate text-navy-600">
                              รุ่นที่ {row.revision} · {row.createdBy.name}
                            </span>
                            <span className="shrink-0 text-navy-400">
                              {new Date(row.createdAt).toLocaleString('th-TH')}
                            </span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                ) : null}
              </div>
            </div>

            <footer className="flex flex-wrap items-center justify-between gap-2 border-t border-line px-4 py-2.5">
              <div className="min-w-0 flex-1">
                {conflict || staleRevision ? (
                  <p className="flex items-start gap-1.5 text-[11.5px] leading-relaxed text-amber-800">
                    <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
                    <span>
                      ข้อความนี้ถูกแก้ไขโดยผู้ใช้อื่นแล้ว กรุณาโหลดข้อมูลล่าสุดก่อนบันทึกอีกครั้ง
                      <button type="button" onClick={() => void reload()} className="ml-1.5 underline">
                        โหลดข้อมูลล่าสุด
                      </button>
                    </span>
                  </p>
                ) : overLimit ? (
                  <p className="text-[11.5px] text-amber-800">
                    ข้อความยาวเกิน {data.maxCharacters.toLocaleString('th-TH')} ตัวอักษร ส่วนที่เกินจะไม่ถูกบันทึก
                  </p>
                ) : data.rawTextDiffersFromCorrection ? (
                  <p className="text-[11.5px] text-navy-400">
                    มีผลจากการสแกนรอบใหม่ที่ยังไม่ได้ตรวจแก้ ข้อความที่ใช้ค้นหายังเป็นฉบับที่คุณแก้ไว้
                  </p>
                ) : !canEdit ? (
                  <p className="text-[11.5px] text-navy-400">คุณเปิดอ่านข้อความนี้ได้ แต่ไม่มีสิทธิ์แก้ไข</p>
                ) : null}
              </div>

              <div className="flex shrink-0 items-center gap-2">
                {canEdit && data.corrected ? (
                  <button
                    type="button"
                    onClick={() => reset.mutate()}
                    disabled={reset.isPending}
                    className="s2-btn s2-btn-outline h-8 gap-1.5 text-[12px] disabled:opacity-60"
                  >
                    <RotateCcw className="h-3.5 w-3.5" aria-hidden />
                    ใช้ผล OCR เดิม
                  </button>
                ) : null}
                <button
                  type="button"
                  onClick={() => save.mutate()}
                  disabled={!canEdit || !dirty || save.isPending || draft.trim().length === 0}
                  className="s2-btn s2-btn-primary h-8 gap-1.5 text-[12px] disabled:opacity-60"
                >
                  {save.isPending ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
                  ) : (
                    <Check className="h-3.5 w-3.5" aria-hidden />
                  )}
                  บันทึกการตรวจแก้
                </button>
              </div>
            </footer>
          </>
        )}
      </section>
    </div>
  );
}
