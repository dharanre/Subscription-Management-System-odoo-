import { type FormEvent, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { ApiError, api } from '../api';
import { usePageTitle } from '../hooks';
import { AuthLayout } from '../layout/AuthLayout';
import { Button } from '../ui/Button';
import { Alert } from '../ui/Feedback';
import { PasswordRules, TextField, passwordIsValid } from '../ui/Field';

export function ForgotPasswordPage() {
  usePageTitle('Reset password');
  const [email, setEmail] = useState('');
  const [error, setError] = useState('');
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError('');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email.trim())) {
      setError('Enter a valid email address');
      return;
    }
    setBusy(true);
    try {
      await api.post('/auth/forgot', { email: email.trim() });
      setSent(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not send the reset link.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthLayout>
      <div>
        <h1>Reset your password</h1>
        <p className="muted" style={{ marginTop: 6 }}>
          Enter your registered email and we will send you a link to choose a new password.
        </p>
      </div>
      {sent ? (
        <>
          <Alert tone="success">If that email is registered, a reset link is on its way. The link works once and expires soon.</Alert>
          {import.meta.env.DEV && (
            <div className="demo-box">
              Local development has no mail server. Read the message in the <Link to="/dev/mailbox">dev mailbox</Link>.
            </div>
          )}
        </>
      ) : (
        <form onSubmit={submit} noValidate>
          <TextField label="Email" type="email" name="email" autoComplete="email" autoFocus value={email} onChange={setEmail} error={error} />
          <Button type="submit" block loading={busy}>
            Send reset link
          </Button>
        </form>
      )}
      <p className="auth__foot">
        <Link to="/login">Back to sign in</Link>
      </p>
    </AuthLayout>
  );
}

export function ResetPasswordPage() {
  usePageTitle('Choose a new password');
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [fieldError, setFieldError] = useState('');
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError('');
    setFieldError('');
    if (!passwordIsValid(password)) {
      setFieldError('Your password does not meet every requirement below');
      return;
    }
    setBusy(true);
    try {
      await api.post('/auth/reset', { token, password });
      setDone(true);
    } catch (err) {
      if (err instanceof ApiError && err.fields.password) setFieldError(err.fields.password);
      else setError(err instanceof Error ? err.message : 'Could not reset the password.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthLayout>
      <div>
        <h1>Choose a new password</h1>
      </div>
      {!token ? (
        <Alert>This reset link is incomplete. Open the link from your email again, or request a new one.</Alert>
      ) : done ? (
        <>
          <Alert tone="success">Your password has been updated. Any other signed-in devices were signed out.</Alert>
          <Link className="btn btn--primary btn--block" to="/login">
            Sign in
          </Link>
        </>
      ) : (
        <form onSubmit={submit} noValidate>
          {error && <Alert>{error}</Alert>}
          <div style={{ display: 'grid', gap: 8 }}>
            <TextField label="New password" type="password" name="password" autoComplete="new-password" autoFocus value={password} onChange={setPassword} error={fieldError} />
            <PasswordRules value={password} />
          </div>
          <Button type="submit" block loading={busy}>
            Update password
          </Button>
        </form>
      )}
      {!done && (
        <p className="auth__foot">
          <Link to="/forgot-password">Request a new link</Link>
        </p>
      )}
    </AuthLayout>
  );
}
