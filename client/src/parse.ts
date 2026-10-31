/**
 * Form-side parsing of typed numbers. The server re-validates everything; these exist so people
 * see a clear message next to the field before the request is sent.
 */
export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

const bad = (error: string): Parsed<never> => ({ ok: false, error });

export function parseMoney(raw: string, label = 'Amount'): Parsed<number> {
  const s = raw.trim();
  if (!s) return bad(`${label} is required`);
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return bad(`${label} must be a number with at most 2 decimals`);
  return { ok: true, value: Number(s) };
}

export function parsePercent(raw: string, label = 'Percentage'): Parsed<number> {
  const r = parseMoney(raw, label);
  if (!r.ok) return r;
  if (r.value > 100) return bad(`${label} cannot exceed 100`);
  return r;
}

export function parseWhole(raw: string, label: string, min = 0): Parsed<number> {
  const s = raw.trim();
  if (!s) return bad(`${label} is required`);
  if (!/^\d+$/.test(s)) return bad(`${label} must be a whole number`);
  const n = Number(s);
  if (n < min) return bad(`${label} must be at least ${min}`);
  return { ok: true, value: n };
}

export const isDate = (s: string) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
};

/** A plain number as the string a person would type back into a field. */
export const numToInput = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/0+$/, '').replace(/\.$/, ''));
