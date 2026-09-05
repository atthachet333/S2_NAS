import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Loader2, PenLine, ScanText } from 'lucide-react';
import { ApiError, resourceApi } from '@/lib/api';
import {
  correctedNotice,
  ocrAccuracyNotice,
  ocrActionFor,
  ocrStatusLabel,
  ocrSummary,
} from '@/lib/ocr';
import type { DriveEntry } from '@/lib/drive';
import { useToast } from '@/hooks/useToast';
import { OcrReviewDialog } from './OcrReviewDialog';

const ERROR_TEXT: Record<string, string> = {
  OCR_NOT_CONFIGURED: 'ระบบยังไม่ได้ตั้งค่าเครื่องมืออ่านข้อความ กรุณาติดต่อผู้ดูแลระบบ',
  OCR_UNSUPPORTED: 'ไฟล์นี้ไม่รองรับการอ่านข้อความ',
  OCR_DENIED: 'ต้องมีสิทธิ์แก้ไขไฟล์นี้จึงจะสั่งอ่านข้อความได้',
};

/**
 * แผงอ่านข้อความจากเอกสาร
 *
 * แสดงเฉพาะไฟล์ที่เข้าเงื่อนไข - เอกสารที่มีข้อความอยู่แล้วไม่ต้องใช้ OCR
 * และการแสดงปุ่มที่กดไปก็ไม่เกิดอะไรขึ้นทำให้ผู้ใช้สับสนมากกว่าช่วย
 *
 * OCR เป็นการสั่งเอง ไม่ใช่สิ่งที่เกิดขึ้นอัตโนมัติ เพราะมันช้าและกิน CPU มาก
 * การไล่ทำกับทุกภาพที่อัปโหลดจะเผาเวลาเครื่องไปกับโลโก้และรูปถ่ายที่ไม่มีใครค้นหา
 */
export function OcrPanel({ entry }: { entry: DriveEntry }) {
  const queryClient = useQueryClient();
  const { notify } = useToast();
  const [reviewing, setReviewing] = useState(false);

  const state = useQuery({
    queryKey: ['ocr', entry.id],
    queryFn: () => resourceApi.ocrState(entry.id),
    // ระหว่างที่งานยังไม่เสร็จ ให้ถามซ้ำเป็นระยะ เพื่อให้สถานะบนหน้าจอตามความจริง
    refetchInterval: (query) => {
      const status = query.state.data?.data.status;
      return status === 'PENDING' || status === 'PROCESSING' ? 4000 : false;
    },
    /**
     * ถามซ้ำแล้วพลาดชั่วคราวต้องไม่ทำให้ทั้งแผงหายไปจากหน้าจอ
     *
     * ผู้ใช้ที่เพิ่งกดปุ่มแล้วเห็นแผงหายไปจะสรุปว่าคำสั่งของเขาล้มเหลว
     * ทั้งที่งานกำลังทำอยู่เบื้องหลัง การคาข้อมูลชุดก่อนไว้ตรงกับความจริงมากกว่า
     */
    placeholderData: (previous) => previous,
  });

  const start = useMutation({
    mutationFn: () => resourceApi.requestOcr(entry.id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['ocr', entry.id] });
      notify({
        tone: 'success',
        title: 'เริ่มอ่านข้อความแล้ว',
        description: 'ระบบกำลังประมวลผลอยู่เบื้องหลัง คุณใช้งานต่อได้ตามปกติ',
      });
    },
    onError: (error) => {
      const code = error instanceof ApiError ? error.code : '';
      notify({
        tone: 'error',
        title: ERROR_TEXT[code] ?? (error instanceof ApiError ? error.message : 'สั่งอ่านข้อความไม่สำเร็จ'),
      });
    },
  });

  const data = state.data?.data ?? null;
  if (state.isPending || !data) return null;

  const action = ocrActionFor(data);
  const status = ocrStatusLabel(data);
  const summary = ocrSummary(data);
  const notice = ocrAccuracyNotice(data.textSource);
  const corrected = correctedNotice(data.textSource);
  /** มีข้อความให้เปิดอ่านหรือยัง - ปุ่มตรวจแก้ไม่มีความหมายถ้ายังไม่มีข้อความ */
  const hasText = data.status === 'READY' && data.textSource !== null;

  // ไฟล์ที่ไม่เข้าเงื่อนไขและไม่มีอะไรจะบอก ก็ไม่ต้องมีแผงนี้เลย
  if (action.kind === 'NONE' && !data.eligible && !notice && !hasText) return null;

  return (
    <div className="rounded-xl border border-line bg-[var(--s2-surface-soft)] px-3 py-2.5">
      <p className="flex items-center gap-1.5 text-[11.5px] font-semibold text-navy-700">
        <ScanText className="h-3.5 w-3.5 text-navy-400" aria-hidden />
        ข้อความในเอกสาร
        {status ? (
          <span className="rounded-md border border-line bg-surface px-1.5 py-0.5 text-[10px] font-normal text-navy-500">
            {status}
          </span>
        ) : null}
      </p>

      {summary ? <p className="mt-1 text-[10.5px] text-navy-400">{summary}</p> : null}

      {/* เตือนเฉพาะข้อความที่มาจากการอ่านภาพ - OCR เป็นการคาดเดา ไม่ใช่ความจริงที่ยืนยันแล้ว */}
      {notice ? (
        <p className="mt-1 rounded-lg bg-amber-50 px-2 py-1 text-[10.5px] leading-relaxed text-amber-800">
          {notice}
        </p>
      ) : null}

      {/* ตรงกันข้าม - ข้อความที่มีคนอ่านด้วยตาแล้วยืนยัน ควรบอกให้รู้ว่าเชื่อถือได้กว่า */}
      {corrected ? (
        <p className="mt-1 rounded-lg bg-emerald-50 px-2 py-1 text-[10.5px] leading-relaxed text-emerald-800">
          {corrected}
        </p>
      ) : null}

      {hasText ? (
        <button
          type="button"
          onClick={() => setReviewing(true)}
          className="s2-btn s2-btn-outline mt-2 h-8 w-full gap-1.5 text-[12px]"
        >
          <PenLine className="h-3.5 w-3.5" aria-hidden />
          เปิดข้อความและตรวจแก้
        </button>
      ) : null}

      {action.kind === 'NONE' ? (
        action.label ? <p className="mt-1.5 text-[10.5px] leading-relaxed text-navy-400">{action.label}</p> : null
      ) : (
        <button
          type="button"
          disabled={action.kind === 'BUSY' || start.isPending}
          onClick={() => start.mutate()}
          className="s2-btn s2-btn-outline mt-2 h-8 w-full gap-1.5 text-[12px] disabled:opacity-60"
        >
          {action.kind === 'BUSY' || start.isPending ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
          ) : (
            <ScanText className="h-3.5 w-3.5" aria-hidden />
          )}
          {start.isPending ? 'กำลังส่งคำขอ…' : action.label}
        </button>
      )}

      {reviewing ? <OcrReviewDialog entry={entry} onClose={() => setReviewing(false)} /> : null}
    </div>
  );
}
