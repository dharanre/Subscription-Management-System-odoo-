import { useMoney } from '../meta';
import type { SubStatus } from '../salesTypes';
import { STATUS_UI } from './Status';

const ORDER: SubStatus[] = ['active', 'paused', 'confirmed', 'quotation', 'draft', 'closed'];

/** Where every subscription stands: one stacked bar, and the same numbers written out beneath it. */
export function StatusMix({ byStatus }: { byStatus: Record<SubStatus, number> }) {
  const { count } = useMoney();
  const total = ORDER.reduce((n, s) => n + byStatus[s], 0);
  if (total === 0) return <p className="muted">No subscriptions yet.</p>;
  return (
    <div className="mix">
      <div className="mix__bar" role="img" aria-label={ORDER.map((s) => `${byStatus[s]} ${STATUS_UI[s].label.toLowerCase()}`).join(', ')}>
        {ORDER.filter((s) => byStatus[s] > 0).map((s) => (
          <span key={s} className={`mix__seg mix__seg--${s}`} style={{ width: `${(byStatus[s] / total) * 100}%` }} title={`${STATUS_UI[s].label}: ${byStatus[s]}`} />
        ))}
      </div>
      <ul className="mix__legend">
        {ORDER.map((s) => (
          <li key={s}>
            <i className={`swatch mix__seg--${s}`} />
            <span>{STATUS_UI[s].label}</span>
            <span className="num">{count(byStatus[s])}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
