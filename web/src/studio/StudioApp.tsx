'use client';
// Studio —— 老 loop 机 .daw 外壳 + 新模型 Session › Instrument › Clip,接真实库 + 生成 + undo + 真 WarpEditor + 落库。
// 左 = LoopManager(生成 + 真实库,可拖);中 = 操场(clip 画波形、拖库素材进空 slot=sample 乐器、hover 空 slot=＋sample/＋切片、拖进 collage=加片);
// 底 = 编辑器(选库素材→预调 warp;选乐器→mixer + warp/collage 下钻)。生产 loop-machine 与 DB 的旧表不碰。
import { memo, useCallback, useEffect, useRef, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { createPortal } from 'react-dom';
import Link from 'next/link';
import type { Clip, CollageClip, FxConfig, GenPrefs, GridPrefs, Instrument, InstrumentPayload, InstrumentSends, Mixer, Quantize, SampleWarp, Session, XYAutomation, XYAutoSet, XYProgram } from '@/contracts';
import { clipMixer, defaultMixer, defaultSends, DEFAULT_FX, DEFAULT_XY, instrumentBars, mixerToClipPatch, sessionBars, sessionRepeats, SESSION_COLORS, SLOTS_PER_SESSION } from '@/contracts';
import { normalize, diff, type Snapshot } from '@/studio/sync';
import { StudioEngine } from '@/audio/studioEngine';
import { buildBuffer, decodeAsset, loadLibrary, regionFromClip, regionFromSound, soundToClip, warpToBuffer } from '@/studio/realLibrary';
import { loadGens, generateToLibrary, retryGen, uploadToLibrary, conciseError, type GenHooks } from '@/studio/studioGens';
import { addSession as docAddSession, cloneInstrument, duplicateSessionAt, findInst, freeSlots, moveSession, patchCollageClip, patchMixer, patchSession, removeInstrument as docRemove, removeSessionAt } from '@/studio/sessionDoc';
import { placeItem, placeNear, roomAt, itemLengthSteps } from '@/studio/collageDoc';
import { MixerStrip } from '@/studio/ui/MixerStrip';
import { Wave, MasterMeter, TransportPos, SampleWave, CollageHead, LaunchLevel, SessionPlayhead, SongPlayhead } from '@/studio/ui/live';
import { InstrumentIcon, INSTRUMENT_ICONS, ICON_KEYS, DEFAULT_ICON } from '@/studio/ui/instrumentIcons';
import { TransportIcon } from '@/studio/ui/glyphs';
import { ConfirmDialog, type ConfirmOpts } from '@/ui/ConfirmDialog';
import { LoopManager } from '@/studio/ui/LoopManager';
import { FxRack } from '@/studio/ui/FxRack';
import { XYPad } from '@/studio/ui/XYPad';
import { AutomationLane } from '@/studio/ui/AutomationLane';
import { defaultAutomation, rescaleAuto, sampleXY, isActiveAuto, NEUTRAL, normalizeXyAuto, PROG_COLOR, PROG_LABEL, PROG_ORDER } from '@/studio/xyAutomation';
import type { GenView, LoopView } from '@/contracts/studioViews';
import { api, type ApiSound } from '@/studio/api';
import { ClipEditor } from '@/studio/ui/WarpEditor';

// 客户端生成稳定 id(§15:落库与内存共用同一 id,支撑自动保存,刷新不变)。
const nid = (p: string) => `${p}-${crypto.randomUUID()}`;
const cvar = (c: string): CSSProperties => ({ ['--c']: c } as CSSProperties);

// 生成框默认提示词池:都是「整条 beat」(鼓+贝斯+旋律的完整律动),非单乐器;每次进入随机换一条。
const BEAT_PROMPTS = [
  'boom bap hip hop beat, dusty drums, jazzy sax loop',
  'lo-fi hip hop beat, mellow rhodes, vinyl crackle, rain',
  'trap beat, hard 808s, rolling hi-hats, dark',
  'drill beat, sliding 808, eerie bells, menacing',
  'soulful boom bap beat, chopped soul vocal sample, warm bass',
  'jazzy lo-fi beat, upright bass, brushed drums, smoky',
  'west coast g-funk beat, talkbox synth, deep bass, sunny',
  'neo soul beat, lush rhodes chords, live drums, groovy',
  'phonk beat, cowbell, distorted 808, memphis vocal chops',
  'afrobeat groove, syncopated percussion, warm bass, bright guitar',
  'reggaeton beat, dembow rhythm, punchy kicks, latin vibe',
  'uk garage beat, shuffled 2-step drums, sub bass, soulful chords',
  'boom bap beat, gritty piano loop, vinyl hiss, headnod',
  'cinematic trap beat, orchestral strings, hard 808, epic',
  'funk beat, slap bass, clavinet, tight live drums',
  'dark lo-fi beat, detuned piano, dusty drums, late night',
  'house beat, four on the floor, warm pads, groovy bassline',
  'plugg beat, dreamy bells, bouncy 808, spacey',
  'jersey club beat, bed squeak, chopped vocals, fast kicks',
  'dub reggae beat, spring reverb, deep bassline, off-beat skank',
];
// 随机挑一条,避开上次那条(localStorage 记 index),保证「每次刷新换一次」。仅客户端调用。
function pickBeatPrompt(): string {
  try {
    const KEY = 'sunogrid:gpIdx';
    const last = Number(localStorage.getItem(KEY));
    let i = Math.floor(Math.random() * BEAT_PROMPTS.length);
    if (BEAT_PROMPTS.length > 1 && i === last) i = (i + 1) % BEAT_PROMPTS.length;
    localStorage.setItem(KEY, String(i));
    return BEAT_PROMPTS[i];
  } catch {
    return BEAT_PROMPTS[Math.floor(Math.random() * BEAT_PROMPTS.length)];
  }
}
// 拖拽时手里只攥一个小标签(默认会把整块波形当拖拽图,太大)。离屏渲染一个小 pill 当 setDragImage。
function setDragImage(ev: React.DragEvent, label: string): void {
  const g = document.createElement('div');
  g.textContent = '♪ ' + (label || 'sample');
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
// 按片 id 哈希取色 —— 稳定:排序/拖移/重排都不变色(别用数组下标,下标会随 sortItems 漂)。
const sliceColorFor = (id: string) => { let h = 0; for (let k = 0; k < id.length; k++) h = (Math.imul(h, 31) + id.charCodeAt(k)) | 0; return sliceColor(h); };

/** collage 乐器 pad 的**静态**底:每片一个彩色底块 + 片色波形 + 小节/拍网格线。memo:payload 不变就不重渲
 *  (播放头是独立的 <CollageHead> 自驱动叶子,不在这里;故播放时本体一帧都不用重算)。
 *  peaksSig:各片峰值是否已进 lanePeaksCache 的签名('0'/'1' 串)。reload 后缓存是异步填的、payload 不变,
 *  纯 memo(payload) 会跳过重渲 → pad 只剩色块不显波形;靠此 prop 从 '0…' 变 '1…' 打破 memo,峰值到位即重画。 */
const CollagePadBody = memo(function CollagePadBody({ payload }: { payload: Extract<InstrumentPayload, { kind: 'collage' }>; peaksSig: string }) {
  const spb = payload.stepsPerBar;
  const loopLen = Math.max(1, Math.round(payload.bars * spb));
  const barPct = (spb / loopLen) * 100, beatPct = barPct / 4; // 每小节/每拍一条线
  return (
    <div className="cwave" aria-hidden="true">
      {payload.clips.map((c) => {
        const x = ((c.startStep - payload.loopStartStep) / loopLen) * 100;
        const w = (Math.max(1, Math.round(c.bars * spb)) / loopLen) * 100;
        const vx = Math.max(0, x), vw = Math.min(100, x + w) - vx;
        if (vw <= 0) return null;
        const col = sliceColorFor(c.id), pk = lanePeaksCache.get(pieceKey(c));
        return (
          <div key={c.id} style={{ position: 'absolute', top: 0, bottom: 0, left: `${vx}%`, width: `${vw}%`, overflow: 'hidden', background: `color-mix(in srgb, ${col} 26%, transparent)`, borderRight: `1px solid color-mix(in srgb, ${col} 50%, transparent)` }}>
            {pk && pk.length > 1 && <div style={{ position: 'absolute', inset: 0, color: `color-mix(in srgb, ${col} 88%, #fff)`, opacity: 0.92 }}><Wave className="" peaks={pk} /></div>}
          </div>
        );
      })}
      {/* 网格线叠在彩色块之上 */}
      <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none', backgroundImage: `repeating-linear-gradient(90deg, rgba(255,255,255,0.14) 0 1px, transparent 1px ${barPct}%), repeating-linear-gradient(90deg, rgba(255,255,255,0.06) 0 1px, transparent 1px ${beatPct}%)` }} />
    </div>
  );
});

interface Ctx { soundsById: Map<string, ApiSound>; bpm: number; beatsPerBar: number }

// 空工程兜底:1 个默认会话(与服务端 /api/studio 一致;真正落库由首次保存的 sess.add 完成)
const emptySessions = (): Session[] => [
  { id: nid('sess'), name: 'Scene 1', index: 0, repeats: 1, color: null, instruments: [] },
];

export function StudioApp({ projectId, name = 'project', masterBpm, masterKey = null, genPrefs = null, gridPrefs = null, fx: fxProp = null, quantize: propQuantize = '1bar', beatsPerBar = 4, loopSong: propLoopSong = false, playMode: propPlayMode = 'live', showAutomation: propShowAutomation = true }: { projectId: string; name?: string; masterBpm: number; masterKey?: string | null; genPrefs?: GenPrefs | null; gridPrefs?: GridPrefs | null; fx?: FxConfig | null; quantize?: Quantize; beatsPerBar?: number; loopSong?: boolean; playMode?: 'live' | 'song'; showAutomation?: boolean }) {
  const [ctx, setCtx] = useState<Ctx | null>(null);
  const [projName, setProjName] = useState(name); // 顶栏可编辑工程名;改即乐观写 Project.name(同 quantize 套路,不进 undo/发件箱)
  const [sessions, setSessions] = useState<Session[]>([]);
  const [sessionIdx, setSessionIdx] = useState(0); // 「查看/编辑」中的场景(pad 区 + 编辑器都读它);Song 模式下它与「正在播的块」解耦
  const sessionIdxRef = useRef(0); sessionIdxRef.current = sessionIdx; // 给 useCallback([]) 的 loadInstrumentToEngine 读最新查看场景(判 viewingSoundingBlock)
  const [playingIdx, setPlayingIdx] = useState(0); // §20 Song 模式:当前正在出声的块(高亮 + 播放头跟它);Live 模式播放块=sessionIdx,不用它
  const playingIdxRef = useRef(0); playingIdxRef.current = playingIdx; // §26 回放 rAF 闭包读最新播放块
  const [songZoom, setSongZoom] = useState(34); // §26 Song 比例时间轴:px/bar(缩放;1 bar 默认较宽)
  const [autoAxis, setAutoAxis] = useState<'x' | 'y'>('x'); // §26 自动化 lane 当前显示轴(全局切换)
  const [autoProgram, setAutoProgram] = useState<XYProgram>('filter'); // §26.v2 当前编辑哪条效果 lane(每效果一条;顶栏 chip 切)
  const xyManual = useRef<{ down: boolean; program: XYProgram; x: number; y: number }>({ down: false, program: 'filter', x: 0.5, y: 0 }); // §26.4 手动板手势 → coordinator 读(手动板不再直调引擎)
  const xyClearRef = useRef(0); // §26.4 bump=请求 coordinator 复位所有效果(清 latch/glide):关 XY 浮层 / 卸载 / undo 时触发
  // §20/§26 播放模式 + 量化换场:playMode 现 Project 列乐观持久化(上次进 Live/Song 记住);pendingIdx = 已排队、等量化边界切到的场景(目标卡呼吸);loopSong = Project 列乐观持久化。
  const [playMode, setPlayMode] = useState<'live' | 'song'>(propPlayMode);
  const [pendingIdx, setPendingIdx] = useState<number | null>(null);
  const [loopSong, setLoopSong] = useState(propLoopSong);
  const [showAutomation, setShowAutomation] = useState(propShowAutomation); // §26 automation UI 显隐(纯 UI 层,Project 列持久化);不影响效果回放
  const playModeRef = useRef<'live' | 'song'>(propPlayMode); playModeRef.current = playMode;
  const loopSongRef = useRef(loopSong); loopSongRef.current = loopSong;
  const songSchedId = useRef<number | null>(null); // Song 线性:下一块推进的 scheduleOnce 句柄
  const songBlockStart = useRef(0); // Song 线性:当前块从第几小节开始(播放态高亮"播到第几遍"用)
  const viewFollows = useRef(true); // §20 Song 模式:pad 视图是否跟随播放块推进;点卡查看某场景即脱离(false),停/重播复位(true)
  const starting = useRef(false); // §20 起播重入锁:重置引擎可能异步(loadSession),起播窗口内挡住第二次起播 + 并发换场(switchSession),避免两次 loadSession 交错把多个场景混进引擎
  const liveSwapSchedId = useRef<number | null>(null); // Live 量化换场:已排在边界、还没触发的换场 scheduleOnce 句柄(连点换场要先撤上一个,否则两场同时起声)
  const swapGen = useRef(0); // 换场代号:更晚的一次换场会让先前那次还在 load 的 .then 作废(避免它过后再排边界)
  const [renamingId, setRenamingId] = useState<string | null>(null); // 场景改名内联编辑
  const [titleRenaming, setTitleRenaming] = useState(false); // §26 顶栏标题改名(独立 state,免和块名共用 renamingId 时双输入框)
  // 场景拖拽换位:实时 preview(用 flex order 视觉重排,DOM/数组不动 → cur/索引逻辑无需改);松手才落库一次。
  const [dragId, setDragId] = useState<string | null>(null);            // 正在拖的场景 id(被拖卡压暗当占位)
  const [previewOrder, setPreviewOrder] = useState<string[] | null>(null); // 拖拽中的预览顺序(场景 id 数组),非拖拽=null
  const dragIdRef = useRef<string | null>(null);
  const previewOrderRef = useRef<string[] | null>(null);
  const [selId, setSelId] = useState<string | null>(null);
  const [selClipId, setSelClipId] = useState<string | null>(null);
  const [libSel, setLibSel] = useState<string | null>(null);
  // §23 乐器 copy/paste:markedIds = shift 多选集(仅服务 copy;空 = 单选,copy 退化到 selId)。
  // clipboard = 组件级 ref(瞬态,不进 undo/不落库)——存已 detach 的深拷贝;paste 时再 cloneInstrument 一次拿新 id,故多次 paste 各自独立。同项目内有效(同/跨场景),不跨项目。
  const [markedIds, setMarkedIds] = useState<Set<string>>(() => new Set());
  const clipboardRef = useRef<Instrument[] | null>(null);
  const [collageGrid, setCollageGrid] = useState(gridPrefs?.arrange ?? 0.25); // collage arrange 网格分辨率(bars/格),乐器壳 rail 与轨共用;§15.A 持久化
  // 网格偏好整块持久化(per-project,记住不重置):arrange=拼贴轨吸附、warp/snap=clip warp 编辑器。改即乐观写 Project.gridPrefs。
  const gridRef = useRef<GridPrefs>({ arrange: gridPrefs?.arrange ?? 0.25, warp: gridPrefs?.warp ?? 0.25, snap: gridPrefs?.snap ?? true });
  const saveGrid = (patch: Partial<GridPrefs>) => { gridRef.current = { ...gridRef.current, ...patch }; api.projects.update(projectId, { gridPrefs: gridRef.current }).catch(() => {}); };
  const setArrangeGrid = (bars: number) => { setCollageGrid(bars); saveGrid({ arrange: bars }); };
  const [arrangeH, setArrangeH] = useState(0); // chop arrange 浮层实测高度 → 选中 chop 时给操场加底部 padding,底部 pad 不被浮层挡住
  const [confirmState, setConfirmState] = useState<(ConfirmOpts & { resolve: (v: boolean) => void }) | null>(null);
  const [gens, setGens] = useState<GenView[]>([]);
  const [gp, setGp] = useState(BEAT_PROMPTS[0]); // SSR 稳定种子,挂载后随机换(见下方 effect)
  useEffect(() => { setGp(pickBeatPrompt()); }, []); // 进入/刷新随机换一条 beat 提示词(客户端 only,避 hydration mismatch)
  const [gmode, setGmode] = useState<'sound' | 'advanced'>(genPrefs?.mode ?? 'sound');
  const [gloop, setGloop] = useState(genPrefs?.loop ?? true);
  // 生成 BPM(§4.1):持久化的独立值,可随时改;主 BPM 变化时单向透传一次覆盖(下方 effect)。
  const [gbpm, setGbpm] = useState(genPrefs?.bpm ?? masterBpm);
  const [gkey, setGkey] = useState(masterKey ?? ''); // 工程调;'' = Any
  const [stemUp, setStemUp] = useState<boolean | null>(null);
  const [peaks, setPeaks] = useState<Record<string, number[]>>({});
  const [libPeaks, setLibPeaks] = useState<Record<string, number[]>>({}); // 库卡波形缩略图:sound/stem id → 峰值(懒解码 + lanePeaksCache 复用)
  const [warming, setWarming] = useState<string | null>(null); // ⑥ 试听 warm-up:正在 build buffer 的 sound/clip id(命中缓存<120ms 不显)
  const [building, setBuilding] = useState<Record<string, boolean>>({}); // ⑩ 新乐器入场:正在首建 buffer 的乐器 id(无 peaks 时 → 压暗 + 锁 ▶)
  const [playing, setPlaying] = useState(false);
  const playingRef = useRef(false); playingRef.current = playing; // §26.4 coordinator 常驻 rAF 闭包读最新播放态
  const [soloIds, setSoloIds] = useState<Set<string>>(() => new Set()); // §18 独奏集(瞬态,不落库/不进 undo);隔离式 + 多选
  // 顶栏:量化粒度 / 节拍器(开关·音量·几小节响一次) / 主音量。引擎能力见 StudioEngine。
  const [quantize, setQuantizeState] = useState<Quantize>(propQuantize);
  const [metroOn, setMetroOn] = useState(false);
  const [metroVol, setMetroVol] = useState(-8);
  const [metroIv, setMetroIv] = useState<'beat' | 'bar' | '2bar' | '4bar'>('beat');
  const [masterVol, setMasterVol] = useState(0);
  // 主总线效果器(§17):per-project,改即时 setFx 到引擎 + 防抖乐观持久化;v1 不进 undo(同 masterVol/quantize,见 §16 沿革)。
  // 归一化:老工程的 Project.fx 没有 xy 字段(§21 后加)→ 补 DEFAULT_XY,免 XYPad 读到 undefined。
  const [fx, setFx] = useState<FxConfig>(() => (fxProp ? { ...DEFAULT_FX, ...fxProp, xy: { ...DEFAULT_XY, ...(fxProp.xy ?? {}) } } : DEFAULT_FX));
  const fxRef = useRef<FxConfig>(fx); fxRef.current = fx;
  // 撤销快照口径(§16):① sessions 整树 ② 各库声音 warp ③ 主 bpm ④ 主总线效果器(§17)⑤ 活动 session(undo 跳回改动现场)⑥ 量化粒度 ⑦ 库存活集(声音/生成组软删可撤)
  // ⚠ 改这个口径(加/减可还原字段)→ 必须同步更新 `histDataKey`(空步判定的数据序列化,除 sessionId 外每个 data 字段都要进),否则空步跳过会漏判/误判。
  type HistEntry = { sessions: Session[]; warps: Map<string, unknown>; bpm: number; fx: FxConfig; sessionId: string; quantize: Quantize; liveSounds: Set<string>; liveGens: Set<string> };
  const [past, setPast] = useState<HistEntry[]>([]);
  const [future, setFuture] = useState<HistEntry[]>([]);
  // ⚠ undo/redo 的 snapshot()/applyEntry() 必须在 setState updater **外**只跑一次:React StrictMode(dev)会双调 updater,
  // 若副作用写在 updater 里会重复跑、把 past/future 栈搞乱(表现:redo 还原不出来)。故用 ref 读最新栈、副作用在外面跑。
  const pastRef = useRef<HistEntry[]>([]); pastRef.current = past;
  const futureRef = useRef<HistEntry[]>([]); futureRef.current = future;
  const [over, setOver] = useState<number | null>(null);
  const [overKind, setOverKind] = useState<'inst' | 'sound'>('sound'); // 拖到 pad 上的是乐器(移动/互换)还是素材(新建/替换/加片)
  const [dragSoundId, setDragSoundId] = useState<string | null>(null); // 正在拖的素材 id(波形/库共用)→ 轨内占位块按真实长度画、判重叠
  const [dragInstSlot, setDragInstSlot] = useState<number | null>(null); // 正在拖的乐器 slot → 拖单 sample 乐器进 chop 时复制其 clip / 占位块按真实小节
  const [hoverSlot, setHoverSlot] = useState<number | null>(null);
  const [, setTick] = useState(0);
  const [status, setStatus] = useState('Loading library + generation records…');
  const [sync, setSync] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle'); // 自动保存状态(替代 Save 按钮)
  const [saveErr, setSaveErr] = useState<string | null>(null); // 保存失败的真实原因(后端 500 body / 网络)——显式暴露,绝不再静默重试丢数据

  const eng = useRef<StudioEngine | null>(null);
  const ctxRef = useRef<Ctx | null>(null);
  const sessionsRef = useRef<Session[]>([]);
  const gensRef = useRef<GenView[]>([]);              // 快照口径⑦:记录当时存活的生成组 id(库删除可撤)
  const quantizeRef = useRef<Quantize>(propQuantize); // 快照口径⑥:量化粒度(项目级标量)读最新值
  // §16 口径⑦:undo/redo 只允许"重删"曾经真删过的 id(restore-only + 这个白名单)→ 撤回到很早的快照时绝不误删之后生成的声音/组。
  const trashableSounds = useRef<Set<string>>(new Set());
  const trashableGens = useRef<Set<string>>(new Set());
  const genAborts = useRef<Map<string, AbortController>>(new Map()); // 生成中的 gen → 取消句柄(随时干掉)
  const loaded = useRef(false); // 加载完成前不触发自动保存
  const saving = useRef(false); // 保存锁:避免并发 flush
  const pendingSave = useRef(false); // 保存期间又有改动 → 存完再存一次
  const synced = useRef<Snapshot>({ sessions: {}, instruments: {}, clips: {} }); // 上次已落库的规范化快照,diff 的基准
  const retryTimer = useRef<ReturnType<typeof setTimeout> | null>(null); // 失败退避重试
  const dragOK = useRef(true);
  const soloRef = useRef<Set<string>>(new Set()); soloRef.current = soloIds; // §18 独奏集 authority(toggle/clear 读最新值,避免闭包旧值)
  const lastCollageEdit = useRef<Session | null>(null); // collage 拖移/调参后,松手重 bake 取最新一笔(绕开 sessionsRef 渲染滞后)
  const collageRebakeTimer = useRef<ReturnType<typeof setTimeout> | null>(null); // per-片 mixer 拖动:防抖重 bake(MixerStrip 无 onEnd)
  const buildSeq = useRef<Record<string, number>>({}); // per-乐器 build 单调号:异步 build 完成后若已被更晚一次编辑/重载取代 → 丢弃旧结果,别用过期 buffer 覆盖引擎(防"画面新声音旧";对标旧 useLoopMachine 的 seqRef)
  ctxRef.current = ctx; sessionsRef.current = sessions; gensRef.current = gens; quantizeRef.current = quantize;

  const loadInstrumentToEngine = useCallback(async (inst: Instrument, seamless = false, arm = true) => {
    const c = ctxRef.current, e = eng.current; if (!c || !e) return;
    const myV = (buildSeq.current[inst.id] = (buildSeq.current[inst.id] ?? 0) + 1); // 本次 build 代号:完成后据此判废,后发先至的旧 build 不再盖回引擎
    setBuilding((b) => ({ ...b, [inst.id]: true })); // ⑩ 入场/重建中;无缝重建(已有 peaks)不显遮罩,只锁全新乐器
    try {
      const buf = await buildBuffer(inst, c.bpm, c.soundsById);
      if (buildSeq.current[inst.id] !== myV) return; // 被更晚一次操作取代 → 丢弃这次(旧)build,不动引擎/peaks
      if (!buf) { e.clearInstrument(inst.id); setPeaks((p) => { const q = { ...p }; delete q[inst.id]; return q; }); return; }
      if (seamless && e.hasVoice(inst.id)) {
        e.swapBuffer(inst.id, buf, instrumentBars(inst)); // 在播时:下一个小节边界无缝接管,不断声
      } else if (!seamless) {
        e.loadInstrument(inst.id, buf, instrumentBars(inst), inst.mixer, inst.sends);
        // arm 且该乐器属于「正在出声的块」→ 即时量化起声;否则只记意图(setWantOn),到换场边界由 swapVoicesAt 按 wantOn 起。
        // §20:Song 钉住查看非播放块时编辑/填充/加片一件 enabled 乐器,会走 arm=true 这条全量重载 —— 若直接 setEnabled 会把
        //   非出声块的乐器凭空点响(声音泄漏)。startPlayback 的 loadSession 即便落到 setWantOn 也无碍:随后 startTransport 按 wantOn 全量起声。
        const soundingNow = playModeRef.current !== 'song' || sessionIdxRef.current === playingIdxRef.current;
        if (arm && soundingNow) e.setEnabled(inst.id, inst.enabled); // 活动场景:走带在跑时即量化起声
        else e.setWantOn(inst.id, inst.enabled);      // §20 预载非活动场景 / 查看非播放块:只记意图,到换场边界再起
      }
      // seamless 但该乐器不在引擎(Song 模式查看非播放场景时编辑它)→ 只重算下方波形、**不建 voice / 不出声**;
      // 该块真正播到时由 loadSession(Additive) 以最新数据建出。否则会在别的块播放途中把这件乐器凭空点响(声音泄漏 + 违反 §20 常驻口径)。
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
      if (buildSeq.current[inst.id] !== myV) return; // peaks 计算又经一次 await(decodeAsset);仍可能被取代 → 别写旧波形
      setPeaks((p) => ({ ...p, [inst.id]: peaks }));
    } finally {
      if (buildSeq.current[inst.id] === myV) setBuilding((b) => { if (!b[inst.id]) return b; const q = { ...b }; delete q[inst.id]; return q; }); // 只有最新一次 build 负责收掉 building 遮罩,免被作废的旧调用提前清掉
    }
  }, []);
  const loadSession = useCallback(async (s: Session) => {
    eng.current?.clearAll();
    // 各乐器**并行**warp/装载(原为逐件 await:换场要等所有 buffer 串行渲完才排边界 → 冷场叠加后常错过下一小节边界,听感=换场延迟)。
    // 单个乐器解码失败(如源文件缺失)不拖垮整场 —— 自己 catch 跳过,其余照常。
    await Promise.all(s.instruments.map((inst) =>
      loadInstrumentToEngine(inst).catch((e) => console.warn('Failed to load instrument, skipping:', inst.id, e))));
  }, [loadInstrumentToEngine]);
  // §20 并存预载:把目标场景的 voice 装进引擎但**不清当前场**(arm=false → 只记意图,到换场边界再起);Live 量化换场 + Song 块 lookahead 共用。并行装载同上。
  const loadSessionAdditive = useCallback(async (s: Session, arm = false) => {
    await Promise.all(s.instruments.map((inst) =>
      loadInstrumentToEngine(inst, false, arm).catch((e) => console.warn('Preload skip:', inst.id, e))));
  }, [loadInstrumentToEngine]);
  // §20 查看(不播放)某场景时:确保其 pad 波形有数据 —— 只解码 + 算峰值填进 peaks/lanePeaksCache,**不碰引擎**(不建 voice、不出声)。
  const ensurePeaksForView = useCallback(async (s: Session | undefined) => {
    if (!s) return;
    for (const inst of s.instruments) {
      try {
        if (inst.payload.kind === 'sample') {
          const cl = inst.payload.clip;
          const d = await decodeAsset(cl.assetId);
          const pk = peaksFromRegion(d.channels, cl.startSample, cl.endSample);
          setPeaks((p) => (p[inst.id] ? p : { ...p, [inst.id]: pk })); // 已加载过的更准 → 不覆盖
        } else {
          for (const cc of inst.payload.clips) { const k = pieceKey(cc); if (cc.assetId && !lanePeaksCache.has(k)) { const d = await decodeAsset(cc.assetId); lanePeaksCache.set(k, peaksFromRegion(d.channels, cc.startSample, cc.endSample)); } }
          setTick((t) => t + 1); // collage pad 走 lanePeaksCache,填好触发重渲
        }
      } catch { /* 源缺失:跳过该乐器波形 */ }
    }
  }, []);

  const refreshGens = useCallback(async () => { setGens(await loadGens(projectId)); }, [projectId]);
  // 库重载(删除/恢复/生成后):重拉声音库 + 生成列表(软删项被路由过滤掉,恢复的重新出现)。
  const reloadLibrary = useCallback(async () => {
    const sb = await loadLibrary();
    if (ctxRef.current) { ctxRef.current = { ...ctxRef.current, soundsById: sb }; setCtx(ctxRef.current); }
    await refreshGens();
  }, [refreshGens]);

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
          sessions = (saved as Session[]).map((s) => ({ ...s, xyAuto: normalizeXyAuto(s.xyAuto) })); // §26.v2 归一:老单形状 {program,...} → map;脏→null
          restored = true;
        }
        if (!alive) return;
        const c: Ctx = { soundsById, bpm: masterBpm, beatsPerBar };
        eng.current = new StudioEngine();
        eng.current.init(c.bpm, c.beatsPerBar);
        // 离散态(voice queued→on/stopping→off、预览 queued→playing 等异步边界跃迁)→ 重渲一次父树,
        // 让"呼吸 className / 编辑器布尔"跟上。连续视觉(电平/播放头/走带位置)由自驱动叶子负责,不靠这里。
        eng.current.onChange = () => setTick((t) => t + 1);
        eng.current.setQuantize(propQuantize); // 初始量化粒度(顶栏 Quantize 选择器)
        eng.current.setFx(fxRef.current);      // 初始主总线效果器(§17)
        ctxRef.current = c;
        setCtx(c); setGens(g); setSessions(sessions);
        await loadSession(sessions[0]);
        // 只有从库里恢复出来的会话才能进 diff 基准。空工程兜底的 emptySessions() 还没落库 ——
        // 若也记进基准,后续 inst.add 会引用一个 DB 里不存在的 sessionId,被 /api/studio/ops 静默丢弃
        // (返回 200 却 0 落库,UI 还显示"Saved"),于是新工程的 pad 永远存不进去。
        // 故未恢复时基准留空 → 首次保存自带 sess.add,会话随乐器一起建。
        synced.current = restored ? normalize(sessions) : { sessions: {}, instruments: {}, clips: {} };
        loaded.current = true; // 之后任何 setSessions 才触发自动保存
        // 后台预热其余场景的 warp/decode 缓存(只暖数据缓存,不在引擎里建 voice → 不违反 §20 常驻口径)。
        // 首切某场景时 buildBuffer 直接命中缓存 → 边界不被冷渲(网络 warpRender + signalsmith)拖过头 = 换场不延迟。best-effort,失败静默。
        (async () => { for (let i = 1; i < sessions.length && alive; i++) for (const inst of sessions[i].instruments) { if (!alive) return; try { await buildBuffer(inst, c.bpm, c.soundsById); } catch { /* 暖缓存失败不影响播放 */ } } })();
        setStatus(restored ? 'Loaded · drag a sample into an empty slot / hover a slot to add an instrument · ⌘Z · changes auto-save' : 'Empty stage · generate or pick a sample on the left, drag it into a slot = sample instrument · hover a slot to add a slice instrument · changes auto-save');
      } catch (err) { setStatus('Load failed: ' + conciseError(err)); }
    })();
    return () => { alive = false; eng.current?.dispose(); };
  }, [loadSession, projectId, masterBpm, beatsPerBar]);

  // 走带启停只切 playing(setState 即重渲一次);高频视觉(电平/走带位置/播放头)由自驱动叶子按 playing 起停 rAF。
  const togglePlay = () => {
    const e = eng.current; if (!e) return;
    if (e.isPlaying()) { cancelSongSchedule(); e.stopTransport(); setPendingIdx(null); setPlaying(false); }
    else startPlayback();
  };

  const curSession = sessions[sessionIdx];
  // §16 撤销宪法:快照口径 = sessions 整树 + 各库声音 warp(预调改 Sound.warp,不在 sessions 里)+ 主 bpm(项目级标量,亦在 sessions 外)。
  // sessionId 可显式指定(undo/redo 时让对侧快照携带"改动归属的 session",见 undo/redo);默认 = 当前活动 session。
  const snapshot = (sessionId?: string): HistEntry => {
    const warps = new Map<string, unknown>();
    const sb = ctxRef.current?.soundsById; if (sb) for (const [id, snd] of sb) warps.set(id, snd.warp);
    return {
      sessions: sessionsRef.current, warps, bpm: ctxRef.current?.bpm ?? masterBpm, fx: fxRef.current,
      sessionId: sessionId ?? sessionsRef.current[sessionIdx]?.id ?? '',
      quantize: quantizeRef.current,
      liveSounds: new Set(sb ? sb.keys() : []),            // 当时存活(未软删)的库声音 id 全集(含 stem)
      liveGens: new Set(gensRef.current.map((g) => g.id)), // 当时存活的生成组 id
    };
  };
  const pushHistory = () => { const next = [...pastRef.current.slice(-49), snapshot()]; pastRef.current = next; setPast(next); futureRef.current = []; setFuture([]); };
  const updateSession = (next: Session) => setSessions((ss) => ss.map((s, i) => (i === sessionIdx ? next : s)));
  const mutate = (fn: (s: Session) => Session) => { pushHistory(); updateSession(fn(sessionsRef.current[sessionIdx])); };
  const reconcile = useCallback(async (ss: Session[], idx: number) => { await loadSession(ss[idx]); setTick((t) => t + 1); }, [loadSession]);
  // 还原一格:sessions + 只把 warp 变了的库声音改回(+ 反向 patch;其余不碰,免误删之后生成的)+ 校验选中(还在就留→看见 snap back)+ 重灌引擎。
  const applyEntry = (entry: HistEntry) => {
    eng.current?.stopAudition();
    cancelSongSchedule(); setPendingIdx(null); // §20:undo/redo 前撤销 Song 待推进 + 清排队态(口径外瞬态)
    clearSolo(); // §18:solo 瞬态、不在快照口径;undo/redo 重灌引擎前先清掉,避免对不上已被还原/重建的乐器
    xyManual.current.down = false; xyClearRef.current++; eng.current?.xyReleaseAll(); // §21.v2:XY 手势瞬态(对标 solo),undo/redo 释放全部效果 + 复位 coordinator(清 latch/glide),免残留 wet
    setSessions(entry.sessions);
    // §16 口径⑤:undo/redo 跳回改动归属的 session(否则改动在别的 session 时 ⌘Z 表现为"毫无反应")。
    const found = entry.sessions.findIndex((s) => s.id === entry.sessionId);
    const idx = found >= 0 ? found : sessionIdx;
    if (idx !== sessionIdx) { eng.current?.stopTransport(); setPlaying(false); setSessionIdx(idx); }
    const c = ctxRef.current;
    if (c) {
      let changed = false; const sounds = new Map(c.soundsById);
      for (const [id, warp] of entry.warps) {
        const cur = sounds.get(id);
        if (cur && JSON.stringify(cur.warp ?? null) !== JSON.stringify(warp ?? null)) { sounds.set(id, { ...cur, warp }); api.sounds.patch(id, { warp: warp ?? null }).catch(() => {}); changed = true; }
      }
      // §16 口径③:bpm 不同则还原 —— transport 立即跟随 + 反向持久化;ctxRef.bpm 在 reconcile 前置好,重灌时按还原后的 bpm re-warp。
      const bpmChanged = entry.bpm !== c.bpm;
      if (bpmChanged) { eng.current?.setBpm(entry.bpm); api.projects.update(projectId, { masterBpm: entry.bpm }).catch(() => {}); }
      if (changed || bpmChanged) { ctxRef.current = { ...c, soundsById: sounds, bpm: entry.bpm }; setCtx(ctxRef.current); }
    }
    // §17 口径④:主总线效果器不同则还原 —— 引擎 setFx + state(浮层跟随)+ 反向持久化。
    // ⚠ 不同步直改 fxRef:让它随 render 更新(同 sessions 口径)。否则 undo 往 future 压的 snapshot() 延迟求值时会读到"还原后"的 fx,redo 抓不到切换态(bpm 因 reconcile 需要才同步改 ctxRef,fx 无此需求)。
    if (JSON.stringify(entry.fx) !== JSON.stringify(fxRef.current)) {
      setFx(entry.fx); eng.current?.setFx(entry.fx);
      api.projects.update(projectId, { fx: entry.fx }).catch(() => {});
    }
    // §16 口径⑥:量化粒度(项目级标量)不同则还原 —— 引擎 + state + 反向持久化。
    if (entry.quantize !== quantizeRef.current) { setQuantizeState(entry.quantize); eng.current?.setQuantize(entry.quantize); api.projects.update(projectId, { quantize: entry.quantize }).catch(() => {}); }
    // §16 口径⑦:库软删可撤 —— 把声音/生成组的 trashed 状态对齐到快照。
    //   恢复:快照里存活、现在没了 → un-trash(undo 一次删除)。restore-only 永远安全。
    //   重删:现在存活、快照里没有,且该 id 曾真删过(在 trashable 白名单)→ re-trash(redo 一次删除)。
    //   ⚠ 不做对称差集:撤回到很早的快照时,之后生成的声音不在快照里但也不在白名单 → 绝不误删(沿用 §16"不误删之后生成的")。
    const curSounds = new Set(ctxRef.current?.soundsById.keys() ?? []);
    const curGens = new Set(gensRef.current.map((g) => g.id));
    const libOps: Promise<unknown>[] = [];
    for (const id of entry.liveSounds) if (!curSounds.has(id)) libOps.push(api.sounds.patch(id, { trashed: false }).catch(() => {}));
    for (const id of curSounds) if (!entry.liveSounds.has(id) && trashableSounds.current.has(id)) libOps.push(api.sounds.patch(id, { trashed: true }).catch(() => {}));
    for (const id of entry.liveGens) if (!curGens.has(id)) libOps.push(api.gens.patch(id, { trashed: false }).catch(() => {}));
    for (const id of curGens) if (!entry.liveGens.has(id) && trashableGens.current.has(id)) libOps.push(api.gens.patch(id, { trashed: true }).catch(() => {}));
    const insts = entry.sessions[idx]?.instruments ?? [];
    setSelId((cur) => (cur && insts.some((i) => i.id === cur) ? cur : null));
    setSelClipId((cur) => (cur && insts.some((i) => i.payload.kind === 'collage' && i.payload.clips.some((k) => k.id === cur)) ? cur : null));
    reconcile(entry.sessions, idx);
    // 库有增删 → 等服务端 trashed 落定后重载库,再 reconcile 一次(此时恢复的声音才回到 soundsById,引用它的乐器才能重建出声)。
    if (libOps.length) Promise.all(libOps).then(() => reloadLibrary()).then(() => reconcile(sessionsRef.current, idx)).catch(() => {});
  };
  // §16:把一条快照的「数据口径」(不含活动 sessionId —— 那只决定 undo 跳回哪个 session,不算数据变化)序列化成稳定串,
  //   用于丢弃「空 undo 步」:还原它在数据上等同当前态的条目(纯点旋钮/把值拖回原位留下的无变化条目)。撤销它用户什么也看不到 → 透明跳过。
  //   只可能因 JSON 键序差异把真·空步「多保留」(退化回原行为,安全);绝不会把真改动误判为空(两状态全部 6 项数据相等才判等)。
  const histDataKey = (h: HistEntry): string => {
    const warps: string[] = [];
    for (const k of [...h.warps.keys()].sort()) warps.push(k + '=' + JSON.stringify(h.warps.get(k) ?? null));
    return JSON.stringify(h.sessions) + '' + h.bpm + '' + JSON.stringify(h.fx) + '' + h.quantize +
      '' + warps.join(',') + '' + [...h.liveSounds].sort().join(',') + '' + [...h.liveGens].sort().join(',');
  };
  // 对侧快照携带"改动归属 session"(prev/nx.sessionId)而非当前活动 session → redo/undo 都能跳回改动现场(否则切过 session 后 redo 会跳错)。
  const undo = () => { // §20 起播异步窗口内忽略 ⌘Z:applyEntry→loadSession 会与起播重灌交错混场
    if (starting.current) return;
    let p = pastRef.current; if (!p.length) return;
    const liveKey = histDataKey(snapshot());                                     // 丢弃栈顶的空步(还原它=当前数据,撤了无变化);空步不改数据 → liveKey 在丢弃过程中恒定
    while (p.length && histDataKey(p[p.length - 1]) === liveKey) p = p.slice(0, -1);
    if (!p.length) { pastRef.current = p; setPast(p); return; }                   // 全是空步:清掉即可,无可见撤销
    const prev = p[p.length - 1];
    const nf = [snapshot(prev.sessionId), ...futureRef.current]; futureRef.current = nf; setFuture(nf);
    const np = p.slice(0, -1); pastRef.current = np; setPast(np);
    applyEntry(prev);
  };
  const redo = () => {
    if (starting.current) return;
    let f = futureRef.current; if (!f.length) return;
    const liveKey = histDataKey(snapshot());                                     // 对称:丢弃 future 头部的空步(redo 它=当前数据,无变化)
    while (f.length && histDataKey(f[0]) === liveKey) f = f.slice(1);
    if (!f.length) { futureRef.current = f; setFuture(f); return; }
    const nx = f[0];
    const np = [...pastRef.current, snapshot(nx.sessionId)]; pastRef.current = np; setPast(np);
    const nf = f.slice(1); futureRef.current = nf; setFuture(nf);
    applyEntry(nx);
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (confirmState) return; // 弹窗开着时,快捷键交给弹窗(Enter/Esc)
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return; // 含 <select>(量化下拉):聚焦时 Del/空格交给控件,别误删乐器/误触走带
      if (e.code === 'Space' || e.key === ' ') { e.preventDefault(); if (!e.repeat) togglePlay(); return; } // 空格 = 走带启停;挡掉列表/页面滚动 + 按钮的空格触发
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
      // §26 Song 块 / §26.9 Live 卡:session 卡片获得焦点(点击/Tab)→ Del/⌫ 删 · ⌘C/⌘V 复制粘贴 · ⌘D 复制,作用于该 session。两模式同款热键(Live 去掉了 ⧉/✕ 按钮)。
      // 让位乐器级靠**选择态**消歧(不靠 DOM 焦点是否从卡片移走 —— pad 是不可聚焦 div,跨浏览器行为不一):有乐器/片/库选中就不当 session 操作。点卡片会清掉 selId/selClipId/libSel,故点卡=session、点 pad=乐器。
      const sblk = t?.closest?.('.sblock, .scard') as HTMLElement | null;
      if (sblk && !selId && !selClipId && !libSel) {
        const sidx = sessionsRef.current.findIndex((x) => x.id === sblk.getAttribute('data-sid'));
        if (sidx >= 0) {
          if ((e.key === 'Delete' || e.key === 'Backspace') && !e.metaKey && !e.ctrlKey) { e.preventDefault(); requestRemoveSession(sidx); return; }
          if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'c' && !window.getSelection()?.toString()) { e.preventDefault(); copySession(sidx); return; }
          if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'v' && sessionClipRef.current) { e.preventDefault(); pasteSession(); return; }
          if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'd') { e.preventDefault(); duplicateSession(sidx); return; }
        }
      }
      // §23 ⌘C 复制选中乐器(无文本选区时才劫持,否则交给浏览器复制文本);⌘V 粘贴到 hover 的空 slot(无则首个空位)。
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'c' && (markedIds.size || selId) && !window.getSelection()?.toString()) { e.preventDefault(); copySelection(); return; }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'v' && clipboardRef.current?.length) { e.preventDefault(); pasteClipboard(hoverSlot ?? undefined); return; }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'd') { // ⌘D:选中片 → 复制 collage 片;否则选中乐器 → 就地复制乐器(挡掉浏览器收藏夹)
        const inst = selId ? findInst(sessionsRef.current[sessionIdx], selId) : null;
        if (selClipId && inst?.payload.kind === 'collage') { e.preventDefault(); duplicateCollagePiece(selId!, selClipId); return; }
        if (inst) { e.preventDefault(); duplicateInstInPlace(inst.id); return; }
      }
      if ((e.key === 'Delete' || e.key === 'Backspace') && !e.metaKey && !e.ctrlKey) {
        if (libSel) { e.preventDefault(); requestRemoveSound(libSel); return; } // 选中库素材 → 软删(弹确认)
        if (selClipId && selId) { e.preventDefault(); removeCollagePiece(selId, selClipId); } // 选中片 → 删该 collage 片
        else if (selId) { e.preventDefault(); requestRemoveInst(selId); } // 否则删选中乐器(弹确认)
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });
  useEffect(() => { const clear = () => { setDragSoundId(null); setDragInstSlot(null); }; window.addEventListener('dragend', clear); return () => window.removeEventListener('dragend', clear); }, []); // 拖拽结束(落下/取消)→ 清掉"正在拖的素材/乐器"

  // §20 Song 线性:撤销待推进的 scheduleOnce(切歌/停播/undo 前)。
  const cancelSongSchedule = () => {
    if (songSchedId.current != null) { eng.current?.clearSched(songSchedId.current); songSchedId.current = null; }
    if (liveSwapSchedId.current != null) { eng.current?.clearSched(liveSwapSchedId.current); liveSwapSchedId.current = null; } // 一并撤销待触发的 Live 换场
    swapGen.current++; // 作废还在 load 中的换场 .then(stop/undo/换模式时不让它过后再排边界)
  };

  // §20 量化换场(走带在跑时):预载目标场景(arm=false)→ 下一量化边界停旧场起新场(保相位)+ 翻 UI + 清旧场 voice。after 给 Song 中途跳块复用。
  const armSwap = (idx: number, after?: (atBar: number) => void) => {
    const e = eng.current; if (!e) return;
    const cur = sessionsRef.current[sessionIdx];
    const target = sessionsRef.current[idx];
    if (!cur || !target) return;
    const gen = ++swapGen.current; // 本次换场代号
    if (liveSwapSchedId.current != null) { e.clearSched(liveSwapSchedId.current); liveSwapSchedId.current = null; } // 撤销上一次还排在边界、没触发的换场(连点换场不让两场同时起声)
    setPendingIdx(idx); clearSolo();
    loadSessionAdditive(target, false).then(() => {
      if (!eng.current || swapGen.current !== gen) return; // 已被更晚一次换场取代(连点)→ 丢弃,别再排边界
      const stopIds = cur.instruments.map((i) => i.id);
      const startIds = target.instruments.map((i) => i.id);
      liveSwapSchedId.current = e.swapAtBoundary((time) => {
        liveSwapSchedId.current = null;
        e.swapAndRelease(stopIds, startIds, time); // 边界:停旧起新(保相位)+ 过了边界再释放旧场(§14/§20);同步释放会切早旧场尾音=换场静音
        e.retainOnly([...stopIds, ...startIds]); // §20 内存:连切被作废的中间目标场会留下 armed 残渣 → 提交时即收掉(只留旧场[待 80ms 优雅释放]+新场);残渣从未出声,立即 dispose 安全
        setSessionIdx(idx); setPendingIdx(null); setSelId(null); setSelClipId(null); setLibSel(null); setTick((t) => t + 1);
        after?.(e.currentBar());
      });
    });
  };

  // §20 Song 线性:进入 id=blockId 的块(其声音已在响),预载下一块(lookahead)并排好"块末推进"。
  // ⚠ 用 session **id** 而非下标定位:Song 播放途中若拖动重排 / 删除别的场景卡,下标会漂移 → 旧实现会在边界 swap 到错的场景
  //   (停错、起错 → 残留场叠加 / 听到的不是该响的)。按 id 在边界**实时重算**"当前块 / 下一块",对结构变动免疫。
  const enterSongBlock = (blockId: string, startBar: number) => {
    const e = eng.current; if (!e) return;
    songBlockStart.current = startBar; // 播放态:本块起始小节(高亮当前第几遍)
    cancelSongSchedule();
    const list = sessionsRef.current;
    const blockI = list.findIndex((x) => x.id === blockId);
    const s = blockI >= 0 ? list[blockI] : undefined; if (!s) return;
    const nextI = blockI + 1 < list.length ? blockI + 1 : (loopSongRef.current ? 0 : -1);
    if (nextI >= 0 && list[nextI] && list[nextI].id !== blockId) loadSessionAdditive(list[nextI], false).catch(() => {}); // 提前热下一块 buffer,边界不卡
    const len = sessionRepeats(s) * sessionBars(s);
    const endBar = startBar + len;
    songSchedId.current = e.scheduleAt(`${endBar}:0:0`, (time) => {
      const cur = sessionsRef.current;
      const fi = cur.findIndex((x) => x.id === blockId); // 当前块此刻真实下标(重排/删除后仍准;当前块被删 → -1 即停)
      const from = fi >= 0 ? cur[fi] : undefined;
      const ni = fi >= 0 ? (fi + 1 < cur.length ? fi + 1 : (loopSongRef.current ? 0 : -1)) : -1; // 下一块按当前 list 实时算
      const tgt = ni >= 0 ? cur[ni] : undefined;
      if (ni < 0 || !from || !tgt) { e.stopTransport(); setPlaying(false); setPendingIdx(null); songSchedId.current = null; setTick((t) => t + 1); return; } // 末块(不循环)/ 当前块被删 → 停
      const fromIds = from.instruments.map((i) => i.id);
      const tgtIds = tgt.instruments.map((i) => i.id);
      // §18/§20:换到不同块前清掉 solo —— solo 是按"当前出声块"的瞬态隔离,soloIds 装的是旧块乐器 id,带进新块会让新块整块被遮罩静音
      //   (新块没有任何乐器在 soloIds 里 → isAudible 全 false)。同 Live armSwap 的口径。单场循环 from===tgt 不清,solo 跨循环保留。
      if (from.id !== tgt.id) clearSolo();
      e.swapAndRelease(fromIds, tgtIds, time); // 过了边界再释放旧块,免切早尾音(单场循环时 from===tgt → 无缝重起)
      e.retainOnly([...fromIds, ...tgtIds]); // §20 内存:只留旧块(待 80ms 优雅释放)+ 新块,收掉任何残渣;下一块 lookahead 随后由 enterSongBlock 重新预载
      playingIdxRef.current = ni; setPlayingIdx(ni); setPendingIdx(null); // 播放块推进(高亮/播放头跟它);ref 同步置好,免回放 rAF 与 songBlockStart 错一帧
      if (viewFollows.current) { setSessionIdx(ni); setSelId(null); setSelClipId(null); setLibSel(null); } // 视图未被点开钉住 → 跟随;已钉住则 pad 区停在用户查看的场景
      setTick((t) => t + 1);
      enterSongBlock(tgt.id, endBar);
    });
  };

  // §20 起播(Live / Song 共用)—— 关键:起播前必须把引擎收敛到「仅当前选中场景」,否则 startTransport 会把残留的
  //   别的场景 armed voice 一起点响(多场景叠加 / 听到的不是当前选中场景)。残留来源:Song 每块预载下一块、Live 连切被作废
  //   的中间目标场;stopTransport 只停 player、不清 voice/不动 wantOn,故残留一直在。
  //   两种收敛方式:① 当前场已在引擎(Live 常态)→ retainOnly 瞬时剔残留(保 solo、不重建);
  //               ② 当前场不在引擎(Song 必走;或 Live 从 Song 钉住视图切回 —— 钉住时只 ensurePeaksForView 没建 voice)
  //                  → loadSession 重灌(clearAll + 只装当前场,buffer 命中缓存故快),否则 retainOnly 会把引擎清空 = 静音。
  //   起播期间是异步窗口(loadSession),用 starting 锁挡住重入起播 + 并发 switchSession(见 switchSession),避免两次 loadSession 交错混场。
  const startPlayback = async () => {
    const e = eng.current; if (!e || starting.current) return;
    const song = playModeRef.current === 'song';
    const startIdx = song ? 0 : sessionIdx; // §26 Song:Play 永远从头(第一个 block);Live:选中场景。从具体位置起播走 startPlayFromBar(点标尺)
    const s = sessionsRef.current[startIdx]; if (!s) return;
    const ids = s.instruments.map((i) => i.id);
    starting.current = true;
    try {
      await e.resume().catch(() => {});
      cancelSongSchedule();
      const loaded = ids.some((id) => e.hasVoice(id)); // 当前场至少有一个 voice 在引擎 = 已加载(空场 ids=[] → false,走重灌兜底,clearAll 后无声可放)
      if (song || !loaded) {
        await loadSession(s); // 重灌:引擎里只剩当前场
        if (eng.current !== e) return; // 期间被卸载/重建 → 放弃
        clearSolo(); // loadSession 的 clearAll 已抹掉引擎 soloIds → 同步清 React 态(口径外瞬态,重播即复位)
      } else {
        e.retainOnly(ids); // Live 常态:当前场已在引擎 → 瞬时剔掉别场残留(保留 solo)
      }
      if (song) {
        if (sessionIdx !== startIdx) { setSessionIdx(startIdx); setSelId(null); setSelClipId(null); setLibSel(null); } // 上次跟随播放停在别块 → 从头播要把 pad 视图也带回 block 0
        e.setTransportPosition('0:0:0'); // Song 起播归零给干净播放头
        // #2 起播前先把 block-0 各 automation 效果在 bar0 设值 + 激活(refs 同步就位让 coordinator 接上不撤),否则 coordinator 落后 ~1 帧 + 激活斜坡 = 头一拍漏覆盖
        viewFollows.current = true; playingIdxRef.current = startIdx; playingRef.current = true; songBlockStart.current = 0;
        if (s.xyAuto) {
          for (const program of PROG_ORDER) { const a = s.xyAuto[program]; if (a && a.x.length && a.y.length) { const v = sampleXY(program, a, 0); e.xySetValue(program, v.x, v.y); e.xySetActive(program, true); } } // §26.v3 map presence=激活(非平);平滑斜坡(非 immediate),在静音里设值+激活
          await new Promise((r) => setTimeout(r, 30)); if (eng.current !== e) return; // settle:等 prime 斜坡在静音里走完,startTransport 后音频第一拍就盖好(不漏不 click)
        }
      } // Live:不调 setTransportPosition(stopTransport 已把走带停回 0)
      e.startTransport(); setPlaying(true);
      if (song) { setPlayingIdx(startIdx); enterSongBlock(s.id, 0); } // Song 从头(block 0)起播 + 排块末推进(viewFollows/playingIdxRef 上面已置)
    } finally { starting.current = false; }
  };

  // §26.9 点标尺跳播:从全局 bar B 所在块的「该 bar 所在 repeat」起播。停 + 干净重起(可预测;复用 startPlayback 同款收敛/prime)。
  //   末推进仍排在块**真正**末尾(blockStart+reps×bars)→ 从第 rep 遍起、播完剩余遍再进下一块;播放头 rel=pos−songBlockStart=rep×bars 正好落第 rep 遍。
  const startPlayFromBar = async (B: number) => {
    const e = eng.current; if (!e || starting.current || playModeRef.current !== 'song') return;
    const list = sessionsRef.current; if (!list.length) return;
    // cumBars 定位:落在哪个块、块起始小节(=该块前累计)、块的 bars/reps。每轮先记「本块起点=acc」再判,没 break(B≥total)即停在末块且 blockStart 正确。
    let acc = 0, bi = 0, blockStart = 0, barsB = 1, repsB = 1;
    for (let i = 0; i < list.length; i++) {
      const bars = sessionBars(list[i]), reps = sessionRepeats(list[i]), len = bars * reps;
      bi = i; blockStart = acc; barsB = bars; repsB = reps;
      if (B < acc + len) break;
      acc += len;
    }
    const s = list[bi]; if (!s) return;
    const rep = Math.max(0, Math.min(repsB - 1, Math.floor(Math.max(0, B - blockStart) / barsB)));
    const repStart = blockStart + rep * barsB; // 全局走带起点(该遍起始)
    const localBar = rep * barsB;              // 块内偏移(automation prime 用)
    starting.current = true;
    try {
      await e.resume().catch(() => {});
      if (e.isPlaying()) { cancelSongSchedule(); e.stopTransport(); setPendingIdx(null); }
      cancelSongSchedule();
      await loadSession(s); if (eng.current !== e) return; // 引擎里只剩目标块
      clearSolo();
      setSessionIdx(bi); setSelId(null); setSelClipId(null); setLibSel(null);
      viewFollows.current = true; playingIdxRef.current = bi; playingRef.current = true; songBlockStart.current = blockStart;
      if (s.xyAuto) { // prime 在 localBar(不是 0):从第 rep 遍起,automation 相位对齐
        for (const program of PROG_ORDER) { const a = s.xyAuto[program]; if (a && a.x.length && a.y.length) { const v = sampleXY(program, a, localBar); e.xySetValue(program, v.x, v.y); e.xySetActive(program, true); } }
        await new Promise((r) => setTimeout(r, 30)); if (eng.current !== e) return;
      }
      e.setTransportPosition(`${repStart}:0:0`); // voice 由 startTransport 在当下相位 0 fire,与走带起点无关 → 干净
      e.startTransport(); setPlaying(true);
      setPlayingIdx(bi); enterSongBlock(s.id, blockStart); // 末推进排块真正末尾(blockStart+reps×bars)
    } finally { starting.current = false; }
  };

  // 点场景卡:走带停 → 硬切(无声可断);走带在跑 → Live=量化换场(改播放);Song=只查看(不动播放,见 §20)。
  const switchSession = (idx: number) => {
    if (starting.current) return; // §20 起播异步窗口内忽略点卡:否则并发 loadSession 与起播的重灌交错,引擎混入别的场景
    if (idx === sessionIdx && pendingIdx === null) return;
    const e = eng.current;
    if (!e || !e.isPlaying()) {
      cancelSongSchedule(); clearSolo(); e?.stopAudition(); setPendingIdx(null); setPlaying(false);
      setSessionIdx(idx); setPlayingIdx(idx); setSelId(null); setSelClipId(null); setLibSel(null);
      loadSession(sessionsRef.current[idx]).then(() => setTick((t) => t + 1));
      return;
    }
    if (playModeRef.current === 'song') {
      // Song 模式:点卡 = 只把 pad 区切到该场景查看/编辑,**不跳播放**;钉住视图(脱离跟随,直到下次起播复位)。
      viewFollows.current = false;
      setSessionIdx(idx); setSelId(null); setSelClipId(null); setLibSel(null); setTick((t) => t + 1);
      ensurePeaksForView(sessionsRef.current[idx]); // 让被查看场景的 pad 波形显示(不建 voice、不出声)
    } else armSwap(idx); // Live 模式:点卡 = 量化换场(原样)
  };

  // §20 模式切换:切模式即停播放(干净重启到新模式)。
  const changePlayMode = (m: 'live' | 'song') => {
    if (starting.current) return; // 起播异步窗口(含 §26 prime 的 30ms settle)内忽略切模式,否则 isPlaying() 还 false → 不停走带,留下不一致的块推进调度
    if (m === playModeRef.current) return;
    if (eng.current?.isPlaying()) { cancelSongSchedule(); eng.current.stopTransport(); setPendingIdx(null); setPlaying(false); }
    setPlayMode(m);
    api.projects.update(projectId, { playMode: m }).catch(() => {}); // §26 记住上次模式(乐观持久化,不进 undo)
  };
  // §20 循环整首开关(Project 列乐观持久化;v1 不进 undo)。
  const toggleLoopSong = () => { const v = !loopSongRef.current; setLoopSong(v); api.projects.update(projectId, { loopSong: v }).catch(() => {}); };
  // §26 automation UI 显隐(纯 UI 层:数据/效果回放不动,只条件渲染 lane/4选1/X-Y/标识)。Project 列乐观持久化,不进 undo。
  // ⚠ 副作用(落库)放 updater 外:updater 在 StrictMode 会双跑 → 双 PATCH。对齐 toggleLoopSong。
  const toggleAutomationUi = () => { const nv = !showAutomation; setShowAutomation(nv); api.projects.update(projectId, { showAutomation: nv }).catch(() => {}); };

  // §20 场景 CRUD —— 改 sessions 数组(口径①,免费可撤);改后按 id 保持活动场景不漂移。
  const mutateSessionsKeepActive = (next: Session[]) => {
    const curId = sessionsRef.current[sessionIdx]?.id;
    pushHistory(); setSessions(next);
    if (curId) { const ni = next.findIndex((s) => s.id === curId); if (ni >= 0 && ni !== sessionIdx) setSessionIdx(ni); }
  };
  const moveSessionTo = (from: number, to: number) => { if (from === to) return; mutateSessionsKeepActive(moveSession(sessionsRef.current, from, to)); };
  // 拖拽换位的实时 preview:拖起 → 记 id + 初始顺序;拖过别的卡 → 把被拖 id 插到那张卡的槽位(整排实时滑动让位,像已经挪过去);松手 → 落库一次。
  const sessDragStart = (id: string) => { dragIdRef.current = id; setDragId(id); const o = sessionsRef.current.map((s) => s.id); previewOrderRef.current = o; setPreviewOrder(o); };
  const sessDragOver = (overId: string) => {
    const drag = dragIdRef.current; if (!drag || overId === drag) return;
    const order = previewOrderRef.current ?? sessionsRef.current.map((s) => s.id);
    const fromPos = order.indexOf(drag), overPos = order.indexOf(overId);
    if (fromPos < 0 || overPos < 0) return;
    const next = order.filter((id) => id !== drag);
    next.splice(fromPos < overPos ? next.indexOf(overId) + 1 : next.indexOf(overId), 0, drag); // 右移=插到目标之后,左移=之前
    if (next.join('\n') !== order.join('\n')) { previewOrderRef.current = next; setPreviewOrder(next); }
  };
  const sessDragClear = () => { dragIdRef.current = null; setDragId(null); previewOrderRef.current = null; setPreviewOrder(null); };
  const sessDragCommit = () => { // 松手落库:把被拖场景从原位移到预览终位(一次 moveSession → 一条 undo)
    const drag = dragIdRef.current, order = previewOrderRef.current;
    if (drag && order) { const from = sessionsRef.current.findIndex((s) => s.id === drag); const to = order.indexOf(drag); if (from >= 0 && to >= 0 && from !== to) moveSessionTo(from, to); }
    sessDragClear();
  };
  const renameSession = (id: string, name: string) => { if (sessionsRef.current.find((x) => x.id === id)?.name === name) return; mutateSessionsKeepActive(patchSession(sessionsRef.current, id, { name })); }; // 同名(聚焦后未改就失焦)不压空 undo 步
  const setSessionRepeats = (id: string, repeats: number) => {
    const next = Math.max(1, Math.round(repeats));
    const s = sessionsRef.current.find((x) => x.id === id);
    const oldR = s ? sessionRepeats(s) : 1;
    const patch: Partial<Pick<Session, 'repeats' | 'xyAuto'>> = { repeats: next };
    if (s?.xyAuto && next !== oldR) { const r = next / oldR, set: XYAutoSet = {}; for (const p of PROG_ORDER) { const a = s.xyAuto[p]; if (a) set[p] = rescaleAuto(a, r); } patch.xyAuto = set; } // #2 改 repeat → 每条 automation 按比例缩放点重分布
    mutateSessionsKeepActive(patchSession(sessionsRef.current, id, patch));
  };
  const setSessionColor = (id: string, color: string) => { if (sessionsRef.current.find((x) => x.id === id)?.color === color) return; mutateSessionsKeepActive(patchSession(sessionsRef.current, id, { color })); }; // 选同色不压空 undo 步
  // §26.v3 Song XY 自动化:改 session.xyAuto[program]。激活=自动判定——**非平才入 map,平则删该键**(=失效);全空 → null。无显式插入/toggle:在 lane 上画即激活。history=false → 实时更新不压栈(画线拖每帧)。活动场景不变。
  const changeXyAuto = (id: string, program: XYProgram, auto: XYAutomation | null, history = false) => {
    if (history) pushHistory();
    const s = sessionsRef.current.find((x) => x.id === id);
    const set: XYAutoSet = { ...(s?.xyAuto ?? {}) };
    if (auto && isActiveAuto(program, auto)) set[program] = auto; else delete set[program]; // 拉平=回未激活=移除
    setSessions(patchSession(sessionsRef.current, id, { xyAuto: Object.keys(set).length ? set : null }));
  };

  // §26.4 单一仲裁 coordinator:唯一驱动引擎 XY 的地方(手动板退化成只写 xyManual ref)。常驻 rAF(Live 也跑,处理手动 + 接管)。
  // per-effect 优先级 手动 > 自动化 > 旁路;松手:spring 在 springMs 内交还滑回「地面」(自动线当前值 / 无则 NEUTRAL→旁路),latch 冻结在松手值。
  useEffect(() => {
    let raf = 0;
    type Src = 'manual' | 'auto' | 'glide' | 'latch' | 'bypass';
    const rt: Record<string, { prev: Src; t0: number; fx: number; fy: number }> = {};
    for (const p of PROG_ORDER) rt[p] = { prev: 'bypass', t0: 0, fx: 0.5, fy: 0 };
    let lastClear = xyClearRef.current;
    const tick = (now: number) => {
      const e = eng.current;
      if (e) {
        const cfg = fxRef.current.xy, m = xyManual.current;
        if (xyClearRef.current !== lastClear) { lastClear = xyClearRef.current; for (const p of PROG_ORDER) rt[p].prev = 'bypass'; } // 复位请求(关板/卸载/undo):清 latch/glide,下面按 手动/自动化/旁路 重判
        const songMode = playingRef.current && playModeRef.current === 'song';
        const block = (cfg.on && songMode) ? sessionsRef.current[playingIdxRef.current] : null;
        const set = block?.xyAuto ?? null;
        const localBar = songMode ? Math.max(0, e.songPosBars() - songBlockStart.current) : 0;
        for (const program of PROG_ORDER) {
          const st = rt[program];
          if (!cfg.on) { e.xySetActive(program, false); st.prev = 'bypass'; continue; }
          if (!playingRef.current && !(m.down && m.program === program)) { e.xySetActive(program, false); st.prev = 'bypass'; continue; } // 停播且非手动 → 旁路:清掉 latch/glide,否则按停后 latch 效果永远卡 wet(stopTransport 不碰 XY)
          const auto = set?.[program];
          const autoOn = !!(auto && auto.x.length && auto.y.length); // §26.v3 map presence=激活(非平,changeXyAuto/normalize 守门),热路径不重算 isActiveAuto
          const ground = (): { x: number; y: number } => (autoOn ? sampleXY(program, auto!, localBar) : { x: NEUTRAL[program].x, y: NEUTRAL[program].y });
          if (m.down && m.program === program) { // ① 手动接管该效果
            e.xySetValue(program, m.x, m.y); e.xySetActive(program, true); // 平滑斜坡(20ms):biquad 滤波器快变会 click,一律慢变
            st.prev = 'manual'; st.fx = m.x; st.fy = m.y; continue;
          }
          if (st.prev === 'manual') { if (cfg.mode === 'latch') st.prev = 'latch'; else { st.prev = 'glide'; st.t0 = now; } } // 刚松手 → latch 冻结 / spring 起滑
          if (st.prev === 'latch') { e.xySetValue(program, st.fx, st.fy); e.xySetActive(program, true); continue; }
          if (st.prev === 'glide') { // 交还滑行:手位 → 地面值
            const e01 = Math.min(1, (now - st.t0) / Math.max(30, cfg.springMs)), k = 1 - Math.pow(1 - e01, 3), g = ground();
            e.xySetValue(program, st.fx + (g.x - st.fx) * k, st.fy + (g.y - st.fy) * k); e.xySetActive(program, true);
            if (e01 >= 1) st.prev = autoOn ? 'auto' : 'bypass';
            continue;
          }
          if (autoOn) { const { x, y } = sampleXY(program, auto!, localBar); e.xySetValue(program, x, y); e.xySetActive(program, true); st.prev = 'auto'; } // ② 自动化(平滑斜坡;起播由 prime 盖好,块边界平滑过渡不 click)
          else { e.xySetActive(program, false); st.prev = 'bypass'; } // ③ 旁路
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => { cancelAnimationFrame(raf); eng.current?.xyReleaseAll(); };
  }, []);
  const duplicateSession = (idx: number) => { const { sessions: ns } = duplicateSessionAt(sessionsRef.current, idx, nid); mutateSessionsKeepActive(ns); };
  // §26 session 剪贴板(⌘C/⌘V;同工程内,粘贴=末尾追加独立副本,乐器全新 id、引用同库素材)。
  const sessionClipRef = useRef<Session | null>(null);
  const copySession = (idx: number) => { const s = sessionsRef.current[idx]; if (s) { sessionClipRef.current = s; setStatus(`Copied session “${s.name}”`); } };
  const pasteSession = () => {
    const src = sessionClipRef.current; if (!src) return;
    const copy: Session = { ...src, id: nid('sess'), index: sessionsRef.current.length, instruments: src.instruments.map((i) => cloneInstrument(i, nid)) };
    mutateSessionsKeepActive([...sessionsRef.current, copy]); setStatus(`Pasted session “${copy.name}”`);
  };
  const addNewSession = () => {
    const color = SESSION_COLORS[sessionsRef.current.length % SESSION_COLORS.length];
    const { sessions: ns } = docAddSession(sessionsRef.current, nid, `Scene ${sessionsRef.current.length + 1}`, color);
    pushHistory(); setSessions(ns); // 新场景在末尾,活动场景不动
  };
  const removeSession = (idx: number) => {
    const list = sessionsRef.current;
    if (list.length <= 1) return; // 至少留一个场景
    const curId = list[sessionIdx]?.id;
    const ns = removeSessionAt(list, idx);
    pushHistory(); setSessions(ns);
    if (idx === sessionIdx) {
      const nextIdx = Math.min(idx, ns.length - 1);
      cancelSongSchedule(); clearSolo(); eng.current?.stopTransport(); eng.current?.stopAudition(); setPendingIdx(null); setPlaying(false);
      setSessionIdx(nextIdx); setSelId(null); setSelClipId(null); setLibSel(null);
      loadSession(ns[nextIdx]).then(() => setTick((t) => t + 1));
    } else if (curId) { const ni = ns.findIndex((s) => s.id === curId); if (ni >= 0 && ni !== sessionIdx) setSessionIdx(ni); }
  };
  const requestRemoveSession = async (idx: number) => {
    const s = sessionsRef.current[idx]; if (!s) return;
    if (sessionsRef.current.length <= 1) { setStatus('At least one session is required'); return; }
    if (await askConfirm({ title: 'Delete session', message: `Delete session "${s.name}" and its ${s.instruments.length} instrument(s)?`, confirmLabel: 'Delete', danger: true })) removeSession(idx);
  };

  // §20:查看场景是否 == 正在出声的块。Song 模式钉住查看非播放块时为 false —— 此时改播放态(enable/solo)绝不能碰引擎,
  //   否则会把预载的别块 voice 凭空点响 / 把正在播的块整块静音(违反「同时只一个块出声」)。Live 模式播放块恒 = sessionIdx。
  const viewingSoundingBlock = () => playModeRef.current !== 'song' || sessionIdx === playingIdxRef.current;

  // §18 独奏(瞬态):改集合 → 推引擎 setSolo;副作用在 setState updater 外只跑一次(同 undo 机制坑,见 §16)。
  const applySolo = (next: Set<string>) => { soloRef.current = next; setSoloIds(next); eng.current?.setSolo(next); setTick((t) => t + 1); };
  // 用户点 S:只对正在出声的块生效。Song 钉住看非播放块时忽略 —— solo 是实时监听工具,只对听得到的块有意义;
  //   若放行,setSolo 会重算全引擎 voice:把预载的该非播放块 voice 点响 + 让正在播的块(不在 soloIds 里)被遮罩静音。
  const toggleSolo = (id: string) => { if (!viewingSoundingBlock()) return; const next = new Set(soloRef.current); if (next.has(id)) next.delete(id); else next.add(id); applySolo(next); };
  const clearSolo = () => { if (soloRef.current.size) applySolo(new Set()); };

  const toggleInst = (id: string) => {
    const inst = findInst(curSession, id); if (!inst) return;
    const on = !inst.enabled;
    mutate((s) => ({ ...s, instruments: s.instruments.map((i) => (i.id === id ? { ...i, enabled: on } : i)) }));
    // §20:即时改引擎(reconcile=量化起/停)只在「查看场景 == 正在出声的块」时做。Song 模式钉住查看非播放块时,
    //   该块的 voice 可能已作为下一块 lookahead 预载进引擎(arm=false,只记 wantOn、未起声);直接 setEnabled 会
    //   reconcileVoice 把它凭空点响 = 别的场景声音泄漏(违反「同时只一个块出声」)。此时只 setWantOn 记意图(不起声),
    //   块真正播到时由 swapAndRelease 按更新后的 wantOn 起声;未预载的远块 voice 不在引擎 → setWantOn 自然 no-op,
    //   稍后该块进 lookahead 时 loadSessionAdditive 会以最新 enabled 重置 wantOn。Live 模式播放块恒 = sessionIdx,直接起停。
    if (viewingSoundingBlock()) eng.current?.setEnabled(id, on); else eng.current?.setWantOn(id, on);
    setTick((t) => t + 1);
  };
  // 真·预览(只走带停时):自由循环试听某乐器当前 warp 产物,再点停;与激活态互不影响。
  const previewInst = (id: string, startPhase?: number) => { const en = eng.current; if (!en) return; if (startPhase == null && en.auditioningId() === id) en.stopAudition(); else en.previewInstrument(id, startPhase ?? 0); setTick((t) => t + 1); }; // §28 startPhase=从起播线偏移(同 auditionSound:给了就从该相位重起,不当 toggle 关)
  // 选中乐器 = arrange 上下文(collage)/底部聚焦(sample);切到别的乐器停掉上一个预览。
  const selectInst = (id: string) => {
    eng.current?.stopAudition(); setSelId(id); setLibSel(null);
    const inst = findInst(sessionsRef.current[sessionIdx], id); // 选中切片乐器且有片 → 自动聚焦最左片(否则清空)
    const first = inst?.payload.kind === 'collage' && inst.payload.clips.length ? [...inst.payload.clips].sort((a, b) => a.startStep - b.startStep)[0].id : null;
    setSelClipId(first);
  };
  const selectPiece = (id: string) => { setSelClipId(id); if (id) setLibSel(null); }; // 点片 → 下方编辑器显示该片;清掉素材聚焦
  // 点素材 = 聚焦到它的预调(底部常驻编辑器显示);选中的是切片乐器时不清它(arrange 浮层留着,只换下方)。
  const focusSound = (id: string) => {
    setLibSel(id); setSelClipId(null);
    const cur = findInst(sessionsRef.current[sessionIdx], selId);
    if (!cur || cur.payload.kind !== 'collage') setSelId(null);
  };
  // §23 选中乐器(shift = 往多选集增删,主选中跟最后点的;普通点 = 单选 + 清多选集)。
  const clickInst = (id: string, additive: boolean) => {
    if (additive) {
      setMarkedIds((prev) => { const base = new Set(prev.size ? prev : selId ? [selId] : []); if (base.has(id)) base.delete(id); else base.add(id); return base; });
    } else setMarkedIds(new Set());
    selectInst(id); // 主选中 + 底部编辑器聚焦(切片乐器自动聚焦最左片)
  };
  // §23 copy:抓多选集(空则退化到 selId)→ 深拷贝 detach 进剪贴板(剥活引用;paste 时再 clone 拿新 id)。不进 undo(瞬态)。
  const copySelection = () => {
    const cur = sessionsRef.current[sessionIdx]; if (!cur) return;
    const ids = markedIds.size ? markedIds : selId ? new Set([selId]) : new Set<string>();
    const picked = cur.instruments.filter((i) => ids.has(i.id)).sort((a, b) => a.slot - b.slot);
    if (!picked.length) return;
    clipboardRef.current = picked.map((i) => cloneInstrument(i, nid));
    setStatus(`Copied ${picked.length} instrument${picked.length > 1 ? 's' : ''} · ⌘V to paste`);
  };
  // §23 把一批克隆落到指定空 slot(全新 id + enabled:false)→ 一次 mutate(=一步撤销)+ 持久化走 sync diff(inst.add/clip.add)。
  // 全部 loadInstrumentToEngine:克隆与源同 asset/warp 参数 → 必中 warpCache(loadInstrument 只建 voice + 取 peaks,廉价),pad 立刻显示波形且可播。
  const placeClones = (srcs: Instrument[], anchor?: number): Instrument[] => {
    const cur = sessionsRef.current[sessionIdx]; if (!cur) return [];
    const start = anchor ?? freeSlots(cur, 1)[0] ?? 0;
    const slots = freeSlots(cur, srcs.length, start);
    if (!slots.length) { setStatus('No free slots in this session'); return []; }
    const clones = srcs.slice(0, slots.length).map((it, k) => ({ ...cloneInstrument(it, nid), slot: slots[k], enabled: false }));
    pushHistory();
    updateSession({ ...cur, instruments: [...cur.instruments, ...clones] });
    setSelId(clones[0].id); setSelClipId(null); setLibSel(null); setMarkedIds(new Set(clones.map((c) => c.id)));
    clones.forEach((c) => loadInstrumentToEngine(c).then(() => setTick((t) => t + 1)));
    return clones;
  };
  const pasteClipboard = (anchor?: number) => {
    const items = clipboardRef.current; if (!items || !items.length) return;
    const clones = placeClones(items, anchor);
    if (!clones.length) return;
    const dropped = items.length - clones.length;
    setStatus(dropped > 0 ? `Pasted ${clones.length} · ${dropped} dropped (session full)` : `Pasted ${clones.length} instrument${clones.length > 1 ? 's' : ''}`);
  };
  // §23 ⌘D 就地复制选中乐器(= copy+paste 单件,落在它后面最近的空位)。
  const duplicateInstInPlace = (id: string) => {
    const cur = sessionsRef.current[sessionIdx]; if (!cur) return;
    const src = cur.instruments.find((i) => i.id === id); if (!src) return;
    const clones = placeClones([src], src.slot + 1);
    if (clones.length) setStatus(`Duplicated "${src.label}"`);
  };
  const changeMixer = (id: string, patch: Partial<Mixer>, history = false) => { if (history) pushHistory(); const next = patchMixer(sessionsRef.current[sessionIdx], id, patch); updateSession(next); const inst = findInst(next, id); if (inst) eng.current?.setMixer(id, inst.mixer); };
  // per-乐器 send 量(§17):同 changeMixer —— 拖动开始压一次 undo,值即时落树(走发件箱持久化)+ 引擎 setSends 即时跟手。sends 在 sessions 树里 → 天然可撤。
  const changeSends = (id: string, patch: Partial<InstrumentSends>, history = false) => {
    if (history) pushHistory();
    const cur = sessionsRef.current[sessionIdx];
    const next: Session = { ...cur, instruments: cur.instruments.map((i) => (i.id === id ? { ...i, sends: { ...i.sends, ...patch } } : i)) };
    updateSession(next);
    const inst = findInst(next, id); if (inst) eng.current?.setSends(id, inst.sends);
  };
  const patchInst = (id: string, patch: Partial<Instrument>) => { mutate((s) => ({ ...s, instruments: s.instruments.map((i) => (i.id === id ? { ...i, ...patch } : i)) })); setTick((t) => t + 1); };
  const removeInst = (id: string) => { eng.current?.stopAudition(); eng.current?.clearInstrument(id); if (soloRef.current.has(id)) { const next = new Set(soloRef.current); next.delete(id); applySolo(next); } setMarkedIds((m) => { if (!m.has(id)) return m; const n = new Set(m); n.delete(id); return n; }); mutate((s) => docRemove(s, id)); if (selId === id) { setSelId(null); setSelClipId(null); } setTick((t) => t + 1); };
  // 通用确认弹窗:const ok = await askConfirm({...}); if (ok) ...
  const askConfirm = (opts: ConfirmOpts) => new Promise<boolean>((resolve) => setConfirmState({ ...opts, resolve }));
  const requestRemoveInst = async (id: string) => { const inst = findInst(curSession, id); if (!inst) return; if (await askConfirm({ title: 'Delete instrument', message: `Delete "${inst.label}"?`, confirmLabel: 'Delete', danger: true })) removeInst(id); };
  // 选中库素材按 Del/Backspace → 弹确认 → 软删(可在库里恢复)。
  const requestRemoveSound = async (id: string) => { const name = ctxRef.current?.soundsById.get(id)?.name ?? 'this sample'; if (await askConfirm({ title: 'Delete sample', message: `Delete "${name}"? (soft delete, recoverable)`, confirmLabel: 'Delete', danger: true })) onDeleteSound(id); };
  const moveInstrument = (from: number, to: number) => { if (from === to) return; mutate((s) => ({ ...s, instruments: s.instruments.map((i) => (i.slot === from ? { ...i, slot: to } : i.slot === to ? { ...i, slot: from } : i)) })); setTick((t) => t + 1); };
  // 改主 BPM(§6/§12/§15/§16):压栈 → 置 ctx.bpm + 主走带 transport 跟随 → 乐观持久化 Project 列 → 当前 session 逐乐器 re-warp 热替换(在播则下一小节边界无缝接管,停时就地换)。
  // 元数据(数字)即时、音频(重渲 buffer)最终一致;别的 session 切过去时按新 bpm 自然重渲(warpToBuffer 以 bpm 为 cache key)。
  const commitBpm = (raw: number) => {
    const c = ctxRef.current, e = eng.current; if (!c || !e) return;
    const next = Math.round(Math.max(40, Math.min(240, raw)));
    if (!Number.isFinite(next) || next === c.bpm) return;
    pushHistory();                                                        // §16 铁律①:改前压栈(口径已含 bpm)
    const nc: Ctx = { ...c, bpm: next };
    ctxRef.current = nc; setCtx(nc);                                      // ctx.bpm 即新值(re-warp 读它)
    api.projects.update(projectId, { masterBpm: next }).catch(() => {});  // §15:Project 列乐观持久化
    const insts = sessionsRef.current[sessionIdx]?.instruments ?? [];
    if (e.isPlaying()) {
      // 走带在跑:协调到下一小节边界无缝换速(§6 —— transport 翻速 + 各乐器同边界保相位换 buffer;未渲完者 playbackRate 顶速过渡,就绪即换)。
      e.retempoPlaying(next, (id) => { const inst = insts.find((i) => i.id === id); return inst ? buildBuffer(inst, next, nc.soundsById) : Promise.resolve(null); });
      setStatus(`Switched to ${next} BPM`);
    } else {
      // 停时:transport 直接跟随 + 逐乐器就地换 buffer(无声可断)。
      e.setBpm(next);
      setStatus(`Master BPM → ${next} · re-rendering instruments…`);
      Promise.all(insts.map((inst) => loadInstrumentToEngine(inst, true).catch(() => {}))).then(() => { setStatus(`Switched to ${next} BPM`); setTick((t) => t + 1); });
    }
    setTick((t) => t + 1);
  };
  // 顶栏 handlers:量化(乐观持久化 Project 列)/ 节拍器 / 主音量。
  const commitQuantize = (q: Quantize) => { if (q === quantizeRef.current) return; pushHistory(); setQuantizeState(q); eng.current?.setQuantize(q); api.projects.update(projectId, { quantize: q }).catch(() => {}); }; // §16 口径⑥:改前压栈
  const commitProjName = (v: string) => { setProjName(v); api.projects.update(projectId, { name: v }).catch(() => {}); }; // §15.A:Project 列乐观持久化
  const toggleMetro = () => { const on = !metroOn; setMetroOn(on); eng.current?.setMetronome(on); };
  const changeMetroVol = (db: number) => { setMetroVol(db); eng.current?.setMetronomeVolume(db); };
  const changeMetroIv = (iv: 'beat' | 'bar' | '2bar' | '4bar') => { setMetroIv(iv); eng.current?.setMetronomeInterval(iv); };
  const changeMaster = (db: number) => { setMasterVol(db); eng.current?.setMasterVolume(db); };
  const commitFx = (next: FxConfig) => { setFx(next); eng.current?.setFx(next); }; // §17:即时应用到引擎;持久化由下方防抖 effect

  // 解码 / analysis 拼装现在收在 ClipEditor 内部(吃 Clip + Sound 自解码),这里不再手搓 editor 状态。

  // --- 库交互(LoopManager)---
  const auditionSound = async (id: string, startPhase?: number) => {
    const c = ctxRef.current, en = eng.current; if (!c || !en) return;
    focusSound(id);
    if (startPhase == null && en.auditioningId() === id) { en.stopAudition(); setTick((t) => t + 1); return; } // §28 给了 startPhase = 从起播线重起(不当 toggle 关)
    const s = c.soundsById.get(id); if (!s) return;
    await en.resume();
    const warmT = setTimeout(() => setWarming(id), 120); // ⑥ 命中缓存(<120ms)直接出声、不闪 spinner
    try {
      const buf = await warpToBuffer(s, c.bpm, regionFromClip(soundToClip(s))); // 走种子 Clip(含 timeMul),与建乐器后一致
      en.audition(id, buf, undefined, en.isPlaying(), (startPhase ?? 0) * buf.duration); // §28 startPhase→从起播线偏移;走带在跑则量化跟随 bar
    } finally {
      clearTimeout(warmT); setWarming((w) => (w === id ? null : w));
    }
    setTick((t) => t + 1);
  };
  // --- 生成参数:BPM 单向透传 + key/偏好记忆(§4.1)---
  // 主 BPM 变化(commitBpm / undo 还原等任何来源)→ 单向覆盖生成 BPM 一次。
  // 用 ref 跳过首帧 hydrate:load 时保留上次持久化的生成 BPM,不被首个 ctx.bpm 覆盖。
  const prevBpmRef = useRef<number | null>(null);
  useEffect(() => {
    const b = ctx?.bpm;
    if (b == null) return;
    if (prevBpmRef.current != null && prevBpmRef.current !== b) setGbpm(b);
    prevBpmRef.current = b;
  }, [ctx?.bpm]);
  // 偏好乐观持久化(跟 commitBpm 的 masterBpm 同套路:直写 Project 列,不进发件箱;失败静默)。
  const prefsHydrated = useRef(false);
  useEffect(() => {
    if (!prefsHydrated.current) { prefsHydrated.current = true; return; } // 首帧是 load 进来的值,不回写
    const prefs: GenPrefs = { mode: gmode, loop: gloop, bpm: gbpm };
    api.projects.update(projectId, { genPrefs: prefs }).catch(() => {});
  }, [projectId, gmode, gloop, gbpm]);
  // 主总线效果器:改即乐观持久化 Project.fx(防抖 300ms,合并连续拖旋钮;§15.A/§17)。引擎应用走 commitFx 即时。
  const fxHydrated = useRef(false);
  useEffect(() => {
    if (!fxHydrated.current) { fxHydrated.current = true; return; } // 首帧是 load 进来的值,不回写
    const t = setTimeout(() => api.projects.update(projectId, { fx }).catch(() => {}), 300);
    return () => clearTimeout(t);
  }, [projectId, fx]);
  const onGenBpm = (n: number) => { if (Number.isFinite(n)) setGbpm(n); };
  const onGenKey = (k: string) => { setGkey(k); api.projects.update(projectId, { masterKey: k || null }).catch(() => {}); }; // 即写工程调

  // 库卡波形:gens 变化时,懒解码每条变体/分轨的 region 峰值(decodeAsset + lanePeaksCache 都已缓存,重跑廉价),非阻塞填进 libPeaks。
  useEffect(() => {
    let alive = true;
    (async () => {
      const sb = ctxRef.current?.soundsById; if (!sb) return;
      const ids: string[] = [];
      for (const g of gens) for (const s of g.sounds) { ids.push(s.id); for (const st of s.stems ?? []) ids.push(st.id); }
      for (const id of ids) {
        const snd = sb.get(id); if (!snd?.assetId) continue;
        const r = regionFromSound(snd);
        const key = `${snd.assetId}:${Math.round(r.startSample)}:${Math.round(r.endSample)}`;
        let pk = lanePeaksCache.get(key);
        if (!pk) {
          try { const d = await decodeAsset(snd.assetId); if (!alive) return; pk = peaksFromRegion(d.channels, r.startSample, r.endSample, 72); lanePeaksCache.set(key, pk); } catch { continue; }
        }
        if (!alive) return;
        setLibPeaks((m) => (m[id] === pk ? m : { ...m, [id]: pk! }));
      }
    })();
    return () => { alive = false; };
  }, [gens, ctx?.soundsById]); // soundsById 也作触发:生成/分轨重载库后(新 sound 才进 map)立刻补算波形,不再要刷新

  const genHooks = useCallback((): GenHooks => ({
    appear: (g) => setGens((gs) => [g, ...gs]),
    patch: (gid, p) => setGens((gs) => gs.map((g) => (g.id === gid ? { ...g, ...p } : g))),
    reload: async () => { const sb = await loadLibrary(); if (ctxRef.current) { ctxRef.current.soundsById = sb; setCtx({ ...ctxRef.current }); } await refreshGens(); setStatus('Generated → library'); },
    register: (gid, ctrl) => genAborts.current.set(gid, ctrl),
    release: (gid) => genAborts.current.delete(gid),
  }), [refreshGens]);
  const onGenerate = () => {
    setStatus('Generating… (needs the Suno plugin + a logged-in suno.com tab)');
    generateToLibrary(projectId, gp, { mode: gmode, loop: gloop, bpm: gbpm, key: gkey }, ctx?.bpm ?? masterBpm, genHooks())
      .catch((e) => setStatus('Generate failed: ' + conciseError(e)));
  };
  // §27 本地样本上传:每个文件各起一条 upload job(uploading→detecting→入库),复用 genHooks。
  const onUpload = (files: FileList) => {
    if (!files?.length) return;
    setStatus(files.length > 1 ? `Uploading ${files.length} files…` : 'Uploading…');
    for (const f of Array.from(files)) {
      uploadToLibrary(projectId, f, genHooks()).catch((e) => setStatus('Upload failed: ' + conciseError(e)));
    }
  };
  const onRetryGen = (id: string) => {
    const g = gens.find((x) => x.id === id); if (!g) return;
    setStatus('Retrying…');
    retryGen(id, { projectId, mode: g.mode === 'advanced' ? 'advanced' : 'sound', prompt: g.prompt, bpm: g.bpm ?? ctx?.bpm ?? masterBpm, key: g.musicalKey ?? '', loop: g.loop ?? true }, genHooks())
      .catch((e) => setStatus('Retry failed: ' + conciseError(e)));
  };
  // 取消生成中的整组:中止管线 → 乐观干掉卡片 → 软删整组(连带中途已落库的半成品变体)。
  // 是瞬态「干掉」而非库删除,不进 undo(此刻基本没成形内容)。
  const onCancelGen = async (id: string) => {
    genAborts.current.get(id)?.abort();
    genAborts.current.delete(id);
    setGens((gs) => gs.filter((x) => x.id !== id)); // 乐观移除整组
    setStatus('Generation canceled');
    try { await api.gens.remove(id); } catch (e) { setStatus('Cancel failed: ' + conciseError(e)); }
    await reloadLibrary();
  };
  const onDeleteGen = async (id: string) => {
    // §16 口径⑦:删前压栈(此刻 gen 及其声音仍存活 → 快照记得住,可被 undo 恢复);把整组的 id 登记进 trashable 白名单 → 允许 redo 重删。
    pushHistory();
    const g = gensRef.current.find((x) => x.id === id);
    if (g) for (const s of g.sounds) { trashableSounds.current.add(s.id); for (const st of s.stems ?? []) trashableSounds.current.add(st.id); }
    trashableGens.current.add(id);
    setGens((gs) => gs.filter((x) => x.id !== id)); // 乐观移除整组
    try { await api.gens.remove(id); } catch (e) { setStatus('Delete failed: ' + conciseError(e)); }
    await reloadLibrary();
  };
  const onDeleteSound = async (id: string) => {
    try { await api.sounds.remove(id); } catch (e) { setStatus('Delete failed: ' + conciseError(e)); return; }
    pushHistory(); // §16 口径⑦:软删成功后压栈(client 尚未重载,快照里该声音仍存活 → 可恢复);登记 trashable → 允许 redo 重删
    trashableSounds.current.add(id);
    if (libSel === id) setLibSel(null);
    await reloadLibrary();
  };
  // 乐观标记分离状态:id 可能是顶层变体,也可能是嵌套的 drums 子轨(§29 二段拆)→ 递归找
  const setStemStatus = (id: string, st: string) => {
    const upd = (s: LoopView): LoopView =>
      s.id === id ? { ...s, stemStatus: st } : s.stems ? { ...s, stems: s.stems.map(upd) } : s;
    setGens((gs) => gs.map((g) => ({ ...g, sounds: g.sounds.map(upd) })));
  };
  const separateSound = async (id: string) => {
    setStemStatus(id, 'separating'); // 乐观:点了立刻显示「分离中」loading 态(路由同步,跑完才返回)
    setStatus('Separating… (local Demucs)');
    try {
      const res = await api.sounds.separate(id);
      if (!res.ok) throw new Error(res.error || 'Separate failed');
      await reloadLibrary(); setStatus('Separated'); // 重拉库:新 stem 进 soundsById,懒解码效应才能算出波形(只 refreshGens 的话 stem 不在库里 → 空波形,要刷新)
    } catch (e) {
      setStatus('Separate failed: ' + conciseError(e));
      try { await refreshGens(); } catch { /* ignore */ } // DB 已标 failed → 卡上「分离失败 · 点重试」
      setStemStatus(id, 'failed'); // 兜底:确保卡上出失败态(即使 refresh 没拿到)
    }
  };

  // --- 操场:加乐器 / 拖入 / hover ---
  const sampleInstFrom = (s: ApiSound, slot: number): Instrument => {
    return { id: nid('inst'), slot, label: s.name, color: '#c2724f', mixer: defaultMixer(), sends: defaultSends(), enabled: false, payload: { kind: 'sample', clip: { ...soundToClip(s), id: nid('clip') } } };
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
    const inst: Instrument = { id: nid(kind), slot, label: kind === 'sample' ? '(empty sample)' : 'Slice instrument', color: kind === 'collage' ? '#9a7bc0' : '#6a86a0', mixer: defaultMixer(), sends: defaultSends(), enabled: false, payload };
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
        if (!(await askConfirm({ title: 'Replace sample', message: `Replace the sample in instrument "${inst.label}" with "${s.name}"?`, confirmLabel: 'Replace' }))) return;
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
    const inst0 = findInst(cur, instId); // 兜底:bars 永远夹到「到下一片的空档」内,不论编辑器是否已 clamp(防重叠铁律)
    const bars = inst0?.payload.kind === 'collage' ? Math.min(clip.bars, roomAt(collageDocView(inst0.payload), clip.startStep, clip.id) / inst0.payload.stepsPerBar) : clip.bars;
    const next = patchCollageClip(cur, instId, clip.id, { startSample: clip.startSample, endSample: clip.endSample, bars, timeMul: clip.timeMul, semitones: clip.semitones, fadeOutBars: clip.fadeOutBars, fadeSilenceBars: clip.fadeSilenceBars, gainDb: clip.gainDb });
    updateSession(next);
    const inst = findInst(next, instId); if (inst) loadInstrumentToEngine(inst, true);
    const en = eng.current, c = ctxRef.current; // 片在试听中(按 clip.id)→ 不停就边界无缝换上新 region,沿用片自己的 gain/eq/pan(从 patch 后的片取,保留 eq)
    if (en?.auditioningId() === clip.id && c) {
      const s = c.soundsById.get(clip.soundId);
      const piece = inst?.payload.kind === 'collage' ? inst.payload.clips.find((x) => x.id === clip.id) : undefined;
      if (s && piece) { const buf = await warpToBuffer(s, c.bpm, regionFromClip(clip)); en.auditionSwap(clip.id, buf, { mixer: clipMixer(piece) }); }
    }
  };
  // collage 片预览:单独 warp 这片的区(自由循环,不挂主走带);不过整 collage,但带上片自己的 gain/eq/pan,听感对齐离线 bake。
  const previewCollagePiece = async (clip: CollageClip, startPhase?: number) => {
    const e = eng.current, c = ctxRef.current; if (!e || !c) return;
    if (startPhase == null && e.auditioningId() === clip.id) { e.stopAudition(); setTick((t) => t + 1); return; } // §28 同 auditionSound
    const s = c.soundsById.get(clip.soundId); if (!s) return;
    await e.resume();
    const buf = await warpToBuffer(s, c.bpm, regionFromClip(clip));
    e.audition(clip.id, buf, { mixer: clipMixer(clip) }, false, (startPhase ?? 0) * buf.duration); setTick((t) => t + 1);
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
  const moveCollagePiece = (instId: string, clipId: string, startStep: number) => { // 拖移(cross-into-gaps:可跨邻居落到最近空位;实时改位,松手才重 bake);startStep 已 snap
    const inst = findInst(sessionsRef.current[sessionIdx], instId); if (!inst || inst.payload.kind !== 'collage') return;
    writeCollagePayload(instId, placeNear(collageDocView(inst.payload), clipId, startStep).items as CollageClip[]);
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
  const dropInstOnCollageLane = (targetInstId: string, fromSlot: number, startStep: number) => { // 拖单 sample 乐器进 chop → 复制其 clip 成一片(独立副本,保留 warp/trim/调/timeMul;乐器 mixer 不随,跟拖库素材一致)
    const cur = sessionsRef.current[sessionIdx];
    const src = cur.instruments.find((i) => i.slot === fromSlot);
    if (!src || src.payload.kind !== 'sample' || src.payload.clip.soundId === '') return; // 只接非空单 sample 乐器(chop/空格不复制)
    const target = findInst(cur, targetInstId); if (!target || target.payload.kind !== 'collage') return;
    eng.current?.stopAudition(); // 落到轨即提交 → 停掉松散的预览
    const piece: CollageClip = { ...src.payload.clip, id: nid('k'), startStep }; // 覆盖源 clip id → 独立副本(共享 asset 字节)
    const placed = placeItem(collageDocView(target.payload), piece);
    if (placed.items.length === target.payload.clips.length) return; // 位置被占,没放进去
    pushHistory();
    const ns = writeCollagePayload(targetInstId, placed.items as CollageClip[]);
    setSelClipId(piece.id);
    const u = findInst(ns, targetInstId); if (u) loadInstrumentToEngine(u).then(() => setTick((t) => t + 1));
  };
  // per-片 mixer(gain/pan/eq):值即时落树(滑杆跟手),重 bake 防抖(MixerStrip 无 onEnd;collage 无 live 节点,改 mix 必重 bake)。
  const setCollagePieceMixer = (instId: string, clipId: string, patch: Partial<Mixer>, history?: boolean) => {
    if (history) pushHistory();
    const next = patchCollageClip(sessionsRef.current[sessionIdx], instId, clipId, mixerToClipPatch(patch));
    updateSession(next);
    const en = eng.current; // 该片正在预览 → 实时刷预览链的 gain/eq/pan,拖旋钮跟手(同乐器 MixerStrip 的 live 口径)
    if (en?.auditioningId() === clipId) { const inst = findInst(next, instId); const piece = inst?.payload.kind === 'collage' ? inst.payload.clips.find((x) => x.id === clipId) : undefined; if (piece) en.setAuditionMix(clipMixer(piece)); }
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
  // 把片在 desiredStart 克隆一份(新 id = 独立副本,共享 asset);插入后用 placeNear 落到最近空位。返回副本 id。
  const insertCollageCopy = (instId: string, srcId: string, desiredStart: number): { ns: Session; newId: string } | null => {
    const inst = findInst(sessionsRef.current[sessionIdx], instId); if (!inst || inst.payload.kind !== 'collage') return null;
    const src = inst.payload.clips.find((c) => c.id === srcId); if (!src) return null;
    const newId = nid('k');
    const view = collageDocView(inst.payload);
    const withCopy = { ...view, items: [...view.items, { ...src, id: newId, startStep: desiredStart }] };
    const resolved = placeNear(withCopy, newId, desiredStart); // bars=1e7 → 右侧永远有空位,必落得下
    const ns = writeCollagePayload(instId, resolved.items as CollageClip[]);
    setSelClipId(newId);
    return { ns, newId };
  };
  // Cmd/Ctrl+D:复制选中片 → 紧跟其后(放得下)否则吸到最近空位;选中副本、可撤销、重 bake。
  const duplicateCollagePiece = (instId: string, clipId: string) => {
    const inst = findInst(sessionsRef.current[sessionIdx], instId); if (!inst || inst.payload.kind !== 'collage') return;
    const src = inst.payload.clips.find((c) => c.id === clipId); if (!src) return;
    const desired = src.startStep + itemLengthSteps(collageDocView(inst.payload), src);
    pushHistory();
    const r = insertCollageCopy(instId, clipId, desired); if (!r) return;
    const u = findInst(r.ns, instId); if (u) loadInstrumentToEngine(u).then(() => setTick((t) => t + 1));
  };
  // Alt 拖:拖动一开始克隆一份(原片留位,拖的是副本);pushHistory 已由 onMoveStart 压过 → 整次拖一条撤销。
  const altDuplicateForDrag = (instId: string, srcId: string, desiredStart: number): string | null => insertCollageCopy(instId, srcId, desiredStart)?.newId ?? null;

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
    const warp: SampleWarp = { startSample: clip.startSample, endSample: clip.endSample, bars: clip.bars, timeMul: clip.timeMul, semitones: clip.semitones, fadeOutBars: clip.fadeOutBars, fadeSilenceBars: clip.fadeSilenceBars, warpedBy: 'manual' };
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
        if (!r.ok) { const body = await r.text().catch(() => ''); throw new Error(`HTTP ${r.status}${body ? ` · ${body.slice(0, 300)}` : ''}`); }
        const res = await r.json().catch(() => null);
        // 后端据实回报丢弃数:若 skipped>0,说明有 op 的父 session/instrument 不在库(基准失配)——
        // 绝不能当成功推进基准,否则又变回"显示 Saved 实则没存"。当失败处理,基准不动、下次带 sess.add 重发。
        if (res && res.skipped) throw new Error(`后端丢弃了 ${res.skipped} 条改动(父 session/instrument 不在库)`);
        synced.current = target; // 这批已落库,推进基准
        if (retryTimer.current) { clearTimeout(retryTimer.current); retryTimer.current = null; }
        setSync('saved'); setSaveErr(null);
      } catch (err) {
        // 关键:别再静默吞掉失败。后端 500 的真实原因(如 Unknown column)打到 console,并经 saveErr 弹横幅 ——
        // 否则一条坏 op 会让整工程的保存永久卡死(基准不前进、每 3s 重试同一批),用户毫不知情、退出即丢全部 pad。
        const msg = err instanceof Error ? err.message : String(err);
        console.error('[studio] 保存失败,改动仍只在内存里(每 3s 重试同一批 ops):', msg, ops);
        setSync('error'); setSaveErr(msg);
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
  useEffect(() => () => { if (retryTimer.current) clearTimeout(retryTimer.current); if (collageRebakeTimer.current) clearTimeout(collageRebakeTimer.current); }, []); // 卸载清掉待跑定时器(collage 重 bake 防抖否则会在引擎已 dispose 后 setState/动引擎)
  // 离开/刷新守卫:仍有改动没落库(正在保存,或 diff 非空=被卡住的重试)→ 拦一下浏览器卸载,
  // 避免重演"退出即丢全部 pad"。注:只挡整页刷新/关标签;App Router 客户端路由跳转挡不住(那条另说)。
  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (!loaded.current) return;
      const dirty = saving.current || diff(synced.current, normalize(sessionsRef.current)).length > 0;
      if (dirty) { e.preventDefault(); e.returnValue = ''; }
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, []);

  const e = eng.current;
  // 走带位置 / 主电平 不在此处每帧取了 —— 交给 <TransportPos>/<MasterMeter> 自驱动叶子(见 ui/live.tsx)。
  const sel = curSession ? findInst(curSession, selId) : null;
  const arrangeInst = sel && sel.payload.kind === 'collage' ? sel : null; // 选中切片乐器 → arrange 浮层(与下方 clip 聚焦解耦)
  const auditioning = e?.auditioningId() ?? null;

  if (!ctx || !curSession) {
    // ① 启动:加载失败 → 文字;加载中 → 骨架屏(按真实三段布局,数据到位平滑替换)
    if (status.startsWith('Load failed')) return <main className="daw" translate="no"><div className="ed-idle">{status}</div></main>;
    return (
      <main className="daw" translate="no" aria-busy="true">
        <header className="tbar">
          {/* 左:返回 + 工程名 */}
          <div className="sg-skel" style={{ width: 28, height: 28 }} />
          <div className="sg-skel" style={{ width: 116, height: 16, marginLeft: 2 }} />
          {/* 走带 + 音乐设置 */}
          <span className="tb-sep" />
          <div className="sg-skel" style={{ width: 34, height: 30 }} />
          <div className="sg-skel" style={{ width: 62, height: 24 }} />
          <div className="sg-skel" style={{ width: 50, height: 24 }} />
          <div className="tspace" style={{ flex: 1 }} />
          {/* 右:主输出 + FX + 存档 */}
          <div className="sg-skel" style={{ width: 92, height: 16 }} />
          <span className="tb-sep" />
          <div className="sg-skel" style={{ width: 46, height: 16 }} />
          <div className="sg-skel" style={{ width: 44, height: 13, marginLeft: 2 }} />
        </header>
        <div className="daw-main">
          {/* 左栏:LoopManager 两段式 —— 生成面板块 + Library 列表 */}
          <aside className="br">
            <div style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 9, borderBottom: '1px solid var(--line)' }}>
              <div style={{ display: 'flex', gap: 6 }}>
                <div className="sg-skel" style={{ height: 26, flex: 1 }} />
                <div className="sg-skel" style={{ height: 26, width: 46 }} />
              </div>
              <div className="sg-skel" style={{ height: 60 }} />
              <div style={{ display: 'flex', gap: 6 }}>
                <div className="sg-skel" style={{ height: 30, flex: 1 }} />
                <div className="sg-skel" style={{ height: 30, width: 40 }} />
              </div>
            </div>
            <div className="br-h"><div className="sg-skel" style={{ height: 11, width: 58 }} /></div>
            <div style={{ padding: '9px 12px', display: 'flex', flexDirection: 'column', gap: 7 }}>
              <div className="sg-skel" style={{ height: 46 }} />
              <div className="sg-skel" style={{ height: 46 }} />
              <div className="sg-skel" style={{ height: 46, width: '84%' }} />
            </div>
          </aside>
          {/* 舞台:① session 轨道带(粘顶横排)→ ② pad 网格 —— 与真实 .stage 同构 */}
          <section className="stage">
            <div className="srail-sticky">
              <div className="banks srail">
                {Array.from({ length: 3 }, (_, i) => <div key={i} className="sg-skel" style={{ width: 168, height: 60, flex: '0 0 auto' }} />)}
                <div className="sg-skel" style={{ width: 30, height: 60, flex: '0 0 auto', opacity: 0.5 }} />
              </div>
            </div>
            <div className="clipgrid" style={{ gridAutoRows: 120, flexShrink: 0, gap: 0, borderRadius: 'var(--r)', overflow: 'hidden', borderTop: `1px solid ${FAINT}`, borderLeft: `1px solid ${FAINT}` }}>
              {Array.from({ length: 8 }, (_, i) => <div key={i} className="sg-skel" style={{ height: 120, borderRadius: 0, borderRight: `1px solid ${FAINT}`, borderBottom: `1px solid ${FAINT}` }} />)}
            </div>
          </section>
        </div>
        <footer className="daw-editor"><div className="ed-idle" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 9 }}><span className="sg-spin" aria-hidden="true" /><span>{status}</span></div></footer>
      </main>
    );
  }

  const slotCount = SLOTS_PER_SESSION;
  const dragSound = dragSoundId ? ctx.soundsById.get(dragSoundId) ?? null : null;
  const dragInst = dragInstSlot != null ? curSession.instruments.find((i) => i.slot === dragInstSlot) ?? null : null;
  const dragSampleInst = dragInst && dragInst.payload.kind === 'sample' && dragInst.payload.clip.soundId !== '' ? dragInst : null; // 正在拖的「非空单 sample 乐器」→ 可复制进 chop
  const canDropOnLane = !!dragSound || !!dragSampleInst; // 库素材任意可落;乐器只接 sample(chop/空格落进来无效 → 不亮提示)
  const dragBars = dragSound ? soundToClip(dragSound).bars : dragSampleInst && dragSampleInst.payload.kind === 'sample' ? dragSampleInst.payload.clip.bars : null; // 占位块按真实小节(lane 内长度锁死 = clip.bars,不含 timeMul)

  return (
    <main className="daw" translate="no">
      <header className="tbar">
        {/* 工程 */}
        <Link href="/projects" className="ic" title="Back to projects" style={{ textDecoration: 'none' }}>←</Link>
        <ProjectNameInput name={projName} onCommit={commitProjName} />

        {/* 走带 */}
        <span className="tb-sep" />
        <button className="tp" data-on={playing} onClick={togglePlay} aria-label={playing ? 'Stop' : 'Play'}><TransportIcon stop={playing} size={12} /></button>
        {/* §20 播放模式 + 循环整首:演奏态,紧挨播放键 */}
        <span className="seg sm">
          <button className={playMode === 'live' ? 'on' : ''} onClick={() => changePlayMode('live')}>Live</button>
          <button className={playMode === 'song' ? 'on' : ''} onClick={() => changePlayMode('song')}>Song</button>
        </span>
        {playMode === 'song' && (<button className="tp" data-on={loopSong} onClick={toggleLoopSong} title="Loop song" style={{ width: 30, fontSize: 13 }}>↻</button>)}
        <Metronome on={metroOn} vol={metroVol} iv={metroIv} onToggle={toggleMetro} onVol={changeMetroVol} onIv={changeMetroIv} />
        <TransportPos engine={e} playing={playing} />

        {/* 音乐设置 */}
        <span className="tb-sep" />
        <div className="tg"><TempoInput bpm={ctx.bpm} onCommit={commitBpm} /><span className="tg-u">BPM</span></div>
        <div className="tg">
          <select className="tb-qtz" value={quantize} onChange={(ev) => commitQuantize(ev.target.value as Quantize)} title="Launch quantize — the grid that starting/stopping an instrument snaps to">
            <option value="1bar">1/1</option><option value="1/2">1/2</option><option value="1/4">1/4</option><option value="off">Off</option>
          </select>
        </div>

        <div className="tspace" style={{ flex: 1 }} />

        {/* 主输出:推子 + L/R 电平表 */}
        <span className="tb-master">
          <svg className="tb-vico" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M11 5 6 9H2v6h4l5 4z" /><path d="M15.5 8.5a5 5 0 0 1 0 7" /></svg>
          <input className="tb-fader" type="range" min={-40} max={6} step={1} value={masterVol} onChange={(ev) => changeMaster(Number(ev.target.value))} title={`Volume ${masterVol > 0 ? '+' : ''}${masterVol} dB`} />
          <MasterMeter engine={e} playing={playing} />
        </span>

        {/* 主总线效果器(§17):失真 / 延迟 / 混响 */}
        <span className="tb-sep" />
        <FxRack fx={fx} bpm={ctx.bpm} onFx={commitFx} onStart={pushHistory} />

        {/* §21 XY 表演板:Kaoss 式主总线 insert(配置走 commitFx 便车;实时手势直连引擎) */}
        <XYPad
          xy={fx.xy}
          onXy={(next) => commitFx({ ...fxRef.current, xy: next })}
          onStart={pushHistory}
          onEngage={() => { xyManual.current = { ...xyManual.current, down: true, program: fxRef.current.xy.program }; }}
          onMove={(x, y) => { xyManual.current = { down: true, program: fxRef.current.xy.program, x, y }; }}
          onRelease={() => { xyManual.current = { ...xyManual.current, down: false }; }}
          onClose={() => { xyManual.current = { ...xyManual.current, down: false }; xyClearRef.current++; }}
        />

        {/* 历史 + 保存 */}
        <span className="tb-sep" />
        <button className="ic" disabled={!past.length} title="Undo (⌘Z)" onClick={undo} aria-label="Undo">↩</button>
        <button className="ic" disabled={!future.length} title="Redo (⌘⇧Z)" onClick={redo} aria-label="Redo">↪</button>
        <span className={'svc-dot ' + sync} title="Changes auto-save to the library; restored on reload">{sync === 'saving' ? 'Saving' : sync === 'error' ? '⚠ Failed' : 'Saved'}</span>
      </header>

      {sync === 'error' && (
        <div role="alert" style={{ position: 'sticky', top: 0, zIndex: 60, background: '#7f1d1d', color: '#fff', padding: '6px 12px', fontSize: 12, lineHeight: 1.45, borderBottom: '1px solid #b91c1c' }}>
          ⚠ 改动没能保存到库,正在每 3 秒重试 —— <b>现在刷新或离开会丢失未保存的 pad</b>。{saveErr ? ` 原因:${saveErr}` : ''}
        </div>
      )}

      <div className="daw-main">
        <aside className="br">
          <LoopManager
            gens={gens} selectedLoopId={libSel} previewing={auditioning != null && auditioning === libSel} warmingId={warming} peaks={libPeaks} masterBpm={ctx.bpm}
            genPrompt={gp} genMode={gmode} genLoop={gloop} genBpm={gbpm} genKey={gkey}
            onGenPrompt={setGp} onGenMode={setGmode} onGenLoop={setGloop} onGenBpm={onGenBpm} onGenKey={onGenKey}
            onGenerate={onGenerate} onUpload={onUpload} onSelect={(id) => { eng.current?.stopAudition(); focusSound(id); }} onAudition={auditionSound} onDragSound={setDragSoundId}
            onAssignNext={(id) => { const slot = (() => { let s = 0; const used = new Set(curSession.instruments.map((i) => i.slot)); while (used.has(s)) s++; return s; })(); addSampleFromSound(id, slot); }}
            onSeparate={separateSound} onRetryGen={onRetryGen} onCancelGen={onCancelGen} onDeleteGen={onDeleteGen} onDeleteSound={onDeleteSound} stemServiceUp={stemUp}
          />
        </aside>

        <section className="stage" style={{ minWidth: 0, paddingBottom: arrangeInst ? arrangeH + 24 : undefined }}>
          <div className="srail-sticky">
          {playMode === 'song' && (
            <div className="song-ctl">
              {/* §26 顶栏标题 = 当前选中 session:色块换色 + 点名改名(和块标题一致),后缀 bar 数。 */}
              <span className="song-ctl-l" style={{ display: 'flex', alignItems: 'center', gap: 6, textTransform: 'none', letterSpacing: 0, fontSize: 11, fontWeight: 500, color: 'var(--tx-2)' }}>
                <SessionColorDot color={curSession.color || SESSION_COLORS[sessionIdx % SESSION_COLORS.length]} onPick={(c) => setSessionColor(curSession.id, c)} />
                {titleRenaming ? (
                  <input autoFocus defaultValue={curSession.name}
                    onClick={(ev) => ev.stopPropagation()}
                    onBlur={(ev) => { const v = ev.target.value.trim(); if (v) renameSession(curSession.id, v); setTitleRenaming(false); }}
                    onKeyDown={(ev) => { if (ev.key === 'Enter') (ev.target as HTMLInputElement).blur(); else if (ev.key === 'Escape') setTitleRenaming(false); }} />
                ) : (
                  <span style={{ cursor: 'text' }} title="点击改名" onClick={() => setTitleRenaming(true)}>{curSession.name}</span>
                )}
                <span style={{ opacity: .55 }}>· {sessionBars(curSession)} bar</span>
              </span>
              <span style={{ flex: 1 }} />
              {/* §26.10 automation UI 显示时才出 4选1 + X/Y(隐藏时整组收起,效果照常播)。 */}
              {showAutomation && (<>
                {/* §26.v3 4 选 1:切「整个 song 当前显示/编辑哪条效果 lane」。选中=该效果色,其余=灰(未选)。不负责激活(在 lane 上画线即激活)。 */}
                <div className="song-progs" role="group" aria-label="Automation effect lane">
                  {PROG_ORDER.map((p) => {
                    const sel = autoProgram === p;
                    return <button key={p} className={'fx-chip' + (sel ? ' on' : '')} style={sel ? { background: PROG_COLOR[p], borderColor: PROG_COLOR[p], color: '#1c1b19' } : undefined} title={`编辑 ${PROG_LABEL[p]} automation`} onMouseDown={(ev) => ev.preventDefault()} onClick={() => setAutoProgram(p)}>{PROG_LABEL[p]}</button>;
                  })}
                </div>
                {/* onMouseDown preventDefault:点选后不夺焦点 → 不留浏览器 focus 圈(键盘 Tab 仍可聚焦,a11y 不丢) */}
                <div className="seg sm" role="group" aria-label="Automation axis (编辑用)">
                  <button className={autoAxis === 'x' ? 'on' : ''} onMouseDown={(ev) => ev.preventDefault()} onClick={() => setAutoAxis('x')}>X</button>
                  <button className={autoAxis === 'y' ? 'on' : ''} onMouseDown={(ev) => ev.preventDefault()} onClick={() => setAutoAxis('y')}>Y</button>
                </div>
              </>)}
              {/* §26.10 automation UI 显隐 toggle(zoom 左侧,大小同 X/Y seg)。开=显示中(高亮)。纯 UI 层,不动效果。 */}
              <button className={'song-auto-tg' + (showAutomation ? ' on' : '')} onMouseDown={(ev) => ev.preventDefault()} onClick={toggleAutomationUi} aria-pressed={showAutomation} title={showAutomation ? '隐藏 automation 界面(效果照常播)' : '显示 automation 界面'}>
                <svg width="14" height="10" viewBox="0 0 14 10" fill="none" aria-hidden="true"><polyline points="1,8 5,4 8,2.5 13,5.5" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" strokeLinecap="round" /><circle cx="8" cy="2.5" r="1.4" fill="currentColor" /></svg>
              </button>
              <span className="song-ctl-z" title="Zoom (px per bar)">
                <span className="song-ctl-zl">zoom</span>
                <input type="range" min={20} max={56} step={1} value={songZoom} onChange={(ev) => setSongZoom(Number(ev.target.value))} />
              </span>
            </div>
          )}
          <RailScroll song={playMode === 'song'} zoom={songZoom} onZoom={setSongZoom} sessions={sessions} selectedIdx={sessionIdx} engine={e} playing={playing} playingIdx={playingIdx} blockTransportStart={songBlockStart.current} onSeekBar={startPlayFromBar}>
            <div className={'banks srail' + (playMode === 'song' ? ' song' : '')}>
              {sessions.map((s, i) => {
                const chips = s.instruments.slice(0, 6);
                const more = s.instruments.length - chips.length;
                const cur = i === sessionIdx; // 选中/查看中(白描边 + 下方 pad 区显示它)
                const playHere = playing && (playMode === 'song' ? i === playingIdx : cur); // 正在出声的块:Song=playingIdx、Live=当前场景 → 高亮 + 播放头跟它(与「查看」解耦)
                const n = sessionRepeats(s);
                const bars = sessionBars(s);
                const sc = s.color || SESSION_COLORS[i % SESSION_COLORS.length]; // per-session 上色:Live 卡 + Song 块共用(§26.9 设计一致);播放态不变色,只看播放头线
                // §26.9 对齐 Song 块设计:色点(换色) + 名字(选中点名改名) + 右端 bar 数;无 ⧉/✕ 按钮 → 走热键(Del/⌫ 删 · ⌘D 复制 · ⌘C/⌘V,见 onKey)。
                const head = (
                  <div className="sc-h">
                    <SessionColorDot color={sc} onPick={(c) => setSessionColor(s.id, c)} />
                    {renamingId === s.id ? (
                      <input className="tb-proj-in" autoFocus defaultValue={s.name} style={{ flex: 1, minWidth: 0, height: 20 }} onClick={(ev) => ev.stopPropagation()}
                        onBlur={(ev) => { const v = ev.target.value.trim(); if (v) renameSession(s.id, v); setRenamingId(null); }}
                        onKeyDown={(ev) => { if (ev.key === 'Enter') (ev.target as HTMLInputElement).blur(); else if (ev.key === 'Escape') setRenamingId(null); }} />
                    ) : (
                      // 选中(当前)态再点名字 = 改名;未选中时点名走卡片 onClick 切场景
                      <span className="sc-nm" style={{ cursor: cur ? 'text' : 'pointer' }} title={cur ? '点击改名' : s.name} onClick={(ev) => { if (cur) { ev.stopPropagation(); setRenamingId(s.id); } }}>{s.name}</span>
                    )}
                    <span className="sc-bars">{bars}b</span>
                  </div>
                );
                const chipsRow = (
                  <div className="sc-chips">
                    {chips.map((inst) => (<span key={inst.id} className="sc-chip" style={{ background: inst.color || 'rgba(236,233,227,.4)' }} />))}
                    {more > 0 && <span className="sc-more">+{more}</span>}
                  </div>
                );
                const meta = <div className="sc-meta">{s.instruments.length} inst</div>;
                // 拖拽换位(HTML5 DnD,自有数据类型不撞 pad/素材);改名时禁拖,让输入框正常用。被拖卡压暗当占位,整排靠 flex order 实时让位。
                const dndCls = (s.id === dragId ? ' dragging' : '');
                const cardOrder = previewOrder ? previewOrder.indexOf(s.id) : i; // 拖拽中按预览顺序;否则原序
                const sessDnd = {
                  draggable: renamingId !== s.id,
                  onDragStart: (ev: React.DragEvent) => { ev.dataTransfer.setData('application/x-session-idx', s.id); ev.dataTransfer.effectAllowed = 'move'; sessDragStart(s.id); },
                  onDragOver: (ev: React.DragEvent) => { if (!ev.dataTransfer.types.includes('application/x-session-idx')) return; ev.preventDefault(); ev.dataTransfer.dropEffect = 'move'; sessDragOver(s.id); },
                  onDrop: (ev: React.DragEvent) => { if (!ev.dataTransfer.types.includes('application/x-session-idx')) return; ev.preventDefault(); sessDragCommit(); },
                  onDragEnd: () => { if (dragIdRef.current) sessDragClear(); }, // 没经 drop(拖出界/Esc)→ 撤销预览,不落库
                };
                if (playMode !== 'song') {
                  return (
                    <div key={s.id} data-sid={s.id} tabIndex={0} className={'scard' + (cur ? ' on' : '') + (playHere ? ' playing' : '') + (pendingIdx === i ? ' queued' : '') + dndCls} style={{ order: cardOrder, '--c': sc } as React.CSSProperties} onClick={() => switchSession(i)} title={s.name} {...sessDnd}>
                      {head}{chipsRow}{meta}
                      {playHere && <SessionPlayhead engine={e} mode="live" startBar={0} barsPerRep={bars} repeats={n} playing={playing} />}
                    </div>
                  );
                }
                // §26 Song = 比例 arrange 时间轴:一个 block 整段(宽=bars×reps×zoom,内部 loop 刻度线)+ 下方内联自动化 lane。
                // 头:名字/小节竖排(左上)· 每遍序号(左下)· repeat 方角 +/−(右上,选中显)。效果/X-Y/清除在顶栏全局。
                const bw = bars * n * songZoom;
                const autoSet = s.xyAuto ?? null;             // §26.v3 该 session 的全部激活效果(map 只存非平;未触碰=不存=隐含中性平直线·非激活)
                const auto = autoSet?.[autoProgram] ?? defaultAutomation(autoProgram, bars * n); // §26.v3 当前显示那条;没有 → 可编辑的中性平直线(画即激活)
                return (
                  <div key={s.id} data-sid={s.id} tabIndex={0} className={'sblock' + (cur ? ' sblk-sel' : '') + (playHere ? ' playing' : '') + (pendingIdx === i ? ' queued' : '') + dndCls} style={{ order: cardOrder, width: bw, '--c': sc } as React.CSSProperties} title={s.name} onClick={() => switchSession(i)}>
                    {/* 名字条:名字置顶(过窄截断)+ 右端 Xb;兼拖拽换位手柄。无删/复制按钮 → 键盘:Del/⌫ 删 · ⌘C/⌘V 复制粘贴 · ⌘D 复制(Win=Ctrl,见 onKey)。 */}
                    <div className="sblk-name" {...sessDnd}>
                      <SessionColorDot color={sc} onPick={(c) => setSessionColor(s.id, c)} />
                      {renamingId === s.id ? (
                        <input className="tb-proj-in" autoFocus defaultValue={s.name} onClick={(ev) => ev.stopPropagation()}
                          onBlur={(ev) => { const v = ev.target.value.trim(); if (v) renameSession(s.id, v); setRenamingId(null); }}
                          onKeyDown={(ev) => { if (ev.key === 'Enter') (ev.target as HTMLInputElement).blur(); else if (ev.key === 'Escape') setRenamingId(null); }} />
                      ) : (
                        <span className="sblk-nm" style={{ cursor: cur ? 'text' : 'pointer' }} title={cur ? '点击改名' : s.name} onClick={(ev) => { if (cur) { ev.stopPropagation(); setRenamingId(s.id); } }}>{s.name}</span>
                      )}
                      {/* §26.v3 纯标识(不可点):该 session 已激活(线非平=在 map)的效果各显一个单字母色块,只表「这块挂了哪些效果」。选哪条编辑去顶栏 4 选 1。§26.10:automation UI 隐藏时一并收起。 */}
                      {showAutomation && autoSet && PROG_ORDER.filter((p) => autoSet[p]).map((p) => (
                        <span key={p} className="sblk-achip" title={`${PROG_LABEL[p]} automation`}
                          style={{ background: PROG_COLOR[p], borderColor: PROG_COLOR[p], color: '#1c1b19' }}>
                          {PROG_LABEL[p][0]}
                        </span>
                      ))}
                      <span className="sblk-bars">{bars}b</span>
                    </div>
                    {/* 数字条:repeat 一格 + 数字(各格左上);末格右侧 +/−(仅选中)。与 automation 条等高。 */}
                    <div className="sblk-nums">
                      {Array.from({ length: n }, (_, k) => (<span key={'rn' + k} className="sblk-rn" style={{ left: k * bars * songZoom + 4 }}>{k + 1}</span>))}
                      {Array.from({ length: n - 1 }, (_, k) => (<span key={'t' + k} className="sblk-tick" style={{ left: (k + 1) * bars * songZoom }} aria-hidden="true" />))}
                      {cur && (
                        <span className="sblk-reps" onClick={(ev) => ev.stopPropagation()} onMouseDown={(ev) => ev.preventDefault()}>{/* onMouseDown preventDefault:点 +/− 不夺焦点 → 空格起停后不会在按钮上残留 focus 圈 */}
                          {n > 1
                            ? <><button onClick={(ev) => { ev.stopPropagation(); setSessionRepeats(s.id, n + 1); }} title="Add repeat">+</button><button onClick={(ev) => { ev.stopPropagation(); setSessionRepeats(s.id, n - 1); }} title="Remove repeat">−</button></>
                            : <button onClick={(ev) => { ev.stopPropagation(); setSessionRepeats(s.id, n + 1); }} title="Add repeat">+</button>}
                        </span>
                      )}
                    </div>
                    {/* §26.v3 lane 显示顶栏 4 选 1 选中的效果(autoProgram)那条,永远可编辑(选中块):没触碰过=中性平直线,照样能画;画成非平即激活(changeXyAuto 入 map)。§26.10:automation UI 隐藏时整条 lane 收起,block 变矮(效果仍在播)。 */}
                    {showAutomation && (
                      <div className="sblock-auto">
                        <AutomationLane auto={auto} program={autoProgram} axis={autoAxis} bars={bars} reps={n} px={songZoom} editable={cur} onStart={pushHistory} onChange={(a) => changeXyAuto(s.id, autoProgram, a)} />
                      </div>
                    )}
                    {/* §26.9 song 播放头改列级单条(SongTimeline 渲,穿标尺+块);此处不再画块内 head。 */}
                  </div>
                );
              })}
              <button className="sadd" onClick={addNewSession} title="New session">＋</button>
            </div>
          </RailScroll>
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
                return (
                  <div key={slot} className={'clip empty' + (over === slot ? ' over' : '')} style={{ minHeight: 0, borderRadius: 0, borderWidth: '0 1px 1px 0', borderStyle: 'solid', borderColor: FAINT }} onMouseEnter={() => setHoverSlot(slot)} onMouseLeave={() => setHoverSlot((h) => (h === slot ? null : h))} onClick={() => { eng.current?.stopAudition(); setSelId(null); setSelClipId(null); setMarkedIds(new Set()); }} {...dnd}>
                    <span className="cidx">{slot + 1}</span>
                    {over === slot ? (
                        <div style={{ margin: 'auto', padding: '6px 12px', border: '1px dashed var(--acc)', borderRadius: 'var(--r)', color: 'var(--acc)', fontSize: 11, fontWeight: 500, background: 'var(--acc-dim)' }}>
                          {overKind === 'inst' ? 'Move here' : 'Drop here · new instrument'}
                        </div>
                      ) : hoverSlot === slot ? (
                        <div style={{ position: 'absolute', top: 6, right: 6, display: 'flex', gap: 4 }}>
                          <button className="addinst" onClick={(ev) => { ev.stopPropagation(); addEmptyAt(slot, 'sample'); }} title="Add an empty sample instrument, then drag a sample in to fill it">＋sample</button>
                          <button className="addinst" onClick={(ev) => { ev.stopPropagation(); addEmptyAt(slot, 'collage'); }} title="Add a slice instrument, drag multiple samples in to arrange">＋slice</button>
                        </div>
                      ) : null}
                  </div>
                );
              }
              const color = inst.color ?? 'var(--acc)';
              const st = e?.voiceState(inst.id) ?? 'off'; // 仅用于 queued/stopping 呼吸 className(走带边界跃迁经 onChange 重渲)
              const isSel = inst.id === selId;
              const isMarked = markedIds.has(inst.id); // §23 shift 多选集成员(copy 目标)
              const pk = peaks[inst.id];
              // chop pad 波形签名:各片峰值是否已在 lanePeaksCache(懒解码异步填)。从 '0…' 变 '1…' 时打破 CollagePadBody 的 memo,reload 后峰值到位即重画(否则 payload 不变 → memo 跳过 → 只剩色块)。
              const padPeaksSig = inst.payload.kind === 'collage' ? inst.payload.clips.map((c) => (lanePeaksCache.has(pieceKey(c)) ? '1' : '0')).join('') : '';
              const isEmpty = inst.payload.kind === 'sample' && inst.payload.clip.soundId === '';
              const isBuilding = !!building[inst.id] && !(pk && pk.length > 0); // ⑩ 全新乐器(从未就绪)首建中 → 压暗 + 锁 ▶;已有 peaks 的无缝重建不算
              const isSoloed = soloIds.has(inst.id);                 // §18:本乐器被独奏
              const soloDimmed = soloIds.size > 0 && !isSoloed;       // §18:有别的乐器独奏中 → 本 pad 被静音 → 压暗
              return (
                <div key={slot} draggable onMouseDownCapture={() => { dragOK.current = true; }} onDragStart={(ev) => { if (!dragOK.current) { ev.preventDefault(); return; } ev.dataTransfer.setData('application/x-inst-slot', String(slot)); ev.dataTransfer.effectAllowed = 'move'; setDragInstSlot(slot); }} style={{ position: 'relative', minHeight: 0, borderRadius: 0, borderWidth: '0 1px 1px 0', borderStyle: 'solid', borderColor: FAINT, background: over === slot ? 'var(--acc-dim)' : undefined }} {...dnd}>
                  <div className={`clip filled ${inst.enabled ? 'st-playing' : ''}${playing && (st === 'queued' || st === 'stopping') ? (st === 'queued' ? ' st-queued' : ' st-stopping') : ''}${isSoloed ? ' solo-on' : soloDimmed ? ' solo-off' : ''}`} style={{ ...cvar(color), position: 'absolute', inset: 6, minHeight: 0, borderRadius: 'var(--r)', borderColor: isSel ? `color-mix(in srgb, ${color} 75%, #fff)` : undefined, boxShadow: isMarked && !isSel ? `inset 0 0 0 2px color-mix(in srgb, ${color} 70%, #fff)` : undefined }} onClick={(ev) => clickInst(inst.id, ev.shiftKey)}>
                    {inst.payload.kind === 'collage'
                      ? <>{/* 底块/波形/网格 memo 静态;播放头独立自驱动叶子 */}<CollagePadBody payload={inst.payload} peaksSig={padPeaksSig} /><CollageHead engine={e} id={inst.id} playing={playing} /></>
                      : (pk && pk.length > 0 && (
                        <SampleWave engine={e} id={inst.id} peaks={pk} color={color} playing={playing} />
                      ))}
                    <button className="launch" disabled={isBuilding} onMouseDown={() => { dragOK.current = false; }} onClick={(ev) => { ev.stopPropagation(); if (!isBuilding) toggleInst(inst.id); }} title={isBuilding ? 'Loading…' : 'Toggle playback'}
                      style={{ position: 'relative', overflow: 'hidden', background: `color-mix(in srgb, ${color} ${inst.enabled ? 20 : 12}%, transparent)`, fontSize: 10, cursor: isBuilding ? 'default' : 'pointer' }}>
                      <LaunchLevel engine={e} id={inst.id} color={color} playing={playing} />
                      <span style={{ position: 'relative', zIndex: 1, display: 'inline-flex', color: inst.enabled ? `color-mix(in srgb, ${color} 72%, #fff)` : `color-mix(in srgb, ${color} 52%, #39352f)` }}><TransportIcon stop={!inst.enabled} size={11} /></span>
                    </button>
                    <div className="cbody">
                      <div className="cname" style={{ display: 'flex', alignItems: 'center', gap: 5, minWidth: 0 }}>
                        {!isEmpty && <InstrumentIcon icon={inst.icon} size={15} style={{ color, flex: 'none' }} />}
                        <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', minWidth: 0 }}>{inst.label}</span>
                      </div>
                      <div className="cmeta">{isEmpty ? 'Drag a sample in' : `${inst.payload.kind} · ${instrumentBars(inst)}b`}</div>
                    </div>
                    {!isEmpty && (
                      <button className={'solobtn' + (isSoloed ? ' on' : '')} title={isSoloed ? 'Un-solo' : 'Solo (isolate this instrument)'}
                        onMouseDown={() => { dragOK.current = false; }} onClick={(ev) => { ev.stopPropagation(); toggleSolo(inst.id); }}>S</button>
                    )}
                    {isSel && !isEmpty && (() => {
                      // gain 线:选中乐器一条横线 + dB 读数(无圆点),颜色用本 pad 色(提亮)。只有抓到线那条带才调电平,空白处仍是拖拽移动;双击复位 0dB。
                      const gy = Math.max(4, Math.min(96, (1 - (inst.mixer.gainDb + 24) / 30) * 100));
                      const ln = `color-mix(in srgb, ${color} 72%, #fff)`;
                      return (
                        <>
                          <div style={{ position: 'absolute', left: 24, right: 0, top: `${gy}%`, height: 1, background: ln, zIndex: 2, pointerEvents: 'none' }} />
                          <span style={{ position: 'absolute', right: 6, top: `calc(${gy}% - 15px)`, fontSize: 10, color: ln, fontFamily: 'var(--mono)', zIndex: 2, pointerEvents: 'none' }}>{inst.mixer.gainDb}dB</span>
                          <div title="Drag to adjust gain · double-click to reset to 0 dB" onMouseDown={() => { dragOK.current = false; }}
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
                    {isBuilding && (
                      <div className="clip-building" aria-busy="true">
                        <span className="sg-spin" aria-hidden="true" />
                        <span>{inst.payload.kind === 'collage' ? 'Baking slices…' : 'Loading…'}</span>
                      </div>
                    )}
                    {over === slot && (
                      <div style={{ position: 'absolute', inset: 0, zIndex: 5, display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: 'var(--r)', border: '1px dashed var(--acc)', background: 'color-mix(in srgb, var(--acc) 24%, transparent)', color: 'var(--acc)', fontSize: 11, fontWeight: 500, pointerEvents: 'none' }}>
                        {overKind === 'inst' ? '↔ Swap' : inst.payload.kind === 'collage' ? '＋ Add slice' : 'Replace sample'}
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
            if (!s) return <EmptyEditor hint="Sample not found" />;
            return (
              <div className="ed-wrap">
                <ClipEditor key={'snd-' + libSel} clip={soundToClip(s)} sound={s} targetBpm={ctx.bpm}
                  initGridBars={gridRef.current.warp} initSnap={gridRef.current.snap} onGridChange={(warp, snap) => saveGrid({ warp, snap })}
                  onChange={(c) => editSoundRegion(libSel, c)}
                  onDragOut={(ev) => { ev.dataTransfer.setData('text/plain', libSel); ev.dataTransfer.effectAllowed = 'copy'; setDragImage(ev, s.name); setDragSoundId(libSel); }}
                  preview={{ previewing: auditioning === libSel, warming: warming === libSel, queued: !!e?.auditionQueuedFor(libSel), getPhase: () => e?.auditionPhase(libSel) ?? null, toggle: (sp?: number) => auditionSound(libSel, sp) }} />
              </div>
            );
          }
          // ② 选中单 sample 乐器 → 它的 clip(空 sample 落到空状态)
          if (sel && sel.payload.kind === 'sample') {
            const p = sel.payload;
            if (p.clip.soundId === '') return <EmptyEditor hint="Empty sample · drag one from the library into its slot" />;
            const clip = p.clip;
            const s = ctx.soundsById.get(clip.soundId);
            if (!s) return <EmptyEditor hint="Sample not found" />;
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
                <button onClick={() => toggleInst(sel.id)} title={enabled ? 'Active — plays with the transport · click to deactivate' : 'Inactive · click to activate'}
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
                initGridBars={gridRef.current.warp} initSnap={gridRef.current.snap} onGridChange={(warp, snap) => saveGrid({ warp, snap })}
                onChange={(c) => writeSampleClip(sel.id, c)} header={header}
                mixer={<MixerStrip mixer={sel.mixer} engine={e} voiceId={sel.id} playing={playing} onMixer={(patch, history) => changeMixer(sel.id, patch, !!history)} sends={sel.sends} onSends={(patch, history) => changeSends(sel.id, patch, !!history)} />}
                preview={{ previewing: sounding, getPhase: () => aud ? (e?.auditionPhase(sel.id) ?? null) : (e?.voicePhase(sel.id) ?? null), toggle: (sp?: number) => previewInst(sel.id, sp) }} />
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
                  <div className="ed-toplab"><span className="sec-l">Slice edit ({arrangeInst.label})</span><span className="muted small">{psSound.name}</span></div>
                  <ClipEditor key={selPiece.id} clip={selPiece} sound={psSound} targetBpm={ctx.bpm} canPreview={!playing}
                    initGridBars={gridRef.current.warp} initSnap={gridRef.current.snap} onGridChange={(warp, snap) => saveGrid({ warp, snap })}
                    maxBars={roomAt(collageDocView(cp), selPiece.startStep, selPiece.id) / cp.stepsPerBar}
                    mixer={<MixerStrip mixer={clipMixer(selPiece)} onMixer={(patch, history) => setCollagePieceMixer(arrangeInst.id, selPiece.id, patch, !!history)} />}
                    onChange={(c) => writeCollageClip(arrangeInst.id, { ...(c as CollageClip), id: selPiece.id, startStep: selPiece.startStep })}
                    preview={{ previewing: e?.auditioningId() === selPiece.id, getPhase: () => (e?.auditioningId() === selPiece.id ? (e?.auditionPhase(selPiece.id) ?? null) : null), toggle: (sp?: number) => previewCollagePiece(selPiece, sp) }} />
                </div>
              );
            }
            return <EmptyEditor hint="Slice instrument · click a slice in the track above to edit, or drag a sample into the track" />;
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
          <ArrangePopover onClose={close} onHeight={setArrangeH}>
            <div className="we we-compact">
              <div className="we-ctrl">
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', height: 38, padding: '0 12px', borderBottom: '1px solid var(--line)' }}>
                  <span style={{ display: 'flex', alignItems: 'center', gap: 9, fontSize: 13, color: 'var(--tx)', minWidth: 0, overflow: 'hidden' }}>
                    <InstrumentChip color={hColor} icon={inst.icon} onPick={(pp) => patchInst(inst.id, pp)} />
                    <InstrumentName label={inst.label} onCommit={(v) => patchInst(inst.id, { label: v })} />
                  </span>
                  <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <button onClick={() => toggleInst(inst.id)} title={enabled ? 'Active — plays with the transport · click to deactivate' : 'Inactive · click to activate'}
                      style={{ flex: 'none', width: 38, height: 22, borderRadius: 6, border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
                        background: enabled ? `color-mix(in srgb, ${hColor} 55%, transparent)` : 'var(--bg-3)', boxShadow: enabled ? `inset 0 0 0 1px color-mix(in srgb, ${hColor} 70%, transparent)` : 'inset 0 0 0 1px var(--line-2)' }}>
                      <span style={{ width: 9, height: 9, borderRadius: '50%', background: enabled ? '#fff' : '#6f6a60', boxShadow: enabled ? '0 0 5px rgba(255,255,255,0.9)' : 'none' }} />
                    </button>
                    <button onClick={close} title="Collapse (Esc)" style={{ flex: 'none', width: 24, height: 22, borderRadius: 6, border: '1px solid var(--line-2)', background: 'var(--bg-3)', color: 'var(--tx-2)', cursor: 'pointer', fontSize: 13, lineHeight: 1 }}>✕</button>
                  </span>
                </div>
                <div className="we-ctrl-body">
                  <MixerStrip mixer={inst.mixer} engine={e} voiceId={inst.id} playing={playing} onMixer={(patch, history) => changeMixer(inst.id, patch, !!history)} sends={inst.sends} onSends={(patch, history) => changeSends(inst.id, patch, !!history)} />
                  <div className="we-rail" style={{ padding: '10px' }}>
                    <span className="we-lab">Grid</span>
                    <div className="seg we-gseg">{COLLAGE_GRID.map((g) => (<button key={g.label} className={Math.abs(collageGrid - g.bars) < 1e-6 ? 'on' : ''} onClick={() => setArrangeGrid(g.bars)}>{g.label}</button>))}</div>
                    <span className="muted small" style={{ marginTop: 8, display: 'block', lineHeight: 1.5 }}>Drag slices · click a slice → edit below · drag samples into empty slots</span>
                  </div>
                </div>
              </div>
              <div className="we-main" style={{ position: 'relative' }}>
                <CollageEditor inst={inst} gridBars={collageGrid} selClipId={selClipId} onSelectClip={selectPiece} dragBars={dragBars} acceptDrop={canDropOnLane}
                  onMoveStart={beginCollageEdit} onMove={(cid, st) => moveCollagePiece(inst.id, cid, st)} onMoveEnd={() => rebakeCollage(inst.id)}
                  onAltDuplicate={(sid, st) => altDuplicateForDrag(inst.id, sid, st)}
                  onDropSound={(sid, st) => dropOnCollageLane(inst.id, sid, st)} onDropInst={(slot, st) => dropInstOnCollageLane(inst.id, slot, st)} onLoop={(ls, bars) => setCollageLoop(inst.id, ls, bars)}
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

/** §26 session 标题栏换色点:展示当前 session 色,点开 SESSION_COLORS 浮层换色(管理颜色)。portal 挂 body,绕开块的 overflow:hidden。 */
function SessionColorDot({ color, onPick }: { color: string; onPick: (c: string) => void }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const place = useCallback(() => { const r = btnRef.current?.getBoundingClientRect(); if (!r) return; const winW = window.innerWidth || 1280; setPos({ left: Math.max(8, Math.min(r.left, winW - 170)), top: r.bottom + 6 }); }, []);
  const toggle = (e: React.MouseEvent) => { e.stopPropagation(); place(); setOpen((o) => !o); };
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => { const t = e.target as Node; if (!btnRef.current?.contains(t) && !popRef.current?.contains(t)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDoc); document.addEventListener('keydown', onKey);
    window.addEventListener('scroll', place, true); window.addEventListener('resize', place);
    return () => { document.removeEventListener('mousedown', onDoc); document.removeEventListener('keydown', onKey); window.removeEventListener('scroll', place, true); window.removeEventListener('resize', place); };
  }, [open, place]);
  return (
    <>
      <button ref={btnRef} className="sblk-cdot" title="Session 颜色" draggable={false} onMouseDown={(e) => e.preventDefault()} onClick={toggle} style={{ background: color }} />
      {open && pos && createPortal(
        <div ref={popRef} style={{ position: 'fixed', left: pos.left, top: pos.top, zIndex: 260, background: 'var(--bg-1)', border: '1px solid var(--line-2)', borderRadius: 8, padding: 8, display: 'flex', gap: 6, boxShadow: '0 10px 28px rgba(0,0,0,0.45)' }}>
          {SESSION_COLORS.map((c) => (
            <button key={c} onClick={(e) => { e.stopPropagation(); onPick(c); setOpen(false); }} title={c} style={{ width: 20, height: 20, borderRadius: 5, cursor: 'pointer', background: c, border: c === color ? '2px solid #fff' : '1px solid var(--line-2)' }} />
          ))}
        </div>, document.body)}
    </>
  );
}

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
      <button ref={btnRef} onClick={toggle} title="Change icon / color" style={{ flex: 'none', width: size, height: size, borderRadius: 6, border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', background: `color-mix(in srgb, ${color} 30%, transparent)`, color: `color-mix(in srgb, ${color} 80%, #fff)` }}>
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
  return <span onClick={() => setEditing(true)} title="Click to rename" style={{ cursor: 'text', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', ...style }}>{label}</span>;
}

/** 顶栏节拍器:按钮 toggle 开关(开=橙),▾ 弹设置面板(音量 + 几小节响一次)。点外面关。 */
type MetroIv = 'beat' | 'bar' | '2bar' | '4bar';
function Metronome({ on, vol, iv, onToggle, onVol, onIv }: { on: boolean; vol: number; iv: MetroIv; onToggle: () => void; onVol: (db: number) => void; onIv: (iv: MetroIv) => void }) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (ev: MouseEvent) => { if (!wrapRef.current?.contains(ev.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);
  const IVS: [string, MetroIv][] = [['Beat', 'beat'], ['Bar', 'bar'], ['2 bars', '2bar'], ['4 bars', '4bar']];
  return (
    <div className="tb-metro" ref={wrapRef}>
      <button className={'metro-btn' + (on ? ' on' : '')} title={on ? 'Metronome: on (click to stop)' : 'Metronome: off (click to start)'} aria-pressed={on} onClick={onToggle}>♩</button>
      <button className="metro-caret" title="Metronome settings" aria-label="Metronome settings" onClick={() => setOpen((o) => !o)}>▾</button>
      {open && (
        <div className="metro-pop" role="dialog">
          <div className="mp-h">Metronome</div>
          <div className="mp-row"><span className="mp-l">Volume</span><input type="range" min={-30} max={0} step={1} value={vol} onChange={(ev) => onVol(Number(ev.target.value))} /></div>
          <div className="mp-row"><span className="mp-l">Interval</span><div className="seg sm mp-iv">{IVS.map(([lab, v]) => <button type="button" key={v} className={iv === v ? 'on' : ''} onClick={() => onIv(v)}>{lab}</button>)}</div></div>
        </div>
      )}
    </div>
  );
}

/** 顶栏工程名:点击改名;Enter/失焦提交,Esc 取消,空名回弹。提交走 commitProjName(乐观写 Project.name)。 */
function ProjectNameInput({ name, onCommit }: { name: string; onCommit: (v: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [val, setVal] = useState(name);
  const ref = useRef<HTMLInputElement | null>(null);
  const escRef = useRef(false); // Esc 退出时跳过 blur 的提交
  useEffect(() => { if (!editing) setVal(name); }, [name, editing]); // 非编辑态跟随真值
  useEffect(() => { if (editing) { ref.current?.focus(); ref.current?.select(); } }, [editing]);
  const commit = () => {
    setEditing(false);
    if (escRef.current) { escRef.current = false; setVal(name); return; }
    const t = val.trim();
    if (t && t !== name) onCommit(t); else setVal(name);
  };
  if (!editing) return (
    <span className="tb-proj" title={`${name} — click to rename`} role="button" tabIndex={0}
      onClick={() => setEditing(true)}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setEditing(true); } }}>{name}</span>
  );
  return (
    <input ref={ref} className="tb-proj-in" value={val} maxLength={80} aria-label="Project name"
      onChange={(e) => setVal(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); else if (e.key === 'Escape') { escRef.current = true; e.currentTarget.blur(); } }} />
  );
}

/** 顶栏主 BPM:可编辑;Enter/失焦提交,Esc 取消,↑↓ 微调(±1)。提交后真正的 clamp/re-warp/undo 在 commitBpm 里。 */
function TempoInput({ bpm, onCommit }: { bpm: number; onCommit: (v: number) => void }) {
  const [editing, setEditing] = useState(false);
  const [val, setVal] = useState(String(bpm));
  useEffect(() => { if (!editing) setVal(String(bpm)); }, [bpm, editing]); // 非编辑态跟随真值(含 undo/clamp 回弹)
  const commit = () => { setEditing(false); const n = parseInt(val, 10); if (Number.isFinite(n) && n !== bpm) onCommit(n); else setVal(String(bpm)); };
  return (
    <input className="tg-bpm" inputMode="numeric" value={val} title="Project master BPM · instruments re-warp to the new tempo after committing (Enter to commit · ↑↓ to nudge)"
      onFocus={() => setEditing(true)}
      onChange={(e) => setVal(e.target.value.replace(/[^0-9]/g, '').slice(0, 3))}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur();
        else if (e.key === 'Escape') { setVal(String(bpm)); setEditing(false); e.currentTarget.blur(); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); setVal((v) => String((parseInt(v, 10) || bpm) + 1)); }
        else if (e.key === 'ArrowDown') { e.preventDefault(); setVal((v) => String((parseInt(v, 10) || bpm) - 1)); }
      }} />
  );
}

const COLLAGE_GRID = [{ label: '1/1', bars: 1 }, { label: '1/2', bars: 0.5 }, { label: '1/4', bars: 0.25 }, { label: '1/8', bars: 0.125 }, { label: '1/16', bars: 0.0625 }];
// arrange 轨(占单 sample 壳的 main 位):网格吸附拖移(夹邻不重叠、可留白)、拖库素材进网格位、尾部 headroom 供延长。
// 选中片不在这里改 —— 点片弹出浮层 ClipEditor(在 footer 分支里渲染);片带 data-clip-id 供浮层锚定。
function CollageEditor({ inst, gridBars, selClipId, onSelectClip, onMoveStart, onMove, onMoveEnd, onAltDuplicate, onDropSound, onDropInst, onLoop, previewing, getPhase, onPreviewToggle, canPreview, dragBars, acceptDrop = true }: {
  inst: Instrument; gridBars: number; selClipId: string | null; onSelectClip: (id: string) => void;
  onMoveStart: () => void; onMove: (clipId: string, startStep: number) => void; onMoveEnd: () => void;
  onAltDuplicate?: (srcId: string, desiredStart: number) => string | null; // Alt 拖 = 复制一份再拖副本
  onDropSound: (soundId: string, startStep: number) => void;
  onDropInst?: (fromSlot: number, startStep: number) => void; // 拖单 sample 乐器进来 → 复制其 clip 成一片
  onLoop: (loopStartStep: number, bars: number) => void;
  previewing: boolean; getPhase: () => number | null; onPreviewToggle: () => void; canPreview: boolean;
  dragBars?: number | null; // 正在拖入的素材/乐器小节数 → 占位块按真实长度画、判重叠;未知则按 1 小节
  acceptDrop?: boolean;     // 当前拖的东西能不能落这条轨(乐器拖拽里只 sample 可)→ 不能则不亮占位提示
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
    const alt = e.altKey && !!onAltDuplicate; // 按住 Alt 拖 = 拖出一个副本(原片留位)
    const x0 = e.clientX; let moved = false; let dragId = id;
    const mv = (ev: PointerEvent) => {
      const want = origStart + Math.round((ev.clientX - x0) / stepPx); const snapped = Math.max(0, Math.round(want / snapSteps) * snapSteps);
      if (!moved) {
        onMoveStart(); moved = true;
        if (alt) { const nid = onAltDuplicate!(id, snapped); if (nid) { dragId = nid; return; } } // 副本已落在 snapped;本帧别再 onMove(此刻 ref 还没含副本,会覆盖掉)
      }
      onMove(dragId, snapped);
    };
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
    e.preventDefault(); // 拖滚动条时别选中页面内容
    const track = e.currentTarget as HTMLElement; const el = scrollRef.current; if (!el) return;
    const prevSel = document.body.style.userSelect; document.body.style.userSelect = 'none';
    const seek = (clientX: number) => { const r = track.getBoundingClientRect(); const frac = Math.max(0, Math.min(1, (clientX - r.left) / (r.width || 1))); el.scrollLeft = frac * Math.max(0, el.scrollWidth - el.clientWidth); };
    seek(e.clientX);
    const mv = (ev: PointerEvent) => seek(ev.clientX);
    const up = () => { document.body.style.userSelect = prevSel; window.removeEventListener('pointermove', mv); window.removeEventListener('pointerup', up); };
    window.addEventListener('pointermove', mv); window.addEventListener('pointerup', up);
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minWidth: 0, minHeight: 130, gap: 6 }}>
      <div style={{ position: 'relative', flex: 1, minWidth: 0, minHeight: 0 }}>
      <div ref={scrollRef} className="lane-scroll" style={{ overflowX: 'auto', overflowY: 'hidden', height: '100%', minWidth: 0, border: '1px solid var(--line)', borderRadius: 'var(--r)', scrollbarWidth: 'none' }}>
        <div ref={contentRef}
          onDragOver={(e) => { if (!acceptDrop) return; e.preventDefault(); if (!over) setOver(true); const st = stepFromX(e.clientX); setDropStep((p) => (p === st ? p : st)); }} onDragLeave={() => { setOver(false); setDropStep(null); }}
          onDrop={(e) => { e.preventDefault(); setOver(false); setDropStep(null); const st = stepFromX(e.clientX); const slot = e.dataTransfer.getData('application/x-inst-slot'); if (slot !== '') { onDropInst?.(Number(slot), st); return; } const id = e.dataTransfer.getData('text/plain'); if (id) onDropSound(id, st); }}
          onPointerDown={() => onSelectClip('')}
          style={{ position: 'relative', height: '100%', minHeight: 116, width: laneSteps * stepPx, minWidth: '100%', background: 'var(--bg-0)', userSelect: 'none', WebkitUserSelect: 'none',
            backgroundImage: `repeating-linear-gradient(90deg, color-mix(in srgb,${color} 24%, transparent) 0 1px, transparent 1px ${spb * stepPx}px), repeating-linear-gradient(90deg, var(--line) 0 1px, transparent 1px ${snapSteps * stepPx}px)`,
            boxShadow: over ? `inset 0 0 0 1px ${color}` : undefined }}>
          <div style={{ position: 'absolute', top: 0, bottom: 0, left: 0, width: loopStart * stepPx, background: 'rgba(0,0,0,0.34)', pointerEvents: 'none', zIndex: 3 }} />
          <div style={{ position: 'absolute', top: 0, bottom: 0, left: loopEnd * stepPx, right: 0, background: 'rgba(0,0,0,0.34)', pointerEvents: 'none', zIndex: 3 }} />
          {Array.from({ length: Math.ceil(laneSteps / spb) }, (_, b) => (<span key={b} className="muted" style={{ position: 'absolute', top: 3, left: b * spb * stepPx + 4, fontSize: 9, fontFamily: 'var(--mono)', color: 'var(--tx-3)', pointerEvents: 'none' }}>{b + 1}</span>))}
          {cp.clips.map((c) => {
            const isSel = c.id === selClipId; const pk = lanePeaksCache.get(peakKey(c)); const pcol = sliceColorFor(c.id); // 每片一色(按 id 稳定,移动不变色)
            return (
              <div key={c.id} data-clip-id={c.id} className={'lane-clip' + (isSel ? ' csel' : '')} onPointerDown={(e) => startDrag(e, c.id, c.startStep)} title={c.soundId}
                style={{ ...cvar(pcol), left: c.startStep * stepPx, width: Math.max(3, Math.round(c.bars * spb) * stepPx) }}>
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
                <span style={{ fontSize: 10, color: col, fontWeight: 500 }}>{occupied ? 'Slot occupied' : 'Drop here'}</span>
              </div>
            );
          })()}
          <div ref={playheadRef} style={{ position: 'absolute', top: 0, bottom: 0, width: 1, background: '#fff', boxShadow: '0 0 4px rgba(255,255,255,0.7)', zIndex: 6, pointerEvents: 'none', display: 'none' }} />
          {([['start', loopStart, '#7cd17c'], ['end', loopEnd, '#e8a33d']] as const).map(([edge, step, hc]) => (
            // 满高线只做视觉(pointerEvents:none),不挡下方 clip;抓手只在顶部标尺带(clip 从 top:20 起,与抓手永不重叠)
            // → 解决「拖 clip 时被 loop 起/止线抢指针」的冲突:clip body 全程可拖,loop 线从顶部三角拖。
            <div key={edge} style={{ position: 'absolute', top: 0, bottom: 0, left: step * stepPx - 4, width: 8, zIndex: 5, pointerEvents: 'none' }}>
              <div style={{ position: 'absolute', top: 0, bottom: 0, left: 3, width: 2, background: hc }} />
              <div style={{ position: 'absolute', top: 0, left: 0, width: 8, height: 8, background: hc, clipPath: 'polygon(0 0,100% 0,50% 100%)' }} />
              <div onPointerDown={(e) => dragLoop(e, edge)} title={edge === 'start' ? 'Loop start (drag)' : 'Loop end (drag)'}
                style={{ position: 'absolute', top: 0, left: -4, width: 16, height: 20, pointerEvents: 'auto', cursor: 'ew-resize' }} />
            </div>
          ))}
        </div>
      </div>
      <button onClick={() => canPreview && onPreviewToggle()} disabled={!canPreview} title={canPreview ? 'Preview collage' : 'Transport is running — no preview needed'}
        style={{ position: 'absolute', right: 8, bottom: 8, width: 26, height: 26, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 10, lineHeight: 1, border: 'none', borderRadius: 'var(--r)', zIndex: 7,
          cursor: canPreview ? 'pointer' : 'default', opacity: canPreview ? 1 : 0.35, background: previewing ? 'var(--play)' : 'var(--acc)', color: previewing ? '#23201d' : 'var(--acc-ink)' }}><TransportIcon stop={previewing} size={11} /></button>
      </div>
      <div className="we-scroll" onPointerDown={thumbDown}><div className="we-thumb" style={{ left: thumb.left + '%', width: thumb.width + '%' }} /></div>
    </div>
  );
}

type SongTimelineProps = { zoom: number; onZoom: (z: number) => void; sessions: Session[]; selectedIdx: number; engine: StudioEngine | null; playing: boolean; playingIdx: number; blockTransportStart: number; onSeekBar: (bar: number) => void; children: ReactNode };

/** §26.9 song 用滚动容器:在 HScroll 之上加 ① 滚轮平移 ② Alt 滚轮缩放(光标钉住) ③ 全局 bar 标尺(播放头穿标尺 + hover 引导线 + 喇叭点击跳播)。
 *  blocks 作 children 原样塞入(flex order 拖拽不变);标尺/播放头/引导线在同一 scroll 内容里按 cumBars 定位。 */
function SongTimeline({ zoom, onZoom, sessions, selectedIdx, engine, playing, playingIdx, blockTransportStart, onSeekBar, children }: SongTimelineProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const guideRef = useRef<HTMLDivElement>(null);
  const zoomRef = useRef(zoom); zoomRef.current = zoom;
  const zoomApply = useRef<{ contentBar: number; cx: number } | null>(null); // Alt 缩放后回正 scrollLeft(光标钉住)
  const [thumb, setThumb] = useState({ left: 0, width: 100, show: false });

  // cumBars[i]=前 i 块累计小节(数组序=视觉序);total=全曲小节;W=标尺/内容宽
  let acc = 0; const cum = sessions.map((s) => { const at = acc; acc += sessionBars(s) * sessionRepeats(s); return at; });
  const total = acc; const W = Math.max(1, total * zoom);
  // 选中 session → 标尺上对应 bar 段铺同色淡底(left/width 用 cum,与块精确对齐)
  const selS = sessions[selectedIdx];
  const selColor = selS ? (selS.color || SESSION_COLORS[selectedIdx % SESSION_COLORS.length]) : null;
  const selLeft = selS ? cum[selectedIdx] * zoom : 0;
  const selW = selS ? sessionBars(selS) * sessionRepeats(selS) * zoom : 0;

  // 自定义滚动条 thumb 同步(同 HScroll)
  useEffect(() => {
    const el = scrollRef.current; if (!el) return;
    const update = () => { const w = el.clientWidth, sw = el.scrollWidth; const width = sw > 0 ? Math.min(100, (w / sw) * 100) : 100; setThumb({ left: sw > w ? (el.scrollLeft / (sw - w)) * (100 - width) : 0, width, show: sw > w + 1 }); };
    update(); el.addEventListener('scroll', update, { passive: true });
    const ro = new ResizeObserver(update); ro.observe(el); if (el.firstElementChild) ro.observe(el.firstElementChild);
    return () => { el.removeEventListener('scroll', update); ro.disconnect(); };
  }, []);
  // 滚轮=平移;Alt+滚轮=以光标为支点缩放(原生非被动监听才能 preventDefault);照搬 CollageEditor。
  useEffect(() => {
    const el = scrollRef.current; if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (e.altKey) {
        e.preventDefault();
        const cx = e.clientX - el.getBoundingClientRect().left;
        zoomApply.current = { contentBar: (el.scrollLeft + cx) / zoomRef.current, cx };
        onZoom(Math.max(10, Math.min(72, zoomRef.current * Math.exp(-e.deltaY * 0.0015))));
      } else { const d = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY; if (d === 0) return; e.preventDefault(); el.scrollLeft += d; }
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [onZoom]);
  useEffect(() => { const el = scrollRef.current, z = zoomApply.current; if (el && z) { el.scrollLeft = Math.max(0, z.contentBar * zoom - z.cx); zoomApply.current = null; } }, [zoom]);

  const barAtX = (clientX: number) => { const el = scrollRef.current; if (!el) return 0; return Math.floor(Math.max(0, Math.min(total - 1e-6, (el.scrollLeft + clientX - el.getBoundingClientRect().left) / zoom))); };
  const onRulerMove = (e: React.PointerEvent) => { const g = guideRef.current; if (g) { g.style.display = 'block'; g.style.left = barAtX(e.clientX) * zoom + 'px'; } };
  const onRulerLeave = () => { const g = guideRef.current; if (g) g.style.display = 'none'; };
  const thumbDown = (e: React.PointerEvent) => {
    e.preventDefault();
    const track = e.currentTarget as HTMLElement; const el = scrollRef.current; if (!el) return;
    const prevSel = document.body.style.userSelect; document.body.style.userSelect = 'none';
    const seek = (clientX: number) => { const r = track.getBoundingClientRect(); el.scrollLeft = Math.max(0, Math.min(1, (clientX - r.left) / (r.width || 1))) * Math.max(0, el.scrollWidth - el.clientWidth); };
    seek(e.clientX);
    const mv = (ev: PointerEvent) => seek(ev.clientX);
    const up = () => { document.body.style.userSelect = prevSel; window.removeEventListener('pointermove', mv); window.removeEventListener('pointerup', up); };
    window.addEventListener('pointermove', mv); window.addEventListener('pointerup', up);
  };

  const labelEvery = zoom >= 26 ? 1 : zoom >= 15 ? 2 : 4; // bar 号疏密随缩放
  const nums: React.ReactNode[] = [];
  for (let b = 0; b < total; b++) if (b % labelEvery === 0) nums.push(<span key={b} className="song-rn" style={{ left: b * zoom + 3 }}>{b + 1}</span>);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 }}>
      <div ref={scrollRef} className="lane-scroll" style={{ overflowX: 'auto', overflowY: 'hidden', minWidth: 0, scrollbarWidth: 'none', paddingBottom: 2 }}>
        <div className="song-content" style={{ position: 'relative', width: 'max-content', minWidth: '100%' }}>
          <div className="song-ruler" style={{ width: W, backgroundImage: `repeating-linear-gradient(90deg, rgba(236,233,227,.08) 0 1px, transparent 1px ${zoom}px)` }} onPointerMove={onRulerMove} onPointerLeave={onRulerLeave} onClick={(e) => onSeekBar(barAtX(e.clientX))}>
            {selColor && <div className="song-rsel" style={{ left: selLeft, width: selW, background: `color-mix(in srgb, ${selColor} 30%, transparent)` }} aria-hidden="true" />}
            {nums}
          </div>
          {children}
          {[...cum, total].map((b, i) => <div key={'d' + i} className="song-div" style={{ left: b * zoom }} aria-hidden="true" />)}{/* 每个块边界(含首 0 / 末 total)画一条;落在精确 B 处与标尺对齐 */}
          <div ref={guideRef} className="song-guide" style={{ display: 'none' }} aria-hidden="true" />
          <SongPlayhead engine={engine} playing={playing} px={zoom} blockStartBars={cum[playingIdx] ?? 0} blockTransportStart={blockTransportStart} />
        </div>
      </div>
      {thumb.show && <div className="we-scroll" onPointerDown={thumbDown}><div className="we-thumb" style={{ left: thumb.left + '%', width: thumb.width + '%' }} /></div>}
    </div>
  );
}

/** Song 模式走 SongTimeline(标尺/滚轮/缩放),Live 模式走朴素 HScroll。 */
function RailScroll({ song, children, ...rest }: SongTimelineProps & { song: boolean }) {
  return song ? <SongTimeline {...rest}>{children}</SongTimeline> : <HScroll>{children}</HScroll>;
}

/** §20 横向自定义滚动容器 —— 复用 collage lane 的 .we-scroll 条:藏原生横滚条,底部挂一条可拖的细条。内容溢出才显条。 */
function HScroll({ children }: { children: ReactNode }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [thumb, setThumb] = useState({ left: 0, width: 100, show: false });
  useEffect(() => {
    const el = scrollRef.current; if (!el) return;
    const update = () => {
      const w = el.clientWidth, sw = el.scrollWidth;
      const width = sw > 0 ? Math.min(100, (w / sw) * 100) : 100;
      const left = sw > w ? (el.scrollLeft / (sw - w)) * (100 - width) : 0;
      setThumb({ left, width, show: sw > w + 1 });
    };
    update();
    el.addEventListener('scroll', update, { passive: true });
    const ro = new ResizeObserver(update); ro.observe(el);
    if (el.firstElementChild) ro.observe(el.firstElementChild); // session 增删 → 内容宽变 → 重算条
    return () => { el.removeEventListener('scroll', update); ro.disconnect(); };
  }, []);
  const thumbDown = (e: React.PointerEvent) => {
    e.preventDefault(); // 拖滚动条时别选中页面内容
    const track = e.currentTarget as HTMLElement; const el = scrollRef.current; if (!el) return;
    const prevSel = document.body.style.userSelect; document.body.style.userSelect = 'none';
    const seek = (clientX: number) => { const r = track.getBoundingClientRect(); const frac = Math.max(0, Math.min(1, (clientX - r.left) / (r.width || 1))); el.scrollLeft = frac * Math.max(0, el.scrollWidth - el.clientWidth); };
    seek(e.clientX);
    const mv = (ev: PointerEvent) => seek(ev.clientX);
    const up = () => { document.body.style.userSelect = prevSel; window.removeEventListener('pointermove', mv); window.removeEventListener('pointerup', up); };
    window.addEventListener('pointermove', mv); window.addEventListener('pointerup', up);
  };
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 }}>
      <div ref={scrollRef} className="lane-scroll" style={{ overflowX: 'auto', overflowY: 'hidden', minWidth: 0, scrollbarWidth: 'none', paddingBottom: 2 }}>
        {children}
      </div>
      {thumb.show && <div className="we-scroll" onPointerDown={thumbDown}><div className="we-thumb" style={{ left: thumb.left + '%', width: thumb.width + '%' }} /></div>}
    </div>
  );
}

/** arrange 轨浮层:portal 挂 body,落在底部编辑器(footer)之上、左缘让开素材列表(aside.br),近满主区宽;Esc 收起;resize/scroll 跟随。 */
function ArrangePopover({ onClose, onHeight, children }: { onClose: () => void; onHeight?: (h: number) => void; children: ReactNode }) {
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
  useEffect(() => { if (popRef.current) { const oh = popRef.current.offsetHeight; if (oh && oh !== h) { setH(oh); onHeight?.(oh); } } });
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
  const cells: [string, string][] = [['Tempo', '—'], ['Length', '—'], ['Pitch', '—'], ['Stretch', '—']];
  return (
    <div className="ed-wrap">
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
            <span className="muted small" style={{ textAlign: 'center', padding: '0 20px' }}>{hint ?? 'Click a sample on the left to pre-adjust · or click a stage instrument'}</span>
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
