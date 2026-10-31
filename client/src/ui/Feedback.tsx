import { AlertCircle, CheckCircle2, Info } from 'lucide-react';
import { type ReactNode, createContext, useCallback, useContext, useMemo, useState } from 'react';

export function Alert({ tone = 'error', children }: { tone?: 'error' | 'success' | 'info'; children: ReactNode }) {
  const Icon = tone === 'error' ? AlertCircle : tone === 'success' ? CheckCircle2 : Info;
  return (
    <div className={`alert alert--${tone}`} role={tone === 'error' ? 'alert' : 'status'}>
      <Icon size={18} />
      <div>{children}</div>
    </div>
  );
}

export function EmptyState({ icon, title, children, action }: { icon: ReactNode; title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="state">
      <div className="state__icon">{icon}</div>
      <h3>{title}</h3>
      {children && <p style={{ maxWidth: '46ch' }}>{children}</p>}
      {action}
    </div>
  );
}

type Tone = 'ok' | 'warn' | 'bad' | 'info' | 'mute';
export function Badge({ tone = 'mute', plain, children }: { tone?: Tone; plain?: boolean; children: ReactNode }) {
  return <span className={`badge badge--${tone}${plain ? ' badge--plain' : ''}`}>{children}</span>;
}

/* ---------- Toasts ---------- */
interface ToastItem {
  id: number;
  tone: 'success' | 'error';
  message: string;
}
interface ToastApi {
  success(message: string): void;
  error(message: string): void;
}
const ToastContext = createContext<ToastApi | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const push = useCallback((tone: ToastItem['tone'], message: string) => {
    const id = Date.now() + Math.random();
    setItems((xs) => [...xs, { id, tone, message }]);
    window.setTimeout(() => setItems((xs) => xs.filter((x) => x.id !== id)), tone === 'error' ? 7000 : 4000);
  }, []);
  const api = useMemo<ToastApi>(() => ({ success: (m) => push('success', m), error: (m) => push('error', m) }), [push]);

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div className="toasts" aria-live="polite">
        {items.map((t) => (
          <div key={t.id} className={`toast${t.tone === 'error' ? ' toast--error' : ''}`}>
            {t.tone === 'error' ? <AlertCircle size={18} /> : <CheckCircle2 size={18} />}
            <span>{t.message}</span>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastApi {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used inside <ToastProvider>');
  return ctx;
}
