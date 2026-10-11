import { useEffect, useState } from 'react';
import { AGENT_IDS, type AgentId, type AgentState, type PublicEvent } from '../../shared/contract.ts';
import { safeUrl } from './api.ts';
import { DeskScene, Portrait } from './characters.tsx';
import {
  AGENT_STATUS_HE, EVENT_TYPE_HE, MODEL_STATUS_HE, TASK_STATUS_HE, fmtDateTime, fmtElapsed, fmtTime, fmtUsd,
} from './format.ts';
import { useLive } from './live.tsx';
import { Bar, Chip, EmptyState, ErrorState, Loading, Modal, type Tone } from './ui.tsx';

const IDLE_BUBBLE = 'ממתין למשימה';

const FALLBACK: Record<AgentId, { name: string; role: string }> = {
  mono: { name: 'MONO', role: '' }, scout: { name: 'SCOUT', role: '' }, ledger: { name: 'LEDGER', role: '' },
  flow: { name: 'FLOW', role: '' }, credit: { name: 'CREDIT', role: '' }, budget: { name: 'BUDGET', role: '' },
  radar: { name: 'RADAR', role: '' }, guardian: { name: 'GUARDIAN', role: '' },
};

export const agentName = (id: string) => id.toUpperCase();

function useNow(ms = 1000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

const statusTone = (s: AgentState['status']): Tone =>
  s === 'working' ? 'ok' : s === 'failed' ? 'bad' : s === 'blocked' || s === 'stale' ? 'warn' : s === 'idle' ? 'neutral' : 'info';

/* ------------------------------ night hero ------------------------------ */
const JLM_HOUR = new Intl.DateTimeFormat('en-GB', { hour: 'numeric', hourCycle: 'h23', timeZone: 'Asia/Jerusalem' });
const JLM_HM = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: 'Asia/Jerusalem' });

const greeting = (hour: number) =>
  hour < 5 || hour >= 21 ? 'משמרת לילה' : hour < 12 ? 'בוקר טוב' : hour < 17 ? 'צהריים טובים' : 'ערב טוב';

/** Time-of-day greeting with a big Jerusalem clock. Counts come from live state; demo is labelled as such. */
function NightHero({ now }: { now: number }) {
  const { state, mode } = useLive();
  const [hh, mm] = JLM_HM.format(now).split(':');
  const working = state?.agents.filter((a) => a.status === 'working').length ?? 0;
  const crew = !state ? 'מתחבר למשרד…' : working === 0 ? 'כל הצוות במנוחה' : working === 1 ? 'סוכן אחד עובד עכשיו' : `${working} סוכנים עובדים עכשיו`;
  const run = !state ? null : state.guardrails.killSwitch ? 'מתג חירום פעיל' : state.guardrails.dryRun ? 'מצב יבש' : 'AI פעיל';
  return (
    <header className="hero">
      <div className="hero-greet">
        <p className="hero-title">{greeting(Number(JLM_HOUR.format(now)))}.</p>
        <p className="hero-sub">{crew}{run ? ` · ${run}` : ''}{mode === 'demo' ? ' · הדמיה' : ''}</p>
      </div>
      <time className="hero-clock" dateTime={`${hh}:${mm}`}>
        <span className="hero-time" dir="ltr">{hh}<i className="hero-colon">:</i>{mm}</span>
        <span className="hero-tz">ירושלים</span>
      </time>
    </header>
  );
}

/**
 * "Lights on": the first office view of a page load boots dark, then lamps switch on desk by desk.
 * It waits for live state, so the lamps light the real desks rather than placeholders under the loading overlay.
 */
let officeBooted = false;
function useBoot(ready: boolean, ms = 2600): boolean {
  const [boot, setBoot] = useState(() => !officeBooted);
  useEffect(() => {
    if (!boot || !ready) return;
    officeBooted = true;
    const t = setTimeout(() => setBoot(false), ms);
    return () => clearTimeout(t);
  }, [boot, ready, ms]);
  return boot && ready;
}

/* ------------------------------ stats row ------------------------------ */
export function StatsRow() {
  const { state } = useLive();
  if (!state) return null;
  const { guardrails: g, spend, model } = state;
  const dayRatio = spend.dayLimitUsd > 0 ? spend.dayUsd / spend.dayLimitUsd : 0;
  const spendTone: Tone = dayRatio >= 1 ? 'bad' : dayRatio >= g.softLimitRatio ? 'warn' : 'ok';
  const modelTone: Tone = model.status === 'verified' ? 'ok' : model.status === 'failed' || model.status === 'cli-missing' ? 'bad' : 'warn';
  return (
    <div className="stats" aria-label="מדדי מערכת">
      <div className="stat">
        <span className="stat-label">משימות AI רצות</span>
        <strong className="stat-val">{state.runningAiJobs}<small> / {g.maxConcurrentAiJobs}</small></strong>
        <span className="stat-sub">מקסימום במקביל</span>
      </div>
      <div className="stat">
        <span className="stat-label">הוצאה היום</span>
        <strong className={`stat-val tone-${spendTone}`}><bdi dir="ltr">{fmtUsd(spend.dayUsd)}</bdi><small> / <bdi dir="ltr">{fmtUsd(spend.dayLimitUsd)}</bdi></small></strong>
        <Bar value={spend.dayUsd} max={spend.dayLimitUsd} tone={spendTone} />
        <span className="stat-sub" title={spend.note}>בפועל, כפי שדווח · מגבלת אפליקציה</span>
      </div>
      <div className="stat">
        <span className="stat-label">מצב הרצה</span>
        {g.dryRun ? <strong className="stat-val tone-warn dry">מצב יבש – אין קריאות AI</strong> : <strong className="stat-val tone-ok">קריאות AI מופעלות</strong>}
        <span className="stat-sub">{g.dryRun ? 'DRY_RUN פעיל' : 'DRY_RUN כבוי · עלויות אמיתיות'}</span>
      </div>
      <div className="stat">
        <span className="stat-label">מתג חירום</span>
        <strong className={`stat-val ${g.killSwitch ? 'tone-bad' : 'tone-ok'}`}>{g.killSwitch ? 'פעיל – הכול נעצר' : 'כבוי'}</strong>
        <span className="stat-sub">{g.killSwitch ? 'לא יתחילו משימות חדשות' : 'המערכת פועלת כרגיל'}</span>
      </div>
      <div className="stat">
        <span className="stat-label">אימות מודל</span>
        <strong className={`stat-val tone-${modelTone}`}>{MODEL_STATUS_HE[model.status]}</strong>
        <span className="stat-sub"><bdi dir="ltr">{model.required}</bdi>{model.checkedAt ? ` · ${fmtTime(model.checkedAt)}` : ''}</span>
      </div>
    </div>
  );
}

/* -------------------------------- desk -------------------------------- */
function Desk({ id, agent, now, demo, onOpen }: { id: AgentId; agent?: AgentState; now: number; demo: boolean; onOpen: () => void }) {
  const status = agent?.status ?? 'idle';
  const working = status === 'working';
  const bubble = agent ? (agent.bubble && agent.bubble.trim() ? agent.bubble : IDLE_BUBBLE) : IDLE_BUBBLE;
  const isIdleBubble = bubble === IDLE_BUBBLE;
  const started = agent?.startedAt ? Date.parse(agent.startedAt) : NaN;
  const name = agent?.name ?? FALLBACK[id].name;
  const role = agent?.roleHe ?? FALLBACK[id].role;
  return (
    <button
      type="button"
      className={`desk desk-${status}`}
      data-agent={id}
      data-status={status}
      onClick={onOpen}
      aria-label={`${name}, ${role}. ${AGENT_STATUS_HE[status]}. ${bubble}. פתח פרטים`}
    >
      <span className={`bubble ${isIdleBubble ? 'bubble-idle' : ''}`} title={bubble}>
        <span className="bubble-text">{bubble}</span>
      </span>
      <DeskScene id={id} status={status} />
      <span className="desk-info">
        <span className="desk-name-row">
          <span className={`led led-${status}`} aria-hidden="true" />
          <span className="desk-name">{name}</span>
          {demo ? <span className="mini-demo">הדמיה</span> : null}
        </span>
        <span className="desk-role">{role || ' '}</span>
        <span className="desk-meta">
          <span className={`status-tag tone-${statusTone(status)}`}>{AGENT_STATUS_HE[status]}</span>
          {working && !Number.isNaN(started) ? <span className="elapsed" aria-label="זמן עבודה">⏱ <bdi dir="ltr">{fmtElapsed(now - started)}</bdi></span> : null}
        </span>
        <span className="desk-meta2">
          {agent?.toolCategory ? <Chip tone="info">{agent.toolCategory}</Chip> : null}
          <span className="last-evt">{agent?.lastEventAt ? `אירוע אחרון ${fmtTime(agent.lastEventAt)}` : 'אין אירועים'}</span>
        </span>
      </span>
    </button>
  );
}

/* ------------------------------ drawer ------------------------------ */
function AgentDrawer({ id, now, onClose }: { id: AgentId; now: number; onClose: () => void }) {
  const { state, events } = useLive();
  const agent = state?.agents.find((a) => a.id === id);
  const status = agent?.status ?? 'idle';
  const started = agent?.startedAt ? Date.parse(agent.startedAt) : NaN;
  const last5 = agent?.lastEvents.slice(0, 5) ?? [];
  const liveModel = events.slice().reverse().find((e) => e.agentId === id && e.modelId)?.modelId;
  const name = agent?.name ?? FALLBACK[id].name;
  return (
    <Modal label={`פרטי סוכן ${name}`} variant="drawer" onClose={onClose}>
      <div className="drawer">
        <div className="drawer-head">
          <Portrait id={id} status={status} />
          <button className="icon-btn drawer-close" onClick={onClose} aria-label="סגור" data-autofocus>✕</button>
        </div>
        <div className="drawer-body">
          <div className="drawer-title">
            <h2>{name}</h2>
            <Chip tone={statusTone(status)}>{AGENT_STATUS_HE[status]}</Chip>
          </div>
          <p className="muted">{agent?.roleHe}</p>

          {!agent ? <p className="muted">אין עדיין נתונים מהשרת על הסוכן.</p> : (
            <>
              <h3>משימה</h3>
              <p className="card-text">{agent.missionHe}</p>

              <h3>משימה נוכחית</h3>
              {agent.currentTaskTitle ? (
                <div className="kv-block">
                  <strong>{agent.currentTaskTitle}</strong>
                  {agent.bubble ? <p className="muted">{agent.bubble}</p> : null}
                </div>
              ) : <p className="muted">{IDLE_BUBBLE}</p>}

              {agent.blocker ? (<><h3>חסימה</h3><div className="callout callout-warn" role="note">{agent.blocker}</div></>) : (<><h3>חסימות</h3><p className="muted">אין חסימות מדווחות.</p></>)}

              <h3>5 האירועים האחרונים</h3>
              {last5.length ? (
                <ol className="evt-list">
                  {last5.map((e) => <EventRow key={e.eventId} e={e} showAgent={false} />)}
                </ol>
              ) : <p className="muted">אין אירועים.</p>}

              <h3>היסטוריית משימות</h3>
              {agent.history.length ? (
                <ul className="plain-list">
                  {agent.history.map((t) => (
                    <li key={t.id}>
                      <span className="grow">{t.title}</span>
                      <Chip tone={t.status === 'completed' ? 'ok' : t.status === 'failed' ? 'bad' : 'neutral'}>{TASK_STATUS_HE[t.status]}</Chip>
                      <span className="muted small">{fmtDateTime(t.finishedAt)} · <bdi dir="ltr">{fmtUsd(t.actualCostUsd)}</bdi></span>
                    </li>
                  ))}
                </ul>
              ) : <p className="muted">אין היסטוריה.</p>}

              <h3>מקורות מאומתים</h3>
              {agent.verifiedSources.length ? (
                <ul className="plain-list">
                  {agent.verifiedSources.map((s) => {
                    const href = safeUrl(s);
                    return <li key={s}>{href ? <a href={href} target="_blank" rel="noopener noreferrer" dir="ltr">{s}</a> : <span dir="ltr">{s}</span>}</li>;
                  })}
                </ul>
              ) : <p className="muted">אין מקורות מאומתים.</p>}

              <h3>זמן ריצה ומודל</h3>
              <dl className="kv">
                <dt>מודל מוגדר</dt><dd dir="ltr">{agent.model}</dd>
                <dt>מודל שנצפה באירועים</dt><dd dir="ltr">{liveModel ?? 'לא דווח'}</dd>
                <dt>סטטוס</dt><dd>{AGENT_STATUS_HE[agent.status]}</dd>
                <dt>התחיל</dt><dd>{fmtDateTime(agent.startedAt)}</dd>
                <dt>משך עבודה</dt><dd dir="ltr">{agent.status === 'working' && !Number.isNaN(started) ? fmtElapsed(now - started) : '—'}</dd>
                <dt>אירוע אחרון</dt><dd>{fmtDateTime(agent.lastEventAt)}</dd>
                <dt>קטגוריית כלי</dt><dd>{agent.toolCategory ?? '—'}</dd>
              </dl>
            </>
          )}
        </div>
      </div>
    </Modal>
  );
}

export function EventRow({ e, showAgent = true }: { e: PublicEvent; showAgent?: boolean }) {
  return (
    <li className={`evt ${e.isDemo ? 'evt-demo' : ''}`}>
      <time className="evt-time" dateTime={e.occurredAt}>{fmtTime(e.occurredAt)}</time>
      <div className="evt-main">
        <div className="evt-head">
          {showAgent ? <strong className="evt-agent">{agentName(e.agentId)}</strong> : null}
          <span className={`evt-type evt-${e.type}`}>{EVENT_TYPE_HE[e.type] ?? e.type}</span>
          {e.isDemo ? <Chip tone="demo">DEMO · הדמיה</Chip> : null}
          {e.toolCategory ? <Chip tone="info">{e.toolCategory}</Chip> : null}
          {typeof e.actualCostUsd === 'number' ? <span className="muted small"><bdi dir="ltr">{fmtUsd(e.actualCostUsd)}</bdi></span> : null}
        </div>
        <div className="evt-text">{e.publicSummary}</div>
      </div>
    </li>
  );
}

/* ------------------------------ office view ------------------------------ */
export function OfficeView() {
  const { state, stateError, events, mode } = useLive();
  const now = useNow();
  const [open, setOpen] = useState<AgentId | null>(null);
  const boot = useBoot(!!state);

  if (!state && stateError) return <ErrorState message={stateError} />;

  const feed = events.filter((e) => e.type !== 'heartbeat').slice(-14).reverse();
  const byId = new Map(state?.agents.map((a) => [a.id, a] as const));
  return (
    <div className="view view-office">
      {state && stateError ? <div className="callout callout-warn" role="alert">הרענון האחרון נכשל ({stateError}) · מוצגים נתונים אחרונים שהתקבלו.</div> : null}
      <NightHero now={now} />
      <StatsRow />
      {state && state.pendingApprovals.length > 0 ? (
        <a className="callout callout-info approvals-link" href="#/missions">
          {state.pendingApprovals.length} אישורים ממתינים לך · פתח משימות
        </a>
      ) : null}

      <section className={`office${boot ? ' boot' : ''}`} aria-label="המשרד החי">
        <div className="office-wall" aria-hidden="true">
          <div className="window">
            <span className="moon" />
            <span className="sky">{[1, 2, 3, 4, 5, 6].map((n) => <span key={n} className={`star s${n}`} />)}</span>
          </div>
          <div className="sconce" />
          <div className="wall-sign">MONO&nbsp;HQ</div>
          <div className="plant"><span /><span /><span /></div>
        </div>
        <div className="floor">
          <div className="desks">
            {AGENT_IDS.map((id) => (
              <Desk key={id} id={id} agent={byId.get(id)} now={now} demo={mode === 'demo'} onOpen={() => setOpen(id)} />
            ))}
          </div>
          {!state ? <div className="floor-loading"><Loading label="טוען את המשרד…" /></div> : null}
        </div>
        <div className="office-legend" aria-hidden="true">
          <span><i className="led led-working" /> עובד</span>
          <span><i className="led led-idle" /> ממתין</span>
          <span><i className="led led-awaiting_input" /> דורש מענה</span>
          <span><i className="led led-blocked" /> חסום</span>
          <span><i className="led led-failed" /> נכשל</span>
        </div>
      </section>

      <section className="section" aria-labelledby="feed-h">
        <div className="section-head">
          <h2 id="feed-h">יומן פעילות חי</h2>
          <span className="muted small">רק אירועים שהתקבלו מהשרת</span>
        </div>
        {feed.length ? <ol className="evt-list evt-feed">{feed.map((e) => <EventRow key={e.seq} e={e} />)}</ol>
          : <EmptyState title="אין אירועים עדיין">{mode === 'demo' ? 'הפעל את ההדמיה כדי לראות אירועים מסומנים DEMO.' : 'כשסוכן יתחיל לעבוד, האירוע יופיע כאן. לא מוצגת פעילות מומצאת.'}</EmptyState>}
      </section>

      {open ? <AgentDrawer id={open} now={now} onClose={() => setOpen(null)} /> : null}
    </div>
  );
}
