import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Download, FileArchive, Trash2, Upload, X } from 'lucide-react';
import { Breadcrumb } from '@/components/files/Breadcrumb';
import { DriveWorkspace } from '@/components/files/DriveWorkspace';
import { FileToolbar, type SortKey } from '@/components/files/FileToolbar';
import { FolderHeader } from '@/components/files/FolderHeader';
import { BulkMetadataDialog } from '@/components/files/BulkMetadataDialog';
import { ResourceDialog, type ResourceDialogMode } from '@/components/files/ResourceDialog';
import { WorkspaceOnboarding } from '@/components/files/WorkspaceOnboarding';
import { ApiError, fileApi, resourceApi } from '@/lib/api';
import { useDriveUi } from '@/hooks/useDriveUi';
import { useToast } from '@/hooks/useToast';
import { applyMarks, listDrive, toDriveEntry, type DriveEntry } from '@/lib/drive';
import { useWorkspaceMarks } from '@/hooks/useWorkspaceMarks';
import { useWorkspaceActions } from '@/hooks/useWorkspaceActions';
import { PinnedStrip } from '@/components/files/PinnedStrip';
import { PreviewModal } from '@/components/files/PreviewModal';
import { useUploadQueue } from '@/hooks/useUploadQueue';
import { downloadResource, downloadZip } from '@/lib/download';
import { isPreviewable } from '@/lib/file-types';
import { selectionDownloadMode } from '@/lib/interaction-policy';
import { ExternalResourceDialog } from '@/components/files/ExternalResourceDialog';
import { isExternalEntry, openExternalUrl, type ExternalResourceType } from '@/lib/external-resources';
import { DRIVE_ROOT_PATH, driveRootLabel, type DriveRoot } from '@/lib/drive-labels';
import { canCreateInSystemDrive } from '@/lib/system-drive';
import { useAuth } from '@/hooks/useAuth';
import { NewMenu } from '@/components/layout/NewMenu';
import { describePlan, groupByDirectory, planFolderUpload } from '@/lib/folder-upload';

const SORT_API: Record<SortKey, { sort: string; direction: 'asc' | 'desc' }> = {
  'name-asc': { sort: 'name', direction: 'asc' },
  'name-desc': { sort: 'name', direction: 'desc' },
  'modified-desc': { sort: 'updatedAt', direction: 'desc' },
  'size-desc': { sort: 'size', direction: 'desc' },
};

/**
 * หน้าไดร์ฟ ใช้ร่วมกันทั้ง "ไดร์ฟของฉัน" และ "ไดร์ฟของระบบ"
 *
 * สองไดร์ฟใช้โครงสร้างและการทำงานชุดเดียวกันทุกอย่าง ต่างกันแค่ขอบเขตข้อมูลและนโยบายการเขียน
 * จึงไม่คัดลอกหน้าออกเป็นสองไฟล์ เพราะจะทำให้พฤติกรรมสองไดร์ฟค่อย ๆ เพี้ยนออกจากกัน
 */
export default function FilesPage({ driveRoot = 'MY_DRIVE' }: { driveRoot?: DriveRoot } = {}) {
  const { folderId } = useParams<{ folderId?: string }>();
  const parentId = folderId ?? null;
  const { user } = useAuth();
  const driveLabel = driveRootLabel(driveRoot);
  const drivePath = DRIVE_ROOT_PATH[driveRoot];
  /**
   * ไดร์ฟของระบบเป็นไดร์ฟกลาง: อ่านได้ทั้งองค์กร แต่เพิ่มของเข้าไปได้เฉพาะผู้ที่ได้รับสิทธิ์
   * ที่นี่ซ่อนปุ่มเพื่อไม่ให้ผู้ใช้กดแล้วเจอ error เฉย ๆ ส่วนด่านจริงอยู่ที่ backend
   */
  const canAddAtRoot = driveRoot === 'SYSTEM_DRIVE' ? canCreateInSystemDrive(user) : true;
  const [sort, setSort] = useState<SortKey>('name-asc');
  const [dialog, setDialog] = useState<{ mode: ResourceDialogMode; entry: DriveEntry | null; targetParentId?: string | null } | null>(null);
  const [externalDialog, setExternalDialog] = useState<{ type: ExternalResourceType; entry?: DriveEntry | null } | null>(null);
  const { notify } = useToast();
  const { select, openDetails, selected } = useDriveUi();
  const { enqueue, enqueueVersion } = useUploadQueue();
  const { favoriteIds, pinnedIds, pinnedResources } = useWorkspaceMarks();
  const { handleWorkspaceAction, workspaceDialogs } = useWorkspaceActions();
  const [preview, setPreview] = useState<DriveEntry | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [zipPending, setZipPending] = useState(false);
  /** กล่องแก้ข้อมูลของหลายรายการ - ใช้การเลือกชุดเดิมของหน้าไฟล์ */
  const [bulkOpen, setBulkOpen] = useState(false);
  const [bulkTrashConfirm, setBulkTrashConfirm] = useState(false);
  const [bulkTrashPending, setBulkTrashPending] = useState(false);
  const filePickerRef = useRef<HTMLInputElement>(null);
  const uploadTargetRef = useRef<{ parentId: string | null; parentName: string } | null>(null);
  const folderPickerRef = useRef<HTMLInputElement>(null);
  const versionPickerRef = useRef<HTMLInputElement>(null);
  const versionTargetRef = useRef<DriveEntry | null>(null);
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const queryClient = useQueryClient();
  const apiSort = SORT_API[sort];

  const { data, isPending, isError, refetch } = useQuery({
    queryKey: ['drive', 'files', driveRoot, parentId ?? 'root', sort],
    queryFn: () => listDrive('files', folderId, apiSort.sort, apiSort.direction, driveRoot),
  });

  const { data: currentFolder } = useQuery({
    queryKey: ['resource', folderId],
    queryFn: () => resourceApi.get(folderId!),
    enabled: Boolean(folderId),
  });

  useEffect(() => {
    const open = () => setDialog({ mode: 'create', entry: null });
    const upload = () => {
      uploadTargetRef.current = { parentId, parentName: currentFolder?.data.name ?? driveLabel };
      filePickerRef.current?.click();
    };
    const createExternal = (event: Event) => {
      const type = (event as CustomEvent<{ type?: ExternalResourceType }>).detail?.type;
      if (type) setExternalDialog({ type });
    };
    window.addEventListener('s2-create-folder', open);
    window.addEventListener('s2-upload-file', upload);
    const uploadFolder = () => {
      uploadTargetRef.current = { parentId, parentName: currentFolder?.data.name ?? driveLabel };
      folderPickerRef.current?.click();
    };
    window.addEventListener('s2-upload-folder', uploadFolder);
    window.addEventListener('s2-create-external', createExternal);
    return () => {
      window.removeEventListener('s2-upload-folder', uploadFolder);
      window.removeEventListener('s2-create-folder', open);
      window.removeEventListener('s2-upload-file', upload);
      window.removeEventListener('s2-create-external', createExternal);
    };
  }, [parentId, currentFolder?.data.name, driveLabel]);

  const action = (name: string, entry: DriveEntry | null) => {
    // รายการโปรด ปักหมุด แท็ก หมายเหตุ สิทธิ์ ล็อก และประวัติ ใช้ตัวจัดการกลางร่วมกับหน้าอื่น
    if (handleWorkspaceAction(name, entry)) return;
    if (name === 'open' && entry && isExternalEntry(entry)) {
      if (!entry.externalUrl || !openExternalUrl(entry.externalUrl)) notify({ tone: 'error', title: 'ลิงก์ไม่ถูกต้อง' });
      return;
    }
    const createTypes: Record<string, ExternalResourceType> = {
      'create-google-sheet': 'GOOGLE_SHEET', 'create-google-doc': 'GOOGLE_DOC',
      'create-google-drive': 'GOOGLE_DRIVE', 'create-web-link': 'WEB_LINK',
    };
    if (createTypes[name]) { setExternalDialog({ type: createTypes[name] }); return; }
    if (name === 'edit-external' && entry && isExternalEntry(entry)) {
      setExternalDialog({ type: entry.resourceType as ExternalResourceType, entry });
      return;
    }
    if (name === 'open' && entry?.kind === 'folder') {
      navigate(`${drivePath}/${entry.id}`);
      return;
    }
    // เปิดไฟล์: ดูตัวอย่างถ้ารองรับ ถ้าไม่รองรับให้เปิดรายละเอียดแทน ไม่ดาวน์โหลดเองโดยไม่บอก
    if (name === 'open' && entry?.kind === 'file') {
      if (isPreviewable(entry.name, entry.mimeType)) setPreview(entry);
      else {
        select(entry);
        openDetails();
      }
      return;
    }
    if (name === 'preview' && entry) {
      setPreview(entry);
      return;
    }
    if (name === 'download' && entry) {
      void downloadResource(entry.id, entry.name).catch((error: unknown) =>
        notify({ tone: 'error', title: error instanceof Error ? error.message : 'ดาวน์โหลดไม่สำเร็จ' }),
      );
      return;
    }
    if (name === 'download-zip' && entry?.kind === 'folder') {
      void downloadZip([entry.id], { id: entry.id, name: entry.name }).catch((error: unknown) =>
        notify({ tone: 'error', title: error instanceof Error ? error.message : 'ดาวน์โหลด ZIP ไม่สำเร็จ' }),
      );
      return;
    }
    if (name === 'new-version' && entry) {
      versionTargetRef.current = entry;
      versionPickerRef.current?.click();
      return;
    }
    if (name === 'create-folder') {
      setDialog({ mode: 'create', entry: null });
      return;
    }
    if (name === 'create-folder-inside' && entry?.kind === 'folder') {
      setDialog({ mode: 'create', entry: null, targetParentId: entry.id });
      return;
    }
    if (name === 'upload-folder') {
      uploadTargetRef.current = entry?.kind === 'folder'
        ? { parentId: entry.id, parentName: entry.name }
        : { parentId, parentName: folder?.name ?? driveLabel };
      folderPickerRef.current?.click();
      return;
    }
    if (name === 'upload-here') {
      uploadTargetRef.current = entry?.kind === 'folder'
        ? { parentId: entry.id, parentName: entry.name }
        : { parentId, parentName: folder?.name ?? driveLabel };
      filePickerRef.current?.click();
      return;
    }
    if (entry && ['rename', 'move', 'owner', 'trash'].includes(name)) {
      setDialog({ mode: name === 'trash' ? 'delete' : (name as ResourceDialogMode), entry });
    }
  };

  const success = (message: string) => {
    setDialog(null);
    notify({ tone: 'success', title: message });
    void queryClient.invalidateQueries({ queryKey: ['drive'] });
    void queryClient.invalidateQueries({ queryKey: ['resource'] });
    void queryClient.invalidateQueries({ queryKey: ['folder-picker'] });
    void queryClient.invalidateQueries({ queryKey: ['admin-ownership'] });
  };

  const folder = currentFolder?.data;
  const folderEntry = folder ? toDriveEntry(folder) : null;
  const entries = applyMarks(data?.entries ?? [], favoriteIds, pinnedIds);
  const breadcrumbSegments = (data?.breadcrumb ?? []).map((node) => node.name);
  const selectedEntries = entries.filter((entry) => selectedIds.has(entry.id));
  const selectedDownloadMode = selectionDownloadMode(selectedEntries);
  const canCreateHere = folder ? folder.capabilities.canEdit : canAddAtRoot;

  /**
   * ทางเข้าเดียวของการเลือกไฟล์และโฟลเดอร์
   * ตั้งปลายทางไว้ก่อนเปิดตัวเลือกเสมอ เพื่อไม่ให้ไฟล์ไปโผล่ผิดไดร์ฟ
   */
  const openFilePicker = (target?: { parentId: string | null; parentName: string }) => {
    uploadTargetRef.current = target ?? { parentId, parentName: folder?.name ?? driveLabel };
    filePickerRef.current?.click();
  };
  const openFolderPicker = (target?: { parentId: string | null; parentName: string }) => {
    uploadTargetRef.current = target ?? { parentId, parentName: folder?.name ?? driveLabel };
    folderPickerRef.current?.click();
  };

  /**
   * อัปโหลดทั้งโฟลเดอร์
   *
   * สร้างโครงสร้างโฟลเดอร์ที่ปลายทางก่อน แล้วจึงส่งไฟล์เข้าคิวอัปโหลดเดิมทั้งหมด
   * ไม่มีตัวอัปโหลดชุดที่สอง - ความคืบหน้า checksum ไฟล์ซ้ำ ชื่อซ้ำ และเวอร์ชัน
   * ยังเดินผ่านเส้นทางเดียวกับการอัปโหลดไฟล์ปกติ
   *
   * โฟลเดอร์ที่มีอยู่แล้วถูกนำมาใช้ซ้ำ ไม่สร้างซ้อน เพราะการอัปโหลดโฟลเดอร์เดิมอีกครั้ง
   * ควรเติมไฟล์เข้าไปในที่เดิม ไม่ใช่สร้าง "ชื่อ (2)" ขึ้นมาใหม่ทั้งต้นไม้
   */
  const uploadFolderTree = async (
    files: File[],
    target: { parentId: string | null; parentName: string },
  ): Promise<void> => {
    const plan = planFolderUpload(files);

    if (plan.rejected.length > 0) {
      notify({
        tone: plan.files.length > 0 ? 'info' : 'error',
        title: plan.files.length > 0 ? 'ข้ามบางรายการที่ชื่อไม่ถูกต้อง' : 'อัปโหลดโฟลเดอร์ไม่ได้',
        description: plan.rejected[0]?.reason,
      });
    }
    if (plan.files.length === 0) return;

    // เส้นทางสัมพัทธ์ -> id ของโฟลเดอร์ปลายทาง เริ่มจากรากที่ผู้ใช้เลือกไว้
    const folderIds = new Map<string, string | null>([['', target.parentId]]);

    try {
      for (const branch of plan.directories) {
        const parentKey = branch.slice(0, -1).join('/');
        const name = branch.at(-1)!;
        const parentOfBranch = folderIds.get(parentKey) ?? target.parentId;

        try {
          const created = await resourceApi.createFolder({
            name,
            parentId: parentOfBranch,
            ...(parentOfBranch ? {} : { driveScope: driveRoot }),
          });
          folderIds.set(branch.join('/'), created.data.id);
        } catch (error) {
          // ชื่อซ้ำแปลว่าโฟลเดอร์นั้นมีอยู่แล้ว ใช้ของเดิมต่อ
          if (!(error instanceof ApiError) || error.code !== 'FOLDER_NAME_EXISTS') throw error;
          const params = new URLSearchParams({ type: 'FOLDER', sort: 'name', direction: 'asc', limit: '100' });
          if (parentOfBranch) params.set('parentId', parentOfBranch);
          else params.set('driveScope', driveRoot);
          const siblings = await resourceApi.list(params);
          const existing = siblings.data.items.find((item) => item.name === name);
          if (!existing) throw error;
          folderIds.set(branch.join('/'), existing.id);
        }
      }
    } catch (error) {
      notify({
        tone: 'error',
        title: error instanceof ApiError ? error.message : 'สร้างโครงสร้างโฟลเดอร์ไม่สำเร็จ',
      });
      return;
    }

    for (const [key, group] of groupByDirectory(plan.files)) {
      const destinationId = folderIds.get(key) ?? target.parentId;
      const destinationName = key === '' ? target.parentName : key.split('/').at(-1)!;
      enqueue(group, { parentId: destinationId, parentName: destinationName });
    }

    notify({ tone: 'success', title: 'เริ่มอัปโหลดโฟลเดอร์แล้ว', description: describePlan(plan) });
    void queryClient.invalidateQueries({ queryKey: ['drive'] });
  };

  const newMenu = (
    <NewMenu
      onCreateFolder={() => setDialog({ mode: 'create', entry: null })}
      onCreateExternal={(type) => setExternalDialog({ type })}
      onUploadFile={() => openFilePicker()}
      onUploadFolder={() => openFolderPicker()}
    />
  );

  const focusId = searchParams.get('focus');
  useEffect(() => {
    if (!focusId || entries.length === 0) return;
    const match = entries.find((entry) => entry.id === focusId);
    if (!match) return;
    select(match);
    openDetails('details');
    // ล้างพารามิเตอร์ทิ้ง เพื่อไม่ให้รีเฟรชหน้าแล้วเด้งกลับมาเลือกซ้ำอีก
    const next = new URLSearchParams(searchParams);
    next.delete('focus');
    setSearchParams(next, { replace: true });
  }, [focusId, entries, select, openDetails, searchParams, setSearchParams]);

  useEffect(() => {
    const previewSelected = (event: Event) => {
      const id = (event as CustomEvent<{ id?: string }>).detail?.id;
      const match = entries.find((entry) => entry.id === id);
      if (match?.kind === 'file') setPreview(match);
    };
    window.addEventListener('s2-preview-resource', previewSelected);
    return () => window.removeEventListener('s2-preview-resource', previewSelected);
  }, [entries]);

  return (
    <div className="space-y-6">
      {/* ---------- โซนหัวเรื่อง ---------- */}
      {folder && folderEntry ? (
        <div className="space-y-3">
          <Breadcrumb root={driveLabel} rootTo={drivePath} nodes={data?.breadcrumb ?? []} />
          <FolderHeader
            folder={folder}
            newMenu={newMenu}
            onCreateFolder={() => setDialog({ mode: 'create', entry: null })}
            onRename={() => setDialog({ mode: 'rename', entry: folderEntry })}
            onMove={() => setDialog({ mode: 'move', entry: folderEntry })}
            onTransferOwner={() => setDialog({ mode: 'owner', entry: folderEntry })}
            /**
             * เปิดแผงรายละเอียดโดย "ไม่ทับสิ่งที่ผู้ใช้เลือกไว้"
             *
             * ปุ่มนี้อยู่บนหัวโฟลเดอร์ จึงเคยบังคับให้แผงผูกกับโฟลเดอร์เสมอ
             * ผลคือผู้ใช้ที่คลิกไฟล์ไว้แล้วกดปุ่มนี้ จะเห็นรายละเอียดของโฟลเดอร์แทน
             * โดยไม่มีอะไรบอกว่าสิ่งที่เขาเลือกไว้ถูกเปลี่ยนไปแล้ว
             *
             * ตอนนี้โฟลเดอร์ถูกเลือกเฉพาะเมื่อยังไม่มีอะไรถูกเลือก ซึ่งเป็นตอนที่
             * "รายละเอียดของที่นี่" หมายถึงโฟลเดอร์จริง ๆ
             */
            onDetails={() => {
              if (!selected) select(folderEntry);
              openDetails();
            }}
          />
        </div>
      ) : (
        <header className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <div className="min-w-0">
            <h1 className="text-[26px] font-semibold leading-tight tracking-tight text-navy-900">{driveLabel}</h1>
            <p className="mt-1 text-[13px] text-navy-400">
              {driveRoot === 'SYSTEM_DRIVE'
                ? 'ไดร์ฟกลางขององค์กร ทุกคนเปิดดูและดาวน์โหลดได้ แต่เพิ่มหรือแก้ไขได้เฉพาะผู้ที่ได้รับสิทธิ์'
                : 'พื้นที่ทำงานและความรับผิดชอบของคุณ ข้อมูลยังเป็นกรรมสิทธิ์ขององค์กร'}
            </p>
          </div>

          {canAddAtRoot ? (
            <div className="flex shrink-0 flex-wrap items-center gap-2">
              {/* + ใหม่ เปิดเมนูทุกชนิด ไม่พาไปสร้างโฟลเดอร์ทันที */}
              {newMenu}
              <button type="button" className="s2-btn s2-btn-outline" onClick={() => openFilePicker()}>
                <Upload className="h-4 w-4" aria-hidden />
                อัปโหลด
              </button>
            </div>
          ) : null}
        </header>
      )}

      {/* แถบปักหมุดอยู่ที่รากเท่านั้น เพราะเป็นทางลัดข้ามโฟลเดอร์ ไม่ใช่เนื้อหาของที่นี่ */}
      {parentId === null ? (
        <PinnedStrip
          resources={pinnedResources}
          favoriteIds={favoriteIds}
          pinnedIds={pinnedIds}
          onOpen={(entry) => action('open', entry)}
          onAction={action}
        />
      ) : null}

      {/* ---------- โซนเนื้อหา: ไม่มีกล่องใหญ่ครอบ การ์ดวางบนพื้นหน้าโดยตรง ---------- */}
      <section>
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-t border-line pt-4">
          <div className="flex min-w-0 items-baseline gap-2">
            <h2 className="text-[13px] font-semibold text-navy-800">โฟลเดอร์และทรัพยากร</h2>
            {!isPending && !isError ? (
              <span className="text-[11.5px] text-navy-400">{entries.length} รายการ</span>
            ) : null}
          </div>

          <FileToolbar
            sort={sort}
            onSortChange={setSort}
            onCreateFolder={() => setDialog({ mode: 'create', entry: null })}
          />
        </div>

        <div className="mt-4">
          {selectedEntries.length > 0 ? (
            <div className="mb-3 flex flex-wrap items-center gap-2 rounded-xl border border-brand-200 bg-brand-50 px-3 py-2" role="toolbar" aria-label="การทำงานกับรายการที่เลือก">
              <span className="mr-auto text-[12px] font-semibold text-brand-700">เลือกแล้ว {selectedEntries.length} รายการ</span>
              <button
                type="button"
                className="s2-btn s2-btn-outline"
                onClick={() => setBulkOpen(true)}
              >
                แก้ข้อมูลหลายรายการ
              </button>
              {selectedDownloadMode ? <button
                type="button"
                className="s2-btn s2-btn-outline"
                disabled={zipPending}
                aria-label={selectedDownloadMode === 'ORIGINAL' ? 'ดาวน์โหลดไฟล์ต้นฉบับ' : 'ดาวน์โหลดรายการที่เลือกเป็น ZIP'}
                onClick={() => {
                  setZipPending(true);
                  const selected = selectedEntries[0];
                  const operation = selectedDownloadMode === 'ORIGINAL' && selected
                    ? downloadResource(selected.id, selected.name)
                    : selectedEntries.length === 1 && selected?.kind === 'folder'
                      ? downloadZip([selected.id], { id: selected.id, name: selected.name })
                      : downloadZip(selectedEntries.map((entry) => entry.id));
                  void operation
                    .catch((error: unknown) => notify({ tone: 'error', title: error instanceof Error ? error.message : 'ดาวน์โหลดไม่สำเร็จ' }))
                    .finally(() => setZipPending(false));
                }}
              >
                {selectedDownloadMode === 'ORIGINAL' ? <Download className="h-4 w-4" aria-hidden /> : <FileArchive className="h-4 w-4" aria-hidden />}
                {zipPending ? 'กำลังดาวน์โหลด…' : selectedDownloadMode === 'ORIGINAL' ? 'ดาวน์โหลดไฟล์ต้นฉบับ' : 'ดาวน์โหลดเป็น ZIP'}
              </button> : null}
              <button type="button" className="s2-btn border border-red-200 bg-red-50 text-red-700" onClick={() => setBulkTrashConfirm(true)}>
                <Trash2 className="h-4 w-4" aria-hidden />
                ย้ายไปถังขยะ
              </button>
              <button type="button" className="rounded-lg p-2 text-navy-500 hover:bg-[var(--s2-surface)]" onClick={() => setSelectedIds(new Set())} aria-label="ล้างรายการที่เลือก">
                <X className="h-4 w-4" aria-hidden />
              </button>
            </div>
          ) : null}
          <DriveWorkspace
            entries={entries}
            isLoading={isPending}
            isError={isError}
            onRetry={() => void refetch()}
            onResourceAction={action}
            uploadTarget={{ parentId, parentName: folder?.name ?? driveLabel }}
            allowUpload={canCreateHere}
            driveLabel={driveLabel}
            destinationSegments={breadcrumbSegments}
            selectedIds={selectedIds}
            onToggleSelection={(entry) => setSelectedIds((current) => {
              const next = new Set(current);
              if (next.has(entry.id)) next.delete(entry.id); else next.add(entry.id);
              return next;
            })}
            onToggleSelectAll={(shouldSelectAll) =>
              setSelectedIds(shouldSelectAll ? new Set(entries.map((entry) => entry.id)) : new Set())
            }
            emptyState={
              <WorkspaceOnboarding
                canCreate={canCreateHere}
                driveRoot={driveRoot}
                newMenu={canCreateHere ? newMenu : undefined}
                onCreateFolder={() => setDialog({ mode: 'create', entry: null })}
              />
            }
          />
        </div>
      </section>

      {/* ตัวเลือกไฟล์ที่ซ่อนไว้ รองรับการเลือกหลายไฟล์และใช้งานด้วยคีย์บอร์ดผ่านปุ่มอัปโหลด */}
      <input
        ref={filePickerRef}
        type="file"
        multiple
        className="hidden"
        aria-hidden
        tabIndex={-1}
        onChange={(event) => {
          const files = Array.from(event.target.files ?? []);
          const target = uploadTargetRef.current ?? { parentId, parentName: folder?.name ?? driveLabel };
          if (files.length > 0) enqueue(files, target);
          uploadTargetRef.current = null;
          event.target.value = '';
        }}
      />
      {/*
        ตัวเลือกโฟลเดอร์: เบราว์เซอร์ส่ง webkitRelativePath มากับทุกไฟล์
        โครงสร้างถูกสร้างขึ้นใหม่ที่ปลายทางก่อน แล้วจึงส่งไฟล์เข้าคิวอัปโหลดเดิม
      */}
      <input
        ref={folderPickerRef}
        type="file"
        multiple
        className="hidden"
        aria-hidden
        tabIndex={-1}
        {...({ webkitdirectory: '', directory: '' } as Record<string, string>)}
        onChange={(event) => {
          const files = Array.from(event.target.files ?? []);
          const target = uploadTargetRef.current ?? { parentId, parentName: folder?.name ?? driveLabel };
          uploadTargetRef.current = null;
          event.target.value = '';
          if (files.length > 0) void uploadFolderTree(files, target);
        }}
      />
      <input
        ref={versionPickerRef}
        type="file"
        className="hidden"
        aria-hidden
        tabIndex={-1}
        onChange={(event) => {
          const file = event.target.files?.[0];
          const target = versionTargetRef.current;
          if (file && target) {
            enqueueVersion(file, { resourceId: target.id, resourceName: target.name });
          }
          versionTargetRef.current = null;
          event.target.value = '';
        }}
      />

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

      {bulkOpen ? (
        <BulkMetadataDialog
          entries={selectedEntries}
          onClose={() => setBulkOpen(false)}
          onDone={() => setSelectedIds(new Set())}
        />
      ) : null}

      {workspaceDialogs}

      {dialog ? (
        <ResourceDialog
          mode={dialog.mode}
          entry={dialog.entry}
          parentId={dialog.targetParentId !== undefined ? dialog.targetParentId : parentId}
          driveRoot={driveRoot}
          onClose={() => setDialog(null)}
          onSuccess={success}
        />
      ) : null}

      {externalDialog ? (
        <ExternalResourceDialog
          type={externalDialog.type}
          entry={externalDialog.entry}
          parentId={parentId}
          driveRoot={driveRoot}
          destinationName={folder?.name ?? driveLabel}
          onClose={() => setExternalDialog(null)}
          onSuccess={(message) => { setExternalDialog(null); success(message); }}
        />
      ) : null}

      {bulkTrashConfirm ? (
        <div className="fixed inset-0 z-[var(--z-dialog)] flex items-center justify-center bg-[var(--s2-overlay)] p-4 backdrop-blur-sm" role="presentation">
          <section role="alertdialog" aria-modal="true" aria-labelledby="bulk-trash-title" className="w-full max-w-md rounded-2xl border border-line bg-[var(--s2-elevated)] p-5 shadow-pop">
            <h2 id="bulk-trash-title" className="text-[16px] font-semibold text-navy-900">ย้ายรายการที่เลือกไปถังขยะ</h2>
            <p className="mt-2 text-[12px] leading-relaxed text-navy-500">รายการที่เลือก {selectedEntries.length} รายการ รวมทั้งรายการภายในโฟลเดอร์ จะถูกย้ายไปถังขยะ</p>
            <div className="mt-5 flex justify-end gap-2">
              <button type="button" className="s2-btn s2-btn-ghost" disabled={bulkTrashPending} onClick={() => setBulkTrashConfirm(false)}>ยกเลิก</button>
              <button
                type="button"
                className="s2-btn border border-red-200 bg-red-600 text-white"
                disabled={bulkTrashPending}
                onClick={() => {
                  setBulkTrashPending(true);
                  void Promise.all(selectedEntries.map((entry) => fileApi.moveToTrash(entry.id)))
                    .then(() => {
                      notify({ tone: 'success', title: 'ย้ายรายการไปถังขยะแล้ว' });
                      setSelectedIds(new Set());
                      setBulkTrashConfirm(false);
                      void queryClient.invalidateQueries({ queryKey: ['drive'] });
                      void queryClient.invalidateQueries({ queryKey: ['trash'] });
                    })
                    .catch((error: unknown) => notify({ tone: 'error', title: error instanceof Error ? error.message : 'ย้ายไปถังขยะไม่สำเร็จ' }))
                    .finally(() => setBulkTrashPending(false));
                }}
              >{bulkTrashPending ? 'กำลังย้าย…' : 'ย้ายไปถังขยะ'}</button>
            </div>
          </section>
        </div>
      ) : null}
    </div>
  );
}
