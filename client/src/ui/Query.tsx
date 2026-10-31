import type { ReactNode } from 'react';
import type { ApiError } from '../api';
import { Alert, EmptyState } from './Feedback';
import { Skeleton } from './Spinner';

interface QueryLike {
  loading: boolean;
  error?: ApiError;
  data?: unknown;
  reload(): void;
}

/**
 * Standard treatment for a list: skeleton on first load, an error with Retry, a friendly empty
 * state, otherwise the content. Stale data stays visible while a refresh is in flight.
 */
export function QueryStates({
  query,
  isEmpty,
  emptyIcon,
  emptyTitle,
  emptyText,
  emptyAction,
  children,
}: {
  query: QueryLike;
  isEmpty: boolean;
  emptyIcon: ReactNode;
  emptyTitle: string;
  emptyText?: string;
  emptyAction?: ReactNode;
  children: ReactNode;
}) {
  if (query.error) {
    return (
      <div className="card__body">
        <Alert>
          Could not load this list: {query.error.message}{' '}
          <button className="btn btn--secondary btn--sm" onClick={query.reload} style={{ marginLeft: 8 }}>
            Retry
          </button>
        </Alert>
      </div>
    );
  }
  if (query.loading && !query.data) {
    return (
      <div className="card__body" style={{ display: 'grid', gap: 18 }}>
        {[0, 1, 2, 3].map((i) => (
          <Skeleton key={i} />
        ))}
      </div>
    );
  }
  if (isEmpty) {
    return (
      <EmptyState icon={emptyIcon} title={emptyTitle} action={emptyAction}>
        {emptyText}
      </EmptyState>
    );
  }
  return <>{children}</>;
}
