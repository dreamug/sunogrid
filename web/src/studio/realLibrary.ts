'use client';
// 把 studio 从合成 mock 接到**真实库**:复用 loop-machine 的解码 + warp(signalsmith)+ warp-render 落盘缓存管线。
// 一件 sample 乐器 = 库里某条 Sound 的 warp 副本;一件 collage = 几条 Sound 各切一片拼成。
import type { ApiSound } from '@/studio/api';
import { api, cdnUrl } from '@/studio/api';
import type { Clip, CollageClip, Instrument, SampleWarp, Session } from '@/contracts';
import { clipTimeMul, defaultMixer, defaultSends, EQ_BANDS, fadeGain } from '@/contracts';

let _ctx: AudioContext | null = null;
const getCtx = () => (_ctx ??= new AudioContext());
const decodeCache = new Map<string, { channels: Float32Array[]; sampleRate: number; durationSec: number }>();

export async function decodeAsset(assetId: string) {
  const hit = decodeCache.get(assetId);
  if (hit) return hit;
  const ab = await fetch(cdnUrl(assetId)).then((r) => r.arrayBuffer());
  const audio = await getCtx().decodeAudioData(ab);
  const channels: Float32Array[] = [];
  for (let c = 0; c < audio.numberOfChannels; c++) channels.push(audio.getChannelData(c).slice());
  const v = { channels, sampleRate: audio.sampleRate, durationSec: audio.duration };
  decodeCache.set(assetId, v);
  return v;
}
async function decodedBuffer(assetId: string): Promise<AudioBuffer> {
  const d = await decodeAsset(assetId);
  const buf = getCtx().createBuffer(d.channels.length, d.channels[0].length, d.sampleRate);
  d.channels.forEach((ch, c) => buf.copyToChannel(ch, c));
  return buf;
}

// fadeOutFrac/fadeSilenceFrac = 占 loop **整段**(渲染出的 buffer)的比例 0..0.5;在 region 层就换算成比例,
// 这样 timeMul(buffer 拉长)时仍与编辑器里看到的"占后半多少"对齐,且 warpToBuffer 不必知道 bars/timeMul。
export interface Region { startSample: number; endSample: number; bars: number; semitones: number; fadeOutFrac?: number; fadeSilenceFrac?: number }
const fadeFrac = (bars: number | undefined, loopBars: number): number => (bars && bars > 0 && loopBars > 0 ? Math.max(0, Math.min(0.5, bars / loopBars)) : 0);
export function regionFromSound(s: ApiSound): Region {
  const w = (s.warp || {}) as Record<string, number>;
  const a = (s.analysis || {}) as Record<string, number>;
  if (typeof w.startSample === 'number' && typeof w.endSample === 'number') {
    const bars = w.bars ?? 1;
    return { startSample: w.startSample, endSample: w.endSample, bars, semitones: w.semitones ?? 0, fadeOutFrac: fadeFrac(w.fadeOutBars, bars), fadeSilenceFrac: fadeFrac(w.fadeSilenceBars, bars) };
  }
  return { startSample: a.startSample ?? 0, endSample: a.endSample ?? 0, bars: a.bars ?? 1, semitones: 0 };
}
export const regionFromClip = (c: Clip): Region => { const loopBars = c.bars * clipTimeMul(c); return { startSample: c.startSample, endSample: c.endSample, bars: loopBars, semitones: c.semitones, fadeOutFrac: fadeFrac(c.fadeOutBars, loopBars), fadeSilenceFrac: fadeFrac(c.fadeSilenceBars, loopBars) }; }; // fade 比例的分母 = 渲染出的 buffer 总小节数(bars×timeMul);用 c.bars 会让 timeMul≠1 时淡出长度被成倍放大(字段语义=距 loop 尾 fadeOutBars 小节)

/** Sound.warp(JSON 种子)→ 强类型 SampleWarp(与 Clip 同形)。缺字段按 analysis 兜底;出身默认 auto。 */
export function warpFromSound(s: ApiSound): SampleWarp {
  const w = (s.warp || {}) as Record<string, unknown>;
  const a = (s.analysis || {}) as Record<string, number>;
  const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
  const has = typeof w.startSample === 'number' && typeof w.endSample === 'number';
  return {
    startSample: has ? num(w.startSample, 0) : (a.startSample ?? 0),
    endSample: has ? num(w.endSample, 0) : (a.endSample ?? 0),
    bars: num(w.bars, a.bars ?? 1),
    timeMul: typeof w.timeMul === 'number' ? num(w.timeMul, 1) : undefined,
    semitones: num(w.semitones, 0),
    fadeOutBars: typeof w.fadeOutBars === 'number' ? num(w.fadeOutBars, 0) : undefined,
    fadeSilenceBars: typeof w.fadeSilenceBars === 'number' ? num(w.fadeSilenceBars, 0) : undefined,
    warpedBy: w.warpedBy === 'manual' ? 'manual' : 'auto',
  };
}
/** 由 Sound + 其种子 warp 合成一条独立 Clip 副本(无 id;预调喂 ClipEditor、建乐器 clone 都走它)。 */
export function soundToClip(s: ApiSound): Clip {
  const w = warpFromSound(s);
  return { soundId: s.id, assetId: s.assetId, startSample: w.startSample, endSample: w.endSample, bars: w.bars, timeMul: w.timeMul, semitones: w.semitones, fadeOutBars: w.fadeOutBars, fadeSilenceBars: w.fadeSilenceBars, gainDb: 0 };
}

const warpCache = new Map<string, AudioBuffer>();
const lruBump = (k: string, v: AudioBuffer) => { warpCache.delete(k); warpCache.set(k, v); }; // 命中刷到最近端(真 LRU)
const lruTrim = () => { if (warpCache.size > 40) warpCache.delete(warpCache.keys().next().value as string); };
// 纯 warp 的缓存键(不含 fade):落盘渲染只存纯 warp,fade 在内存里后挂(见 applyFade)。
// `x1` = warp 算法版本标记(x1=输出烘入 loop 缝交叉淡化,见 signalsmithWarp)。改 warp 产物口径时 ++,令旧落盘渲染失效、强制重渲。
const pureSig = (s: ApiSound, masterBpm: number, region: Region) => `${s.assetId}|${region.startSample}|${region.endSample}|${region.bars.toFixed(4)}|${region.semitones || 0}|${s.sourceBpm}|${masterBpm}|x1`;

/** clip 尾淡出:在纯 warp 出来的 buffer 尾巴乘一条隆起抛物线包络 1-t²(两点曲线:fadeStart→fadeEnd 由 1 降到 0,fadeEnd 之后到尾=静音)。
 *  烘进 buffer 而非实时增益 → 与 trim/warp 同档离线,引擎 loop=true 时每圈循环自然淡尾(也顺手消循环接缝爆音)。不改源 buffer,返回新副本。 */
function applyFade(base: AudioBuffer, outFrac: number, silFrac: number): AudioBuffer {
  const dur = base.duration, SR = base.sampleRate, n = base.length;
  const fadeStart = dur * (1 - outFrac);
  const fadeEnd = dur * (1 - Math.min(silFrac, outFrac));
  const span = Math.max(1e-6, fadeEnd - fadeStart);
  const startIdx = Math.max(0, Math.min(n, Math.floor(fadeStart * SR))); // 淡出前整段不变 → 只处理这之后
  const out = getCtx().createBuffer(base.numberOfChannels, n, SR);
  for (let ch = 0; ch < base.numberOfChannels; ch++) {
    const src = base.getChannelData(ch), dst = out.getChannelData(ch);
    dst.set(src.subarray(0, startIdx)); // 不变前缀整段拷(不逐样本)
    for (let i = startIdx; i < n; i++) {
      const t = i / SR;
      dst[i] = t >= fadeEnd ? 0 : src[i] * fadeGain((t - fadeStart) / span); // fadeGain = 隆起抛物线,与编辑器共用
    }
  }
  return out;
}

/** 纯 warp(无 fade):某条 Sound 的某 region warp 到 masterBpm(signalsmith;先查 warp-render 落盘缓存)。 */
async function warpPure(s: ApiSound, masterBpm: number, region: Region): Promise<AudioBuffer> {
  // sourceBpm 决定拉伸比(喂 nativeBpm),必须进 key:否则同一 asset 的 sourceBpm 被重新分析/纠正后,旧 key 仍命中旧拉伸 = 放错速度/音高。
  const sig = pureSig(s, masterBpm, region);
  const hit = warpCache.get(sig);
  if (hit) { lruBump(sig, hit); return hit; }
  try {
    const found = await api.warpRender.get(sig);
    if (found) { const ab = await fetch(found.cdn).then((r) => r.arrayBuffer()); const audio = await getCtx().decodeAudioData(ab); warpCache.set(sig, audio); return audio; }
  } catch { /* 落盘查询失败就渲染 */ }
  const { channels, sampleRate } = await decodeAsset(s.assetId);
  const { warpClip, toAudioBuffer, sliceChannelsPadded } = await import('@/audio/signalsmithWarp');
  const sliced = sliceChannelsPadded(channels, region.startSample, region.endSample);
  const done = await warpClip({ id: sig, channels: sliced, sampleRate, nativeBpm: s.sourceBpm, targetBpm: masterBpm, semitones: region.semitones || 0, beatsPerBar: 4, conditioning: 'trust-tempo', targetBars: region.bars });
  const buf = toAudioBuffer(done);
  warpCache.set(sig, buf); lruTrim();
  return buf;
}

/** 把某条 Sound 的某 region warp 到 masterBpm,并按 region 上的 fade 比例后挂尾部淡出(命中纯 warp 缓存 + faded 缓存分开存)。 */
export async function warpToBuffer(s: ApiSound, masterBpm: number, region: Region): Promise<AudioBuffer> {
  const base = await warpPure(s, masterBpm, region);
  const outFrac = Math.max(0, Math.min(0.5, region.fadeOutFrac ?? 0));
  if (outFrac <= 1e-4) return base;
  const silFrac = Math.max(0, Math.min(outFrac, region.fadeSilenceFrac ?? 0));
  const fsig = `${pureSig(s, masterBpm, region)}|fo${outFrac.toFixed(4)}|fs${silFrac.toFixed(4)}`;
  const fhit = warpCache.get(fsig);
  if (fhit) { lruBump(fsig, fhit); return fhit; }
  const faded = applyFade(base, outFrac, silFrac);
  warpCache.set(fsig, faded); lruTrim();
  return faded;
}

export interface RealStudio { sessions: Session[]; soundsById: Map<string, ApiSound>; collageSources: Map<string, AudioBuffer>; bpm: number; beatsPerBar: number }

const COLORS = ['#c2724f', '#6a86a0', '#c2a24f', '#8a9b6a', '#a06f8a', '#9a7bc0'];

/** Studio collage:每片 = 真·warp Clip。逐片 warp 到自己的 bars → 按 startStep 摆位 → 只渲染 **loop 区间** [loopStartStep, +bars) 成一条。
 *  loop 区由乐器拉杆定(与内容解耦):片偏移 = startStep−loopStartStep;落在 loop 前/后的片排除,跨 loop 尾的片硬切。
 *  片间/开头留白 = 静音;与 ClipEditor 的 warp 模型一致(所见=所听)。 */
export async function buildCollageBuffer(
  clips: CollageClip[], stepsPerBar: number, bars: number, loopStartStep: number, bpm: number, beatsPerBar: number, soundsById: Map<string, ApiSound>,
): Promise<AudioBuffer | null> {
  const masterBar = (beatsPerBar * 60) / bpm;
  const stepSec = masterBar / Math.max(1, stepsPerBar);
  const loopStartSec = loopStartStep * stepSec;
  const loopLenSec = Math.max(stepSec, bars * masterBar); // loop 长度
  const placed: { buf: AudioBuffer; offsetSec: number; c: CollageClip }[] = [];
  for (const c of clips) {
    const s = soundsById.get(c.soundId);
    if (!s) continue;
    const offsetSec = c.startStep * stepSec - loopStartSec; // 相对 loop 起点的位置
    const buf = await warpToBuffer(s, bpm, regionFromClip(c)); // 拉伸到 c.bars(含 timeMul)@bpm,变调保音高
    if (offsetSec >= loopLenSec) continue;          // 整片在 loop 之后
    if (offsetSec + buf.duration <= 0) continue;     // 整片在 loop 之前
    placed.push({ buf, offsetSec, c });
  }
  if (!placed.length) return null;
  const SR = 48000;
  const ctx = new OfflineAudioContext(2, Math.max(1, Math.round(loopLenSec * SR)), SR);
  for (const { buf, offsetSec, c } of placed) {
    const node = ctx.createBufferSource(); node.buffer = buf; // SR 不一致时 bufferSource 自动重采样到 ctx
    let tail: AudioNode = node;
    const g = ctx.createGain(); g.gain.value = Math.pow(10, c.gainDb / 20); tail.connect(g); tail = g; // per-片 gain
    if (c.pan) { const p = ctx.createStereoPanner(); p.pan.value = Math.max(-1, Math.min(1, c.pan)); tail.connect(p); tail = p; } // per-片 pan
    if (c.eqLowDb) { const f = ctx.createBiquadFilter(); f.type = 'lowshelf'; f.frequency.value = EQ_BANDS.lowFreq; f.gain.value = c.eqLowDb; tail.connect(f); tail = f; } // per-片 EQ low(频点/dB 与 studioEngine 共用 EQ_BANDS)
    if (c.eqMidDb) { const f = ctx.createBiquadFilter(); f.type = 'peaking'; f.frequency.value = EQ_BANDS.midFreq; f.Q.value = EQ_BANDS.midQ; f.gain.value = c.eqMidDb; tail.connect(f); tail = f; } // per-片 EQ mid(钟形,频点/Q 与 studioEngine 对齐)
    if (c.eqHighDb) { const f = ctx.createBiquadFilter(); f.type = 'highshelf'; f.frequency.value = EQ_BANDS.highFreq; f.gain.value = c.eqHighDb; tail.connect(f); tail = f; } // per-片 EQ high
    tail.connect(ctx.destination);
    node.start(Math.max(0, offsetSec), offsetSec < 0 ? -offsetSec : 0); // 片起点在 loop 前 → 从 buffer 内部跳入
    node.stop(loopLenSec); // loop 尾硬切
  }
  return ctx.startRendering();
}

/** 一件乐器 → 可播放 buffer（sample 走 warp，collage 逐片 warp 后摆位合成）。统一入口,reconcile/add/edit 都用它。 */
export async function buildBuffer(inst: Instrument, bpm: number, soundsById: Map<string, ApiSound>): Promise<AudioBuffer | null> {
  if (inst.payload.kind === 'sample') {
    const s = soundsById.get(inst.payload.clip.soundId);
    if (!s) return null;
    return warpToBuffer(s, bpm, regionFromClip(inst.payload.clip));
  }
  const p = inst.payload;
  return buildCollageBuffer(p.clips, p.stepsPerBar, p.bars, p.loopStartStep, bpm, 4, soundsById);
}

/** 从真实库拉 Sound，造 2 个 session（Verse = 4 sample + 1 collage；Break = 2 sample）。 */
/** 全库 Sound（顶层 + 分轨 stem 都拍平进 Map）→ 供 buildBuffer / 编辑器按任意 soundId 解析（含 stem 子轨）。 */
export async function loadLibrary(): Promise<Map<string, ApiSound>> {
  const all = await api.sounds.list();
  const m = new Map<string, ApiSound>();
  // 递归收全部后代:顶层 + stem + 鼓件孙轨(§29)都可被选中/编辑/拖放
  const walk = (s: ApiSound) => { m.set(s.id, s); for (const st of s.stems ?? []) walk(st); };
  for (const s of all) walk(s);
  return m;
}
/** 给一组 soundId 解码出 collage 源 buffer（落库加载 collage 乐器时用）。 */
export async function collageSourcesFor(soundIds: string[], soundsById: Map<string, ApiSound>): Promise<Map<string, AudioBuffer>> {
  const m = new Map<string, AudioBuffer>();
  for (const id of soundIds) { const s = soundsById.get(id); if (s) m.set(id, await decodedBuffer(s.assetId)); }
  return m;
}

export async function buildRealStudio(bpm = 90): Promise<RealStudio> {
  const soundsById = await loadLibrary();
  const sounds = [...soundsById.values()].slice(0, 6);
  if (sounds.length === 0) throw new Error('No samples in the library');

  const sampleInst = (s: ApiSound, slot: number, idPrefix: string): Instrument => {
    const r = regionFromSound(s);
    const clip: Clip = { soundId: s.id, assetId: s.assetId, startSample: r.startSample, endSample: r.endSample, bars: r.bars, semitones: r.semitones, gainDb: 0 };
    return { id: `${idPrefix}-${s.id}`, slot, label: s.name, color: COLORS[slot % COLORS.length], mixer: defaultMixer(), sends: defaultSends(), enabled: false, payload: { kind: 'sample', clip } };
  };

  const verseSamples = sounds.slice(0, Math.min(4, sounds.length)).map((s, i) => sampleInst(s, i, 'a'));

  // 一件真实 collage:前 3 条 Sound 各切一小片（~0.45s）拼成 2 小节。
  const chopSounds = sounds.slice(0, Math.min(3, sounds.length));
  const collageSources = new Map<string, AudioBuffer>();
  const clips: CollageClip[] = [];
  for (let i = 0; i < chopSounds.length; i++) {
    const s = chopSounds[i];
    collageSources.set(s.id, await decodedBuffer(s.assetId));
    const r = regionFromSound(s);
    const chopLen = Math.round(0.45 * s.sampleRate);
    clips.push({ id: `k${i}`, soundId: s.id, assetId: s.assetId, startSample: r.startSample, endSample: r.startSample + chopLen, bars: 0.5, semitones: i === 2 ? 5 : 0, gainDb: 0, startStep: i * 8 });
  }
  const collage: Instrument = { id: 'a-chops', slot: verseSamples.length, label: 'Chops (slices)', color: COLORS[5], mixer: defaultMixer(), sends: defaultSends(), enabled: false, payload: { kind: 'collage', bars: 2, stepsPerBar: 16, loopStartStep: 0, bakedAssetId: null, clips } };

  const breakSamples = sounds.slice(1, Math.min(3, sounds.length)).map((s, i) => sampleInst(s, i, 'b'));

  const sessions: Session[] = [
    { id: 's-a', name: 'Verse', index: 0, repeats: 1, color: '#6f9e8b', instruments: [...verseSamples, collage] },
    { id: 's-b', name: 'Break', index: 1, repeats: 1, color: '#7e8a9e', instruments: breakSamples },
  ];
  return { sessions, soundsById, collageSources, bpm, beatsPerBar: 4 };
}
