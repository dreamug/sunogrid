'use client';
// §27 上传样本的「从零检测」:估速(BPM)+ 估调(key)。纯函数,无音频上下文依赖。
// ⚠️ 为什么不能直接用 conditioning.ts 的 detectLoop:那套「输入 BPM 是母」,锚定已知速度,
//    自相关只在 ±12% 窄窗算置信度,不从零找速度。上传没有用户填的 BPM,所以这里先估出来,
//    再把估速喂回 detectLoop 拿 bars / loop 区 / warp 种子(见 studioGens.uploadToLibrary)。
import { ANALYZE_SECONDS, HOP, novelty, toMono } from '@/audio/conditioning';

export interface TempoEstimate { bpm: number; confidence: number } // confidence 0..1
export interface KeyEstimate { key: string | null; confidence: number } // 'C' / 'Am' …;-1..1 → 取正

// 速度先验:log-tempo 高斯,中心 120 BPM,σ≈0.55 八度 —— 给倍频消歧加权(偏向常见区间)。
function tempoPrior(bpm: number): number {
  const c = Math.log2(bpm / 120) / 0.55;
  return Math.exp(-0.5 * c * c);
}

/** 估速:novelty 包络宽域自相关找节拍周期 + 先验加权选峰 + 抛物线插值 + 八度归一到 [70,180]。 */
export function estimateTempo(channels: Float32Array[], sampleRate: number): TempoEstimate {
  const mono = toMono(channels);
  const nov = novelty(mono, 0, Math.min(mono.length, Math.floor(sampleRate * ANALYZE_SECONDS))); // 只看头部一个段落,长素材省算力
  if (nov.length < 16) return { bpm: 120, confidence: 0 };
  const fps = sampleRate / HOP; // novelty 帧率
  const lagMin = Math.max(2, Math.floor((fps * 60) / 200)); // 200 BPM
  const lagMax = Math.min(nov.length - 2, Math.ceil((fps * 60) / 60)); // 60 BPM
  if (lagMax <= lagMin + 1) return { bpm: 120, confidence: 0 };
  let energy = 0;
  for (let i = 0; i < nov.length; i++) energy += nov[i] * nov[i];
  const ac = new Float32Array(lagMax + 2);
  for (let L = lagMin; L <= lagMax; L++) {
    let sum = 0;
    for (let i = 0; i + L < nov.length; i++) sum += nov[i] * nov[i + L];
    ac[L] = energy > 0 ? sum / energy : 0;
  }
  // 在局部极大里按「自相关峰强 × 速度先验」选最优 lag(消半/倍频错)。
  let best = { lag: 0, raw: 0, score: -1 };
  for (let L = lagMin + 1; L < lagMax; L++) {
    if (ac[L] >= ac[L - 1] && ac[L] >= ac[L + 1]) {
      const bpm = (60 * fps) / L;
      const score = ac[L] * tempoPrior(bpm);
      if (score > best.score) best = { lag: L, raw: ac[L], score };
    }
  }
  if (!best.lag) return { bpm: 120, confidence: 0 };
  // 抛物线插值精修 lag。
  const L = best.lag;
  const y0 = ac[L - 1], y1 = ac[L], y2 = ac[L + 1];
  const denom = y0 - 2 * y1 + y2;
  const delta = denom !== 0 ? Math.max(-0.5, Math.min(0.5, (0.5 * (y0 - y2)) / denom)) : 0;
  let bpm = (60 * fps) / (L + delta);
  while (bpm < 70) bpm *= 2;
  while (bpm > 180) bpm /= 2;
  return { bpm: Math.round(bpm * 10) / 10, confidence: Math.round(Math.max(0, Math.min(1, best.raw)) * 100) / 100 };
}

// Krumhansl–Schmuckler 大/小调音级权重模板。
const KS_MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const KS_MINOR = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];
const ROOTS = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

/** Goertzel:单频功率(整段)。 */
function goertzel(x: Float32Array, start: number, len: number, freq: number, sr: number): number {
  const coeff = 2 * Math.cos((2 * Math.PI * freq) / sr);
  let s1 = 0, s2 = 0;
  for (let i = 0; i < len; i++) {
    const s0 = x[start + i] + coeff * s1 - s2;
    s2 = s1;
    s1 = s0;
  }
  return s1 * s1 + s2 * s2 - coeff * s1 * s2;
}

/** Pearson 相关(两等长向量)。 */
function corr(a: number[], b: number[]): number {
  const n = a.length;
  let ma = 0, mb = 0;
  for (let i = 0; i < n; i++) { ma += a[i]; mb += b[i]; }
  ma /= n; mb /= n;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) {
    const xa = a[i] - ma, xb = b[i] - mb;
    num += xa * xb; da += xa * xa; db += xb * xb;
  }
  return da > 0 && db > 0 ? num / Math.sqrt(da * db) : 0;
}

/** 估调:Goertzel 累出 12 维 chroma → 对 KS 大/小调 24 旋转取最相关 → 'C' / 'Am'。 */
export function estimateKey(channels: Float32Array[], sampleRate: number): KeyEstimate {
  const mono = toMono(channels);
  const len = Math.min(mono.length, Math.floor(sampleRate * ANALYZE_SECONDS)); // 取头部一个段落足够定调,省算力(同测速口径)
  if (len < sampleRate) return { key: null, confidence: 0 };
  const chroma = new Array(12).fill(0);
  // MIDI 40..76(E2..E5)= 大部分调性能量所在;每个音的 Goertzel 功率累进其音级。
  for (let midi = 40; midi <= 76; midi++) {
    const freq = 440 * Math.pow(2, (midi - 69) / 12);
    chroma[midi % 12] += goertzel(mono, 0, len, freq, sampleRate);
  }
  const total = chroma.reduce((s, v) => s + v, 0);
  if (total <= 0) return { key: null, confidence: 0 };
  for (let i = 0; i < 12; i++) chroma[i] /= total;
  let best = { key: null as string | null, score: -2 };
  for (let t = 0; t < 12; t++) {
    const rot = Array.from({ length: 12 }, (_, i) => chroma[(t + i) % 12]);
    const cMaj = corr(rot, KS_MAJOR);
    if (cMaj > best.score) best = { key: ROOTS[t], score: cMaj };
    const cMin = corr(rot, KS_MINOR);
    if (cMin > best.score) best = { key: ROOTS[t] + 'm', score: cMin };
  }
  return { key: best.key, confidence: Math.round(Math.max(0, best.score) * 100) / 100 };
}
