import { useState } from 'react';
import type { Report } from '../../shared/contract.ts';
import { REPORT_KIND_HE, fmtDateTime } from './format.ts';
import { useLive, useResource } from './live.tsx';
import { Chip, EmptyState, ErrorState, Icon, Loading, Markdown, Modal } from './ui.tsx';

export function ReportsView() {
  const { mode, tick } = useLive();
  const res = useResource<Report[]>('/api/reports', mode, tick);
  const [openId, setOpenId] = useState<string | null>(null);

  if (res.loading && !res.data) return <div className="view"><Loading /></div>;
  if (res.error && !res.data) return <div className="view"><ErrorState message={res.error} onRetry={res.retry} /></div>;
  const list = res.data ?? [];
  const open = list.find((r) => r.id === openId);

  return (
    <div className="view">
      {list.length === 0 ? <EmptyState title="אין דוחות עדיין">דוחות יופיעו כאן אחרי שמשימה תסתיים ותפיק תוצר.</EmptyState> : (
        <ul className="card-list cols-2">
          {list.map((r) => (
            <li key={r.id} className="card">
              <div className="card-head"><strong>{r.titleHe}</strong><Chip tone="info">{REPORT_KIND_HE[r.kind] ?? r.kind}</Chip></div>
              <div className="chips">{r.isDemo ? <Chip tone="demo">DEMO · הדמיה</Chip> : null}<span className="muted small">{fmtDateTime(r.createdAt)}</span></div>
              <div className="actions">
                <button className="btn btn-sm btn-primary" onClick={() => setOpenId(r.id)}>קרא</button>
                <a className="btn btn-sm" href={`/api/reports/${encodeURIComponent(r.id)}/download?format=md`} download><Icon name="download" size={16} /> Markdown</a>
                <a className="btn btn-sm" href={`/api/reports/${encodeURIComponent(r.id)}/download?format=json`} download><Icon name="download" size={16} /> JSON</a>
              </div>
            </li>
          ))}
        </ul>
      )}
      {open ? (
        <Modal label={open.titleHe} variant="wide" onClose={() => setOpenId(null)}>
          <div className="dialog-body report-body">
            <div className="card-head"><h2>{open.titleHe}</h2><button className="icon-btn" onClick={() => setOpenId(null)} aria-label="סגור" data-autofocus>✕</button></div>
            <div className="chips">{open.isDemo ? <Chip tone="demo">DEMO · הדמיה</Chip> : null}<Chip tone="info">{REPORT_KIND_HE[open.kind] ?? open.kind}</Chip><span className="muted small">{fmtDateTime(open.createdAt)}</span></div>
            <Markdown source={open.markdown} />
          </div>
        </Modal>
      ) : null}
    </div>
  );
}
