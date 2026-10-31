import { useMoney } from '../meta';

export interface BreakdownRow {
  key: string | number;
  description: string;
  /** Second line under the description, e.g. "10 × ₹1,760 · Standard tax 18%". */
  detail?: string;
  subtotal: number;
  discount: number;
  tax: number;
  total: number;
}

export interface BreakdownTotals {
  subtotal: number;
  discount: number;
  tax: number;
  total: number;
}

const right = { textAlign: 'right' } as const;

/** One table that shows how a price is made up, shared by the calculator, the quotation form and a subscription's detail. */
export function BreakdownTable({ rows, totals, totalLabel = 'Total' }: { rows: BreakdownRow[]; totals: BreakdownTotals; totalLabel?: string }) {
  const { money } = useMoney();
  const off = (n: number) => (n > 0 ? `−${money(n)}` : '—');
  /** The columns hidden on a phone, written out under the line instead. */
  const folded = (r: BreakdownTotals) => `Subtotal ${money(r.subtotal)}${r.discount > 0 ? ` · Discount −⁠${money(r.discount)}` : ''} · Tax ${money(r.tax)}`;
  return (
    <div className="table-wrap">
      <table className="table table--compact">
        <thead>
          <tr>
            <th>Line</th>
            <th className="hide-sm" style={right}>Subtotal</th>
            <th className="hide-sm" style={right}>Discount</th>
            <th className="hide-sm" style={right}>Tax</th>
            <th style={right}>Total</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.key}>
              <td>
                <div className="cell-main">{r.description}</div>
                {r.detail && <div className="cell-sub">{r.detail}</div>}
                <div className="cell-sub show-sm">{folded(r)}</div>
              </td>
              <td className="num hide-sm" style={right}>{money(r.subtotal)}</td>
              <td className="num neg hide-sm" style={right}>{off(r.discount)}</td>
              <td className="num hide-sm" style={right}>{money(r.tax)}</td>
              <td className="num" style={right}>{money(r.total)}</td>
            </tr>
          ))}
          <tr className="total-row">
            <td>
              {totalLabel}
              <div className="cell-sub show-sm" style={{ fontWeight: 500 }}>{folded(totals)}</div>
            </td>
            <td className="num hide-sm" style={right}>{money(totals.subtotal)}</td>
            <td className="num neg hide-sm" style={right}>{off(totals.discount)}</td>
            <td className="num hide-sm" style={right}>{money(totals.tax)}</td>
            <td className="num" style={right}>{money(totals.total)}</td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}
