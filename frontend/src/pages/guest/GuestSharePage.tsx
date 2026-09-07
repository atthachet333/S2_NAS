import { useEffect, useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Download, Eye, FileText, Folder, Loader2, Lock, ShieldAlert } from 'lucide-react';
import {
  ApiError,
  guestShareApi,
  type GuestFolderDto,
  type GuestItemDto,
  type GuestShareDto,
} from '@/lib/api';
import { formatBytes } from '@/lib/utils';

/**
 * หน้าของแขก (F18)
 *
 * คนที่เปิดหน้านี้ไม่มีบัญชี S2 NAS และไม่ควรได้เห็นว่าข้างในระบบมีอะไรบ้าง
 *
 * จึงไม่ใช้เปลือกหน้าจอร่วมกับพื้นที่ทำงานภายในและพื้นที่ลูกค้าเลย - ไม่มีเมนู
 * ไม่มีไดร์ฟ ไม่มีถังขยะ ไม่มีรูปผู้ใช้ ไม่มีทางไปหน้าผู้ดูแล
 *
 * การใช้เปลือกร่วมกันแล้วซ่อนเมนูทีละอันคือวิธีที่พลาดได้ในวันที่มีคนเพิ่มเมนูใหม่
 * แล้วลืมซ่อน หน้านี้จึงไม่มีอะไรให้ลืมซ่อนตั้งแต่ต้น
 */

/**
 * ใบผ่านอยู่ในหน่วยความจำของหน้าเท่านั้น ไม่เขียนลง web storage เลย
 *
 * ระบบนี้มีกฎเด็ดขาดว่าไม่เก็บ token ใด ๆ ลง localStorage/sessionStorage/IndexedDB
 * และมีชุดทดสอบสแกนซอร์สคอยบังคับอยู่ - ใบผ่านของแขกไม่ได้รับการยกเว้น
 *
 * เหตุผลที่ไม่ขอยกเว้น แม้จะพอมีข้อแก้ต่างว่าโทเคนตัวจริงอยู่ใน URL อยู่แล้ว:
 * กฎที่มีข้อยกเว้นหนึ่งข้อจะมีข้อที่สอง แล้ววันหนึ่งจะไม่มีใครรู้ว่าข้อไหนคือข้อที่ผิด
 *
 * ราคาที่จ่าย: กด refresh แล้วต้องพิมพ์รหัสผ่านใหม่ ส่วนการเดินดูไฟล์
 * ในโฟลเดอร์ที่แชร์ยังลื่นไหลตามปกติ เพราะไม่มีการโหลดหน้าใหม่
 */

export default function GuestSharePage() {
  const { token = '' } = useParams();
  const [pass, setPass] = useState<string | null>(null);
  const [folderId, setFolderId] = useState<string | undefined>(undefined);

  const share = useQuery({
    queryKey: ['guest-share', token, pass],
    queryFn: () => guestShareApi.open(token, pass),
    retry: false,
    enabled: token.length > 0,
  });

  const data = share.data;
  const isFolder = data?.resource?.type === 'FOLDER';

  const folder = useQuery({
    queryKey: ['guest-folder', token, pass, folderId],
    queryFn: () => guestShareApi.children(token, pass, folderId),
    retry: false,
    enabled: Boolean(data?.resource) && isFolder,
  });

  if (share.isPending) {
    return (
      <GuestFrame>
        <div className="flex justify-center py-10 text-navy-400">
          <Loader2 className="h-6 w-6 animate-spin" aria-hidden />
        </div>
      </GuestFrame>
    );
  }

  if (share.isError) return <GuestFrame><Unavailable error={share.error} /></GuestFrame>;

  if (data?.passwordRequired) {
    return (
      <GuestFrame>
        <PasswordForm token={token} onUnlocked={setPass} />
      </GuestFrame>
    );
  }

  if (!data?.resource) return <GuestFrame><Unavailable error={null} /></GuestFrame>;

  return (
    <GuestFrame>
      {isFolder ? (
        <GuestFolder
          token={token}
          pass={pass}
          share={data}
          folder={folder.data}
          loading={folder.isPending}
          error={folder.isError ? folder.error : null}
          onOpenFolder={setFolderId}
        />
      ) : (
        <GuestFile token={token} pass={pass} share={data} resource={data.resource} />
      )}
    </GuestFrame>
  );
}

/* ------------------------------------------------------------------ */
/* เปลือกหน้าจอ                                                          */
/* ------------------------------------------------------------------ */

function GuestFrame({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-canvas px-4 py-8">
      <div className="mx-auto w-full max-w-2xl">
        {/* ชื่อระบบเท่านั้น ไม่ใช่ปุ่มและไม่ลิงก์ไปไหน - แขกไม่มีที่ให้ไปต่อในระบบนี้ */}
        <div className="mb-6 flex items-center gap-2.5">
          <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-[#14213d] text-[11px] font-bold text-white">
            S2
          </span>
          <span className="text-[13px] font-semibold text-navy-800">S2 NAS</span>
        </div>
        {children}
      </div>
    </div>
  );
}

const ERROR_TEXT: Record<string, string> = {
  SHARE_PREVIEW_DENIED: 'ลิงก์นี้ไม่อนุญาตให้ดูตัวอย่างเอกสาร',
  SHARE_DOWNLOAD_DENIED: 'ลิงก์นี้ไม่อนุญาตให้ดาวน์โหลด',
  SHARE_DOWNLOAD_LIMIT: 'ลิงก์นี้ใช้สิทธิ์ดาวน์โหลดครบตามที่กำหนดแล้ว',
};

/**
 * ข้อความเดียวสำหรับทุกสาเหตุ
 *
 * ไม่บอกว่าลิงก์หมดอายุ ถูกยกเลิก หรือไม่เคยมีอยู่ เพราะความต่างนั้นช่วยเฉพาะ
 * คนที่กำลังสุ่มโทเคนหาเอกสารขององค์กรอื่น ส่วนผู้รับตัวจริงต้องติดต่อผู้ส่งอยู่ดี
 */
function Unavailable({ error }: { error: unknown }) {
  const specific = error instanceof ApiError ? ERROR_TEXT[error.code] : undefined;

  return (
    <div className="s2-surface flex flex-col items-center gap-2.5 px-6 py-14 text-center shadow-subtle">
      <span className="mb-2 flex h-14 w-14 items-center justify-center rounded-[18px] border border-line bg-[var(--s2-surface-soft)] text-navy-400">
        <ShieldAlert className="h-6 w-6" aria-hidden />
      </span>
      <p className="text-[15px] font-medium text-navy-800">
        {specific ?? 'ลิงก์นี้ไม่สามารถใช้งานได้แล้ว'}
      </p>
      <p className="max-w-sm text-[13px] leading-relaxed text-navy-400">
        กรุณาติดต่อผู้ที่ส่งลิงก์นี้ให้คุณเพื่อขอลิงก์ใหม่
      </p>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* รหัสผ่าน                                                            */
/* ------------------------------------------------------------------ */

function PasswordForm({
  token,
  onUnlocked,
}: {
  token: string;
  onUnlocked: (pass: string | null) => void;
}) {
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setMessage(null);
    try {
      const result = await guestShareApi.verifyPassword(token, password);
      onUnlocked(result.pass);
    } catch (error) {
      /**
       * ข้อความเดียวสำหรับทั้งรหัสผิดและการยิงถี่เกินไป
       *
       * ถ้าบอกว่า "ลองมากเกินไป" ผู้ที่ไล่เดาจะรู้ทันทีว่าต้องรอแล้วยิงต่อ
       * ส่วนผู้รับตัวจริงที่พิมพ์ผิดก็แค่พิมพ์ใหม่ ซึ่งข้อความนี้ก็เพียงพอ
       */
      setMessage(
        error instanceof ApiError && error.status === 429
          ? 'ลองใหม่อีกครั้งในอีกสักครู่'
          : 'รหัสผ่านไม่ถูกต้อง',
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="s2-surface px-6 py-10 text-center shadow-subtle">
      <span className="mx-auto mb-3 flex h-14 w-14 items-center justify-center rounded-[18px] border border-brand-200 bg-brand-50 text-brand-600">
        <Lock className="h-6 w-6" aria-hidden />
      </span>
      <h1 className="text-[15px] font-medium text-navy-800">เอกสารนี้ต้องใช้รหัสผ่าน</h1>
      <p className="mt-1 text-[12.5px] text-navy-400">
        กรุณากรอกรหัสผ่านที่ได้รับจากผู้ส่งเอกสาร
      </p>

      <label className="mx-auto mt-5 block w-full max-w-xs text-left">
        <span className="text-[11.5px] font-medium text-navy-600">รหัสผ่าน</span>
        <input
          type="password"
          autoFocus
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          aria-invalid={message !== null}
          aria-describedby={message ? 'guest-password-error' : undefined}
          className="s2-input mt-1 h-9 text-[13px]"
        />
      </label>

      {message ? (
        /* role=alert เพื่อให้โปรแกรมอ่านหน้าจอประกาศทันที ไม่ใช่แค่เปลี่ยนสี */
        <p id="guest-password-error" role="alert" className="mt-2.5 text-[12px] text-red-600">
          {message}
        </p>
      ) : null}

      <button
        type="submit"
        disabled={busy || password.length === 0}
        className="s2-btn s2-btn-primary mx-auto mt-4 h-9 w-full max-w-xs text-[13px] disabled:opacity-60"
      >
        {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : 'เปิดเอกสาร'}
      </button>
    </form>
  );
}

/* ------------------------------------------------------------------ */
/* ไฟล์                                                                */
/* ------------------------------------------------------------------ */

function GuestFile({
  token,
  pass,
  share,
  resource,
}: {
  token: string;
  pass: string | null;
  share: GuestShareDto;
  resource: GuestItemDto;
}) {
  const [busy, setBusy] = useState<'preview' | 'download' | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  /**
   * ดึงเนื้อหาผ่าน fetch แล้วค่อยเปิด แทนที่จะชี้ href ไปที่เส้นทางตรง ๆ
   *
   * เพราะใบผ่านของแขกเดินทางใน header ซึ่งแท็กลิงก์ธรรมดาแนบให้ไม่ได้
   * และวิธีนี้ยังทำให้แสดงข้อความไทยได้เมื่อเซิร์ฟเวอร์ปฏิเสธ แทนที่จะเปิดแท็บว่าง
   */
  const fetchBlob = async (path: string) => {
    const response = await fetch(path, { headers: pass ? { 'X-Guest-Pass': pass } : {} });
    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as
        | { error?: { code?: string; message?: string } }
        | null;
      throw new ApiError(
        body?.error?.code ?? `HTTP_${response.status}`,
        body?.error?.message ?? 'เปิดเอกสารไม่สำเร็จ',
        response.status,
      );
    }
    return response.blob();
  };

  const run = async (kind: 'preview' | 'download') => {
    setBusy(kind);
    setMessage(null);
    try {
      const path =
        kind === 'preview'
          ? guestShareApi.contentPath(token)
          : guestShareApi.downloadPath(token);
      const blob = await fetchBlob(path);
      const url = URL.createObjectURL(blob);

      if (kind === 'preview') {
        window.open(url, '_blank', 'noopener,noreferrer');
      } else {
        const link = document.createElement('a');
        link.href = url;
        link.download = resource.name;
        link.click();
      }
      window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch (error) {
      setMessage(
        error instanceof ApiError
          ? (ERROR_TEXT[error.code] ?? 'เปิดเอกสารไม่สำเร็จ')
          : 'เปิดเอกสารไม่สำเร็จ',
      );
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="s2-surface px-6 py-10 text-center shadow-subtle">
      <span className="mx-auto mb-3 flex h-14 w-14 items-center justify-center rounded-[18px] border border-brand-200 bg-brand-50 text-brand-600">
        <FileText className="h-6 w-6" aria-hidden />
      </span>

      <p className="text-[12px] text-navy-400">เอกสารที่แชร์กับคุณ</p>
      {/* ชื่อไฟล์แสดงผ่าน children ของ React จึงเป็นข้อความล้วนเสมอ */}
      <h1 className="mt-1 break-words text-[16px] font-medium text-navy-900">{resource.name}</h1>
      <p className="mt-1 text-[12.5px] text-navy-400">
        {[resource.extension?.toUpperCase(), resource.size === null ? null : formatBytes(resource.size)]
          .filter(Boolean)
          .join(' • ')}
      </p>

      <div className="mt-6 flex flex-col justify-center gap-2 sm:flex-row">
        {share.allowPreview ? (
          <button
            type="button"
            onClick={() => void run('preview')}
            disabled={busy !== null}
            className="s2-btn s2-btn-outline h-9 gap-1.5 text-[13px] disabled:opacity-60"
          >
            {busy === 'preview' ? (
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
            ) : (
              <Eye className="h-4 w-4" aria-hidden />
            )}
            ดูเอกสาร
          </button>
        ) : null}

        {/* ปุ่มดาวน์โหลดไม่ปรากฏเลยเมื่อลิงก์ไม่อนุญาต - ไม่ใช่ปุ่มที่กดแล้วถูกปฏิเสธ */}
        {share.allowDownload ? (
          <button
            type="button"
            onClick={() => void run('download')}
            disabled={busy !== null}
            className="s2-btn s2-btn-primary h-9 gap-1.5 text-[13px] disabled:opacity-60"
          >
            {busy === 'download' ? (
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
            ) : (
              <Download className="h-4 w-4" aria-hidden />
            )}
            ดาวน์โหลด
          </button>
        ) : null}
      </div>

      {message ? (
        <p role="alert" className="mt-3 text-[12px] text-red-600">
          {message}
        </p>
      ) : null}

      <ExpiryNote expiresAt={share.expiresAt ?? null} />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* โฟลเดอร์                                                            */
/* ------------------------------------------------------------------ */

function GuestFolder({
  token,
  pass,
  share,
  folder,
  loading,
  error,
  onOpenFolder,
}: {
  token: string;
  pass: string | null;
  share: GuestShareDto;
  folder: GuestFolderDto | undefined;
  loading: boolean;
  error: unknown;
  onOpenFolder: (id: string | undefined) => void;
}) {
  if (error) return <Unavailable error={error} />;

  return (
    <div className="s2-surface overflow-hidden shadow-subtle">
      <div className="border-b border-line px-5 py-4">
        <p className="text-[12px] text-navy-400">โฟลเดอร์ที่แชร์กับคุณ</p>
        <h1 className="mt-0.5 break-words text-[16px] font-medium text-navy-900">
          {share.resource?.name}
        </h1>

        {/*
          เส้นทางนำทางเริ่มที่โฟลเดอร์ที่แชร์เสมอ
          ไม่มีชั้นใดเหนือรากปรากฏ - เซิร์ฟเวอร์ตัดทิ้งไปแล้วตั้งแต่ต้นทาง
        */}
        {folder && folder.breadcrumb.length > 1 ? (
          <nav aria-label="เส้นทาง" className="mt-2 flex flex-wrap items-center gap-1 text-[12px]">
            {folder.breadcrumb.map((node, index) => (
              <span key={node.id} className="flex items-center gap-1">
                {index > 0 ? <span className="text-navy-300">/</span> : null}
                <button
                  type="button"
                  onClick={() => onOpenFolder(index === 0 ? undefined : node.id)}
                  disabled={index === folder.breadcrumb.length - 1}
                  className="text-navy-500 hover:underline disabled:font-medium disabled:text-navy-800 disabled:no-underline"
                >
                  {node.name}
                </button>
              </span>
            ))}
          </nav>
        ) : null}
      </div>

      {loading ? (
        <div className="flex justify-center py-10 text-navy-400">
          <Loader2 className="h-5 w-5 animate-spin" aria-hidden />
        </div>
      ) : !folder || folder.items.length === 0 ? (
        <p className="px-5 py-10 text-center text-[13px] text-navy-400">โฟลเดอร์นี้ยังไม่มีเอกสาร</p>
      ) : (
        <ul>
          {folder.items.map((item) => (
            <li key={item.id} className="border-b border-line last:border-0">
              <GuestRow item={item} token={token} pass={pass} share={share} onOpen={onOpenFolder} />
            </li>
          ))}
        </ul>
      )}

      <div className="px-5 pb-5">
        <ExpiryNote expiresAt={share.expiresAt ?? null} />
      </div>
    </div>
  );
}

function GuestRow({
  item,
  token,
  pass,
  share,
  onOpen,
}: {
  item: GuestItemDto;
  token: string;
  pass: string | null;
  share: GuestShareDto;
  onOpen: (id: string) => void;
}) {
  const [busy, setBusy] = useState(false);

  if (item.type === 'FOLDER') {
    return (
      <button
        type="button"
        onClick={() => onOpen(item.id)}
        className="flex w-full items-center gap-2.5 px-5 py-3 text-left hover:bg-[var(--s2-surface-soft)]"
      >
        <Folder className="h-4 w-4 shrink-0 text-navy-400" aria-hidden />
        <span className="min-w-0 flex-1 truncate text-[13px] text-navy-800">{item.name}</span>
      </button>
    );
  }

  const open = async (kind: 'preview' | 'download') => {
    setBusy(true);
    try {
      const path =
        kind === 'preview'
          ? guestShareApi.contentPath(token, item.id)
          : guestShareApi.downloadPath(token, item.id);
      const response = await fetch(path, { headers: pass ? { 'X-Guest-Pass': pass } : {} });
      if (!response.ok) return;

      const url = URL.createObjectURL(await response.blob());
      if (kind === 'preview') {
        window.open(url, '_blank', 'noopener,noreferrer');
      } else {
        const link = document.createElement('a');
        link.href = url;
        link.download = item.name;
        link.click();
      }
      window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex items-center gap-2.5 px-5 py-3">
      <FileText className="h-4 w-4 shrink-0 text-navy-400" aria-hidden />
      <span className="min-w-0 flex-1 truncate text-[13px] text-navy-800">{item.name}</span>
      <span className="hidden shrink-0 text-[11.5px] text-navy-400 sm:inline">
        {item.size === null ? '' : formatBytes(item.size)}
      </span>

      {share.allowPreview ? (
        <button
          type="button"
          onClick={() => void open('preview')}
          disabled={busy}
          aria-label={`ดู ${item.name}`}
          className="s2-btn s2-btn-ghost h-8 w-8 shrink-0 p-0"
        >
          <Eye className="h-3.5 w-3.5" aria-hidden />
        </button>
      ) : null}
      {share.allowDownload ? (
        <button
          type="button"
          onClick={() => void open('download')}
          disabled={busy}
          aria-label={`ดาวน์โหลด ${item.name}`}
          className="s2-btn s2-btn-ghost h-8 w-8 shrink-0 p-0"
        >
          <Download className="h-3.5 w-3.5" aria-hidden />
        </button>
      ) : null}
    </div>
  );
}

/** บอกวันหมดอายุไว้ล่วงหน้า ผู้รับจะได้บันทึกเอกสารก่อนลิงก์ปิด */
function ExpiryNote({ expiresAt }: { expiresAt: string | null }) {
  const text = useMemo(() => {
    if (!expiresAt) return null;
    return new Date(expiresAt).toLocaleDateString('th-TH', {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    });
  }, [expiresAt]);

  useEffect(() => {
    /**
     * บอกเครื่องมือค้นหาไม่ให้เก็บหน้านี้เข้าดัชนี
     *
     * เซิร์ฟเวอร์ส่ง X-Robots-Tag มาแล้ว แต่หน้านี้เรนเดอร์ในเบราว์เซอร์
     * เครื่องมือบางตัวอ่านเฉพาะ meta ในเอกสาร จึงใส่ไว้ทั้งสองที่
     */
    const meta = document.createElement('meta');
    meta.name = 'robots';
    meta.content = 'noindex, nofollow';
    document.head.appendChild(meta);
    return () => meta.remove();
  }, []);

  if (!text) return null;
  return <p className="mt-5 text-[12px] text-navy-400">ลิงก์หมดอายุ: {text}</p>;
}
