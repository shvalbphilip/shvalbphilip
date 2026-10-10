import { useState } from 'react';
import { AGENT_IDS, type Approval, type AgentId, type Task, type TaskStatus } from '../../shared/contract.ts';
import { api } from './api.ts';
import { agentName } from './Office.tsx';
import { ORIGIN_HE, TASK_STATUS_HE, fmtDateTime, fmtUsd } from './format.ts';
import { useLive, useResource } from './live.tsx';
import { Chip, EmptyState, ErrorState, Loading, Section, useConfirm, useRunner, type Tone } from './ui.tsx';

const taskTone = (s: TaskStatus): Tone =>
  s === 'completed' ? 'ok' : s === 'failed' ? 'bad' : s === 'running' ? 'info' : s === 'cancelled' ? 'neutral' : 'warn';

const STEP_HE: Record<string, string> = {
  pending: 'ממתין', running: 'רץ', completed: 'הושלם', failed: 'נכשל', skipped: 'דולג', cancelled: 'בוטל',
};

type Action = 'pause' | 'resume' | 'cancel' | 'retry';
const canDo = (s: TaskStatus): Action[] => {
  switch (s) {
    case 'queued': return ['pause', 'cancel'];
    case 'running': return ['pause', 'cancel'];
    case 'paused': return ['resume', 'cancel'];
    case 'awaiting_input':
    case 'awaiting_approval': return ['cancel'];
    case 'failed':
    case 'cancelled': return ['retry'];
    default: return [];
  }
};
const ACTION_HE: Record<Action, string> = { pause: 'השהה', resume: 'המשך', cancel: 'בטל', retry: 'נסה שוב' };

export function MissionsView() {
  const { mode, state, tick, refresh } = useLive();
  const tasks = useResource<Task[]>('/api/tasks', mode, tick);
  const { busy, run } = useRunner();
  const [confirm, confirmEl] = useConfirm();
  const [filter, setFilter] = useState<'all' | 'open' | 'done'>('all');

  const approvals = state?.pendingApprovals ?? [];

  const doAction = async (t: Task, a: Action) => {
    if (a === 'cancel' || a === 'retry') {
      const ok = await confirm({
        title: `${ACTION_HE[a]} משימה`,
        body: <p>{a === 'cancel' ? `לבטל את "${t.title}"? פעולה זו אינה הפיכה.` : `להריץ שוב את "${t.title}"? ${state?.guardrails.dryRun ? 'מצב יבש פעיל: לא תתבצע קריאת AI.' : 'ייתכן שתיווצר עלות AI.'}`}</p>,
        confirmLabel: ACTION_HE[a], danger: a === 'cancel',
      });
      if (!ok) return;
    }
    const done = await run(`${t.id}:${a}`, () => api('POST', `/api/tasks/${encodeURIComponent(t.id)}/${a}`, { mode, body: {} }), 'הפעולה בוצעה');
    if (done) { void tasks.reload(); refresh(); }
  };

  const decide = async (ap: Approval, verdict: 'approve' | 'reject') => {
    const ok = await confirm({
      title: verdict === 'approve' ? 'אישור פעולה' : 'דחיית פעולה',
      body: (<><p><strong>{ap.titleHe}</strong></p><p>{ap.detailHe}</p><p className="muted">עלות משוערת: <bdi dir="ltr">{fmtUsd(ap.estimatedCostUsd)}</bdi></p></>),
      confirmLabel: verdict === 'approve' ? 'אשר' : 'דחה', danger: verdict === 'reject',
    });
    if (!ok) return;
    const done = await run(`${ap.id}:${verdict}`, () => api('POST', `/api/approvals/${encodeURIComponent(ap.id)}/${verdict}`, { mode, body: {} }), verdict === 'approve' ? 'האישור נשמר' : 'הבקשה נדחתה');
    if (done) { void tasks.reload(); refresh(); }
  };

  const list = (tasks.data ?? []).filter((t) =>
    filter === 'all' ? true : filter === 'open' ? !['completed', 'failed', 'cancelled'].includes(t.status) : ['completed', 'failed', 'cancelled'].includes(t.status));

  return (
    <div className="view">
      {confirmEl}
      <Section title="אישורים ממתינים" id="appr-h" aside={<Chip tone={approvals.length ? 'warn' : 'neutral'}>{approvals.length}</Chip>}>
        {approvals.length ? (
          <ul className="card-list">
            {approvals.map((ap) => (
              <li key={ap.id} className="card card-attn">
                <div className="card-head"><strong>{ap.titleHe}</strong><Chip tone="warn">ממתין לאישור</Chip></div>
                <p className="card-text">{ap.detailHe}</p>
                <div className="card-meta">
                  <span>עלות משוערת <bdi dir="ltr">{fmtUsd(ap.estimatedCostUsd)}</bdi></span>
                  <span>נוצר {fmtDateTime(ap.createdAt)}</span>
                </div>
                <div className="actions">
                  <button className="btn btn-primary" disabled={busy !== null} onClick={() => decide(ap, 'approve')}>אשר</button>
                  <button className="btn btn-danger-ghost" disabled={busy !== null} onClick={() => decide(ap, 'reject')}>דחה</button>
                </div>
              </li>
            ))}
          </ul>
        ) : <p className="muted">אין אישורים שממתינים להחלטתך.</p>}
      </Section>

      <NewTask onCreated={() => { void tasks.reload(); refresh(); }} />

      <Section title="משימות" id="tasks-h" aside={
        <div className="seg" role="group" aria-label="סינון משימות">
          {(['all', 'open', 'done'] as const).map((f) => (
            <button key={f} aria-pressed={filter === f} onClick={() => setFilter(f)}>{f === 'all' ? 'הכול' : f === 'open' ? 'פתוחות' : 'הסתיימו'}</button>
          ))}
        </div>}>
        {tasks.loading && !tasks.data ? <Loading /> : tasks.error && !tasks.data ? <ErrorState message={tasks.error} onRetry={tasks.retry} /> : list.length === 0 ? (
          <EmptyState title="אין משימות להצגה">{mode === 'demo' ? 'הפעל הדמיה כדי לראות משימות מסומנות DEMO.' : 'צור משימה למעלה, או המתן לאוטומציה מתוזמנת.'}</EmptyState>
        ) : (
          <ul className="card-list">
            {list.map((t) => (
              <li key={t.id} className="card">
                <div className="card-head">
                  <strong>{t.title}</strong>
                  <Chip tone={taskTone(t.status)}>{TASK_STATUS_HE[t.status]}</Chip>
                </div>
                <div className="chips">
                  {t.isDemo ? <Chip tone="demo">DEMO · הדמיה</Chip> : null}
                  {t.dryRun ? <Chip tone="warn">מצב יבש</Chip> : null}
                  <Chip>אחראי: {agentName(t.leadAgent)}</Chip>
                  <Chip>{ORIGIN_HE[t.origin] ?? t.origin}</Chip>
                  <Chip>{t.kind}</Chip>
                  {t.attempts > 1 ? <Chip>ניסיון {t.attempts}</Chip> : null}
                </div>
                {t.blocker ? <div className="callout callout-warn" role="note">{t.blocker}</div> : null}
                {t.resultSummary ? <p className="card-text">{t.resultSummary}</p> : null}
                <div className="card-meta">
                  <span>נוצר {fmtDateTime(t.createdAt)}</span>
                  {t.finishedAt ? <span>הסתיים {fmtDateTime(t.finishedAt)}</span> : null}
                  <span>עלות: <bdi dir="ltr">{fmtUsd(t.actualCostUsd)}</bdi> (משוער <bdi dir="ltr">{fmtUsd(t.estimatedCostUsd)}</bdi>)</span>
                </div>
                {t.steps.length ? (
                  <details className="steps">
                    <summary>שלבים ({t.steps.filter((s) => s.status === 'completed').length}/{t.steps.length})</summary>
                    <ol>
                      {t.steps.map((s) => (
                        <li key={s.idx} className={`step step-${s.status}`}>
                          <span className="step-dot" aria-hidden="true" />
                          <span className="grow">{s.title} <span className="muted small">· {agentName(s.agentId)} · {s.kind === 'ai' ? 'AI' : 'מקומי'}</span></span>
                          <span className="small">{STEP_HE[s.status] ?? s.status}</span>
                        </li>
                      ))}
                    </ol>
                  </details>
                ) : null}
                {t.reportId ? <a className="btn btn-sm" href="#/reports">לדוח</a> : null}
                {canDo(t.status).length ? (
                  <div className="actions">
                    {canDo(t.status).map((a) => (
                      <button key={a} className={`btn btn-sm ${a === 'cancel' ? 'btn-danger-ghost' : ''}`} disabled={busy !== null} onClick={() => doAction(t, a)}>
                        {busy === `${t.id}:${a}` ? '…' : ACTION_HE[a]}
                      </button>
                    ))}
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </Section>
    </div>
  );
}

function NewTask({ onCreated }: { onCreated: () => void }) {
  const { mode, state } = useLive();
  const { busy, run } = useRunner();
  const [title, setTitle] = useState('');
  const [prompt, setPrompt] = useState('');
  const [lead, setLead] = useState<'' | AgentId>('');
  const demo = mode === 'demo';
  const valid = title.trim().length > 0 && prompt.trim().length > 0;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!valid || demo) return;
    const body: { title: string; prompt: string; leadAgent?: AgentId } = { title: title.trim(), prompt: prompt.trim() };
    if (lead) body.leadAgent = lead;
    const ok = await run('create', () => api('POST', '/api/tasks', { mode, body }), 'המשימה נוצרה');
    if (ok) { setTitle(''); setPrompt(''); setLead(''); onCreated(); }
  };

  return (
    <Section title="משימה חדשה" id="new-h">
      <form className="card form" onSubmit={submit}>
        {demo ? <div className="callout callout-demo">במצב הדמיה לא יוצרים משימות. עבור למצב אמיתי כדי להוסיף משימה.</div> : null}
        {state?.guardrails.dryRun ? <div className="callout callout-warn">מצב יבש פעיל: המשימה תירשם אך לא תתבצע קריאת AI.</div> : null}
        <label className="field"><span>כותרת</span>
          <input value={title} maxLength={120} onChange={(e) => setTitle(e.target.value)} disabled={demo} required placeholder="למשל: איפה הכסף שלי הולך החודש?" />
        </label>
        <label className="field"><span>הנחיה לסוכן</span>
          <textarea value={prompt} rows={3} maxLength={4000} onChange={(e) => setPrompt(e.target.value)} disabled={demo} required placeholder="מה בדיוק לבדוק? ללא סיסמאות או פרטי כרטיס." />
        </label>
        <label className="field"><span>סוכן מוביל (לא חובה)</span>
          <select value={lead} onChange={(e) => setLead(e.target.value as '' | AgentId)} disabled={demo}>
            <option value="">אוטומטי</option>
            {AGENT_IDS.map((id) => <option key={id} value={id}>{agentName(id)}</option>)}
          </select>
        </label>
        <div className="actions"><button className="btn btn-primary" type="submit" disabled={!valid || demo || busy !== null}>{busy === 'create' ? 'יוצר…' : 'צור משימה'}</button></div>
      </form>
    </Section>
  );
}
