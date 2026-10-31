import { Navigate, Route, Routes } from 'react-router-dom';
import { PublicOnly, RequireAuth } from './auth';
import { AppShell } from './layout/AppShell';
import { DevMailboxPage } from './pages/DevMailbox';
import { LoginPage } from './pages/Login';
import { OverviewPage } from './pages/Overview';
import { ForgotPasswordPage, ResetPasswordPage } from './pages/PasswordReset';
import { SignupPage } from './pages/Signup';
import { TeamPage } from './pages/Team';

export function App() {
  return (
    <Routes>
      <Route path="/login" element={<PublicOnly><LoginPage /></PublicOnly>} />
      <Route path="/signup" element={<PublicOnly><SignupPage /></PublicOnly>} />
      <Route path="/forgot-password" element={<PublicOnly><ForgotPasswordPage /></PublicOnly>} />
      <Route path="/reset-password" element={<ResetPasswordPage />} />

      <Route element={<RequireAuth><AppShell /></RequireAuth>}>
        <Route index element={<OverviewPage />} />
        <Route path="team" element={<RequireAuth roles={['admin']}><TeamPage /></RequireAuth>} />
        {import.meta.env.DEV && <Route path="dev/mailbox" element={<RequireAuth roles={['admin']}><DevMailboxPage /></RequireAuth>} />}
      </Route>

      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
