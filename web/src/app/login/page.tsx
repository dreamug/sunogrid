import { Suspense } from 'react';
import { AuthForm } from '@/ui/AuthForm';

export default function LoginPage() {
  return (
    <Suspense fallback={<main className="auth"><div className="auth-card">…</div></main>}>
      <AuthForm mode="login" />
    </Suspense>
  );
}
