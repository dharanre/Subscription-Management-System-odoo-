import { type ReactNode, createContext, useContext, useEffect, useMemo, useState } from 'react';
import { api } from './api';

interface Meta {
  currency: string;
  locale: string;
}

interface MetaValue {
  money(amount: number): string;
  /** Currency symbol only, for input prefixes. */
  symbol: string;
  currency: string;
}

const MetaContext = createContext<MetaValue | null>(null);

export function MetaProvider({ children }: { children: ReactNode }) {
  const [meta, setMeta] = useState<Meta>({ currency: 'INR', locale: 'en-IN' });

  useEffect(() => {
    api
      .get<Meta>('/meta')
      .then(setMeta)
      .catch((err) => console.error('Could not load currency settings, using defaults', err));
  }, []);

  const value = useMemo<MetaValue>(() => {
    const fmt = new Intl.NumberFormat(meta.locale, { style: 'currency', currency: meta.currency });
    const symbol = fmt.formatToParts(0).find((p) => p.type === 'currency')?.value ?? meta.currency;
    return { money: (n) => fmt.format(n), symbol, currency: meta.currency };
  }, [meta]);

  return <MetaContext.Provider value={value}>{children}</MetaContext.Provider>;
}

export function useMoney(): MetaValue {
  const ctx = useContext(MetaContext);
  if (!ctx) throw new Error('useMoney must be used inside <MetaProvider>');
  return ctx;
}
