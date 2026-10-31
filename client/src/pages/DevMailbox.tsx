import { Inbox, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { fmtDateTime } from '../format';
import { usePageTitle, useQuery } from '../hooks';
import { Button } from '../ui/Button';
import { Alert, EmptyState, useToast } from '../ui/Feedback';
import { PageHeader } from '../ui/Layout';
import { Spinner } from '../ui/Spinner';

interface Mail {
  to: string;
  subject: string;
  text: string;
  createdAt: string;
}

/** Local-only stand-in for an email inbox; the API refuses to serve it to non-loopback clients. */
export function DevMailboxPage() {
  usePageTitle('Dev mailbox');
  const toast = useToast();
  const [clearing, setClearing] = useState(false);
  const mail = useQuery(() => api.get<{ items: Mail[] }>('/dev/mailbox'), [], { pollMs: 3000 });

  async function clear() {
    setClearing(true);
    try {
      await api.del('/dev/mailbox');
      mail.reload();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not clear the mailbox.');
    } finally {
      setClearing(false);
    }
  }

  const items = mail.data?.items ?? [];
  // Links in these messages carry live single-use tokens, so they are rendered as plain text here
  // and opened through the app's own route.
  const linkOf = (text: string) => text.match(/https?:\/\/[^\s]+\/reset-password\?token=[A-Za-z0-9_-]+/)?.[0];

  return (
    <div style={{ maxWidth: 820 }}>
      <PageHeader
        title="Dev mailbox"
        description="Emails the app would send, captured locally because no mail provider is configured. This page only exists in development."
        actions={
          <Button variant="secondary" icon={<Trash2 size={17} />} onClick={clear} loading={clearing} disabled={items.length === 0}>
            Clear
          </Button>
        }
      />
      <section className="card">
        {mail.error && (
          <div className="card__body">
            <Alert>{mail.error.status === 404 ? 'The dev mailbox is disabled on this server (DEV_MAILBOX is off).' : mail.error.message}</Alert>
          </div>
        )}
        {!mail.error && mail.loading && !mail.data && (
          <div className="state">
            <Spinner large />
          </div>
        )}
        {!mail.error && mail.data && items.length === 0 && (
          <EmptyState icon={<Inbox size={22} />} title="No messages yet">
            Request a password reset from the sign-in page and the message will appear here.
          </EmptyState>
        )}
        {items.map((m) => {
          const link = linkOf(m.text);
          const path = link ? new URL(link).pathname + new URL(link).search : undefined;
          return (
            <article key={`${m.createdAt}-${m.to}`} className="mail">
              <div className="row-between" style={{ alignItems: 'flex-start' }}>
                <div>
                  <h3>{m.subject}</h3>
                  <div className="small muted">
                    To {m.to} · {fmtDateTime(m.createdAt)}
                  </div>
                </div>
                {path && (
                  <Link className="btn btn--secondary btn--sm" to={path}>
                    Open link
                  </Link>
                )}
              </div>
              <pre>{m.text}</pre>
            </article>
          );
        })}
      </section>
    </div>
  );
}
