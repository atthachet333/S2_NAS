import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { AlertCircle, CheckCircle2, Info, X } from 'lucide-react';

type ToastTone = 'info' | 'success' | 'error';

interface Toast {
  id: number;
  title: string;
  description?: string;
  tone: ToastTone;
}

interface ToastContextValue {
  notify: (toast: Omit<Toast, 'id'>) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

let nextId = 1;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const dismiss = useCallback((id: number) => {
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  const notify = useCallback(
    (toast: Omit<Toast, 'id'>) => {
      const id = nextId++;
      setToasts((current) => [...current, { ...toast, id }]);
      window.setTimeout(() => dismiss(id), 6000);
    },
    [dismiss],
  );

  const value = useMemo(() => ({ notify }), [notify]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="pointer-events-none fixed bottom-5 right-5 z-[var(--z-toast)] flex w-[min(360px,calc(100vw-2rem))] flex-col gap-2">
        {toasts.map((toast) => (
          <div
            key={toast.id}
            role="status"
            className="s2-surface pointer-events-auto flex items-start gap-3 px-4 py-3 shadow-[0_8px_28px_rgba(14,23,39,0.14)]"
          >
            <span className="mt-0.5 shrink-0">
              {toast.tone === 'success' ? (
                <CheckCircle2 className="h-4 w-4 text-emerald-600" aria-hidden />
              ) : toast.tone === 'error' ? (
                <AlertCircle className="h-4 w-4 text-red-600" aria-hidden />
              ) : (
                <Info className="h-4 w-4 text-brand-600" aria-hidden />
              )}
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-[13px] font-medium text-navy-900">{toast.title}</p>
              {toast.description ? (
                <p className="mt-0.5 text-[12px] leading-relaxed text-navy-500">{toast.description}</p>
              ) : null}
            </div>
            <button
              type="button"
              onClick={() => dismiss(toast.id)}
              className="-mr-1 rounded-md p-1 text-navy-300 hover:bg-navy-50 hover:text-navy-600"
              aria-label="ปิดการแจ้งเตือน"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastContextValue {
  const context = useContext(ToastContext);
  if (!context) throw new Error('useToast ต้องอยู่ภายใน ToastProvider');
  return context;
}
