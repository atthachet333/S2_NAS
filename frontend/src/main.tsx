import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import App from '@/App';
import { AppErrorBoundary } from '@/components/errors/AppErrorBoundary';
import { ToastProvider } from '@/hooks/useToast';
import { UploadQueueProvider } from '@/hooks/useUploadQueue';
import { AuthProvider } from '@/hooks/useAuth';
import { ThemeProvider } from '@/hooks/useTheme';
import { PwaStatus } from '@/components/pwa/PwaStatus';
/*
  นำเข้าเพื่อผลข้างเคียงโดยตั้งใจ (F24-J)

  ที่เก็บนี้ติดตั้งตัวรับ beforeinstallprompt ตั้งแต่โมดูลถูกโหลด เบราว์เซอร์ยิงเหตุการณ์นั้น
  ครั้งเดียวและยิงเร็วมาก ถ้ารอให้คอมโพเนนต์ที่ใช้มันถูกสร้างก่อน เหตุการณ์จะผ่านไปแล้ว
*/
import '@/lib/install-prompt-store';
import '@/styles/index.css';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: false,
      staleTime: 10_000,
      /**
       * การอ่านรีเฟรชเองได้เมื่อเน็ตกลับมา (F24-K)
       *
       * นี่คือค่าเริ่มต้นของไลบรารีอยู่แล้ว แต่เขียนไว้ให้ชัดเพราะเป็นครึ่งหนึ่งของกฎ
       * ที่ตั้งใจไว้: "อ่านรีเฟรชได้เอง ส่วนการเขียนต้องให้ผู้ใช้สั่งใหม่เท่านั้น"
       */
      refetchOnReconnect: true,
    },
    mutations: {
      /**
       * การเขียนต้องล้มเหลวทันที ไม่ใช่ถูกพักไว้แล้วส่งเองตอนเน็ตกลับมา (F24-K)
       *
       * **ค่าเริ่มต้นของไลบรารีคือ 'online' ซึ่งพักคำสั่งเขียนไว้ขณะออฟไลน์
       * แล้วเล่นซ้ำให้อัตโนมัติเมื่อกลับมาออนไลน์** พฤติกรรมนั้นทำให้เกิดการย้ายเอกสาร
       * หรือการเปลี่ยนแปลงอื่นเกิดขึ้นเองในจังหวะที่ผู้ใช้ไม่ได้สั่ง และอาจนานหลายนาที
       * หลังจากที่เขาเปลี่ยนใจไปแล้ว
       *
       * 'always' ทำให้คำสั่งวิ่งทันทีและล้มเหลวด้วยข้อผิดพลาดของเครือข่ายอย่างตรงไปตรงมา
       * ผู้ใช้จึงเห็นผลเดี๋ยวนั้น และเป็นคนตัดสินใจเองว่าจะสั่งใหม่หรือไม่
       */
      networkMode: 'always',
    },
  },
});

const container = document.getElementById('root');
if (!container) {
  throw new Error('ไม่พบ root element สำหรับ S2 NAS');
}

createRoot(container).render(
  <StrictMode>
    <AppErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <ThemeProvider>
          <ToastProvider>
            <UploadQueueProvider>
              <AuthProvider>
                <BrowserRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
                  <App />
                  {/*
                    อยู่นอกเส้นทางทั้งหมดโดยตั้งใจ

                    service worker คือเปลือกของแอปทั้งตัว ไม่ใช่ของหน้าใดหน้าหนึ่ง
                    ถ้าลงทะเบียนไว้ในเปลือกของพื้นที่ไฟล์ ผู้ที่ยังไม่เข้าสู่ระบบ
                    จะไม่ได้รับอะไรเลย และหน้าเข้าสู่ระบบก็จะติดตั้งเป็นแอปไม่ได้
                  */}
                  <PwaStatus />
                </BrowserRouter>
              </AuthProvider>
            </UploadQueueProvider>
          </ToastProvider>
        </ThemeProvider>
      </QueryClientProvider>
    </AppErrorBoundary>
  </StrictMode>,
);
