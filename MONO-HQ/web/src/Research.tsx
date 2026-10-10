import { useState } from 'react';
import type { ResearchItem } from '../../shared/contract.ts';
import { safeUrl } from './api.ts';
import { fmtDateIso, fmtDateTime } from './format.ts';
import { useLive, useResource } from './live.tsx';
import { Chip, EmptyState, ErrorState, Loading, type Tone } from './ui.tsx';

const CHANGE: Record<ResearchItem['changeSinceLastCheck'], { he: string; tone: Tone }> = {
  new: { he: 'חדש', tone: 'info' }, changed: { he: 'השתנה מאז הבדיקה הקודמת', tone: 'warn' }, unchanged: { he: 'ללא שינוי', tone: 'neutral' },
};

export function ResearchView() {
  const { mode, tick } = useLive();
  const res = useResource<ResearchItem[]>('/api/research', mode, tick);
  const [f, setF] = useState<'all' | 'changed' | 'official'>('all');

  if (res.loading && !res.data) return <div className="view"><Loading /></div>;
  if (res.error && !res.data) return <div className="view"><ErrorState message={res.error} onRetry={res.retry} /></div>;
  const items = (res.data ?? []).filter((i) => (f === 'all' ? true : f === 'changed' ? i.changeSinceLastCheck !== 'unchanged' : i.reliability === 'official'));

  return (
    <div className="view">
      <div className="toolbar">
        <p className="lead">עדכונים בנושאי כספים בישראל. כל פריט מצורף למקור, תאריך ורמת מהימנות. אינו ייעוץ מוסמך.</p>
        <div className="seg" role="group" aria-label="סינון">
          <button aria-pressed={f === 'all'} onClick={() => setF('all')}>הכול</button>
          <button aria-pressed={f === 'changed'} onClick={() => setF('changed')}>חדש / השתנה</button>
          <button aria-pressed={f === 'official'} onClick={() => setF('official')}>רשמי בלבד</button>
        </div>
      </div>
      {items.length === 0 ? <EmptyState title="אין פריטי מחקר להצגה">עדיין לא בוצע מחקר, או שאין פריטים התואמים לסינון.</EmptyState> : (
        <ul className="card-list cols-2">
          {items.map((i) => {
            const href = safeUrl(i.sourceUrl);
            return (
              <li key={i.id} className="card">
                <div className="card-head">
                  <strong>{i.titleHe}</strong>
                  <Chip tone={i.reliability === 'official' ? 'ok' : 'warn'}>{i.reliability === 'official' ? 'מקור רשמי' : 'לא מאומת'}</Chip>
                </div>
                <div className="chips"><Chip tone={CHANGE[i.changeSinceLastCheck].tone}>{CHANGE[i.changeSinceLastCheck].he}</Chip></div>
                <p className="card-text">{i.summaryHe}</p>
                <dl className="kv kv-2">
                  <dt>השפעה</dt><dd>{i.impactHe}</dd>
                  <dt>אי־ודאות</dt><dd>{i.uncertaintyHe}</dd>
                  <dt>פורסם</dt><dd>{fmtDateIso(i.publishedAt)}</dd>
                  <dt>נבדק</dt><dd>{fmtDateTime(i.checkedAt)}</dd>
                </dl>
                <div className="actions">
                  {href ? <a className="btn btn-sm" href={href} target="_blank" rel="noopener noreferrer">{i.sourceName} ↗</a> : <span className="muted small">{i.sourceName} · קישור לא תקין</span>}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
