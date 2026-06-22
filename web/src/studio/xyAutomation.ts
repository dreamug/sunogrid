// §26 Song XY 自动化 —— 纯逻辑(无依赖、框架无关,可直接 node 跑测)。
// 度量 = bar(session 内 bar 偏移,0..bars×reps);断点直线插值 + 端点 hold;离散参数(slicer/delay 的 X=rate)零阶保持(台阶)。
// UI 编辑器与回放 coordinator 共用这里的采样,所见=所听。改 repeat = 按比例缩放点重分布(rescaleAuto)。
// §26.v2:program 不再存 XYAutomation 里,由 XYAutoSet 的键给;采样函数把 program 作入参传入。
import type { AutoPoint, XYAutomation, XYAutoSet, XYProgram } from '@/contracts';

const clamp01 = (v: number): number => (Number.isFinite(v) ? (v < 0 ? 0 : v > 1 ? 1 : v) : 0);

/** 各效果的"中性"默认值(≈无效果),插入自动化时落平直线于此,插入瞬间不改音色。 */
// 中性=无效果点。**X 和 Y 都落中线 0.5**(默认平直线压在中线/0 线/bypass 参考线上,两轴一致)。
// filter X 双极中点 0.5=全开;Y 的量由引擎按「离中线的上半位移」算(yAmt=clamp((ny-0.5)*2,0,1)):中线=无量,往上=加量(见 xyPad)。
export const NEUTRAL: Record<XYProgram, { x: number; y: number }> = {
  filter: { x: 0.5, y: 0.5 },
  slicer: { x: 0.5, y: 0.5 },
  delay: { x: 0.5, y: 0.5 },
  brake: { x: 0.5, y: 0.5 },
};

/** X 轴是否离散参数(rate 四档)→ 采样用台阶(零阶保持)而非斜线。Y 永远连续。 */
export const isStepAxis = (program: XYProgram, axis: 'x' | 'y'): boolean => axis === 'x' && (program === 'slicer' || program === 'delay');

/** 4 效果各一色(§21 体系,取自 SESSION_COLORS);自动化 lane / chip 共用。 */
export const PROG_COLOR: Record<XYProgram, string> = { filter: '#c2724f', slicer: '#6f9e8b', delay: '#7e8a9e', brake: '#b07f86' };
export const PROG_LABEL: Record<XYProgram, string> = { filter: 'Filter', slicer: 'Slicer', delay: 'Delay', brake: 'Brake' };
export const PROG_ORDER: XYProgram[] = ['filter', 'slicer', 'delay', 'brake'];
/** lane 轴短标签(读数交给 UI;这里只给短名)。 */
export const axisLabel = (program: XYProgram, axis: 'x' | 'y'): string => {
  const X: Record<XYProgram, string> = { filter: 'cutoff', slicer: 'rate', delay: 'time', brake: 'depth' };
  const Y: Record<XYProgram, string> = { filter: 'reso', slicer: 'depth', delay: 'fbk', brake: 'brake' };
  return (axis === 'x' ? X : Y)[program];
};

/** 默认自动化:中性平直线(bar 0 → totalBars 首尾两端点,X/Y 都压 NEUTRAL)。§26.v3 无 on;此形状即「未激活」。program 只用来取 NEUTRAL。 */
export function defaultAutomation(program: XYProgram, totalBars: number): XYAutomation {
  const n = NEUTRAL[program] ?? { x: 0.5, y: 0 };
  const end = Math.max(1, totalBars);
  return { x: [{ bar: 0, v: n.x }, { bar: end, v: n.x }], y: [{ bar: 0, v: n.y }, { bar: end, v: n.y }] };
}

/** §26.v3 激活判定(用户规则:「线上多出点 或 有点离开 0 线」=激活;回到「只有首尾两点、都在 0 线」=未激活)。
 *  某轴「有内容」⇔ 点数 > 2 或 任一点离开该轴 NEUTRAL。空/退化(0~2 点全压中线)=未激活。
 *  唯一的激活真相;`changeXyAuto`/`normalizeXyAuto` 用它守「xyAuto map 只进非平」,故热路径(coordinator/prime)只看 map presence。 */
export function isActiveAuto(program: XYProgram, auto: XYAutomation | undefined | null): boolean {
  if (!auto) return false;
  const n = NEUTRAL[program] ?? { x: 0.5, y: 0 };
  const axisActive = (pts: AutoPoint[] | undefined, v: number): boolean => Array.isArray(pts) && (pts.length > 2 || pts.some((p) => Math.abs(p.v - v) >= 1e-4));
  return axisActive(auto.x, n.x) || axisActive(auto.y, n.y);
}

/** 过滤非法断点(脏 JSON:null/非对象/bar 或 v 非有限数)→ 不让坏元素漏到 sampleAuto 崩。 */
const cleanPts = (arr: unknown): AutoPoint[] =>
  (Array.isArray(arr) ? arr : []).filter((p): p is AutoPoint => !!p && typeof p === 'object' && Number.isFinite((p as AutoPoint).bar) && Number.isFinite((p as AutoPoint).v));

/** v2 旧中性 = {x:0.5, y:0}(那时 NEUTRAL.y=0)。v3 改成 y 中线 0.5,故旧「插入但没画」的平直线(y 全 0)会被 isActiveAuto 误判成激活。迁移时按旧中性也算未激活,清掉这批幽灵 chip。 */
const flat2 = (pts: AutoPoint[], v: number): boolean => pts.length === 2 && pts.every((p) => Math.abs(p.v - v) < 1e-4);
const isOldNeutral = (a: XYAutomation): boolean => flat2(a.x, 0.5) && flat2(a.y, 0);

/** §26.v3 迁移:把任意持久化形状归一成 XYAutoSet,**只留非平(激活)的效果**。兼容老单形状 `{program,on,x,y}`、老 map `{[p]:{on,x,y}}`;丢 `on`、丢平直线(含 v2 旧中性 y=0);断点逐元素清洗。 */
export function normalizeXyAuto(raw: unknown): XYAutoSet | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const out: XYAutoSet = {};
  const put = (prog: XYProgram, x: unknown, y: unknown): void => {
    const a: XYAutomation = { x: cleanPts(x), y: cleanPts(y) };
    if (isActiveAuto(prog, a) && !isOldNeutral(a)) out[prog] = a; // 平直线 / v2 旧中性(未激活)不入 map
  };
  // 老单形状:有 program + x/y 数组
  if (typeof r.program === 'string' && Array.isArray(r.x) && Array.isArray(r.y)) {
    const prog = r.program as XYProgram;
    if (!PROG_ORDER.includes(prog)) return null;
    put(prog, r.x, r.y);
    return Object.keys(out).length ? out : null;
  }
  // map 形状:逐键校验是 {x:[],y:[]}
  for (const prog of PROG_ORDER) {
    const a = r[prog];
    if (a && typeof a === 'object' && Array.isArray((a as Record<string, unknown>).x) && Array.isArray((a as Record<string, unknown>).y)) {
      const aa = a as { x: unknown; y: unknown };
      put(prog, aa.x, aa.y);
    }
  }
  return Object.keys(out).length ? out : null;
}

/** §26 #2:repeat 增减 → 按比例缩放所有断点的 bar(点重新分布到新总长,而非截断/延长)。ratio=新总 bar / 旧总 bar。 */
export function rescaleAuto(auto: XYAutomation, ratio: number): XYAutomation {
  if (!Number.isFinite(ratio) || ratio <= 0 || ratio === 1) return auto;
  const scale = (pts: AutoPoint[]): AutoPoint[] => pts.map((p) => ({ ...p, bar: p.bar * ratio }));
  return { ...auto, x: scale(auto.x), y: scale(auto.y) };
}

/** 按 bar 升序的拷贝。 */
export const sortPoints = (points: AutoPoint[]): AutoPoint[] => [...points].sort((a, b) => a.bar - b.bar);

/**
 * 在 bar 位置采样断点序列(域 = bar,不归一)。
 * - 空 → 0.5(中性兜底)。
 * - 在首点前 / 末点后 → 端点值(hold)。
 * - step=false:相邻断点间线性插值。
 * - step=true(离散参数):零阶保持 = 最后一个 bar≤x 的点值(台阶)。
 * points 需按 bar 升序(回放路径用 sortPoints 保证)。
 */
export function sampleAuto(points: AutoPoint[] | undefined, bar: number, step = false): number {
  if (!points || points.length === 0) return 0.5;
  const x = Number.isFinite(bar) ? bar : 0;
  if (x <= points[0].bar) return clamp01(points[0].v);
  const last = points[points.length - 1];
  if (x >= last.bar) return clamp01(last.v);
  if (step) {
    let v = points[0].v;
    for (const p of points) { if (p.bar <= x) v = p.v; else break; }
    return clamp01(v);
  }
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i], b = points[i + 1];
    if (x >= a.bar && x <= b.bar) { const span = b.bar - a.bar; const f = span <= 0 ? 0 : (x - a.bar) / span; return clamp01(a.v + (b.v - a.v) * f); }
  }
  return clamp01(last.v);
}

/** 回放一帧:在块内 bar 偏移采样出某效果要喂给引擎的 {x,y}(program 决定离散/连续 step)。 */
export function sampleXY(program: XYProgram, auto: XYAutomation, bar: number): { x: number; y: number } {
  return {
    x: sampleAuto(sortPoints(auto.x), bar, isStepAxis(program, 'x')),
    y: sampleAuto(sortPoints(auto.y), bar, isStepAxis(program, 'y')),
  };
}
