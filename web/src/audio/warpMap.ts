// §36 warp marker —— 分段 warp 的纯映射/编辑逻辑(无 DOM / 无引擎依赖,可单测)。
//
//  模型(见 PRODUCT.md §36):一条 clip 的 warp = 一串「源采样 ↔ 输出拍」控制点。
//   - trim 起/止是隐式端点:{src:startSample, beat:0} 与 {src:endSample, beat:totalBeats}。
//   - 中间点 = clip.warpPts(按 beat 升序;空 = 单段恒速 = §6 现状,零迁移)。
//   - 相邻控制点之间线性插值 → 每段独立速率。整条序列在 src 与 beat 上严格单调递增(不许时间倒流)。
//
//  坐标:src = 绝对源采样(同 startSample/endSample);beat = 距 loop 起点的输出拍(totalBeats = bars×beatsPerBar)。
//  本模块只在「采样 / 拍」域算;转成 signalsmith 的「输入秒/输出秒 rate」由渲染层(signalsmithWarp)做。
import type { WarpPoint } from '@/contracts';

/** 安全下限:防除零/极端速率。比这更细的「音乐粒度」由 UI 吸附负责,不在此。 */
export const MIN_BEAT_GAP = 1e-3; // 输出拍
export const MIN_SRC_GAP = 4;     // 源采样

/** 无中间点 = 单段恒速 = §6 现状。 */
export const isLinearWarp = (pts?: WarpPoint[] | null): boolean => !pts || pts.length === 0;

const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);

/**
 * 清洗中间控制点,保证「端点 + 中间点」整条序列严格单调(src 与 beat 都递增)且段间留足 MIN gap。
 * 越界 / 非有限 / 破坏单调 / 贴太近的点一律丢弃(贪心从前往后扫)。返回**不含端点**的中间点。
 * 落库 / 渲染 / 编辑前都先过这关 → 铁律恒成立。
 */
export function normalizeWarpPts(
  pts: WarpPoint[] | null | undefined,
  startSample: number,
  endSample: number,
  totalBeats: number,
): WarpPoint[] {
  if (!pts || pts.length === 0) return [];
  const inside = pts
    .filter((p) => p && finite(p.src) && finite(p.beat) && p.src > startSample && p.src < endSample && p.beat > 0 && p.beat < totalBeats)
    .sort((a, b) => a.beat - b.beat);

  const out: WarpPoint[] = [];
  let prevSrc = startSample, prevBeat = 0;
  for (const p of inside) {
    if (p.beat - prevBeat >= MIN_BEAT_GAP && p.src - prevSrc >= MIN_SRC_GAP) {
      out.push({ src: p.src, beat: p.beat });
      prevSrc = p.src; prevBeat = p.beat;
    }
  }
  // 末点须给「到终点端点」也留够 gap;不够则从尾部回退。
  while (out.length && (endSample - out[out.length - 1].src < MIN_SRC_GAP || totalBeats - out[out.length - 1].beat < MIN_BEAT_GAP)) {
    out.pop();
  }
  return out;
}

/** 端点 + 清洗后的中间点 = 渲染/绘制/查询用的完整控制点序列(首=trim 起、尾=trim 止)。 */
export function controlPoints(
  startSample: number,
  endSample: number,
  totalBeats: number,
  pts?: WarpPoint[] | null,
): WarpPoint[] {
  const interior = normalizeWarpPts(pts, startSample, endSample, totalBeats);
  return [{ src: startSample, beat: 0 }, ...interior, { src: endSample, beat: totalBeats }];
}

/** 输出拍 → 源采样(分段线性;端点外 hold)。cps = controlPoints(...) 的完整序列。 */
export function srcAtBeat(cps: WarpPoint[], beat: number): number {
  if (cps.length === 0) return 0;
  if (beat <= cps[0].beat) return cps[0].src;
  for (let i = 0; i < cps.length - 1; i++) {
    const a = cps[i], b = cps[i + 1];
    if (beat <= b.beat) {
      const span = b.beat - a.beat;
      const t = span > 0 ? (beat - a.beat) / span : 0;
      return a.src + t * (b.src - a.src);
    }
  }
  return cps[cps.length - 1].src;
}

/** 源采样 → 输出拍(srcAtBeat 的逆;端点外 hold)。给「在点击的源位置放 marker」「画 onset 落到哪拍」用。 */
export function beatAtSrc(cps: WarpPoint[], src: number): number {
  if (cps.length === 0) return 0;
  if (src <= cps[0].src) return cps[0].beat;
  for (let i = 0; i < cps.length - 1; i++) {
    const a = cps[i], b = cps[i + 1];
    if (src <= b.src) {
      const span = b.src - a.src;
      const t = span > 0 ? (src - a.src) / span : 0;
      return a.beat + t * (b.beat - a.beat);
    }
  }
  return cps[cps.length - 1].beat;
}

export interface WarpSegment { srcStart: number; srcEnd: number; beatStart: number; beatEnd: number; samplesPerBeat: number; }

/** 相邻控制点拆成段;samplesPerBeat = 该段源采样/输出拍(渲染层据此换算 signalsmith rate)。 */
export function segments(cps: WarpPoint[]): WarpSegment[] {
  const segs: WarpSegment[] = [];
  for (let i = 0; i < cps.length - 1; i++) {
    const a = cps[i], b = cps[i + 1];
    const dBeat = b.beat - a.beat;
    segs.push({ srcStart: a.src, srcEnd: b.src, beatStart: a.beat, beatEnd: b.beat, samplesPerBeat: dBeat > 0 ? (b.src - a.src) / dBeat : 0 });
  }
  return segs;
}

// —— 编辑(都返回新的「中间点」数组,已 normalize;调用点比较 length 即可知是否真的加/删成功)——

/** 加一个 marker(src 钉住、落在 beat)。违反 gap/越界则被 normalize 丢弃(返回数组长度不变)。 */
export function addPoint(pts: WarpPoint[] | undefined, startSample: number, endSample: number, totalBeats: number, src: number, beat: number): WarpPoint[] {
  return normalizeWarpPts([...(pts ?? []), { src, beat }], startSample, endSample, totalBeats);
}

/** 删第 index 个中间点(index 落在 normalize 后的中间点数组上)。 */
export function removePoint(pts: WarpPoint[] | undefined, startSample: number, endSample: number, totalBeats: number, index: number): WarpPoint[] {
  const cur = normalizeWarpPts(pts, startSample, endSample, totalBeats);
  if (index < 0 || index >= cur.length) return cur;
  return cur.filter((_, i) => i !== index);
}

/**
 * 拖 marker:只改第 index 个中间点的 beat(src 钉死),夹在左右邻居之间(留 gap)。
 * 邻居 = 前一中间点/trim 起,后一中间点/trim 止。返回 normalize 后的中间点数组。
 */
export function movePointBeat(pts: WarpPoint[] | undefined, startSample: number, endSample: number, totalBeats: number, index: number, newBeat: number): WarpPoint[] {
  const cur = normalizeWarpPts(pts, startSample, endSample, totalBeats);
  if (index < 0 || index >= cur.length) return cur;
  const lo = (index > 0 ? cur[index - 1].beat : 0) + MIN_BEAT_GAP;
  const hi = (index < cur.length - 1 ? cur[index + 1].beat : totalBeats) - MIN_BEAT_GAP;
  const beat = Math.min(hi, Math.max(lo, newBeat));
  const next = cur.map((p, i) => (i === index ? { src: p.src, beat } : p));
  return normalizeWarpPts(next, startSample, endSample, totalBeats);
}

/**
 * 中间点 → 渲染用的分数控制点(srcFrac = 占 trim 源比例,beatFrac = 占整 loop 输出比例)。
 * 分数 timeMul 无关(marker 与 loop 同步缩放),故渲染层不必知道 timeMul。先 normalize 保铁律。
 */
export function toFracs(
  pts: WarpPoint[] | null | undefined,
  startSample: number,
  endSample: number,
  totalBeats: number,
): { srcFrac: number; beatFrac: number }[] {
  const span = endSample - startSample;
  if (span <= 0 || totalBeats <= 0) return [];
  return normalizeWarpPts(pts, startSample, endSample, totalBeats).map((p) => ({
    srcFrac: (p.src - startSample) / span,
    beatFrac: p.beat / totalBeats,
  }));
}

/** 缓存签名片段(改 marker → warp-render 缓存 bust)。空 = ''(与单段同签名 → 老缓存不失效)。 */
export function warpPtsSig(pts?: WarpPoint[] | null): string {
  if (!pts || pts.length === 0) return '';
  return pts.map((p) => `${Math.round(p.src)}:${p.beat.toFixed(3)}`).join(';');
}
