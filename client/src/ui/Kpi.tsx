import type { CSSProperties, ReactNode } from 'react';
import { Link } from 'react-router-dom';

interface KpiProps {
  label: string;
  value: string;
  sub?: ReactNode;
  /** Makes the whole card a link, e.g. to the list behind the number. */
  to?: string;
  tone?: 'bad';
}

/**
 * A headline figure. The value shrinks to fit its card instead of spilling out, so a total in the crores
 * stays whole while a small count keeps the full size (see `.kpi` in dashboard.css).
 */
export function Kpi({ label, value, sub, to, tone }: KpiProps) {
  const body = (
    <>
      <div className="stat__label">{label}</div>
      <div className="stat__value">{value}</div>
      <div className="stat__sub">{sub ?? ' '}</div>
    </>
  );
  const style = { '--chars': Math.max(value.length, 1) } as CSSProperties;
  return to ? (
    <Link to={to} className="card stat kpi" data-tone={tone} style={style}>
      {body}
    </Link>
  ) : (
    <div className="card stat kpi" data-tone={tone} style={style}>
      {body}
    </div>
  );
}
