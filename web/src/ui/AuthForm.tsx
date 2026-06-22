'use client';
// 登录/注册共用表单。注册=用户名+密码+确认密码,登录=用户名+密码。成功跳 next || /projects。
// 左品牌面板(波形 hero)+ 右表单双栏;面板下方一个插件 block(下载 / 安装步骤 / 学习用途风险声明,细线分隔)。
import { useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';

// 一段"音频片段"的波形(build→peak→decay→tail);播放头扫过点亮陶土色,呼应 pad 已播 fill。
const WAVE = [
  0.22, 0.3, 0.26, 0.4, 0.34, 0.5, 0.44, 0.62, 0.55, 0.72, 0.66,
  0.84, 0.7, 0.9, 0.6, 0.78, 0.52, 0.66, 0.46, 0.58, 0.38, 0.5,
  0.62, 0.74, 0.86, 0.7, 0.56, 0.68, 0.8, 0.64, 0.5, 0.6, 0.72,
  0.84, 0.58, 0.46, 0.54, 0.66, 0.42, 0.5, 0.34, 0.4, 0.28, 0.24,
];

const Logo = () => (
  <span className="ab-logo">
    <svg width="13" height="13" viewBox="0 0 13 13" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
      <path d="M3 8.5v-4M6.5 10.7v-8.4M10 7.3v-1.6" />
    </svg>
  </span>
);

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
      <div className="auth-stack">
        <div className="auth-shell">
          <aside className="auth-brand">
            <div className="ab-mark"><Logo /><span className="ab-word">sunogrid</span></div>
            <div className="ab-hero">
              <h2>Make loops<br />out of anything.</h2>
              <p>Generate with Suno, warp to the grid, and arrange into a track — all in the browser.</p>
            </div>
            <div className="ab-foot">
              <div className="auth-wave" aria-hidden="true">
                <div className="aw-bars aw-base">{WAVE.map((h, i) => <span key={i} style={{ height: `${Math.round(h * 100)}%` }} />)}</div>
                <div className="aw-bars aw-fill">{WAVE.map((h, i) => <span key={i} style={{ height: `${Math.round(h * 100)}%` }} />)}</div>
                <span className="aw-head" />
              </div>
              <div className="ab-meta">120 BPM · C maj · 4 bars</div>
            </div>
          </aside>

          <form className="auth-card" onSubmit={submit}>
            <div className="ac-mark"><Logo /><span className="ab-word">sunogrid</span></div>
            <h1>{isReg ? 'Create your account' : 'Welcome back'}</h1>
            <p className="sub">{isReg ? 'Start building your first loop.' : 'Log in to your loop workbench.'}</p>

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
        </div>

        {/* Suno 桥接插件:没上商店,下载未打包扩展 + 开发者模式加载;声明仅供学习、账号风险自负。 */}
        <div className="auth-ext">
          <div className="ax-main">
            <span className="ax-icon"><img src="/suno.png" alt="Suno" width={34} height={34} /></span>
            <div className="ax-t">
              <div className="ax-tt">Suno Bridge extension</div>
              <div className="ax-ts">Needed to generate — it runs in your own browser. Install once.</div>
            </div>
            <a className="ax-dl" href="/suno-bridge.zip" download>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M12 3v12M7 10l5 5 5-5M5 21h14" />
              </svg>
              Download .zip
            </a>
          </div>
          <div className="ax-steps">
            <span><span className="ax-n">1</span>open <em>chrome://extensions</em></span><span className="ax-sep">→</span>
            <span><span className="ax-n">2</span>turn on <em>Developer mode</em></span><span className="ax-sep">→</span>
            <span><span className="ax-n">3</span><em>Load unpacked</em> → pick the folder</span>
          </div>
          <div className="ax-warn">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M12 3l9 16H3z" /><path d="M12 10v4M12 17.4v.01" />
            </svg>
            <p><b>For learning &amp; research only.</b> Replaying Suno's private API can get your account rate-limited or banned — your account, your risk.</p>
          </div>
        </div>
      </div>
    </main>
  );
}
