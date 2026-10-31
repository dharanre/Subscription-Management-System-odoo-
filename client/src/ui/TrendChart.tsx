import { useMoney } from '../meta';
import type { TrendPoint } from '../dashboardTypes';

/** Rounds a maximum up to a tidy axis top (1, 2, 2.5, 5 or 10 times a power of ten). */
function niceCeil(v: number): number {
  const pow = 10 ** Math.floor(Math.log10(v));
  const n = v / pow;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * pow;
}

/**
 * Invoiced against collected, per day or month. Built from plain elements so it scales with its container,
 * reads aloud as a summary plus a table, and every bar shows its exact figures on hover.
 */
export function TrendChart({ points, granularity }: { points: TrendPoint[]; granularity: 'day' | 'month' }) {
  const { money, compact } = useMoney();
  const max = Math.max(0, ...points.flatMap((p) => [p.invoiced, p.collected]));
  // Four equal steps, each a round number, so the axis reads 0, 1K, 2K, 3K, 4K rather than 0, 1.3K, 2.5K...
  const step = niceCeil(Math.max(max, 1) / 4);
  const top = step * 4;
  const ticks = [4, 3, 2, 1, 0].map((n) => step * n);
  const every = Math.max(1, Math.ceil(points.length / 8));
  const totalInvoiced = points.reduce((n, p) => n + p.invoiced, 0);
  const totalCollected = points.reduce((n, p) => n + p.collected, 0);
  const unit = granularity === 'day' ? 'day' : 'month';

  return (
    <figure className="trend">
      <div className="trend__legend" aria-hidden="true">
        <span><i className="swatch swatch--inv" /> Invoiced</span>
        <span><i className="swatch swatch--col" /> Collected</span>
      </div>
      {max === 0 ? (
        <div className="trend__empty">No invoices or payments in this period.</div>
      ) : (
        <>
          <div className="trend__body">
            <div className="trend__yaxis" aria-hidden="true">
              {ticks.map((t) => (
                <span key={t}>{t === 0 ? '0' : compact(t)}</span>
              ))}
            </div>
            <div className="trend__plot" role="img" aria-label={`Invoiced ${money(totalInvoiced)} and collected ${money(totalCollected)} over ${points.length} ${unit}${points.length === 1 ? '' : 's'}`}>
              <div className="trend__grid" aria-hidden="true">
                {ticks.map((t) => (
                  <span key={t} />
                ))}
              </div>
              <div className="trend__cols" style={{ gridTemplateColumns: `repeat(${points.length}, minmax(0, 1fr))` }}>
                {points.map((p) => (
                  <div key={p.key} className="trend__col" title={`${p.label}\nInvoiced ${money(p.invoiced)}\nCollected ${money(p.collected)}`}>
                    <span className="trend__bar trend__bar--inv" style={{ height: `${(p.invoiced / top) * 100}%` }} />
                    <span className="trend__bar trend__bar--col" style={{ height: `${(p.collected / top) * 100}%` }} />
                  </div>
                ))}
              </div>
            </div>
          </div>
          <div className="trend__xaxis" aria-hidden="true" style={{ gridTemplateColumns: `repeat(${points.length}, minmax(0, 1fr))` }}>
            {points.map((p, i) => (
              <span key={p.key} className={i % (every * 2) === 0 ? undefined : 'x--minor'}>
                {i % every === 0 ? p.label : ''}
              </span>
            ))}
          </div>
        </>
      )}
      <table className="sr-only">
        <caption>Invoiced and collected by {unit}</caption>
        <thead>
          <tr>
            <th>{unit === 'day' ? 'Day' : 'Month'}</th>
            <th>Invoiced</th>
            <th>Collected</th>
          </tr>
        </thead>
        <tbody>
          {points.map((p) => (
            <tr key={p.key}>
              <td>{p.label}</td>
              <td>{money(p.invoiced)}</td>
              <td>{money(p.collected)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  );
}
