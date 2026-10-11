import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { api, errMsg, setUnauthorizedHandler } from './api.ts';
import { SceneDefs } from './characters.tsx';
import { AutomationsView } from './Automations.tsx';
import { fmtTime } from './format.ts';
import { LiveProvider, useLive } from './live.tsx';
import { MissionsView } from './Missions.tsx';
import { MoneyView } from './Money.tsx';
import { OfficeView } from './Office.tsx';
import { ReportsView } from './Reports.tsx';
import { ResearchView } from './Research.tsx';
import { KillSwitch, SystemViewPage } from './System.tsx';
import { ErrorState, Icon, Loading, ToastProvider, useRunner } from './ui.tsx';

interface Route { id: string; label: string; short: string; icon: string; title: string; view: () => ReactNode }
const ROUTES: Route[] = [
  { id: 'office', label: 'המשרד החי', short: 'משרד', icon: 'office', title: 'המשרד החי', view: () => <OfficeView /> },
  { id: 'missions', label: 'משימות', short: 'משימות', icon: 'tasks', title: 'משימות ואישורים', view: () => <MissionsView /> },
  { id: 'automations', label: 'אוטומציות', short: 'אוטומציות', icon: 'clock', title: 'אוטומציות', view: () => <AutomationsView /> },
  { id: 'money', label: 'הכסף שלי', short: 'כסף', icon: 'wallet', title: 'הכסף שלי', view: () => <MoneyView /> },
  { id: 'research', label: 'מחקר', short: 'מחקר', icon: 'research', title: 'שולחן מחקר', view: () => <ResearchView /> },
  { id: 'reports', label: 'דוחות', short: 'דוחות', icon: 'report', title: 'דוחות', view: () => <ReportsView /> },
  { id: 'system', label: 'מערכת', short: 'מערכת', icon: 'system', title: 'מערכת', view: () => <SystemViewPage /> },
];

function useRoute(): [string, (id: string) => void] {
  const read = () => {
    const h = location.hash.replace(/^#\/?/, '');
    return ROUTES.some((r) => r.id === h) ? h : 'office';
  };
  const [id, setId] = useState(read);
  useEffect(() => {
    const on = () => setId(read());
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return [id, (next) => { location.hash = `/${next}`; }];
}

/* -------------------------------- auth -------------------------------- */
interface AuthInfo { required: boolean; authenticated: boolean }

function Login({ onDone }: { onDone: () => void }) {
  const [token, setToken] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr(null);
    try {
      await api('POST', '/api/login', { body: { token }, quiet401: true });
      setToken('');
      onDone();
    } catch (x) {
      setErr(errMsg(x));
    }
  };
  return (
    <main className="login">
      <form className="login-card" onSubmit={submit}>
        <div className="brandmark" aria-hidden="true">M</div>
        <h1>MONO HQ</h1>
        <p className="muted">הכניסה מוגנת. הזן את אסימון הגישה שהוגדר בשרת (MONO_ACCESS_TOKEN).</p>
        <label className="field"><span>אסימון גישה</span>
          <input type="password" autoComplete="current-password" dir="ltr" value={token} onChange={(e) => setToken(e.target.value)} required autoFocus />
        </label>
        {err ? <div className="callout callout-bad" role="alert">{err}</div> : null}
        <button className="btn btn-primary" type="submit" disabled={!token}>כניסה</button>
        <p className="muted small">האסימון נשלח לשרת ונשמר בעוגיית HttpOnly בלבד. הוא לא נשמר בדפדפן.</p>
      </form>
    </main>
  );
}

/* ------------------------------- chrome ------------------------------- */
function ConnIndicator() {
  const { mode, conn, lastVerifiedAt } = useLive();
  const lastOk = lastVerifiedAt ? fmtTime(new Date(lastVerifiedAt).toISOString()) : null;
  if (conn === 'connected') {
    return mode === 'real'
      ? <span className="conn conn-live" role="status"><i className="dot" /> חי · מחובר</span>
      : <span className="conn conn-demo" role="status"><i className="dot" /> מחובר · הדמיה</span>;
  }
  if (conn === 'connecting') return <span className="conn conn-wait" role="status"><i className="dot" /> מתחבר…</span>;
  if (conn === 'reconnecting') return <span className="conn conn-wait" role="status"><i className="dot" /> מתחבר מחדש…{lastOk ? ` · אומת ${lastOk}` : ''}</span>;
  return <span className="conn conn-off" role="status"><i className="dot" /> מנותק · {lastOk ? `אומת לאחרונה ב-${lastOk}` : 'טרם אומת'}</span>;
}

function ModeSwitch() {
  const { mode, setMode } = useLive();
  return (
    <div className="mode-switch seg" role="group" aria-label="מצב תצוגה">
      <button aria-pressed={mode === 'real'} onClick={() => setMode('real')}>אמיתי</button>
      <button aria-pressed={mode === 'demo'} onClick={() => setMode('demo')}>הדמיה</button>
    </div>
  );
}

function DemoBanner() {
  const { mode, state, refresh } = useLive();
  const { busy, run } = useRunner();
  if (mode !== 'demo') return null;
  const running = state?.demoRunning ?? false;
  const toggle = async () => {
    if (await run('demo', () => api('POST', running ? '/api/demo/stop' : '/api/demo/start', { mode, body: {} }), running ? 'ההדמיה נעצרה' : 'ההדמיה התחילה')) refresh();
  };
  return (
    <div className="demo-banner" role="region" aria-label="מצב הדמיה">
      <strong className="demo-title">DEMO · הדמיה — לא ביצוע אמיתי</strong>
      <span className="demo-sub">האירועים כאן מדומים ומסומנים. לא מתבצעות קריאות AI ולא נוגעים בנתונים אמיתיים.</span>
      <button className="btn btn-demo" onClick={toggle} disabled={busy !== null || !state}>
        <Icon name={running ? 'stop' : 'play'} size={16} /> {running ? 'עצור הדמיה' : 'התחל הדמיה'}
      </button>
    </div>
  );
}

function Shell() {
  const [route, go] = useRoute();
  const { state } = useLive();
  const current = ROUTES.find((r) => r.id === route) ?? ROUTES[0]!;
  const pending = state?.pendingApprovals.length ?? 0;

  useEffect(() => {
    document.title = `${current.title} · MONO HQ`;
    document.getElementById('main')?.focus({ preventScroll: true });
    window.scrollTo(0, 0);
  }, [current]);

  const nav = (cls: string, short: boolean) => (
    <nav className={cls} aria-label="ניווט ראשי">
      {ROUTES.map((r) => (
        <a key={r.id} href={`#/${r.id}`} aria-current={r.id === route ? 'page' : undefined} onClick={(e) => { e.preventDefault(); go(r.id); }}>
          <Icon name={r.icon} size={short ? 22 : 20} />
          <span>{short ? r.short : r.label}</span>
          {r.id === 'missions' && pending > 0 ? <b className="badge" aria-label={`${pending} אישורים ממתינים`}>{pending}</b> : null}
        </a>
      ))}
    </nav>
  );

  return (
    <div className="app">
      <a className="skip" href="#main" onClick={(e) => { e.preventDefault(); document.getElementById('main')?.focus(); }}>דלג לתוכן</a>
      <aside className="side">
        <div className="brand"><div className="brandmark" aria-hidden="true">M</div><div><strong>MONO</strong><small>FINANCE HQ</small></div></div>
        {nav('nav-side', false)}
        <div className="side-foot"><p>להפוך כל שקל להחלטה מודעת, בלי לשפוט ובלי להמציא נתונים.</p></div>
      </aside>
      <div className="col">
        <div className="sticky-top">
        <header className="topbar">
          <div className="topbar-title">
            <div className="brand brand-mobile"><div className="brandmark" aria-hidden="true">M</div></div>
            <div>
              <h1>{current.title}</h1>
              <ConnIndicator />
            </div>
          </div>
          <div className="topbar-actions">
            <ModeSwitch />
            <KillSwitch compact />
          </div>
        </header>
        <DemoBanner />
        </div>
        <main id="main" tabIndex={-1}><div className="route" key={current.id}>{current.view()}</div></main>
      </div>
      {nav('tabbar', true)}
    </div>
  );
}

export function App() {
  const [auth, setAuth] = useState<AuthInfo | null>(null);
  const [error, setError] = useState<string | null>(null);

  const check = useCallback(async () => {
    setError(null);
    try {
      setAuth(await api<AuthInfo>('GET', '/api/auth', { quiet401: true }));
    } catch (e) {
      setError(errMsg(e));
    }
  }, []);

  useEffect(() => {
    void check();
    setUnauthorizedHandler(() => setAuth({ required: true, authenticated: false }));
    return () => setUnauthorizedHandler(null);
  }, [check]);

  let body: ReactNode;
  if (error) body = <main className="login"><ErrorState message={error} onRetry={() => void check()} /></main>;
  else if (!auth) body = <main className="login"><Loading label="מתחבר לשרת…" /></main>;
  else if (auth.required && !auth.authenticated) body = <Login onDone={() => void check()} />;
  else body = <LiveProvider><Shell /></LiveProvider>;

  return (
    <ToastProvider>
      <SceneDefs />
      {body}
    </ToastProvider>
  );
}
