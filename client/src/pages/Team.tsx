import { Search, UserPlus, Users } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { type Account, ApiError, type Page, api, qs } from '../api';
import { useAuth } from '../auth';
import { capitalize, fmtDate } from '../format';
import { useDebounced, usePageTitle, useQuery } from '../hooks';
import { Button } from '../ui/Button';
import { ConfirmDialog, Dialog } from '../ui/Dialog';
import { Alert, Badge, EmptyState, useToast } from '../ui/Feedback';
import { PasswordRules, TextField, passwordIsValid } from '../ui/Field';
import { PageHeader, Pagination } from '../ui/Layout';
import { Skeleton } from '../ui/Spinner';

const PAGE_SIZE = 10;
const ROLE_TONE = { admin: 'info', staff: 'ok', customer: 'mute' } as const;

export function TeamPage() {
  usePageTitle('Team');
  const { user } = useAuth();
  const toast = useToast();
  const [q, setQ] = useState('');
  const [role, setRole] = useState('');
  const [page, setPage] = useState(1);
  const search = useDebounced(q.trim());
  const [addOpen, setAddOpen] = useState(false);
  const [toggle, setToggle] = useState<Account | null>(null);
  const [toggling, setToggling] = useState(false);

  const list = useQuery(() => api.get<Page<Account>>(`/users${qs({ page, pageSize: PAGE_SIZE, role, q: search })}`), [page, role, search]);

  async function confirmToggle() {
    if (!toggle) return;
    setToggling(true);
    try {
      await api.patch(`/users/${toggle.id}/status`, { isActive: !toggle.isActive });
      toast.success(`${toggle.name} ${toggle.isActive ? 'deactivated' : 'reactivated'}.`);
      setToggle(null);
      list.reload();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not update the account.');
    } finally {
      setToggling(false);
    }
  }

  const rows = list.data?.items ?? [];

  return (
    <>
      <PageHeader
        title="Team"
        description="Every account in the system. Only admins can add staff, and staff only get the limited access their role allows."
        actions={
          <Button icon={<UserPlus size={18} />} onClick={() => setAddOpen(true)}>
            Add staff member
          </Button>
        }
      />

      <section className="card">
        <div className="toolbar">
          <div className="search">
            <Search size={17} />
            <input
              className="input"
              type="search"
              placeholder="Search name or email"
              aria-label="Search accounts"
              value={q}
              onChange={(e) => {
                setQ(e.target.value);
                setPage(1);
              }}
            />
          </div>
          <select
            className="select"
            aria-label="Filter by role"
            value={role}
            onChange={(e) => {
              setRole(e.target.value);
              setPage(1);
            }}
          >
            <option value="">All roles</option>
            <option value="admin">Admins</option>
            <option value="staff">Staff</option>
            <option value="customer">Customers</option>
          </select>
        </div>

        {list.error && (
          <div className="card__body">
            <Alert>
              Could not load accounts: {list.error.message}{' '}
              <button className="btn btn--secondary btn--sm" onClick={list.reload} style={{ marginLeft: 8 }}>
                Retry
              </button>
            </Alert>
          </div>
        )}

        {!list.error && list.loading && !list.data && (
          <div className="card__body" style={{ display: 'grid', gap: 18 }}>
            {[0, 1, 2, 3].map((i) => (
              <Skeleton key={i} />
            ))}
          </div>
        )}

        {!list.error && list.data && rows.length === 0 && (
          <EmptyState icon={<Users size={22} />} title="No accounts match">
            Try a different search or clear the role filter.
          </EmptyState>
        )}

        {rows.length > 0 && (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Person</th>
                  <th>Role</th>
                  <th>Status</th>
                  <th className="hide-sm">Joined</th>
                  <th className="cell-actions">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((a) => (
                  <tr key={a.id}>
                    <td>
                      <div className="cell-main">
                        {a.name} {a.isDemo && <Badge plain>Demo</Badge>}
                      </div>
                      <div className="cell-sub">{a.email}</div>
                    </td>
                    <td>
                      <Badge tone={ROLE_TONE[a.role]}>{capitalize(a.role)}</Badge>
                    </td>
                    <td>{a.isActive ? <Badge tone="ok">Active</Badge> : <Badge tone="bad">Deactivated</Badge>}</td>
                    <td className="num hide-sm">{fmtDate(a.createdAt)}</td>
                    <td className="cell-actions">
                      {a.id !== user?.id && (
                        <Button variant="secondary" size="sm" onClick={() => setToggle(a)}>
                          {a.isActive ? 'Deactivate' : 'Reactivate'}
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {list.data && list.data.total > 0 && <Pagination page={page} pageSize={PAGE_SIZE} total={list.data.total} onPage={setPage} />}
      </section>

      <AddStaffDialog
        open={addOpen}
        onClose={() => setAddOpen(false)}
        onCreated={(name) => {
          setAddOpen(false);
          toast.success(`${name} can now sign in as staff.`);
          setPage(1);
          list.reload();
        }}
      />

      <ConfirmDialog
        open={toggle !== null}
        title={toggle?.isActive ? 'Deactivate this account?' : 'Reactivate this account?'}
        confirmLabel={toggle?.isActive ? 'Deactivate' : 'Reactivate'}
        danger={toggle?.isActive}
        busy={toggling}
        onConfirm={confirmToggle}
        onClose={() => !toggling && setToggle(null)}
      >
        {toggle?.isActive ? (
          <p>
            <strong>{toggle?.name}</strong> will be signed out immediately and will not be able to sign in until reactivated. Their records are kept.
          </p>
        ) : (
          <p>
            <strong>{toggle?.name}</strong> will be able to sign in again.
          </p>
        )}
      </ConfirmDialog>
    </>
  );
}

function AddStaffDialog({ open, onClose, onCreated }: { open: boolean; onClose(): void; onCreated(name: string): void }) {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState('');
  const [busy, setBusy] = useState(false);

  function close() {
    if (busy) return;
    setName('');
    setEmail('');
    setPassword('');
    setErrors({});
    setFormError('');
    onClose();
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    const next: Record<string, string> = {};
    if (!name.trim()) next.name = 'Enter a name';
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email.trim())) next.email = 'Enter a valid email address';
    if (!passwordIsValid(password)) next.password = 'The password does not meet every requirement below';
    setErrors(next);
    setFormError('');
    if (Object.keys(next).length) return;

    setBusy(true);
    try {
      await api.post('/users/staff', { name: name.trim(), email: email.trim(), password });
      const created = name.trim();
      setName('');
      setEmail('');
      setPassword('');
      onCreated(created);
    } catch (err) {
      if (err instanceof ApiError && Object.keys(err.fields).length) setErrors(err.fields);
      else setFormError(err instanceof Error ? err.message : 'Could not add the staff member.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      title="Add staff member"
      onClose={close}
      footer={
        <>
          <Button variant="secondary" onClick={close} disabled={busy}>
            Cancel
          </Button>
          <Button type="submit" form="add-staff-form" loading={busy}>
            Add staff member
          </Button>
        </>
      }
    >
      <form id="add-staff-form" className="dialog__body" onSubmit={submit} noValidate>
        {formError && <Alert>{formError}</Alert>}
        <TextField label="Full name" name="name" autoFocus value={name} onChange={setName} error={errors.name} />
        <TextField label="Work email" type="email" name="email" autoComplete="off" value={email} onChange={setEmail} error={errors.email} />
        <div style={{ display: 'grid', gap: 8 }}>
          <TextField label="Temporary password" type="password" name="password" autoComplete="new-password" value={password} onChange={setPassword} error={errors.password} hint="Share it with them securely. They can change it with Forgot password." />
          <PasswordRules value={password} />
        </div>
      </form>
    </Dialog>
  );
}
