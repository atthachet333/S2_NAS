import React, { type ErrorInfo, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
}

interface State {
  failed: boolean;
}

export class AppErrorBoundary extends React.Component<Props, State> {
  state: State = { failed: false };

  static getDerivedStateFromError(): State {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    if (import.meta.env?.DEV) {
      console.error('S2 NAS render failure', error, info);
    }
  }

  render() {
    if (this.state.failed) {
      return (
        <main className="flex min-h-screen items-center justify-center bg-background p-6 text-foreground">
          <section className="w-full max-w-md rounded-2xl border border-border bg-card p-8 text-center shadow-sm" role="alert">
            <h1 className="text-xl font-semibold">ไม่สามารถแสดงหน้านี้ได้</h1>
            <p className="mt-2 text-sm text-muted-foreground">เกิดข้อผิดพลาดขณะโหลด S2 NAS</p>
            <button
              type="button"
              className="mt-6 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground"
              onClick={() => window.location.reload()}
            >
              ลองใหม่
            </button>
          </section>
        </main>
      );
    }

    return this.props.children;
  }
}
