'use client';
// Studio —— 老 loop 机 .daw 外壳 + 新模型 Session › Instrument › Clip,接真实库 + 生成 + undo + 真 WarpEditor + 落库。
// 左 = LoopManager(生成 + 真实库,可拖);中 = 操场(clip 画波形、拖库素材进空 slot=sample 乐器、hover 空 slot=＋sample/＋切片、拖进 collage=加片);
// 底 = 编辑器(选库素材→预调 warp;选乐器→mixer + warp/collage 下钻)。生产 loop-machine 与 DB 的旧表不碰。
import { useCallback, useEffect, useRef, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { createPortal } from 'react-dom';
import Link from 'next/link';
import type { Clip, CollageClip, Instrument, InstrumentPayload, Mixer, SampleWarp, Session } from '@/contracts';
import { clipMixer, defaultMixer, instrumentBars, mixerToClipPatch, sessionBars, SLOTS_PER_SESSION } from '@/contracts';
import { normalize, diff, type Snapshot } from '@/studio/sync';
import { StudioEngine } from '@/audio/studioEngine';
import { buildBuffer, decodeAsset, loadLibrary, regionFromClip, soundToClip, warpToBuffer } from '@/studio/realLibrary';
import { loadGens, generateToLibrary, retryGen, conciseError, type GenHooks } from '@/studio/studioGens';
import { findInst, patchCollageClip, patchMixer, removeInstrument as docRemove } from '@/studio/sessionDoc';
import { moveItem, placeItem } from '@/studio/collageDoc';
import { MixerStrip } from '@/studio/ui/MixerStrip';
import { InstrumentIcon, INSTRUMENT_ICONS, ICON_KEYS, DEFAULT_ICON } from '@/studio/ui/instrumentIcons';
import { ConfirmDialog, type ConfirmOpts } from '@/ui/ConfirmDialog';
import { LoopManager } from '@/studio/ui/LoopManager';
import type { GenView } from '@/studio/useLoopMachine';
import { api, type ApiSound } from '@/studio/api';
import { ClipEditor } from '@/studio/ui/WarpEditor';

// 客户端生成稳定 id(§15:落库与内存共用同一 id,支撑自动保存,刷新不变)。
const nid = (p: string) => `${p}-${crypto.randomUUID()}`;
const cvar = (c: string): CSSProperties => ({ ['--c']: c } as CSSProperties);
// 拖拽时手里只攥一个小标签(默认会把整块波形当拖拽图,太大)。离屏渲染一个小 pill 当 setDragImage。
function setDragImage(ev: React.DragEvent, label: string): void {
  const g = document.createElement('div');
  g.textContent = '♪ ' + (label || '素材');
  Object.assign(g.style, { position: 'fixed', top: '-1000px', left: '-1000px', padding: '4px 9px', borderRadius: '6px',
    background: 'var(--acc)', color: 'var(--acc-ink)', font: '500 11px -apple-system,system-ui,sans-serif', whiteSpace: 'nowrap', maxWidth: '180px', overflow: 'hidden', textOverflow: 'ellipsis', boxShadow: '0 6px 18px rgba(0,0,0,0.45)' } as CSSStyleDeclaration);
  document.body.appendChild(g);
  try { ev.dataTransfer.setDragImage(g, 14, 12); } catch { /* */ }
  setTimeout(() => g.remove(), 0);
}
const PX = 12;
const FAINT = 'rgba(255,255,255,0.032)'; // 很浅的网格线

function computePeaks(buf: AudioBuffer, n = 120): number[] {
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
function peaksFromRegion(channels: Float32Array[], startSample: number, endSample: number, n = 100): number[] {
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
const lanePeaksCache = new Map<string, number[]>(); // key = assetId:start:end → 峰值(跨乐器/渲染复用)
const pieceKey = (c: { assetId: string; startSample: number; endSample: number }) => `${c.assetId}:${Math.round(c.startSample)}:${Math.round(c.endSample)}`;
// collage 每片配色:按片序号轮一个调色板(相邻片必不同色,方便分辨);lane 与 pad 用同一序号 → 同片同色。
const SLICE_COLORS = ['#c2724f', '#6a86a0', '#c2a24f', '#8a9b6a', '#a06f8a', '#9a7bc0', '#5a9b9b', '#b56a6a'];
const sliceColor = (i: number) => SLICE_COLORS[((i % SLICE_COLORS.length) + SLICE_COLORS.length) % SLICE_COLORS.length];

function Wave({ peaks, className }: { peaks: number[]; className: string }) {
  const n = peaks.length; if (n < 2) return null;
  const sx = 100 / (n - 1);
  const yT = (p: number) => (50 - Math.max(p, 0.03) * 46).toFixed(2);
  const yB = (p: number) => (50 + Math.max(p, 0.03) * 46).toFixed(2);
  let d = `M 0 ${yT(peaks[0])}`;
  for (let i = 1; i < n; i++) d += `L${(i * sx).toFixed(2)} ${yT(peaks[i])}`;
  for (let i = n - 1; i >= 0; i--) d += `L${(i * sx).toFixed(2)} ${yB(peaks[i])}`;
  d += 'Z';
  return <svg className={className} viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true"><path d={d} fill="currentColor" /></svg>;
}

/** collage 乐器 pad:每片一个**彩色底块**(不只波形)+ 片色波形,叠**小节/拍网格线**(和单 sample 的纯波形一眼区分)。 */
function CollagePadWave({ payload, ph }: { payload: Extract<InstrumentPayload, { kind: 'collage' }>; ph: number | null }) {
  const spb = payload.stepsPerBar;
  const loopLen = Math.max(1, Math.round(payload.bars * spb));
  const barPct = (spb / loopLen) * 100, beatPct = barPct / 4; // 每小节/每拍一条线
  return (
    <div className="cwave" aria-hidden="true">
      {payload.clips.map((c, i) => {
        const x = ((c.startStep - payload.loopStartStep) / loopLen) * 100;
        const w = (Math.max(1, Math.round(c.bars * spb)) / loopLen) * 100;
        const vx = Math.max(0, x), vw = Math.min(100, x + w) - vx;
        if (vw <= 0) return null;
        const col = sliceColor(i), pk = lanePeaksCache.get(pieceKey(c));
        return (
          <div key={c.id} style={{ position: 'absolute', top: 0, bottom: 0, left: `${vx}%`, width: `${vw}%`, overflow: 'hidden', background: `color-mix(in srgb, ${col} 26%, transparent)`, borderRight: `1px solid color-mix(in srgb, ${col} 50%, transparent)` }}>
            {pk && pk.length > 1 && <div style={{ position: 'absolute', inset: 0, color: `color-mix(in srgb, ${col} 88%, #fff)`, opacity: 0.92 }}><Wave className="" peaks={pk} /></div>}
          </div>
        );
      })}
      {/* 网格线叠在彩色块之上 */}
      <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none', backgroundImage: `repeating-linear-gradient(90deg, rgba(255,255,255,0.14) 0 1px, transparent 1px ${barPct}%), repeating-linear-gradient(90deg, rgba(255,255,255,0.06) 0 1px, transparent 1px ${beatPct}%)` }} />
      {ph != null && <div style={{ position: 'absolute', top: 0, bottom: 0, left: `${(ph * 100).toFixed(1)}%`, width: 1, background: '#fff', opacity: 0.9, pointerEvents: 'none' }} />}
    </div>
  );
}

interface Ctx { soundsById: Map<string, ApiSound>; bpm: number; beatsPerBar: number }

const emptySessions = (): Session[] => [
  { id: nid('sess'), name: 'Verse', index: 0, instruments: [] },
  { id: nid('sess'), name: 'Break', index: 1, instruments: [] },
];

export function StudioApp({ projectId, masterBpm, beatsPerBar = 4 }: { projectId: string; masterBpm: number; beatsPerBar?: number }) {
  const [ctx, setCtx] = useState<Ctx | null>(null);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [sessionIdx, setSessionIdx] = useState(0);
  const [selId, setSelId] = useState<string | null>(null);
  const [selClipId, setSelClipId] = useState<string | null>(null);
  const [libSel, setLibSel] = useState<string | null>(null);
  const [collageGrid, setCollageGrid] = useState(0.25); // collage arrange 网格分辨率(bars/格),乐器壳 rail 与轨共用
  const [confirmState, setConfirmState] = useState<(ConfirmOpts & { resolve: (v: boolean) => void }) | null>(null);
  const [gens, setGens] = useState<GenView[]>([]);
  const [gp, setGp] = useState('dusty jazz rhodes chords, lo-fi');
  const [gmode, setGmode] = useState<'sound' | 'advanced'>('sound');
  const [gloop, setGloop] = useState(true);
  const [gbpm, setGbpm] = useState(90);
  const [gkey, setGkey] = useState('');
  const [stemUp, setStemUp] = useState<boolean | null>(null);
  const [peaks, setPeaks] = useState<Record<string, number[]>>({});
  const [playing, setPlaying] = useState(false);
  type HistEntry = { sessions: Session[]; warps: Map<string, unknown> }; // 撤销快照口径(§16):sessions 整树 + 各库声音 warp
  const [past, setPast] = useState<HistEntry[]>([]);
  const [future, setFuture] = useState<HistEntry[]>([]);
  const [over, setOver] = useState<number | null>(null);
  const [overKind, setOverKind] = useState<'inst' | 'sound'>('sound'); // 拖到 pad 上的是乐器(移动/互换)还是素材(新建/替换/加片)
  const [dragSoundId, setDragSoundId] = useState<string | null>(null); // 正在拖的素材 id(波形/库共用)→ 轨内占位块按真实长度画、判重叠
  const [hoverSlot, setHoverSlot] = useState<number | null>(null);
  const [, setTick] = useState(0);
  const [status, setStatus] = useState('加载真实库 + 生成记录…');
  const [sync, setSync] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle'); // 自动保存状态(替代 Save 按钮)

  const eng = useRef<StudioEngine | null>(null);
  const raf = useRef<number | null>(null);
  const ctxRef = useRef<Ctx | null>(null);
  const sessionsRef = useRef<Session[]>([]);
  const loaded = useRef(false); // 加载完成前不触发自动保存
  const saving = useRef(false); // 保存锁:避免并发 flush
  const pendingSave = useRef(false); // 保存期间又有改动 → 存完再存一次
  const synced = useRef<Snapshot>({ sessions: {}, instruments: {}, clips: {} }); // 上次已落库的规范化快照,diff 的基准
  const retryTimer = useRef<ReturnType<typeof setTimeout> | null>(null); // 失败退避重试
  const dragOK = useRef(true);
  const lastCollageEdit = useRef<Session | null>(null); // collage 拖移/调参后,松手重 bake 取最新一笔(绕开 sessionsRef 渲染滞后)
  const collageRebakeTimer = useRef<ReturnType<typeof setTimeout> | null>(null); // per-片 mixer 拖动:防抖重 bake(MixerStrip 无 onEnd)
  ctxRef.current = ctx; sessionsRef.current = sessions;

  const loadInstrumentToEngine = useCallback(async (inst: Instrument, seamless = false) => {
    const c = ctxRef.current, e = eng.current; if (!c || !e) return;
    const buf = await buildBuffer(inst, c.bpm, c.soundsById);
    if (!buf) { e.clearInstrument(inst.id); setPeaks((p) => { const q = { ...p }; delete q[inst.id]; return q; }); return; }
    if (seamless && e.hasVoice(inst.id)) {
      e.swapBuffer(inst.id, buf, instrumentBars(inst)); // 在播时:下一个小节边界无缝接管,不断声
    } else {
      e.loadInstrument(inst.id, buf, instrumentBars(inst), inst.mixer);
      e.setEnabled(inst.id, inst.enabled);
    }
    // sample:pad 波形 = 源的 trim 区(与 ClipEditor 同一段,所见=所见);collage:乐器层 = 整条 baked loop。
    let peaks: number[];
    if (inst.payload.kind === 'sample') {
      const cl = inst.payload.clip;
      const d = await decodeAsset(cl.assetId).catch(() => null);
      peaks = d ? peaksFromRegion(d.channels, cl.startSample, cl.endSample) : computePeaks(buf);
    } else {
      peaks = computePeaks(buf);
      // 给每片预算 trim 波形(pad 多色分段渲染要;选中/未选中乐器的 pad 都能显示)。
      for (const cc of inst.payload.clips) { const k = pieceKey(cc); if (cc.assetId && !lanePeaksCache.has(k)) { try { const d = await decodeAsset(cc.assetId); lanePeaksCache.set(k, peaksFromRegion(d.channels, cc.startSample, cc.endSample)); } catch { /* 源缺失 */ } } }
    }
    setPeaks((p) => ({ ...p, [inst.id]: peaks }));
  }, []);
  const loadSession = useCallback(async (s: Session) => {
    eng.current?.clearAll();
    // 单个乐器解码失败(如源文件缺失)不应拖垮整个 session 加载 —— 跳过它,其余照常。
    for (const inst of s.instruments) {
      try { await loadInstrumentToEngine(inst); }
      catch (e) { console.warn('乐器加载失败,跳过:', inst.id, e); }
    }
  }, [loadInstrumentToEngine]);

  const refreshGens = useCallback(async () => { setGens(await loadGens(projectId)); }, [projectId]);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const soundsById = await loadLibrary();
        const g = await loadGens(projectId);
        api.stemService().then((s) => alive && setStemUp(s.up)).catch(() => alive && setStemUp(false));
        let sessions = emptySessions();
        let restored = false;
        const saved = await fetch(`/api/studio?projectId=${projectId}`).then((r) => (r.ok ? r.json() : [])).catch(() => []);
        if (Array.isArray(saved) && saved.length) {
          sessions = saved as Session[];
          restored = true;
        }
        if (!alive) return;
        const c: Ctx = { soundsById, bpm: masterBpm, beatsPerBar };
        eng.current = new StudioEngine();
        eng.current.init(c.bpm, c.beatsPerBar);
        ctxRef.current = c;
        setCtx(c); setGens(g); setSessions(sessions);
        await loadSession(sessions[0]);
        synced.current = normalize(sessions); // 记下加载态为 diff 基准,避免 load 后无谓重存
        loaded.current = true; // 之后任何 setSessions 才触发自动保存
        setStatus(restored ? '已加载 · 拖左边素材到空格 / hover 空格＋加乐器 · ⌘Z · 改动自动保存' : '空操场 · 左边生成/选素材,拖到右边空格 = 单 sample 乐器 · hover 空格可＋切片乐器 · 改动自动保存');
      } catch (err) { setStatus('加载失败:' + conciseError(err)); }
    })();
    return () => { alive = false; if (raf.current != null) cancelAnimationFrame(raf.current); eng.current?.dispose(); };
  }, [loadSession, projectId, masterBpm, beatsPerBar]);

  const startRaf = useCallback(() => { if (raf.current != null) return; const t = () => { setTick((x) => x + 1); raf.current = requestAnimationFrame(t); }; raf.current = requestAnimationFrame(t); }, []);
  const stopRaf = useCallback(() => { if (raf.current != null) { cancelAnimationFrame(raf.current); raf.current = null; } }, []);
  const togglePlay = useCallback(() => {
    const e = eng.current; if (!e) return;
    e.resume().catch(() => {});
    if (e.isPlaying()) { e.stopTransport(); setPlaying(false); stopRaf(); setTick((t) => t + 1); }
    else { e.startTransport(); setPlaying(true); startRaf(); }
  }, [startRaf, stopRaf]);

  const curSession = sessions[sessionIdx];
  // §16 撤销宪法:快照口径 = sessions 整树 + 各库声音 warp(预调改 Sound.warp,不在 sessions 里)。
  const snapshot = (): HistEntry => {
    const warps = new Map<string, unknown>();
    const sb = ctxRef.current?.soundsById; if (sb) for (const [id, snd] of sb) warps.set(id, snd.warp);
    return { sessions: sessionsRef.current, warps };
  };
  const pushHistory = () => { setPast((p) => [...p.slice(-49), snapshot()]); setFuture([]); };
  const updateSession = (next: Session) => setSessions((ss) => ss.map((s, i) => (i === sessionIdx ? next : s)));
  const mutate = (fn: (s: Session) => Session) => { pushHistory(); updateSession(fn(sessionsRef.current[sessionIdx])); };
  const reconcile = useCallback(async (ss: Session[], idx: number) => { await loadSession(ss[idx]); setTick((t) => t + 1); }, [loadSession]);
  // 还原一格:sessions + 只把 warp 变了的库声音改回(+ 反向 patch;其余不碰,免误删之后生成的)+ 校验选中(还在就留→看见 snap back)+ 重灌引擎。
  const applyEntry = (entry: HistEntry) => {
    eng.current?.stopAudition();
    setSessions(entry.sessions);
    const c = ctxRef.current;
    if (c) {
      let changed = false; const sounds = new Map(c.soundsById);
      for (const [id, warp] of entry.warps) {
        const cur = sounds.get(id);
        if (cur && JSON.stringify(cur.warp ?? null) !== JSON.stringify(warp ?? null)) { sounds.set(id, { ...cur, warp }); api.sounds.patch(id, { warp: warp ?? null }).catch(() => {}); changed = true; }
      }
      if (changed) { ctxRef.current = { ...c, soundsById: sounds }; setCtx(ctxRef.current); }
    }
    const insts = entry.sessions[sessionIdx]?.instruments ?? [];
    setSelId((cur) => (cur && insts.some((i) => i.id === cur) ? cur : null));
    setSelClipId((cur) => (cur && insts.some((i) => i.payload.kind === 'collage' && i.payload.clips.some((k) => k.id === cur)) ? cur : null));
    reconcile(entry.sessions, sessionIdx);
  };
  const undo = () => setPast((p) => { if (!p.length) return p; const prev = p[p.length - 1]; setFuture((f) => [snapshot(), ...f]); applyEntry(prev); return p.slice(0, -1); });
  const redo = () => setFuture((f) => { if (!f.length) return f; const nx = f[0]; setPast((p) => [...p, snapshot()]); applyEntry(nx); return f.slice(1); });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (confirmState) return; // 弹窗开着时,快捷键交给弹窗(Enter/Esc)
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
      if ((e.key === 'Delete' || e.key === 'Backspace') && !e.metaKey && !e.ctrlKey) {
        if (libSel) return; // 聚焦库素材时(底部预调)Delete 不删乐器/片
        if (selClipId && selId) { e.preventDefault(); removeCollagePiece(selId, selClipId); } // 选中片 → 删该 collage 片
        else if (selId) { e.preventDefault(); requestRemoveInst(selId); } // 否则删选中乐器(弹确认)
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });
  useEffect(() => { const clear = () => setDragSoundId(null); window.addEventListener('dragend', clear); return () => window.removeEventListener('dragend', clear); }, []); // 拖拽结束(落下/取消)→ 清掉"正在拖的素材"

  const switchSession = (idx: number) => { eng.current?.stopTransport(); eng.current?.stopAudition(); setPlaying(false); stopRaf(); setSessionIdx(idx); setSelId(null); setSelClipId(null); setLibSel(null); loadSession(sessionsRef.current[idx]).then(() => setTick((t) => t + 1)); };

  const toggleInst = (id: string) => { const inst = findInst(curSession, id); if (!inst) return; const on = !inst.enabled; mutate((s) => ({ ...s, instruments: s.instruments.map((i) => (i.id === id ? { ...i, enabled: on } : i)) })); eng.current?.setEnabled(id, on); setTick((t) => t + 1); };
  // 真·预览(只走带停时):自由循环试听某乐器当前 warp 产物,再点停;与激活态互不影响。
  const previewInst = (id: string) => { const en = eng.current; if (!en) return; if (en.auditioningId() === id) en.stopAudition(); else en.previewInstrument(id); setTick((t) => t + 1); };
  // 选中乐器 = arrange 上下文(collage)/底部聚焦(sample);切到别的乐器停掉上一个预览。
  const selectInst = (id: string) => { eng.current?.stopAudition(); setSelId(id); setSelClipId(null); setLibSel(null); };
  const selectPiece = (id: string) => { setSelClipId(id); if (id) setLibSel(null); }; // 点片 → 下方编辑器显示该片;清掉素材聚焦
  // 点素材 = 聚焦到它的预调(底部常驻编辑器显示);选中的是切片乐器时不清它(arrange 浮层留着,只换下方)。
  const focusSound = (id: string) => {
    setLibSel(id); setSelClipId(null);
    const cur = findInst(sessionsRef.current[sessionIdx], selId);
    if (!cur || cur.payload.kind !== 'collage') setSelId(null);
  };
  const changeMixer = (id: string, patch: Partial<Mixer>, history = false) => { if (history) pushHistory(); const next = patchMixer(sessionsRef.current[sessionIdx], id, patch); updateSession(next); const inst = findInst(next, id); if (inst) eng.current?.setMixer(id, inst.mixer); };
  const patchInst = (id: string, patch: Partial<Instrument>) => { mutate((s) => ({ ...s, instruments: s.instruments.map((i) => (i.id === id ? { ...i, ...patch } : i)) })); setTick((t) => t + 1); };
  const removeInst = (id: string) => { eng.current?.stopAudition(); eng.current?.clearInstrument(id); mutate((s) => docRemove(s, id)); if (selId === id) { setSelId(null); setSelClipId(null); } setTick((t) => t + 1); };
  // 通用确认弹窗:const ok = await askConfirm({...}); if (ok) ...
  const askConfirm = (opts: ConfirmOpts) => new Promise<boolean>((resolve) => setConfirmState({ ...opts, resolve }));
  const requestRemoveInst = async (id: string) => { const inst = findInst(curSession, id); if (!inst) return; if (await askConfirm({ title: '删除乐器', message: `确定删除「${inst.label}」?`, confirmLabel: '删除', danger: true })) removeInst(id); };
  const moveInstrument = (from: number, to: number) => { if (from === to) return; mutate((s) => ({ ...s, instruments: s.instruments.map((i) => (i.slot === from ? { ...i, slot: to } : i.slot === to ? { ...i, slot: from } : i)) })); setTick((t) => t + 1); };

  // 解码 / analysis 拼装现在收在 ClipEditor 内部(吃 Clip + Sound 自解码),这里不再手搓 editor 状态。

  // --- 库交互(LoopManager)---
  const auditionSound = async (id: string) => {
    const c = ctxRef.current, en = eng.current; if (!c || !en) return;
    focusSound(id);
    if (en.auditioningId() === id) { en.stopAudition(); setTick((t) => t + 1); return; }
    const s = c.soundsById.get(id); if (!s) return;
    await en.resume();
    const buf = await warpToBuffer(s, c.bpm, regionFromClip(soundToClip(s))); // 走种子 Clip(含 timeMul),与建乐器后一致
    en.audition(id, buf, undefined, en.isPlaying()); setTick((t) => t + 1); // 走带在跑 → 量化跟随 bar(等待期波形呼吸)
  };
  const genHooks = useCallback((): GenHooks => ({
    appear: (g) => setGens((gs) => [g, ...gs]),
    patch: (gid, p) => setGens((gs) => gs.map((g) => (g.id === gid ? { ...g, ...p } : g))),
    reload: async () => { const sb = await loadLibrary(); if (ctxRef.current) { ctxRef.current.soundsById = sb; setCtx({ ...ctxRef.current }); } await refreshGens(); setStatus('生成完成 → 进库'); },
  }), [refreshGens]);
  const onGenerate = () => {
    setStatus('生成中…(需 Suno 插件 + 登录的 suno.com 标签)');
    generateToLibrary(projectId, gp, { mode: gmode, loop: gloop, bpm: gbpm, key: gkey }, ctx?.bpm ?? masterBpm, genHooks())
      .catch((e) => setStatus('生成失败:' + conciseError(e)));
  };
  const onRetryGen = (id: string) => {
    const g = gens.find((x) => x.id === id); if (!g) return;
    setStatus('重试生成中…');
    retryGen(id, { projectId, mode: g.mode === 'advanced' ? 'advanced' : 'sound', prompt: g.prompt, bpm: g.bpm ?? ctx?.bpm ?? masterBpm, key: g.musicalKey ?? '', loop: g.loop ?? true }, genHooks())
      .catch((e) => setStatus('重试失败:' + conciseError(e)));
  };
  const onDeleteGen = async (id: string) => {
    setGens((gs) => gs.filter((g) => g.id !== id)); // 乐观移除整组
    try { await api.gens.remove(id); } catch (e) { setStatus('删除失败:' + conciseError(e)); }
    const sb = await loadLibrary(); if (ctxRef.current) { ctxRef.current.soundsById = sb; setCtx({ ...ctxRef.current }); }
    await refreshGens();
  };
  const onDeleteSound = async (id: string) => {
    try { await api.sounds.remove(id); } catch (e) { setStatus('删除失败:' + conciseError(e)); return; }
    if (libSel === id) setLibSel(null);
    const sb = await loadLibrary(); if (ctxRef.current) { ctxRef.current.soundsById = sb; setCtx({ ...ctxRef.current }); }
    await refreshGens();
  };
  const separateSound = async (id: string) => { try { await api.sounds.separate(id); await refreshGens(); } catch (e) { setStatus('分离失败:' + conciseError(e)); } };

  // --- 操场:加乐器 / 拖入 / hover ---
  const sampleInstFrom = (s: ApiSound, slot: number): Instrument => {
    return { id: nid('inst'), slot, label: s.name, color: '#c2724f', mixer: defaultMixer(), sends: [], enabled: false, payload: { kind: 'sample', clip: { ...soundToClip(s), id: nid('clip') } } };
  };
  const addSampleFromSound = (soundId: string, slot: number) => {
    const c = ctxRef.current; if (!c) return; const s = c.soundsById.get(soundId); if (!s) return;
    eng.current?.stopAudition(); // 建乐器即提交 → 停掉松散的素材预览
    const inst = sampleInstFrom(s, slot);
    mutate((sess) => ({ ...sess, instruments: [...sess.instruments, inst] }));
    loadInstrumentToEngine(inst).then(() => setTick((t) => t + 1));
    setSelId(inst.id); setLibSel(null);
  };
  const addEmptyAt = (slot: number, kind: 'sample' | 'collage') => {
    eng.current?.stopAudition();
    const payload: InstrumentPayload = kind === 'sample'
      ? { kind: 'sample', clip: { id: nid('clip'), soundId: '', assetId: '', startSample: 0, endSample: 0, bars: 1, semitones: 0, gainDb: 0 } }
      : { kind: 'collage', bars: 2, stepsPerBar: 16, loopStartStep: 0, bakedAssetId: null, clips: [] };
    const inst: Instrument = { id: nid(kind), slot, label: kind === 'sample' ? '（空 sample）' : '切片乐器', color: kind === 'collage' ? '#9a7bc0' : '#6a86a0', mixer: defaultMixer(), sends: [], enabled: false, payload };
    mutate((s) => ({ ...s, instruments: [...s.instruments, inst] }));
    if (kind === 'collage') loadInstrumentToEngine(inst);
    setSelId(inst.id); setSelClipId(null); setLibSel(null);
  };
  const dropSoundOnSlot = async (soundId: string, slot: number) => {
    const c = ctxRef.current; if (!c) return;
    eng.current?.stopAudition(); // 落到 pad 即提交 → 停掉松散的素材预览
    const inst = curSession.instruments.find((i) => i.slot === slot);
    if (!inst) { addSampleFromSound(soundId, slot); return; }      // 空格 → 新建单 sample 乐器
    if (inst.payload.kind === 'sample') { // 填充/替换 —— 复用同一 clip id → 一条 clip.upd
      const s = c.soundsById.get(soundId); if (!s) return;
      if (inst.payload.clip.soundId !== '' && inst.payload.clip.soundId !== soundId) { // 已有素材且换的是另一个 → 弹确认(空 sample 填充不问)
        if (!(await askConfirm({ title: '替换素材', message: `用「${s.name}」替换乐器「${inst.label}」当前的素材?`, confirmLabel: '替换' }))) return;
      }
      const live = findInst(sessionsRef.current[sessionIdx], inst.id); // 弹窗期间乐器可能被改/删 → 用最新的重建,别用确认前捕获的旧快照
      if (!live || live.payload.kind !== 'sample') return;
      const updated: Instrument = { ...live, label: s.name, payload: { kind: 'sample', clip: { ...soundToClip(s), id: live.payload.clip.id ?? nid('clip') } } };
      mutate((sess) => ({ ...sess, instruments: sess.instruments.map((i) => (i.id === inst.id ? updated : i)) }));
      loadInstrumentToEngine(updated).then(() => setTick((t) => t + 1)); // ⚠用本地 updated,别读 mutate 后还没刷新的 sessionsRef(否则 load 到旧空 clip → 不出声/无波形)
      setSelId(inst.id); setLibSel(null); setSelClipId(null);
    } else { addPieceToCollage(inst.id, soundId); }              // 切片乐器 → 加到末尾(无视 trim)
  };
  const addPieceToCollage = (instId: string, soundId: string) => {
    const c = ctxRef.current; if (!c) return; const s = c.soundsById.get(soundId); if (!s) return;
    const inst = findInst(sessionsRef.current[sessionIdx], instId); if (!inst || inst.payload.kind !== 'collage') return;
    const startStep = inst.payload.clips.length * 8;
    const piece: CollageClip = { ...soundToClip(s), id: nid('k'), startStep }; // 整片(warp 种子,与拖进轨一致)
    const updated: Instrument = { ...inst, payload: { ...inst.payload, clips: [...inst.payload.clips, piece] } };
    mutate((sess) => ({ ...sess, instruments: sess.instruments.map((i) => (i.id === instId ? updated : i)) }));
    loadInstrumentToEngine(updated).then(() => setTick((t) => t + 1)); // 同上:用本地 updated
  };
  // collage 片:ClipEditor 吐完整 Clip(含 startStep,因 onChange 是 {...片}) → patch 进 collage + 逐片重 bake(无缝)+ 可撤销。
  const writeCollageClip = async (instId: string, clip: CollageClip) => {
    const cur = sessionsRef.current[sessionIdx];
    pushHistory();
    const next = patchCollageClip(cur, instId, clip.id, { startSample: clip.startSample, endSample: clip.endSample, bars: clip.bars, timeMul: clip.timeMul, semitones: clip.semitones, gainDb: clip.gainDb });
    updateSession(next);
    const inst = findInst(next, instId); if (inst) loadInstrumentToEngine(inst, true);
    const en = eng.current, c = ctxRef.current; // 片在试听中(按 clip.id)→ 同库素材:不停就边界无缝换上新 region
    if (en?.auditioningId() === clip.id && c) { const s = c.soundsById.get(clip.soundId); if (s) { const buf = await warpToBuffer(s, c.bpm, regionFromClip(clip)); en.auditionSwap(clip.id, buf); } }
  };
  // collage 片预览:单独 warp 这片的区(自由循环,不挂主走带);与库素材试听同路(裸,不过整 collage)。
  const previewCollagePiece = async (clip: CollageClip) => {
    const e = eng.current, c = ctxRef.current; if (!e || !c) return;
    if (e.auditioningId() === clip.id) { e.stopAudition(); setTick((t) => t + 1); return; }
    const s = c.soundsById.get(clip.soundId); if (!s) return;
    await e.resume();
    const buf = await warpToBuffer(s, c.bpm, regionFromClip(clip));
    e.audition(clip.id, buf); setTick((t) => t + 1);
  };

  // --- collage arrange(自由网格:拖移/拖放/留白/无限延长;片按网格吸附,长度=各自 warp 的 bars)---
  // loop 区间 = [loopStartStep, +bars) —— 由乐器拉杆控制(与内容解耦,不再自动跟内容增长);开头/中间留白 = loop 内静音。
  const collageDocView = (p: Extract<InstrumentPayload, { kind: 'collage' }>) => ({ bars: 1e7, stepsPerBar: p.stepsPerBar, beatsPerBar: ctxRef.current?.beatsPerBar ?? 4, masterBpm: ctxRef.current?.bpm ?? 90, items: p.clips }); // bars 放大 → 右边不夹死(支持无限延长)
  const writeCollagePayload = (instId: string, items: CollageClip[]): Session => {
    const cur = sessionsRef.current[sessionIdx];
    const ns: Session = { ...cur, instruments: cur.instruments.map((i) => (i.id === instId && i.payload.kind === 'collage' ? { ...i, payload: { ...i.payload, clips: items } } : i)) }; // bars/loopStart 不动
    updateSession(ns); lastCollageEdit.current = ns; return ns;
  };
  // loop 拉杆:实时改 loopStartStep/bars(松手才重 bake);clamp 已在 CollageEditor 里 snap+夹好。
  const setCollageLoop = (instId: string, loopStartStep: number, bars: number) => {
    const cur = sessionsRef.current[sessionIdx];
    const ns: Session = { ...cur, instruments: cur.instruments.map((i) => (i.id === instId && i.payload.kind === 'collage' ? { ...i, payload: { ...i.payload, loopStartStep, bars } } : i)) };
    updateSession(ns); lastCollageEdit.current = ns;
  };
  const beginCollageEdit = () => pushHistory();                                   // 拖动/调参开始压一次撤销
  const rebakeCollage = (instId: string) => { const ns = lastCollageEdit.current ?? sessionsRef.current[sessionIdx]; const u = findInst(ns, instId); if (u) loadInstrumentToEngine(u, true); };
  const moveCollagePiece = (instId: string, clipId: string, startStep: number) => { // 拖移(实时改位,松手才重 bake);startStep 已 snap
    const inst = findInst(sessionsRef.current[sessionIdx], instId); if (!inst || inst.payload.kind !== 'collage') return;
    writeCollagePayload(instId, moveItem(collageDocView(inst.payload), clipId, startStep).items as CollageClip[]);
  };
  const dropOnCollageLane = (instId: string, soundId: string, startStep: number) => { // 拖库素材到网格位 → 整片(soundToClip 带 warp 种子+timeMul)
    const c = ctxRef.current; if (!c) return; const s = c.soundsById.get(soundId); if (!s) return;
    eng.current?.stopAudition(); // 落到轨即提交 → 停掉松散的素材预览
    const inst = findInst(sessionsRef.current[sessionIdx], instId); if (!inst || inst.payload.kind !== 'collage') return;
    const piece: CollageClip = { ...soundToClip(s), id: nid('k'), startStep };
    const placed = placeItem(collageDocView(inst.payload), piece);
    if (placed.items.length === inst.payload.clips.length) return; // 位置被占,没放进去
    pushHistory();
    const ns = writeCollagePayload(instId, placed.items as CollageClip[]);
    setSelClipId(piece.id);
    const u = findInst(ns, instId); if (u) loadInstrumentToEngine(u).then(() => setTick((t) => t + 1));
  };
  // per-片 mixer(gain/pan/eq):值即时落树(滑杆跟手),重 bake 防抖(MixerStrip 无 onEnd;collage 无 live 节点,改 mix 必重 bake)。
  const setCollagePieceMixer = (instId: string, clipId: string, patch: Partial<Mixer>, history?: boolean) => {
    if (history) pushHistory();
    updateSession(patchCollageClip(sessionsRef.current[sessionIdx], instId, clipId, mixerToClipPatch(patch)));
    if (collageRebakeTimer.current) clearTimeout(collageRebakeTimer.current);
    collageRebakeTimer.current = setTimeout(() => { collageRebakeTimer.current = null; const inst = findInst(sessionsRef.current[sessionIdx], instId); if (inst) loadInstrumentToEngine(inst, true); }, 180);
  };
  const removeCollagePiece = (instId: string, clipId: string) => {
    const cur = sessionsRef.current[sessionIdx];
    pushHistory();
    const ns: Session = { ...cur, instruments: cur.instruments.map((i) => { if (i.id !== instId || i.payload.kind !== 'collage') return i; const clips = i.payload.clips.filter((c) => c.id !== clipId); return { ...i, payload: { ...i.payload, clips } }; }) }; // bars/loopStart 不动
    updateSession(ns);
    if (selClipId === clipId) setSelClipId(null);
    const u = findInst(ns, instId); if (u) loadInstrumentToEngine(u, true);
  };

  // sample 乐器:ClipEditor 吐出完整新 Clip(warp/trim/变调/timeMul 全在内) → 整条替换 + 无缝换 buffer(在播不断声) + 可撤销。
  const writeSampleClip = (instId: string, clip: Clip) => {
    const cur = sessionsRef.current[sessionIdx];
    const next = cur.instruments.map((i) => (i.id === instId && i.payload.kind === 'sample' ? { ...i, payload: { kind: 'sample' as const, clip } } : i));
    pushHistory();
    updateSession({ ...cur, instruments: next });
    const inst = next.find((i) => i.id === instId); if (inst) loadInstrumentToEngine(inst, true);
  };
  // 预调:ClipEditor 吐完整 Clip → 写回 Sound.warp(种子,同 Clip 同形:含 timeMul);出身标记 manual(库角标用)。
  const editSoundRegion = async (soundId: string, clip: Clip) => {
    const c = ctxRef.current; if (!c) return;
    const s = c.soundsById.get(soundId); if (!s) return;
    pushHistory(); // §16:预调改 Sound.warp(快照口径②)→ 改动前压栈,可撤
    const warp: SampleWarp = { startSample: clip.startSample, endSample: clip.endSample, bars: clip.bars, timeMul: clip.timeMul, semitones: clip.semitones, warpedBy: 'manual' };
    const sounds = new Map(c.soundsById); sounds.set(soundId, { ...s, warp }); // 不可变更新:免污染已压栈的快照引用
    ctxRef.current = { ...c, soundsById: sounds }; setCtx(ctxRef.current);
    api.sounds.patch(soundId, { warp }).then(() => refreshGens()).catch(() => {});
    const en = eng.current; // 试听中改 region → 不停下、边界无缝换上新 trim/长度/变调(否则要停了重播才生效)
    if (en?.auditioningId() === soundId) { const buf = await warpToBuffer(s, c.bpm, regionFromClip(clip)); en.auditionSwap(soundId, buf); }
  };
  // 自动保存(§15.C:没有 Save —— 改即存,字段级细粒度 op)。
  // 当前树 vs synced 快照做 diff → 最小 op 列表 → POST /api/studio/ops;成功后 synced=target。
  // 保存锁串行化;保存期间又有改动则存完再存一次;失败退避重试。
  const flushOps = useCallback(async () => {
    if (saving.current) { pendingSave.current = true; return; }
    saving.current = true;
    do {
      pendingSave.current = false;
      const target = normalize(sessionsRef.current);
      const ops = diff(synced.current, target);
      if (ops.length === 0) break; // 无实质变化
      setSync('saving');
      try {
        const r = await fetch('/api/studio/ops', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ projectId, ops }) });
        if (!r.ok) throw new Error(String(r.status));
        synced.current = target; // 这批已落库,推进基准
        if (retryTimer.current) { clearTimeout(retryTimer.current); retryTimer.current = null; }
        setSync('saved');
      } catch {
        setSync('error');
        saving.current = false;
        if (!retryTimer.current) retryTimer.current = setTimeout(() => { retryTimer.current = null; flushOps(); }, 3000); // 退避重试(基准未推进 → 下次重算同 diff)
        return;
      }
    } while (pendingSave.current);
    saving.current = false;
  }, [projectId]);

  // 防抖:sessions 有实质变化 → 350ms 后落库(加载完成前不触发)。diff 天然合并连续改动。
  useEffect(() => {
    if (!loaded.current) return;
    if (diff(synced.current, normalize(sessionsRef.current)).length === 0) return;
    const t = setTimeout(() => { flushOps(); }, 350);
    return () => clearTimeout(t);
  }, [sessions, flushOps]);
  useEffect(() => () => { if (retryTimer.current) clearTimeout(retryTimer.current); }, []);

  const e = eng.current;
  const pos = e && playing ? e.barBeat() : { bar: 1, beat: 1, sixteenth: 1 };
  const sel = curSession ? findInst(curSession, selId) : null;
  const arrangeInst = sel && sel.payload.kind === 'collage' ? sel : null; // 选中切片乐器 → arrange 浮层(与下方 clip 聚焦解耦)
  const auditioning = e?.auditioningId() ?? null;

  if (!ctx || !curSession) return <main className="daw" translate="no"><div className="ed-idle">{status}</div></main>;

  const slotCount = SLOTS_PER_SESSION;
  const dragSound = dragSoundId ? ctx.soundsById.get(dragSoundId) ?? null : null;
  const dragBars = dragSound ? soundToClip(dragSound).bars : null; // 拖进轨时占位块的真实小节数(种子 warp 算出,无需解码)

  return (
    <main className="daw" translate="no">
      <header className="tbar">
        <Link href="/projects" className="ic" title="返回项目工作台" style={{ textDecoration: 'none' }}>←</Link>
        <button className="tp" data-on={playing} onClick={togglePlay} aria-label={playing ? '停止' : '播放'}>{playing ? '■' : '▶'}</button>
        <div className="tg"><span className="tg-l">Tempo</span><input className="tg-bpm" value={ctx.bpm} readOnly title="项目主 BPM(改 BPM 需 re-warp 全部,后做)" /><span className="tg-u">BPM</span></div>
        <div className="led" title="bar · beat · 16th"><b>{pos.bar}</b><i>.</i><b>{pos.beat}</b><i>.</i><b>{pos.sixteenth}</b></div>
        <div className="tg"><span className="tg-l">Quantize</span><div className="seg sm"><button className="on">1 Bar</button></div></div>
        <div className="thist"><button className="ic" disabled={!past.length} title="撤销 (⌘Z)" onClick={undo}>↶</button><button className="ic" disabled={!future.length} title="重做" onClick={redo}>↷</button></div>
        <span className="svc-dot" style={{ marginLeft: 8 }} title="改动自动保存到库,刷新还原">
          {sync === 'saving' ? '同步中…' : sync === 'saved' ? '已同步 ✓' : sync === 'error' ? '⚠ 保存失败' : '自动保存'}
        </span>
        <div className="tspace" style={{ flex: 1 }} />
        <span className="muted small">Session › Instrument › Clip · 真实库</span>
      </header>

      <div className="daw-main">
        <aside className="br">
          <LoopManager
            gens={gens} selectedLoopId={libSel} previewing={auditioning != null && auditioning === libSel} masterBpm={ctx.bpm}
            genPrompt={gp} genMode={gmode} genLoop={gloop} genBpm={gbpm} genKey={gkey}
            onGenPrompt={setGp} onGenMode={setGmode} onGenLoop={setGloop} onGenBpm={setGbpm} onGenKey={setGkey}
            onGenerate={onGenerate} onSelect={(id) => { eng.current?.stopAudition(); focusSound(id); }} onAudition={auditionSound} onDragSound={setDragSoundId}
            onAssignNext={(id) => { const slot = (() => { let s = 0; const used = new Set(curSession.instruments.map((i) => i.slot)); while (used.has(s)) s++; return s; })(); addSampleFromSound(id, slot); }}
            onSeparate={separateSound} onRetryGen={onRetryGen} onDeleteGen={onDeleteGen} onDeleteSound={onDeleteSound} stemServiceUp={stemUp}
          />
        </aside>

        <section className="stage" style={{ minWidth: 0 }}>
          <div className="banks">
            <span className="sec-l">Session</span>
            {sessions.map((s, i) => (<button key={s.id} className={'bank' + (i === sessionIdx ? ' on' : '')} style={{ width: 'auto', padding: '0 11px' }} onClick={() => switchSession(i)}>{s.name}</button>))}
            <span className="hint">长度 = {sessionBars(curSession)} 小节 · 拖左边素材到空格 = sample 乐器 · hover 空格＋切片 · ▶ 开关</span>
          </div>
          <div className="clipgrid" style={{ gridAutoRows: 120, flexShrink: 0, gap: 0, borderRadius: 'var(--r)', overflow: 'hidden', borderTop: `1px solid ${FAINT}`, borderLeft: `1px solid ${FAINT}` }}>
            {Array.from({ length: slotCount }, (_, slot) => {
              const inst = curSession.instruments.find((i) => i.slot === slot) ?? null;
              const dnd = {
                onDragOver: (ev: React.DragEvent) => { ev.preventDefault(); const isInst = ev.dataTransfer.types.includes('application/x-inst-slot'); ev.dataTransfer.dropEffect = isInst ? 'move' : 'copy'; if (over !== slot) setOver(slot); setOverKind(isInst ? 'inst' : 'sound'); },
                onDragLeave: () => setOver((o) => (o === slot ? null : o)),
                onDrop: (ev: React.DragEvent) => {
                  ev.preventDefault(); setOver(null);
                  const fromSlot = ev.dataTransfer.getData('application/x-inst-slot');
                  if (fromSlot !== '') { moveInstrument(Number(fromSlot), slot); return; } // 乐器 → 乐器 = 移动/互换
                  const id = ev.dataTransfer.getData('text/plain'); if (id) dropSoundOnSlot(id, slot);
                },
              };
              if (!inst) {
                const addBtn: CSSProperties = { font: 'inherit', fontSize: 10.5, padding: '3px 8px', borderRadius: 'var(--r)', background: 'var(--bg-3)', border: '1px solid var(--line-2)', color: 'var(--tx-2)', cursor: 'pointer' };
                return (
                  <div key={slot} className={'clip empty' + (over === slot ? ' over' : '')} style={{ minHeight: 0, borderRadius: 0, borderWidth: '0 1px 1px 0', borderStyle: 'solid', borderColor: FAINT }} onMouseEnter={() => setHoverSlot(slot)} onMouseLeave={() => setHoverSlot((h) => (h === slot ? null : h))} {...dnd}>
                    <span className="cidx">{slot + 1}</span>
                    {over === slot ? (
                        <div style={{ margin: 'auto', padding: '6px 12px', border: '1px dashed var(--acc)', borderRadius: 'var(--r)', color: 'var(--acc)', fontSize: 11, fontWeight: 500, background: 'var(--acc-dim)' }}>
                          {overKind === 'inst' ? '移到这里' : '放这里 · 新建乐器'}
                        </div>
                      ) : hoverSlot === slot ? (
                        <div style={{ margin: 'auto', display: 'flex', gap: 5 }}>
                          <button style={addBtn} onClick={() => addEmptyAt(slot, 'sample')} title="加一个空 sample 乐器,再拖素材进来填充">＋sample</button>
                          <button style={addBtn} onClick={() => addEmptyAt(slot, 'collage')} title="加一个切片乐器,拖多个素材进来拼">＋切片</button>
                        </div>
                      ) : null}
                  </div>
                );
              }
              const color = inst.color ?? 'var(--acc)';
              const st = e?.voiceState(inst.id) ?? 'off';
              const ph = e?.voicePhase(inst.id) ?? null;
              const isSel = inst.id === selId;
              const pk = peaks[inst.id];
              const level = playing ? (e?.voiceLevel(inst.id) ?? 0) : 0; // 实时电平 0..1
              const isEmpty = inst.payload.kind === 'sample' && inst.payload.clip.soundId === '';
              return (
                <div key={slot} draggable onMouseDownCapture={() => { dragOK.current = true; }} onDragStart={(ev) => { if (!dragOK.current) { ev.preventDefault(); return; } ev.dataTransfer.setData('application/x-inst-slot', String(slot)); ev.dataTransfer.effectAllowed = 'move'; }} style={{ position: 'relative', minHeight: 0, borderRadius: 0, borderWidth: '0 1px 1px 0', borderStyle: 'solid', borderColor: FAINT, background: over === slot ? 'var(--acc-dim)' : undefined }} {...dnd}>
                  <div className={`clip filled ${inst.enabled ? 'st-playing' : ''}${playing && (st === 'queued' || st === 'stopping') ? (st === 'queued' ? ' st-queued' : ' st-stopping') : ''}`} style={{ ...cvar(color), position: 'absolute', inset: 6, minHeight: 0, borderRadius: 'var(--r)', borderColor: isSel ? `color-mix(in srgb, ${color} 75%, #fff)` : undefined }} onClick={() => selectInst(inst.id)}>
                    {inst.payload.kind === 'collage'
                      ? <CollagePadWave payload={inst.payload} ph={ph} />
                      : (pk && pk.length > 0 && (
                        <div className="cwave" aria-hidden="true">
                          <Wave className="cwave-base" peaks={pk} />
                          <div className="cwave-fill" style={{ clipPath: ph != null ? `inset(0 ${(100 - ph * 100).toFixed(1)}% 0 0)` : 'inset(0 100% 0 0)' }}><Wave className="" peaks={pk} /></div>
                          {ph != null && <div style={{ position: 'absolute', top: 0, bottom: 0, left: `${(ph * 100).toFixed(1)}%`, width: 1, background: color, opacity: 0.95, pointerEvents: 'none' }} />}
                        </div>
                      ))}
                    <button className="launch" onMouseDown={() => { dragOK.current = false; }} onClick={(ev) => { ev.stopPropagation(); toggleInst(inst.id); }} title="播放态开关"
                      style={{ position: 'relative', overflow: 'hidden', background: `color-mix(in srgb, ${color} ${inst.enabled ? 20 : 12}%, transparent)`, fontSize: 10 }}>
                      <span style={{ position: 'absolute', left: 0, right: 0, bottom: 0, height: `${Math.round(level * 100)}%`, background: `color-mix(in srgb, ${color} 60%, #fff)`, opacity: 0.6, pointerEvents: 'none' }} />
                      <span style={{ position: 'relative', zIndex: 1, color: inst.enabled ? `color-mix(in srgb, ${color} 72%, #fff)` : `color-mix(in srgb, ${color} 52%, #39352f)` }}>{inst.enabled ? '▶' : '■'}</span>
                    </button>
                    <div className="cbody">
                      <div className="cname" style={{ display: 'flex', alignItems: 'center', gap: 5, minWidth: 0 }}>
                        {!isEmpty && <InstrumentIcon icon={inst.icon} size={15} style={{ color, flex: 'none' }} />}
                        <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', minWidth: 0 }}>{inst.label}</span>
                      </div>
                      <div className="cmeta">{isEmpty ? '拖素材进来' : `${inst.payload.kind} · ${instrumentBars(inst)}b`}</div>
                    </div>
                    {isSel && !isEmpty && (() => {
                      // gain 线:选中乐器一条横线 + dB 读数(无圆点),颜色用本 pad 色(提亮)。只有抓到线那条带才调电平,空白处仍是拖拽移动;双击复位 0dB。
                      const gy = Math.max(4, Math.min(96, (1 - (inst.mixer.gainDb + 24) / 30) * 100));
                      const ln = `color-mix(in srgb, ${color} 72%, #fff)`;
                      return (
                        <>
                          <div style={{ position: 'absolute', left: 24, right: 0, top: `${gy}%`, height: 1, background: ln, zIndex: 2, pointerEvents: 'none' }} />
                          <span style={{ position: 'absolute', right: 6, top: `calc(${gy}% - 15px)`, fontSize: 10, color: ln, fontFamily: 'var(--mono)', zIndex: 2, pointerEvents: 'none' }}>{inst.mixer.gainDb}dB</span>
                          <div title="拖动调电平 · 双击复位 0dB" onMouseDown={() => { dragOK.current = false; }}
                            onPointerDown={(ev: React.PointerEvent) => {
                              ev.stopPropagation();
                              const el = ev.currentTarget; try { el.setPointerCapture(ev.pointerId); } catch { /* 合成事件 */ }
                              const card = el.closest('.clip'); const h = card ? card.getBoundingClientRect().height : 108; // 整卡高对应 ±30dB
                              const y0 = ev.clientY; const g0 = inst.mixer.gainDb;
                              let pushed = false; // 只在真正改变 gain 的那一刻压一次撤销(纯点击不污染历史)
                              const mv = (e2: PointerEvent) => { const dg = ((y0 - e2.clientY) / h) * 30; const ng = Math.round(Math.max(-24, Math.min(6, g0 + dg))); if (ng === g0 && !pushed) return; if (!pushed) { changeMixer(inst.id, {}, true); pushed = true; } changeMixer(inst.id, { gainDb: ng }); };
                              const up = (e2: PointerEvent) => { try { el.releasePointerCapture(e2.pointerId); } catch { /* */ } window.removeEventListener('pointermove', mv); window.removeEventListener('pointerup', up); };
                              window.addEventListener('pointermove', mv); window.addEventListener('pointerup', up);
                            }}
                            onDoubleClick={(ev) => { ev.stopPropagation(); if (inst.mixer.gainDb !== 0) { changeMixer(inst.id, {}, true); changeMixer(inst.id, { gainDb: 0 }); } }}
                            style={{ position: 'absolute', left: 24, right: 0, top: `calc(${gy}% - 8px)`, height: 16, zIndex: 2, cursor: 'ns-resize' }} />
                        </>
                      );
                    })()}
                    {over === slot && (
                      <div style={{ position: 'absolute', inset: 0, zIndex: 5, display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: 'var(--r)', border: '1px dashed var(--acc)', background: 'color-mix(in srgb, var(--acc) 24%, transparent)', color: 'var(--acc)', fontSize: 11, fontWeight: 500, pointerEvents: 'none' }}>
                        {overKind === 'inst' ? '↔ 互换位置' : inst.payload.kind === 'collage' ? '＋ 加到切片' : '替换素材'}
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      </div>

      {/* 底部常驻编辑器:按聚焦渲染(素材 / 单sample clip / 切片片 / 空)。切片乐器的 arrange 轨另在浮层(见下)。 */}
      <footer className="daw-editor">
        {(() => {
          // ① 聚焦库素材(预调)—— 最高优先;选中切片乐器时点素材也走这里(arrange 浮层不动,req5)
          if (libSel) {
            const s = ctx.soundsById.get(libSel);
            if (!s) return <EmptyEditor hint="素材不存在" />;
            return (
              <div className="ed-wrap">
                <div className="ed-toplab"><span className="sec-l">预调（库素材的 warp · 改这里会存回素材）</span><span className="muted small">{s.name}</span></div>
                <ClipEditor key={'snd-' + libSel} clip={soundToClip(s)} sound={s} targetBpm={ctx.bpm}
                  onChange={(c) => editSoundRegion(libSel, c)}
                  onDragOut={(ev) => { ev.dataTransfer.setData('text/plain', libSel); ev.dataTransfer.effectAllowed = 'copy'; setDragImage(ev, s.name); setDragSoundId(libSel); }}
                  preview={{ previewing: auditioning === libSel, queued: !!e?.auditionQueuedFor(libSel), getPhase: () => e?.auditionPhase(libSel) ?? null, toggle: () => auditionSound(libSel) }} />
              </div>
            );
          }
          // ② 选中单 sample 乐器 → 它的 clip(空 sample 落到空状态)
          if (sel && sel.payload.kind === 'sample') {
            const p = sel.payload;
            if (p.clip.soundId === '') return <EmptyEditor hint="空 sample · 从左边库拖一条素材到它的格子来填充" />;
            const clip = p.clip;
            const s = ctx.soundsById.get(clip.soundId);
            if (!s) return <EmptyEditor hint="源素材不存在" />;
            const hColor = sel.color ?? 'var(--acc)';
            const enabled = !!sel.enabled;
            const vst = e?.voiceState(sel.id);
            const blink = playing && (vst === 'queued' || vst === 'stopping'); // 走带运行时 toggle 的过渡
            const aud = e?.auditioningId() === sel.id;
            const sounding = (e?.voiceState(sel.id) === 'on') || aud; // 走带出声 或 预览出声 → 画播放线
            const header = (
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', height: 38, padding: '0 12px', borderBottom: '1px solid var(--line)' }}>
                <span style={{ display: 'flex', alignItems: 'center', gap: 9, fontSize: 13, color: 'var(--tx)', minWidth: 0, overflow: 'hidden' }}>
                  <InstrumentChip color={hColor} icon={sel.icon} onPick={(pp) => patchInst(sel.id, pp)} />
                  <InstrumentName label={sel.label} onCommit={(v) => patchInst(sel.id, { label: v })} />
                </span>
                <button onClick={() => toggleInst(sel.id)} title={enabled ? '已激活:主走带播放时参与 · 点击取消激活' : '未激活 · 点击激活'}
                  style={{ flex: 'none', width: 38, height: 22, borderRadius: 6, border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
                    background: enabled ? `color-mix(in srgb, ${hColor} 55%, transparent)` : 'var(--bg-3)',
                    boxShadow: enabled ? `inset 0 0 0 1px color-mix(in srgb, ${hColor} 70%, transparent)` : 'inset 0 0 0 1px var(--line-2)',
                    animation: blink ? 'clippulse .8s ease-in-out infinite' : undefined }}>
                  <span style={{ width: 9, height: 9, borderRadius: '50%', background: enabled ? '#fff' : '#6f6a60', boxShadow: enabled ? '0 0 5px rgba(255,255,255,0.9)' : 'none' }} />
                </button>
              </div>
            );
            return (
              <ClipEditor key={sel.id} clip={clip} sound={s} targetBpm={ctx.bpm} canPreview={!playing}
                onChange={(c) => writeSampleClip(sel.id, c)} header={header}
                mixer={<MixerStrip mixer={sel.mixer} level={playing ? (e?.voiceLevel(sel.id) ?? 0) : 0} onMixer={(patch, history) => changeMixer(sel.id, patch, !!history)} />}
                preview={{ previewing: sounding, getPhase: () => aud ? (e?.auditionPhase(sel.id) ?? null) : (e?.voicePhase(sel.id) ?? null), toggle: () => previewInst(sel.id) }} />
            );
          }
          // ③ 选中切片乐器 + 选了某片 → 该片的 clip(arrange 轨在浮层里)
          if (arrangeInst) {
            const cp = arrangeInst.payload; if (cp.kind !== 'collage') return null;
            const selPiece = cp.clips.find((c) => c.id === selClipId) ?? null;
            const psSound = selPiece ? ctx.soundsById.get(selPiece.soundId) : null;
            if (selPiece && psSound) {
              return (
                <div className="ed-wrap">
                  <div className="ed-toplab"><span className="sec-l">片编辑（{arrangeInst.label}）</span><span className="muted small">{psSound.name}</span></div>
                  <ClipEditor key={selPiece.id} clip={selPiece} sound={psSound} targetBpm={ctx.bpm} canPreview={!playing}
                    mixer={<MixerStrip mixer={clipMixer(selPiece)} level={0} onMixer={(patch, history) => setCollagePieceMixer(arrangeInst.id, selPiece.id, patch, !!history)} />}
                    onChange={(c) => writeCollageClip(arrangeInst.id, { ...(c as CollageClip), id: selPiece.id, startStep: selPiece.startStep })}
                    preview={{ previewing: e?.auditioningId() === selPiece.id, getPhase: () => (e?.auditioningId() === selPiece.id ? (e?.auditionPhase(selPiece.id) ?? null) : null), toggle: () => previewCollagePiece(selPiece) }} />
                </div>
              );
            }
            return <EmptyEditor hint="切片乐器 · 点上方轨里的片来编辑,或把素材拖进轨" />;
          }
          // ④ 空(沿用素材编辑 UI、数据为空)
          return <EmptyEditor />;
        })()}
      </footer>
      {/* arrange 轨浮层:仅选中切片乐器时;落在底部编辑器之上、让开左侧素材列表;Esc / ✕ 收起。 */}
      {arrangeInst && (() => {
        const inst = arrangeInst;
        const hColor = inst.color ?? 'var(--acc)';
        const enabled = !!inst.enabled;
        const collageAud = e?.auditioningId() === inst.id;
        const close = () => { eng.current?.stopAudition(); setSelId(null); setSelClipId(null); };
        return (
          <ArrangePopover onClose={close}>
            <div className="we we-compact">
              <div className="we-ctrl">
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', height: 38, padding: '0 12px', borderBottom: '1px solid var(--line)' }}>
                  <span style={{ display: 'flex', alignItems: 'center', gap: 9, fontSize: 13, color: 'var(--tx)', minWidth: 0, overflow: 'hidden' }}>
                    <InstrumentChip color={hColor} icon={inst.icon} onPick={(pp) => patchInst(inst.id, pp)} />
                    <InstrumentName label={inst.label} onCommit={(v) => patchInst(inst.id, { label: v })} />
                  </span>
                  <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <button onClick={() => toggleInst(inst.id)} title={enabled ? '已激活 · 点击取消激活' : '未激活 · 点击激活'}
                      style={{ flex: 'none', width: 38, height: 22, borderRadius: 6, border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
                        background: enabled ? `color-mix(in srgb, ${hColor} 55%, transparent)` : 'var(--bg-3)', boxShadow: enabled ? `inset 0 0 0 1px color-mix(in srgb, ${hColor} 70%, transparent)` : 'inset 0 0 0 1px var(--line-2)' }}>
                      <span style={{ width: 9, height: 9, borderRadius: '50%', background: enabled ? '#fff' : '#6f6a60', boxShadow: enabled ? '0 0 5px rgba(255,255,255,0.9)' : 'none' }} />
                    </button>
                    <button onClick={close} title="收起 (Esc)" style={{ flex: 'none', width: 24, height: 22, borderRadius: 6, border: '1px solid var(--line-2)', background: 'var(--bg-3)', color: 'var(--tx-2)', cursor: 'pointer', fontSize: 13, lineHeight: 1 }}>✕</button>
                  </span>
                </div>
                <div className="we-ctrl-body">
                  <MixerStrip mixer={inst.mixer} level={playing ? (e?.voiceLevel(inst.id) ?? 0) : 0} onMixer={(patch, history) => changeMixer(inst.id, patch, !!history)} />
                  <div className="we-rail" style={{ padding: '10px' }}>
                    <span className="we-lab">网格</span>
                    <div className="seg we-gseg">{COLLAGE_GRID.map((g) => (<button key={g.label} className={Math.abs(collageGrid - g.bars) < 1e-6 ? 'on' : ''} onClick={() => setCollageGrid(g.bars)}>{g.label}</button>))}</div>
                    <span className="muted small" style={{ marginTop: 8, display: 'block', lineHeight: 1.5 }}>拖移片 · 点片 → 下方编辑 · 拖素材进空位</span>
                  </div>
                </div>
              </div>
              <div className="we-main" style={{ position: 'relative' }}>
                <CollageEditor inst={inst} gridBars={collageGrid} selClipId={selClipId} onSelectClip={selectPiece} dragBars={dragBars}
                  onMoveStart={beginCollageEdit} onMove={(cid, st) => moveCollagePiece(inst.id, cid, st)} onMoveEnd={() => rebakeCollage(inst.id)}
                  onDropSound={(sid, st) => dropOnCollageLane(inst.id, sid, st)} onLoop={(ls, bars) => setCollageLoop(inst.id, ls, bars)}
                  previewing={(e?.voiceState(inst.id) === 'on') || collageAud} getPhase={() => (collageAud ? (e?.auditionPhase(inst.id) ?? null) : (e?.voicePhase(inst.id) ?? null))}
                  onPreviewToggle={() => previewInst(inst.id)} canPreview={!playing} />
              </div>
            </div>
          </ArrangePopover>
        );
      })()}
      {confirmState && <ConfirmDialog {...confirmState} onConfirm={() => { confirmState.resolve(true); setConfirmState(null); }} onCancel={() => { confirmState.resolve(false); setConfirmState(null); }} />}
    </main>
  );
}

const CHIP_COLORS = ['#c2724f', '#6a86a0', '#c2a24f', '#8a9b6a', '#a06f8a', '#9a7bc0', '#5a9b9b', '#b56a6a'];

/** 乐器色块 + 图标:展示当前图标(底色 = 乐器色),点开浮层换颜色/图标。浮层用 portal 挂到 body 上弹,绕开外壳的 overflow:hidden 裁剪。 */
function InstrumentChip({ color, icon, size = 26, onPick }: { color: string; icon?: string | null; size?: number; onPick: (patch: { color?: string; icon?: string }) => void }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ left: number; top: number; below: boolean } | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  // 上方放不下(如 arrange 浮层贴到视口顶,chip 在很上面)→ 翻到锚点下方;左缘夹进视口。否则浮层会跑到屏幕外。
  const place = useCallback(() => {
    const r = btnRef.current?.getBoundingClientRect(); if (!r) return;
    const winW = window.innerWidth || 1280;
    const below = r.top < 200;
    setPos({ left: Math.max(8, Math.min(r.left, winW - 230)), top: below ? r.bottom + 6 : r.top - 6, below });
  }, []);
  const toggle = () => { place(); setOpen((o) => !o); };
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => { const t = e.target as Node; if (!btnRef.current?.contains(t) && !popRef.current?.contains(t)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDoc); document.addEventListener('keydown', onKey);
    window.addEventListener('scroll', place, true); window.addEventListener('resize', place); // 滚动/resize 跟着锚点走
    return () => { document.removeEventListener('mousedown', onDoc); document.removeEventListener('keydown', onKey); window.removeEventListener('scroll', place, true); window.removeEventListener('resize', place); };
  }, [open, place]);
  const cur = icon || DEFAULT_ICON;
  return (
    <>
      <button ref={btnRef} onClick={toggle} title="换图标 / 颜色" style={{ flex: 'none', width: size, height: size, borderRadius: 6, border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', background: `color-mix(in srgb, ${color} 30%, transparent)`, color: `color-mix(in srgb, ${color} 80%, #fff)` }}>
        <InstrumentIcon icon={cur} size={Math.round(size * 0.7)} />
      </button>
      {open && pos && createPortal(
        <div ref={popRef} style={{ position: 'fixed', left: pos.left, top: pos.top, transform: pos.below ? 'none' : 'translateY(-100%)', zIndex: 260, background: 'var(--bg-1)', border: '1px solid var(--line-2)', borderRadius: 8, padding: 9, width: 222, boxShadow: '0 10px 28px rgba(0,0,0,0.45)' }}>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 9 }}>
            {CHIP_COLORS.map((c) => (
              <button key={c} onClick={() => onPick({ color: c })} title={c} style={{ width: 20, height: 20, borderRadius: 5, cursor: 'pointer', background: c, border: c === color ? '2px solid #fff' : '1px solid var(--line-2)' }} />
            ))}
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(6,1fr)', gap: 4 }}>
            {ICON_KEYS.map((k) => (
              <button key={k} title={INSTRUMENT_ICONS[k].label} onClick={() => onPick({ icon: k })} style={{ height: 30, display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: 5, cursor: 'pointer', color: cur === k ? `color-mix(in srgb, ${color} 80%, #fff)` : 'var(--tx-2)', background: cur === k ? `color-mix(in srgb, ${color} 24%, transparent)` : 'var(--bg-2)', border: cur === k ? `1px solid ${color}` : '1px solid transparent' }}>
                <InstrumentIcon icon={k} size={16} />
              </button>
            ))}
          </div>
        </div>, document.body)}
    </>
  );
}

/** 乐器名:单击就地编辑;Enter/失焦提交,Esc 取消。 */
function InstrumentName({ label, onCommit, style }: { label: string; onCommit: (v: string) => void; style?: CSSProperties }) {
  const [editing, setEditing] = useState(false);
  const [val, setVal] = useState(label);
  useEffect(() => { if (!editing) setVal(label); }, [label, editing]);
  if (editing) {
    return (
      <input autoFocus value={val} onChange={(e) => setVal(e.target.value)}
        onBlur={() => { setEditing(false); const v = val.trim(); if (v && v !== label) onCommit(v); else setVal(label); }}
        onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); else if (e.key === 'Escape') { setVal(label); setEditing(false); } }}
        style={{ font: 'inherit', fontSize: 13, color: 'var(--tx)', background: 'var(--bg-0)', border: '1px solid var(--line-2)', borderRadius: 4, padding: '1px 6px', minWidth: 0, width: Math.max(80, Math.min(220, val.length * 9 + 22)), ...style }} />
    );
  }
  return <span onClick={() => setEditing(true)} title="点击改名" style={{ cursor: 'text', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', ...style }}>{label}</span>;
}

const COLLAGE_GRID = [{ label: '1/1', bars: 1 }, { label: '1/2', bars: 0.5 }, { label: '1/4', bars: 0.25 }, { label: '1/8', bars: 0.125 }, { label: '1/16', bars: 0.0625 }];
// arrange 轨(占单 sample 壳的 main 位):网格吸附拖移(夹邻不重叠、可留白)、拖库素材进网格位、尾部 headroom 供延长。
// 选中片不在这里改 —— 点片弹出浮层 ClipEditor(在 footer 分支里渲染);片带 data-clip-id 供浮层锚定。
function CollageEditor({ inst, gridBars, selClipId, onSelectClip, onMoveStart, onMove, onMoveEnd, onDropSound, onLoop, previewing, getPhase, onPreviewToggle, canPreview, dragBars }: {
  inst: Instrument; gridBars: number; selClipId: string | null; onSelectClip: (id: string) => void;
  onMoveStart: () => void; onMove: (clipId: string, startStep: number) => void; onMoveEnd: () => void;
  onDropSound: (soundId: string, startStep: number) => void;
  onLoop: (loopStartStep: number, bars: number) => void;
  previewing: boolean; getPhase: () => number | null; onPreviewToggle: () => void; canPreview: boolean;
  dragBars?: number | null; // 正在拖入的素材小节数 → 占位块按真实长度画、判重叠;未知则按 1 小节
}) {
  const [over, setOver] = useState(false);
  const [dropStep, setDropStep] = useState<number | null>(null); // 拖素材到轨上时,吸附后的落点 → 画占位波形 block
  const [, setPeaksTick] = useState(0);
  const [stepPx, setStepPx] = useState(PX);                 // 缩放:每 step 像素
  const [thumb, setThumb] = useState({ left: 0, width: 100 });
  const scrollRef = useRef<HTMLDivElement>(null);            // 横滚容器(原生 scrollLeft,藏掉系统滚动条)
  const contentRef = useRef<HTMLDivElement>(null);           // 宽内容(坐标系原点)
  const playheadRef = useRef<HTMLDivElement>(null);
  const rafRef = useRef<number | null>(null);
  const viewRef = useRef({ stepPx: PX });                    // 给原生 wheel 监听读最新缩放
  const zoomApply = useRef<{ contentStep: number; cx: number } | null>(null);
  const loopRef = useRef({ start: 0, len: 1 });              // 给 raf 播放线读最新 loop
  const getPhaseRef = useRef(getPhase); getPhaseRef.current = getPhase;

  const cp = inst.payload.kind === 'collage' ? inst.payload : null;
  const spb = cp?.stepsPerBar ?? 16;
  const color = inst.color ?? 'var(--acc)';
  const snapSteps = Math.max(1, Math.round(gridBars * spb));
  const loopStart = cp?.loopStartStep ?? 0;
  const loopEnd = loopStart + Math.round((cp?.bars ?? 1) * spb);        // loop 区间 [loopStart, loopEnd)
  const clips = cp?.clips ?? [];
  const contentEnd = clips.reduce((m, c) => Math.max(m, c.startStep + Math.max(1, Math.round(c.bars * spb))), 0);
  const laneSteps = Math.max(loopEnd, contentEnd, spb) + 2 * spb;       // 显示到 loop/内容最远处 + 2 bar headroom(往右拖会再长)
  viewRef.current = { stepPx };
  loopRef.current = { start: loopStart, len: loopEnd - loopStart };

  const peakKey = (c: { assetId: string; startSample: number; endSample: number }) => `${c.assetId}:${Math.round(c.startSample)}:${Math.round(c.endSample)}`;
  const clipsSig = clips.map(peakKey).join('|');
  useEffect(() => {
    let alive = true;
    (async () => {
      for (const c of clips) { const key = peakKey(c); if (!c.assetId || lanePeaksCache.has(key)) continue; try { const d = await decodeAsset(c.assetId); if (!alive) return; lanePeaksCache.set(key, peaksFromRegion(d.channels, c.startSample, c.endSample)); setPeaksTick((t) => t + 1); } catch { /* 源缺失 */ } }
    })();
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clipsSig]);
  // 自定义滚动条 thumb 同步 scrollLeft / resize / 缩放
  useEffect(() => {
    const el = scrollRef.current; if (!el) return;
    const sync = () => { const sw = el.scrollWidth || 1; setThumb({ left: (el.scrollLeft / sw) * 100, width: Math.min(100, (el.clientWidth / sw) * 100) }); };
    sync(); el.addEventListener('scroll', sync);
    const ro = new ResizeObserver(sync); ro.observe(el);
    return () => { el.removeEventListener('scroll', sync); ro.disconnect(); };
  }, [stepPx, laneSteps]);
  // 滚轮=左右平移;Alt+滚轮=以光标为支点缩放(原生非被动监听才能 preventDefault)。
  useEffect(() => {
    const el = scrollRef.current; if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (e.altKey) {
        e.preventDefault();
        const cx = e.clientX - el.getBoundingClientRect().left;
        const contentStep = (el.scrollLeft + cx) / viewRef.current.stepPx;
        zoomApply.current = { contentStep, cx };
        setStepPx(Math.max(4, Math.min(64, viewRef.current.stepPx * Math.exp(-e.deltaY * 0.0015))));
      } else {
        const d = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
        if (d === 0) return; e.preventDefault(); el.scrollLeft += d;
      }
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);
  useEffect(() => { const el = scrollRef.current, z = zoomApply.current; if (el && z) { el.scrollLeft = Math.max(0, z.contentStep * stepPx - z.cx); zoomApply.current = null; } }, [stepPx]);
  // 播放线:previewing 时 raf 读 getPhase 定位(content 内坐标,随滚动自然移动)。
  useEffect(() => {
    const stop = () => { if (rafRef.current != null) cancelAnimationFrame(rafRef.current); rafRef.current = null; };
    stop();
    if (playheadRef.current) playheadRef.current.style.display = 'none';
    if (!previewing) return;
    const tick = () => {
      const el = playheadRef.current;
      if (el) { const phase = getPhaseRef.current(); if (phase == null) el.style.display = 'none'; else { el.style.display = 'block'; el.style.left = ((loopRef.current.start + phase * loopRef.current.len) * viewRef.current.stepPx) + 'px'; } }
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return stop;
  }, [previewing]);

  if (!cp) return null;

  const stepFromX = (clientX: number) => { const r = contentRef.current?.getBoundingClientRect(); if (!r) return 0; return Math.max(0, Math.round((clientX - r.left) / stepPx / snapSteps) * snapSteps); };
  const startDrag = (e: React.PointerEvent, id: string, origStart: number) => {
    e.stopPropagation(); onSelectClip(id);
    const x0 = e.clientX; let moved = false;
    const mv = (ev: PointerEvent) => { const want = origStart + Math.round((ev.clientX - x0) / stepPx); const snapped = Math.max(0, Math.round(want / snapSteps) * snapSteps); if (!moved) { onMoveStart(); moved = true; } onMove(id, snapped); };
    const up = () => { window.removeEventListener('pointermove', mv); window.removeEventListener('pointerup', up); if (moved) onMoveEnd(); };
    window.addEventListener('pointermove', mv); window.addEventListener('pointerup', up);
  };
  const dragLoop = (e: React.PointerEvent, edge: 'start' | 'end') => {
    e.stopPropagation();
    const x0 = e.clientX; let moved = false;
    const mv = (ev: PointerEvent) => {
      const d = Math.round((ev.clientX - x0) / stepPx);
      if (!moved) { onMoveStart(); moved = true; }
      if (edge === 'start') { const ls = Math.max(0, Math.min(loopEnd - snapSteps, Math.round((loopStart + d) / snapSteps) * snapSteps)); onLoop(ls, (loopEnd - ls) / spb); }
      else { const le = Math.max(loopStart + snapSteps, Math.round((loopEnd + d) / snapSteps) * snapSteps); onLoop(loopStart, (le - loopStart) / spb); }
    };
    const up = () => { window.removeEventListener('pointermove', mv); window.removeEventListener('pointerup', up); if (moved) onMoveEnd(); };
    window.addEventListener('pointermove', mv); window.addEventListener('pointerup', up);
  };
  const thumbDown = (e: React.PointerEvent) => {
    const track = e.currentTarget as HTMLElement; const el = scrollRef.current; if (!el) return;
    const seek = (clientX: number) => { const r = track.getBoundingClientRect(); const frac = Math.max(0, Math.min(1, (clientX - r.left) / (r.width || 1))); el.scrollLeft = frac * Math.max(0, el.scrollWidth - el.clientWidth); };
    seek(e.clientX);
    const mv = (ev: PointerEvent) => seek(ev.clientX);
    const up = () => { window.removeEventListener('pointermove', mv); window.removeEventListener('pointerup', up); };
    window.addEventListener('pointermove', mv); window.addEventListener('pointerup', up);
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minWidth: 0, minHeight: 130, gap: 6 }}>
      <div style={{ position: 'relative', flex: 1, minWidth: 0, minHeight: 0 }}>
      <div ref={scrollRef} className="lane-scroll" style={{ overflowX: 'auto', overflowY: 'hidden', height: '100%', minWidth: 0, border: '1px solid var(--line)', borderRadius: 'var(--r)', scrollbarWidth: 'none' }}>
        <div ref={contentRef}
          onDragOver={(e) => { e.preventDefault(); if (!over) setOver(true); const st = stepFromX(e.clientX); setDropStep((p) => (p === st ? p : st)); }} onDragLeave={() => { setOver(false); setDropStep(null); }}
          onDrop={(e) => { e.preventDefault(); setOver(false); setDropStep(null); const id = e.dataTransfer.getData('text/plain'); if (id) onDropSound(id, stepFromX(e.clientX)); }}
          onPointerDown={() => onSelectClip('')}
          style={{ position: 'relative', height: '100%', minHeight: 116, width: laneSteps * stepPx, minWidth: '100%', background: 'var(--bg-0)', userSelect: 'none', WebkitUserSelect: 'none',
            backgroundImage: `repeating-linear-gradient(90deg, color-mix(in srgb,${color} 24%, transparent) 0 1px, transparent 1px ${spb * stepPx}px), repeating-linear-gradient(90deg, var(--line) 0 1px, transparent 1px ${snapSteps * stepPx}px)`,
            boxShadow: over ? `inset 0 0 0 1px ${color}` : undefined }}>
          <div style={{ position: 'absolute', top: 0, bottom: 0, left: 0, width: loopStart * stepPx, background: 'rgba(0,0,0,0.34)', pointerEvents: 'none', zIndex: 3 }} />
          <div style={{ position: 'absolute', top: 0, bottom: 0, left: loopEnd * stepPx, right: 0, background: 'rgba(0,0,0,0.34)', pointerEvents: 'none', zIndex: 3 }} />
          {Array.from({ length: Math.ceil(laneSteps / spb) }, (_, b) => (<span key={b} className="muted" style={{ position: 'absolute', top: 3, left: b * spb * stepPx + 4, fontSize: 9, fontFamily: 'var(--mono)', color: 'var(--tx-3)', pointerEvents: 'none' }}>{b + 1}</span>))}
          {cp.clips.map((c, i) => {
            const isSel = c.id === selClipId; const pk = lanePeaksCache.get(peakKey(c)); const pcol = sliceColor(i); // 每片一色
            return (
              <div key={c.id} data-clip-id={c.id} onPointerDown={(e) => startDrag(e, c.id, c.startStep)} title={c.soundId}
                style={{ position: 'absolute', top: 20, bottom: 10, left: c.startStep * stepPx, width: Math.max(3, Math.round(c.bars * spb) * stepPx), cursor: 'grab', boxSizing: 'border-box', overflow: 'hidden',
                  background: `color-mix(in srgb, ${pcol} ${isSel ? 52 : 30}%, var(--bg-1))`, border: `1px solid ${isSel ? `color-mix(in srgb, ${pcol} 85%, #fff)` : `color-mix(in srgb, ${pcol} 60%, var(--line))`}` }}>
                {pk && pk.length > 1 && <div style={{ position: 'absolute', inset: 0, color: `color-mix(in srgb, ${pcol} 82%, #fff)`, opacity: isSel ? 0.95 : 0.7, pointerEvents: 'none' }}><Wave className="lanewave" peaks={pk} /></div>}
                {c.semitones !== 0 && <em style={{ position: 'absolute', top: 2, right: 3, fontStyle: 'normal', fontSize: 9, color: 'var(--tx)', background: 'color-mix(in srgb, var(--bg-0) 65%, transparent)', borderRadius: 3, padding: '0 3px', zIndex: 1, pointerEvents: 'none' }}>{c.semitones > 0 ? `+${c.semitones}` : c.semitones}</em>}
              </div>
            );
          })}
          {dropStep != null && (() => {
            const gSteps = Math.max(1, Math.round((dragBars ?? 1) * spb)); // 占位块宽 = 素材真实小节(未知则 1 小节)
            const occupied = clips.some((c) => dropStep < c.startStep + Math.max(1, Math.round(c.bars * spb)) && c.startStep < dropStep + gSteps); // 与已有片重叠 → 落不下
            const col = occupied ? 'var(--danger)' : 'var(--acc)';
            return (
              <div style={{ position: 'absolute', top: 20, bottom: 10, left: dropStep * stepPx, width: gSteps * stepPx, zIndex: 4, pointerEvents: 'none', boxSizing: 'border-box',
                border: `1px dashed ${col}`, background: `color-mix(in srgb, ${col} 16%, transparent)`, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <span style={{ fontSize: 10, color: col, fontWeight: 500 }}>{occupied ? '位置被占' : '放这里'}</span>
              </div>
            );
          })()}
          <div ref={playheadRef} style={{ position: 'absolute', top: 0, bottom: 0, width: 1, background: '#fff', boxShadow: '0 0 4px rgba(255,255,255,0.7)', zIndex: 6, pointerEvents: 'none', display: 'none' }} />
          {([['start', loopStart, '#7cd17c'], ['end', loopEnd, '#e8a33d']] as const).map(([edge, step, hc]) => (
            <div key={edge} onPointerDown={(e) => dragLoop(e, edge)} title={edge === 'start' ? 'loop 起点(拖)' : 'loop 尾部(拖)'}
              style={{ position: 'absolute', top: 0, bottom: 0, left: step * stepPx - 4, width: 8, zIndex: 5, cursor: 'ew-resize' }}>
              <div style={{ position: 'absolute', top: 0, bottom: 0, left: 3, width: 2, background: hc }} />
              <div style={{ position: 'absolute', top: 0, left: 0, width: 8, height: 8, background: hc, clipPath: 'polygon(0 0,100% 0,50% 100%)' }} />
            </div>
          ))}
        </div>
      </div>
      <button onClick={() => canPreview && onPreviewToggle()} disabled={!canPreview} title={canPreview ? '预览整条 collage' : '主走带运行中,无需预览'}
        style={{ position: 'absolute', right: 8, bottom: 8, width: 26, height: 26, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 10, lineHeight: 1, border: 'none', borderRadius: 'var(--r)', zIndex: 7,
          cursor: canPreview ? 'pointer' : 'default', opacity: canPreview ? 1 : 0.35, background: previewing ? 'var(--play)' : 'var(--acc)', color: previewing ? '#23201d' : 'var(--acc-ink)' }}>{previewing ? '■' : '▶'}</button>
      </div>
      <div className="we-scroll" onPointerDown={thumbDown}><div className="we-thumb" style={{ left: thumb.left + '%', width: thumb.width + '%' }} /></div>
    </div>
  );
}

/** arrange 轨浮层:portal 挂 body,落在底部编辑器(footer)之上、左缘让开素材列表(aside.br),近满主区宽;Esc 收起;resize/scroll 跟随。 */
function ArrangePopover({ onClose, children }: { onClose: () => void; children: ReactNode }) {
  const [box, setBox] = useState<{ left: number; width: number; top: number } | null>(null);
  const [h, setH] = useState(0);
  const popRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const place = () => {
      const footer = document.querySelector('footer.daw-editor');
      const lib = document.querySelector('aside.br');
      const winW = window.innerWidth || 1280, winH = window.innerHeight || 800;
      const top = footer ? footer.getBoundingClientRect().top : winH - 220;     // 落在底部编辑器之上
      const left = (lib ? lib.getBoundingClientRect().right : 312) + 8;          // 让开左侧素材列表
      setBox({ left, width: Math.max(420, winW - left - 10), top });
    };
    place();
    window.addEventListener('scroll', place, true); window.addEventListener('resize', place);
    const footer = document.querySelector('footer.daw-editor');
    const ro = footer ? new ResizeObserver(place) : null; if (footer && ro) ro.observe(footer); // 底部编辑器高度变(空↔片)→ 重新贴
    return () => { window.removeEventListener('scroll', place, true); window.removeEventListener('resize', place); ro?.disconnect(); };
  }, []);
  useEffect(() => { if (popRef.current) { const oh = popRef.current.offsetHeight; if (oh && oh !== h) setH(oh); } });
  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => { if (ev.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  if (!box) return null;
  const top = Math.max(8, box.top - 8 - h); // 放在编辑器上方;太高就夹到视口顶
  return createPortal(
    <div ref={popRef} style={{ position: 'fixed', left: box.left, top, width: box.width, zIndex: 240, background: 'var(--bg-1)', border: '1px solid var(--line-2)', borderRadius: 10, boxShadow: '0 14px 36px rgba(0,0,0,0.45)', overflow: 'hidden' }}>
      {children}
    </div>, document.body);
}

/** 空状态:沿用素材编辑器(ClipEditor compact)的外壳,数据为空、禁用。 */
function EmptyEditor({ hint }: { hint?: string }) {
  const cells: [string, string][] = [['速度', '—'], ['长度', '—'], ['变调', '—'], ['拉伸', '—']];
  return (
    <div className="ed-wrap">
      <div className="ed-toplab"><span className="sec-l">编辑器</span><span className="muted small">未选择</span></div>
      <div className="we we-compact" style={{ opacity: 0.72 }}>
        <div className="we-ctrl">
          <div className="we-ctrl-body">
            <div className="we-rail">
              <div className="we-grid">
                {cells.map(([l, v]) => (<div className="we-cell" key={l}><span className="we-lab">{l}</span><div className="we-box">{v}</div></div>))}
              </div>
              <div className="we-gridrow"><div className="seg we-gseg">{['1/1', '1/2', '1/4', '1/8', '1/16'].map((g, i) => (<button key={g} className={i === 2 ? 'on' : ''} disabled>{g}</button>))}</div></div>
            </div>
          </div>
        </div>
        <div className="we-main">
          <div className="we-stage" style={{ cursor: 'default', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <span className="muted small" style={{ textAlign: 'center', padding: '0 20px' }}>{hint ?? '点左侧素材预调 · 或点操场乐器编辑'}</span>
          </div>
          <div className="we-scroll"><div className="we-thumb" style={{ left: 0, width: '100%' }} /></div>
        </div>
      </div>
    </div>
  );
}

function Knob({ label, min, max, step = 1, val, unit, onChange, onCommit }: { label: string; min: number; max: number; step?: number; val: number; unit?: string; onChange: (v: number) => void; onCommit?: () => void }) {
  return (
    <label className="muted small" style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
      {label}
      <input type="range" min={min} max={max} step={step} value={val} onChange={(ev) => onChange(Number(ev.target.value))} onPointerUp={onCommit} style={{ width: 84 }} />
      <b style={{ color: 'var(--tx)', fontFamily: 'var(--mono)', minWidth: 38, textAlign: 'right' }}>{step < 1 ? val.toFixed(2) : val}{unit ?? ''}</b>
    </label>
  );
}
