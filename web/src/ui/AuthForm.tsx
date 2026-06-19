'use client';
// 登录/注册共用表单。注册=用户名+密码+确认密码,登录=用户名+密码。成功跳 next || /projects。
import { useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';

export function AuthForm({ mode }: { mode: 'login' | 'register' }) {
  const router = useRouter();
  const sp = useSearchParams();
  const next = sp.get('next') || '/projects';
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const isReg = mode === 'register';

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setErr('');
    if (isReg && password !== confirm) { setErr("Passwords don't match"); return; }
    setBusy(true);
    try {
      const res = await fetch(`/api/auth/${isReg ? 'register' : 'login'}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(isReg ? { username, password, confirm } : { username, password }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { setErr(data.error || 'Something went wrong, please try again'); setBusy(false); return; }
      router.replace(next);
      router.refresh();
    } catch {
      setErr('Network error, please try again');
      setBusy(false);
    }
  };

  return (
    <main className="auth">
      <form className="auth-card" onSubmit={submit}>
        <h1>{isReg ? 'Sign up' : 'Log in'}</h1>
        <p className="sub">Browser AI loop machine · your project workbench</p>

        <div className="field">
          <label htmlFor="u">Username</label>
          <input id="u" autoFocus autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="p">Password</label>
          <input id="p" type="password" autoComplete={isReg ? 'new-password' : 'current-password'} value={password} onChange={(e) => setPassword(e.target.value)} />
        </div>
        {isReg && (
          <div className="field">
            <label htmlFor="c">Confirm password</label>
            <input id="c" type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
          </div>
        )}

        <p className="auth-err">{err}</p>
        <button className="btn primary" type="submit" disabled={busy}>{busy ? 'Submitting…' : isReg ? 'Sign up' : 'Log in'}</button>

        <p className="auth-alt">
          {isReg ? <>Have an account? <Link href="/login">Log in</Link></> : <>No account? <Link href="/register">Sign up</Link></>}
        </p>
      </form>
    </main>
  );
}
