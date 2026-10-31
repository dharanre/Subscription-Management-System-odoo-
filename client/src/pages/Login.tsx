import { type FormEvent, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { ApiError } from '../api';
import { useAuth } from '../auth';
import { usePageTitle } from '../hooks';
import { AuthLayout } from '../layout/AuthLayout';
import { Button } from '../ui/Button';
import { Alert } from '../ui/Feedback';
import { TextField } from '../ui/Field';

export function LoginPage() {
  usePageTitle('Sign in');
  const { login } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const from = (location.state as { from?: string } | null)?.from ?? '/';

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const next: Record<string, string> = {};
    if (!email.trim()) next.email = 'Enter your email address';
    if (!password) next.password = 'Enter your password';
    setErrors(next);
    setFormError('');
    if (Object.keys(next).length) return;

    setBusy(true);
    try {
      await login(email.trim(), password);
      navigate(from, { replace: true });
    } catch (err) {
      if (err instanceof ApiError && err.status === 422) setErrors(err.fields);
      else setFormError(err instanceof Error ? err.message : 'Could not sign in.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthLayout>
      <div>
        <h1>Welcome back</h1>
        <p className="muted" style={{ marginTop: 6 }}>
          Sign in to manage subscriptions, invoices and payments.
        </p>
      </div>
      <form onSubmit={submit} noValidate>
        {formError && <Alert>{formError}</Alert>}
        <TextField label="Email" type="email" name="email" autoComplete="email" autoFocus value={email} onChange={setEmail} error={errors.email} />
        <TextField label="Password" type="password" name="password" autoComplete="current-password" value={password} onChange={setPassword} error={errors.password} />
        <div className="row-between">
          <span />
          <Link to="/forgot-password" className="small">
            Forgot password?
          </Link>
        </div>
        <Button type="submit" block loading={busy}>
          Sign in
        </Button>
      </form>
      {import.meta.env.DEV && (
        <div className="demo-box">
          <strong>Local demo accounts</strong> (created by <code>npm run seed</code>)
          <br />
          <code>admin@brightloop.example</code> · <code>staff@brightloop.example</code>
          <br />
          Password: <code>Demo#Pass2026</code>
        </div>
      )}
      <p className="auth__foot">
        New to Brightloop? <Link to="/signup">Create an account</Link>
      </p>
    </AuthLayout>
  );
}
