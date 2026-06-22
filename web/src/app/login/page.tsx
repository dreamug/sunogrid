import { Suspense } from 'react';
import { AuthForm } from '@/ui/AuthForm';

export default function LoginPage() {
  return (
    <Suspense fallback={<main className="auth" />}>
      <AuthForm mode="login" />
    </Suspense>
  );
}
