'use client';
// 把 studio 从合成 mock 接到**真实库**:复用 loop-machine 的解码 + warp(signalsmith)+ warp-render 落盘缓存管线。
// 一件 sample 乐器 = 库里某条 Sound 的 warp 副本;一件 collage = 几条 Sound 各切一片拼成。
import type { ApiSound } from '@/studio/api';
import { api, cdnUrl } from '@/studio/api';
import type { Clip, CollageClip, Instrument, SampleWarp, Session } from '@/contracts';
import { clipTimeMul, defaultMixer } from '@/contracts';

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

export interface Region { startSample: number; endSample: number; bars: number; semitones: number }
export function regionFromSound(s: ApiSound): Region {
  const w = (s.warp || {}) as Record<string, number>;
  const a = (s.analysis || {}) as Record<string, number>;
  if (typeof w.startSample === 'number' && typeof w.endSample === 'number') return { startSample: w.startSample, endSample: w.endSample, bars: w.bars ?? 1, semitones: w.semitones ?? 0 };
  return { startSample: a.startSample ?? 0, endSample: a.endSample ?? 0, bars: a.bars ?? 1, semitones: 0 };
}
export const regionFromClip = (c: Clip): Region => ({ startSample: c.startSample, endSample: c.endSample, bars: c.bars * clipTimeMul(c), semitones: c.semitones });

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
    warpedBy: w.warpedBy === 'manual' ? 'manual' : 'auto',
  };
}
/** 由 Sound + 其种子 warp 合成一条独立 Clip 副本(无 id;预调喂 ClipEditor、建乐器 clone 都走它)。 */
export function soundToClip(s: ApiSound): Clip {
  const w = warpFromSound(s);
  return { soundId: s.id, assetId: s.assetId, startSample: w.startSample, endSample: w.endSample, bars: w.bars, timeMul: w.timeMul, semitones: w.semitones, gainDb: 0 };
}

const warpCache = new Map<string, AudioBuffer>();
/** 把某条 Sound 的某 region warp 到 masterBpm（signalsmith；先查 warp-render 落盘缓存）。 */
export async function warpToBuffer(s: ApiSound, masterBpm: number, region: Region): Promise<AudioBuffer> {
  const sig = `${s.assetId}|${region.startSample}|${region.endSample}|${region.bars.toFixed(4)}|${region.semitones || 0}|${masterBpm}`;
  const hit = warpCache.get(sig);
  if (hit) return hit;
  try {
    const found = await api.warpRender.get(sig);
    if (found) { const ab = await fetch(found.cdn).then((r) => r.arrayBuffer()); const audio = await getCtx().decodeAudioData(ab); warpCache.set(sig, audio); return audio; }
  } catch { /* 落盘查询失败就渲染 */ }
  const { channels, sampleRate } = await decodeAsset(s.assetId);
  const { warpClip, toAudioBuffer, sliceChannelsPadded } = await import('@/audio/signalsmithWarp');
  const sliced = sliceChannelsPadded(channels, region.startSample, region.endSample);
  const done = await warpClip({ id: sig, channels: sliced, sampleRate, nativeBpm: s.sourceBpm, targetBpm: masterBpm, semitones: region.semitones || 0, beatsPerBar: 4, conditioning: 'trust-tempo', targetBars: region.bars });
  const buf = toAudioBuffer(done);
  warpCache.set(sig, buf);
  if (warpCache.size > 32) warpCache.delete(warpCache.keys().next().value as string);
  return buf;
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
    if (c.eqLowDb) { const f = ctx.createBiquadFilter(); f.type = 'lowshelf'; f.frequency.value = 400; f.gain.value = c.eqLowDb; tail.connect(f); tail = f; } // per-片 EQ low
    if (c.eqHighDb) { const f = ctx.createBiquadFilter(); f.type = 'highshelf'; f.frequency.value = 2500; f.gain.value = c.eqHighDb; tail.connect(f); tail = f; } // per-片 EQ high
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
  for (const s of all) {
    if (!s.parentSoundId) m.set(s.id, s);
    for (const st of s.stems ?? []) m.set(st.id, st); // 分轨 stem 也可被选中/编辑/拖放
  }
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
    return { id: `${idPrefix}-${s.id}`, slot, label: s.name, color: COLORS[slot % COLORS.length], mixer: defaultMixer(), sends: [], enabled: false, payload: { kind: 'sample', clip } };
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
  const collage: Instrument = { id: 'a-chops', slot: verseSamples.length, label: 'Chops (slices)', color: COLORS[5], mixer: defaultMixer(), sends: [], enabled: false, payload: { kind: 'collage', bars: 2, stepsPerBar: 16, loopStartStep: 0, bakedAssetId: null, clips } };

  const breakSamples = sounds.slice(1, Math.min(3, sounds.length)).map((s, i) => sampleInst(s, i, 'b'));

  const sessions: Session[] = [
    { id: 's-a', name: 'Verse', index: 0, instruments: [...verseSamples, collage] },
    { id: 's-b', name: 'Break', index: 1, instruments: breakSamples },
  ];
  return { sessions, soundsById, collageSources, bpm, beatsPerBar: 4 };
}
