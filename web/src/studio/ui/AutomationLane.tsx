'use client';
// §26 内联自动化 lane —— Song 比例时间轴上,每个 block 下的一条断点编辑器。
// 横轴=session 内 bar 偏移(统一 bar 度量,x=bar*px;每 bar 细线 + 每遍 loop 粗线),纵轴=参数值 0..1。
// 连续参数(filter cutoff / brake / 所有 Y)=斜直线;离散参数(slicer/delay 的 X=rate)=台阶。
// 编辑(仅 selected):双击空白加点、双击点删点、拖动移点(近中线吸附)。改 repeat = 按比例缩放点重分布(rescaleAuto);超出当前 T 的点非破坏保留(显 +N beyond)。
// 起拖 onStart 压一次 undo(且只在真移动时),过程 onChange 实时更新。
import { memo, useRef } from 'react';
import type { AutoPoint, XYAutomation, XYProgram } from '@/contracts';
import { PROG_COLOR, NEUTRAL, isStepAxis, sortPoints } from '@/studio/xyAutomation';

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
const H = 50;

// §41:可选覆写 color/refV/stepAxis —— 不传则照旧从 program 派生(§26 XY);音量 lane 传 color=VOL_COLOR、refV=1(吸顶端 unity)、stepAxis=false。
// perf:memo 包裹 —— 切场景/播放跨块边界(px/bars/auto 不变)时整批 lane 跳过重渲;比较器只看数据 prop,
//   忽略 onStart/onChange 引用(父每渲染都新建闭包,但它们捕获的状态 autoProgram 等都已镜像进会变的数据 prop,故安全)。
function AutomationLaneImpl({ auto, program, axis, bars, reps, px, editable, ghost, color, refV, stepAxis, onStart, onChange }: {
  auto: XYAutomation; program: XYProgram; axis: 'x' | 'y'; bars: number; reps: number; px: number; editable: boolean; ghost?: boolean;
  color?: string; refV?: number; stepAxis?: boolean;
  onStart: () => void; onChange: (next: XYAutomation) => void;
}) {
  const svgRef = useRef<SVGSVGElement>(null);
  const drag = useRef<{ bi: number; started: boolean } | null>(null);
  const T = Math.max(1, bars * reps);
  const W = Math.max(1, T * px);
  const col = ghost ? '#5f5e5a' : (color ?? PROG_COLOR[program]); // ghost=没 automation 的扁平占位线(灰、不可编辑)
  const step = stepAxis ?? isStepAxis(program, axis);
  const ref = refV ?? NEUTRAL[program]?.[axis] ?? 0.5; // bypass/中性参考值(+吸附目标):XY=该轴 NEUTRAL,音量=顶端 unity(1)
  const snapV = (v: number) => (Math.abs(v - ref) < 0.045 ? ref : v); // 近参考值吸附
  const all = sortPoints(auto[axis]);
  const vis = all.filter((p) => p.bar <= T + 1e-6);
  const hidden = all.length - vis.length;
  const X = (bar: number) => bar * px, Y = (v: number) => (1 - clamp(v, 0, 1)) * H;

  // 折线(连续=直线;离散=台阶);两端 hold 到边缘。
  const poly: string[] = [];
  if (vis.length) {
    poly.push(`0,${Y(vis[0].v)}`);
    if (step) { let prev = vis[0].v; for (let i = 1; i < vis.length; i++) { poly.push(`${X(vis[i].bar)},${Y(prev)}`); poly.push(`${X(vis[i].bar)},${Y(vis[i].v)}`); prev = vis[i].v; } poly.push(`${W},${Y(prev)}`); }
    else { for (const p of vis) poly.push(`${X(p.bar)},${Y(p.v)}`); poly.push(`${W},${Y(vis[vis.length - 1].v)}`); }
  }

  // perf:bar/loop 竖线由 O(T) 个 <line> 改成两层 CSS 渐变背景(画在 svg 上),消掉长曲里上百个 SVG 节点 —— zoom/重渲不再逐线重排。
  //   细线每 px 一条(浅 .03),loop 分割线每 bars*px 一条(深 .07);渐变在 viewBox 坐标系(px 单位)下定位,与折线/节点对齐。
  const gridBg = `repeating-linear-gradient(90deg, rgba(236,233,227,.07) 0 1px, transparent 1px ${bars * px}px), repeating-linear-gradient(90deg, rgba(236,233,227,.03) 0 1px, transparent 1px ${px}px)`;
  const refY = Y(ref); // bypass/中性参考线:画在该轴 NEUTRAL 处(音量=顶端 unity),默认平直线正好压在它上面
  const grid: React.ReactNode[] = [<line key="c" x1={0} y1={refY} x2={W} y2={refY} stroke="rgba(236,233,227,.1)" strokeDasharray="3 3" />];

  const rel = (e: React.PointerEvent | React.MouseEvent) => { const r = svgRef.current!.getBoundingClientRect(); return { bar: clamp((e.clientX - r.left) / r.width * T, 0, T), v: snapV(clamp(1 - (e.clientY - r.top) / r.height, 0, 1)) }; };
  const commit = (arr: AutoPoint[]) => onChange({ ...auto, [axis]: arr.map((p) => ({ bar: p.bar, v: p.v })) });

  // 拖动移点(双击才加/删 → 单击不会误加点;起拖延迟 onStart,纯抓不压栈)。
  const down = (e: React.PointerEvent) => {
    if (!editable || (e.target as Element).tagName !== 'circle') return;
    e.preventDefault(); // ⚠ 别 setPointerCapture:它会把 circle 的 click/dblclick 重定向到 svg → 双击删点失效。拖动靠下面的 window 监听已足够。
    drag.current = { bi: Number((e.target as Element).getAttribute('data-bi')), started: false };
    const mv = (ev: PointerEvent) => {
      const d = drag.current; if (!d) return; if (!d.started) { onStart(); d.started = true; }
      const p = rel(ev as unknown as React.PointerEvent); const arr = sortPoints(auto[axis]); // all(含 hidden);按渲染序 data-bi 对应 sortPoints
      if (arr[d.bi]) { arr[d.bi] = { bar: p.bar, v: p.v }; commit(arr); }
    };
    const up = () => { window.removeEventListener('pointermove', mv); window.removeEventListener('pointerup', up); drag.current = null; };
    window.addEventListener('pointermove', mv); window.addEventListener('pointerup', up);
  };
  const dbl = (e: React.MouseEvent) => {
    if (!editable) return;
    e.stopPropagation();
    const r = svgRef.current!.getBoundingClientRect();
    const cx = (e.clientX - r.left) / (r.width || 1) * W, cy = (e.clientY - r.top) / (r.height || 1) * H; // 视口 → viewBox 坐标
    const arr = sortPoints(auto[axis]);
    const hit = arr.findIndex((pt) => Math.hypot(X(pt.bar) - cx, Y(pt.v) - cy) < 7); // 按位置命中节点(不靠 event.target → 不受 pointer-capture/重渲染影响)
    onStart();
    if (hit >= 0) commit(arr.filter((_, i) => i !== hit));               // 双击节点 → 删
    else { const p = rel(e); commit([...arr, { bar: p.bar, v: p.v }]); } // 双击空白 → 加
  };

  return (
    <svg ref={svgRef} className="auto-svg" width={W} height={H} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none"
      style={{ display: 'block', width: W, cursor: editable ? 'crosshair' : 'pointer', touchAction: 'none', backgroundImage: gridBg }} onPointerDown={down} onDoubleClick={dbl}>
      {grid}
      {poly.length > 0 && <polyline points={poly.join(' ')} fill="none" stroke={col} strokeWidth={1.5} strokeLinejoin="round" opacity={ghost ? 0.3 : editable ? 1 : 0.5} vectorEffect="non-scaling-stroke" />}
      {editable && vis.map((p) => { const j = all.indexOf(p); return <circle key={j} cx={clamp(X(p.bar), 3, W - 3)} cy={Y(p.v)} r={3} fill={col} stroke="#1c1b19" strokeWidth={1} data-bi={j} style={{ cursor: 'grab' }} />; })}{/* cx 夹到点边缘刚好触边([3,W-3],r=3):首/末点贴边线、又不被裁一半(#4) */}
      {hidden > 0 && <text x={W - 4} y={11} textAnchor="end" fontSize={8} fill="#c2a24f" style={{ fontVariantNumeric: 'tabular-nums' }}>+{hidden} beyond</text>}
    </svg>
  );
}

// perf:只比较数据 prop —— 数据(auto 的 x/y 数组引用、bars/reps/px/editable/program/axis/color…)不变就不重渲。
//   onStart/onChange 故意不比:父每次渲染都新建闭包,但其捕获的状态(autoProgram/autoVol/选中块)在变化时
//   一定改了某个数据 prop(parent 据此换 auto/program/editable),故旧闭包永不被陈旧调用 —— 见组件头注释。
export const AutomationLane = memo(AutomationLaneImpl, (a, b) =>
  a.axis === b.axis && a.auto[a.axis] === b.auto[b.axis] && // 只比当前轴那条数组(同源 autoSet[program] 引用变=两轴都变);避开父 volWrap 每渲染新建 y:[] 的假失配
  a.program === b.program &&
  a.bars === b.bars && a.reps === b.reps && a.px === b.px &&
  a.editable === b.editable && a.ghost === b.ghost &&
  a.color === b.color && a.refV === b.refV && a.stepAxis === b.stepAxis,
);
