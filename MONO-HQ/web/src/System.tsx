import { useEffect, useRef, useState, type MutableRefObject } from 'react';
import type { Guardrails, SystemView } from '../../shared/contract.ts';
import { api } from './api.ts';
import { MODEL_STATUS_HE, fmtDateTime, fmtUsd } from './format.ts';
import { useLive, useResource } from './live.tsx';
import { Bar, Chip, ErrorState, Icon, Loading, Section, useConfirm, useRunner, type Tone } from './ui.tsx';

/**
 * Step-up field: when MONO_ACCESS_TOKEN is set, releasing the kill switch, turning DRY_RUN off and raising cost
 * ceilings must re-present the token. Uncontrolled on purpose: the value lives only in a ref for the one request.
 */
function StepUpField({ draft }: { draft: MutableRefObject<string> }) {
  return (
    <label className="field">
      <span>אסימון גישה (נדרש לפעולה זו)</span>
      <input type="password" dir="ltr" autoComplete="off" data-autofocus onChange={(e) => { draft.current = e.target.value; }} />
      <em className="field-hint">הזן שוב את MONO_ACCESS_TOKEN. הוא נשלח רק לבקשה הזו ולא נשמר בדפדפן.</em>
    </label>
  );
}
/** Reads the step-up draft for one request and clears it. */
const takeToken = (draft: MutableRefObject<string>): string | undefined => { const t = draft.current.trim(); draft.current = ''; return t || undefined; };

/** Prominent kill switch with confirm dialog. Used in the header and on the System page. */
export function KillSwitch({ compact = false }: { compact?: boolean }) {
  const { mode, state, refresh } = useLive();
  const { busy, run } = useRunner();
  const [confirm, el] = useConfirm();
  const draft = useRef('');
  const on = state?.guardrails.killSwitch ?? false;
  const stepUp = on && (state?.authRequired ?? false);
  const click = async () => {
    draft.current = '';
    const ok = await confirm(
      on
        ? { title: 'שחרור מתג החירום', body: <><p>המערכת תחזור לקבל ולהריץ משימות. להמשיך?</p>{stepUp ? <StepUpField draft={draft} /> : null}</>, confirmLabel: 'שחרר' }
        : { title: 'הפעלת מתג חירום', body: <p><strong>כל המשימות הפעילות יעצרו ולא יתחילו משימות חדשות</strong> עד ששחרור יאושר ידנית. להפעיל?</p>, confirmLabel: 'עצור הכול', danger: true },
    );
    const token = takeToken(draft);
    if (!ok) return;
    if (await run('kill', () => api('POST', '/api/system/kill-switch', { mode, body: { on: !on, ...(stepUp ? { token } : {}) } }), on ? 'מתג החירום שוחרר' : 'מתג החירום הופעל')) refresh();
  };
  return (
    <>
      {el}
      <button type="button" className={`kill ${on ? 'kill-on' : ''} ${compact ? 'kill-compact' : ''}`} onClick={click}
        disabled={!state || busy !== null || (on && mode === 'demo')} aria-pressed={on} title={on ? 'מתג החירום פעיל · לחץ לשחרור' : 'עצירת חירום של כל הסוכנים'}>
        <Icon name="power" size={18} />
        <span>{on ? 'חירום פעיל · שחרר' : 'מתג חירום'}</span>
      </button>
    </>
  );
}

const NUM_FIELDS: Array<{ key: keyof Omit<Guardrails, 'dryRun' | 'killSwitch'>; label: string; step: string; min: number; max?: number; int?: boolean; hint?: string }> = [
  { key: 'maxConcurrentAiJobs', label: 'משימות AI במקביל', step: '1', min: 1, max: 10, int: true },
  { key: 'maxDailyCostUsd', label: 'תקרה יומית ($)', step: '0.01', min: 0 },
  { key: 'maxMonthlyCostUsd', label: 'תקרה חודשית ($)', step: '0.01', min: 0 },
  { key: 'maxJobMinutes', label: 'משך משימה מקסימלי (דקות)', step: '1', min: 1, max: 240, int: true },
  { key: 'maxRetries', label: 'ניסיונות חוזרים', step: '1', min: 0, max: 5, int: true },
  { key: 'softLimitRatio', label: 'סף אזהרה (0–1)', step: '0.05', min: 0.05, max: 1, hint: 'אזהרה כשהשימוש מגיע לשבר הזה מהתקרה' },
];

export function SystemViewPage() {
  const { mode, tick, refresh } = useLive();
  const res = useResource<SystemView>('/api/system', mode, tick);
  const { busy, run } = useRunner();
  const [confirm, confirmEl] = useConfirm();
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [dirty, setDirty] = useState(false);
  const tokenDraft = useRef('');

  const g = res.data?.guardrails;
  useEffect(() => {
    if (g && !dirty) setDraft(Object.fromEntries(NUM_FIELDS.map((f) => [f.key, String(g[f.key])])));
  }, [g, dirty]);

  if (res.loading && !res.data) return <div className="view"><Loading /></div>;
  if (res.error && !res.data) return <div className="view"><ErrorState message={res.error} onRetry={res.retry} /></div>;
  const s = res.data;
  if (!s || !g) return null;

  const errors: Record<string, string> = {};
  const parsed: Partial<Guardrails> = {};
  for (const f of NUM_FIELDS) {
    const raw = draft[f.key] ?? '';
    const n = Number(raw);
    if (raw.trim() === '' || Number.isNaN(n)) errors[f.key] = 'מספר נדרש';
    else if (n < f.min || (f.max !== undefined && n > f.max)) errors[f.key] = `טווח ${f.min}–${f.max ?? '∞'}`;
    else if (f.int && !Number.isInteger(n)) errors[f.key] = 'מספר שלם';
    else if (n !== g[f.key]) (parsed as Record<string, number>)[f.key] = n;
  }
  if ((parsed.maxDailyCostUsd ?? g.maxDailyCostUsd) > (parsed.maxMonthlyCostUsd ?? g.maxMonthlyCostUsd)) errors.maxDailyCostUsd = 'התקרה היומית גבוהה מהחודשית';
  const canSave = Object.keys(errors).length === 0 && Object.keys(parsed).length > 0;

  // Raising a cost/concurrency ceiling is a step-up action when a token is configured; lowering never is.
  const raising = (['maxDailyCostUsd', 'maxMonthlyCostUsd', 'maxConcurrentAiJobs'] as const).some((k) => parsed[k] !== undefined && parsed[k]! > g[k]);
  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSave) return;
    let token: string | undefined;
    if (raising && s.authRequired) {
      tokenDraft.current = '';
      const ok = await confirm({ title: 'העלאת תקרה', body: <><p>העלאת תקרת עלות או מקבילות מאפשרת הוצאה גבוהה יותר.</p><StepUpField draft={tokenDraft} /></>, confirmLabel: 'שמור מגבלות' });
      token = takeToken(tokenDraft);
      if (!ok) return;
    }
    if (await run('limits', () => api('POST', '/api/system/limits', { mode, body: { ...parsed, ...(token ? { token } : {}) } }), 'המגבלות נשמרו')) {
      setDirty(false);
      void res.reload();
      refresh();
    }
  };
  const toggleDry = async () => {
    const turningOff = g.dryRun;
    const stepUp = turningOff && s.authRequired;
    tokenDraft.current = '';
    const ok = await confirm(
      turningOff
        ? { title: 'כיבוי מצב יבש', body: (<><p><strong>הסוכנים יתחילו לבצע קריאות AI אמיתיות</strong> ויצרכו עלות בהתאם למגבלות שהוגדרו.</p><p className="muted">המגבלות הן הגדרות אפליקציה ואינן מגבלות חיוב של Anthropic.</p>{stepUp ? <StepUpField draft={tokenDraft} /> : null}</>), confirmLabel: 'כבה מצב יבש', danger: true }
        : { title: 'הפעלת מצב יבש', body: <p>לא יבוצעו קריאות AI. משימות יירשמו בלבד.</p>, confirmLabel: 'הפעל מצב יבש' },
    );
    const token = takeToken(tokenDraft);
    if (!ok) return;
    if (await run('dry', () => api('POST', '/api/system/dry-run', { mode, body: { on: !g.dryRun, confirm: true, ...(stepUp ? { token } : {}) } }), 'מצב הריצה עודכן')) { void res.reload(); refresh(); }
  };
  const logout = async () => {
    if (await run('logout', () => api('POST', '/api/logout', { body: {} }), 'התנתקת')) location.reload();
  };
  const revokeAll = async () => {
    const ok = await confirm({ title: 'ניתוק כל המכשירים', body: <p>כל ההתחברויות הפעילות (כולל זו) יבוטלו ויידרש אסימון מחדש בכל מכשיר.</p>, confirmLabel: 'נתק הכול', danger: true });
    if (!ok) return;
    if (await run('revoke', () => api('POST', '/api/sessions/revoke-all', { body: {} }), 'כל ההתחברויות בוטלו')) location.reload();
  };
  const verify = async () => {
    if (await run('verify', () => api('POST', '/api/system/verify-model', { mode, body: {} }), 'האימות הסתיים')) { void res.reload(); refresh(); }
  };

  const m = s.model;
  const modelTone: Tone = m.status === 'verified' ? 'ok' : m.status === 'failed' || m.status === 'cli-missing' ? 'bad' : 'warn';
  const loopback = /^(127\.|localhost|\[?::1\]?)/.test(s.bindAddress);
  const audit = [...s.auditLog].sort((a, b) => Date.parse(b.at) - Date.parse(a.at)).slice(0, 100);
  const ratioTone = (v: number, lim: number): Tone => (lim > 0 && v / lim >= 1 ? 'bad' : lim > 0 && v / lim >= g.softLimitRatio ? 'warn' : 'ok');

  return (
    <div className="view">
      {confirmEl}
      <Section title="בטיחות והרצה" id="safe-h">
        <div className="card cols-2 inner-cols">
          <div>
            <div className="card-head"><strong>מצב יבש (DRY_RUN)</strong><Chip tone={g.dryRun ? 'warn' : 'ok'}>{g.dryRun ? 'פעיל · אין קריאות AI' : 'כבוי'}</Chip></div>
            <p className="muted">כשהוא פעיל לא מתבצעות קריאות AI ולא נוצרת עלות.</p>
            <button className="btn" onClick={toggleDry} disabled={busy !== null || mode === 'demo'}>{g.dryRun ? 'כבה מצב יבש…' : 'הפעל מצב יבש'}</button>
          </div>
          <div>
            <div className="card-head"><strong>מתג חירום</strong><Chip tone={g.killSwitch ? 'bad' : 'ok'}>{g.killSwitch ? 'פעיל' : 'כבוי'}</Chip></div>
            <p className="muted">עוצר את כל הסוכנים ומונע משימות חדשות.</p>
            <KillSwitch />
          </div>
        </div>
      </Section>

      <Section title="הוצאות" id="spend-h">
        <div className="card">
          <div className="spend-grid">
            <div><span className="stat-label">היום</span><strong className="big"><bdi dir="ltr">{fmtUsd(s.spend.dayUsd)}</bdi><small> / <bdi dir="ltr">{fmtUsd(s.spend.dayLimitUsd)}</bdi></small></strong>
              <Bar value={s.spend.dayUsd} max={s.spend.dayLimitUsd} tone={ratioTone(s.spend.dayUsd, s.spend.dayLimitUsd)} /></div>
            <div><span className="stat-label">החודש</span><strong className="big"><bdi dir="ltr">{fmtUsd(s.spend.monthUsd)}</bdi><small> / <bdi dir="ltr">{fmtUsd(s.spend.monthLimitUsd)}</bdi></small></strong>
              <Bar value={s.spend.monthUsd} max={s.spend.monthLimitUsd} tone={ratioTone(s.spend.monthUsd, s.spend.monthLimitUsd)} /></div>
          </div>
          <p className="muted small">{s.spend.note}</p>
        </div>
      </Section>

      <Section title="מגבלות (Guardrails)" id="lim-h">
        <form className="card form" onSubmit={save}>
          <div className="form-grid">
            {NUM_FIELDS.map((f) => (
              <label className="field" key={f.key}>
                <span>{f.label}</span>
                <input type="number" inputMode="decimal" dir="ltr" step={f.step} min={f.min} max={f.max} value={draft[f.key] ?? ''}
                  aria-invalid={errors[f.key] ? true : undefined} onChange={(e) => { setDraft({ ...draft, [f.key]: e.target.value }); setDirty(true); }} />
                {errors[f.key] ? <em className="field-err">{errors[f.key]}</em> : f.hint ? <em className="field-hint">{f.hint}</em> : null}
              </label>
            ))}
          </div>
          <p className="muted small">אלו הגדרות של האפליקציה ואינן מגבלות חיוב של Anthropic.</p>
          <div className="actions">
            <button className="btn btn-primary" type="submit" disabled={!canSave || busy !== null || mode === 'demo'}>{busy === 'limits' ? 'שומר…' : 'שמור מגבלות'}</button>
            {dirty ? <button className="btn" type="button" onClick={() => setDirty(false)}>אפס</button> : null}
          </div>
        </form>
      </Section>

      <Section title="אימות מודל" id="model-h" aside={<button className="btn btn-sm" onClick={verify} disabled={busy !== null || g.dryRun || mode === 'demo'} title={g.dryRun ? 'במצב יבש האימות מדולג' : undefined}>{busy === 'verify' ? 'בודק…' : 'אמת עכשיו'}</button>}>
        <div className="card">
          <div className="card-head"><strong dir="ltr">{m.required}</strong><Chip tone={modelTone}>{MODEL_STATUS_HE[m.status]}</Chip></div>
          <p className="card-text">{m.detail}</p>
          <dl className="kv kv-2">
            <dt>נבדק</dt><dd>{fmtDateTime(m.checkedAt)}</dd>
            <dt>גרסת CLI</dt><dd dir="ltr">{m.cliVersion ?? '—'}</dd>
            <dt>מודלים שנצפו</dt><dd dir="ltr">{m.observedModels.length ? m.observedModels.join(', ') : 'לא נצפו'}</dd>
          </dl>
          {g.dryRun ? <p className="muted small">מצב יבש פעיל: אימות אמיתי מחייב קריאת AI ולכן מדולג.</p> : null}
        </div>
      </Section>

      <div className="two-col">
        <Section title="הרשאות" id="perm-h">
          <ul className="card-list">
            {s.permissions.map((p) => (
              <li key={p.scope} className="card row-card"><div className="grow"><strong dir="ltr">{p.scope}</strong><div className="muted small">{p.noteHe}</div></div><Chip tone={p.granted ? 'ok' : 'neutral'}>{p.granted ? 'ניתנה' : 'לא ניתנה'}</Chip></li>
            ))}
          </ul>
        </Section>
        <Section title="מקורות נתונים (Provenance)" id="prov-h">
          <ul className="card-list">
            {s.provenance.map((p) => (
              <li key={p.source} className="card row-card"><div className="grow"><strong>{p.source}</strong><div className="muted small">{p.noteHe}</div></div>
                <Chip tone={p.status === 'connected' ? 'ok' : p.status === 'manual' ? 'info' : 'neutral'}>{p.status === 'connected' ? 'מחובר' : p.status === 'manual' ? 'ידני' : 'לא מחובר'}</Chip></li>
            ))}
          </ul>
        </Section>
      </div>

      <Section title="גישה ורשת" id="auth-h">
        <div className="card">
          <dl className="kv kv-2">
            <dt>אימות גישה</dt><dd>{s.authRequired ? 'נדרש אסימון' : 'לא נדרש'}</dd>
            <dt>כתובת האזנה</dt><dd dir="ltr">{s.bindAddress}</dd>
          </dl>
          {!s.authRequired && !loopback ? <div className="callout callout-bad" role="alert">השרת חשוף מחוץ ל־localhost ללא אימות. הגדר MONO_ACCESS_TOKEN.</div> : null}
          {!s.authRequired && loopback ? <p className="muted small">השרת מאזין ל־localhost בלבד.</p> : null}
          {s.authRequired ? (
            <>
              <p className="muted small">פעולות רגישות (כיבוי מצב יבש, שחרור מתג חירום, העלאת תקרות) מבקשות את האסימון שוב. גישה מחוץ ל־localhost חייבת לעבור ב־HTTPS.</p>
              <div className="actions">
                <button className="btn" type="button" onClick={logout} disabled={busy !== null}>{busy === 'logout' ? 'מתנתק…' : 'התנתק'}</button>
                <button className="btn btn-danger" type="button" onClick={revokeAll} disabled={busy !== null}>{busy === 'revoke' ? 'מנתק…' : 'נתק את כל המכשירים'}</button>
              </div>
            </>
          ) : null}
        </div>
      </Section>

      <Section title="יומן ביקורת" id="audit-h" aside={<Chip tone={s.auditChainValid ? 'ok' : 'bad'} title="כל רשומה מקושרת בחתימת sha256 לקודמתה">{s.auditChainValid ? 'שרשרת ביקורת תקינה' : 'שרשרת הביקורת נפגמה!'}</Chip>}>
        {!s.auditChainValid ? <div className="callout callout-bad" role="alert">יומן הביקורת אינו עקבי עם שרשרת החתימות — ייתכן שרשומות שונו או נמחקו מחוץ לאפליקציה.</div> : null}
        {audit.length ? (
          <div className="table-wrap">
            <table className="audit">
              <thead><tr><th>זמן</th><th>גורם</th><th>פעולה</th><th>פירוט</th></tr></thead>
              <tbody>{audit.map((a) => <tr key={a.id}><td className="nowrap">{fmtDateTime(a.at)}</td><td>{a.actor}</td><td dir="ltr">{a.action}</td><td>{a.detail}</td></tr>)}</tbody>
            </table>
          </div>
        ) : <p className="muted">אין רשומות.</p>}
      </Section>
    </div>
  );
}
