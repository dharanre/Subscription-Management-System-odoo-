export function Spinner({ large, label = 'Loading' }: { large?: boolean; label?: string }) {
  return (
    <span role="status" aria-label={label} style={{ display: 'inline-flex' }}>
      <span className={`spinner${large ? ' spinner--lg' : ''}`} />
    </span>
  );
}

export function Skeleton({ width = '100%' }: { width?: string | number }) {
  return <div className="skeleton" style={{ width }} aria-hidden="true" />;
}
