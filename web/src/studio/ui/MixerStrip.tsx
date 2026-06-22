'use client';
// 单 sample 乐器的 mixer 外壳 —— GAIN 列:PAN 旋钮在上 + 压缩推子(+实时电平表)在下;EQ 列:三段竖排旋钮(EQ HI / MID / LO)。PAN 上移、推子压矮是为了不抬高整条高度。
// 旋钮/推子都可拖(竖向拖改值,双击复位)。onStart 在拖动开始压一次撤销快照,onChange 实时改。配色走 app 暗色主题。
import { useRef } from 'react';
import type { InstrumentSends, Mixer } from '@/contracts';
import { EQ_DB_RANGE } from '@/contracts';
import type { StudioEngine } from '@/audio/studioEngine';
import { useVoiceLevel } from './live';

const CLAY = '#c2724f';
const TRACK = '#39352f';

function Knob({ label, value, min, max, def = 0, fmt, onStart, onChange }: { label: string; value: number; min: number; max: number; def?: number; fmt: (v: number) => string; onStart: () => void; onChange: (v: number) => void }) {
  const v = Number.isFinite(value) ? value : def; // 兜底:缺字段/旧数据传进 undefined/NaN 不能让 SVG 坐标变 NaN(整条 mixer 崩)
  const st = useRef({ y: 0, v: 0 });
  const down = (e: React.PointerEvent) => {
    e.preventDefault();
    try { (e.target as Element).setPointerCapture?.(e.pointerId); } catch { /* 合成事件/无效 pointerId */ }
    st.current = { y: e.clientY, v };
    let started = false, last = v; // §16:值**真变了**才压栈/emit;纯点击的合成 pointermove(零位移)不产生空 undo 步、不挤掉撤销栈
    const move = (ev: PointerEvent) => { const dv = ((st.current.y - ev.clientY) / 140) * (max - min); const nv = Math.max(min, Math.min(max, st.current.v + dv)); if (nv === last) return; if (!started) { onStart(); started = true; } onChange(nv); last = nv; };
    const up = (ev: PointerEvent) => { (e.target as Element).releasePointerCapture?.(ev.pointerId); window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  const norm = (v - min) / (max - min);
  const a0 = -135, a1 = 135, ang = a0 + norm * (a1 - a0);
  const pt = (deg: number, r: number) => [24 + r * Math.sin((deg * Math.PI) / 180), 24 - r * Math.cos((deg * Math.PI) / 180)];
  const [sx, sy] = pt(a0, 17), [ex, ey] = pt(a1, 17), [vx, vy] = pt(ang, 17), [cx, cy] = pt(ang, 6.5), [lx, ly] = pt(ang, 15.5);
  const valLarge = ang - a0 > 180 ? 1 : 0;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 1, userSelect: 'none' }}>
      <svg width="32" height="32" viewBox="0 0 48 48" onPointerDown={down} onDoubleClick={() => { if (v !== def) { onStart(); onChange(def); } }} style={{ cursor: 'ns-resize', touchAction: 'none' }}>
        <circle cx="24" cy="24" r="17" fill="#2a2825" stroke="#48433b" strokeWidth="1" />
        <path d={`M ${sx} ${sy} A 17 17 0 1 1 ${ex} ${ey}`} fill="none" stroke={TRACK} strokeWidth="3" strokeLinecap="round" />
        <path d={`M ${sx} ${sy} A 17 17 0 ${valLarge} 1 ${vx} ${vy}`} fill="none" stroke={CLAY} strokeWidth="3" strokeLinecap="round" />
        <line x1={cx} y1={cy} x2={lx} y2={ly} stroke="#ece9e3" strokeWidth="2" strokeLinecap="round" />
      </svg>
      <span style={{ fontSize: 8.5, letterSpacing: '.05em', color: '#6f6a60' }}>{label}</span>
      <span style={{ fontSize: 9.5, color: '#ece9e3', fontFamily: 'ui-monospace,monospace' }}>{fmt(v)}</span>
    </div>
  );
}

function Fader({ value, min, max, def = 0, getLevel, live, onStart, onChange }: { value: number; min: number; max: number; def?: number; getLevel?: () => number; live: boolean; onStart: () => void; onChange: (v: number) => void }) {
  const trackRef = useRef<HTMLDivElement | null>(null);
  const level = useVoiceLevel(getLevel, live); // 实时电平条:自驱动 rAF,不靠父树每帧重渲
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
    <div style={{ display: 'flex', gap: 4, alignItems: 'stretch', height: 90 }}>
      <div ref={trackRef} onPointerDown={down} onDoubleClick={() => { if (value !== def) { onStart(); onChange(def); } }} style={{ position: 'relative', width: 22, cursor: 'ns-resize', touchAction: 'none' }}>
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

// sends/onSends 给定 → 多画一个 SEND block(右侧,竖排 3 个 send 旋钮 DIST/DLY/REV);只在乐器级 mixer 传(collage 片级不传)。
// engine+voiceId+playing 给定 → 推子电平条自驱动取该 voice 实时电平(collage 片级不传 = 不画电平)。
export function MixerStrip({ mixer, onMixer, sends, onSends, engine, voiceId, playing }: { mixer: Mixer; onMixer: (patch: Partial<Mixer>, history?: boolean) => void; sends?: InstrumentSends; onSends?: (patch: Partial<InstrumentSends>, history?: boolean) => void; engine?: StudioEngine | null; voiceId?: string; playing?: boolean }) {
  const getLevel = engine && voiceId ? () => engine.voiceLevel(voiceId) : undefined;
  const begin = () => onMixer({}, true);
  const beginS = () => onSends?.({}, true);
  const pctFmt = (v: number) => `${Math.round(v * 100)}`;
  const s2 = (v: number) => Math.round(v * 100) / 100; // send 量 0..1,保两位
  return (
    <div style={{ flex: 'none', borderRight: '1px solid var(--line)', padding: '12px', display: 'flex', flexDirection: 'column', gap: 9, background: 'var(--bg-1)' }}>
      <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
        {/* GAIN 列:PAN 旋钮在上,压缩推子在下(总高与右侧 3 旋钮列对齐 → 不抬高整条) */}
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 7 }}>
          <Knob label="PAN" value={mixer.pan} min={-1} max={1} def={0} fmt={(v) => v.toFixed(1)} onStart={begin} onChange={(v) => onMixer({ pan: Math.round(v * 20) / 20 })} />
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4 }}>
            <Fader value={mixer.gainDb} min={-24} max={6} def={0} getLevel={getLevel} live={!!playing} onStart={begin} onChange={(v) => onMixer({ gainDb: Math.round(v) })} />
            <span style={{ fontSize: 8.5, letterSpacing: '.05em', color: '#6f6a60' }}>GAIN</span>
            <span style={{ fontSize: 9.5, color: 'var(--tx)', fontFamily: 'var(--mono)' }}>{Math.round(mixer.gainDb)}dB</span>
          </div>
        </div>
        {/* EQ 列:三段 HI / MID / LO(频率高→低自上而下) */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
          <Knob label="EQ HI" value={mixer.eq.highDb} min={-EQ_DB_RANGE} max={EQ_DB_RANGE} def={0} fmt={(v) => `${Math.round(v)}`} onStart={begin} onChange={(v) => onMixer({ eq: { ...mixer.eq, highDb: Math.round(v) } })} />
          <Knob label="EQ MID" value={mixer.eq.midDb} min={-EQ_DB_RANGE} max={EQ_DB_RANGE} def={0} fmt={(v) => `${Math.round(v)}`} onStart={begin} onChange={(v) => onMixer({ eq: { ...mixer.eq, midDb: Math.round(v) } })} />
          <Knob label="EQ LO" value={mixer.eq.lowDb} min={-EQ_DB_RANGE} max={EQ_DB_RANGE} def={0} fmt={(v) => `${Math.round(v)}`} onStart={begin} onChange={(v) => onMixer({ eq: { ...mixer.eq, lowDb: Math.round(v) } })} />
        </div>
        {sends && onSends && (
          <>
            {/* 分隔线:撑满行高 + 负 margin 溢出 padding(12px)→ 抵到面板上下内边缘 */}
            <div style={{ alignSelf: 'stretch', width: 1, margin: '-12px 0', background: 'var(--line)', flex: 'none' }} />
            <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }} title="Aux sends to the master effects (FX rack)">
              <Knob label="DIST" value={sends.dist} min={0} max={1} def={0} fmt={pctFmt} onStart={beginS} onChange={(v) => onSends({ dist: s2(v) })} />
              <Knob label="DLY" value={sends.delay} min={0} max={1} def={0} fmt={pctFmt} onStart={beginS} onChange={(v) => onSends({ delay: s2(v) })} />
              <Knob label="REV" value={sends.reverb} min={0} max={1} def={0} fmt={pctFmt} onStart={beginS} onChange={(v) => onSends({ reverb: s2(v) })} />
            </div>
          </>
        )}
      </div>
    </div>
  );
}
