import { Navigate, Route, Routes } from 'react-router-dom';
import { PublicOnly, RequireAuth } from './auth';
import { AppShell } from './layout/AppShell';
import { CalculatorPage } from './pages/Calculator';
import { DevMailboxPage } from './pages/DevMailbox';
import { DiscountsPage } from './pages/Discounts';
import { LoginPage } from './pages/Login';
import { OverviewPage } from './pages/Overview';
import { ForgotPasswordPage, ResetPasswordPage } from './pages/PasswordReset';
import { PlansPage } from './pages/Plans';
import { ProductsPage } from './pages/Products';
import { SignupPage } from './pages/Signup';
import { TaxesPage } from './pages/Taxes';
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

        <Route path="products" element={<RequireAuth roles={['admin', 'staff']}><ProductsPage /></RequireAuth>} />
        <Route path="plans" element={<RequireAuth roles={['admin', 'staff']}><PlansPage /></RequireAuth>} />
        <Route path="taxes" element={<RequireAuth roles={['admin', 'staff']}><TaxesPage /></RequireAuth>} />
        <Route path="discounts" element={<RequireAuth roles={['admin', 'staff']}><DiscountsPage /></RequireAuth>} />
        <Route path="calculator" element={<RequireAuth roles={['admin', 'staff']}><CalculatorPage /></RequireAuth>} />
        <Route path="team" element={<RequireAuth roles={['admin']}><TeamPage /></RequireAuth>} />
        {import.meta.env.DEV && <Route path="dev/mailbox" element={<RequireAuth roles={['admin']}><DevMailboxPage /></RequireAuth>} />}
      </Route>

      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
