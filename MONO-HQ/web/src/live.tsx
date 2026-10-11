import {
  createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode,
} from 'react';
import type { PublicEvent, StateSnapshot } from '../../shared/contract.ts';
import { api, ApiError, errMsg, type Mode } from './api.ts';

export type ConnStatus = 'connecting' | 'connected' | 'reconnecting' | 'disconnected';

interface Live {
  mode: Mode;
  setMode: (m: Mode) => void;
  state: StateSnapshot | null;
  stateError: string | null;
  events: PublicEvent[]; // oldest first, deduped by seq
  conn: ConnStatus;
  lastVerifiedAt: number | null;
  /** bumps every 20s and after meaningful events; views reload on change */
  tick: number;
  refresh: () => void;
}

const Ctx = createContext<Live | null>(null);

export function useLive(): Live {
  const v = useContext(Ctx);
  if (!v) throw new Error('LiveProvider missing');
  return v;
}

function readMode(): Mode {
  try {
    return new URLSearchParams(location.search).get('mode') === 'demo' ? 'demo' : 'real';
  } catch {
    return 'real';
  }
}

const MAX_EVENTS = 200;
const MINOR: ReadonlySet<string> = new Set(['heartbeat', 'progress', 'tool_started', 'tool_completed']);

export function LiveProvider({ children }: { children: ReactNode }) {
  const [mode, setModeRaw] = useState<Mode>(readMode);
  const [state, setState] = useState<StateSnapshot | null>(null);
  const [stateError, setStateError] = useState<string | null>(null);
  const [events, setEvents] = useState<PublicEvent[]>([]);
  const [conn, setConn] = useState<ConnStatus>('connecting');
  const [lastVerifiedAt, setLastVerified] = useState<number | null>(null);
  const [tick, setTick] = useState(0);
  const refreshRef = useRef<() => void>(() => undefined);

  useEffect(() => {
    let alive = true;
    const seen = new Set<number>();
    let lastSeq = 0;
    let es: EventSource | null = null;
    let discTimer: ReturnType<typeof setTimeout> | undefined;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let refreshTimer: ReturnType<typeof setTimeout> | undefined;
    let retryDelay = 2000;

    setState(null);
    setEvents([]);
    setStateError(null);
    setConn('connecting');

    const clearDisc = () => {
      if (discTimer) clearTimeout(discTimer);
      discTimer = undefined;
    };
    const armDisc = () => {
      if (discTimer) return;
      discTimer = setTimeout(() => {
        discTimer = undefined;
        if (alive) setConn((c) => (c === 'connected' ? c : 'disconnected'));
      }, 8000);
    };

    const addEvents = (list: PublicEvent[]) => {
      const fresh: PublicEvent[] = [];
      for (const e of list) {
        if (!e || typeof e.seq !== 'number' || seen.has(e.seq)) continue;
        if (mode === 'real' && e.isDemo) continue; // demo events never appear in real mode
        seen.add(e.seq);
        fresh.push(e);
      }
      for (const e of list) if (e && typeof e.seq === 'number') lastSeq = Math.max(lastSeq, e.seq);
      if (!fresh.length) return;
      setEvents((prev) => [...prev, ...fresh].sort((a, b) => a.seq - b.seq).slice(-MAX_EVENTS));
    };

    const fetchState = async (): Promise<StateSnapshot | undefined> => {
      try {
        const s = await api<StateSnapshot>('GET', '/api/state', { mode });
        if (!alive) return undefined;
        setState(s);
        setStateError(null);
        setLastVerified(Date.now());
        if (es && es.readyState === 1) {
          clearDisc();
          setConn('connected');
        }
        return s;
      } catch (e) {
        if (!alive) return undefined;
        setStateError(errMsg(e));
        if (e instanceof ApiError && e.network) {
          setConn((c) => (c === 'connected' || c === 'connecting' ? 'reconnecting' : c));
          armDisc();
        }
        return undefined;
      }
    };

    const catchUp = async () => {
      try {
        for (let i = 0; i < 5; i++) {
          const list = await api<PublicEvent[]>('GET', '/api/events', { mode, query: { after: lastSeq, limit: 200 } });
          if (!alive) return;
          addEvents(Array.isArray(list) ? list : []);
          setLastVerified(Date.now());
          if (!Array.isArray(list) || list.length < 200) break;
        }
      } catch {
        /* the stream or next poll will retry */
      }
    };

    const scheduleRefresh = (important: boolean) => {
      if (refreshTimer) clearTimeout(refreshTimer);
      refreshTimer = setTimeout(() => {
        void fetchState();
        if (important) setTick((t) => t + 1);
      }, 350);
    };

    const connect = () => {
      if (!alive) return;
      es?.close();
      const src = new EventSource(`/api/stream?mode=${mode}`);
      es = src;
      src.onopen = () => {
        if (!alive) return;
        retryDelay = 2000;
        clearDisc();
        setConn('connected');
        setLastVerified(Date.now());
        void catchUp();
      };
      src.addEventListener('agent-event', (m) => {
        try {
          const ev = JSON.parse((m as MessageEvent<string>).data) as PublicEvent;
          if (!ev || typeof ev.seq !== 'number') return;
          addEvents([ev]);
          setLastVerified(Date.now());
          if (ev.type !== 'heartbeat') scheduleRefresh(!MINOR.has(ev.type));
        } catch {
          /* ignore malformed frame */
        }
      });
      src.onerror = () => {
        if (!alive) return;
        setConn((c) => (c === 'disconnected' ? c : 'reconnecting'));
        armDisc();
        if (src.readyState === 2) {
          if (retryTimer) clearTimeout(retryTimer);
          retryTimer = setTimeout(connect, retryDelay);
          retryDelay = Math.min(retryDelay * 2, 20000);
        }
      };
    };

    void (async () => {
      const s = await fetchState();
      if (!alive) return;
      if (s) lastSeq = Math.max(0, s.lastEventSeq - 40);
      connect();
    })();

    const poll = setInterval(() => {
      void fetchState();
      setTick((t) => t + 1);
    }, 20000);

    refreshRef.current = () => {
      void fetchState();
      setTick((t) => t + 1);
    };

    return () => {
      alive = false;
      clearInterval(poll);
      clearDisc();
      if (retryTimer) clearTimeout(retryTimer);
      if (refreshTimer) clearTimeout(refreshTimer);
      es?.close();
    };
  }, [mode]);

  const setMode = useCallback((m: Mode) => {
    try {
      const u = new URL(location.href);
      u.searchParams.set('mode', m);
      history.replaceState(null, '', u);
    } catch {
      /* ignore */
    }
    setModeRaw(m);
  }, []);
  const refresh = useCallback(() => refreshRef.current(), []);

  const value = useMemo<Live>(
    () => ({ mode, setMode, state, stateError, events, conn, lastVerifiedAt, tick, refresh }),
    [mode, setMode, state, stateError, events, conn, lastVerifiedAt, tick, refresh],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/** Fetches a GET resource; reloads silently when `tick` changes. */
export function useResource<T>(path: string, mode: Mode, tick: number) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const req = useRef(0);

  const load = useCallback(
    async (silent: boolean) => {
      const id = ++req.current;
      if (!silent) setLoading(true);
      try {
        const d = await api<T>('GET', path, { mode });
        if (id !== req.current) return;
        setData(d);
        setError(null);
      } catch (e) {
        if (id !== req.current) return;
        setError(errMsg(e));
      } finally {
        if (id === req.current) setLoading(false);
      }
    },
    [path, mode],
  );

  useEffect(() => {
    setData(null);
    setError(null);
    void load(false);
    return () => {
      req.current++;
    };
  }, [load]);

  const lastTick = useRef(tick);
  useEffect(() => {
    if (lastTick.current === tick) return;
    lastTick.current = tick;
    void load(true);
  }, [tick, load]);

  return { data, error, loading, reload: () => load(true), retry: () => load(false) };
}
