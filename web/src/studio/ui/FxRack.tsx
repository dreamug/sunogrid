'use client';
// 主总线效果器浮层(§17)—— 顶栏最右 FX 按钮,点开三栏 insert:失真 / 延迟 / 混响。
// 旋钮沿用 MixerStrip 画法(竖拖改值 / 双击复位)。改参数即时 onFx → 引擎 setFx + 防抖持久化(在 StudioApp)。
// 浮层右对齐(right:0 向左展开),点外/Esc 关闭,沿用 Metronome 范式。
import { useEffect, useRef, useState } from 'react';
import type { FxConfig, FxDelay, FxDistortion, FxReverb } from '@/contracts';

const CLAY = '#c2724f', TRACK = '#39352f';
const pct = (v: number) => `${Math.round(v * 100)}%`;
const cap = (s: string) => s[0].toUpperCase() + s.slice(1);

function Knob({ label, value, min, max, def, fmt, onStart, onChange }: { label: string; value: number; min: number; max: number; def: number; fmt: (v: number) => string; onStart: () => void; onChange: (v: number) => void }) {
  const st = useRef({ y: 0, v: 0 });
  const down = (e: React.PointerEvent) => {
    e.preventDefault();
    try { (e.target as Element).setPointerCapture?.(e.pointerId); } catch { /* 合成事件 */ }
    st.current = { y: e.clientY, v: value };
    let started = false, last = value; // §16:值**真变了**才压栈/emit;纯点击的合成 pointermove(零位移)不产生空 undo 步
    const move = (ev: PointerEvent) => { const dv = ((st.current.y - ev.clientY) / 140) * (max - min); const nv = Math.max(min, Math.min(max, st.current.v + dv)); if (nv === last) return; if (!started) { onStart(); started = true; } onChange(nv); last = nv; };
    const up = (ev: PointerEvent) => { (e.target as Element).releasePointerCapture?.(ev.pointerId); window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  const norm = (value - min) / (max - min);
  const a0 = -135, a1 = 135, ang = a0 + norm * (a1 - a0);
  const pt = (deg: number, r: number) => [24 + r * Math.sin((deg * Math.PI) / 180), 24 - r * Math.cos((deg * Math.PI) / 180)];
  const [sx, sy] = pt(a0, 17), [ex, ey] = pt(a1, 17), [vx, vy] = pt(ang, 17), [cx, cy] = pt(ang, 6.5), [lx, ly] = pt(ang, 15.5);
  const big = ang - a0 > 180 ? 1 : 0;
  return (
    <div className="fx-k">
      <svg width="38" height="38" viewBox="0 0 48 48" onPointerDown={down} onDoubleClick={() => { if (value !== def) { onStart(); onChange(def); } }} style={{ cursor: 'ns-resize', touchAction: 'none' }}>
        <circle cx="24" cy="24" r="17" fill="#2a2825" stroke="#48433b" strokeWidth="1" />
        <path d={`M ${sx} ${sy} A 17 17 0 1 1 ${ex} ${ey}`} fill="none" stroke={TRACK} strokeWidth="3" strokeLinecap="round" />
        <path d={`M ${sx} ${sy} A 17 17 0 ${big} 1 ${vx} ${vy}`} fill="none" stroke={CLAY} strokeWidth="3" strokeLinecap="round" />
        <line x1={cx} y1={cy} x2={lx} y2={ly} stroke="#ece9e3" strokeWidth="2" strokeLinecap="round" />
      </svg>
      <span className="fx-kl">{label}</span>
      <span className="fx-kv">{fmt(value)}</span>
    </div>
  );
}

function Power({ on, onClick }: { on: boolean; onClick: () => void }) {
  return (
    <button type="button" className={'fx-pw' + (on ? ' on' : '')} aria-pressed={on} onClick={onClick} title={on ? 'On — click to bypass' : 'Bypassed — click to enable'}>
      <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" aria-hidden="true"><path d="M12 3v8" /><path d="M6.5 7a8 8 0 1 0 11 0" /></svg>
      {on ? 'ON' : 'BYP'}
    </button>
  );
}

const SYNCS: FxDelay['sync'][] = ['1/4', '1/8', '1/8.', '1/16', 'ms'];
const CHARS: FxDistortion['character'][] = ['soft', 'hard', 'fuzz'];

export function FxRack({ fx, bpm, onFx, onStart }: { fx: FxConfig; bpm: number; onFx: (next: FxConfig) => void; onStart: () => void }) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (ev: MouseEvent) => { if (!wrapRef.current?.contains(ev.target as Node)) setOpen(false); };
    const onKey = (ev: KeyboardEvent) => { if (ev.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDoc); document.removeEventListener('keydown', onKey); };
  }, [open]);

  const d = fx.distortion, dl = fx.delay, rv = fx.reverb;
  const setD = (p: Partial<FxDistortion>) => onFx({ ...fx, distortion: { ...d, ...p } });
  const setDl = (p: Partial<FxDelay>) => onFx({ ...fx, delay: { ...dl, ...p } });
  const setRv = (p: Partial<FxReverb>) => onFx({ ...fx, reverb: { ...rv, ...p } });
  const anyOn = d.on || dl.on || rv.on;

  const q = 60 / bpm; // 四分音符秒 → 同步分割毫秒(显示用)
  const syncMs = dl.sync === 'ms' ? dl.timeMs : Math.round((dl.sync === '1/4' ? q : dl.sync === '1/8' ? q / 2 : dl.sync === '1/8.' ? q * 0.75 : q / 4) * 1000);

  return (
    <div className="fx-wrap" ref={wrapRef}>
      <button className={'fx-btn' + (anyOn ? ' on' : '')} aria-pressed={open} title="Master effects — distortion · delay · reverb" onClick={() => setOpen((o) => !o)}>
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><circle cx="7" cy="8" r="2" /><circle cx="17" cy="16" r="2" /><path d="M3 8h2M9 8h12M3 16h12M19 16h2" /></svg>
        FX
      </button>
      {open && (
        <div className="fx-pop" role="dialog" aria-label="Master effects">
          <div className="fx-head">
            <span className="sec-l">Effects · aux returns</span>
            <span className="fx-chain">SENDS ▸ <b style={{ color: d.on ? CLAY : 'var(--tx-3)' }}>DIST</b> · <b style={{ color: dl.on ? CLAY : 'var(--tx-3)' }}>DELAY</b> · <b style={{ color: rv.on ? CLAY : 'var(--tx-3)' }}>REVERB</b> ▸ OUT</span>
          </div>
          <div className="fx-grid">

            <div className={'fx-mod' + (d.on ? '' : ' off')}>
              <div className="fx-mh"><span className="fx-name">Distortion</span><Power on={d.on} onClick={() => { onStart(); setD({ on: !d.on }); }} /></div>
              <div className="fx-row">{CHARS.map((ch) => <button key={ch} type="button" className={'fx-chip' + (d.character === ch ? ' on' : '')} onClick={() => { if (d.character !== ch) { onStart(); setD({ character: ch }); } }}>{cap(ch)}</button>)}</div>
              <div className="fx-knobs">
                <Knob label="DRIVE" value={d.drive} min={0} max={1} def={0.3} fmt={pct} onStart={onStart} onChange={(v) => setD({ drive: v })} />
                <Knob label="TONE" value={d.tone} min={0} max={1} def={0.5} fmt={pct} onStart={onStart} onChange={(v) => setD({ tone: v })} />
                <Knob label="LVL" value={d.mix} min={0} max={1} def={1} fmt={pct} onStart={onStart} onChange={(v) => setD({ mix: v })} />
              </div>
              <span className="fx-note">waveshaper · 4× oversample</span>
            </div>

            <div className={'fx-mod' + (dl.on ? '' : ' off')}>
              <div className="fx-mh"><span className="fx-name">Delay</span><Power on={dl.on} onClick={() => { onStart(); setDl({ on: !dl.on }); }} /></div>
              <div className="fx-row">{SYNCS.map((s) => <button key={s} type="button" className={'fx-chip' + (dl.sync === s ? ' on' : '')} onClick={() => { if (dl.sync !== s) { onStart(); setDl({ sync: s }); } }}>{s}</button>)}</div>
              <div className="fx-knobs">
                {dl.sync === 'ms' && <Knob label="TIME" value={dl.timeMs} min={20} max={1000} def={250} fmt={(v) => `${Math.round(v)}ms`} onStart={onStart} onChange={(v) => setDl({ timeMs: Math.round(v) })} />}
                <Knob label="FBK" value={dl.feedback} min={0} max={0.95} def={0.35} fmt={pct} onStart={onStart} onChange={(v) => setDl({ feedback: v })} />
                <Knob label="TONE" value={dl.tone} min={0} max={1} def={0.5} fmt={pct} onStart={onStart} onChange={(v) => setDl({ tone: v })} />
                <Knob label="LVL" value={dl.mix} min={0} max={1} def={0.3} fmt={pct} onStart={onStart} onChange={(v) => setDl({ mix: v })} />
              </div>
              <div className="fx-row" style={{ justifyContent: 'center', alignItems: 'center', gap: 8 }}>
                <button type="button" className={'fx-chip' + (dl.pingpong ? ' on' : '')} onClick={() => { onStart(); setDl({ pingpong: !dl.pingpong }); }}>Ping-pong</button>
                <span className="fx-note">{dl.sync === 'ms' ? 'free' : `≈ ${syncMs} ms`}</span>
              </div>
            </div>

            <div className={'fx-mod' + (rv.on ? '' : ' off')}>
              <div className="fx-mh"><span className="fx-name">Reverb</span><Power on={rv.on} onClick={() => { onStart(); setRv({ on: !rv.on }); }} /></div>
              <div className="fx-knobs">
                <Knob label="DECAY" value={rv.decay} min={0.3} max={12} def={2.5} fmt={(v) => `${v.toFixed(1)}s`} onStart={onStart} onChange={(v) => setRv({ decay: v })} />
                <Knob label="PRE" value={rv.preDelay} min={0} max={0.15} def={0.02} fmt={(v) => `${Math.round(v * 1000)}ms`} onStart={onStart} onChange={(v) => setRv({ preDelay: v })} />
                <Knob label="DAMP" value={rv.damp} min={0} max={1} def={0.5} fmt={pct} onStart={onStart} onChange={(v) => setRv({ damp: v })} />
                <Knob label="LVL" value={rv.mix} min={0} max={1} def={0.3} fmt={pct} onStart={onStart} onChange={(v) => setRv({ mix: v })} />
              </div>
              <span className="fx-note">convolution IR</span>
            </div>

          </div>
        </div>
      )}
    </div>
  );
}
