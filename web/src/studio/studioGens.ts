'use client';
// Studio 左栏的"生成 + 库"数据层 —— 复用 loop 机的管线(api.gens / sunoBridge / detectLoop),
// 产出 LoopManager 直接吃的 GenView[]。生成走真实 Suno 桥接(需插件 + 登录的 suno.com 标签)。
import { api, type ApiSound } from '@/studio/api';
import { clipColor } from '@/studio/clipColor';
import { detectLoop } from '@/audio/conditioning';
import { estimateTempo, estimateKey } from '@/audio/detect';
import type { GenStatus, GenView, LoopView } from '@/contracts/studioViews';

let _gctx: AudioContext | null = null;
const gctx = () => (_gctx ??= new AudioContext());

/** 把任意报错压成一句话短提示(去栈/去 HTML/映射常见原因/截断),给卡片和状态栏用。 */
export function conciseError(e: unknown): string {
  let msg = (e instanceof Error ? e.message : String(e ?? '')).trim();
  if (/^<|<!doctype|<html/i.test(msg)) return 'Server error'; // Next/代理 的 HTML 错误页
  msg = msg.split('\n')[0].trim(); // 只取首行,丢掉堆栈
  if (/桥接超时|插件没响应|没响应/.test(msg)) return 'Plugin not responding (check it\'s installed and suno.com is logged in)';
  if (/生成超时|渲染未完成/.test(msg)) return 'Generation timed out — try again';
  if (/ECONNREFUSED|fetch failed|Failed to fetch|NetworkError|网络/i.test(msg)) return 'Network/service not connected';
  if (/没在跑|未启动|502/.test(msg)) return 'Service not running';
  if (/HTTP 5\d\d|\b5\d\d\b/.test(msg)) return 'Server error';
  if (/HTTP 4\d\d|\b4\d\d\b/.test(msg)) return 'Request rejected';
  return msg.length > 80 ? msg.slice(0, 80) + '…' : (msg || 'Failed');
}

export const soundToLoop = (s: ApiSound): LoopView => {
  const w = (s.warp || {}) as Record<string, unknown>;
  const a = (s.analysis || {}) as Record<string, number>;
  const status = w.warpedBy === 'manual' ? 'manual' : (a.confidence ?? 0) >= 0.6 ? 'auto' : 'pending';
  return {
    id: s.id, label: s.name, status,
    srcBpm: Math.round((a.bpm as number) ?? s.sourceBpm), bars: (w.bars as number) ?? (a.bars ?? 1),
    durationSec: s.durationSec, musicalKey: s.musicalKey,
    color: clipColor({ stemKind: s.stemKind, id: s.id }),
    stemKind: s.stemKind ?? undefined, stemStatus: s.stemStatus ?? undefined,
    stems: (s.stems ?? []).map(soundToLoop),
  };
};

export async function loadGens(projectId: string): Promise<GenView[]> {
  const list = await api.gens.list(projectId);
  return list.map((g) => ({
    id: g.id, prompt: g.prompt, mode: g.mode,
    source: (g.source === 'upload' ? 'upload' : 'suno') as 'suno' | 'upload',
    status: (g.status === 'queued' ? 'generating' : g.status) as GenStatus,
    error: g.error || undefined,
    bpm: g.bpm, musicalKey: g.musicalKey ?? '', loop: g.loop ?? true, // 留给「重试」复用原参数
    sounds: (g.sounds || []).map(soundToLoop),
  }));
}

export interface GenHooks {
  appear: (g: GenView) => void;
  patch: (id: string, p: Partial<GenView>) => void;
  reload: () => void | Promise<void>;
  register?: (genId: string, ctrl: AbortController) => void; // 登记取消句柄(随时干掉这组生成)
  release?: (genId: string) => void;                          // 管线收尾,注销句柄
}
interface GenParams { projectId: string; mode: 'sound' | 'advanced'; prompt: string; bpm: number; key: string; loop: boolean }

/** 在一条已存在的 gen 行上跑完整管线(桥接 → 轮询 → 下载 → 落库)。成功标 complete,失败标 failed(简洁报错)。 */
async function runGeneration(genId: string, params: GenParams, h: GenHooks, signal?: AbortSignal): Promise<void> {
  const { projectId, mode, prompt, bpm, key, loop: isLoop } = params;
  const adv = mode === 'advanced';
  const stopped = () => !!signal?.aborted; // 用户中途取消 → 静默收手(卡片已被上层干掉,别再标状态)
  try {
    const { sunoBridge, base64ToArrayBuffer } = await import('@/studio/sunoBridge');
    h.patch(genId, { status: 'generating', error: undefined });
    await api.gens.patch(genId, { status: 'generating', error: null }); // 重试时清掉上次的报错
    if (stopped()) return;
    const { clipIds } = await sunoBridge.generate({ prompt, mode, loop: isLoop, bpm, key });
    if (stopped()) return;
    await api.gens.patch(genId, { status: 'streaming', sunoClipIds: clipIds });
    h.patch(genId, { status: 'streaming' });
    const completed = new Map<string, { audio_url?: string; id?: string }>();
    const maxPolls = adv ? 150 : 60;
    for (let i = 0; i < maxPolls && completed.size < clipIds.length; i++) {
      if (stopped()) return;
      const clips = await sunoBridge.poll(clipIds);
      for (const c of clips) if (c.audio_url && c.status === 'complete' && c.id && !completed.has(c.id)) completed.set(c.id, c);
      if (completed.size >= clipIds.length) break;
      await new Promise((r) => setTimeout(r, 2000));
    }
    if (stopped()) return;
    if (!completed.size) throw new Error('生成超时(渲染未完成)');
    let n = 0, ok = 0; const failures: string[] = [];
    for (const c of completed.values()) {
      if (stopped()) return; // 取消后别再下载/落库
      n++;
      // 单条下载/解码/落库失败不应连累整组 —— 各自 try,失败记一笔继续;已建好的声音保留。
      try {
        const { b64 } = await sunoBridge.download(c.audio_url!);
        const audio = await gctx().decodeAudioData(base64ToArrayBuffer(b64));
        const channels: Float32Array[] = [];
        for (let ch = 0; ch < audio.numberOfChannels; ch++) channels.push(audio.getChannelData(ch).slice());
        const analysis = detectLoop(channels, audio.sampleRate, bpm);
        // 落地即「包裹整段」:默认 warp = detectLoop 整段区间(用户进编辑器再裁),不按生成/上传猜该截多短。
        const warp = { startSample: analysis.startSample, endSample: analysis.endSample, bars: analysis.bars, semitones: 0, warpedBy: 'auto' };
        await api.sounds.create({
          originProjectId: projectId, genId, name: `${prompt.slice(0, 16)} #${n}`, mode, sourceBpm: bpm, key,
          durationSec: audio.duration, sampleRate: audio.sampleRate, channels: audio.numberOfChannels,
          analysis, warp, audioB64: b64, sourceUrl: c.audio_url,
        });
        ok++;
      } catch (e) { failures.push(conciseError(e)); }
    }
    if (stopped()) return;
    if (ok === 0) throw new Error(failures[0] || '全部渲染下载/解码失败'); // 一条都没成 → 整组失败(走外层 catch)
    // 有成功(哪怕部分):标 complete,失败数写进 error 当提示(不丢已建好的声音)。
    await api.gens.patch(genId, { status: 'complete', error: failures.length ? `${failures.length}/${n} 条失败` : null });
    await h.reload();
  } catch (e) {
    if (stopped()) return; // 取消引发的报错不标失败(整组已被干掉)
    const msg = conciseError(e);
    try { await api.gens.patch(genId, { status: 'failed', error: msg }); } catch { /* ignore */ }
    h.patch(genId, { status: 'failed', error: msg });
  } finally {
    h.release?.(genId);
  }
}

/** 生成 → 进库(复用 loop 机逻辑)。失败把 gen 标 failed(简洁报错)。需 Suno 插件。 */
export async function generateToLibrary(projectId: string, prompt: string, opts: { mode?: 'sound' | 'advanced'; loop?: boolean; bpm?: number; key?: string }, masterBpm: number, h: GenHooks): Promise<void> {
  if (!prompt.trim() || !projectId) return;
  const mode = opts.mode ?? 'sound';
  const isLoop = opts.loop ?? true;
  const bpm = opts.bpm && opts.bpm > 0 ? opts.bpm : masterBpm;
  const key = opts.key || '';
  const params: GenParams = { projectId, mode, prompt, bpm, key, loop: isLoop };
  // 建 gen 行(失败则抛给调用方,没有卡片可标记);成功后立刻出卡片,再跑管线。
  const gen = await api.gens.create({ projectId, mode, prompt, bpm, key, loop: isLoop, instrumental: mode === 'advanced' });
  const ctrl = new AbortController(); // 支持随时取消(干掉整组)
  h.appear({ id: gen.id, prompt, mode, status: 'generating', sounds: [], bpm, musicalKey: key, loop: isLoop });
  h.register?.(gen.id, ctrl);
  await runGeneration(gen.id, params, h, ctrl.signal);
}

/** 重试一条失败的 gen:复用它原来的参数,在同一行上重跑。 */
export async function retryGen(genId: string, params: GenParams, h: GenHooks): Promise<void> {
  const ctrl = new AbortController(); // 重试同样可被取消
  h.register?.(genId, ctrl);
  await runGeneration(genId, params, h, ctrl.signal);
}

/** §27 上传管线:multipart 落 Asset(uploading) → 解码 + 估速估调(detecting) → 入库(complete)。镜像 runGeneration。 */
async function runUpload(genId: string, projectId: string, file: File, h: GenHooks, signal?: AbortSignal): Promise<void> {
  const stopped = () => !!signal?.aborted;
  try {
    // ① 传输:把字节落成共享 Asset(WAV 走 multipart,不 base64)。
    h.patch(genId, { status: 'uploading', error: undefined });
    await api.gens.patch(genId, { status: 'uploading', error: null });
    const { assetId } = await api.uploads.create(file);
    if (stopped()) return;
    // ② 检测:本地解码 → 从零估速 + 估调 → 喂回 detectLoop 拿 bars/loop 区/warp 种子。
    h.patch(genId, { status: 'detecting' });
    await api.gens.patch(genId, { status: 'detecting' });
    const audio = await gctx().decodeAudioData(await file.arrayBuffer());
    if (stopped()) return;
    const channels: Float32Array[] = [];
    for (let ch = 0; ch < audio.numberOfChannels; ch++) channels.push(audio.getChannelData(ch).slice());
    const { bpm } = estimateTempo(channels, audio.sampleRate);
    const { key } = estimateKey(channels, audio.sampleRate);
    const mode = audio.duration > 20 ? 'advanced' : 'sound'; // 仅卡片标签;warp 不再据此截短
    const analysis = detectLoop(channels, audio.sampleRate, bpm);
    // 落地即「包裹整段」:默认 warp = detectLoop 整段区间(用户进编辑器再裁)。
    const warp = { startSample: analysis.startSample, endSample: analysis.endSample, bars: analysis.bars, semitones: 0, warpedBy: 'auto' };
    const name = file.name.replace(/\.[^.]+$/, '').slice(0, 24) || 'Upload';
    if (stopped()) return; // 取消后别再落库(对齐 runGeneration:否则取消已软删 gen,这条 sound 仍以 trashed:false 建出 → 库里留孤儿)
    await api.sounds.create({
      originProjectId: projectId, genId, name, mode, sourceBpm: bpm, key: key || '',
      durationSec: audio.duration, sampleRate: audio.sampleRate, channels: audio.numberOfChannels,
      analysis, warp, assetId,
    });
    if (stopped()) return;
    // 把检测结果回填到 gen 卡头(genParams 读 bpm/key/mode);完成。
    await api.gens.patch(genId, { status: 'complete', bpm: Math.round(bpm), musicalKey: key, mode, error: null });
    await h.reload();
  } catch (e) {
    if (stopped()) return;
    const msg = conciseError(e);
    try { await api.gens.patch(genId, { status: 'failed', error: msg }); } catch { /* ignore */ }
    h.patch(genId, { status: 'failed', error: msg });
  } finally {
    h.release?.(genId);
  }
}

/** 上传一个本地音频文件 → 进库(§27)。建 upload gen 行 → 立刻出卡 → 跑管线。 */
export async function uploadToLibrary(projectId: string, file: File, h: GenHooks): Promise<void> {
  if (!projectId || !file) return;
  // 建 gen 行(source=upload;bpm/key 检测前留空,prompt=文件名)。
  const gen = await api.gens.create({ projectId, source: 'upload', mode: 'sound', prompt: file.name, bpm: 0, key: '', loop: true });
  const ctrl = new AbortController(); // 上传/检测可被取消(干掉整条)
  h.appear({ id: gen.id, source: 'upload', prompt: file.name, mode: 'sound', status: 'uploading', sounds: [], bpm: 0, musicalKey: '', loop: true });
  h.register?.(gen.id, ctrl);
  await runUpload(gen.id, projectId, file, h, ctrl.signal);
}
