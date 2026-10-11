export type Mode = 'real' | 'demo';

export class ApiError extends Error {
  status: number;
  network: boolean;
  constructor(status: number, message: string, network = false) {
    super(message);
    this.status = status;
    this.network = network;
  }
}

let unauthorizedHandler: (() => void) | null = null;
export function setUnauthorizedHandler(fn: (() => void) | null) {
  unauthorizedHandler = fn;
}

interface Opts {
  mode?: Mode;
  body?: unknown;
  query?: Record<string, string | number | undefined>;
  signal?: AbortSignal;
  /** do not trigger the global "login required" handler on 401 */
  quiet401?: boolean;
}

export async function api<T>(method: 'GET' | 'POST', path: string, opts: Opts = {}): Promise<T> {
  const params = new URLSearchParams();
  if (opts.mode) params.set('mode', opts.mode);
  for (const [k, v] of Object.entries(opts.query ?? {})) if (v !== undefined) params.set(k, String(v));
  const qs = params.toString();
  const url = qs ? `${path}${path.includes('?') ? '&' : '?'}${qs}` : path;
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      credentials: 'same-origin',
      // Every write is JSON (the server rejects anything else), so a body-less POST still sends {}.
      headers: method === 'POST' || opts.body !== undefined ? { 'content-type': 'application/json' } : undefined,
      body: method === 'POST' || opts.body !== undefined ? JSON.stringify(opts.body ?? {}) : undefined,
      signal: opts.signal,
    });
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') throw e;
    throw new ApiError(0, 'אין חיבור לשרת', true);
  }
  if (res.status === 401 && !opts.quiet401) unauthorizedHandler?.();
  const text = await res.text();
  let json: unknown = undefined;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = undefined;
    }
  }
  if (!res.ok) {
    const o = json as { error?: unknown; message?: unknown } | undefined;
    const raw = typeof o?.error === 'string' ? o.error : typeof o?.message === 'string' ? o.message : '';
    throw new ApiError(res.status, raw || `שגיאת שרת (${res.status})`);
  }
  return json as T;
}

export function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : 'שגיאה לא צפויה';
}

/** Only http(s) links are ever rendered as anchors. */
export function safeUrl(u: string | null | undefined): string | null {
  if (!u) return null;
  try {
    const p = new URL(u);
    return p.protocol === 'https:' || p.protocol === 'http:' ? p.href : null;
  } catch {
    return null;
  }
}
