'use client';
// §33 长素材切块:把整首(> MAX_LOOP_BARS 小节)切成若干整小节、可无缝循环的块。
// 纯函数,无音频上下文。BPM 是锚(生成=sourceBpm / 上传=estimateTempo,切块前已定);
// 实际网格 bpm 由调用方传 —— ingest 传 analysis.bpm(loopBpm:让整首恰好 N 小节 → 块整齐铺满)。
// 命门(§33.1):难的不是切,是定 grid origin(下拍相位);错半拍则块块不循环。
import { toMono, novelty, HOP, ANALYZE_SECONDS } from './conditioning';

export const MAX_LOOP_BARS = 32;      // 闸门:> 此小节数才切(§33.2,按小节不按秒)
export const DEFAULT_BLOCK_BARS = 16; // 默认每块小节(≈30s @140);UI 可选 8 / 16 / 32
export const MIN_BLOCK_BARS = 4;      // 末块下限,不足则并入前块(§33.1 余数)
const BLOCK_CHOICES = [4, 8, 16, 32];

export interface ChopBlock {
  startSample: number;
  endSample: number;
  bars: number;          // 整数小节
  sectionLabel?: string; // v2 结构感知回填;v1 留空 → UI 显 Block N
}
export interface ChopResult {
  origin: number;    // 下拍相位(样本,[0, samplesPerBar));块从此对齐
  blockBars: number; // 实际每块小节
  blocks: ChopBlock[];
}
export interface ChopOpts {
  beatsPerBar?: number;
  blockBars?: number;     // 覆盖默认块长(UI 8 / 16 / 32);吸到 BLOCK_CHOICES
  originSamples?: number; // 覆盖 origin(总览拖 origin 手柄重切)
  minBlockBars?: number;
}

/** 闸门:这条素材该不该切(§33.2,按小节)。 */
export function shouldChop(bars: number): boolean {
  return bars > MAX_LOOP_BARS;
}

function snapBlockBars(req: number | undefined): number {
  const v = req ?? DEFAULT_BLOCK_BARS;
  let best = BLOCK_CHOICES[0];
  for (const a of BLOCK_CHOICES) if (Math.abs(a - v) <= Math.abs(best - v)) best = a;
  return best;
}

/** 估 grid origin = 下拍相位(样本,[0, samplesPerBar))。
 *  做法:novelty 包络对 bar 网格做相位扫描,选让 bar 线压在最强重复瞬态上的相位(§33.1)。
 *  恒速素材(Suno 必恒速)头部相位即全局相位,故只看头部一段(ANALYZE_SECONDS)够用。 */
export function estimateOrigin(channels: Float32Array[], sampleRate: number, samplesPerBar: number): number {
  if (!(samplesPerBar > 0)) return 0;
  const mono = toMono(channels);
  const headEnd = Math.min(mono.length, Math.floor(ANALYZE_SECONDS * sampleRate));
  const nov = novelty(mono, 0, headEnd);
  const framesPerBar = samplesPerBar / HOP;
  const span = Math.max(1, Math.round(framesPerBar));
  if (nov.length < span) return 0;
  let bestPhase = 0;
  let bestScore = -1;
  for (let p = 0; p < span; p++) {
    let score = 0;
    for (let k = 0; ; k++) {
      const f = Math.round(p + k * framesPerBar);
      if (f >= nov.length) break;
      score += nov[f];
    }
    if (score > bestScore) { bestScore = score; bestPhase = p; }
  }
  const origin = bestPhase * HOP;
  return origin % samplesPerBar;
}

/** 把整首切成整小节块(§33.5 v1 盲网格)。
 *  块从 origin 起、每块 blockBars 小节;origin 前不足一小节的弱起(< 1 bar)丢弃(总览可拖 origin 找回);
 *  末块不足 minBlockBars → 并入前块(§33.1)。每个中间块都恰好 blockBars 小节 → 真正可循环。 */
export function chopSong(channels: Float32Array[], sampleRate: number, bpm: number, opts: ChopOpts = {}): ChopResult {
  const beatsPerBar = opts.beatsPerBar ?? 4;
  const len = channels[0]?.length ?? 0;
  const samplesPerBar = ((beatsPerBar * 60) / Math.max(1, bpm)) * sampleRate;
  const blockBars = snapBlockBars(opts.blockBars);
  const minBars = opts.minBlockBars ?? MIN_BLOCK_BARS;
  const step = blockBars * samplesPerBar;
  const barsOf = (a: number, b: number) => Math.max(1, Math.round((b - a) / samplesPerBar));

  const rawOrigin = opts.originSamples != null
    ? Math.max(0, opts.originSamples) % samplesPerBar
    : estimateOrigin(channels, sampleRate, samplesPerBar);
  // origin 接近 0(< 5% 小节)视作 0,免在最前面丢一丁点。
  const origin = rawOrigin < samplesPerBar * 0.05 ? 0 : Math.round(rawOrigin);

  // 太短(切不出 ≥2 整块)→ 整段一块。
  if (len <= origin + step || samplesPerBar <= 0) {
    return { origin, blockBars, blocks: [{ startSample: 0, endSample: len, bars: barsOf(0, len) }] };
  }

  // 下拍块起点:origin, origin+step, …(< len - 半小节才再开一块,余下并进末块)。
  const starts: number[] = [];
  for (let b = origin; b < len - samplesPerBar * 0.5; b += step) starts.push(Math.round(b));
  if (starts.length === 0) starts.push(origin);

  const blocks: ChopBlock[] = starts.map((start, i) => {
    const end = i + 1 < starts.length ? starts[i + 1] : len;
    return { startSample: start, endSample: end, bars: barsOf(start, end) };
  });

  // 余数:末块不足下限 → 并入前块。
  if (blocks.length >= 2 && blocks[blocks.length - 1].bars < minBars) {
    const last = blocks.pop()!;
    const prev = blocks[blocks.length - 1];
    prev.endSample = last.endSample;
    prev.bars = barsOf(prev.startSample, prev.endSample);
  }

  return { origin, blockBars, blocks };
}
