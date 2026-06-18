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
    if (isReg && password !== confirm) { setErr('两次密码不一致'); return; }
    setBusy(true);
    try {
      const res = await fetch(`/api/auth/${isReg ? 'register' : 'login'}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(isReg ? { username, password, confirm } : { username, password }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { setErr(data.error || '出错了,请重试'); setBusy(false); return; }
      router.replace(next);
      router.refresh();
    } catch {
      setErr('网络错误,请重试');
      setBusy(false);
    }
  };

  return (
    <main className="auth">
      <form className="auth-card" onSubmit={submit}>
        <h1>{isReg ? '注册' : '登录'}</h1>
        <p className="sub">浏览器 AI loop 机 · 你的项目工作台</p>

        <div className="field">
          <label htmlFor="u">用户名</label>
          <input id="u" autoFocus autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="p">密码</label>
          <input id="p" type="password" autoComplete={isReg ? 'new-password' : 'current-password'} value={password} onChange={(e) => setPassword(e.target.value)} />
        </div>
        {isReg && (
          <div className="field">
            <label htmlFor="c">确认密码</label>
            <input id="c" type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
          </div>
        )}

        <p className="auth-err">{err}</p>
        <button className="btn primary" type="submit" disabled={busy}>{busy ? '请稍候…' : isReg ? '注册并进入' : '登录'}</button>

        <p className="auth-alt">
          {isReg ? <>已有账号?<Link href="/login">去登录</Link></> : <>还没账号?<Link href="/register">去注册</Link></>}
        </p>
      </form>
    </main>
  );
}
