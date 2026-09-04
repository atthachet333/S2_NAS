import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ChevronRight, Loader2, Upload } from 'lucide-react';
import { getAccessToken, type PortalFolderDto } from '@/lib/api';
import { portalApi } from '@/lib/api';
import { PortalItemList } from '@/components/portal/PortalItemList';
import { ListSkeleton } from '@/components/ui/States';
import { useToast } from '@/hooks/useToast';

/**
 * ข้อความผิดพลาดของการอัปโหลด
 *
 * แปลรหัสที่ปลอดภัยเป็นภาษาไทยที่บอกว่าต้องทำอะไรต่อ
 * ไม่ส่งข้อความดิบจากเซิร์ฟเวอร์ออกหน้าจอ และไม่แสดงรหัสให้ผู้ใช้เดาเอง
 */
function uploadErrorText(request: XMLHttpRequest): string {
  const byStatus: Record<number, string> = {
    403: 'ไม่มีสิทธิ์อัปโหลดในโฟลเดอร์นี้',
    404: 'ไม่พบโฟลเดอร์ปลายทาง อาจถูกยกเลิกการแชร์แล้ว',
    409: 'โฟลเดอร์นี้ถูกล็อกไว้ชั่วคราว กรุณาติดต่อผู้ดูแล',
    413: 'ไฟล์มีขนาดใหญ่เกินกำหนด',
  };

  let code: string | undefined;
  try {
    code = JSON.parse(request.responseText)?.error?.code;
  } catch {
    code = undefined;
  }

  const byCode: Record<string, string> = {
    FILE_TOO_LARGE: 'ไฟล์มีขนาดใหญ่เกินกำหนด',
    UNSUPPORTED_FILE_TYPE: 'ไม่รองรับไฟล์ชนิดนี้',
    FILE_CONTENT_MISMATCH: 'ไฟล์เสียหายหรือชนิดไฟล์ไม่ตรงกับนามสกุล',
    RESOURCE_LOCKED: 'โฟลเดอร์นี้ถูกล็อกไว้ชั่วคราว กรุณาติดต่อผู้ดูแล',
    PORTAL_UPLOAD_DENIED: 'ไม่มีสิทธิ์อัปโหลดในโฟลเดอร์นี้',
  };

  return (code && byCode[code]) ?? byStatus[request.status] ?? 'ส่งไฟล์ไม่สำเร็จ กรุณาลองใหม่';
}

/**
 * หน้าโฟลเดอร์ในพื้นที่ลูกค้า
 *
 * เส้นทางนำทางมาจากเซิร์ฟเวอร์ ซึ่งตัดให้เริ่มที่โฟลเดอร์ที่ถูกแชร์ให้เสมอ
 * หน้าจอจึงไม่มีทางเผยชื่อโฟลเดอร์ชั้นเหนือขึ้นไปได้ แม้จะเขียนโค้ดผิด
 */
export default function PortalFolderPage() {
  const { folderId = '' } = useParams();
  const { notify } = useToast();
  const [data, setData] = useState<PortalFolderDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [denied, setDenied] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const load = useCallback(() => {
    setLoading(true);
    setDenied(false);
    portalApi
      .folder(folderId)
      .then((response) => setData(response.data))
      .catch(() => setDenied(true))
      .finally(() => setLoading(false));
  }, [folderId]);

  useEffect(load, [load]);

  /**
   * อัปโหลดผ่าน XMLHttpRequest เพื่อให้แนบ Authorization header ได้
   * ปลายทางมาจาก path ของหน้านี้ ไม่มีการส่ง parentId จากฝั่งหน้าจอ
   * เซิร์ฟเวอร์ตรวจสิทธิ์ของโฟลเดอร์นั้นเองอีกครั้งเสมอ
   */
  const upload = (file: File) => {
    setUploading(true);
    const form = new FormData();
    form.append('file', file);

    const request = new XMLHttpRequest();
    request.open('POST', `/api/portal/folders/${folderId}/upload`);
    const token = getAccessToken();
    if (token) request.setRequestHeader('Authorization', `Bearer ${token}`);
    request.upload.onprogress = (event) => {
      if (event.lengthComputable) setProgress(Math.round((event.loaded / event.total) * 100));
    };
    request.onload = () => {
      setUploading(false);
      setProgress(0);
      if (request.status === 201) {
        notify({ tone: 'success', title: 'ส่งไฟล์เรียบร้อยแล้ว', description: file.name });
        load();
        return;
      }
      notify({ tone: 'error', title: uploadErrorText(request) });
    };
    request.onerror = () => {
      setUploading(false);
      setProgress(0);
      notify({ tone: 'error', title: 'ส่งไฟล์ไม่สำเร็จ กรุณาตรวจสอบการเชื่อมต่อแล้วลองใหม่' });
    };
    request.send(form);
  };

  if (loading) return <ListSkeleton rows={5} />;

  if (denied || !data) {
    /**
     * ไม่พบและไม่มีสิทธิ์ให้ข้อความเดียวกัน
     * มิฉะนั้นลูกค้าจะเดาได้ว่ารหัสไหนมีอยู่จริงในระบบ
     */
    return (
      <div className="s2-surface flex flex-col items-center gap-3 px-6 py-14 text-center">
        <p className="text-[14px] font-medium text-navy-800">ไม่พบเอกสารที่ต้องการ</p>
        <p className="max-w-[420px] text-[12.5px] text-navy-400">
          เอกสารนี้อาจถูกยกเลิกการแชร์หรือหมดอายุแล้ว กรุณาติดต่อผู้ดูแลหากคุณคิดว่าควรมีสิทธิ์เข้าถึง
        </p>
        <Link to="/portal" className="s2-btn s2-btn-outline mt-1 h-9 px-3 text-[12.5px]">
          กลับหน้าแรก
        </Link>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <nav aria-label="เส้นทางโฟลเดอร์" className="flex flex-wrap items-center gap-1 text-[12px] text-navy-400">
        <Link to="/portal" className="hover:text-brand-700 hover:underline">
          พื้นที่เอกสาร
        </Link>
        {data.breadcrumb.map((crumb, index) => (
          <span key={crumb.id} className="flex items-center gap-1">
            <ChevronRight className="h-3.5 w-3.5 text-navy-200" aria-hidden />
            {index === data.breadcrumb.length - 1 ? (
              <span className="font-medium text-navy-800">{crumb.name}</span>
            ) : (
              <Link to={`/portal/folders/${crumb.id}`} className="hover:text-brand-700 hover:underline">
                {crumb.name}
              </Link>
            )}
          </span>
        ))}
      </nav>

      <div className="flex flex-wrap items-center gap-3">
        <h1 className="min-w-0 flex-1 truncate text-[18px] font-semibold text-navy-900">{data.folder.name}</h1>

        {data.folder.capabilities.canUpload ? (
          <>
            <input
              ref={inputRef}
              type="file"
              className="hidden"
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) upload(file);
                event.target.value = '';
              }}
            />
            <button
              type="button"
              disabled={uploading}
              onClick={() => inputRef.current?.click()}
              className="s2-btn s2-btn-primary h-9 gap-1.5 px-3 text-[12.5px] disabled:opacity-60"
            >
              {uploading ? (
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
              ) : (
                <Upload className="h-4 w-4" aria-hidden />
              )}
              {uploading ? `กำลังส่งไฟล์… ${progress}%` : 'ส่งไฟล์เข้าโฟลเดอร์นี้'}
            </button>
          </>
        ) : null}
      </div>

      {/*
        ปลายทางต้องอ่านได้ก่อนกด ไม่ใช่หลังส่งไปแล้ว
        ลูกค้าที่ได้รับสิทธิ์หลายโฟลเดอร์มีโอกาสส่งผิดที่ และไฟล์ที่ส่งผิดที่ลบเองไม่ได้
      */}
      {data.folder.capabilities.canUpload ? (
        <div className="rounded-xl border border-brand-100 bg-brand-50/60 px-3 py-2.5">
          <p className="text-[11.5px] text-navy-600">
            กำลังอัปโหลดไปยัง{' '}
            <span className="font-medium text-navy-800">
              “{data.breadcrumb.map((crumb) => crumb.name).join(' / ')}”
            </span>
          </p>
          {uploading ? (
            <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-white/70" role="progressbar" aria-valuenow={progress} aria-valuemin={0} aria-valuemax={100}>
              <div className="h-full rounded-full bg-brand-600 transition-[width]" style={{ width: `${progress}%` }} />
            </div>
          ) : null}
        </div>
      ) : null}

      <PortalItemList items={data.items} />
    </div>
  );
}
