import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Loader2, ShieldQuestion } from 'lucide-react';
import {
  ApiError,
  CLASSIFICATION_LABEL,
  CLASSIFICATION_ORDER,
  classificationApi,
  type ResourceClassification,
} from '@/lib/api';
import { lifecycleInvalidationKeys } from '@/lib/lifecycle-invalidation';
import type { DriveEntry } from '@/lib/drive';
import { useAuth } from '@/hooks/useAuth';
import { useToast } from '@/hooks/useToast';

/**
 * การจัดชั้นความลับในแผงรายละเอียด (F25-D)
 *
 * **หน้าจอไม่ตัดสินใจแทนเซิร์ฟเวอร์** ทุกกฎถูกบังคับใช้ฝั่งหลังบ้านอยู่แล้ว ส่วนนี้มีไว้เพื่อ
 * บอกผลกระทบ "ก่อน" ผู้ใช้กด ไม่ใช่เพื่อกันไม่ให้กด การซ่อนปุ่มที่เซิร์ฟเวอร์จะปฏิเสธอยู่ดี
 * ทำให้ผู้ใช้ไม่รู้ว่ามีความสามารถนี้อยู่และต้องขอสิทธิ์จากใคร
 *
 * เหตุผลของการลดชั้นจึงแสดงตลอดเมื่อเลือกชั้นที่ต่ำลง แม้ผู้ใช้จะยังไม่มีสิทธิ์
 */

const ERROR_TEXT: Record<string, string> = {
  CLASSIFICATION_DECLASSIFY_DENIED: 'คุณไม่มีสิทธิ์ลดชั้นความลับ ต้องให้ผู้ดูแลระบบมอบสิทธิ์นี้ก่อน',
  CLASSIFICATION_REASON_REQUIRED: 'ต้องระบุเหตุผลของการลดชั้นความลับอย่างน้อย 10 ตัวอักษร',
  CLASSIFICATION_BLOCKED_HOLD: 'ลดชั้นไม่ได้ เอกสารนี้อยู่ระหว่างการระงับตามกฎหมาย',
  CLASSIFICATION_VISIBILITY_CONFLICT:
    'ชั้น "จำกัดการเข้าถึง" ต้องตั้งการมองเห็นภายในเป็นแบบจำกัดก่อน',
  CLASSIFICATION_UNCHANGED: 'เอกสารนี้อยู่ในชั้นความลับนี้อยู่แล้ว',
  RESOURCE_ACCESS_DENIED: 'คุณไม่มีสิทธิ์แก้ไขเอกสารนี้',
};

const message = (error: unknown, fallback: string) =>
  error instanceof ApiError ? (ERROR_TEXT[error.code] ?? error.message ?? fallback) : fallback;

const rank = (level: ResourceClassification) => CLASSIFICATION_ORDER.indexOf(level);

const MIN_REASON_LENGTH = 10;

export function ClassificationControl({ entry }: { entry: DriveEntry }) {
  const queryClient = useQueryClient();
  const { notify } = useToast();
  const { user } = useAuth();
  const [level, setLevel] = useState<ResourceClassification>(entry.classification);
  const [reason, setReason] = useState('');

  useEffect(() => {
    setLevel(entry.classification);
    setReason('');
  }, [entry.id, entry.classification]);

  const current = entry.classification;
  const changed = level !== current;
  const lowering = rank(level) < rank(current);

  /*
   * ถามผลกระทบจากเซิร์ฟเวอร์เฉพาะตอนที่ผู้ใช้เลือกชั้นที่ต่างจากเดิมจริง ๆ
   * ถามทุกครั้งที่เปิดแผงจะยิงคำขอให้เอกสารทุกฉบับที่ผู้ใช้คลิกดู โดยที่ส่วนใหญ่ไม่ได้จะเปลี่ยนอะไร
   */
  const impact = useQuery({
    queryKey: ['classification-impact', entry.id, level],
    queryFn: () => classificationApi.impact(entry.id, level),
    enabled: changed,
    staleTime: 30_000,
  });

  const save = useMutation({
    mutationFn: () =>
      classificationApi.set(entry.id, { level, reason: reason.trim() || null }),
    onSuccess: () => {
      setReason('');
      for (const queryKey of lifecycleInvalidationKeys(entry.id)) {
        void queryClient.invalidateQueries({ queryKey });
      }
      notify({ tone: 'success', title: `เปลี่ยนชั้นความลับเป็น "${CLASSIFICATION_LABEL[level]}" แล้ว` });
    },
    onError: (error) => notify({ tone: 'error', title: message(error, 'เปลี่ยนชั้นความลับไม่สำเร็จ') }),
  });

  if (!entry.capabilities?.canEdit) {
    return (
      <div className="mt-2.5 flex items-center justify-between gap-2 text-[11.5px]">
        <span className="text-navy-400">ชั้นความลับ</span>
        <span className="text-navy-700">{CLASSIFICATION_LABEL[current]}</span>
      </div>
    );
  }

  const data = impact.data?.data;
  const blocksSomething =
    data && (data.publicLinksBlocked > 0 || data.externalGrantsBlocked > 0 || data.ancestorLinksHidingResource > 0);

  return (
    <div className="mt-2.5 space-y-1.5 border-t border-line pt-2.5">
      <label className="block">
        <span className="text-[10.5px] text-navy-400">ชั้นความลับ (เพดานการเปิดเผยออกนอกองค์กร)</span>
        <select
          value={level}
          onChange={(event) => setLevel(event.target.value as ResourceClassification)}
          disabled={save.isPending}
          className="s2-input mt-0.5 h-8 w-full text-[12px]"
        >
          {CLASSIFICATION_ORDER.map((option) => (
            <option key={option} value={option}>
              {CLASSIFICATION_LABEL[option]}
            </option>
          ))}
        </select>
      </label>

      {/*
        * ค่าเริ่มต้นของระบบไม่ใช่การตัดสินใจของใคร - บอกให้ชัด
        * ผู้ตรวจสอบที่เห็น "ภายใน" เฉย ๆ จะเข้าใจว่ามีคนพิจารณาแล้ว ทั้งที่ยังไม่เคยมีใครดู
        */}
      {!entry.classifiedAt ? (
        <p className="flex items-start gap-1 text-[10.5px] text-navy-400">
          <ShieldQuestion className="mt-px h-3 w-3 shrink-0" aria-hidden />
          ยังไม่มีใครจัดชั้นเอกสารนี้ - ค่าที่เห็นเป็นค่าเริ่มต้นของระบบ
        </p>
      ) : null}

      {changed && impact.isFetching ? (
        <p className="flex items-center gap-1 text-[10.5px] text-navy-400">
          <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
          กำลังตรวจผลกระทบ
        </p>
      ) : null}

      {/*
        * คำเตือนผลกระทบมาจากเซิร์ฟเวอร์ ไม่ได้คำนวณที่นี่
        * แยกลิงก์ของเอกสารเองออกจากลิงก์ของโฟลเดอร์แม่ เพราะผลต่างกันคนละแบบ
        */}
      {changed && blocksSomething ? (
        <div className="rounded-md border border-amber-200 bg-amber-50 px-1.5 py-1 text-[10.5px] text-amber-800">
          <p className="flex items-center gap-1 font-medium">
            <AlertTriangle className="h-3 w-3" aria-hidden />
            การเปลี่ยนนี้จะปิดการเข้าถึงที่ใช้งานอยู่
          </p>
          <ul className="mt-0.5 list-inside list-disc">
            {data!.publicLinksBlocked > 0 ? (
              <li>ลิงก์สาธารณะของเอกสารนี้ {data!.publicLinksBlocked} ลิงก์จะใช้ไม่ได้</li>
            ) : null}
            {data!.ancestorLinksHidingResource > 0 ? (
              <li>
                เอกสารนี้จะหายไปจากลิงก์ของโฟลเดอร์แม่ {data!.ancestorLinksHidingResource} ลิงก์
                (ตัวลิงก์ยังใช้ได้ตามปกติ)
              </li>
            ) : null}
            {data!.externalGrantsBlocked > 0 ? (
              <li>สิทธิ์ของบัญชีลูกค้า {data!.externalGrantsBlocked} รายการจะใช้ไม่ได้</li>
            ) : null}
          </ul>
          <p className="mt-0.5">สิทธิ์และลิงก์ทั้งหมดยังถูกเก็บไว้ ปรับชั้นกลับแล้วใช้งานได้เหมือนเดิม</p>
        </div>
      ) : null}

      {changed && data?.visibilityConflict ? (
        <p className="rounded-md border border-rose-200 bg-rose-50 px-1.5 py-1 text-[10.5px] text-rose-700">
          ชั้นนี้ต้องตั้งการมองเห็นภายในเป็นแบบจำกัดก่อน ระบบจะไม่เปลี่ยนให้เองเพราะเป็นการถอนสิทธิ์ของผู้ที่เข้าถึงได้อยู่
        </p>
      ) : null}

      {lowering ? (
        <>
          <input
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            maxLength={500}
            placeholder="เหตุผลของการลดชั้นความลับ (บังคับ)"
            aria-label="เหตุผลของการลดชั้นความลับ"
            className="s2-input h-8 w-full text-[11.5px]"
          />
          {!user?.permissions.includes('system:classification:declassify') ? (
            <p className="text-[10.5px] text-navy-400">
              การลดชั้นต้องใช้สิทธิ์เฉพาะ หากต้องการดำเนินการ ให้ขอสิทธิ์จากผู้ดูแลระบบ
            </p>
          ) : null}
        </>
      ) : null}

      <button
        type="button"
        onClick={() => save.mutate()}
        disabled={save.isPending || !changed || (lowering && reason.trim().length < MIN_REASON_LENGTH)}
        className="s2-btn s2-btn-outline h-8 w-full text-[11.5px] disabled:opacity-60"
      >
        {save.isPending ? 'กำลังบันทึก' : 'บันทึกชั้นความลับ'}
      </button>
    </div>
  );
}
