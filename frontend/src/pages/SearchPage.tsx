import { useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Search, SlidersHorizontal, X } from 'lucide-react';
import { DriveWorkspace } from '@/components/files/DriveWorkspace';
import { PreviewModal } from '@/components/files/PreviewModal';
import { EmptyState } from '@/components/ui/States';
import { PageTitle } from '@/components/ui/PageTitle';
import { workspaceApi, type SearchHitDto } from '@/lib/api';
import { applyMarks, toDriveEntry, type DriveEntry } from '@/lib/drive';
import { matchReasonLabel, splitSnippet } from '@/lib/search-content';
import { textSourceBadge } from '@/lib/ocr';
import { useWorkspaceMarks } from '@/hooks/useWorkspaceMarks';
import { useWorkspaceActions } from '@/hooks/useWorkspaceActions';
import { useDriveUi } from '@/hooks/useDriveUi';
import { isPreviewable } from '@/lib/file-types';

/** ตัวกรองทั้งหมดอยู่ใน URL เพื่อให้ผลค้นหาที่กรองแล้วส่งต่อและบุ๊กมาร์กได้ */
const FILTER_KEYS = ['q', 'type', 'ownerId', 'tagId', 'visibility', 'updatedFrom', 'updatedTo', 'favoriteOnly'] as const;

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

  const activeChips = [
    params.get('type') ? { key: 'type', label: `ประเภท: ${({ FOLDER: 'โฟลเดอร์', FILE: 'ไฟล์', GOOGLE_SHEET: 'Google Sheet', GOOGLE_DOC: 'Google Doc', GOOGLE_DRIVE: 'Google Drive', WEB_LINK: 'Web Link' } as Record<string, string>)[params.get('type')!] ?? params.get('type')}` } : null,
    params.get('ownerId')
      ? {
          key: 'ownerId',
          label: `ผู้ดูแล: ${
            facets.data?.data.owners.find((owner) => owner.id === params.get('ownerId'))?.displayName ?? '—'
          }`,
        }
      : null,
    params.get('tagId')
      ? {
          key: 'tagId',
          label: `แท็ก: ${facets.data?.data.tags.find((tag) => tag.id === params.get('tagId'))?.name ?? '—'}`,
        }
      : null,
    params.get('visibility')
      ? { key: 'visibility', label: params.get('visibility') === 'RESTRICTED' ? 'จำกัดการเข้าถึง' : 'ทั้งองค์กร' }
      : null,
    params.get('favoriteOnly') ? { key: 'favoriteOnly', label: 'เฉพาะรายการโปรด' } : null,
    params.get('updatedFrom') ? { key: 'updatedFrom', label: `แก้ไขตั้งแต่ ${params.get('updatedFrom')}` } : null,
    params.get('updatedTo') ? { key: 'updatedTo', label: `แก้ไขถึง ${params.get('updatedTo')}` } : null,
  ].filter((chip): chip is { key: string; label: string } => chip !== null);

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

          {activeChips.map((chip) => (
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

          {activeChips.length > 0 ? (
            <button
              type="button"
              onClick={() => setParams(term ? new URLSearchParams({ q: term }) : new URLSearchParams(), { replace: true })}
              className="text-[11.5px] text-navy-400 underline-offset-2 hover:underline"
            >
              ล้างตัวกรองทั้งหมด
            </button>
          ) : null}
        </div>

        {advancedOpen ? (
          <div className="grid gap-3 rounded-xl border border-line bg-[var(--s2-surface-soft)] p-3 sm:grid-cols-2 lg:grid-cols-3">
            <Field label="ประเภท">
              <select className="s2-input h-9 rounded-lg px-2 text-[12.5px]" value={params.get('type') ?? ''} onChange={(event) => setFilter('type', event.target.value || null)}>
                <option value="">ทั้งหมด</option>
                <option value="FOLDER">โฟลเดอร์</option>
                <option value="FILE">ไฟล์</option>
                <option value="GOOGLE_SHEET">Google Sheet</option>
                <option value="GOOGLE_DOC">Google Doc</option>
                <option value="GOOGLE_DRIVE">Google Drive</option>
                <option value="WEB_LINK">Web Link</option>
              </select>
            </Field>

            <Field label="ผู้ดูแล">
              <select className="s2-input h-9 rounded-lg px-2 text-[12.5px]" value={params.get('ownerId') ?? ''} onChange={(event) => setFilter('ownerId', event.target.value || null)}>
                <option value="">ทุกคน</option>
                {(facets.data?.data.owners ?? []).map((owner) => (
                  <option key={owner.id} value={owner.id}>
                    {owner.displayName} ({owner.resourceCount})
                  </option>
                ))}
              </select>
            </Field>

            <Field label="แท็ก">
              <select className="s2-input h-9 rounded-lg px-2 text-[12.5px]" value={params.get('tagId') ?? ''} onChange={(event) => setFilter('tagId', event.target.value || null)}>
                <option value="">ทุกแท็ก</option>
                {(facets.data?.data.tags ?? []).map((tag) => (
                  <option key={tag.id} value={tag.id}>
                    {tag.name} ({tag.resourceCount})
                  </option>
                ))}
              </select>
            </Field>

            <Field label="การมองเห็น">
              <select className="s2-input h-9 rounded-lg px-2 text-[12.5px]" value={params.get('visibility') ?? ''} onChange={(event) => setFilter('visibility', event.target.value || null)}>
                <option value="">ทั้งหมด</option>
                <option value="ORGANIZATION">ทั้งองค์กร</option>
                <option value="RESTRICTED">จำกัดการเข้าถึง</option>
              </select>
            </Field>

            <Field label="แก้ไขตั้งแต่">
              <input type="date" className="s2-input h-9 rounded-lg px-2 text-[12.5px]" value={params.get('updatedFrom') ?? ''} onChange={(event) => setFilter('updatedFrom', event.target.value || null)} />
            </Field>

            <Field label="แก้ไขถึง">
              <input type="date" className="s2-input h-9 rounded-lg px-2 text-[12.5px]" value={params.get('updatedTo') ?? ''} onChange={(event) => setFilter('updatedTo', event.target.value || null)} />
            </Field>

            <label className="inline-flex items-center gap-2 text-[12px] text-navy-600">
              <input
                type="checkbox"
                checked={params.get('favoriteOnly') === 'true'}
                onChange={(event) => setFilter('favoriteOnly', event.target.checked ? 'true' : null)}
              />
              เฉพาะรายการโปรดของฉัน
            </label>
          </div>
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

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block text-[11.5px] font-semibold text-navy-700">
      {label}
      <span className="mt-1 block">{children}</span>
    </label>
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
              {/* บอกว่าข้อความที่ตรงกันมาจากการอ่านภาพ ซึ่งเชื่อถือได้ไม่เท่าข้อความในไฟล์จริง */}
              {textSourceBadge(hit.textSource) ? (
                <span className="rounded-md bg-amber-50 px-1.5 py-0.5 text-[10px] font-medium text-amber-700">
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
