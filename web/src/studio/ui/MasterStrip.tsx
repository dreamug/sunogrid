'use client';
// §42 Master Strip(总线母带链 / 缩混)浮层 —— 顶栏触发,点开模拟母带机面板:双 VU 指针表(IEC 60268-17)
// + GR 表 + LUFS/真峰读数 + memoryless 三件套(EQ / 饱和 / 立体声宽度)+ opt-in 动态(GLUE/LIMIT, v2)。
// 视觉铁律(§42.8):不做镀铬/玻璃皮肤,只翻译模拟表几何 + 我们的暖黑/陶土调色板;指针 ~300ms 弹道是灵魂。
// 旋钮/chip/电源键沿用 FxRack 画法;改参即时 onFx → 引擎 setFx + 防抖持久化(在 StudioApp)。
import { useEffect, useRef, useState } from 'react';
import type { FxConfig, MasterConfig, MasterEq, MasterComp, MasterSat, MasterWidth, MasterLimiter } from '@/contracts';
import type { StudioEngine } from '@/audio/studioEngine';
import { MASTER_PRESETS } from '@/studio/masterPresets';
import { useFrame } from './live';

const CLAY = '#c2724f', TRACK = '#39352f';
const pct = (v: number) => `${Math.round(v * 100)}%`;
const dbf = (v: number) => `${v > 0 ? '+' : ''}${v.toFixed(1)}`;

// ---------------- 旋钮 / 电源键(沿用 FxRack 画法:竖拖 140px=满量程,双击复位)----------------
function Knob({ label, value, min, max, def, fmt, dim, onStart, onChange }: { label: string; value: number; min: number; max: number; def: number; fmt: (v: number) => string; dim?: boolean; onStart: () => void; onChange: (v: number) => void }) {
  const st = useRef({ y: 0, v: 0 });
  const down = (e: React.PointerEvent) => {
    e.preventDefault();
    try { (e.target as Element).setPointerCapture?.(e.pointerId); } catch { /* */ }
    st.current = { y: e.clientY, v: value };
    let started = false, last = value;
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
        <path d={`M ${sx} ${sy} A 17 17 0 ${big} 1 ${vx} ${vy}`} fill="none" stroke={dim ? '#5b554c' : CLAY} strokeWidth="3" strokeLinecap="round" />
        <line x1={cx} y1={cy} x2={lx} y2={ly} stroke={dim ? '#8d877c' : '#ece9e3'} strokeWidth="2" strokeLinecap="round" />
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

// ---------------- 双 VU 指针表(IEC:−20..+3 VU,线性于振幅 ⟹ 0VU 右偏 ~69%,红区 0..+3)----------------
const VU_MIN = -20, VU_MAX = 3, TH0 = -47, TH1 = 43;
const vamp = (v: number) => Math.pow(10, v / 20);
const VAMIN = vamp(VU_MIN), VASPAN = vamp(VU_MAX) - VAMIN;
const vuAngle = (v: number) => TH0 + ((vamp(v) - VAMIN) / VASPAN) * (TH1 - TH0);
// 归一电平 0..1(= masterPeakRaw,[−48,0]dBFS 线性)→ VU(给 6dB headroom:−6dBFS≈0VU)→ 角度
const levelToAngle = (n: number) => vuAngle(Math.max(VU_MIN, Math.min(VU_MAX, (n * 48 - 48) + 6)));
const vpt = (deg: number, r: number): [number, number] => { const t = (deg * Math.PI) / 180; return [110 + r * Math.sin(t), 165 - r * Math.cos(t)]; };
const VU_MAJORS = [-20, -10, -7, -5, -3, -1, 0, 1, 2, 3];
const VU_MINORS = [-15, -12, -8, -6, -4, -2, -0.5, 0.5, 1.5, 2.5];
function buildVuFace(): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  VU_MINORS.forEach((v, i) => { const a = vuAngle(v), [ix, iy] = vpt(a, 121), [ox, oy] = vpt(a, 130), red = v >= 0; out.push(<line key={'mi' + i} x1={ix} y1={iy} x2={ox} y2={oy} stroke={red ? 'rgba(229,86,75,.55)' : '#5b554c'} strokeWidth={1} />); });
  VU_MAJORS.forEach((v, i) => {
    const a = vuAngle(v), [ix, iy] = vpt(a, 117), [ox, oy] = vpt(a, 131), [lx, ly] = vpt(a, 103), red = v >= 0;
    out.push(<line key={'ma' + i} x1={ix} y1={iy} x2={ox} y2={oy} stroke={red ? '#e5564b' : '#cfc9bd'} strokeWidth={v === 0 ? 2.4 : 1.6} />);
    out.push(<text key={'mt' + i} x={lx} y={ly} fill={red ? '#e5564b' : '#9b958a'} fontSize={8.5} textAnchor="middle" dominantBaseline="middle" fontFamily="var(--mono)">{v > 0 ? '+' + v : '' + v}</text>);
  });
  const [b0x, b0y] = vpt(TH0, 127.5), [b1x, b1y] = vpt(TH1, 127.5);
  out.push(<path key="base" d={`M ${b0x} ${b0y} A 127.5 127.5 0 0 1 ${b1x} ${b1y}`} fill="none" stroke="#6f6a60" strokeWidth={1.2} />);
  const [r0x, r0y] = vpt(vuAngle(0), 124.5), [r1x, r1y] = vpt(vuAngle(3), 124.5);
  out.push(<path key="red" d={`M ${r0x} ${r0y} A 124.5 124.5 0 0 1 ${r1x} ${r1y}`} fill="none" stroke="#e5564b" strokeWidth={4.6} strokeLinecap="round" opacity={0.9} />);
  return out;
}
const VU_FACE = buildVuFace();

function VuFace({ label, angle, hot }: { label: string; angle: number; hot: boolean }) {
  return (
    <div className="ms-vu">
      <span className={'ms-led' + (hot ? ' on' : '')} aria-hidden="true" />
      <svg viewBox="0 0 220 150">
        <defs><radialGradient id={'vg' + label} cx="50%" cy="96%" r="62%"><stop offset="0%" stopColor="rgba(194,114,79,.16)" /><stop offset="55%" stopColor="rgba(194,114,79,.04)" /><stop offset="100%" stopColor="rgba(194,114,79,0)" /></radialGradient></defs>
        <rect x="2" y="2" width="216" height="146" rx="3" fill="#1c1b19" />
        <rect x="2" y="2" width="216" height="146" rx="3" fill={`url(#vg${label})`} />
        {VU_FACE}
        <text x="186" y="118" fill="#9b958a" fontSize="11" letterSpacing="1.5" textAnchor="middle" fontFamily="var(--mono)">VU</text>
        <g transform={`rotate(${angle.toFixed(2)} 110 165)`}><line x1="110" y1="165" x2="110" y2="37" stroke="#ece9e3" strokeWidth="1.8" strokeLinecap="round" /></g>
        <path d="M97 150 L103 138 H117 L123 150 Z" fill="#26241f" stroke="#48433b" strokeWidth="1" />
        <circle cx="110" cy="148" r="3.4" fill="#322f2b" stroke="#5b554c" strokeWidth="1" />
      </svg>
      <span className="ms-vu-cap">{label}</span>
    </div>
  );
}

function VuMeters({ engine, playing }: { engine: StudioEngine | null; playing: boolean }) {
  useFrame(!!engine && playing);
  const sm = useRef<[number, number]>([0, 0]);
  const raw: [number, number] = playing && engine ? engine.masterPeakRaw() : [0, 0];
  const A = 0.06; // ~300ms @60fps 弹道平滑
  sm.current = [sm.current[0] + (raw[0] - sm.current[0]) * A, sm.current[1] + (raw[1] - sm.current[1]) * A];
  return (
    <div className="ms-vus">
      <VuFace label="L" angle={levelToAngle(sm.current[0])} hot={sm.current[0] >= 0.9375} />
      <VuFace label="R" angle={levelToAngle(sm.current[1])} hot={sm.current[1] >= 0.9375} />
    </div>
  );
}

// ---------------- GR 指针小表(停 0/右,压缩向左摆;v1 gr 恒 0)----------------
const GT0 = -42, GT1 = 42;
const gpt = (deg: number, r: number): [number, number] => { const t = (deg * Math.PI) / 180; return [80 + r * Math.sin(t), 120 - r * Math.cos(t)]; };
const grAngle = (gr: number) => GT1 - (Math.min(20, Math.max(0, gr)) / 20) * (GT1 - GT0);
function buildGrFace(): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  [0, 2, 4, 6, 10, 15, 20].forEach((d, i) => {
    const a = grAngle(d), [ix, iy] = gpt(a, 64), [ox, oy] = gpt(a, 73), [lx, ly] = gpt(a, 54);
    out.push(<line key={'g' + i} x1={ix} y1={iy} x2={ox} y2={oy} stroke={d === 0 ? '#cfc9bd' : '#5b554c'} strokeWidth={d === 0 ? 1.8 : 1.1} />);
    out.push(<text key={'gt' + i} x={lx} y={ly} fill="#7a746a" fontSize={6.5} textAnchor="middle" dominantBaseline="middle" fontFamily="var(--mono)">{d === 0 ? '0' : '-' + d}</text>);
  });
  const [b0x, b0y] = gpt(GT0, 68.5), [b1x, b1y] = gpt(GT1, 68.5);
  out.push(<path key="gb" d={`M ${b0x} ${b0y} A 68.5 68.5 0 0 1 ${b1x} ${b1y}`} fill="none" stroke="#6f6a60" strokeWidth={1} />);
  return out;
}
const GR_FACE = buildGrFace();
function GrMeter({ gr }: { gr: number }) {
  const [tx, ty] = gpt(grAngle(gr), 70);
  return (
    <div className="ms-gr">
      <svg viewBox="0 0 160 86">{GR_FACE}<line x1="80" y1="120" x2={tx} y2={ty} stroke="#a39d92" strokeWidth="1.5" strokeLinecap="round" /><circle cx="80" cy="120" r="3" fill="#322f2b" stroke="#5b554c" strokeWidth="1" /></svg>
      <div className="ms-gr-foot"><span>GAIN REDUCTION</span><b>{gr > 0.05 ? `-${gr.toFixed(1)}` : '0.0'} dB</b></div>
    </div>
  );
}

// ---------------- 右栏:GR 表 + LUFS/真峰读数(单组件每帧调一次 masterMeters,避免双推积分)----------------
function MasterScope({ engine, playing }: { engine: StudioEngine | null; playing: boolean }) {
  useFrame(!!engine && playing);
  const m = playing && engine ? engine.masterMeters() : null;
  const lf = (v: number | undefined) => (v == null || v <= -99 ? '—' : v.toFixed(1));
  const tp = m && m.tpL > -99 ? `${m.tpL.toFixed(1)}/${m.tpR.toFixed(1)}` : '—';
  return (
    <div className="ms-right">
      <GrMeter gr={m?.gr ?? 0} />
      <div className="ms-ro">
        <div className="ro"><span>LUFS-S</span><b>{lf(m?.lufsST)}</b></div>
        <div className="ro"><span>LUFS-I</span><b>{lf(m?.lufsI)}</b></div>
        <div className="ro"><span>TRUE&nbsp;PK</span><b>{tp}</b></div>
      </div>
    </div>
  );
}

// ====================== 主组件 ======================
export function MasterStrip({ fx, engine, playing, onFx, onStart }: { fx: FxConfig; engine: StudioEngine | null; playing: boolean; onFx: (next: FxConfig) => void; onStart: () => void }) {
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

  const m = fx.master, eq = m.eq, comp = m.comp, sat = m.sat, w = m.width, lim = m.limiter;
  const setM = (p: Partial<MasterConfig>) => onFx({ ...fx, master: { ...m, ...p } });
  const setEq = (p: Partial<MasterEq>) => onFx({ ...fx, master: { ...m, eq: { ...eq, ...p } } });
  const setComp = (p: Partial<MasterComp>) => onFx({ ...fx, master: { ...m, comp: { ...comp, ...p } } });
  const setSat = (p: Partial<MasterSat>) => onFx({ ...fx, master: { ...m, sat: { ...sat, ...p } } });
  const setW = (p: Partial<MasterWidth>) => onFx({ ...fx, master: { ...m, width: { ...w, ...p } } });
  const setLim = (p: Partial<MasterLimiter>) => onFx({ ...fx, master: { ...m, limiter: { ...lim, ...p } } });
  const applyPreset = (cfg: MasterConfig) => { onStart(); onFx({ ...fx, master: cfg }); };
  const anyOn = m.on && (eq.on || sat.on || w.on); // 触发键高亮:strip 在且有段开着
  const stageCol = (on: boolean) => (m.on && on ? CLAY : 'var(--tx-3)');
  const CHARS: MasterSat['character'][] = ['tape', 'tube', 'soft'];

  return (
    <div className="fx-wrap" ref={wrapRef}>
      <button className={'fx-btn' + (anyOn ? ' on' : '')} aria-pressed={open} title="Master strip — mastering / 缩混" onClick={() => setOpen((o) => !o)}>
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M4 14a8 8 0 0 1 16 0" /><path d="M12 14l4-3" /><circle cx="12" cy="14" r="1.3" fill="currentColor" stroke="none" /></svg>
        MASTER
      </button>
      {open && (
        <div className={'fx-pop ms-pop' + (m.on ? '' : ' ms-byp')} role="dialog" aria-label="Master strip">
          <div className="ms-head">
            <div className="ms-htitle">
              <Power on={m.on} onClick={() => { onStart(); setM({ on: !m.on }); }} />
              <span className="ms-name">MASTER</span>
              <span className="sec-l">缩混 · mastering</span>
            </div>
            <span className="fx-chain">IN ▸ <b style={{ color: stageCol(eq.on) }}>EQ</b> · <b style={{ color: stageCol(comp.on) }}>GLUE</b> · <b style={{ color: stageCol(sat.on) }}>SAT</b> · <b style={{ color: stageCol(w.on) }}>WIDTH</b> ▸ <b style={{ color: stageCol(lim.on) }}>LIM</b> ▸ OUT</span>
          </div>

          <div className="ms-presets">
            <span className="ms-pre-l">预设</span>
            {MASTER_PRESETS.map((p) => (
              <button key={p.name} type="button" className="fx-chip" title={p.hint} onClick={() => applyPreset(p.config)}>{p.name}</button>
            ))}
          </div>

          <div className="ms-hero">
            <VuMeters engine={engine} playing={playing} />
            <MasterScope engine={engine} playing={playing} />
          </div>

          <div className="ms-rows">
            <div className={'fx-mod' + (m.on && eq.on ? '' : ' off')}>
              <div className="fx-mh"><span className="fx-name">Master EQ</span><Power on={eq.on} onClick={() => { onStart(); setEq({ on: !eq.on }); }} /></div>
              <div className="fx-knobs">
                <Knob label="LOW" value={eq.low} min={-12} max={12} def={0} fmt={dbf} dim={!eq.on} onStart={onStart} onChange={(v) => setEq({ low: v })} />
                <Knob label="MID" value={eq.mid} min={-12} max={12} def={0} fmt={dbf} dim={!eq.on} onStart={onStart} onChange={(v) => setEq({ mid: v })} />
                <Knob label="HIGH" value={eq.high} min={-12} max={12} def={0} fmt={dbf} dim={!eq.on} onStart={onStart} onChange={(v) => setEq({ high: v })} />
              </div>
              <span className="fx-note">3-band shelf · memoryless</span>
            </div>

            <div className={'fx-mod' + (m.on && sat.on ? '' : ' off')}>
              <div className="fx-mh"><span className="fx-name">Saturation</span><Power on={sat.on} onClick={() => { onStart(); setSat({ on: !sat.on }); }} /></div>
              <div className="fx-row">{CHARS.map((ch) => <button key={ch} type="button" className={'fx-chip' + (sat.character === ch ? ' on' : '')} onClick={() => { if (sat.character !== ch) { onStart(); setSat({ character: ch }); } }}>{ch[0].toUpperCase() + ch.slice(1)}</button>)}</div>
              <div className="fx-knobs">
                <Knob label="DRIVE" value={sat.drive} min={0} max={1} def={0.3} fmt={pct} dim={!sat.on} onStart={onStart} onChange={(v) => setSat({ drive: v })} />
                <Knob label="MIX" value={sat.mix} min={0} max={1} def={1} fmt={pct} dim={!sat.on} onStart={onStart} onChange={(v) => setSat({ mix: v })} />
              </div>
              <span className="fx-note">waveshaper · 4× oversample</span>
            </div>

            <div className={'fx-mod' + (m.on && w.on ? '' : ' off')}>
              <div className="fx-mh"><span className="fx-name">Stereo Width</span><Power on={w.on} onClick={() => { onStart(); setW({ on: !w.on }); }} /></div>
              <div className="fx-knobs">
                <Knob label="WIDTH" value={w.width} min={0} max={2} def={1} fmt={(v) => v.toFixed(2)} dim={!w.on} onStart={onStart} onChange={(v) => setW({ width: v })} />
                <Knob label="AIR" value={w.air} min={-6} max={6} def={0} fmt={dbf} dim={!w.on} onStart={onStart} onChange={(v) => setW({ air: v })} />
              </div>
              <div className="fx-row" style={{ justifyContent: 'center' }}>
                <button type="button" className={'fx-chip' + (w.monoBelowHz > 0 ? ' on' : '')} onClick={() => { onStart(); setW({ monoBelowHz: w.monoBelowHz > 0 ? 0 : 120 }); }}>MONO &lt;120Hz</button>
              </div>
            </div>
          </div>

          <div className="ms-dyn">
            <span className="ms-dyn-flag" title="§17 抗抽吸:压缩默认关,softclip 天花板永远兜底">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" aria-hidden="true"><path d="M12 9v4M12 16.5v.5" strokeWidth="2" /><path d="M10.3 3.9 2.6 17.3a2 2 0 0 0 1.7 3h15.4a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" /></svg>
              OPT-IN DYNAMICS — 慢胶水压缩(抗 §17 抽吸:并行 mix · 侧链 HPF · lookahead · auto-rel);softclip 天花板始终兜底
            </span>
            <div className={'fx-mod' + (m.on && comp.on ? '' : ' off')}>
              <div className="fx-mh"><span className="fx-name">Bus Glue · compressor</span><Power on={comp.on} onClick={() => { onStart(); setComp({ on: !comp.on }); }} /></div>
              <div className="fx-knobs">
                <Knob label="THRESH" value={comp.threshold} min={-48} max={0} def={-18} fmt={(v) => `${v.toFixed(0)}`} dim={!comp.on} onStart={onStart} onChange={(v) => setComp({ threshold: v })} />
                <Knob label="RATIO" value={comp.ratio} min={1} max={8} def={2} fmt={(v) => `${v.toFixed(1)}:1`} dim={!comp.on} onStart={onStart} onChange={(v) => setComp({ ratio: v })} />
                <Knob label="ATTACK" value={comp.attack} min={1} max={100} def={30} fmt={(v) => `${Math.round(v)}ms`} dim={!comp.on} onStart={onStart} onChange={(v) => setComp({ attack: v })} />
                <Knob label="REL" value={comp.release} min={20} max={800} def={200} fmt={(v) => `${Math.round(v)}ms`} dim={!comp.on} onStart={onStart} onChange={(v) => setComp({ release: v })} />
                <Knob label="SC-HPF" value={comp.scHpf} min={20} max={300} def={80} fmt={(v) => `${Math.round(v)}Hz`} dim={!comp.on} onStart={onStart} onChange={(v) => setComp({ scHpf: v })} />
                <Knob label="MIX" value={comp.mix} min={0} max={1} def={1} fmt={pct} dim={!comp.on} onStart={onStart} onChange={(v) => setComp({ mix: v })} />
              </div>
              <div className="fx-row" style={{ justifyContent: 'center', gap: 6, alignItems: 'center' }}>
                <button type="button" className={'fx-chip' + (comp.autoRelease ? ' on' : '')} onClick={() => { onStart(); setComp({ autoRelease: !comp.autoRelease }); }}>AUTO-REL</button>
                <span className="fx-note">parallel · sidechain HPF · lookahead · slow glue (§17-safe)</span>
              </div>
            </div>
            <div className={'fx-mod' + (m.on && lim.on ? '' : ' off')} style={{ marginTop: 8 }}>
              <div className="fx-mh"><span className="fx-name">Bus Limiter · true-peak</span><Power on={lim.on} onClick={() => { onStart(); setLim({ on: !lim.on }); }} /></div>
              <div className="fx-knobs">
                <Knob label="DRIVE" value={lim.gainDb} min={0} max={18} def={0} fmt={(v) => `+${v.toFixed(1)}`} dim={!lim.on} onStart={onStart} onChange={(v) => setLim({ gainDb: v })} />
                <Knob label="CEILING" value={lim.ceilingDb} min={-6} max={0} def={-1} fmt={(v) => `${v.toFixed(1)}`} dim={!lim.on} onStart={onStart} onChange={(v) => setLim({ ceilingDb: v })} />
                <Knob label="RELEASE" value={lim.release} min={20} max={800} def={200} fmt={(v) => `${Math.round(v)}ms`} dim={!lim.on} onStart={onStart} onChange={(v) => setLim({ release: v })} />
                <Knob label="CROSS" value={lim.crossHz} min={60} max={300} def={120} fmt={(v) => `${Math.round(v)}Hz`} dim={!lim.on || !lim.multiband} onStart={onStart} onChange={(v) => setLim({ crossHz: v })} />
              </div>
              <div className="fx-row" style={{ justifyContent: 'center', gap: 6, alignItems: 'center' }}>
                <button type="button" className={'fx-chip' + (lim.multiband ? ' on' : '')} onClick={() => { onStart(); setLim({ multiband: !lim.multiband }); }}>MULTIBAND</button>
                <span className="fx-note">{lim.multiband ? '低频单独限幅 = 更响还干净' : '单段'}</span>
              </div>
              <span className="fx-note">DRIVE 推响度(maximizer)· 2-band lookahead brickwall · softclip 仍兜底{lim.targetLufs != null ? ` · 目标 ${lim.targetLufs} LUFS(待对齐)` : ''}</span>
            </div>
          </div>

          <div className="ms-foot">master ▸ <b style={{ color: stageCol(eq.on || sat.on || w.on) }}>strip</b> ▸ XY ▸ <span className="ms-ceil">▮ softclip ceiling</span> ▸ out</div>
        </div>
      )}
    </div>
  );
}
