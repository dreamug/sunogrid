// 波形峰值采样 + 跨件峰值缓存。从 StudioApp.tsx 抽出(零行为变化):pad/lane/编辑器/库卡共享 lanePeaksCache(同 region 同 key)。

// 波形峰值采样点数:全用同一高密度值 —— pad/lane/编辑器/库卡共享 lanePeaksCache(同 region 同 key),
// 且 peaksFromRegion 是 O(span)(与 n 无关,只多写几个数组元素),故拉高几乎免费,换来宽编辑器里不再有可见折线。
// 旧值 72/100/120 在宽 collage 轨上每个 transient 只摊到 ~6 点 → 圆钝折面;768 让每片 transient 有几十点 → 贴近逐像素的细腻。
const WAVE_N = 768; // 模块私有:仅作 computePeaks/peaksFromRegion 的默认采样点数

export function computePeaks(buf: AudioBuffer, n = WAVE_N): number[] {
  const ch0 = buf.getChannelData(0);
  const ch1 = buf.numberOfChannels > 1 ? buf.getChannelData(1) : null;
  const len = ch0.length, out = new Array(n).fill(0), step = len / n;
  let max = 0;
  for (let i = 0; i < n; i++) {
    const a = Math.floor(i * step), b = Math.min(len, Math.floor((i + 1) * step));
    let pk = 0;
    for (let j = a; j < b; j++) { const v = ch1 ? (Math.abs(ch0[j]) + Math.abs(ch1[j])) * 0.5 : Math.abs(ch0[j]); if (v > pk) pk = v; }
    out[i] = pk; if (pk > max) max = pk;
  }
  if (max > 0) for (let i = 0; i < n; i++) out[i] /= max;
  return out;
}
// 取源解码声道里 [start,end) 区(= trim 后那段)的峰值,供 collage 轨上每片画 trim 后波形。
export function peaksFromRegion(channels: Float32Array[], startSample: number, endSample: number, n = WAVE_N): number[] {
  const ch0 = channels[0]; if (!ch0) return [];
  const len = ch0.length;
  // ⚠不夹 span:trim 区可越界(负起点/超尾),越界处算静音补零 —— 与 warp sliceChannelsPadded / 播放一致,否则波形会"丢掉"前导静音、整体左移。
  const a = Math.round(startSample), b = Math.max(a + 1, Math.round(endSample));
  const span = b - a, out = new Array(n).fill(0), step = span / n;
  let max = 0;
  for (let i = 0; i < n; i++) {
    const s0 = a + Math.floor(i * step), s1 = a + Math.floor((i + 1) * step);
    let pk = 0;
    for (let j = s0; j < s1; j++) { if (j >= 0 && j < len) { const v = Math.abs(ch0[j]); if (v > pk) pk = v; } }
    out[i] = pk; if (pk > max) max = pk;
  }
  if (max > 0) for (let i = 0; i < n; i++) out[i] /= max;
  return out;
}
export const lanePeaksCache = new Map<string, number[]>(); // key = assetId:start:end → 峰值(跨乐器/渲染复用)
export const pieceKey = (c: { assetId: string; startSample: number; endSample: number }) => `${c.assetId}:${Math.round(c.startSample)}:${Math.round(c.endSample)}`;
