import { useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Search, SlidersHorizontal, X } from 'lucide-react';
import { DriveWorkspace } from '@/components/files/DriveWorkspace';
import { PreviewModal } from '@/components/files/PreviewModal';
import { EmptyState } from '@/components/ui/States';
import { PageTitle } from '@/components/ui/PageTitle';
import { categoryApi, workspaceApi, type SearchHitDto } from '@/lib/api';
import { applyMarks, toDriveEntry, type DriveEntry } from '@/lib/drive';
import { matchReasonLabel, splitSnippet } from '@/lib/search-content';
import { textSourceBadge } from '@/lib/ocr';
import { AdvancedFilterPanel } from '@/components/search/AdvancedFilterPanel';
import { SavedSearchMenu } from '@/components/search/SavedSearchMenu';
import {
  FILTER_KEYS,
  activeChips as buildChips,
  filtersFromParams,
  paramsFromFilters,
  type SearchFilters,
} from '@/lib/search-filters';
import { useWorkspaceMarks } from '@/hooks/useWorkspaceMarks';
import { useWorkspaceActions } from '@/hooks/useWorkspaceActions';
import { useDriveUi } from '@/hooks/useDriveUi';
import { isPreviewable } from '@/lib/file-types';

/**
 * ตัวกรองทั้งหมดอยู่ใน URL
 *
 * ทำให้รีเฟรชแล้วไม่หาย บุ๊กมาร์กได้ ส่งลิงก์ให้เพื่อนร่วมงานได้ และเป็นรูปแบบเดียว
 * กับที่ชุดค้นหาที่บันทึกไว้ใช้ - รายชื่อคีย์อยู่ใน lib/search-filters.ts ที่เดียว
 */

export default function SearchPage() {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const { select, openDetails } = useDriveUi();
  const { favoriteIds, pinnedIds } = useWorkspaceMarks();
  const { handleWorkspaceAction, workspaceDialogs } = useWorkspaceActions();
  const [preview, setPreview] = useState<DriveEntry | null>(null);
  const [advancedOpen, setAdvancedOpen] = useState(false);

  const term = params.get('q') ?? '';

  const queryString = useMemo(() => {
    const next = new URLSearchParams();
    for (const key of FILTER_KEYS) {
      const value = params.get(key);
      if (value) next.set(key, value);
    }
    next.set('limit', '100');
    return next;
  }, [params]);

  const hasCriteria = FILTER_KEYS.some((key) => params.get(key));

  const results = useQuery({
    queryKey: ['search', 'page', queryString.toString()],
    queryFn: () => workspaceApi.search(queryString),
    enabled: hasCriteria,
  });

  const facets = useQuery({ queryKey: ['search-facets'], queryFn: workspaceApi.facets });
  const categories = useQuery({
    queryKey: ['document-categories'],
    queryFn: () => categoryApi.list(),
  });

  const entries = applyMarks((results.data?.data.items ?? []).map(toDriveEntry), favoriteIds, pinnedIds);

  const setFilter = (key: string, value: string | null) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    setParams(next, { replace: true });
  };

  const action = (name: string, entry: DriveEntry | null) => {
    if (handleWorkspaceAction(name, entry)) return;
    if (!entry) return;
    if (name === 'open' && entry.kind === 'folder') {
      navigate(`/files/${entry.id}`);
      return;
    }
    if ((name === 'open' || name === 'preview') && entry.kind === 'file') {
      if (isPreviewable(entry.name, entry.mimeType)) setPreview(entry);
      else {
        select(entry);
        openDetails();
      }
      return;
    }
    if (name === 'details') {
      select(entry);
      openDetails();
    }
  };

  const filters = filtersFromParams(params);

  /**
   * ป้ายของตัวกรองที่กำลังใช้อยู่
   *
   * ชื่อผู้ดูแล แท็ก และประเภทเอกสาร ถูกแปลงจากรหัสเป็นชื่อที่คนอ่านออก
   * ป้ายที่เขียนว่า "ผู้ดูแล: cmt9x2..." ไม่ได้ช่วยให้ใครรู้ว่ากรองอะไรอยู่
   */
  const chips = buildChips(filters, {
    owners: new Map((facets.data?.data.owners ?? []).map((o) => [o.id, o.displayName])),
    tags: new Map((facets.data?.data.tags ?? []).map((t) => [t.id, t.name])),
    categories: new Map((categories.data?.data ?? []).map((c) => [c.id, c.name])),
  });

  /** ล้างตัวกรองแต่เก็บคำค้นไว้ - ผู้ใช้ที่กด "ล้างตัวกรอง" ไม่ได้ต้องการเริ่มใหม่ทั้งหมด */
  const clearFilters = () => {
    setParams(term ? new URLSearchParams({ q: term }) : new URLSearchParams(), { replace: true });
  };

  /** เปิดชุดค้นหาที่บันทึกไว้ - เขียนทั้งคำค้นและตัวกรองลง URL ในครั้งเดียว */
  const applySaved = (savedQuery: string, savedFilters: SearchFilters) => {
    setParams(paramsFromFilters(savedQuery, savedFilters), { replace: false });
  };


  return (
    <div className="space-y-4">
      <PageTitle
        title="ค้นหา"
        description={
          term
            ? `ผลการค้นหาสำหรับ “${term}”`
            : 'ค้นหาทั่วพื้นที่ทำงาน แสดงเฉพาะรายการที่คุณมีสิทธิ์เข้าถึง'
        }
      />

      {/* ช่องค้นหาและตัวกรองด่วน */}
      <div className="space-y-3">
        <form
          className="relative"
          onSubmit={(event) => {
            event.preventDefault();
            const value = new FormData(event.currentTarget).get('q');
            setFilter('q', typeof value === 'string' && value.trim() ? value.trim() : null);
          }}
        >
          <Search className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-navy-300" aria-hidden />
          <input
            name="q"
            defaultValue={term}
            key={term}
            className="s2-input h-11 rounded-xl pl-10 pr-3 text-[13px]"
            placeholder="ค้นหาจากชื่อหรือหมายเหตุ"
            aria-label="คำค้นหา"
          />
        </form>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => setAdvancedOpen((open) => !open)}
            aria-expanded={advancedOpen}
            className="s2-btn s2-btn-outline"
          >
            <SlidersHorizontal className="h-4 w-4" aria-hidden />
            ตัวกรองขั้นสูง
          </button>

          <SavedSearchMenu
            query={term}
            filters={filters}
            onApply={applySaved}
            onApplySmartView={(slug) => navigate(`/smart-views/${slug}`)}
          />
        </div>

        {/* ป้ายตัวกรองที่กดปิดได้ทีละอัน - ผู้ใช้เห็นทันทีว่ากำลังกรองอะไรอยู่ */}
        {chips.length > 0 ? (
          <div className="flex flex-wrap items-center gap-2">
            {chips.map((chip) => (
              <button
                key={chip.key}
                type="button"
                onClick={() => setFilter(chip.key, null)}
                className="inline-flex items-center gap-1 rounded-full border border-brand-200 bg-brand-50 py-1 pl-2.5 pr-1.5 text-[11.5px] text-brand-700"
                aria-label={`ล้างตัวกรอง ${chip.label}`}
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

        {advancedOpen ? (
          <AdvancedFilterPanel
            filters={filters}
            onChange={(key, value) =>
              setFilter(key, value === null || value === false ? null : String(value))
            }
            onClear={clearFilters}
            onClose={() => setAdvancedOpen(false)}
          />
        ) : null}
      </div>

      {hasCriteria ? (
        <>
          {!results.isPending && !results.isError ? (
            <p className="text-[12px] text-navy-400">
              พบ {results.data?.data.total ?? 0} รายการที่คุณเข้าถึงได้
              {(results.data?.data.total ?? 0) > entries.length ? ` · แสดง ${entries.length} รายการแรก` : ''}
            </p>
          ) : null}

          <ContentMatches hits={results.data?.data.items ?? []} term={term} />

          <DriveWorkspace
            entries={entries}
            isLoading={results.isPending}
            isError={results.isError}
            onRetry={() => void results.refetch()}
            onResourceAction={action}
            allowUpload={false}
            emptyState={
              <EmptyState
                icon={<Search className="h-6 w-6" aria-hidden />}
                title="ไม่พบรายการที่ตรงกับเงื่อนไข"
                description="ลองใช้คำค้นที่สั้นลง หรือล้างตัวกรองบางอย่างออก"
              />
            }
          />
        </>
      ) : (
        <EmptyState
          icon={<Search className="h-6 w-6" aria-hidden />}
          title="เริ่มค้นหา"
          description="พิมพ์คำค้น หรือเลือกตัวกรองขั้นสูง เพื่อค้นหาทั่วพื้นที่ทำงานขององค์กร"
        />
      )}

      {preview ? (
        <PreviewModal
          entry={preview}
          onClose={() => setPreview(null)}
          onShowDetails={() => {
            select(preview);
            openDetails();
            setPreview(null);
          }}
        />
      ) : null}

      {workspaceDialogs}
    </div>
  );
}


/**
 * ผลลัพธ์ที่ตรงเพราะ "เนื้อในเอกสาร"
 *
 * แยกออกมาเป็นแถบของตัวเองเหนือตารางปกติ แทนที่จะยัดตัวอย่างข้อความลงในตาราง
 * เพราะการค้นเจอจากเนื้อในต้องอธิบายตัวเอง ผู้ใช้ที่ค้นคำที่ไม่ปรากฏในชื่อไฟล์เลย
 * ต้องเห็นทันทีว่าทำไมไฟล์นี้ถึงขึ้นมา มิฉะนั้นจะคิดว่าการค้นหาพัง
 *
 * ตัวอย่างข้อความถูกวาดเป็นชิ้น ๆ ผ่านการผูกค่าของ React
 * ไม่มีการแทรก HTML จากเนื้อหาที่ผู้ใช้อัปโหลดเข้ามาที่ใดเลย
 */
function ContentMatches({ hits, term }: { hits: SearchHitDto[]; term: string }) {
  const matches = hits.filter((hit) => hit.matchReason === 'CONTENT' && hit.contentSnippet);
  if (matches.length === 0) return null;

  return (
    <section className="s2-surface overflow-hidden">
      <p className="border-b border-line px-4 py-2 text-[11.5px] font-medium text-navy-600">
        พบคำค้นในเนื้อหาเอกสาร ({matches.length})
      </p>
      <ul className="divide-y divide-line">
        {matches.map((hit) => (
          <li key={hit.id} className="px-4 py-2.5">
            <p className="flex flex-wrap items-center gap-1.5">
              <span className="truncate text-[12.5px] font-medium text-navy-800">{hit.name}</span>
              <span className="rounded-md border border-line px-1.5 py-0.5 text-[10px] text-navy-500">
                {matchReasonLabel(hit.matchReason)}
              </span>
              {/*
                * ที่มาของข้อความที่ตรงกัน - สองกรณีนี้มีน้ำหนักต่างกันจึงใช้สีต่างกัน
                * OCR เป็นการเดาของเครื่อง จึงเป็นสีเตือน
                * ส่วนที่ตรวจแก้แล้วมีคนยืนยันด้วยตา จึงไม่ควรหน้าตาเหมือนคำเตือน
                */}
              {textSourceBadge(hit.textSource) ? (
                <span
                  className={
                    hit.textSource === 'HUMAN_CORRECTED'
                      ? 'rounded-md bg-emerald-50 px-1.5 py-0.5 text-[10px] font-medium text-emerald-700'
                      : 'rounded-md bg-amber-50 px-1.5 py-0.5 text-[10px] font-medium text-amber-700'
                  }
                >
                  {textSourceBadge(hit.textSource)}
                </span>
              ) : null}
            </p>
            <p className="mt-1 rounded-lg bg-[var(--s2-surface-soft)] px-2 py-1 text-[11px] leading-relaxed text-navy-500">
              {splitSnippet(hit.contentSnippet!, term).map((part, index) =>
                part.highlight ? (
                  <mark key={index} className="rounded bg-amber-100 px-0.5 text-navy-900">
                    {part.text}
                  </mark>
                ) : (
                  <span key={index}>{part.text}</span>
                ),
              )}
            </p>
          </li>
        ))}
      </ul>
    </section>
  );
}
