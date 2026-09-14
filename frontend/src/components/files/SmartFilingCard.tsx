import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Sparkles, FolderInput, RefreshCw } from 'lucide-react';
import { smartFilingApi, type SmartFilingConfidence } from '@/lib/api';
import type { DriveRoot } from '@/lib/drive-labels';
import { SmartFilingTargetDialog } from './SmartFilingTargetDialog';

/**
 * การ์ดจัดเก็บอัจฉริยะ (F22-F)
 *
 * **ออกแบบตามผลที่วัดได้จริง ไม่ใช่ตามกรณีที่ดูดีที่สุด**
 *
 * จากการวัดกับคลังเอกสารจริง 88% ของกรณีที่มีข้อเสนอจบลงที่ระดับ "รู้ว่าเป็นลูกค้ารายไหน
 * แต่ยังไม่รู้โฟลเดอร์ย่อย" และอีกจำนวนมากไม่มีข้อเสนอเลย การออกแบบหน้าจอโดยสมมติว่า
 * ระบบรู้ปลายทางเต็มรูปแบบเป็นปกติ จะทำให้สถานะที่พบบ่อยที่สุดดูเหมือนความล้มเหลว
 *
 * การ์ดนี้จึงให้พื้นที่เท่าเทียมกับทุกสถานะ และไม่ทำให้ "ยังไม่พบตำแหน่ง" ดูเหมือนข้อผิดพลาด
 *
 * **ความมั่นใจสองค่าแยกกัน** ความแน่ใจว่าเป็นลูกค้ารายใด ไม่เท่ากับความแน่ใจว่าควรอยู่
 * โฟลเดอร์ย่อยไหน หน้าจอต้องไม่ยุบสองอย่างนี้เป็นค่าเดียว
 */

const CONFIDENCE_LABEL: Record<SmartFilingConfidence, string> = {
  HIGH: 'สูง', MEDIUM: 'ปานกลาง', LOW: 'ต่ำ',
};

const CONFIDENCE_TONE: Record<SmartFilingConfidence, string> = {
  HIGH: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  MEDIUM: 'bg-amber-50 text-amber-700 border-amber-200',
  LOW: 'bg-navy-50 text-navy-600 border-line',
};

function ConfidenceChip({ value, label }: { value: SmartFilingConfidence | null; label: string }): JSX.Element | null {
  if (!value) return null;
  return (
    <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] ${CONFIDENCE_TONE[value]}`}>
      {label} {CONFIDENCE_LABEL[value]}
    </span>
  );
}

export interface SmartFilingCardProps {
  resourceId: string;
  /** โฟลเดอร์แม่ปัจจุบัน ใช้ตั้งต้นให้ตัวเลือกโฟลเดอร์ */
  currentParentId?: string | null;
  currentDriveRoot?: DriveRoot;
}

export function SmartFilingCard({ resourceId, currentParentId = null, currentDriveRoot }: SmartFilingCardProps): JSX.Element {
  const [pickerOpen, setPickerOpen] = useState(false);
  // เปิดตัวเลือกโฟลเดอร์ - การเลือกยังไม่ย้าย ต้องผ่านขั้นยืนยันเสมอ
  const onPickFolder = (): void => setPickerOpen(true);
  const queryClient = useQueryClient();
  const [pendingTarget, setPendingTarget] = useState<{ folderId: string; label: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const suggestion = useQuery({
    queryKey: ['smart-filing', resourceId],
    queryFn: async () => (await smartFilingApi.suggestion(resourceId)).data,
    retry: false,
  });

  const invalidate = async (): Promise<void> => {
    // ใช้สถาปัตยกรรม query เดิมของระบบ ไม่รีโหลดทั้งหน้า
    await queryClient.invalidateQueries({ queryKey: ['smart-filing', resourceId] });
    await queryClient.invalidateQueries({ queryKey: ['resources'] });
    await queryClient.invalidateQueries({ queryKey: ['resource', resourceId] });
  };

  const analyze = useMutation({
    mutationFn: async () => (await smartFilingApi.analyze(resourceId)).data,
    onSuccess: async () => { setError(null); await invalidate(); },
    onError: (cause: Error) => setError(cause.message),
  });

  const dismiss = useMutation({
    mutationFn: async (suggestionId: string) => smartFilingApi.dismiss(resourceId, suggestionId),
    onSuccess: async () => { setError(null); await invalidate(); },
    onError: (cause: Error) => setError(cause.message),
  });

  const accept = useMutation({
    mutationFn: async (input: { suggestionId: string; targetFolderId?: string }) =>
      smartFilingApi.accept(resourceId, input.suggestionId, input.targetFolderId),
    onSuccess: async () => { setPendingTarget(null); setError(null); await invalidate(); },
    onError: (cause: Error) => { setPendingTarget(null); setError(cause.message); },
  });

  const data = suggestion.data ?? null;
  const busy = analyze.isPending || accept.isPending || dismiss.isPending;

  const header = (
    <header className="flex items-center justify-between gap-2">
      <h3 className="flex items-center gap-2 text-[13px] font-semibold text-navy-700">
        <Sparkles className="h-4 w-4 text-brand-500" aria-hidden />
        จัดเก็บอัจฉริยะ
      </h3>
      <button type="button" className="s2-btn s2-btn-ghost text-[12px]" disabled={busy}
        onClick={() => analyze.mutate()}>
        <RefreshCw className="h-3.5 w-3.5" aria-hidden /> วิเคราะห์ใหม่
      </button>
    </header>
  );

  /** ยืนยันก่อนย้ายเสมอ - การย้ายเอกสารเป็นการกระทำที่ผู้ใช้ต้องตั้งใจ */
  const confirmation = pendingTarget ? (
    <div className="rounded-lg border border-line bg-[var(--s2-surface-soft)] p-3" role="group" aria-label="ยืนยันการย้าย">
      <p className="text-[12px] text-navy-600">ย้ายเอกสารนี้ไปที่:</p>
      <p className="mt-1 break-words text-[13px] font-medium text-navy-800">{pendingTarget.label}</p>
      <div className="mt-3 flex flex-wrap gap-2">
        <button type="button" className="s2-btn s2-btn-primary" disabled={busy}
          onClick={() => data && accept.mutate({ suggestionId: data.suggestionId, targetFolderId: pendingTarget.folderId })}>
          ยืนยันการย้าย
        </button>
        <button type="button" className="s2-btn s2-btn-outline" disabled={busy} onClick={() => setPendingTarget(null)}>
          ยกเลิก
        </button>
      </div>
    </div>
  ) : null;

  const reasons = data && data.reasons.length > 0 ? (
    <ul className="mt-2 space-y-1 text-[12px] text-navy-500">
      {data.reasons.map((reason) => <li key={reason}>• {reason}</li>)}
    </ul>
  ) : null;

  function body(): JSX.Element {
    if (suggestion.isLoading) return <p className="text-[12px] text-navy-400">กำลังตรวจสอบ…</p>;

    // ยังไม่เคยวิเคราะห์ - ไม่ใช่ข้อผิดพลาด
    if (!data) {
      return (
        <div>
          <p className="text-[12px] text-navy-500">ยังไม่ได้วิเคราะห์ตำแหน่งจัดเก็บของเอกสารนี้</p>
          <button type="button" className="s2-btn s2-btn-outline mt-3" disabled={busy} onClick={() => analyze.mutate()}>
            วิเคราะห์ตำแหน่ง
          </button>
        </div>
      );
    }

    /**
     * ข้อเสนอที่จบไปแล้วต้องรายงานผลของมันเอง ไม่ใช่รายงานว่าไม่เป็นปัจจุบัน
     *
     * การยืนยันย้ายทำให้ตำแหน่งของเอกสารเปลี่ยน ข้อเสนอที่เพิ่งถูกใช้จึง "ไม่ตรงกับโลก"
     * ทันทีตามนิยามของความไม่เป็นปัจจุบัน ถ้าตรวจความไม่เป็นปัจจุบันก่อน ผู้ใช้ที่เพิ่งกดย้าย
     * สำเร็จจะได้ข้อความว่าข้อเสนอหมดอายุ แทนที่จะได้คำยืนยันว่าการย้ายสำเร็จ
     */
    if (data.status === 'ACCEPTED') return <p className="text-[12px] text-emerald-700">ย้ายเอกสารตามข้อเสนอแล้ว</p>;

    /**
     * ข้อเสนอที่ไม่เป็นปัจจุบันแล้ว
     *
     * ห้ามให้กดย้ายต่อ เพราะเนื้อหาหรือตำแหน่งเปลี่ยนไปจากตอนที่วิเคราะห์
     * ปลายทางที่เคยถูกอาจไม่ถูกอีกต่อไป
     */
    if (data.stale || data.status === 'STALE') {
      return (
        <div>
          <p className="text-[12px] text-navy-600">ข้อเสนอนี้ไม่เป็นปัจจุบันแล้ว</p>
          <button type="button" className="s2-btn s2-btn-outline mt-3" disabled={busy} onClick={() => analyze.mutate()}>
            วิเคราะห์ใหม่
          </button>
        </div>
      );
    }

    if (data.status === 'DISMISSED') {
      return (
        <div>
          <p className="text-[12px] text-navy-500">เลือกไว้ที่เดิมแล้ว</p>
          <button type="button" className="s2-btn s2-btn-outline mt-3" onClick={onPickFolder}>เลือกโฟลเดอร์เอง</button>
        </div>
      );
    }

    // ไม่พบตำแหน่งที่เหมาะสม - เป็นผลลัพธ์ปกติ ไม่ใช่ความล้มเหลว
    if (data.resultLevel === 'NO_SUGGESTION') {
      return (
        <div>
          <p className="text-[12px] text-navy-600">ยังไม่พบตำแหน่งที่เหมาะสม</p>
          <p className="mt-1 text-[11px] text-navy-400">เอกสารนี้ยังอยู่ที่เดิม</p>
          <div className="mt-3 flex flex-wrap gap-2">
            <button type="button" className="s2-btn s2-btn-outline" onClick={onPickFolder}>เลือกโฟลเดอร์เอง</button>
            <button type="button" className="s2-btn s2-btn-ghost" disabled={busy} onClick={() => analyze.mutate()}>วิเคราะห์ใหม่</button>
          </div>
        </div>
      );
    }

    /**
     * หลายความเป็นไปได้ - ต้องไม่มีผู้ชนะโดยปริยาย
     *
     * ผู้ใช้ต้องเลือกเอง ระบบจะไม่เลือกให้แม้จะมีตัวเลือกที่คะแนนสูงกว่าเล็กน้อย
     */
    if (data.resultLevel === 'AMBIGUOUS') {
      return (
        <div>
          <p className="text-[12px] text-navy-600">พบหลายตำแหน่งที่เป็นไปได้</p>
          <ul className="mt-2 space-y-2">
            {data.alternatives.map((option) => (
              <li key={option.folderId} className="flex items-center justify-between gap-2 rounded-lg border border-line p-2">
                <span className="min-w-0 break-words text-[12px] text-navy-700">{option.pathLabel}</span>
                <button type="button" className="s2-btn s2-btn-outline shrink-0" disabled={busy}
                  onClick={() => setPendingTarget({ folderId: option.folderId, label: option.pathLabel })}>
                  เลือก
                </button>
              </li>
            ))}
          </ul>
          <div className="mt-3 flex flex-wrap gap-2">
            <button type="button" className="s2-btn s2-btn-ghost" onClick={onPickFolder}>เลือกโฟลเดอร์เอง</button>
            <button type="button" className="s2-btn s2-btn-ghost" disabled={busy}
              onClick={() => dismiss.mutate(data.suggestionId)}>ไว้ที่เดิม</button>
          </div>
        </div>
      );
    }

    const full = data.resultLevel === 'FULL_DESTINATION';
    const target = full ? data.destination : null;
    const clientLabel = data.client?.label ?? data.destination?.pathLabel ?? '';

    return (
      <div>
        {/* ปลายทางเต็มรูปแบบแสดงเส้นทางที่แนะนำ ส่วนกรณีรู้แค่ลูกค้าแสดงชื่อลูกค้า */}
        <p className="text-[12px] text-navy-600">{full ? 'แนะนำตำแหน่ง' : 'พบลูกค้าที่น่าจะตรงกับเอกสารนี้'}</p>
        <p className="mt-1 break-words text-[13px] font-medium text-navy-800">
          {full ? (target?.pathLabel ?? clientLabel) : clientLabel}
        </p>
        <div className="mt-2 flex flex-wrap gap-1.5">
          <ConfidenceChip value={data.client?.confidence ?? null} label="ความมั่นใจลูกค้า" />
          {full ? <ConfidenceChip value={data.destination?.confidence ?? null} label="ความมั่นใจตำแหน่ง" /> : null}
        </div>

        {/* ไม่รู้โฟลเดอร์ย่อยก็บอกตามตรง ดีกว่าเดาแล้วทำให้ผู้ใช้เชื่อผิด */}
        {!full ? <p className="mt-2 text-[12px] text-navy-500">ยังไม่แน่ใจโฟลเดอร์ย่อยที่เหมาะสม</p> : null}
        {reasons}

        <div className="mt-3 flex flex-wrap gap-2">
          {/*
            ชื่อลูกค้ายาวเท่าไรก็ได้ ปุ่มจึงต้องย่อข้อความแทนที่จะดันจอ

            ชื่อโฟลเดอร์ลูกค้าจริงยาวได้หลายสิบตัวอักษร ปุ่มมาตรฐานไม่ตัดบรรทัด
            ถ้าไม่บีบไว้ ปุ่มจะกว้างเกินแผงรายละเอียดและทำให้ทั้งหน้าเลื่อนแนวนอนบนจอแคบ
          */}
          <button type="button" className="s2-btn s2-btn-primary max-w-full" disabled={busy}
            onClick={() => {
              const folderId = target?.folderId ?? data.client?.folderId ?? data.destination?.folderId;
              const label = target?.pathLabel ?? clientLabel;
              if (folderId) setPendingTarget({ folderId, label });
            }}>
            <FolderInput className="h-3.5 w-3.5 shrink-0" aria-hidden />
            <span className="min-w-0 truncate">{full ? 'ย้ายเข้าโฟลเดอร์' : `ย้ายเข้า ${clientLabel}`}</span>
          </button>
          <button type="button" className="s2-btn s2-btn-outline" onClick={onPickFolder}>
            {full ? 'เลือกที่อื่น' : 'เลือกโฟลเดอร์ย่อย'}
          </button>
          <button type="button" className="s2-btn s2-btn-ghost" disabled={busy}
            onClick={() => dismiss.mutate(data.suggestionId)}>ไว้ที่เดิม</button>
        </div>
      </div>
    );
  }

  return (
    <section className="space-y-3 rounded-xl border border-line bg-[var(--s2-surface)] p-3" aria-label="จัดเก็บอัจฉริยะ">
      {header}
      {confirmation ?? body()}
      {error ? <p className="text-[12px] text-red-600" role="alert">{error}</p> : null}
      {pickerOpen ? (
        <SmartFilingTargetDialog
          resourceId={resourceId}
          currentParentId={currentParentId}
          currentDriveRoot={currentDriveRoot}
          onClose={() => setPickerOpen(false)}
          onSelect={(target) => {
            // เลือกแล้วเข้าสู่ขั้นยืนยัน ไม่ย้ายทันที
            setPickerOpen(false);
            setPendingTarget(target);
          }}
        />
      ) : null}
    </section>
  );
}
