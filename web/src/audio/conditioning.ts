'use client';
// 从一段 Suno loop 估出:loop 区(去边缘静音)+ 小节数 N + 速度 + 置信度 + 瞬态。
// 核心:**输入 BPM 是母**(= 发给 Suno 的 user_tempo,生成必在它附近)。
//   N = round(时长 × 输入BPM / (拍数×60))     —— 锚定输入,取整极稳,杜绝倍频错
//   loopBpm = N × 拍数 × 60 / 时长             —— 把整段当成正好 N 小节(warp 后无缝)
//   自相关只在输入 ±12% 窄窗里算置信度,不参与定 N。
// 纯函数,无音频上下文依赖。

export interface LoopAnalysis {
  startSample: number; // 去边缘静音后的起点
  endSample: number;   // 终点
  bars: number;        // 小节数 N(锚定输入 BPM)
  bpm: number;         // loopBpm:把整段当成 N 小节的无缝速度
  confidence: number;  // 0..1
  exactBars: number;   // 未取整的小节数(给 UI)
  onsets: number[];    // 瞬态采样位置
}

export const HOP = 256;

/** DSP 分析(测速/自相关/瞬态)只看头部这一个段落,长素材不至于全量扫 —— 整段时长/小节数仍按全长算(纯算术,不吃这刀)。
 *  与 estimateKey 的截断同口径,单一来源。 */
export const ANALYZE_SECONDS = 30;

export function toMono(channels: Float32Array[]): Float32Array {
  if (channels.length === 1) return channels[0];
  const n = channels[0].length;
  const out = new Float32Array(n);
  for (let c = 0; c < channels.length; c++) {
    const ch = channels[c];
    for (let i = 0; i < n; i++) out[i] += ch[i] / channels.length;
  }
  return out;
}

/** onset novelty 包络(帧 RMS 的正向差分,去均值)。 */
export function novelty(mono: Float32Array, s: number, e: number): Float32Array {
  const frames = Math.max(0, Math.floor((e - s) / HOP));
  const energy = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    let sum = 0;
    const base = s + f * HOP;
    for (let i = 0; i < HOP; i++) { const v = mono[base + i]; sum += v * v; }
    energy[f] = Math.sqrt(sum / HOP);
  }
  const nov = new Float32Array(frames);
  for (let f = 1; f < frames; f++) nov[f] = Math.max(0, energy[f] - energy[f - 1]);
  let mean = 0;
  for (let f = 0; f < frames; f++) mean += nov[f];
  mean /= frames || 1;
  for (let f = 0; f < frames; f++) nov[f] = Math.max(0, nov[f] - mean);
  return nov;
}

/** 在 expected 附近(窄窗)找 novelty 自相关峰,返回归一化峰强 —— 只用于置信度。 */
function beatScore(nov: Float32Array, expectedLag: number, tolFrac = 0.12): { lag: number; score: number } {
  const lo = Math.max(2, Math.floor(expectedLag * (1 - tolFrac)));
  const hi = Math.min(nov.length - 2, Math.ceil(expectedLag * (1 + tolFrac)));
  let energy = 0;
  for (let i = 0; i < nov.length; i++) energy += nov[i] * nov[i];
  let best = { lag: Math.round(expectedLag), score: 0 };
  for (let L = lo; L <= hi; L++) {
    let sum = 0;
    for (let i = 0; i + L < nov.length; i++) sum += nov[i] * nov[i + L];
    const score = energy > 0 ? sum / energy : 0;
    if (score > best.score) best = { lag: L, score };
  }
  return best;
}

/** novelty 局部峰 → 瞬态采样位置。高阈值 + 最小间距,只留真正击点。 */
function pickOnsets(nov: Float32Array, s: number, sampleRate: number): number[] {
  let max = 0;
  for (let f = 0; f < nov.length; f++) max = Math.max(max, nov[f]);
  if (max <= 0) return [];
  const thr = max * 0.35;
  const minGap = Math.max(1, Math.round((0.1 * sampleRate) / HOP)); // ≥ ~100ms
  const out: number[] = [];
  let lastF = -minGap;
  for (let f = 1; f < nov.length - 1; f++) {
    if (nov[f] >= thr && nov[f] >= nov[f - 1] && nov[f] >= nov[f + 1] && f - lastF >= minGap) {
      out.push(s + f * HOP);
      lastF = f;
    }
  }
  return out;
}

export function detectLoop(
  channels: Float32Array[],
  sampleRate: number,
  inputBpm: number,
  beatsPerBar = 4,
): LoopAnalysis {
  const mono = toMono(channels);
  // 不裁:loop=整文件(尾部留白是音乐性间隙,裁了会变速/不接缝;真实 Suno loop 也无缝)。
  // 开头留白少见,留给编辑器手动 trim。
  const s = 0;
  const e = mono.length;
  const dur = (e - s) / sampleRate;
  const bpm0 = inputBpm > 0 ? inputBpm : 120;

  // 锚定输入 BPM 定 N(取整极稳),再反推无缝 loopBpm。
  const barSecInput = (beatsPerBar * 60) / bpm0;
  const exactBars = dur / barSecInput;
  const bars = Math.max(1, Math.round(exactBars));
  const loopBpm = (bars * beatsPerBar * 60) / dur;

  // 置信度:① 时长接近整 N 小节 ② 节拍自相关峰强(窄窗) ③ 节拍速度与输入一致
  // —— 测速/自相关/瞬态只看头部一个段落(ANALYZE_SECONDS),长素材不全量扫;bars/loopBpm 已按全长算。
  const eAna = Math.min(e, s + Math.floor(ANALYZE_SECONDS * sampleRate));
  const nov = novelty(mono, s, eAna);
  const expectedBeatFrames = ((60 / bpm0) * sampleRate) / HOP;
  const { lag, score } = beatScore(nov, expectedBeatFrames, 0.12);
  const refinedBpm = 60 / ((lag * HOP) / sampleRate);
  const integerness = Math.max(0, 1 - 2 * Math.abs(exactBars - Math.round(exactBars)));
  const agree = Math.max(0, 1 - Math.abs(refinedBpm - bpm0) / (bpm0 * 0.15));
  const confidence = Math.max(0, Math.min(1, 0.45 * integerness + 0.3 * Math.min(1, score * 2) + 0.25 * agree));

  return {
    startSample: s,
    endSample: e,
    bars,
    bpm: Math.round(loopBpm * 10) / 10,
    confidence: Math.round(confidence * 100) / 100,
    exactBars: Math.round(exactBars * 100) / 100,
    onsets: pickOnsets(nov, s, sampleRate),
  };
}
