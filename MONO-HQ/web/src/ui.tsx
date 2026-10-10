import {
  createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { errMsg } from './api.ts';

/* ---------------- icons ---------------- */
const ICONS: Record<string, string> = {
  office: 'M3 21V9l9-6 9 6v12M9 21v-7h6v7M3 21h18',
  tasks: 'M9 11l3 3 8-8M20 12v7a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h9',
  clock: 'M12 7v5l3 2M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0z',
  wallet: 'M3 7a2 2 0 0 1 2-2h13v4M3 7v11a2 2 0 0 0 2 2h14a1 1 0 0 0 1-1v-9a1 1 0 0 0-1-1H5a2 2 0 0 1-2-2zM16 14.5h.01',
  research: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM21 21l-4.3-4.3M8 11h6M11 8v6',
  report: 'M7 3h8l4 4v14H7zM15 3v4h4M10 12h6M10 16h6',
  system: 'M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6zM9 12l2 2 4-4',
  power: 'M12 3v8M6.3 6.3a8 8 0 1 0 11.4 0',
  x: 'M6 6l12 12M18 6L6 18',
  play: 'M7 5v14l12-7z',
  stop: 'M6 6h12v12H6z',
  link: 'M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1',
  download: 'M12 4v11M7 11l5 5 5-5M5 20h14',
  alert: 'M12 4l9 16H3zM12 10v4M12 17h.01',
  refresh: 'M20 11a8 8 0 0 0-14-4M4 4v4h4M4 13a8 8 0 0 0 14 4M20 20v-4h-4',
  check: 'M5 12l5 5 9-10',
  plus: 'M12 5v14M5 12h14',
};
export function Icon({ name, size = 20 }: { name: keyof typeof ICONS | string; size?: number }) {
  return (
    <svg className="icon" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <path d={ICONS[name] ?? ''} />
    </svg>
  );
}

/* ---------------- small atoms ---------------- */
export type Tone = 'neutral' | 'ok' | 'warn' | 'bad' | 'info' | 'demo';
export function Chip({ tone = 'neutral', children, title }: { tone?: Tone; children: ReactNode; title?: string }) {
  return <span className={`chip chip-${tone}`} title={title}>{children}</span>;
}

export function Loading({ label = 'טוען…' }: { label?: string }) {
  return (
    <div className="state-box" role="status" aria-live="polite">
      <span className="spinner" aria-hidden="true" />
      <span>{label}</span>
    </div>
  );
}
export function EmptyState({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="state-box empty">
      <div className="state-art" aria-hidden="true">☾</div>
      <strong>{title}</strong>
      {children ? <p>{children}</p> : null}
      {action}
    </div>
  );
}
export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="state-box error" role="alert">
      <Icon name="alert" size={28} />
      <strong>לא הצלחנו לטעון</strong>
      <p>{message}</p>
      {onRetry ? <button className="btn" onClick={onRetry}>נסה שוב</button> : null}
    </div>
  );
}

export function Section({ title, aside, children, id }: { title: string; aside?: ReactNode; children: ReactNode; id?: string }) {
  return (
    <section className="section" aria-labelledby={id}>
      <div className="section-head">
        <h2 id={id}>{title}</h2>
        {aside}
      </div>
      {children}
    </section>
  );
}

export function Bar({ value, max, tone }: { value: number; max: number; tone?: Tone }) {
  const pct = max > 0 ? Math.min(100, Math.max(0, (value / max) * 100)) : 0;
  return (
    <div className="bar" role="presentation">
      <div className={`bar-fill bar-${tone ?? 'ok'}`} style={{ inlineSize: `${pct}%` }} />
    </div>
  );
}

/* ---------------- modal with focus trap ---------------- */
let lockCount = 0;
const FOCUSABLE =
  'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

export function Modal({
  label, onClose, variant = 'dialog', children, role = 'dialog',
}: {
  label: string; onClose: () => void; variant?: 'dialog' | 'drawer' | 'wide'; children: ReactNode; role?: 'dialog' | 'alertdialog';
}) {
  const ref = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    const root = document.getElementById('root');
    lockCount++;
    root?.setAttribute('inert', '');
    document.body.style.overflow = 'hidden';
    const el = ref.current;
    if (el) {
      const target = el.querySelector<HTMLElement>('[data-autofocus]') ?? el.querySelector<HTMLElement>(FOCUSABLE) ?? el;
      target.focus();
    }
    return () => {
      lockCount--;
      if (lockCount === 0) {
        root?.removeAttribute('inert');
        document.body.style.overflow = '';
      }
      prev?.focus?.();
    };
  }, []);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      closeRef.current();
      return;
    }
    if (e.key !== 'Tab' || !ref.current) return;
    const items = Array.from(ref.current.querySelectorAll<HTMLElement>(FOCUSABLE));
    if (!items.length) {
      e.preventDefault();
      return;
    }
    const first = items[0]!;
    const last = items[items.length - 1]!;
    const active = document.activeElement;
    if (e.shiftKey && (active === first || active === ref.current)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && active === last) {
      e.preventDefault();
      first.focus();
    }
  };

  return createPortal(
    <div className={`overlay overlay-${variant}`} onMouseDown={(e) => { if (e.target === e.currentTarget) closeRef.current(); }}>
      <div ref={ref} className={`modal modal-${variant}`} role={role} aria-modal="true" aria-label={label}
        tabIndex={-1} onKeyDown={onKeyDown}>
        {children}
      </div>
    </div>,
    document.body,
  );
}

/* ---------------- confirm dialog ---------------- */
export interface ConfirmOpts {
  title: string; body: ReactNode; confirmLabel: string; danger?: boolean;
}
export function useConfirm() {
  const [req, setReq] = useState<{ opts: ConfirmOpts; resolve: (v: boolean) => void } | null>(null);
  const confirm = useCallback(
    (opts: ConfirmOpts) => new Promise<boolean>((resolve) => setReq({ opts, resolve })),
    [],
  );
  const done = (v: boolean) => {
    req?.resolve(v);
    setReq(null);
  };
  const element = req ? (
    <Modal label={req.opts.title} onClose={() => done(false)} role="alertdialog">
      <div className="dialog-body">
        <h2>{req.opts.title}</h2>
        <div className="dialog-text">{req.opts.body}</div>
        <div className="dialog-actions">
          <button className="btn" data-autofocus onClick={() => done(false)}>ביטול</button>
          <button className={`btn ${req.opts.danger ? 'btn-danger' : 'btn-primary'}`} onClick={() => done(true)}>
            {req.opts.confirmLabel}
          </button>
        </div>
      </div>
    </Modal>
  ) : null;
  return [confirm, element] as const;
}

/* ---------------- toasts ---------------- */
interface Toast { id: number; kind: 'ok' | 'err'; msg: string }
const ToastCtx = createContext<(kind: 'ok' | 'err', msg: string) => void>(() => undefined);
export const useToast = () => useContext(ToastCtx);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<Toast[]>([]);
  const idRef = useRef(0);
  const push = useCallback((kind: 'ok' | 'err', msg: string) => {
    const id = ++idRef.current;
    setItems((p) => [...p.slice(-3), { id, kind, msg }]);
    setTimeout(() => setItems((p) => p.filter((t) => t.id !== id)), kind === 'err' ? 7000 : 4000);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      {createPortal(
        <div className="toasts" role="status" aria-live="polite">
          {items.map((t) => (
            <div key={t.id} className={`toast toast-${t.kind}`}>{t.msg}</div>
          ))}
        </div>,
        document.body,
      )}
    </ToastCtx.Provider>
  );
}

/** run an async mutation with a busy key + toast feedback */
export function useRunner() {
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const run = useCallback(
    async (key: string, fn: () => Promise<unknown>, okMsg?: string): Promise<boolean> => {
      setBusy(key);
      try {
        await fn();
        if (okMsg) toast('ok', okMsg);
        return true;
      } catch (e) {
        toast('err', errMsg(e));
        return false;
      } finally {
        setBusy(null);
      }
    },
    [toast],
  );
  return { busy, run };
}

/* ---------------- safe markdown (no HTML injection) ---------------- */
function inline(text: string, key: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(\*\*[^*]+\*\*|`[^`]+`)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const tok = m[0];
    out.push(tok.startsWith('**') ? <strong key={`${key}b${i}`}>{tok.slice(2, -2)}</strong> : <code key={`${key}c${i}`}>{tok.slice(1, -1)}</code>);
    last = m.index + tok.length;
    i++;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function Markdown({ source }: { source: string }) {
  const lines = source.replace(/\r/g, '').split('\n');
  const nodes: ReactNode[] = [];
  let i = 0;
  let k = 0;
  while (i < lines.length) {
    const line = lines[i] ?? '';
    if (line.startsWith('```')) {
      const buf: string[] = [];
      i++;
      while (i < lines.length && !(lines[i] ?? '').startsWith('```')) buf.push(lines[i++] ?? '');
      i++;
      nodes.push(<pre key={k++} dir="ltr">{buf.join('\n')}</pre>);
      continue;
    }
    const h = /^(#{1,4})\s+(.*)$/.exec(line);
    if (h) {
      const lvl = Math.min(4, h[1]!.length + 1);
      const Tag = `h${lvl}` as 'h2' | 'h3' | 'h4' | 'h5';
      nodes.push(<Tag key={k++}>{inline(h[2] ?? '', `h${k}`)}</Tag>);
      i++;
      continue;
    }
    if (/^\s*\|/.test(line)) {
      const rows: string[][] = [];
      while (i < lines.length && /^\s*\|/.test(lines[i] ?? '')) {
        const cells = (lines[i] ?? '').trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
        if (!cells.every((c) => /^:?-{2,}:?$/.test(c))) rows.push(cells);
        i++;
      }
      const [head, ...body] = rows;
      nodes.push(
        <div className="table-wrap" key={k++}>
          <table className="md-table">
            {head ? <thead><tr>{head.map((c, j) => <th key={j}>{inline(c, `th${j}`)}</th>)}</tr></thead> : null}
            <tbody>{body.map((r, a) => <tr key={a}>{r.map((c, j) => <td key={j}>{inline(c, `td${a}${j}`)}</td>)}</tr>)}</tbody>
          </table>
        </div>,
      );
      continue;
    }
    if (/^\s*([-*]|\d+\.)\s+/.test(line)) {
      const ordered = /^\s*\d+\./.test(line);
      const items: string[] = [];
      while (i < lines.length && /^\s*([-*]|\d+\.)\s+/.test(lines[i] ?? '')) {
        items.push((lines[i] ?? '').replace(/^\s*([-*]|\d+\.)\s+/, ''));
        i++;
      }
      const L = ordered ? 'ol' : 'ul';
      nodes.push(<L key={k++}>{items.map((t, j) => <li key={j}>{inline(t, `li${k}${j}`)}</li>)}</L>);
      continue;
    }
    if (/^\s*---+\s*$/.test(line)) {
      nodes.push(<hr key={k++} />);
      i++;
      continue;
    }
    if (!line.trim()) {
      i++;
      continue;
    }
    const buf: string[] = [];
    while (i < lines.length && (lines[i] ?? '').trim() && !/^(#{1,4}\s|```|\s*\||\s*([-*]|\d+\.)\s+|\s*---+\s*$)/.test(lines[i] ?? '')) {
      buf.push(lines[i++] ?? '');
    }
    nodes.push(<p key={k++}>{inline(buf.join(' '), `p${k}`)}</p>);
  }
  return <div className="md">{nodes}</div>;
}
