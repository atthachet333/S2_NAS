import { useQuery } from '@tanstack/react-query';
import { X } from 'lucide-react';
import { categoryApi, workspaceApi } from '@/lib/api';
import {
  DATE_PRESET_LABELS,
  DRIVE_SCOPE_LABELS,
  FILE_KIND_LABELS,
  OCR_STATE_LABELS,
  SORT_LABELS,
  SOURCE_TYPE_LABELS,
  TEXT_SOURCE_LABELS,
  type SearchFilters,
} from '@/lib/search-filters';

/**
 * แผงตัวกรองขั้นสูง
 *
 * ออกแบบให้ "ไม่ขวางการค้นหาแบบง่าย" - ผู้ใช้ที่พิมพ์แล้วกด Enter ต้องได้ผลทันที
 * เหมือนเดิม แผงนี้ถูกซ่อนไว้จนกว่าจะมีคนกดเปิด
 *
 * ทุกตัวเลือกแสดงเป็นภาษาที่คนทำงานเอกสารใช้ ไม่ใช่ชื่อค่าในฐานข้อมูล
 * ผู้ใช้ไม่ควรต้องรู้ว่าระบบเรียกลูกค้าที่อัปโหลดไฟล์เข้ามาว่า EXTERNAL_UPLOAD
 */

interface Props {
  filters: SearchFilters;
  onChange: (key: string, value: string | boolean | null) => void;
  onClear: () => void;
  onClose: () => void;
}

/** ช่องเลือกหนึ่งช่อง - ค่าว่างหมายถึง "ทั้งหมด" เสมอ */
function Select({
  label,
  value,
  options,
  onChange,
  allLabel = 'ทั้งหมด',
}: {
  label: string;
  value: string | undefined;
  options: Record<string, string>;
  onChange: (value: string | null) => void;
  allLabel?: string;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[11px] font-medium text-navy-500">{label}</span>
      <select
        value={value ?? ''}
        onChange={(event) => onChange(event.target.value || null)}
        className="s2-input h-8 text-[12px]"
      >
        <option value="">{allLabel}</option>
        {Object.entries(options).map(([key, text]) => (
          <option key={key} value={key}>
            {text}
          </option>
        ))}
      </select>
    </label>
  );
}

function Toggle({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="flex items-center gap-2 text-[12px] text-navy-600">
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        className="h-3.5 w-3.5 rounded border-line"
      />
      {label}
    </label>
  );
}

export function AdvancedFilterPanel({ filters, onChange, onClear, onClose }: Props) {
  /** ตัวเลือกที่ต้องดึงจากเซิร์ฟเวอร์ - ผู้ดูแล แท็ก และประเภทเอกสาร */
  const facets = useQuery({ queryKey: ['search-facets'], queryFn: workspaceApi.facets });
  const categories = useQuery({ queryKey: ['document-categories'], queryFn: () => categoryApi.list() });

  const owners = Object.fromEntries(
    (facets.data?.data.owners ?? []).map((owner) => [owner.id, owner.displayName]),
  );
  const tags = Object.fromEntries((facets.data?.data.tags ?? []).map((tag) => [tag.id, tag.name]));
  const categoryOptions = Object.fromEntries(
    (categories.data?.data ?? []).map((category) => [category.id, category.name]),
  );

  return (
    <section
      aria-label="ตัวกรองขั้นสูง"
      className="rounded-xl border border-line bg-[var(--s2-surface-soft)] p-3"
    >
      <div className="mb-2.5 flex items-center justify-between">
        <p className="text-[12px] font-semibold text-navy-700">ตัวกรองขั้นสูง</p>
        <div className="flex items-center gap-1.5">
          <button type="button" onClick={onClear} className="s2-btn s2-btn-ghost h-7 px-2 text-[11px]">
            ล้างตัวกรอง
          </button>
          <button
            type="button"
            onClick={onClose}
            aria-label="ปิดตัวกรองขั้นสูง"
            className="s2-btn s2-btn-ghost h-7 w-7 p-0"
          >
            <X className="h-3.5 w-3.5" aria-hidden />
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 lg:grid-cols-4">
        <Select
          label="ประเภทไฟล์"
          value={filters.fileKind}
          options={FILE_KIND_LABELS}
          onChange={(value) => onChange('fileKind', value)}
        />
        <Select
          label="ไดร์ฟ"
          value={filters.driveScope}
          options={DRIVE_SCOPE_LABELS}
          onChange={(value) => onChange('driveScope', value)}
        />
        <Select
          label="ประเภทเอกสาร"
          value={filters.documentCategoryId}
          options={categoryOptions}
          onChange={(value) => onChange('documentCategoryId', value)}
        />
        <Select
          label="ผู้ดูแล"
          value={filters.ownerId}
          options={owners}
          onChange={(value) => onChange('ownerId', value)}
        />
        <Select
          label="ผู้อัปโหลด"
          value={filters.createdById}
          options={owners}
          onChange={(value) => onChange('createdById', value)}
        />
        <Select
          label="ต้นทาง"
          value={filters.sourceType}
          options={SOURCE_TYPE_LABELS}
          onChange={(value) => onChange('sourceType', value)}
        />
        <Select
          label="แท็ก"
          value={filters.tagId}
          options={tags}
          onChange={(value) => onChange('tagId', value)}
        />
        <Select
          label="ที่มาของข้อความ"
          value={filters.textSource}
          options={TEXT_SOURCE_LABELS}
          onChange={(value) => onChange('textSource', value)}
        />
        <Select
          label="สถานะ OCR"
          value={filters.ocrState}
          options={OCR_STATE_LABELS}
          onChange={(value) => onChange('ocrState', value)}
        />
        <Select
          label="วันที่อัปโหลด"
          value={filters.uploadedPreset}
          options={DATE_PRESET_LABELS}
          onChange={(value) => onChange('uploadedPreset', value)}
          allLabel="ทุกช่วงเวลา"
        />
        <Select
          label="วันที่แก้ไข"
          value={filters.updatedPreset}
          options={DATE_PRESET_LABELS}
          onChange={(value) => onChange('updatedPreset', value)}
          allLabel="ทุกช่วงเวลา"
        />
        <Select
          label="เรียงตาม"
          value={filters.sort}
          options={SORT_LABELS}
          onChange={(value) => onChange('sort', value)}
          allLabel="ค่าเริ่มต้น"
        />
      </div>

      {/* ช่วงวันที่แบบกำหนดเอง แสดงเฉพาะเมื่อผู้ใช้เลือก "กำหนดเอง" จริง ๆ */}
      {filters.uploadedPreset === 'custom' ? (
        <div className="mt-2.5 grid grid-cols-1 gap-2.5 sm:grid-cols-2">
          <label className="flex flex-col gap-1">
            <span className="text-[11px] font-medium text-navy-500">อัปโหลดตั้งแต่</span>
            <input
              type="date"
              value={filters.uploadedFrom ?? ''}
              onChange={(event) => onChange('uploadedFrom', event.target.value || null)}
              className="s2-input h-8 text-[12px]"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-[11px] font-medium text-navy-500">ถึง</span>
            <input
              type="date"
              value={filters.uploadedTo ?? ''}
              onChange={(event) => onChange('uploadedTo', event.target.value || null)}
              className="s2-input h-8 text-[12px]"
            />
          </label>
        </div>
      ) : null}

      <div className="mt-3 flex flex-wrap gap-x-4 gap-y-2 border-t border-line pt-2.5">
        <Toggle
          label="มีข้อความในเอกสาร"
          checked={filters.hasText === true}
          onChange={(checked) => onChange('hasText', checked ? true : null)}
        />
        <Toggle
          label="ยังไม่มีแท็ก"
          checked={filters.untaggedOnly === true}
          onChange={(checked) => onChange('untaggedOnly', checked ? true : null)}
        />
        <Toggle
          label="ยังไม่ระบุประเภท"
          checked={filters.uncategorizedOnly === true}
          onChange={(checked) => onChange('uncategorizedOnly', checked ? true : null)}
        />
        <Toggle
          label="เฉพาะรายการโปรด"
          checked={filters.favoriteOnly === true}
          onChange={(checked) => onChange('favoriteOnly', checked ? true : null)}
        />
      </div>
    </section>
  );
}
