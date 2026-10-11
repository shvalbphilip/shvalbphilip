import { useState } from 'react';
import type { Automation } from '../../shared/contract.ts';
import { api } from './api.ts';
import { TASK_STATUS_HE, fmtDateTime, fmtUsd } from './format.ts';
import { useLive, useResource } from './live.tsx';
import { Chip, EmptyState, ErrorState, Loading, useConfirm, useRunner, type Tone } from './ui.tsx';

function lastStatusChip(a: Automation) {
  if (!a.lastStatus) return <Chip>טרם רץ</Chip>;
  if (a.lastStatus === 'waiting_for_connection') return <Chip tone="warn">ממתין לחיבור</Chip>;
  const tone: Tone = a.lastStatus === 'completed' ? 'ok' : a.lastStatus === 'failed' ? 'bad' : 'neutral';
  return <Chip tone={tone}>{TASK_STATUS_HE[a.lastStatus]}</Chip>;
}

export function AutomationsView() {
  const { mode, state, tick, refresh } = useLive();
  const res = useResource<Automation[]>('/api/automations', mode, tick);
  const { busy, run } = useRunner();
  const [confirm, confirmEl] = useConfirm();
  const [openId, setOpenId] = useState<string | null>(null);

  const act = async (a: Automation, action: 'enable' | 'disable' | 'run-now') => {
    const dry = state?.guardrails.dryRun;
    const ok = await confirm(
      action === 'enable'
        ? {
            title: `הפעלת אוטומציה: ${a.nameHe}`,
            body: (
              <>
                <p><strong>הפעלה דורשת אישור מפורש שלך.</strong> לאחר האישור האוטומציה תרוץ לפי לוח הזמנים ({a.schedule}) ותיצור משימות.</p>
                {a.timeStatus === 'draft-awaiting-confirmation' ? <p className="callout callout-warn">שעת ההרצה היא טיוטה ועדיין לא אושרה.</p> : null}
                {a.requiresAi ? <p>{dry ? 'מצב יבש פעיל: לא יתבצעו קריאות AI.' : `ייתכנו קריאות AI בעלות עד ${fmtUsd(a.maxModelCostUsd)} להרצה.`}</p> : null}
              </>
            ),
            confirmLabel: 'אני מאשר/ת, הפעל',
          }
        : action === 'disable'
          ? { title: `כיבוי אוטומציה: ${a.nameHe}`, body: <p>האוטומציה לא תרוץ יותר עד שתופעל מחדש באישורך.</p>, confirmLabel: 'כבה', danger: true }
          : {
              title: `הרצה עכשיו: ${a.nameHe}`,
              body: <p>תיווצר משימה מיד. {a.requiresAi ? (dry ? 'מצב יבש פעיל: ללא קריאת AI.' : `עלות מקסימלית להרצה: ${fmtUsd(a.maxModelCostUsd)}.`) : 'המשימה מקומית וללא עלות AI.'}</p>,
              confirmLabel: 'הרץ עכשיו',
            },
    );
    if (!ok) return;
    const done = await run(`${a.id}:${action}`, () => api('POST', `/api/automations/${encodeURIComponent(a.id)}/${action}`, { mode, body: { confirm: true } }),
      action === 'enable' ? 'האוטומציה הופעלה' : action === 'disable' ? 'האוטומציה כובתה' : 'המשימה נוצרה');
    if (done) { void res.reload(); refresh(); }
  };

  return (
    <div className="view">
      {confirmEl}
      <p className="lead">אוטומציות מתוזמנות מוגבלות בזמן, בעלות ובניסיונות. הפעלה תמיד דורשת אישור שלך; אין לולאה אינסופית.</p>
      {res.loading && !res.data ? <Loading /> : res.error && !res.data ? <ErrorState message={res.error} onRetry={res.retry} /> : !res.data || res.data.length === 0 ? (
        <EmptyState title="אין אוטומציות מוגדרות" />
      ) : (
        <ul className="card-list cols-2">
          {res.data.map((a) => (
            <li key={a.id} className={`card ${a.enabled ? 'card-on' : ''}`}>
              <div className="card-head">
                <strong>{a.nameHe}</strong>
                <Chip tone={a.enabled ? 'ok' : 'neutral'}>{a.enabled ? 'מופעלת' : 'כבויה'}</Chip>
              </div>
              <p className="card-text">{a.descriptionHe}</p>
              <div className="chips">
                <Chip tone="info">{a.trigger === 'cron' ? 'מתוזמנת' : 'לפי אירוע'}</Chip>
                <Chip>{a.schedule}</Chip>
                {a.timeStatus === 'draft-awaiting-confirmation' ? <Chip tone="warn" title="השעה טרם אושרה על ידך">טיוטה · ממתין לאישור שעה</Chip> : <Chip tone="ok">שעה מאושרת</Chip>}
                {a.requiresAi ? <Chip tone="info">AI · עד <bdi dir="ltr">{fmtUsd(a.maxModelCostUsd)}</bdi></Chip> : <Chip>מקומית</Chip>}
                {lastStatusChip(a)}
              </div>
              {a.waitingFor ? <div className="callout callout-warn" role="note"><strong>ממתין ל:</strong> {a.waitingFor}</div> : null}
              <dl className="kv kv-2">
                <dt>הרצה הבאה</dt><dd>{a.nextRunAt ? fmtDateTime(a.nextRunAt) : a.trigger === 'event' ? 'לפי אירוע' : '—'}</dd>
                <dt>הרצה אחרונה</dt><dd>{fmtDateTime(a.lastRunAt)}</dd>
                <dt>הצלחה אחרונה</dt><dd>{fmtDateTime(a.lastSuccessAt)}</dd>
                <dt>אומת לאחרונה</dt><dd>{fmtDateTime(a.lastVerifiedAt)}</dd>
              </dl>
              <button className="link-btn" aria-expanded={openId === a.id} onClick={() => setOpenId(openId === a.id ? null : a.id)}>
                {openId === a.id ? 'הסתר מגבלות' : 'מגבלות ומקורות'}
              </button>
              {openId === a.id ? (
                <dl className="kv kv-2">
                  <dt>משך מקסימלי</dt><dd>{a.maxDurationMinutes} דקות</dd>
                  <dt>ניסיונות</dt><dd>עד {a.maxAttempts}</dd>
                  <dt>מדיניות אישור</dt><dd>{a.approvalPolicy}</dd>
                  <dt>מקורות נדרשים</dt><dd>{a.requiredSources.length ? a.requiredSources.join(' · ') : '—'}</dd>
                </dl>
              ) : null}
              <div className="actions">
                {a.enabled
                  ? <button className="btn btn-sm btn-danger-ghost" disabled={busy !== null || mode === 'demo'} onClick={() => act(a, 'disable')}>{busy === `${a.id}:disable` ? '…' : 'כבה'}</button>
                  : <button className="btn btn-sm btn-primary" disabled={busy !== null || mode === 'demo'} onClick={() => act(a, 'enable')}>{busy === `${a.id}:enable` ? '…' : 'הפעל (דורש אישור)'}</button>}
                <button className="btn btn-sm" disabled={busy !== null || mode === 'demo'} onClick={() => act(a, 'run-now')}>{busy === `${a.id}:run-now` ? '…' : 'הרץ עכשיו'}</button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
