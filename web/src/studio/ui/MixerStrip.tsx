'use client';
// 单 sample 乐器的 mixer 外壳 —— 最左竖排:满高推子(+实时电平表) + 一列竖排旋钮(PAN / EQ HI / EQ LO)。
// 旋钮/推子都可拖(竖向拖改值,双击复位)。onStart 在拖动开始压一次撤销快照,onChange 实时改。配色走 app 暗色主题。
import { useRef } from 'react';
import type { Mixer } from '@/contracts';

const CLAY = '#c2724f';
const TRACK = '#39352f';

function Knob({ label, value, min, max, def = 0, fmt, onStart, onChange }: { label: string; value: number; min: number; max: number; def?: number; fmt: (v: number) => string; onStart: () => void; onChange: (v: number) => void }) {
  const st = useRef({ y: 0, v: 0 });
  const down = (e: React.PointerEvent) => {
    e.preventDefault();
    try { (e.target as Element).setPointerCapture?.(e.pointerId); } catch { /* 合成事件/无效 pointerId */ }
    onStart();
    st.current = { y: e.clientY, v: value };
    const move = (ev: PointerEvent) => { const dv = ((st.current.y - ev.clientY) / 140) * (max - min); onChange(Math.max(min, Math.min(max, st.current.v + dv))); };
    const up = (ev: PointerEvent) => { (e.target as Element).releasePointerCapture?.(ev.pointerId); window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  const norm = (value - min) / (max - min);
  const a0 = -135, a1 = 135, ang = a0 + norm * (a1 - a0);
  const pt = (deg: number, r: number) => [24 + r * Math.sin((deg * Math.PI) / 180), 24 - r * Math.cos((deg * Math.PI) / 180)];
  const [sx, sy] = pt(a0, 17), [ex, ey] = pt(a1, 17), [vx, vy] = pt(ang, 17), [cx, cy] = pt(ang, 6.5), [lx, ly] = pt(ang, 15.5);
  const valLarge = ang - a0 > 180 ? 1 : 0;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 1, userSelect: 'none' }}>
      <svg width="32" height="32" viewBox="0 0 48 48" onPointerDown={down} onDoubleClick={() => { onStart(); onChange(def); }} style={{ cursor: 'ns-resize', touchAction: 'none' }}>
        <circle cx="24" cy="24" r="17" fill="#2a2825" stroke="#48433b" strokeWidth="1" />
        <path d={`M ${sx} ${sy} A 17 17 0 1 1 ${ex} ${ey}`} fill="none" stroke={TRACK} strokeWidth="3" strokeLinecap="round" />
        <path d={`M ${sx} ${sy} A 17 17 0 ${valLarge} 1 ${vx} ${vy}`} fill="none" stroke={CLAY} strokeWidth="3" strokeLinecap="round" />
        <line x1={cx} y1={cy} x2={lx} y2={ly} stroke="#ece9e3" strokeWidth="2" strokeLinecap="round" />
      </svg>
      <span style={{ fontSize: 8.5, letterSpacing: '.05em', color: '#6f6a60' }}>{label}</span>
      <span style={{ fontSize: 9.5, color: '#ece9e3', fontFamily: 'ui-monospace,monospace' }}>{fmt(value)}</span>
    </div>
  );
}

function Fader({ value, min, max, def = 0, level, onStart, onChange }: { value: number; min: number; max: number; def?: number; level: number; onStart: () => void; onChange: (v: number) => void }) {
  const trackRef = useRef<HTMLDivElement | null>(null);
  const norm = (value - min) / (max - min);
  const setFromY = (clientY: number) => { const el = trackRef.current; if (!el) return; const r = el.getBoundingClientRect(); const n = 1 - Math.max(0, Math.min(1, (clientY - r.top) / r.height)); onChange(min + n * (max - min)); };
  const down = (e: React.PointerEvent) => {
    e.preventDefault();
    try { (e.target as Element).setPointerCapture?.(e.pointerId); } catch { /* 合成事件/无效 pointerId */ }
    onStart();
    setFromY(e.clientY);
    const move = (ev: PointerEvent) => setFromY(ev.clientY);
    const up = (ev: PointerEvent) => { (e.target as Element).releasePointerCapture?.(ev.pointerId); window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  return (
    <div style={{ display: 'flex', gap: 4, alignItems: 'stretch', height: 150 }}>
      <div ref={trackRef} onPointerDown={down} onDoubleClick={() => { onStart(); onChange(def); }} style={{ position: 'relative', width: 22, cursor: 'ns-resize', touchAction: 'none' }}>
        <div style={{ position: 'absolute', left: 9, width: 4, top: 0, bottom: 0, background: TRACK, borderRadius: 2 }} />
        <div style={{ position: 'absolute', left: 9, width: 4, bottom: 0, height: `${norm * 100}%`, background: CLAY, borderRadius: 2 }} />
        <div style={{ position: 'absolute', left: 2, width: 18, height: 11, top: `calc(${(1 - norm) * 100}% - 5.5px)`, background: '#cfc9bd', border: '1px solid #7d776c', borderRadius: 2 }} />
      </div>
      <div style={{ width: 5, background: '#2a2825', borderRadius: 2, position: 'relative', overflow: 'hidden' }}>
        <div style={{ position: 'absolute', bottom: 0, left: 0, right: 0, height: `${Math.round(level * 100)}%`, background: 'linear-gradient(to top,#7c8a6a,#c2a24f,#c2724f)' }} />
      </div>
    </div>
  );
}

export function MixerStrip({ mixer, level, onMixer }: { mixer: Mixer; level: number; onMixer: (patch: Partial<Mixer>, history?: boolean) => void }) {
  const begin = () => onMixer({}, true);
  return (
    <div style={{ flex: 'none', borderRight: '1px solid var(--line)', padding: '12px', display: 'flex', flexDirection: 'column', gap: 9, background: 'var(--bg-1)' }}>
      <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4 }}>
          <Fader value={mixer.gainDb} min={-24} max={6} def={0} level={level} onStart={begin} onChange={(v) => onMixer({ gainDb: Math.round(v) })} />
          <span style={{ fontSize: 8.5, letterSpacing: '.05em', color: '#6f6a60' }}>GAIN</span>
          <span style={{ fontSize: 9.5, color: 'var(--tx)', fontFamily: 'var(--mono)' }}>{Math.round(mixer.gainDb)}dB</span>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
          <Knob label="PAN" value={mixer.pan} min={-1} max={1} def={0} fmt={(v) => v.toFixed(1)} onStart={begin} onChange={(v) => onMixer({ pan: Math.round(v * 20) / 20 })} />
          <Knob label="EQ HI" value={mixer.eq.highDb} min={-12} max={12} def={0} fmt={(v) => `${Math.round(v)}`} onStart={begin} onChange={(v) => onMixer({ eq: { ...mixer.eq, highDb: Math.round(v) } })} />
          <Knob label="EQ LO" value={mixer.eq.lowDb} min={-12} max={12} def={0} fmt={(v) => `${Math.round(v)}`} onStart={begin} onChange={(v) => onMixer({ eq: { ...mixer.eq, lowDb: Math.round(v) } })} />
        </div>
      </div>
    </div>
  );
}
