'use client';
// XY 表演板浮层(§21)—— 顶栏 FX 按钮旁的 XY 按钮,点开主总线 insert 的 Kaoss 式触控方块。
// 布局:左=XY 方块,右栏=效果选择(2×2)+ X/Y 读数(并排)+ 触发模式/SPRING/WET(同一行)。无标题/无开关/无状态文字。
// 状态只靠圆点颜色:演奏/锁定=该效果色(4 效果各一色),闲置=灰;锁定额外加外环。
// spring 模式松手:在 springMs 内把 X/Y 用 rAF 滑回中点(每帧驱动音频→听到效果扫回中性),到点再 release(bypass)。
// 配置(program/wet/mode/springMs)走 onXy(commitFx 便车:即时引擎 + 防抖落库 + undo,onStart 压栈);
// 实时手指 X/Y/engage/release 直连引擎(瞬态、不落库/不进 undo,对标 §18 Solo)。拖动/回弹用命令式 DOM 更新避免每帧重渲。
import { useEffect, useRef, useState } from 'react';
import type { XYConfig, XYProgram } from '@/contracts';

const CLAY = '#c2724f', DIM = '#6f6a60', TRACK = '#39352f';
// 4 效果各一色(取自 app 的 SESSION_COLORS 体系);active chip + engaged/held 圆点都用它。
const PROG_COLOR: Record<XYProgram, string> = { filter: '#c2724f', slicer: '#6f9e8b', delay: '#7e8a9e', brake: '#b07f86' };
const INK = '#1c1b19'; // 彩色 chip 上的深色字
const RATES = ['1/4', '1/8', '1/8.', '1/16'];
const SPR_MIN = 40, SPR_MAX = 2000;                                            // spring 回中时长范围(ms,对数)
const normToMs = (n: number) => SPR_MIN * Math.pow(SPR_MAX / SPR_MIN, Math.max(0, Math.min(1, n)));
const msToNorm = (ms: number) => Math.log(Math.max(SPR_MIN, ms) / SPR_MIN) / Math.log(SPR_MAX / SPR_MIN);
const fmtSpr = (ms: number) => (ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${Math.round(ms)}ms`);
const hz = (f: number) => (f >= 1000 ? `${(f / 1000).toFixed(f >= 10000 ? 0 : 1)} kHz` : `${Math.round(f)} Hz`);
const expMap = (t: number, lo: number, hi: number) => lo * Math.pow(hi / lo, Math.max(0, Math.min(1, t)));
const rateIdx = (x: number) => Math.min(3, Math.floor(Math.max(0, Math.min(1, x)) * 4));

interface ProgMeta { label: string; xlab: string; ylab: string; xn: string; yn: string; snap: boolean; xr: (x: number) => string; yr: (y: number) => string }
const PROGS: Record<XYProgram, ProgMeta> = {
  filter: {
    label: 'Filter', xlab: 'LP ◄ cutoff ► HP', ylab: 'resonance', xn: 'cutoff · X', yn: 'reso · Y', snap: false,
    xr: (x) => (Math.abs(x - 0.5) < 0.02 ? 'open' : x < 0.5 ? `LP ${hz(expMap((0.5 - x) / 0.5, 20000, 20))}` : `HP ${hz(expMap((x - 0.5) / 0.5, 20, 20000))}`),
    yr: (y) => `Q ${(0.7 + y * 11.3).toFixed(1)}`,
  },
  slicer: { label: 'Slicer', xlab: 'rate ◄ sync ►', ylab: 'depth', xn: 'rate · X', yn: 'depth · Y', snap: true, xr: (x) => RATES[rateIdx(x)], yr: (y) => `${Math.round((0.5 + 0.5 * y) * 100)}%` },
  delay: { label: 'Delay', xlab: 'time ◄ sync ►', ylab: 'feedback', xn: 'time · X', yn: 'fbk · Y', snap: true, xr: (x) => RATES[rateIdx(x)], yr: (y) => `${Math.round(y * 70)}%` },
  brake: { label: 'Brake', xlab: '◄ depth ►', ylab: 'brake', xn: 'depth · X', yn: 'brake · Y', snap: false, xr: (x) => `${Math.round(12 + x * 12)} st`, yr: (y) => `${Math.round(y * 100)}%` },
};
const ORDER: XYProgram[] = ['filter', 'slicer', 'delay', 'brake'];

// 旋钮(沿用 FxRack 画法:竖拖改值 / 双击复位);value/onChange 都是归一 0..1,fmt 决定显示。
function Knob({ label, value, fmt, def, onStart, onChange, dim }: { label: string; value: number; fmt: (v: number) => string; def: number; onStart: () => void; onChange: (v: number) => void; dim?: boolean }) {
  const st = useRef({ y: 0, v: 0 });
  const down = (e: React.PointerEvent) => {
    e.preventDefault();
    try { (e.target as Element).setPointerCapture?.(e.pointerId); } catch { /* 合成事件 */ }
    onStart();
    st.current = { y: e.clientY, v: value };
    const move = (ev: PointerEvent) => onChange(Math.max(0, Math.min(1, st.current.v + (st.current.y - ev.clientY) / 140)));
    const up = (ev: PointerEvent) => { (e.target as Element).releasePointerCapture?.(ev.pointerId); window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  const a0 = -135, a1 = 135, ang = a0 + Math.max(0, Math.min(1, value)) * (a1 - a0);
  const pt = (deg: number, r: number) => [24 + r * Math.sin((deg * Math.PI) / 180), 24 - r * Math.cos((deg * Math.PI) / 180)];
  const [sx, sy] = pt(a0, 17), [ex, ey] = pt(a1, 17), [vx, vy] = pt(ang, 17), [cx, cy] = pt(ang, 6.5), [lx, ly] = pt(ang, 15.5);
  const big = ang - a0 > 180 ? 1 : 0;
  return (
    <div className="fx-k" style={dim ? { opacity: 0.4 } : undefined}>
      <svg width="34" height="34" viewBox="0 0 48 48" onPointerDown={down} onDoubleClick={() => { onStart(); onChange(def); }} style={{ cursor: 'ns-resize', touchAction: 'none' }}>
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

type Live = 'idle' | 'engaged' | 'held';

export function XYPad({ xy, onXy, onStart, onEngage, onMove, onRelease }: {
  xy: XYConfig; onXy: (next: XYConfig) => void; onStart: () => void;
  onEngage: () => void; onMove: (nx: number, ny: number) => void; onRelease: () => void;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const padRef = useRef<HTMLDivElement>(null);
  const dotRef = useRef<HTMLDivElement>(null);
  const hRef = useRef<HTMLDivElement>(null);
  const vRef = useRef<HTMLDivElement>(null);
  const xvalRef = useRef<HTMLSpanElement>(null);
  const yvalRef = useRef<HTMLSpanElement>(null);
  const cfgRef = useRef(xy); cfgRef.current = xy;
  const rx = useRef(0.5), ry = useRef(0.5), dragging = useRef(false), live = useRef<Live>('idle');
  const springRaf = useRef<number | null>(null);

  // 浮层:点外/Esc 关(沿用 FxRack 范式)。
  useEffect(() => {
    if (!open) return;
    const onDoc = (ev: MouseEvent) => { if (!wrapRef.current?.contains(ev.target as Node)) setOpen(false); };
    const onKey = (ev: KeyboardEvent) => { if (ev.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDoc); document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDoc); document.removeEventListener('keydown', onKey); };
  }, [open]);

  const meta = PROGS[xy.program];
  const trans = (v: string) => [dotRef, hRef, vRef].forEach((r) => { if (r.current) r.current.style.transition = v; });
  const place = () => {
    const m = PROGS[cfgRef.current.program];
    const dx = rx.current; // 圆点跟手自由移动(默认正中);速率吸附只体现在读数/引擎,不挪圆点
    if (dotRef.current) { dotRef.current.style.left = `${dx * 100}%`; dotRef.current.style.bottom = `${ry.current * 100}%`; }
    if (vRef.current) vRef.current.style.left = `${dx * 100}%`;
    if (hRef.current) hRef.current.style.bottom = `${ry.current * 100}%`;
    if (xvalRef.current) xvalRef.current.textContent = m.xr(rx.current);
    if (yvalRef.current) yvalRef.current.textContent = m.yr(ry.current);
  };
  const applyAcc = () => {
    padRef.current?.style.setProperty('--xacc', live.current === 'idle' ? DIM : PROG_COLOR[cfgRef.current.program]);
    dotRef.current?.classList.toggle('held', live.current === 'held');
  };

  // 重渲后(切 program / 重开浮层)同步圆点位置/读数/状态色。
  useEffect(() => { place(); applyAcc(); }); // eslint-disable-line react-hooks/exhaustive-deps
  // 关闭浮层:停回弹 + 释放任何 engaged/held —— 否则效果卡在 wet 且没 UI 可解除(无电源键)。"不操作即关"。
  useEffect(() => {
    if (open) return;
    cancelSpring();
    if (live.current !== 'idle') { onRelease(); live.current = 'idle'; }
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  // 卸载(切工程/拆 StudioApp):同样释放,免 phantom 主总线效果常驻。
  useEffect(() => () => { cancelSpring(); if (live.current !== 'idle') onRelease(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  function cancelSpring() { if (springRaf.current != null) { cancelAnimationFrame(springRaf.current); springRaf.current = null; } }
  // spring 回弹:springMs 内把 X/Y(easeOut)滑回中点,每帧驱动音频随之扫回中性;到点 release+idle。
  const startSpring = () => {
    cancelSpring();
    const x0 = rx.current, y0 = ry.current, dur = Math.max(30, cfgRef.current.springMs);
    trans('none');
    let t0: number | null = null;
    const step = (now: number) => {
      if (t0 == null) t0 = now;
      const e = Math.min(1, (now - t0) / dur), k = 1 - Math.pow(1 - e, 3);
      rx.current = x0 + (0.5 - x0) * k; ry.current = y0 + (0.5 - y0) * k;
      place(); onMove(rx.current, ry.current);
      if (e < 1) { springRaf.current = requestAnimationFrame(step); }
      else { springRaf.current = null; onRelease(); live.current = 'idle'; applyAcc(); }
    };
    springRaf.current = requestAnimationFrame(step);
  };

  const fromEvent = (e: React.PointerEvent | PointerEvent) => {
    const r = padRef.current!.getBoundingClientRect();
    rx.current = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
    ry.current = Math.max(0, Math.min(1, 1 - (e.clientY - r.top) / r.height));
  };
  const onDown = (e: React.PointerEvent) => {
    cancelSpring();
    dragging.current = true;
    try { padRef.current?.setPointerCapture(e.pointerId); } catch { /* */ }
    trans('none'); fromEvent(e); place();
    live.current = 'engaged'; applyAcc();
    onEngage(); onMove(rx.current, ry.current);
  };
  const onMoveEv = (e: React.PointerEvent) => { if (!dragging.current) return; fromEvent(e); place(); onMove(rx.current, ry.current); };
  const onUp = () => {
    if (!dragging.current) return;
    dragging.current = false;
    if (cfgRef.current.mode === 'spring') startSpring();   // 滑回中点 + 音频随动,到点 release
    else { live.current = 'held'; applyAcc(); }
  };

  const setCfg = (p: Partial<XYConfig>) => { onStart(); onXy({ ...cfgRef.current, ...p }); };
  const pickMode = (mode: XYConfig['mode']) => {
    setCfg({ mode });
    if (mode === 'spring') { if (!dragging.current && live.current !== 'idle') startSpring(); }
    else { const springing = springRaf.current != null; cancelSpring(); if (springing) { onRelease(); live.current = 'idle'; applyAcc(); } } // latch:中断回弹要释放,否则卡在 engaged
  };

  return (
    <div className="fx-wrap" ref={wrapRef}>
      <button className={'fx-btn' + (open ? ' on' : '')} aria-pressed={open} title="XY performance pad — Kaoss-style master insert" onClick={() => setOpen((o) => !o)}>
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="1" /><path d="M3 12h18M12 3v18" /></svg>
        XY
      </button>
      {open && (
        <div className="fx-pop xy-pop" role="dialog" aria-label="XY performance pad">
          <div className="xy-body">
            <div className="xy-padwrap">
              <div className="xy-ylab"><span>{meta.ylab}</span></div>
              <div ref={padRef} className="xy-pad" onPointerDown={onDown} onPointerMove={onMoveEv} onPointerUp={onUp} onPointerCancel={onUp}>
                <div className="xy-grid" />
                {meta.snap && <div className="xy-snaps"><i style={{ left: '25%' }} /><i style={{ left: '50%' }} /><i style={{ left: '75%' }} /></div>}
                <div className="xy-center" />
                <div ref={hRef} className="xy-line-h" />
                <div ref={vRef} className="xy-line-v" />
                <div ref={dotRef} className="xy-dot" />
              </div>
              <div />
              <div className="xy-xlab">{meta.xlab}</div>
            </div>

            <div className="xy-rail">
              <div className="xy-progs">
                {ORDER.map((p) => (
                  <button key={p} type="button" className={'fx-chip' + (xy.program === p ? ' on' : '')} style={xy.program === p ? { background: PROG_COLOR[p], borderColor: PROG_COLOR[p], color: INK } : undefined} onClick={() => setCfg({ program: p })}>{PROGS[p].label}</button>
                ))}
              </div>

              <div className="xy-reads">
                <div className="xy-cell"><span className="we-lab">{meta.xn}</span><div className="we-box"><span ref={xvalRef}>{meta.xr(rx.current)}</span></div></div>
                <div className="xy-cell"><span className="we-lab">{meta.yn}</span><div className="we-box"><span ref={yvalRef}>{meta.yr(ry.current)}</span></div></div>
              </div>

              <div className="xy-tw">
                <div className="seg">
                  <button type="button" className={xy.mode === 'spring' ? 'on' : ''} onClick={() => pickMode('spring')}>Spring</button>
                  <button type="button" className={xy.mode === 'latch' ? 'on' : ''} onClick={() => pickMode('latch')}>Latch</button>
                </div>
                <Knob label="SPRING" value={msToNorm(xy.springMs)} fmt={(v) => fmtSpr(normToMs(v))} def={msToNorm(300)} onStart={onStart} onChange={(v) => onXy({ ...cfgRef.current, springMs: Math.round(normToMs(v)) })} dim={xy.mode === 'latch'} />
                <Knob label="WET" value={xy.wet} fmt={(v) => `${Math.round(v * 100)}%`} def={1} onStart={onStart} onChange={(v) => onXy({ ...cfgRef.current, wet: v })} />
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
