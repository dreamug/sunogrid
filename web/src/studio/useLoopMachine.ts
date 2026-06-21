'use client';
// M5 控制器(doc-as-truth + undo/redo 版)。
// ─ 真相源:ProjectDoc(可撤销的项目编排 = pad 布局 + 每 pad warp + 主 BPM + 量化)。
//   所有编排变更走 applyDoc(label, recipe[, coalesceKey]) → 算出新 doc → reconcile(before, after)
//   幂等投影到 DB(api.*)+ 音频引擎。undo/redo 只是搬快照后走同一个 reconcile,故逆操作「免费」。
// ─ 库(Sound/Gen)仍是只读引用缓存 + 外部副作用(生成/分离),不在 doc、不进 undo。
// ─ warp 渲染在客户端缓存 + 落盘缓存(/api/warp-render)。
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AudioEngine, EngineEvent, PadState, Quantize } from '@/contracts';
import { PADS_PER_BANK } from '@/contracts';
import { detectLoop, type LoopAnalysis } from '@/audio/conditioning';
import type { WarpRegion } from '@/studio/ui/WarpEditor';
import { api, cdnUrl, type ApiPad, type ApiProject, type ApiSound } from './api';
import { clipColor } from './clipColor';
import {
  type ProjectDoc, type PadEntry, type WarpJson, type HistState,
  emptyDoc, produceDoc, diffDoc, docChanged, initHist, histApply, histUndo, histRedo,
  canUndo as histCanUndo, canRedo as histCanRedo,
} from './history';

export const BANKS = 4;
const BANK_IDS = ['A', 'B', 'C', 'D'];
const gid = (bank: number, index: number) => bank * PADS_PER_BANK + index;
const splitGid = (g: number) => ({ bank: Math.floor(g / PADS_PER_BANK), padIndex: g % PADS_PER_BANK });
const ACTIVE_PAD: PadState[] = ['playing', 'queued', 'stopping']; // 算作「在响」的 pad 态(编辑器跟随用)
const SCRATCH = -1; // 临时"试验 pad"槽:warp 区试听走和 pad 同一套引擎播放(量化/主时钟/循环、和整曲一起响),只是不持久化。走带=绝对总控,停走带连它一起停。

export type LoopStatus = 'auto' | 'pending' | 'manual';
export interface LoopView {
  id: string; label: string; status: LoopStatus; srcBpm: number; bars: number; color: string;
  durationSec: number; musicalKey?: string | null; // 库卡展示用:秒数 + 调
  stemKind?: string; stemStatus?: string | null; stems?: LoopView[]; // 乐器分离
}
export interface PadView { loopId: string | null; sourceSoundId: string | null; label: string; state: PadState; color: string; bars: number; peaks: number[]; selected: boolean }

/** 把音频降采样成 N 个峰值(0..1),用于 pad 上画小波形。 */
function computePeaks(buf: AudioBuffer, n = 120): number[] {
  const ch0 = buf.getChannelData(0);
  const ch1 = buf.numberOfChannels > 1 ? buf.getChannelData(1) : null;
  const len = ch0.length;
  const out = new Array(n).fill(0);
  const step = len / n;
  let max = 0;
  for (let i = 0; i < n; i++) {
    const a = Math.floor(i * step), b = Math.min(len, Math.floor((i + 1) * step));
    let pk = 0;
    for (let j = a; j < b; j++) {
      const v = ch1 ? (Math.abs(ch0[j]) + Math.abs(ch1[j])) * 0.5 : Math.abs(ch0[j]);
      if (v > pk) pk = v;
    }
    out[i] = pk;
    if (pk > max) max = pk;
  }
  if (max > 0) for (let i = 0; i < n; i++) out[i] = out[i] / max; // 归一,小波形更清晰
  return out;
}
// 生成块:点生成就有,状态都在块上;完成后带两个变体(像 Suno)。
export type GenStatus = 'generating' | 'streaming' | 'complete' | 'failed';
export interface GenView { id: string; prompt: string; mode: string; status: GenStatus; error?: string; sounds: LoopView[]; bpm?: number; musicalKey?: string; loop?: boolean }

const soundToLoop = (s: ApiSound): LoopView => {
  const w = (s.warp || {}) as Record<string, unknown>;
  const a = (s.analysis || {}) as Record<string, number>;
  const status: LoopStatus = w.warpedBy === 'manual' ? 'manual' : (a.confidence ?? 0) >= 0.6 ? 'auto' : 'pending';
  return {
    id: s.id, label: s.name, status,
    srcBpm: Math.round((a.bpm as number) ?? s.sourceBpm), bars: (w.bars as number) ?? (a.bars ?? 1),
    durationSec: s.durationSec, musicalKey: s.musicalKey,
    color: clipColor({ stemKind: s.stemKind, id: s.id }),
    stemKind: s.stemKind ?? undefined, stemStatus: s.stemStatus ?? undefined,
    stems: (s.stems ?? []).map(soundToLoop),
  };
};

interface Editing {
  kind: 'sound' | 'pad';
  id: string;        // 编辑器 React key;sound 时同时是 Sound id
  gid?: number;      // pad 时:目标格 gid
  soundId?: string;  // pad 时:源 Sound id(解析 asset / analysis / 原始 BPM)
  channels: Float32Array[]; sampleRate: number; nativeBpm: number; analysis: LoopAnalysis; semitones: number;
}
type WarpResult = { buffer: AudioBuffer; bars: number; loopStartSample: number; loopEndSample: number };

const regionFromWarp = (warp: unknown, analysis: unknown): WarpRegion => {
  const w = (warp || {}) as Record<string, number>;
  const a = (analysis || {}) as Record<string, number>;
  if (typeof w.startSample === 'number' && typeof w.endSample === 'number') {
    return { startSample: w.startSample, endSample: w.endSample, bars: w.bars ?? 1, semitones: w.semitones ?? 0, fadeOutBars: w.fadeOutBars ?? 0, fadeSilenceBars: w.fadeSilenceBars ?? 0 };
  }
  return { startSample: a.startSample ?? 0, endSample: a.endSample ?? 0, bars: a.bars ?? 1, semitones: 0, fadeOutBars: 0, fadeSilenceBars: 0 };
};

/** 放置 pad 时的初始 warp:优先源 Sound 的默认 warp,否则按 analysis 兜底。 */
const soundDefaultWarp = (s: ApiSound): WarpJson => {
  const w = (s.warp ?? null) as WarpJson | null;
  if (w && (typeof w.startSample === 'number' || typeof w.endSample === 'number')) return { ...w };
  const a = (s.analysis ?? {}) as Record<string, number>;
  return { startSample: a.startSample ?? 0, endSample: a.endSample ?? 0, bars: a.bars ?? 1, semitones: 0, warpedBy: 'auto' };
};

export function useLoopMachine() {
  const engineRef = useRef<AudioEngine | null>(null);
  const decodeCtx = useRef<AudioContext | null>(null);
  const masterBpmRef = useRef(90);
  const reWarpTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const decodeCache = useRef<Map<string, { channels: Float32Array[]; sampleRate: number; durationSec: number }>>(new Map());
  const warpCache = useRef<Map<string, WarpResult>>(new Map());
  const projectId = useRef<string | null>(null);
  const soundsRef = useRef<ApiSound[]>([]);
  const soundExtra = useRef<Map<string, ApiSound>>(new Map()); // pad 引用但库里没有的源 Sound(放置返回 / hydrate 时补)
  const padStates = useRef<Record<number, PadState>>({});
  const padPeaks = useRef<Record<number, number[]>>({}); // gid → 波形峰值
  const padBars = useRef<Record<number, number>>({}); // gid → loop 小节数(算播放相位)
  const selKind = useRef<'sound' | 'pad' | null>(null);

  // ─ undo/redo 内核:doc 是真相,padDbIds/seq/chain 是投影基础设施(不进 doc) ─
  const histRef = useRef<HistState>(initHist(emptyDoc()));
  const padDbIds = useRef<Record<number, string>>({}); // gid → DB PadClip 行 id(投影,删/重建时维护)
  const seqRef = useRef<Record<number, number>>({});   // gid → 版本号(异步重 warp 的守卫,旧结果不污染引擎)
  const chainRef = useRef<Record<number, Promise<unknown>>>({}); // gid → 串行链(防同格并发写冲突 unique(project,bank,index))

  const [ready, setReady] = useState(false);
  const [projects, setProjects] = useState<ApiProject[]>([]);
  const [currentProjectId, setCurrentProjectId] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const [position, setPosition] = useState({ bar: 1, beat: 1, sixteenth: 1 });
  const [currentBank, setCurrentBank] = useState(0);
  const [selectedLoopId, setSelectedLoopId] = useState<string | null>(null); // 选中的 Sound 变体(用于放 pad)
  const [gens, setGens] = useState<GenView[]>([]);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [bump, setBump] = useState(0); // 统一的重渲染触发(doc / 引擎态 / 历史变更)
  const [stemServiceUp, setStemServiceUp] = useState<boolean | null>(null); // 分离 sidecar 是否在跑
  const [stemError, setStemError] = useState<string | null>(null);
  // 镜像到 ref,供回调里读最新值(避免闭包过期 / 依赖抖动)
  const editingRef = useRef<Editing | null>(null); editingRef.current = editing;
  const selectedLoopIdRef = useRef<string | null>(null); selectedLoopIdRef.current = selectedLoopId;
  const currentBankRef = useRef(0); currentBankRef.current = currentBank;
  const [selectedPad, setSelectedPad] = useState<{ bank: number; index: number } | null>(null); // 选中的 pad(→pad 目标 + 高亮)
  const selectedPadRef = useRef<{ bank: number; index: number } | null>(null); selectedPadRef.current = selectedPad;

  const getDoc = useCallback(() => histRef.current.present, []);
  const getDecodeCtx = () => (decodeCtx.current ??= new AudioContext());
  const updateGen = (id: string, patch: Partial<GenView>) => setGens((gs) => gs.map((g) => (g.id === id ? { ...g, ...patch } : g)));
  const soundById = useCallback((id: string | null | undefined): ApiSound | undefined => {
    if (!id) return undefined;
    return soundsRef.current.find((s) => s.id === id) ?? soundExtra.current.get(id);
  }, []);

  const decodeAsset = useCallback(async (assetId: string) => {
    const hit = decodeCache.current.get(assetId);
    if (hit) return hit;
    const buf = await fetch(cdnUrl(assetId)).then((r) => r.arrayBuffer());
    const audio = await getDecodeCtx().decodeAudioData(buf);
    const channels: Float32Array[] = [];
    for (let c = 0; c < audio.numberOfChannels; c++) channels.push(audio.getChannelData(c).slice());
    const v = { channels, sampleRate: audio.sampleRate, durationSec: audio.duration };
    decodeCache.current.set(assetId, v);
    return v;
  }, []);

  /** 把某 asset 的某 region warp 到主 BPM,返回可装载 clip。内存缓存 + 落盘缓存(persist=true 时把渲染结果存盘)。 */
  const warpToClip = useCallback(async (assetId: string, region: WarpRegion, nativeBpm: number, persist = false): Promise<WarpResult> => {
    const master = masterBpmRef.current;
    const sig = `${assetId}|${region.startSample}|${region.endSample}|${region.bars.toFixed(4)}|${region.semitones || 0}|${master}`;
    const hit = warpCache.current.get(sig);
    if (hit) return hit;
    // 落盘缓存命中 → 直接取渲染好的 WAV 解码,跳过 signalsmith
    try {
      const found = await api.warpRender.get(sig);
      if (found) {
        const ab = await fetch(found.cdn).then((r) => r.arrayBuffer());
        const audio = await getDecodeCtx().decodeAudioData(ab);
        const r: WarpResult = { buffer: audio, bars: region.bars, loopStartSample: 0, loopEndSample: audio.length };
        warpCache.current.set(sig, r);
        return r;
      }
    } catch { /* 落盘查询失败就走渲染 */ }
    const { channels, sampleRate } = await decodeAsset(assetId);
    const { warpClip, toAudioBuffer, sliceChannelsPadded } = await import('@/audio/signalsmithWarp');
    const sliced = sliceChannelsPadded(channels, region.startSample, region.endSample);
    const done = await warpClip({ id: sig, channels: sliced, sampleRate, nativeBpm, targetBpm: master, semitones: region.semitones || 0, beatsPerBar: 4, conditioning: 'trust-tempo', targetBars: region.bars });
    const result: WarpResult = { buffer: toAudioBuffer(done), bars: done.bars, loopStartSample: done.loopStartSample, loopEndSample: done.loopEndSample };
    warpCache.current.set(sig, result);
    if (warpCache.current.size > 24) warpCache.current.delete(warpCache.current.keys().next().value as string);
    if (persist) {
      // 仅已提交(放 pad)才落盘,免得编辑时大量临时预览塞满存储。后台编码 WAV 上传,不阻塞播放。
      import('@/audio/wav').then(({ encodeWavBase64 }) => {
        api.warpRender.put({ signature: sig, bars: done.bars, masterBpm: master, audioB64: encodeWavBase64(done.channels, done.sampleRate), contentType: 'audio/wav' }).catch(() => {});
      }).catch(() => {});
    }
    return result;
  }, [decodeAsset]);

  /** 用某 region 在**临时 pad 槽 SCRATCH** 循环预览:和 pad 同一套播放(量化进入、主时钟、和整曲一起响),只是不落库。 */
  const previewClip = useCallback(async (assetId: string, region: WarpRegion, nativeBpm: number) => {
    const eng = engineRef.current; if (!eng) return;
    eng.resume();
    const clip = await warpToClip(assetId, region, nativeBpm);
    eng.loadClip({ padIndex: SCRATCH, buffer: clip.buffer, bars: clip.bars, loopStartSample: clip.loopStartSample, loopEndSample: clip.loopEndSample, gainDb: 0 });
    eng.launchPad(SCRATCH, false); // 不碰主走带:走带在跑→量化跟整曲一起响;走带停→只自由试听这个 sample
  }, [warpToClip]);
  const stopPreview = useCallback(() => { engineRef.current?.clearPad(SCRATCH); }, []);

  // --- 引擎装载(从 doc entry,而非 ApiPad) ---
  /** 把某 gid 的 doc entry warp 到主 BPM 并装入引擎;在播的重启(单声跟随)。persist=落盘缓存;
   *  isStale=warp 完成后若已被更新的一次操作取代则返回 true → 跳过载入,别用旧 buffer 覆盖引擎。 */
  const loadEntryToEngine = useCallback(async (g: number, entry: PadEntry, persist: boolean, isStale?: () => boolean) => {
    const eng = engineRef.current; if (!eng) return;
    const sound = soundById(entry.soundId);
    if (!sound) { eng.clearPad(g); return; } // 源 Sound 不在(被删/trash)→ 清空,别崩
    const nativeBpm = sound.sourceBpm ?? masterBpmRef.current;
    const region = regionFromWarp(entry.warp, sound.analysis);
    const clip = await warpToClip(sound.assetId, region, nativeBpm, persist);
    if (isStale?.()) return; // 被更新的一次操作取代(撤销/再编辑)→ 别用过期 buffer 覆盖
    // wasPlaying 在 warp 之后、loadClip(会置 ready)之前读:warp 期间被用户停掉的就别重启
    const wasPlaying = padStates.current[g] === 'playing' || padStates.current[g] === 'queued';
    padPeaks.current[g] = computePeaks(clip.buffer);
    padBars.current[g] = clip.bars;
    eng.loadClip({ padIndex: g, buffer: clip.buffer, bars: clip.bars, loopStartSample: clip.loopStartSample, loopEndSample: clip.loopEndSample, gainDb: entry.gainDb || 0 });
    if (wasPlaying) eng.launchPad(g);
  }, [soundById, warpToClip]);

  /** 仅重载引擎(不写 DB),带版本守卫 + 串行链。用于改主 BPM 时把在用 pad 重 warp。 */
  const reloadPadEngine = useCallback((g: number, entry: PadEntry, persist: boolean) => {
    const v = (seqRef.current[g] = (seqRef.current[g] ?? 0) + 1);
    chainRef.current[g] = (chainRef.current[g] ?? Promise.resolve())
      .then(async () => { if (seqRef.current[g] !== v) return; await loadEntryToEngine(g, entry, persist, () => seqRef.current[g] !== v); setBump((b) => b + 1); })
      .catch(() => { padStates.current[g] = 'error'; setBump((b) => b + 1); });
  }, [loadEntryToEngine]);

  /** 一个 gid 的投影:让 DB 行 + 引擎追上 after(after=null 即删)。串行 + 版本守卫。 */
  const reconcilePad = useCallback((g: number, before: PadEntry | null, after: PadEntry | null) => {
    const eng = engineRef.current;
    const v = (seqRef.current[g] = (seqRef.current[g] ?? 0) + 1);
    const run = async () => {
      if (!after) { // doc 说空 → 删行 + 清引擎
        const id = padDbIds.current[g];
        if (id) { await api.pads.remove(id).catch(() => {}); delete padDbIds.current[g]; }
        eng?.clearPad(g);
        padStates.current[g] = 'empty'; delete padPeaks.current[g]; delete padBars.current[g];
        setBump((b) => b + 1);
        return;
      }
      if (!projectId.current || !after.soundId) return;
      const sourceChanged = !before || before.soundId !== after.soundId; // 换源/新建 → place(拷源 + label);仅 warp/标签变 → patch
      const { bank, padIndex } = splitGid(g);
      let row: ApiPad;
      if (sourceChanged) {
        padStates.current[g] = 'warping'; setBump((b) => b + 1);
        row = await api.pads.place({ projectId: projectId.current, bank, padIndex, soundId: after.soundId, warp: after.warp });
      } else {
        const id = padDbIds.current[g];
        row = id
          ? await api.pads.patch(id, { warp: after.warp, label: after.label, gainDb: after.gainDb })
          : await api.pads.place({ projectId: projectId.current, bank, padIndex, soundId: after.soundId, warp: after.warp });
      }
      padDbIds.current[g] = row.id;
      if (row.sourceSound) soundExtra.current.set(row.sourceSound.id, row.sourceSound);
      if (seqRef.current[g] !== v) return; // 期间被更新的一次 reconcile 取代 → 别用旧状态载入引擎
      await loadEntryToEngine(g, after, sourceChanged, () => seqRef.current[g] !== v); // warp 后再查一次;换源才落盘缓存,纯 warp 微调不落盘
      setBump((b) => b + 1);
    };
    chainRef.current[g] = (chainRef.current[g] ?? Promise.resolve())
      .then(run)
      .catch(() => { padStates.current[g] = 'error'; setBump((b) => b + 1); });
  }, [loadEntryToEngine]);

  /** doc 变更后的统一投影:undo/redo/正向都走这里。只动 diff 出的 pad / 标量。 */
  const reconcile = useCallback((before: ProjectDoc, after: ProjectDoc) => {
    const eng = engineRef.current;
    const d = diffDoc(before, after);
    if (d.masterBpm) {
      masterBpmRef.current = after.masterBpm; // 同步生效,供 warpToClip 读
      eng?.setBpm(after.masterBpm);           // 走带 tempo 立即变
      if (reWarpTimer.current) clearTimeout(reWarpTimer.current);
      // 防抖:停手 400ms 后把"在用的"重 warp 到新主 BPM,并存项目设置
      reWarpTimer.current = setTimeout(() => {
        if (projectId.current) api.projects.update(projectId.current, { masterBpm: after.masterBpm }).catch(() => {});
        const doc = getDoc();
        for (const k in doc.pads) { const e = doc.pads[k]; if (e) reloadPadEngine(Number(k), e, true); }
        // 模板预览(编辑库变体时)也跟主 BPM 重渲染
        const ed = editingRef.current;
        if (ed?.kind === 'sound' && ACTIVE_PAD.includes(padStates.current[SCRATCH])) {
          const s = soundsRef.current.find((x) => x.id === ed.id);
          if (s) previewClip(s.assetId, regionFromWarp(s.warp, s.analysis), ed.nativeBpm);
        }
      }, 400);
    }
    if (d.quantize) {
      eng?.setQuantize(after.quantize);
      if (projectId.current) api.projects.update(projectId.current, { quantize: after.quantize }).catch(() => {});
    }
    for (const p of d.pads) reconcilePad(p.gid, p.before, p.after);
  }, [reconcilePad, reloadPadEngine, previewClip, getDoc]);

  /** 编辑中的 pad 若已被 undo/redo 删掉 → 退出编辑器(别留幽灵)。 */
  const syncEditingAfterHistory = useCallback(() => {
    const ed = editingRef.current;
    if (ed?.kind === 'pad' && ed.gid != null && !getDoc().pads[ed.gid]) setEditing(null);
  }, [getDoc]);

  // --- 历史:提交 / 撤销 / 重做 ---
  const applyDoc = useCallback((label: string, recipe: (d: ProjectDoc) => void, coalesceKey?: string) => {
    const before = histRef.current.present;
    const next = produceDoc(before, recipe);
    if (!docChanged(before, next)) return; // 空提交不入栈
    histRef.current = histApply(histRef.current, label, next, coalesceKey);
    reconcile(before, next);
    setBump((b) => b + 1);
  }, [reconcile]);
  const undo = useCallback(() => {
    const before = histRef.current.present;
    const ns = histUndo(histRef.current);
    if (ns === histRef.current) return;
    histRef.current = ns;
    reconcile(before, ns.present);
    syncEditingAfterHistory();
    setBump((b) => b + 1);
  }, [reconcile, syncEditingAfterHistory]);
  const redo = useCallback(() => {
    const before = histRef.current.present;
    const ns = histRedo(histRef.current);
    if (ns === histRef.current) return;
    histRef.current = ns;
    reconcile(before, ns.present);
    syncEditingAfterHistory();
    setBump((b) => b + 1);
  }, [reconcile, syncEditingAfterHistory]);
  /** 重置历史到某 doc(切项目 / 初次加载),不投影、不入栈 —— 每项目一份独立栈。 */
  const resetHist = useCallback((doc: ProjectDoc) => { histRef.current = initHist(doc); setBump((b) => b + 1); }, []);

  // --- 加载 ---
  const loadLibrary = useCallback(async () => {
    const list = await api.sounds.list(); // 顶层 + 各自 stem(嵌套)
    soundsRef.current = list.flatMap((s) => [s, ...(s.stems ?? [])]); // 拍平:父 + 各 stem 都能按 id 查
  }, []);
  const loadGens = useCallback(async () => {
    if (!projectId.current) return;
    const list = await api.gens.list(projectId.current);
    setGens(list.map((g) => ({
      id: g.id, prompt: g.prompt, mode: g.mode,
      status: (g.status === 'queued' ? 'generating' : g.status) as GenStatus,
      error: g.error || undefined,
      sounds: (g.sounds || []).map(soundToLoop),
    })));
  }, []);

  /** 从 DB 把某项目的 pad 载成 doc(真相),重置历史栈,再装入引擎。DB→doc 仅此一处。 */
  const hydrateProject = useCallback(async (project: ApiProject) => {
    const list = await api.pads.list(project.id);
    // 重置全部投影/瞬态:gid 跨项目复用,不清会把上个项目的波形/小节/状态/缓存源带进新项目
    padDbIds.current = {}; seqRef.current = {}; chainRef.current = {};
    padStates.current = {}; padPeaks.current = {}; padBars.current = {};
    soundExtra.current.clear();
    const pads: Record<number, PadEntry | null> = {};
    for (const p of list) {
      if (!p.sourceSoundId) continue; // 源 Sound 已删的死 pad:无法装载 → 不进 doc、不入 undo
      const g = gid(p.bank, p.padIndex);
      pads[g] = { soundId: p.sourceSoundId, warp: (p.warp ?? {}) as WarpJson, label: p.label ?? '', gainDb: p.gainDb };
      padDbIds.current[g] = p.id;
      if (p.sourceSound) soundExtra.current.set(p.sourceSound.id, p.sourceSound);
    }
    resetHist({ masterBpm: project.masterBpm, quantize: project.quantize as Quantize, pads });
    for (const k in pads) { const e = pads[k]; if (e && e.soundId) { try { await loadEntryToEngine(Number(k), e, true); } catch { /* 单个失败不阻塞 */ } } }
  }, [resetHist, loadEntryToEngine]);

  const init = useCallback(async () => {
    if (engineRef.current) return;
    const { ToneAudioEngine } = await import('@/audio/ToneAudioEngine');
    const eng = new ToneAudioEngine();
    await eng.init();
    eng.on((e: EngineEvent) => {
      if (e.type === 'transport') { setPosition(e.position); setPlaying(e.isPlaying); }
      else if (e.type === 'padState') { padStates.current[e.padIndex] = e.state; setBump((b) => b + 1); }
    });
    engineRef.current = eng;
    // 项目:取第一个,没有就建一个
    let list = await api.projects.list();
    if (!list.length) { await api.projects.create({ name: '我的项目' }); list = await api.projects.list(); }
    const project = list[0];
    setProjects(list);
    projectId.current = project.id;
    setCurrentProjectId(project.id);
    masterBpmRef.current = project.masterBpm;
    eng.setBpm(project.masterBpm);
    eng.setQuantize(project.quantize as Quantize);
    await loadLibrary();
    await loadGens();
    await hydrateProject(project);
    api.stemService().then((h) => setStemServiceUp(h.up)).catch(() => setStemServiceUp(false)); // 不阻塞启动
    setReady(true);
  }, [loadLibrary, loadGens, hydrateProject]);

  // 进页面即自动初始化(不再要"启动"屏);音频在首次播放/启停/试听的点击里解锁。
  const initStarted = useRef(false);
  useEffect(() => {
    if (!initStarted.current) { initStarted.current = true; init(); }
    return () => { engineRef.current?.dispose(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // --- 项目:切换 / 新建 / 改名 ---
  const switchProject = useCallback(async (id: string) => {
    if (id === projectId.current) return;
    const eng = engineRef.current;
    const cur = getDoc();
    for (const k in cur.pads) if (cur.pads[k]) eng?.clearPad(Number(k)); // 卸掉当前项目的 pad
    padStates.current = {}; padPeaks.current = {}; padBars.current = {}; // 早清,避免切换 await 期间残留旧项目波形/状态(hydrateProject 还会再清一次)
    warpCache.current.clear();
    const p = (await api.projects.list()).find((x) => x.id === id);
    if (!p) return;
    projectId.current = id;
    setCurrentProjectId(id);
    masterBpmRef.current = p.masterBpm;
    eng?.setBpm(p.masterBpm);
    eng?.setQuantize(p.quantize as Quantize);
    setSelectedLoopId(null);
    setEditing(null);
    await loadGens();
    await hydrateProject(p); // 重置历史栈 → 每项目独立 undo
  }, [loadGens, hydrateProject, getDoc]);

  const createProject = useCallback(async (name?: string) => {
    const p = await api.projects.create({ name: name && name.trim() ? name.trim() : '新项目', masterBpm: masterBpmRef.current });
    setProjects(await api.projects.list());
    await switchProject(p.id);
  }, [switchProject]);

  const renameProject = useCallback(async (name: string) => {
    if (!projectId.current || !name.trim()) return;
    await api.projects.update(projectId.current, { name: name.trim() });
    setProjects(await api.projects.list());
  }, []);

  // --- 生成 → 块(后端);两个变体都拿,状态挂在生成块上(外部副作用,不进 undo) ---
  const generateToLibrary = useCallback(async (prompt: string, opts?: { mode?: 'sound' | 'advanced'; loop?: boolean; bpm?: number; key?: string }) => {
    if (!prompt.trim() || !projectId.current) return;
    const mode = opts?.mode ?? 'sound';
    const isLoop = opts?.loop ?? true;
    const bpm = opts?.bpm && opts.bpm > 0 ? opts.bpm : masterBpmRef.current;
    const key = opts?.key || '';
    const adv = mode === 'advanced';
    let genId: string | null = null;
    try {
      const gen = await api.gens.create({ projectId: projectId.current, mode, prompt, bpm, key, loop: isLoop, instrumental: adv });
      genId = gen.id;
      setGens((gs) => [{ id: genId!, prompt, mode, status: 'generating', sounds: [] }, ...gs]); // 点生成即出块
      const { sunoBridge, base64ToArrayBuffer } = await import('@/studio/sunoBridge');
      await api.gens.patch(genId, { status: 'generating' });
      const { clipIds } = await sunoBridge.generate({ prompt, mode, loop: isLoop, bpm, key });
      await api.gens.patch(genId, { status: 'streaming', sunoClipIds: clipIds });
      updateGen(genId, { status: 'streaming' });
      // 轮询:等所有变体都 complete(超时则取已完成的)
      const completed = new Map<string, { audio_url?: string; id?: string }>();
      const maxPolls = adv ? 150 : 60;
      for (let i = 0; i < maxPolls && completed.size < clipIds.length; i++) {
        const clips = await sunoBridge.poll(clipIds);
        for (const c of clips) if (c.audio_url && c.status === 'complete' && c.id && !completed.has(c.id)) completed.set(c.id, c);
        if (completed.size >= clipIds.length) break;
        await new Promise((r) => setTimeout(r, 2000));
      }
      if (!completed.size) throw new Error('生成超时(渲染未完成)');
      // 下载 + 落库每个变体(两个都拿过来)
      let n = 0;
      for (const c of completed.values()) {
        n++;
        const { b64 } = await sunoBridge.download(c.audio_url!);
        const audio = await getDecodeCtx().decodeAudioData(base64ToArrayBuffer(b64));
        const channels: Float32Array[] = [];
        for (let ch = 0; ch < audio.numberOfChannels; ch++) channels.push(audio.getChannelData(ch).slice());
        const totalS = channels[0].length;
        const analysis = detectLoop(channels, audio.sampleRate, bpm);
        const barSamples = ((4 * 60) / bpm) * audio.sampleRate;
        // 最佳 loop 机体验:落地即"紧凑可叠的循环",不是一整段。
        const defBars = Math.max(1, adv ? 2 : Math.min(analysis.bars, 4));
        const defEnd = Math.min(totalS, analysis.startSample + Math.round(defBars * barSamples));
        const warp = { startSample: analysis.startSample, endSample: defEnd, bars: defBars, semitones: 0, warpedBy: 'auto' };
        await api.sounds.create({
          originProjectId: projectId.current, genId, name: `${prompt.slice(0, 16)} #${n}`, mode, sourceBpm: bpm, key,
          durationSec: audio.duration, sampleRate: audio.sampleRate, channels: audio.numberOfChannels,
          analysis, warp, audioB64: b64, sourceUrl: c.audio_url,
        });
      }
      await api.gens.patch(genId, { status: 'complete' });
      await loadLibrary();
      await loadGens();
    } catch (e) {
      const msg = String((e as Error).message || e);
      if (genId) { try { await api.gens.patch(genId, { status: 'failed', error: msg }); } catch { /* ignore */ } updateGen(genId, { status: 'failed', error: msg }); }
    }
  }, [loadLibrary, loadGens]);

  // --- 选中 / 编辑 / 预览(库 ▶ 与 warp 区预览是同一套播放) ---
  const editingAssetId = useCallback((ed: Editing): string | undefined =>
    ed.kind === 'sound' ? soundsRef.current.find((s) => s.id === ed.id)?.assetId
                        : soundById(ed.soundId)?.assetId, [soundById]);

  const selectLoop = useCallback(async (id: string) => {
    const sound = soundById(id);
    if (!sound) return;
    stopPreview(); // 选别的就停掉当前预览
    setSelectedLoopId(id);
    selKind.current = 'sound';
    const { channels, sampleRate } = await decodeAsset(sound.assetId);
    const region = regionFromWarp(sound.warp, sound.analysis);
    const analysis = { ...(sound.analysis as object), startSample: region.startSample, endSample: region.endSample, bars: region.bars } as LoopAnalysis;
    setEditing({ kind: 'sound', id, channels, sampleRate, nativeBpm: sound.sourceBpm, analysis, semitones: region.semitones });
  }, [decodeAsset, stopPreview, soundById]);

  /** 点 pad:选中它(→pad 目标 + 高亮);填了的 pad 把**它自己的 warp** 开进编辑器(per-pad)。 */
  const selectPad = useCallback(async (bank: number, index: number) => {
    setSelectedPad({ bank, index });
    const g = gid(bank, index);
    const entry = getDoc().pads[g];
    if (!entry) return; // 空 pad:仅选中(作 →pad 目标)
    const sound = soundById(entry.soundId);
    if (!sound) return;
    stopPreview();
    setSelectedLoopId(entry.soundId); // 库里高亮源变体
    selKind.current = 'pad';
    const { channels, sampleRate } = await decodeAsset(sound.assetId);
    const region = regionFromWarp(entry.warp, sound.analysis);
    const analysis = { ...((sound.analysis ?? {}) as object), startSample: region.startSample, endSample: region.endSample, bars: region.bars } as LoopAnalysis;
    setEditing({ kind: 'pad', id: `pad:${g}`, gid: g, soundId: entry.soundId, channels, sampleRate, nativeBpm: sound.sourceBpm ?? masterBpmRef.current, analysis, semitones: region.semitones });
  }, [decodeAsset, stopPreview, soundById, getDoc]);

  /** 库 ▶:选中进 warp 区 + 在那里播放;同一条且在播时再点 = 停。和编辑器预览同一套。 */
  const auditionSound = useCallback(async (id: string) => {
    engineRef.current?.resume(); // 必须同步(在任何 await 之前)解锁音频,否则首次点库▶ 会没声
    if (selKind.current === 'sound' && selectedLoopIdRef.current === id && ACTIVE_PAD.includes(padStates.current[SCRATCH])) { stopPreview(); return; }
    const sound = soundById(id);
    if (!sound) return;
    await selectLoop(id);
    previewClip(sound.assetId, regionFromWarp(sound.warp, sound.analysis), sound.sourceBpm);
  }, [selectLoop, previewClip, stopPreview, soundById]);

  /** 编辑器播放键:编辑 pad → 启停**那个 pad**(单声跟随);编辑库变体 → 用独立预览试听模板。 */
  const previewToggle = useCallback((region: WarpRegion) => {
    const ed = editingRef.current; if (!ed) return;
    if (ed.kind === 'pad') {
      const g = ed.gid; if (g == null) return;
      engineRef.current?.resume();
      if (ACTIVE_PAD.includes(padStates.current[g])) engineRef.current?.stopPad(g);
      else engineRef.current?.launchPad(g);
      return;
    }
    if (ACTIVE_PAD.includes(padStates.current[SCRATCH])) { stopPreview(); return; }
    const assetId = editingAssetId(ed);
    if (assetId) previewClip(assetId, region, ed.nativeBpm);
  }, [previewClip, stopPreview, editingAssetId]);

  /** region 变更(自动应用):编辑 pad → 走 applyDoc 改**这个 pad** 的 warp(可撤销);编辑库变体 → 写 Sound 模板(不在 undo 范围)。 */
  const tuneLoop = useCallback(async (region: WarpRegion) => {
    const ed = editingRef.current; if (!ed) return;
    const warp: WarpJson = { startSample: region.startSample, endSample: region.endSample, bars: region.bars, semitones: region.semitones || 0, warpedBy: 'manual' };
    if (ed.kind === 'pad') {
      const g = ed.gid; if (g == null) return;
      applyDoc('调整片段', (d) => { const e = d.pads[g]; if (e) e.warp = warp; }, `warp:${g}`); // 连续微调合并成一步
    } else {
      // 库变体模板编辑 —— 全局库,非编排,不进 undo;保持原行为(写 Sound + 即调即听)
      const s = soundsRef.current.find((x) => x.id === ed.id); if (s) s.warp = warp;
      await api.sounds.patch(ed.id, { warp });
      loadGens(); // 刷新徽标(自动/手调)
      const assetId = editingAssetId(ed);
      if (assetId && ACTIVE_PAD.includes(padStates.current[SCRATCH])) previewClip(assetId, region, ed.nativeBpm);
    }
  }, [applyDoc, previewClip, loadGens, editingAssetId]);

  const resetLoopAuto = useCallback(async () => {
    const ed = editingRef.current; if (!ed) return;
    if (ed.kind === 'pad') {
      const g = ed.gid; if (g == null) return;
      const sound = soundById(ed.soundId);
      const a = (sound?.analysis ?? {}) as Record<string, number>; // 退回源音频自动检测的默认 loop
      const warp: WarpJson = { startSample: a.startSample, endSample: a.endSample, bars: a.bars, semitones: 0, warpedBy: 'auto' };
      applyDoc('重置片段', (d) => { const e = d.pads[g]; if (e) e.warp = warp; });
      const { bank, padIndex } = splitGid(g);
      await selectPad(bank, padIndex); // 重挂编辑器用新 region
    } else {
      const sound = soundsRef.current.find((s) => s.id === ed.id);
      const a = (sound?.analysis ?? {}) as Record<string, number>;
      const warp = { startSample: a.startSample, endSample: a.endSample, bars: a.bars, semitones: 0, warpedBy: 'auto' };
      if (sound) sound.warp = warp;
      await api.sounds.patch(ed.id, { warp });
      loadGens();
      selectLoop(ed.id);
    }
  }, [applyDoc, soundById, selectPad, selectLoop, loadGens]);

  /** 乐器分离:把一个变体送去 Demucs,分出 6 stem 子 Sound(外部副作用,不进 undo)。 */
  const markStem = (id: string, st: string | null) =>
    setGens((gs) => gs.map((g) => ({ ...g, sounds: g.sounds.map((l) => (l.id === id ? { ...l, stemStatus: st } : l)) })));
  const separateSound = useCallback(async (id: string) => {
    setStemError(null);
    markStem(id, 'separating'); // 乐观:该变体显示"分离中"
    try {
      const res = await api.sounds.separate(id);
      if (!res.ok) throw new Error(res.error || '分离失败');
      await loadLibrary();
      await loadGens();
      setStemServiceUp(true);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      markStem(id, 'failed');
      setStemError(msg);
      if (/没在跑|ECONNREFUSED|fetch failed|502/.test(msg)) setStemServiceUp(false);
    }
  }, [loadLibrary, loadGens]);

  // --- pad 操作(全部走 applyDoc → 可撤销) ---
  const assignToPad = useCallback(async (soundId: string, bank: number, index: number) => {
    if (!projectId.current) return;
    const sound = soundById(soundId);
    if (!sound) return;
    const g = gid(bank, index);
    const warp = soundDefaultWarp(sound);
    applyDoc('放入 pad', (d) => { d.pads[g] = { soundId, warp, label: sound.name, gainDb: 0 }; });
  }, [applyDoc, soundById]);

  const unassignPad = useCallback(async (bank: number, index: number) => {
    const g = gid(bank, index);
    if (!getDoc().pads[g]) return;
    applyDoc('清空 pad', (d) => { d.pads[g] = null; });
    if (editingRef.current?.kind === 'pad' && editingRef.current.gid === g) setEditing(null); // 别留着编辑一个已删的 pad
  }, [applyDoc, getDoc]);

  /** pad → pad 拖拽 = **移动**(不是复制):目标空位 → 移过去并清空原位;目标占用 → 两块互换。各自带 warp 一起搬。 */
  const movePad = useCallback(async (bank: number, from: number, to: number) => {
    if (from === to) return;
    const gFrom = gid(bank, from), gTo = gid(bank, to);
    const doc = getDoc();
    const src = doc.pads[gFrom];
    if (!src) return;
    const dst = doc.pads[gTo] ?? null;
    applyDoc('移动 pad', (d) => {
      d.pads[gTo] = { ...src, warp: { ...src.warp } };
      d.pads[gFrom] = dst ? { ...dst, warp: { ...dst.warp } } : null;
    });
    const eg = editingRef.current?.kind === 'pad' ? editingRef.current.gid : undefined; // 别留着编辑被搬走/改写的 pad
    if (eg === gFrom || eg === gTo) setEditing(null);
  }, [applyDoc, getDoc]);

  const launch = useCallback((bank: number, index: number) => {
    const g = gid(bank, index);
    const st = padStates.current[g];
    const has = !!getDoc().pads[g];
    engineRef.current?.resume(); // 手势里解锁音频
    if (st === 'playing' || st === 'queued') engineRef.current?.stopPad(g);
    else if (has && st !== 'warping' && st !== 'loading') engineRef.current?.launchPad(g);
  }, [getDoc]);

  // --- transport ---
  const play = useCallback(() => { engineRef.current?.resume(); engineRef.current?.startTransport(); }, []);
  const stop = useCallback(() => engineRef.current?.stopTransport(), []);
  const setQuantize = useCallback((q: Quantize) => { applyDoc('量化', (d) => { d.quantize = q; }); }, [applyDoc]); // engine + 存盘在 reconcile
  const setMasterBpm = useCallback((bpm: number) => {
    if (!Number.isFinite(bpm) || bpm <= 0) return; // 只拦 0/负/NaN(会让 warp 除零);不设下限,否则受控输入框打字时中间值被拒、播放重渲染下会回弹
    applyDoc('速度', (d) => { d.masterBpm = bpm; }, 'masterBpm'); // 拖动/打字时合并成一步;engine.setBpm + 防抖重 warp 在 reconcile
  }, [applyDoc]);
  const switchBank = useCallback((b: number) => setCurrentBank(b), []);

  const bankPads: PadView[] = useMemo(() => {
    void bump;
    const doc = histRef.current.present;
    return Array.from({ length: PADS_PER_BANK }, (_, i) => {
      const g = gid(currentBank, i);
      const entry = doc.pads[g] ?? null;
      const sound = entry ? soundById(entry.soundId) : undefined;
      return {
        loopId: entry ? `pad:${g}` : null, sourceSoundId: entry?.soundId ?? null,
        label: entry?.label ?? '', state: padStates.current[g] ?? 'empty',
        color: clipColor({ stemKind: sound?.stemKind, id: entry?.soundId || `pad:${g}` }),
        bars: padBars.current[g] ?? 1, peaks: padPeaks.current[g] ?? [],
        selected: selectedPad?.bank === currentBank && selectedPad?.index === i,
      };
    });
  }, [currentBank, bump, selectedPad, soundById]);

  // 播放态统一成"读某个 pad 槽":编辑 pad → 那个 pad;编辑库变体 → SCRATCH 临时槽。读 bump 即重算。
  void bump;
  const previewing = ACTIVE_PAD.includes(padStates.current[SCRATCH]); // 试听槽在响(给库 ▶ 图标用)
  const editorSlot = editing?.kind === 'pad' ? (editing.gid ?? null) : SCRATCH;
  const editorPlaying = editorSlot != null && ACTIVE_PAD.includes(padStates.current[editorSlot]);
  const editorPhase = () => {
    const ed = editingRef.current;
    const slot = ed?.kind === 'pad' ? (ed.gid ?? null) : SCRATCH;
    return slot != null ? (engineRef.current?.padPhase(slot) ?? null) : null;
  };

  return {
    ready, masterBpm: histRef.current.present.masterBpm, playing, quantize: histRef.current.present.quantize,
    position, currentBank, bankPads, gens, selectedLoopId, editing, previewing,
    editorPlaying, editorPhase,
    projects, currentProjectId, stemServiceUp, stemError, selectedPad,
    bankIds: BANK_IDS.slice(0, BANKS),
    canUndo: histCanUndo(histRef.current), canRedo: histCanRedo(histRef.current), undo, redo,
    init, play, stop, setMasterBpm, setQuantize, switchBank, switchProject, createProject, renameProject,
    generateToLibrary, selectLoop, selectPad, auditionSound, previewToggle, stopPreview, tuneLoop, resetLoopAuto,
    assignToPad, unassignPad, movePad, launch, separateSound,
    transportBeats: () => engineRef.current?.transportBeats() ?? 0,
    padPhase: (i: number) => engineRef.current?.padPhase(gid(currentBankRef.current, i)) ?? null,
  };
}
