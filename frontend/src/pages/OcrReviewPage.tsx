import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, ChevronRight, Loader2, PenLine, ScanText } from 'lucide-react';
import { PageTitle } from '@/components/ui/PageTitle';
import { EmptyState } from '@/components/ui/States';
import { OcrReviewDialog } from '@/components/files/OcrReviewDialog';
import { ApiError, authorizedFetch, fileApi, ocrReviewApi, type ReviewQueueItemDto } from '@/lib/api';
import type { DriveEntry } from '@/lib/drive';
import { useToast } from '@/hooks/useToast';

/**
 * คิวตรวจผลของ OCR
 *
 * ออกแบบรอบสิ่งเดียว: **ทำให้การตรวจเอกสารสิบฉบับติดกันไม่ทรมาน**
 *
 * เอกสารต้นฉบับอยู่ตรงกลาง ข้อความอยู่ข้าง ๆ และปุ่มที่ใช้บ่อยที่สุด
 * ("ถูกต้องแล้ว") อยู่ที่เดิมทุกครั้ง ผู้ใช้จึงกดรัวได้โดยไม่ต้องหาปุ่มใหม่ทุกฉบับ
 *
 * หลังกดแล้วเลื่อนไปรายการถัดไปเอง โดยไม่โหลดหน้าใหม่ - การโหลดหน้าใหม่
 * ทุกครั้งที่ตรวจเสร็จหนึ่งฉบับจะทำให้งานห้าสิบฉบับกลายเป็นเรื่องน่าเบื่อทันที
 */

const ERROR_TEXT: Record<string, string> = {
  OCR_REVIEW_DENIED: 'คุณไม่มีสิทธิ์ตรวจเอกสารนี้ หรือไฟล์ถูกล็อกอยู่',
  OCR_REVIEW_NOT_APPLICABLE: 'ยืนยันได้เฉพาะเอกสารที่อ่านด้วย OCR สำเร็จแล้ว',
  OCR_REVIEW_NOT_FOUND: 'ไม่พบผลการอ่านข้อความของไฟล์นี้',
  RESOURCE_ACCESS_DENIED: 'คุณไม่มีสิทธิ์ดำเนินการนี้',
};

const message = (error: unknown, fallback: string) =>
  error instanceof ApiError ? (ERROR_TEXT[error.code] ?? error.message ?? fallback) : fallback;

/** แปลงรายการในคิวเป็นรูปที่กล่องตรวจแก้ของ F14 รับได้ */
function toEntry(item: ReviewQueueItemDto): DriveEntry {
  return {
    id: item.resourceId,
    name: item.name,
    kind: 'file',
    mimeType: null,
  } as DriveEntry;
}

export default function OcrReviewPage() {
  const queryClient = useQueryClient();
  const { notify } = useToast();

  const [order, setOrder] = useState<'oldest' | 'newest' | 'lowestConfidence'>('oldest');
  const [lowConfidenceOnly, setLowConfidenceOnly] = useState(false);
  const [fileKind, setFileKind] = useState<'' | 'pdf' | 'image'>('');
  const [cursor, setCursor] = useState(0);
  const [editing, setEditing] = useState(false);
  const [objectUrl, setObjectUrl] = useState<string | null>(null);

  const params = useMemo(() => {
    const next = new URLSearchParams({ order, limit: '20' });
    if (lowConfidenceOnly) next.set('lowConfidenceOnly', 'true');
    if (fileKind) next.set('fileKind', fileKind);
    return next;
  }, [order, lowConfidenceOnly, fileKind]);

  const queue = useQuery({
    queryKey: ['ocr-review-queue', params.toString()],
    queryFn: () => ocrReviewApi.queue(params),
  });

  const items = queue.data?.data.items ?? [];
  const remaining = queue.data?.data.remaining ?? 0;
  const current = items[cursor] ?? null;

  // ตัวกรองเปลี่ยน = คิวคนละชุด ตำแหน่งเดิมจึงไม่มีความหมายอีกต่อไป
  useEffect(() => setCursor(0), [params]);

  /** ตัวอย่างเอกสารดึงผ่าน endpoint ที่ตรวจสิทธิ์แล้ว ไม่ใช่ URL ที่เดาได้ */
  useEffect(() => {
    if (!current) {
      setObjectUrl(null);
      return;
    }
    let active = true;
    let created: string | null = null;

    void authorizedFetch(fileApi.contentPath(current.resourceId))
      .then(async (response) => {
        if (!response.ok) throw new Error(String(response.status));
        const blob = await response.blob();
        if (!active) return;
        created = URL.createObjectURL(blob);
        setObjectUrl(created);
      })
      .catch(() => {
        /* เปิดตัวอย่างไม่ได้ไม่ควรขวางการตรวจ - ข้อความยังอ่านได้ */
      });

    return () => {
      active = false;
      if (created) URL.revokeObjectURL(created);
    };
  }, [current]);

  /** ไปรายการถัดไป - ถ้าหมดชุดนี้แล้วค่อยดึงชุดใหม่ */
  const next = () => {
    if (cursor + 1 < items.length) {
      setCursor((value) => value + 1);
      return;
    }
    setCursor(0);
    void queryClient.invalidateQueries({ queryKey: ['ocr-review-queue'] });
  };

  const verify = useMutation({
    mutationFn: (resourceId: string) => ocrReviewApi.verify(resourceId),
    onSuccess: () => {
      notify({ tone: 'success', title: 'บันทึกว่าตรวจแล้ว' });
      void queryClient.invalidateQueries({ queryKey: ['ocr', current?.resourceId] });
      next();
    },
    onError: (error) => notify({ tone: 'error', title: message(error, 'บันทึกไม่สำเร็จ') }),
  });

  const isPdf = current?.extension === 'pdf';

  return (
    <div className="space-y-4">
      <PageTitle
        title="คิวตรวจ OCR"
        description="ตรวจผลที่เครื่องอ่านมาทีละฉบับ เอกสารที่ถูกต้องอยู่แล้วกดยืนยันได้เลยโดยไม่ต้องแก้"
      />

      {/* ---- ตัวกรองของคิว ---- */}
      <div className="flex flex-wrap items-center gap-2">
        <select
          value={order}
          onChange={(event) => setOrder(event.target.value as typeof order)}
          aria-label="ลำดับการตรวจ"
          className="s2-input h-8 w-auto text-[12px]"
        >
          <option value="oldest">รอนานที่สุดก่อน</option>
          <option value="newest">ล่าสุดก่อน</option>
          <option value="lowestConfidence">ความมั่นใจต่ำก่อน</option>
        </select>

        <select
          value={fileKind}
          onChange={(event) => setFileKind(event.target.value as typeof fileKind)}
          aria-label="ชนิดไฟล์"
          className="s2-input h-8 w-auto text-[12px]"
        >
          <option value="">ทุกชนิด</option>
          <option value="pdf">PDF</option>
          <option value="image">รูปภาพ</option>
        </select>

        <label className="flex items-center gap-2 text-[12px] text-navy-600">
          <input
            type="checkbox"
            checked={lowConfidenceOnly}
            onChange={(event) => setLowConfidenceOnly(event.target.checked)}
            className="h-3.5 w-3.5 rounded border-line"
          />
          เฉพาะความมั่นใจต่ำ
        </label>

        {/* จำนวนที่เหลือนับจากรายการที่ผู้ใช้คนนี้เห็นได้จริง ไม่ใช่ยอดรวมของทั้งระบบ */}
        <span className="ml-auto text-[12px] text-navy-500">เหลือ {remaining} รายการ</span>
      </div>

      {queue.isPending ? (
        <div className="flex justify-center py-16 text-navy-400">
          <Loader2 className="h-6 w-6 animate-spin" aria-hidden />
        </div>
      ) : !current ? (
        <EmptyState
          icon={<ScanText className="h-6 w-6" aria-hidden />}
          title="ไม่มีเอกสารที่รอตรวจ"
          description="เอกสารที่อ่านด้วย OCR ทั้งหมดได้รับการตรวจแล้ว"
        />
      ) : (
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-[220px_minmax(0,1fr)_320px]">
          {/* ---- รายการในคิว ---- */}
          <aside className="order-2 max-h-[70vh] overflow-y-auto rounded-xl border border-line lg:order-1">
            <p className="border-b border-line px-3 py-2 text-[11px] font-semibold text-navy-600">
              รายการที่รอตรวจ
            </p>
            <ul>
              {items.map((item, index) => (
                <li key={item.resourceId}>
                  <button
                    type="button"
                    onClick={() => setCursor(index)}
                    aria-current={index === cursor}
                    className={`w-full border-b border-line px-3 py-2 text-left text-[11.5px] ${
                      index === cursor
                        ? 'bg-brand-50 font-medium text-brand-700'
                        : 'text-navy-600 hover:bg-[var(--s2-surface-soft)]'
                    }`}
                  >
                    <span className="block truncate">{item.name}</span>
                    {item.ocrConfidence !== null ? (
                      <span className="block text-[10px] text-navy-400">
                        ความมั่นใจของระบบ {item.ocrConfidence}%
                      </span>
                    ) : null}
                  </button>
                </li>
              ))}
            </ul>
          </aside>

          {/* ---- เอกสารต้นฉบับ ---- */}
          <section className="order-1 flex min-h-[320px] flex-col overflow-hidden rounded-xl border border-line bg-[var(--s2-surface-soft)] lg:order-2 lg:min-h-[70vh]">
            <p className="truncate border-b border-line px-3 py-2 text-[11.5px] font-semibold text-navy-700">
              {current.name}
            </p>
            <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto p-2">
              {objectUrl && isPdf ? (
                <iframe src={objectUrl} title={current.name} className="h-full w-full rounded-lg bg-white" />
              ) : objectUrl ? (
                <img
                  src={objectUrl}
                  alt={current.name}
                  className="max-h-full max-w-full rounded-lg object-contain"
                />
              ) : (
                <p className="text-[11.5px] text-navy-400">กำลังเปิดเอกสาร…</p>
              )}
            </div>
          </section>

          {/* ---- ข้อความและปุ่ม ---- */}
          <section className="order-3 flex flex-col gap-2.5">
            <div className="rounded-xl border border-line p-3">
              <p className="text-[11.5px] font-semibold text-navy-700">ผลที่เครื่องอ่านได้</p>
              <dl className="mt-2 space-y-1 text-[11.5px] text-navy-500">
                <div className="flex justify-between gap-2">
                  <dt>ผู้ดูแล</dt>
                  <dd className="truncate text-navy-700">{current.ownerName}</dd>
                </div>
                {current.ocrConfidence !== null ? (
                  <div className="flex justify-between gap-2">
                    <dt>ความมั่นใจของระบบ</dt>
                    <dd className="text-navy-700">{current.ocrConfidence}%</dd>
                  </div>
                ) : null}
                {current.ocrPageCount !== null ? (
                  <div className="flex justify-between gap-2">
                    <dt>จำนวนหน้า</dt>
                    <dd className="text-navy-700">{current.ocrPageCount}</dd>
                  </div>
                ) : null}
                <div className="flex justify-between gap-2">
                  <dt>ความยาวข้อความ</dt>
                  <dd className="text-navy-700">
                    {current.characterCount.toLocaleString('th-TH')} ตัวอักษร
                  </dd>
                </div>
              </dl>
            </div>

            <button
              type="button"
              onClick={() => verify.mutate(current.resourceId)}
              disabled={verify.isPending}
              className="s2-btn s2-btn-primary h-9 gap-1.5 text-[12.5px] disabled:opacity-60"
            >
              {verify.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
              ) : (
                <Check className="h-4 w-4" aria-hidden />
              )}
              ตรวจแล้วถูกต้อง
            </button>

            <button
              type="button"
              onClick={() => setEditing(true)}
              className="s2-btn s2-btn-outline h-9 gap-1.5 text-[12.5px]"
            >
              <PenLine className="h-4 w-4" aria-hidden />
              แก้ไขข้อความ
            </button>

            {/*
              * ข้าม = เลื่อนผ่านในรอบนี้เท่านั้น ไม่บันทึกว่าตรวจแล้ว
              * เอกสารจะกลับมาอยู่ในคิวรอบหน้า ซึ่งตรงกับที่ผู้ใช้คาดหวังจากคำว่า "ข้าม"
              */}
            <button
              type="button"
              onClick={next}
              className="s2-btn s2-btn-ghost h-9 gap-1.5 text-[12.5px]"
            >
              ข้ามไปก่อน
              <ChevronRight className="h-4 w-4" aria-hidden />
            </button>

            <p className="text-center text-[10.5px] leading-relaxed text-navy-400">
              “ตรวจแล้วถูกต้อง” บันทึกว่ามีคนอ่านแล้ว โดยข้อความยังเป็นผลของเครื่องตามเดิม
            </p>
          </section>
        </div>
      )}

      {/* การแก้ข้อความใช้กล่องเดิมของ F14 - ไม่มีตรรกะการแก้ข้อความชุดที่สอง */}
      {editing && current ? (
        <OcrReviewDialog
          entry={toEntry(current)}
          onClose={() => {
            setEditing(false);
            void queryClient.invalidateQueries({ queryKey: ['ocr-review-queue'] });
          }}
        />
      ) : null}
    </div>
  );
}
