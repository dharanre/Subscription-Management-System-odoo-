import { type FormEvent, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ApiError } from '../api';
import { useAuth } from '../auth';
import { usePageTitle } from '../hooks';
import { AuthLayout } from '../layout/AuthLayout';
import { Button } from '../ui/Button';
import { Alert } from '../ui/Feedback';
import { PasswordRules, TextField, passwordIsValid } from '../ui/Field';

export function SignupPage() {
  usePageTitle('Create account');
  const { signup } = useAuth();
  const navigate = useNavigate();

  const [name, setName] = useState('');
  const [company, setCompany] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const next: Record<string, string> = {};
    if (!name.trim()) next.name = 'Enter your name';
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email.trim())) next.email = 'Enter a valid email address';
    if (!passwordIsValid(password)) next.password = 'Your password does not meet every requirement below';
    setErrors(next);
    setFormError('');
    if (Object.keys(next).length) return;

    setBusy(true);
    try {
      await signup({ name: name.trim(), company: company.trim() || undefined, email: email.trim(), password });
      navigate('/', { replace: true });
    } catch (err) {
      if (err instanceof ApiError && Object.keys(err.fields).length) setErrors(err.fields);
      else setFormError(err instanceof Error ? err.message : 'Could not create the account.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthLayout>
      <div>
        <h1>Create your account</h1>
        <p className="muted" style={{ marginTop: 6 }}>
          See and manage your own subscriptions and invoices in the customer portal.
        </p>
      </div>
      <form onSubmit={submit} noValidate>
        {formError && <Alert>{formError}</Alert>}
        <TextField label="Full name" name="name" autoComplete="name" autoFocus value={name} onChange={setName} error={errors.name} />
        <TextField label="Company (optional)" name="company" autoComplete="organization" value={company} onChange={setCompany} error={errors.company} />
        <TextField label="Email" type="email" name="email" autoComplete="email" value={email} onChange={setEmail} error={errors.email} />
        <div style={{ display: 'grid', gap: 8 }}>
          <TextField label="Password" type="password" name="password" autoComplete="new-password" value={password} onChange={setPassword} error={errors.password} />
          <PasswordRules value={password} />
        </div>
        <Button type="submit" block loading={busy}>
          Create account
        </Button>
      </form>
      <p className="auth__foot">
        Already registered? <Link to="/login">Sign in</Link>
      </p>
    </AuthLayout>
  );
}
