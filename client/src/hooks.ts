import { useCallback, useEffect, useRef, useState } from 'react';
import { type ApiError, toApiError } from './api';

interface QueryState<T> {
  data?: T;
  error?: ApiError;
  loading: boolean;
}

/**
 * Loads data and keeps it fresh. Re-runs when `deps` change, and re-fetches quietly every
 * `pollMs` (no loading flicker) so screens follow changes made elsewhere.
 */
export function useQuery<T>(fetcher: () => Promise<T>, deps: unknown[], opts: { pollMs?: number } = {}) {
  const [state, setState] = useState<QueryState<T>>({ loading: true });
  const [tick, setTick] = useState(0);
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  useEffect(() => {
    let cancelled = false;
    const load = (initial: boolean) => {
      if (initial) setState((s) => ({ data: s.data, loading: true }));
      fetcherRef
        .current()
        .then((data) => !cancelled && setState({ data, loading: false }))
        .catch((err) => !cancelled && setState((s) => ({ data: s.data, error: toApiError(err), loading: false })));
    };
    load(true);
    const id = opts.pollMs ? window.setInterval(() => load(false), opts.pollMs) : undefined;
    return () => {
      cancelled = true;
      if (id) window.clearInterval(id);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick, opts.pollMs]);

  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { ...state, reload };
}

export function useDebounced<T>(value: T, ms = 300): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const id = window.setTimeout(() => setDebounced(value), ms);
    return () => window.clearTimeout(id);
  }, [value, ms]);
  return debounced;
}

export function usePageTitle(title: string) {
  useEffect(() => {
    document.title = `${title} · Brightloop Billing`;
  }, [title]);
}
