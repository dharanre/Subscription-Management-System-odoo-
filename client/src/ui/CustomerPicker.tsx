import { AlertCircle, Search, X } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import { type Page, api, qs } from '../api';
import { useDebounced } from '../hooks';
import type { Customer } from '../salesTypes';
import { Button } from './Button';

export interface PickedCustomer {
  id: number;
  name: string;
  company: string | null;
}

/** Searches customers as you type, so it keeps working with thousands of them (a plain dropdown would not). */
export function CustomerPicker({ value, onChange, error, disabled }: { value: PickedCustomer | null; onChange(c: PickedCustomer | null): void; error?: string; disabled?: boolean }) {
  const inputId = useId();
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const [results, setResults] = useState<Customer[]>([]);
  const [failed, setFailed] = useState(false);
  const search = useDebounced(q.trim(), 250);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    api
      .get<Page<Customer>>(`/customers${qs({ q: search, pageSize: 8 })}`)
      .then((r) => !cancelled && (setResults(r.items), setFailed(false)))
      .catch(() => !cancelled && setFailed(true));
    return () => {
      cancelled = true;
    };
  }, [search, open]);

  useEffect(() => {
    const close = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, []);

  return (
    <div className="field">
      <label className="field__label" htmlFor={inputId}>
        Customer
      </label>
      {value ? (
        <div className="picker__chosen" data-invalid={error ? true : undefined}>
          <span>
            <strong>{value.company || value.name}</strong>
            {value.company && <span className="muted"> · {value.name}</span>}
          </span>
          {!disabled && <Button variant="ghost" size="sm" aria-label="Choose a different customer" onClick={() => onChange(null)} icon={<X size={16} />} />}
        </div>
      ) : (
        <div className="picker" ref={box}>
          <div className="search" style={{ position: 'relative' }}>
            <Search size={17} style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', color: 'var(--ink-500)' }} />
            <input
              id={inputId}
              className="input"
              style={{ paddingLeft: 38 }}
              placeholder="Search by name, company or email"
              value={q}
              disabled={disabled}
              autoComplete="off"
              aria-invalid={error ? true : undefined}
              onFocus={() => setOpen(true)}
              onChange={(e) => {
                setQ(e.target.value);
                setOpen(true);
              }}
            />
          </div>
          {open && (
            <ul className="picker__list" role="listbox" aria-label="Customers">
              {failed && <li className="picker__item muted">Could not load customers. Try again.</li>}
              {!failed && results.length === 0 && <li className="picker__item muted">No customers found</li>}
              {results.map((c) => (
                <li key={c.id} role="option" aria-selected={false}>
                  <button
                    type="button"
                    className="picker__item"
                    onClick={() => {
                      onChange({ id: c.id, name: c.name, company: c.company });
                      setOpen(false);
                      setQ('');
                    }}
                  >
                    {c.company || c.name}
                    <small>
                      {c.company ? `${c.name} · ` : ''}
                      {c.email}
                    </small>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      {error && (
        <p className="field__error" role="alert">
          <AlertCircle size={15} style={{ flex: 'none', marginTop: 2 }} />
          {error}
        </p>
      )}
    </div>
  );
}
