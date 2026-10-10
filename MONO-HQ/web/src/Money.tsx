import { useRef, useState } from 'react';
import type { ImportResult, MoneyFlag, MoneyView } from '../../shared/contract.ts';
import { api } from './api.ts';
import { FLAG_HE, KIND_HE, fmtCalendarDate, fmtDateTime, fmtIls } from './format.ts';
import { useLive, useResource } from './live.tsx';
import { Bar, Chip, EmptyState, ErrorState, Loading, Section, useRunner, useToast, type Tone } from './ui.tsx';

const flagTone = (f: MoneyFlag): Tone => (f === 'confirmed' ? 'ok' : f === 'reported' ? 'info' : 'warn');
const FlagChip = ({ flag }: { flag: MoneyFlag }) => <Chip tone={flagTone(flag)}>{FLAG_HE[flag]}</Chip>;
const Amount = ({ a, signed }: { a: number; signed?: boolean }) => (
  <bdi dir="ltr" className={`amount ${a < 0 ? 'neg' : a > 0 && signed ? 'pos' : ''}`}>{fmtIls(a, signed)}</bdi>
);

export function MoneyView() {
  const { mode, tick, refresh } = useLive();
  const res = useResource<MoneyView>('/api/money', mode, tick);
  const [result, setResult] = useState<ImportResult | null>(null);

  const importer = (
    <ImportForm disabled={mode === 'demo'} onDone={(r) => { setResult(r); void res.reload(); refresh(); }} />
  );

  if (res.loading && !res.data) return <div className="view"><Loading /></div>;
  if (res.error && !res.data) return <div className="view"><ErrorState message={res.error} onRetry={res.retry} /></div>;
  const m = res.data;
  if (!m) return null;

  return (
    <div className="view">
      {result ? <ImportSummary r={result} onClose={() => setResult(null)} /> : null}
      {!m.hasData ? (
        <>
          <EmptyState title="עדיין אין נתונים כספיים">
            {m.emptyReasonHe ?? 'לא יובאו נתונים. MONO לא ממציא יתרות או עסקאות; ייבא קובץ CSV כדי להתחיל.'}
          </EmptyState>
          {importer}
        </>
      ) : (
        <>
          <p className="lead">נכון ל־{fmtDateTime(m.asOf)} · כל נתון מסומן: <Chip tone="ok">מאומת</Chip> <Chip tone="info">מדווח</Chip> <Chip tone="warn">משוער</Chip></p>

          <Section title="יתרות" id="bal-h">
            {m.balances.length ? (
              <ul className="card-list cols-3">
                {m.balances.map((b) => (
                  <li key={b.account} className="card stat-card">
                    <span className="stat-label">{b.account}</span>
                    <strong className="big"><Amount a={b.amountAgorot} /></strong>
                    <div className="card-meta"><FlagChip flag={b.flag} /><span>נכון ל־{fmtCalendarDate(b.asOf)}</span></div>
                  </li>
                ))}
              </ul>
            ) : <p className="muted">אין יתרות מדווחות. יתרות לא מחושבות בלי נתון אמיתי.</p>}
          </Section>

          <Section title="תקציב לפי קטגוריה" id="bud-h">
            {m.budget.length ? (
              <ul className="card-list cols-2">
                {m.budget.map((b) => {
                  const over = b.spentAgorot > b.limitAgorot && b.limitAgorot > 0;
                  const near = !over && b.limitAgorot > 0 && b.spentAgorot / b.limitAgorot >= 0.85;
                  return (
                    <li key={b.category} className="card budget-row">
                      <div className="card-head"><strong>{b.category}</strong><FlagChip flag={b.flag} /></div>
                      <Bar value={b.spentAgorot} max={b.limitAgorot} tone={over ? 'bad' : near ? 'warn' : 'ok'} />
                      <div className="card-meta">
                        <span>הוצאו <Amount a={b.spentAgorot} /></span>
                        <span>מתוך <Amount a={b.limitAgorot} /></span>
                        {over ? <Chip tone="bad">חריגה</Chip> : null}
                      </div>
                    </li>
                  );
                })}
              </ul>
            ) : <p className="muted">לא הוגדר תקציב.</p>}
          </Section>

          <Section title="תנועות" id="tx-h" aside={m.duplicates > 0 ? <Chip tone="warn">{m.duplicates} כפילויות אפשריות</Chip> : undefined}>
            {m.transactions.length ? (
              <>
                <div className="table-wrap tx-table">
                  <table>
                    <thead><tr><th>תאריך</th><th>תיאור</th><th>קטגוריה</th><th>סוג</th><th>סכום</th><th>סטטוס</th></tr></thead>
                    <tbody>
                      {m.transactions.map((t) => (
                        <tr key={t.id}>
                          <td>{fmtCalendarDate(t.date)}</td>
                          <td>{t.description}<div className="muted small">{t.account}{t.possibleDuplicateOf ? ' · ' : ''}{t.possibleDuplicateOf ? <Chip tone="warn">כפילות אפשרית</Chip> : null}</div></td>
                          <td>{t.category}</td>
                          <td>{KIND_HE[t.kind] ?? t.kind}</td>
                          <td><Amount a={t.amountAgorot} signed /></td>
                          <td><FlagChip flag={t.flag} /></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <ul className="card-list tx-cards">
                  {m.transactions.map((t) => (
                    <li key={t.id} className="card tx-card">
                      <div className="card-head"><strong>{t.description}</strong><Amount a={t.amountAgorot} signed /></div>
                      <div className="card-meta">
                        <span>{fmtCalendarDate(t.date)}</span><span>{t.category}</span><span>{KIND_HE[t.kind] ?? t.kind}</span>
                      </div>
                      <div className="chips"><FlagChip flag={t.flag} />{t.possibleDuplicateOf ? <Chip tone="warn">כפילות אפשרית</Chip> : null}<Chip>{t.account}</Chip></div>
                    </li>
                  ))}
                </ul>
              </>
            ) : <p className="muted">אין תנועות.</p>}
          </Section>
          {importer}
        </>
      )}
    </div>
  );
}

function ImportSummary({ r, onClose }: { r: ImportResult; onClose: () => void }) {
  return (
    <div className="callout callout-ok" role="status">
      <div className="card-head"><strong>הייבוא הסתיים</strong><button className="link-btn" onClick={onClose}>סגור</button></div>
      <p>נוספו {r.inserted} · כפילויות שדולגו {r.duplicatesSkipped} · כפילויות אפשריות {r.possibleDuplicates} · נדחו {r.rejected.length}</p>
      {r.rejected.length ? (
        <ul className="plain-list">{r.rejected.slice(0, 20).map((x) => <li key={x.row}>שורה {x.row}: {x.reason}</li>)}</ul>
      ) : null}
    </div>
  );
}

function ImportForm({ disabled, onDone }: { disabled: boolean; onDone: (r: ImportResult) => void }) {
  const { mode } = useLive();
  const toast = useToast();
  const { busy, run } = useRunner();
  const [csv, setCsv] = useState('');
  const [account, setAccount] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);

  const onFile = async (f: File | undefined) => {
    if (!f) return;
    if (f.size > 2_000_000) { toast('err', 'הקובץ גדול מדי (מעל 2MB)'); return; }
    setCsv(await f.text());
  };
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    let out: ImportResult | undefined;
    const ok = await run('import', async () => { out = await api<ImportResult>('POST', '/api/money/import', { mode, body: { csv, account: account.trim() } }); });
    if (ok && out) { onDone(out); setCsv(''); if (fileRef.current) fileRef.current.value = ''; }
  };
  return (
    <Section title="ייבוא CSV" id="imp-h">
      <form className="card form" onSubmit={submit}>
        {disabled ? <div className="callout callout-demo">ייבוא נתונים זמין רק במצב אמיתי.</div> : null}
        <p className="muted">הדבק או העלה קובץ תנועות. אל תכלול מספרי חשבון, סיסמאות או פרטי כרטיס מלאים. הנתונים נשמרים מקומית בלבד.</p>
        <label className="field"><span>שם חשבון (תווית בלבד)</span>
          <input value={account} onChange={(e) => setAccount(e.target.value)} disabled={disabled} required maxLength={60} placeholder="למשל: עו״ש ראשי" />
        </label>
        <label className="field"><span>קובץ CSV</span>
          <input ref={fileRef} type="file" accept=".csv,text/csv,text/plain" disabled={disabled} onChange={(e) => void onFile(e.target.files?.[0])} />
        </label>
        <label className="field"><span>או הדבק תוכן</span>
          <textarea dir="ltr" rows={6} value={csv} onChange={(e) => setCsv(e.target.value)} disabled={disabled} placeholder="date,description,amount,..." spellCheck={false} />
        </label>
        <div className="actions"><button className="btn btn-primary" type="submit" disabled={disabled || busy !== null || !csv.trim() || !account.trim()}>{busy ? 'מייבא…' : 'ייבא'}</button></div>
      </form>
    </Section>
  );
}
