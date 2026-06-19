'use client';
// 生成区的 Suno 连接状态灯(③ 插件预检):方块里一颗圆 LED —— 绿=就绪、红=有问题、灰闪=检测中。
// 点开 popover 给具体状态 + 修复提示 + 重新检测。探测走 sunoBridge.status()(插件没响应会 8s 超时 → 红)。
import { useEffect, useRef, useState } from 'react';
import { sunoBridge } from '@/studio/sunoBridge';

type State = 'checking' | 'ready' | 'problem';

export function SunoStatus() {
  const [st, setSt] = useState<State>('checking');
  const [msg, setMsg] = useState({ title: 'Checking…', detail: 'Connecting to the Suno plugin…' });
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const seq = useRef(0); // 防竞态:只认最后一次探测的结果

  const probe = async () => {
    const my = ++seq.current;
    setSt('checking');
    setMsg({ title: 'Checking…', detail: 'Connecting to the Suno plugin…' });
    try {
      const s = await sunoBridge.status();
      if (my !== seq.current) return;
      // 绿 = 已登录即可生成(模板首次生成时自动捕获,不作硬条件)。
      if (s.hasAuth) setMsgSt('ready', 'Suno ready', s.hasTemplate ? 'Plugin connected, logged in to suno.com — ready to generate.' : 'Plugin connected & logged in — ready to generate (template captured on first run).');
      else setMsgSt('problem', 'Not logged in to suno.com', 'Plugin connected, but no login detected. Open a logged-in suno.com tab.');
    } catch {
      if (my !== seq.current) return;
      setMsgSt('problem', 'Plugin not connected', 'No response from the plugin. Make sure the Suno bridge plugin is installed and a logged-in suno.com tab is open, then re-check.');
    }
  };
  const setMsgSt = (s: State, title: string, detail: string) => { setSt(s); setMsg({ title, detail }); };

  useEffect(() => { probe(); }, []);
  // 点外面关 popover
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => { if (!wrapRef.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  const dot = st === 'ready' ? 'ok' : st === 'problem' ? 'err' : 'checking';
  return (
    <div className="suno-st" ref={wrapRef}>
      <button
        type="button"
        className="suno-led"
        title={'Suno connection: ' + msg.title}
        aria-label={'Suno connection: ' + msg.title}
        onClick={() => { const willOpen = !open; setOpen(willOpen); if (willOpen && st !== 'checking') probe(); }}
      >
        <span className={'sled ' + dot} />
      </button>
      {open && (
        <div className="suno-pop" role="dialog">
          <div className="sp-h"><span className={'sled ' + dot} /><span className="sp-t">{msg.title}</span></div>
          <div className="sp-d">{msg.detail}</div>
          <button type="button" className="sp-re" onClick={probe} disabled={st === 'checking'}>{st === 'checking' ? 'Checking…' : 'Re-check'}</button>
        </div>
      )}
    </div>
  );
}
