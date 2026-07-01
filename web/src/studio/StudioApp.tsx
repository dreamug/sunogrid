'use client';
// Studio —— 老 loop 机 .daw 外壳 + 新模型 Session › Instrument › Clip,接真实库 + 生成 + undo + 真 WarpEditor + 落库。
// 左 = LoopManager(生成 + 真实库,可拖);中 = 操场(clip 画波形、拖库素材进空 slot=sample 乐器、hover 空 slot=＋sample/＋切片、拖进 collage=加片);
// 底 = 编辑器(选库素材→预调 warp;选乐器→mixer + warp/collage 下钻)。生产 loop-machine 与 DB 的旧表不碰。
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import Link from 'next/link';
import type { AutoPoint, Clip, CollageClip, FxConfig, GenPrefs, GridPrefs, Instrument, InstrumentPayload, InstrumentSends, Mixer, Quantize, SampleWarp, Session, SongLane, XYAutomation, XYAutoSet, XYProgram } from '@/contracts';
import { activeInstruments, resolveInstruments, clipMixer, defaultMixer, defaultSends, DEFAULT_FX, DEFAULT_XY, DEFAULT_MASTER, normalizeMaster, instrumentBars, mixerToClipPatch, sessionBars, sessionColor, sessionRepeats, sessionSongEndBar, sessionSongLane, sessionSongStartBar, sessionSongAnchor, isMainLane, pickSessionColor, backfillSessionColors, SESSION_COLORS, SLOTS_PER_SESSION } from '@/contracts';
import { resnapSong, mainLayout, anchorPatchAt, mainInsertIndex, moveMainTo, subDropLanding, nextFreeSubStart } from '@/studio/songLayout';
import { normalize, type Snapshot } from '@/studio/sync';
import { StudioEngine } from '@/audio/studioEngine';
import { warpPtsSig } from '@/audio/warpMap';
import { buildBuffer, decodeAsset, loadLibrary, regionFromClip, regionFromSound, soundToClip, warpToBuffer } from '@/studio/realLibrary';
import { loadGens, generateToLibrary, retryGen, uploadToLibrary, rechopSong, conciseError, type GenHooks } from '@/studio/studioGens';
import { addSession as docAddSession, cloneInstrument, duplicateSessionAt, findInst, freeSlots, moveSession, patchCollageClip, patchMixer, patchSession, removeInstrument as docRemove, removeSessionAt } from '@/studio/sessionDoc';
import { placeItem, placeNear, roomAt, itemLengthSteps } from '@/studio/collageDoc';
import { MixerStrip } from '@/studio/ui/MixerStrip';
import { MasterMeter, TransportPos, SampleWave, CollageHead, LaunchLevel, SessionPlayhead } from '@/studio/ui/live';
import { InstrumentIcon } from '@/studio/ui/instrumentIcons';
import { TransportIcon } from '@/studio/ui/glyphs';
import { ConfirmDialog, type ConfirmOpts } from '@/ui/ConfirmDialog';
import { LoopManager } from '@/studio/ui/LoopManager';
import { FxRack } from '@/studio/ui/FxRack';
import { MasterStrip } from '@/studio/ui/MasterStrip';
import { XYPad } from '@/studio/ui/XYPad';
import { OutputDevice } from '@/studio/ui/OutputDevice';
import { ExportDialog } from '@/studio/ui/ExportDialog';
import { applySavedOutput } from '@/studio/useAudioOutputs';
import { AutomationLane } from '@/studio/ui/AutomationLane';
import { defaultAutomation, rescaleAuto, sampleXY, sampleAuto, sortPoints, isActiveAuto, NEUTRAL, normalizeXyAuto, normalizeVolAuto, isActiveVol, volGain, VOL_NEUTRAL, VOL_COLOR, VOL_LABEL, PROG_COLOR, PROG_LABEL, PROG_ORDER } from '@/studio/xyAutomation';
import type { GenView, LoopView } from '@/contracts/studioViews';
import { api, type ApiSound } from '@/studio/api';
import { ClipEditor } from '@/studio/ui/WarpEditor';
import { ChopView } from '@/studio/ui/ChopView';
import { CollagePadBody } from '@/studio/ui/CollagePadBody';
import { SongZoomScope } from '@/studio/ui/SongZoomScope';
import { SessionColorDot } from '@/studio/ui/SessionColorDot';
import { InstrumentChip } from '@/studio/ui/InstrumentChip';
import { SongInstrumentCount } from '@/studio/ui/SongInstrumentCount';
import { InstrumentName } from '@/studio/ui/InstrumentName';
import { Metronome } from '@/studio/ui/Metronome';
import { ProjectNameInput } from '@/studio/ui/ProjectNameInput';
import { TempoInput } from '@/studio/ui/TempoInput';
import { CollageEditor } from '@/studio/ui/CollageEditor';
import { RailScroll } from '@/studio/ui/SongTimeline';
import { ArrangePopover } from '@/studio/ui/ArrangePopover';
import { EmptyEditor } from '@/studio/ui/EmptyEditor';
import { nid, cvar, FAINT, SONG_ZOOM_DEFAULT, clampZoom } from '@/studio/shared';
import { computePeaks, peaksFromRegion, lanePeaksCache, pieceKey } from '@/studio/peaks';
import { emptySessions, normalizeSongLayout, songTotalBars, SONG_TRACK_COUNT, songActiveAt, songForeground, songNextBoundaryAfter, sessionInstIds, enabledInstIds } from '@/studio/songQuery';
import { usePersistence } from '@/studio/hooks/usePersistence';


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
interface Ctx { soundsById: Map<string, ApiSound>; bpm: number; beatsPerBar: number }


export function StudioApp({ projectId, name = 'project', masterBpm, masterKey = null, genPrefs = null, gridPrefs = null, fx: fxProp = null, quantize: propQuantize = '1bar', beatsPerBar = 4, loopSong: propLoopSong = false, playMode: propPlayMode = 'live', showAutomation: propShowAutomation = true, songLanes: songLanesProp = null }: { projectId: string; name?: string; masterBpm: number; masterKey?: string | null; genPrefs?: GenPrefs | null; gridPrefs?: GridPrefs | null; fx?: FxConfig | null; quantize?: Quantize; beatsPerBar?: number; loopSong?: boolean; playMode?: 'live' | 'song'; showAutomation?: boolean; songLanes?: SongLane[] | null }) {
  const [ctx, setCtx] = useState<Ctx | null>(null);
  const [projName, setProjName] = useState(name); // 顶栏可编辑工程名;改即乐观写 Project.name(同 quantize 套路,不进 undo/发件箱)
  // §19 桌面化:仅 Electron(注入 window.sunogrid)才显示顶栏的「Suno」按钮。useEffect 里读,避免 SSR 水合不一致。web 上恒 false → 不渲染,行为不变。
  const [isDesktop, setIsDesktop] = useState(false);
  useEffect(() => { setIsDesktop(typeof window !== 'undefined' && !!(window as unknown as { sunogrid?: unknown }).sunogrid); }, []);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [sessionIdx, setSessionIdx] = useState(0); // 「查看/编辑」中的场景(pad 区 + 编辑器都读它);Song 模式下它与「正在播的块」解耦
  const sessionIdxRef = useRef(0); sessionIdxRef.current = sessionIdx; // 给 useCallback([]) 的 loadInstrumentToEngine 读最新查看场景(判 viewingSoundingBlock)
  const [playingIdx, setPlayingIdx] = useState(0); // §20 Song 模式:当前正在出声的块(高亮 + 播放头跟它);Live 模式播放块=sessionIdx,不用它
  const playingIdxRef = useRef(0); playingIdxRef.current = playingIdx; // §26 回放 rAF 闭包读最新播放块
  const [playingSongIds, setPlayingSongIds] = useState<Set<string>>(() => new Set()); // §37 Song 多轨:当前正在出声的 session id 集
  const playingSongIdsRef = useRef<Set<string>>(new Set()); playingSongIdsRef.current = playingSongIds;
  // perf:songZoom/songGrid 已下放到 <SongZoomScope>(隔离重渲,见组件) —— zoom 高频改动不再触发 3100 行单体全量重渲。
  const [arrangerH, setArrangerH] = useState(208); // §37 arranger(track 区)定高:内部纵向 scroll(默认露 ~3 条收起 track);分隔条拖动改它
  const [songVScroll, setSongVScroll] = useState(0); // §37 lanes 纵向 scrollTop → gutter 表头同步平移(冻结窗格)
  const stageRef = useRef<HTMLElement>(null); // §37 量 stage 可用高 → arranger 上限按它的一半(留给乐器区一半,而非整屏一半)
  const [stageH, setStageH] = useState(0);
  const [autoAxis, setAutoAxis] = useState<'x' | 'y'>('x'); // §26 自动化 lane 当前显示轴(全局切换)
  const [autoProgram, setAutoProgram] = useState<XYProgram>('filter'); // §26.v2 当前编辑哪条效果 lane(每效果一条;顶栏 chip 切)
  const [autoVol, setAutoVol] = useState(false); // §41 自动化选择器是否选中「音量」(一维,与 4 个 XY 效果互斥;选中 → 隐 X/Y、lane 换音量曲线)
  const xyManual = useRef<{ down: boolean; program: XYProgram; x: number; y: number }>({ down: false, program: 'filter', x: 0.5, y: 0 }); // §26.4 手动板手势 → coordinator 读(手动板不再直调引擎)
  const xyClearRef = useRef(0); // §26.4 bump=请求 coordinator 复位所有效果(清 latch/glide):关 XY 浮层 / 卸载 / undo 时触发
  // §20/§26 播放模式 + 量化换场:playMode 现 Project 列乐观持久化(上次进 Live/Song 记住);pendingIdx = 已排队、等量化边界切到的场景(目标卡呼吸);loopSong = Project 列乐观持久化。
  const [playMode, setPlayMode] = useState<'live' | 'song'>(propPlayMode);
  const [pendingIdx, setPendingIdx] = useState<number | null>(null);
  const [loopSong, setLoopSong] = useState(propLoopSong);
  const [showAutomation, setShowAutomation] = useState(propShowAutomation); // §26 automation UI 显隐(纯 UI 层,Project 列持久化);不影响效果回放
  // §37 命名 track:Project.songLanes 稀疏覆盖数组(下标=lane;未自定义则回退默认 Main/Sub N)。改名/换色乐观持久化 + 进 undo。
  const [songTracks, setSongTracks] = useState<SongLane[]>(songLanesProp ?? []);
  const songTracksRef = useRef<SongLane[]>(songTracks); songTracksRef.current = songTracks;
  const playModeRef = useRef<'live' | 'song'>(propPlayMode); playModeRef.current = playMode;
  const loopSongRef = useRef(loopSong); loopSongRef.current = loopSong;
  const songSchedId = useRef<number | null>(null); // Song 多轨:下一处 start/end 边界的 scheduleOnce 句柄
  const songBlockStart = useRef(0); // Song 线性:当前块从第几小节开始(播放态高亮"播到第几遍"用)
  const songLapBars = useRef(0); // §39 loop:已循环圈数累计的 bar 偏移(走带单调递增不回零 → 播放头/边界换场对齐音频时钟,见 scheduleNextSongBoundary)。song-bar = songPosBars − songLapBars
  const viewFollows = useRef(true); // §20 Song 模式:pad 视图是否跟随播放块推进;点卡查看某场景即脱离(false),停/重播复位(true)
  const starting = useRef(false); // §20 起播重入锁:重置引擎可能异步(loadSession),起播窗口内挡住第二次起播 + 并发换场(switchSession),避免两次 loadSession 交错把多个场景混进引擎
  const liveSwapSchedId = useRef<number | null>(null); // Live 量化换场:已排在边界、还没触发的换场 scheduleOnce 句柄(连点换场要先撤上一个,否则两场同时起声)
  const swapGen = useRef(0); // 换场代号:更晚的一次换场会让先前那次还在 load 的 .then 作废(避免它过后再排边界)
  const [renamingId, setRenamingId] = useState<string | null>(null); // 场景改名内联编辑
  const [titleRenaming, setTitleRenaming] = useState(false); // §26 顶栏标题改名(独立 state,免和块名共用 renamingId 时双输入框)
  const [renamingLane, setRenamingLane] = useState<number | null>(null); // §37 track gutter 表头改名
  // 场景拖拽换位:实时 preview(用 flex order 视觉重排,DOM/数组不动 → cur/索引逻辑无需改);松手才落库一次。
  const [dragId, setDragId] = useState<string | null>(null);            // 正在拖的场景 id(被拖卡压暗当占位)
  const [previewOrder, setPreviewOrder] = useState<string[] | null>(null); // 拖拽中的预览顺序(场景 id 数组),非拖拽=null
  const dragIdRef = useRef<string | null>(null);
  const previewOrderRef = useRef<string[] | null>(null);
  // §37 Song 多轨指针拖拽:拖块身=2D 移动(吸 bar+lane,落主轨重排/落 sub 锚定·Alt 复制),拖右缘=改 repeat。
  const [songDrag, setSongDrag] = useState<{ id: string; vbar: number; vlane: number; clone: boolean; cursorBar: number } | null>(null); // §37 vbar=块投影起点(浮动跟手用);cursorBar=鼠标所在小节(主轨 reorder 插入判据用)
  const songDragRef = useRef<{ id: string; grabX: number; origStart: number; clone: boolean; moved: boolean; vbar: number; vlane: number; cursorBar: number } | null>(null);
  const songLanesRef = useRef<HTMLDivElement>(null);
  const gutterWheelCleanup = useRef<(() => void) | null>(null);
  // §37 track 表头列上滚轮:gutter 是 overflow:hidden 的独立兄弟(不在 lane-scroll 里),原生滚轮够不到 lanes。
  //   用 callback ref 在 gutter 真正挂载时绑非被动 wheel(用 useEffect 会在加载骨架阶段 el 还是 null 时跑一次、之后不再重跑)。
  //   滚轮转发给 lane-scroll(纵滚 track)+ 直接驱动 gutter 平移(冻结窗格跟手,不依赖 scroll 事件回灌)。
  const songGutterRef = useCallback((el: HTMLDivElement | null) => {
    gutterWheelCleanup.current?.(); gutterWheelCleanup.current = null;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      const sc = el.parentElement?.querySelector<HTMLElement>('.lane-scroll'); if (!sc) return;
      e.preventDefault();
      sc.scrollTop += e.deltaY;
      setSongVScroll(sc.scrollTop);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    gutterWheelCleanup.current = () => el.removeEventListener('wheel', onWheel);
  }, []);
  const [songResize, setSongResize] = useState<{ id: string; reps: number } | null>(null);
  const songResizeRef = useRef<{ id: string; grabX: number; bars: number; origReps: number } | null>(null);
  const [selId, setSelId] = useState<string | null>(null);
  const [selClipId, setSelClipId] = useState<string | null>(null);
  const [libSel, setLibSel] = useState<string | null>(null);
  // 切块/还原时调和选中态:选中乐器/片若仍在「目标块」里就**保留**高亮,不在才清。
  //   选中态绑乐器 id,不随走带无脑丢 —— 修「选中乐器一播放选中态就没」的体验。
  //   常见路径(在块0选中→从块0起播,视图不变)下乐器仍在该块 → 选中保留;走带跨到别块、被动跟随时旧块的选中才放手。
  //   只管乐器域的 selId/selClipId(走 resolveInstruments 接缝,与回放/导出同口径);libSel(全局库检视器选择)非块作用域,留给调用方按需各自处理。
  //   loadSessionPure(§16 还原)与走带跟随共用本函数;走带路径另行清 libSel(回放期不留悬空库检视),还原路径不动 libSel(沿用旧口径)。
  const reconcileSelToSession = (s: Session | undefined) => {
    const insts = s ? resolveInstruments(s) : [];
    setSelId((cur) => (cur && insts.some((i) => i.id === cur) ? cur : null));
    setSelClipId((cur) => (cur && insts.some((i) => i.payload.kind === 'collage' && i.payload.clips.some((k) => k.id === cur)) ? cur : null));
  };
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
  const [chopBusy, setChopBusy] = useState(false); // §33.6 重切进行中
  const [warming, setWarming] = useState<string | null>(null); // ⑥ 试听 warm-up:正在 build buffer 的 sound/clip id(命中缓存<120ms 不显)
  const [building, setBuilding] = useState<Record<string, boolean>>({}); // ⑩ 新乐器入场:正在首建 buffer 的乐器 id(无 peaks 时 → 压暗 + 锁 ▶)
  const [playing, setPlaying] = useState(false);
  const playingRef = useRef(false); playingRef.current = playing; // §26.4 coordinator 常驻 rAF 闭包读最新播放态
  const [prepping, setPrepping] = useState(false); // §44 起播准备态:点 Play 后到 startTransport 之间(冷启动建 active 块 voice)→ 按钮转圈 + 禁重入
  const preloadAbort = useRef(false); // §44 起播入口**同步**置 true → 立即停后台预载,把主线程让给起播(避免预载与起播 build 并发争抢 = 实测「播放期间一次性 build 全曲」式 ~1s 卡;只一件在途的 build 会越界,可接受)
  const [soloIds, setSoloIds] = useState<Set<string>>(() => new Set()); // §18 独奏集(瞬态,不落库/不进 undo);隔离式 + 多选
  // 顶栏:量化粒度 / 节拍器(开关·音量·几小节响一次) / 主音量。引擎能力见 StudioEngine。
  const [quantize, setQuantizeState] = useState<Quantize>(propQuantize);
  const [metroOn, setMetroOn] = useState(false);
  const [metroVol, setMetroVol] = useState(-8);
  const [metroIv, setMetroIv] = useState<'beat' | 'bar' | '2bar' | '4bar'>('beat');
  const [masterVol, setMasterVol] = useState(0);
  // 主总线效果器(§17):per-project,改即时 setFx 到引擎 + 防抖乐观持久化;v1 不进 undo(同 masterVol/quantize,见 §16 沿革)。
  // 归一化:老工程的 Project.fx 没有 xy(§21 后加)/ master(§42 后加)字段 → 补 DEFAULT,免引擎读到 undefined。
  const [fx, setFx] = useState<FxConfig>(() => (fxProp ? { ...DEFAULT_FX, ...fxProp, xy: { ...DEFAULT_XY, ...(fxProp.xy ?? {}) }, master: normalizeMaster(fxProp.master) } : DEFAULT_FX));
  const fxRef = useRef<FxConfig>(fx); fxRef.current = fx;
  // 撤销快照口径(§16):① sessions 整树 ② 各库声音 warp ③ 主 bpm ④ 主总线效果器(§17)⑤ 活动 session(undo 跳回改动现场)⑥ 量化粒度 ⑦ 库存活集(声音/生成组软删可撤)
  // ⚠ 改这个口径(加/减可还原字段)→ 必须同步更新 `histDataKey`(空步判定的数据序列化,除 sessionId 外每个 data 字段都要进),否则空步跳过会漏判/误判。
  type HistEntry = { sessions: Session[]; warps: Map<string, unknown>; bpm: number; fx: FxConfig; sessionId: string; quantize: Quantize; liveSounds: Set<string>; liveGens: Set<string>; songTracks: SongLane[] };
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
  // perf:LIBRARY(LoopManager,~700 节点)+ pad grid 回调走稳定 ref 路由 —— 元素引用稳定 + memo 包裹后,
  //   zoom / 播放跨块 / 切场景时这些与它们无关的子树不再陪着 reconcile。ref.current 每渲染刷新=闭包永新鲜。
  const libCbRef = useRef<Record<string, (...a: any[]) => any>>({});
  const libCb = useMemo(() => {
    const k = ['onGenBpm', 'onGenKey', 'onGenerate', 'onUpload', 'onSelect', 'onAudition', 'onAssignNext', 'onSeparate', 'onRetryGen', 'onCancelGen', 'onDeleteGen', 'onDeleteSound'] as const;
    return Object.fromEntries(k.map((n) => [n, (...a: any[]) => libCbRef.current[n]?.(...a)])) as Record<(typeof k)[number], (...a: any[]) => any>;
  }, []);
  // perf:songZoom/songGrid 下放到 <SongZoomScope>(rAF 合并 + 钳制 + 持久化都在那);这里只留:
  //   ① songZoomRef —— 暴露当前 zoom 给 StudioApp 体内的拖拽 handler 读(scope 每渲染回写);
  //   ② persistGrid —— scope 改 zoom/grid 时防抖落 gridPrefs 的回调。
  const songZoomRef = useRef(clampZoom(gridPrefs?.songZoom ?? SONG_ZOOM_DEFAULT));
  const persistGrid = useCallback((zoom: number, grid: number) => {
    gridRef.current = { ...gridRef.current, songZoom: zoom, songGrid: grid };
    api.projects.update(projectId, { gridPrefs: gridRef.current }).catch(() => {});
  }, [projectId]);
  const [status, setStatus] = useState('Loading library + generation records…');

  const eng = useRef<StudioEngine | null>(null);
  const ctxRef = useRef<Ctx | null>(null);
  const sessionsRef = useRef<Session[]>([]);
  const gensRef = useRef<GenView[]>([]);              // 快照口径⑦:记录当时存活的生成组 id(库删除可撤)
  const quantizeRef = useRef<Quantize>(propQuantize); // 快照口径⑥:量化粒度(项目级标量)读最新值
  // §16 口径⑦:undo/redo 只允许"重删"曾经真删过的 id(restore-only + 这个白名单)→ 撤回到很早的快照时绝不误删之后生成的声音/组。
  const trashableSounds = useRef<Set<string>>(new Set());
  const trashableGens = useRef<Set<string>>(new Set());
  const genAborts = useRef<Map<string, AbortController>>(new Map()); // 生成中的 gen → 取消句柄(随时干掉)
  const loaded = useRef(false); // 加载完成前不触发自动保存(usePersistence 读它判断是否落库)
  const synced = useRef<Snapshot>({ sessions: {}, instruments: {}, clips: {} }); // 上次已落库的规范化快照,diff 基准(load 写初值,usePersistence flush 推进)
  const { sync, saveErr } = usePersistence({ projectId, sessions, sessionsRef, loaded, synced }); // §15 自动保存发件箱(抽成 hook;sync/saveErr 供顶栏状态点 + 错误横幅)
  const dragOK = useRef(true);
  const gainDragged = useRef(false); // 拖 gain 线刚结束 → 吞掉随之而来的 click(否则冒泡到卡片 onClick 误触 previewInst)
  const soloRef = useRef<Set<string>>(new Set()); soloRef.current = soloIds; // §18 独奏集 authority(toggle/clear 读最新值,避免闭包旧值)
  const lastCollageEdit = useRef<Session | null>(null); // collage 拖移/调参后,松手重 bake 取最新一笔(绕开 sessionsRef 渲染滞后)
  const collageRebakeTimer = useRef<ReturnType<typeof setTimeout> | null>(null); // per-片 mixer 拖动:防抖重 bake(MixerStrip 无 onEnd)
  const buildSeq = useRef<Record<string, number>>({}); // per-乐器 build 单调号:异步 build 完成后若已被更晚一次编辑/重载取代 → 丢弃旧结果,别用过期 buffer 覆盖引擎(防"画面新声音旧";对标旧 useLoopMachine 的 seqRef)
  ctxRef.current = ctx; sessionsRef.current = sessions; gensRef.current = gens; quantizeRef.current = quantize;

  // §44 perf:把 loadInstrumentToEngine 的 setPeaks/setBuilding **合批**——首播/预载会并发 build 全曲乐器,
  //   原本每件 3 次全树 setState(building↑→peaks→building↓)= 几十次单体重渲 = 起播卡顿真因(见 [[studio-render-perf]])。
  //   累进 pending,setTimeout(0) 一帧内攒齐再一次性 flush:N×3 → ~2 次重渲。
  //   附带「暖建跳 spinner」:某件 build 在一个 flush 窗口内 start→finish(命中缓存,亚毫秒),building 的 true 与 delete
  //   落在同一 pending(后写覆盖)→ 只剩 delete → 从不闪 spinner、不多渲。冷建(true 先 flush)才显。
  const peaksPending = useRef<Record<string, number[] | null>>({}); // null = 删除该乐器峰值(缺源)
  const buildingPending = useRef<Record<string, boolean>>({});      // false = 删除该 building 标记
  const flushScheduled = useRef(false);
  const flushBuildState = useCallback(() => {
    flushScheduled.current = false;
    const pp = peaksPending.current; peaksPending.current = {};
    const bp = buildingPending.current; buildingPending.current = {};
    if (Object.keys(pp).length) setPeaks((prev) => {
      const next = { ...prev };
      for (const [id, v] of Object.entries(pp)) { if (v === null) delete next[id]; else next[id] = v; }
      return next;
    });
    if (Object.keys(bp).length) setBuilding((prev) => {
      let next = prev, changed = false;
      for (const [id, on] of Object.entries(bp)) {
        if (on) { if (next[id] !== true) { if (!changed) { next = { ...prev }; changed = true; } next[id] = true; } }
        else if (next[id]) { if (!changed) { next = { ...prev }; changed = true; } delete next[id]; }
      }
      return changed ? next : prev;
    });
  }, []);
  const scheduleBuildFlush = useCallback(() => { if (!flushScheduled.current) { flushScheduled.current = true; setTimeout(flushBuildState, 0); } }, [flushBuildState]);
  const queuePeaks = useCallback((id: string, v: number[] | null) => { peaksPending.current[id] = v; scheduleBuildFlush(); }, [scheduleBuildFlush]);
  const queueBuilding = useCallback((id: string, on: boolean) => { buildingPending.current[id] = on; scheduleBuildFlush(); }, [scheduleBuildFlush]);

  // setIntent=false = 纯预载:建 buffer+voice+peaks 但**绝不碰** wantOn/enabled(voice 默认 wantOn=false=静默)→ songPlayFrom 的 sweep 是唯一播放意图源 → 无竞态、不会点亮别块(§44 预载安全前提,区别于会污染意图的旧 loadSessionAdditive 预载)。
  const loadInstrumentToEngine = useCallback(async (inst: Instrument, seamless = false, arm = true, setIntent = true) => {
    const e = eng.current; if (!ctxRef.current || !e) return;
    const myV = (buildSeq.current[inst.id] = (buildSeq.current[inst.id] ?? 0) + 1); // 本次 build 代号:完成后据此判废,后发先至的旧 build 不再盖回引擎
    queueBuilding(inst.id, true); // ⑩ 入场/重建中;无缝重建(已有 peaks)不显遮罩,只锁全新乐器(§44 合批 flush:暖建随后被 delete 抵消 → 不闪 spinner)
    try {
      // §34 竞态修复:新上传/生成的 asset 偶发「落库已返回但 CDN 还没就绪」→ 紧接着的 buildBuffer(取流/decode)**抛错**
      //   = 这件乐器建不出 voice(预览不出声、开了也不跟走带,要刷新才好)。只对**抛错**退避重试(asset 就绪后即成功);
      //   返回 null = 缺源(soundsById 没这条),重试也没用(不重载不会变)→ 立即按缺源处理,别白等。
      let buf: AudioBuffer | null = null;
      for (let attempt = 0; attempt < 3; attempt++) {
        if (attempt > 0) await new Promise((r) => setTimeout(r, 250 * attempt));
        const cc = ctxRef.current; if (!cc) break;
        try { buf = await buildBuffer(inst, cc.bpm, cc.soundsById); break; } // 拿到 buffer 或确定缺源(null)→ 不再重试
        catch (err) {
          if (buildSeq.current[inst.id] !== myV) return; // 期间被更晚一次操作取代 → 丢弃这次(旧)build
          if (attempt === 2) console.warn('[studio] buildBuffer 重试后仍失败,乐器暂无 voice:', inst.id, err);
        }
      }
      if (buildSeq.current[inst.id] !== myV) return; // 成功路径也判废:build 期间被更晚操作取代 → 不动引擎/peaks
      if (!buf) { e.clearInstrument(inst.id); queuePeaks(inst.id, null); return; }
      if (seamless && e.hasVoice(inst.id)) {
        e.swapBuffer(inst.id, buf, instrumentBars(inst)); // 在播时:下一个小节边界无缝接管,不断声
      } else {
        // 非 seamless,**或** seamless 但引擎里还没有这件乐器的 voice —— 后者过去只重算波形、不建 voice,是个坑:
        //   collage 建 voice 的那次(seamless=false,addPiece/addEmpty/粘贴)build 还在 bake 时,若被随后一次编辑
        //   (rebake/move/改片/调 mixer/拖 loop 杆,均 seamless=true)作废(L302 判废发生在 loadInstrument 之前),
        //   接管的 seamless build 因 !hasVoice 落到这里 → 永远不建 voice;于是 pad 有波形但引擎无 voice,
        //   激活(setEnabled)因 `if(!v) return` 空操作、按 play 不出声,**要刷新才好**(见 'bug' 复盘)。改为一并建 voice。
        //   建 voice 本身不漏声:下面 soundingNow/arm 闸决定 setEnabled(量化起声)还是只 setWantOn(记意图);
        //   Song 查看非播放块时落到 setWantOn,voice 留 'off' 不点响(§20 常驻口径不破,真正播到时 loadSessionAdditive 会以 clearInstrument 重灌)。
        // §41 乐器归属 session(同时给下面 soundingNow + loadInstrument 的 per-session gain 路由用)。
        const instSession = sessionsRef.current.find((s) => s.instruments.some((i) => i.id === inst.id));
        e.loadInstrument(inst.id, buf, instrumentBars(inst), inst.mixer, inst.sends, instSession?.id);
        // arm 且该乐器属于「正在出声的块」→ 即时量化起声;否则只记意图(setWantOn),到换场边界由 swapVoicesAt 按 wantOn 起。
        // §20:Song 钉住查看非播放块时编辑/填充/加片一件 enabled 乐器,会走 arm=true 这条全量重载 —— 若直接 setEnabled 会把
        //   非出声块的乐器凭空点响(声音泄漏)。startPlayback 的 loadSession 即便落到 setWantOn 也无碍:随后 startTransport 按 wantOn 全量起声。
        const soundingNow = playModeRef.current !== 'song' || (instSession ? playingSongIdsRef.current.has(instSession.id) : sessionIdxRef.current === playingIdxRef.current);
        // 取 sessionsRef 里**最新**的 enabled,而非这次异步 build 捕获时的旧 inst.enabled:bake 期间用户点了激活 →
        //   捕获值已过期,旧值会把刚点的激活回写覆盖掉(同源的次生 desync)。乐器找不到(已删)则回落捕获值。
        const liveEnabled = sessionsRef.current.flatMap((s) => s.instruments).find((i) => i.id === inst.id)?.enabled ?? inst.enabled;
        if (!setIntent) { /* §44 纯预载:不碰 wantOn/enabled(voice 建出即 wantOn=false 静默)→ 不会点亮别块,songPlayFrom 起播时由 sweep 统一上意图 */ }
        else if (arm && soundingNow) e.setEnabled(inst.id, liveEnabled); // 活动场景:走带在跑时即量化起声
        else e.setWantOn(inst.id, liveEnabled);      // §20 预载非活动场景 / 查看非播放块:只记意图,到换场边界再起
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
      if (buildSeq.current[inst.id] !== myV) return; // peaks 计算又经一次 await(decodeAsset);仍可能被取代 → 别写旧波形
      queuePeaks(inst.id, peaks);
    } finally {
      if (buildSeq.current[inst.id] === myV) queueBuilding(inst.id, false); // 只有最新一次 build 负责收掉 building 遮罩,免被作废的旧调用提前清掉(§44 合批)
    }
  }, []);
  const loadSession = useCallback(async (s: Session) => {
    eng.current?.clearAll();
    // 各乐器**并行**warp/装载(原为逐件 await:换场要等所有 buffer 串行渲完才排边界 → 冷场叠加后常错过下一小节边界,听感=换场延迟)。
    // 单个乐器解码失败(如源文件缺失)不拖垮整场 —— 自己 catch 跳过,其余照常。
    await Promise.all(resolveInstruments(s).map((inst) =>
      loadInstrumentToEngine(inst).catch((e) => console.warn('Failed to load instrument, skipping:', inst.id, e))));
  }, [loadInstrumentToEngine]);
  // §20 并存预载:把目标场景的 voice 装进引擎但**不清当前场**(arm=false → 只记意图,到换场边界再起);Live 量化换场 + Song 块 lookahead 共用。并行装载同上。
  const loadSessionAdditive = useCallback(async (s: Session, arm = false) => {
    await Promise.all(resolveInstruments(s).map((inst) =>
      loadInstrumentToEngine(inst, false, arm).catch((e) => console.warn('Preload skip:', inst.id, e))));
  }, [loadInstrumentToEngine]);
  // §20 查看(不播放)某场景时:确保其 pad 波形有数据 —— 只解码 + 算峰值填进 peaks/lanePeaksCache,**不碰引擎**(不建 voice、不出声)。
  const ensurePeaksForView = useCallback(async (s: Session | undefined) => {
    if (!s) return;
    for (const inst of resolveInstruments(s)) {
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

  // stem 分离 sidecar 探活:挂载查一次 + 每 15s 轮询 —— sidecar 不自启(重启机器/崩了要手动 ./run.sh),
  // 轮询让它一起来 Separate 按钮就自动恢复,不必手动刷新页面(否则 stemUp 一直缓存着 false)。
  useEffect(() => {
    let alive = true;
    const ping = () => api.stemService().then((s) => alive && setStemUp(s.up)).catch(() => alive && setStemUp(false));
    ping();
    const t = setInterval(ping, 15000);
    return () => { alive = false; clearInterval(t); };
  }, []);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const soundsById = await loadLibrary();
        const g = await loadGens(projectId);
        let sessions = emptySessions();
        let restored = false;
        const saved = await fetch(`/api/studio?projectId=${projectId}`).then((r) => (r.ok ? r.json() : [])).catch(() => []);
        if (Array.isArray(saved) && saved.length) {
          sessions = normalizeSongLayout((saved as Session[]).map((s) => ({ ...s, xyAuto: normalizeXyAuto(s.xyAuto), volAuto: normalizeVolAuto(s.volAuto) }))); // §26.v2 归一 + §41 音量曲线归一 + §37 旧线性 Song → lane0 布局
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
        applySavedOutput(eng.current);         // §31:应用已存的输出设备偏好(校验设备仍在,否则回落默认)
        ctxRef.current = c;
        setCtx(c); setGens(g); setSessions(sessions);
        await loadSession(sessions[0]);
        // 只有从库里恢复出来的会话才能进 diff 基准。空工程兜底的 emptySessions() 还没落库 ——
        // 若也记进基准,后续 inst.add 会引用一个 DB 里不存在的 sessionId,被 /api/studio/ops 静默丢弃
        // (返回 200 却 0 落库,UI 还显示"Saved"),于是新工程的 pad 永远存不进去。
        // 故未恢复时基准留空 → 首次保存自带 sess.add,会话随乐器一起建。
        synced.current = restored ? normalize(sessions) : { sessions: {}, instruments: {}, clips: {} };
        loaded.current = true; // 之后任何 setSessions 才触发自动保存
        // §37 一次性补色:给历史「未设色」场景钉上不撞色的稳定色(loaded 后 setSessions → autosave 落库;之后非 null 不再补)。颜色从此只随用户改色而变,不再随数组下标洗牌。
        { const colored = backfillSessionColors(sessions); if (colored !== sessions) setSessions(colored); }
        // §44 后台预载:把其余场景的 voice 也建进引擎,但 setIntent=false=**绝不碰 wantOn/enabled**(voice 默认静默)。
        //   → 首播 songPlayFrom 的 missing 已基本就绪 = 起播无需现场 decode/warp/建 voice/算 peaks(实测这才是冷首播 ~300ms 卡的真因,非渲染),起播降到 warm 档(~30ms)。
        //   与旧「loadSessionAdditive 预载」的本质区别:那个 setIntent 默认 true → 后台迟到 setWantOn 点亮别块 = 播放不正常 + 抢机;这个永不上意图 → 无竞态。songPlayFrom 起播时 sweep 仍是唯一意图源。
        //   逐件串行(不淹没主线程);build 经 §44 合批 flush;失败静默。Live 起播 retainOnly 照旧剔别场。
        //   并发硬化:① playingRef.current 一旦起播立即停预载(songPlayFrom L768 早早置 true)→ 绝不在播放后重建/重载 voice(避免 dispose 掉正在出声的 player = 抖动);② hasVoice 已建则跳过(被 songPlayFrom 或上一轮建过)→ 不重载、不与起播抢 buildSeq。
        (async () => { for (let i = 1; i < sessions.length && alive; i++) for (const inst of resolveInstruments(sessions[i])) { if (!alive || preloadAbort.current) return; if (eng.current?.hasVoice(inst.id)) continue; try { await loadInstrumentToEngine(inst, false, false, false); } catch { /* 预载失败不影响播放 */ } } })();
        setStatus(restored ? 'Loaded · drag a sample into an empty slot / hover a slot to add an instrument · ⌘Z · changes auto-save' : 'Empty stage · generate or pick a sample on the left, drag it into a slot = sample instrument · hover a slot to add a slice instrument · changes auto-save');
      } catch (err) { setStatus('Load failed: ' + conciseError(err)); }
    })();
    return () => { alive = false; eng.current?.dispose(); };
  }, [loadSession, projectId, masterBpm, beatsPerBar]);

  // §44 起播 loading 态:点 Play → startTransport 之间(冷启动现建 active 块 voice)按钮转圈。
  //   只在 >120ms 才显(命中预载/缓存的暖起播亚毫秒完成 → 定时器未触发即被 endPrepping 取消 → 不闪 spinner、零额外重渲)。
  const preppingTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const beginPrepping = () => { if (preppingTimer.current) return; preppingTimer.current = setTimeout(() => { preppingTimer.current = null; setPrepping(true); }, 120); };
  const endPrepping = () => { if (preppingTimer.current) { clearTimeout(preppingTimer.current); preppingTimer.current = null; } setPrepping(false); };

  // 走带启停只切 playing(setState 即重渲一次);高频视觉(电平/走带位置/播放头)由自驱动叶子按 playing 起停 rAF。
  const togglePlay = () => {
    const e = eng.current; if (!e) return;
    if (e.isPlaying()) { cancelSongSchedule(); e.stopTransport(); e.stopAudition(); setPendingIdx(null); setPlaying(false); setSongActiveIds(new Set()); } // 停走带连带停掉「走带在跑时点起、跟随走带在响」的 clip/chop 预览
    else startPlayback();
  };
  // §32 导出前停掉一切发声(走带 + 松散预览 + Song 待推进 + 排队态),免离线渲染与实时播放抢 context。
  const stopAllAudio = () => { cancelSongSchedule(); eng.current?.stopTransport(); eng.current?.stopAudition(); setPendingIdx(null); setPlaying(false); setSongActiveIds(new Set()); };

  const curSession = sessions[sessionIdx];
  // §37 automation 单放(Ableton 式):clip 行(原版三层观感:名字条 tint + 数字条 tint·repeat 数字)+ 展开时下挂 automation 子行(原版暗底 strip,独立可编辑、指针手势分离不打架)。收起时数字条叠只读 ghost。
  const SONG_CLIP_H = 62, SONG_AUTO_H = 46;
  const songLaneH = showAutomation ? SONG_CLIP_H + SONG_AUTO_H : SONG_CLIP_H; // 108 : 62
  // §37 arranger 高度上下限(随轨高联动):下限=标尺+1 轨(至少露一整轨);上限=铺满 10 轨 & 给乐器区留 ≥260。
  const songMinH = 22 + songLaneH;
  const songAvailH = stageH || ((typeof window !== 'undefined' ? window.innerHeight : 800) - 220); // stage 可用高(未量到时按 viewport−220 兜底)
  const songMaxH = Math.max(songMinH, Math.min(22 + SONG_TRACK_COUNT * songLaneH, Math.round(songAvailH * 0.5) - 28)); // 上限:不超过 stage 一半(减 song-ctl+splitter 开销)→ 乐器区始终保住一半;再多的轨靠纵滚
  const arrangerHc = Math.max(songMinH, Math.min(songMaxH, arrangerH)); // 布局用的钳过高(automation 切换/localStorage 恢复都不越界)
  const songLanes = SONG_TRACK_COUNT; // §37 固定 10 条 track(Main + Sub 1..9),不增删;空轨也常驻,纵向 scroll 看下面的
  // songTrackW 移进 <SongZoomScope> 的 render-prop(用其 zoom 参数算),此处不再持有 songZoom。
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
      songTracks: songTracksRef.current,                   // §37 命名 track 快照(改名/换色可撤)
    };
  };
  const pushHistory = () => { const next = [...pastRef.current.slice(-49), snapshot()]; pastRef.current = next; setPast(next); futureRef.current = []; setFuture([]); };
  const updateSession = (next: Session) => setSessions((ss) => resnapSong(ss.map((s, i) => (i === sessionIdx ? next : s)))); // §37 改乐器可能改 sessionBars(最长乐器)→ 主轨长度变;必须 resnap 让 songStartBar 缓存跟上,否则渲染位置 + 播放边界一起漂(视觉/播放不统一的总根)
  const mutate = (fn: (s: Session) => Session) => { pushHistory(); updateSession(fn(sessionsRef.current[sessionIdx])); };
  const reconcile = useCallback(async (ss: Session[], idx: number) => { await loadSession(ss[idx]); setTick((t) => t + 1); }, [loadSession]);
  // 还原一格:sessions + 只把 warp 变了的库声音改回(+ 反向 patch;其余不碰,免误删之后生成的)+ 校验选中(还在就留→看见 snap back)+ 重灌引擎。
  const applyEntry = (entry: HistEntry) => {
    eng.current?.stopAudition();
    cancelSongSchedule(); setPendingIdx(null); // §20:undo/redo 前撤销 Song 待推进 + 清排队态(口径外瞬态)
    if (eng.current?.isPlaying()) { eng.current.stopTransport(); playingRef.current = false; setPlaying(false); setSongActiveIds(new Set()); }
    clearSolo(); // §18:solo 瞬态、不在快照口径;undo/redo 重灌引擎前先清掉,避免对不上已被还原/重建的乐器
    xyManual.current.down = false; xyClearRef.current++; eng.current?.xyReleaseAll(); // §21.v2:XY 手势瞬态(对标 solo),undo/redo 释放全部效果 + 复位 coordinator(清 latch/glide),免残留 wet
    sessionsRef.current = entry.sessions; // setState 下一帧才落;保存 diff/后续操作需要立刻读到还原后的树。
    setSessions(entry.sessions);
    // §16 口径⑤:undo/redo 跳回改动归属的 session(否则改动在别的 session 时 ⌘Z 表现为"毫无反应")。
    const found = entry.sessions.findIndex((s) => s.id === entry.sessionId);
    const idx = found >= 0 ? found : sessionIdx;
    if (idx !== sessionIdx) setSessionIdx(idx);
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
    // §37 命名 track:改名/换色可撤 —— state + 反向持久化(同 fx 口径)。
    if (JSON.stringify(entry.songTracks) !== JSON.stringify(songTracksRef.current)) { setSongTracks(entry.songTracks); api.projects.update(projectId, { songLanes: entry.songTracks }).catch(() => {}); }
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
    reconcileSelToSession(entry.sessions[idx]); // 选中乐器/片存活校验(走接缝;libSel 还原路径不动 —— 沿用旧口径)
    reconcile(entry.sessions, idx);
    // 库有增删 → 等服务端 trashed 落定后重载库,再 reconcile 一次(此时恢复的声音才回到 soundsById,引用它的乐器才能重建出声)。
    if (libOps.length) Promise.all(libOps).then(() => reloadLibrary()).then(() => reconcile(sessionsRef.current, idx)).catch(() => {});
  };
  // §16:把一条快照的「数据口径」(不含活动 sessionId —— 那只决定 undo 跳回哪个 session,不算数据变化)序列化成稳定串,
  //   用于丢弃「空 undo 步」:还原它在数据上等同当前态的条目(纯点旋钮/把值拖回原位留下的无变化条目)。撤销它用户什么也看不到 → 透明跳过。
  //   只可能因 JSON 键序差异把真·空步「多保留」(退化回原行为,安全);绝不会把真改动误判为空(两状态全部 8 项数据口径——sessions/bpm/fx/quantize/warps/liveSounds/liveGens/songTracks——相等才判等)。
  const histDataKey = (h: HistEntry): string => {
    const warps: string[] = [];
    for (const k of [...h.warps.keys()].sort()) warps.push(k + '=' + JSON.stringify(h.warps.get(k) ?? null));
    return JSON.stringify(h.sessions) + '' + h.bpm + '' + JSON.stringify(h.fx) + '' + h.quantize +
      '' + warps.join(',') + '' + [...h.liveSounds].sort().join(',') + '' + [...h.liveGens].sort().join(',') + "" + JSON.stringify(h.songTracks);
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

  // ——— §44 手动版本 / 存点(Checkpoint)———
  // 存 = 序列化项目态一条 JSON 行(client 即事实来源 §15②,不等发件箱);回退 = pushHistory() + applyEntry(合成 HistEntry,
  //   库字段中性化)→ §15 发件箱自动落库。范围仅项目态(sessions/bpm/fx/quantize/songTracks),不碰声音库(§44.1)。详见 PRODUCT §44。
  type CkptSnap = { sessions: Session[]; bpm: number; fx: FxConfig; quantize: Quantize; songTracks: SongLane[] };
  const [ckptSaving, setCkptSaving] = useState(false);
  const [ckptHas, setCkptHas] = useState(false);   // 是否已有存点 → 决定 Restore 可用
  const [ckptAt, setCkptAt] = useState(0);         // 最近存点时间戳(相对时间显示;0=无)
  const [ckptToast, setCkptToast] = useState<string | null>(null);
  const ckptToastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const savedKey = useRef<string | null>(null);    // 上次存点的项目态 key(脏检测基准;null=本会话未建立基准 → 不显脏)
  const showCkptToast = (msg: string) => { setCkptToast(msg); if (ckptToastTimer.current) clearTimeout(ckptToastTimer.current); ckptToastTimer.current = setTimeout(() => setCkptToast(null), 3000); };
  // 项目态 key = 版本快照涵盖的口径(§16 口径的项目子集);脏检测 + 存点基准 + 挂载初始化共用同一算法。
  const projStateKey = (ss: Session[], bpm: number, fxc: FxConfig, q: Quantize, st: SongLane[]): string =>
    JSON.stringify(ss) + '‖' + bpm + '‖' + JSON.stringify(fxc) + '‖' + q + '‖' + JSON.stringify(st);
  // 落库快照(可能来自旧版)按 load 同款归一后算 key —— 与 live 口径对齐,避免刚加载就误判脏。
  const snapProjKey = (snap: CkptSnap): string => {
    const ss = normalizeSongLayout((snap.sessions ?? []).map((s) => ({ ...s, xyAuto: normalizeXyAuto(s.xyAuto), volAuto: normalizeVolAuto(s.volAuto) })));
    const fxc: FxConfig = { ...DEFAULT_FX, ...(snap.fx ?? {}), xy: { ...DEFAULT_XY, ...((snap.fx as FxConfig)?.xy ?? {}) }, master: normalizeMaster((snap.fx as FxConfig)?.master) };
    return projStateKey(ss, typeof snap.bpm === 'number' ? snap.bpm : masterBpm, fxc, (snap.quantize ?? '1bar') as Quantize, Array.isArray(snap.songTracks) ? snap.songTracks : []);
  };
  const liveProjKey = useMemo(() => projStateKey(sessions, ctx?.bpm ?? masterBpm, fx, quantize, songTracks), [sessions, ctx?.bpm, fx, quantize, songTracks, masterBpm]); // eslint-disable-line react-hooks/exhaustive-deps
  const liveProjKeyRef = useRef(liveProjKey); liveProjKeyRef.current = liveProjKey;
  const ckptDirty = savedKey.current != null && liveProjKey !== savedKey.current; // 有基准且不同 = 有未保存改动

  const doSaveCheckpoint = useCallback(async () => {
    if (!loaded.current || ckptSaving) return;
    const snap: CkptSnap = { sessions: sessionsRef.current, bpm: ctxRef.current?.bpm ?? masterBpm, fx: fxRef.current, quantize: quantizeRef.current, songTracks: songTracksRef.current };
    const key = projStateKey(snap.sessions, snap.bpm, snap.fx, snap.quantize, snap.songTracks);
    setCkptSaving(true);
    try {
      await api.projects.saveCheckpoint(projectId, { snapshot: snap });
      savedKey.current = key; setCkptHas(true); setCkptAt(Date.now());
      showCkptToast('Saved version');
    } catch (err) { showCkptToast('Save failed'); console.error('[studio] §44 存点失败:', err); }
    finally { setCkptSaving(false); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, ckptSaving]);

  const doRevertCheckpoint = useCallback(async () => {
    if (!loaded.current || starting.current) return;
    let snap: CkptSnap;
    try {
      const { checkpoint } = await api.projects.latestCheckpoint(projectId);
      if (!checkpoint) { showCkptToast('No saved version yet'); return; }
      snap = checkpoint.snapshot as CkptSnap;
    } catch (err) { showCkptToast('Restore failed'); console.error('[studio] §44 取存点失败:', err); return; }
    if (!snap || !Array.isArray(snap.sessions)) { showCkptToast('Restore failed'); return; }
    const sessions = normalizeSongLayout((snap.sessions as Session[]).map((s) => ({ ...s, xyAuto: normalizeXyAuto(s.xyAuto), volAuto: normalizeVolAuto(s.volAuto) })));
    const fxNorm: FxConfig = { ...DEFAULT_FX, ...(snap.fx ?? {}), xy: { ...DEFAULT_XY, ...((snap.fx as FxConfig)?.xy ?? {}) }, master: normalizeMaster((snap.fx as FxConfig)?.master) };
    const bpm = typeof snap.bpm === 'number' ? snap.bpm : (ctxRef.current?.bpm ?? masterBpm);
    const q = (snap.quantize ?? quantizeRef.current) as Quantize;
    const st = (Array.isArray(snap.songTracks) ? snap.songTracks : songTracksRef.current) as SongLane[];
    const nextKey = projStateKey(sessions, bpm, fxNorm, q, st);
    if (nextKey === liveProjKeyRef.current) { savedKey.current = nextKey; showCkptToast('Already at last saved'); return; } // 与当前完全一致 → 免空 undo 步
    // 回退本身可 ⌘Z:先压当前 live 态。库字段中性化(warps 空 / live 集取当前)→ applyEntry 库分支 no-op(不碰声音库)。
    pushHistory();
    const sb = ctxRef.current?.soundsById;
    applyEntry({ sessions, warps: new Map(), bpm, fx: fxNorm, sessionId: sessionsRef.current[sessionIdx]?.id ?? '', quantize: q, liveSounds: new Set(sb ? sb.keys() : []), liveGens: new Set(gensRef.current.map((g) => g.id)), songTracks: st });
    savedKey.current = nextKey; // 回退后 live == saved
    showCkptToast('Reverted to last saved · ⌘Z to undo');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, sessionIdx]);

  // ⌘/Ctrl+S = 存一版,并灭浏览器「保存网页」框(不分焦点,与 ⌘Z 输入框退让不同 —— Save 是通用动作)。
  useEffect(() => {
    const onSaveKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.altKey && (e.key === 's' || e.key === 'S')) { e.preventDefault(); doSaveCheckpoint(); }
    };
    window.addEventListener('keydown', onSaveKey);
    return () => window.removeEventListener('keydown', onSaveKey);
  }, [doSaveCheckpoint]);

  // 挂载:取最新存点 → 启用 Restore + 初始化脏检测基准(内容与当前一致 → 显干净;有存点即可回退)。
  useEffect(() => {
    let alive = true;
    api.projects.latestCheckpoint(projectId).then(({ checkpoint }) => {
      if (!alive || !checkpoint) return;
      try { savedKey.current = snapProjKey(checkpoint.snapshot as CkptSnap); } catch { savedKey.current = null; }
      setCkptHas(true); setCkptAt(new Date(checkpoint.createdAt).getTime());
    }).catch(() => {});
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  const relTime = (t: number): string => {
    if (!t) return '';
    const s = Math.max(0, Math.round((Date.now() - t) / 1000));
    if (s < 45) return 'just now';
    const m = Math.round(s / 60); if (m < 60) return m + 'm ago';
    const h = Math.round(m / 60); if (h < 24) return h + 'h ago';
    return Math.round(h / 24) + 'd ago';
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (confirmState) return; // 弹窗开着时,快捷键交给弹窗(Enter/Esc)
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return; // 含 <select>(量化下拉):聚焦时 Del/空格交给控件,别误删乐器/误触走带
      if (e.key === 'Tab') { e.preventDefault(); return; } // 关掉键盘焦点遍历:Tab 不再在按钮/卡片间游走起 focus 环。点击仍会聚焦,§26 卡片热键(点卡=聚焦)不受影响;输入框内的 Tab 已由上面 editable 早返回放行
      if (e.code === 'Space' || e.key === ' ') { // 空格 = 走带启停;挡掉列表/页面滚动 + 按钮的空格触发
        e.preventDefault();
        if (e.repeat) return;
        const en = eng.current;
        if (en && !en.isPlaying() && (en.auditioningId() != null || en.auditionPending())) { en.stopAudition(); setTick((t) => t + 1); return; } // §28.7 有预览在响**或正在加载(warm-up)**且走带没跑 → 第一下空格只停预览(不误启走带);再按才控走带
        togglePlay();
        return;
      }
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
  // §34 粘贴入库:document 级 paste 监听 —— 有音频文件才 preventDefault+入库,否则放行默认(不劫持文本/图片粘贴)。无 deps 同 keydown effect:每渲染重挂,importPastedAudio 始终最新闭包。
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const files = e.clipboardData?.files;
      if (!files || !files.length) return;
      const audio = Array.from(files).filter(isAudioFile);
      if (!audio.length) return; // 非音频粘贴 → 交给默认行为
      e.preventDefault();
      void importPastedAudio(audio);
    };
    document.addEventListener('paste', onPaste);
    return () => document.removeEventListener('paste', onPaste);
  });
  // 全局禁用浏览器原生右键菜单 —— 自家菜单(如 WarpEditor)是 React 浮层、在自己的 onContextMenu 里已 preventDefault 并 setMenu,不依赖原生菜单,故不受影响。
  // 想保留原生右键的局部区域(目前无),给元素或其祖先挂 data-app-menu 即可放行。冒泡阶段监听:不抢在组件自身 onContextMenu 之前。
  useEffect(() => {
    const onCtx = (e: MouseEvent) => {
      if ((e.target as HTMLElement | null)?.closest('[data-app-menu]')) return;
      e.preventDefault();
    };
    document.addEventListener('contextmenu', onCtx);
    return () => document.removeEventListener('contextmenu', onCtx);
  }, []);
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
      const stopIds = resolveInstruments(cur).map((i) => i.id);
      const startIds = resolveInstruments(target).map((i) => i.id);
      liveSwapSchedId.current = e.swapAtBoundary((time) => {
        liveSwapSchedId.current = null;
        e.swapAndRelease(stopIds, startIds, time); // 边界:停旧起新(保相位)+ 过了边界再释放旧场(§14/§20);同步释放会切早旧场尾音=换场静音
        e.retainOnly([...stopIds, ...startIds]); // §20 内存:连切被作废的中间目标场会留下 armed 残渣 → 提交时即收掉(只留旧场[待 80ms 优雅释放]+新场);残渣从未出声,立即 dispose 安全
        setSessionIdx(idx); setPendingIdx(null); setSelId(null); setSelClipId(null); setLibSel(null); setTick((t) => t + 1);
        after?.(e.currentBar());
      });
    });
  };

  const setSongActiveIds = (ids: Set<string>) => { playingSongIdsRef.current = ids; setPlayingSongIds(new Set(ids)); };
  const primeSongAutomation = async (active: Session[], atBar: number) => {
    const e = eng.current; if (!e) return;
    // §37 owner = 前景块(主轨优先,否则最晚开始)——与稳态 coordinator(读 playingIdx=applySongActiveSet 的 foreground)同一口径,免起播瞬间 prime 一块、稳态又换块。
    const owner = songForeground(active);
    const localBar = owner ? Math.max(0, atBar - sessionSongStartBar(owner)) : 0;
    for (const program of PROG_ORDER) {
      const a = owner?.xyAuto?.[program];
      if (a && a.x.length && a.y.length) { const v = sampleXY(program, a, localBar); e.xySetValue(program, v.x, v.y); e.xySetActive(program, true); }
      else e.xySetActive(program, false);
    }
    // §41 音量自动化 prime:每个 active 块按各自起始 bar 瞬时设 gain,免第一圈从 unity 跳到自动值的台阶(immediate=true 不走斜坡)。
    for (const s of active) {
      const lb = Math.max(0, atBar - sessionSongStartBar(s));
      const v = (s.volAuto && s.volAuto.length) ? sampleAuto(sortPoints(s.volAuto), lb) : VOL_NEUTRAL;
      e.setSessionGain(s.id, volGain(v), true);
    }
    if (owner?.xyAuto) await new Promise((r) => setTimeout(r, 30));
  };
  const applySongActiveSet = (bar: number, time?: number) => {
    const e = eng.current; if (!e) return;
    const list = sessionsRef.current;
    const active = songActiveAt(list, bar);
    const prev = playingSongIdsRef.current;
    const next = new Set(active.map((s) => s.id));
    const stopSessions = list.filter((s) => prev.has(s.id) && !next.has(s.id));
    const startSessions = active.filter((s) => !prev.has(s.id));
    const stopIds = sessionInstIds(stopSessions);     // 停:全部(把禁用的也停干净)
    const startIds = enabledInstIds(startSessions);   // §37 起:只起激活乐器(禁用的不随块进 active 被点响)
    for (const id of stopIds) e.setWantOn(id, false);
    for (const id of startIds) e.setWantOn(id, true);
    // §37 Song 换场只 stop/start、**不销毁**旧场 voice(用 swapVoicesAt 而非 swapAndRelease)。
    //   songPlayFrom 已把全曲所有 session 预载常驻 = 无缝换场的前提;换完再 clearInstrument 旧场是反设计:
    //   ① 一次销毁 N 个 voice(player+eq×3+gain+panner+meter)同步耗时 ~100ms,Song 连续换场时这块极易压上**下一个**边界的 swap 回调
    //      → 回调迟到、lead 掉到 ~55ms 偶尔过点 → fire(time) 被 clamp → 下一段开头被吞(间歇 80/20,Live 单次换场不连发故无此症);
    //   ② 销毁后循环回放该 session 无声(voice 没了)。常驻则两病同消;内存由 songPlayFrom 的 retainOnly 兜底(只留全曲乐器)。
    if (time != null) e.swapVoicesAt(stopIds, startIds, time);
    setSongActiveIds(next);
    const foreground = songForeground(active); // §37 与 primeSongAutomation 同口径(主轨优先);驱动 playingIdx / songBlockStart / 视图跟随 / XY automation 源
    if (foreground) {
      const idx = list.findIndex((s) => s.id === foreground.id);
      if (idx >= 0) { playingIdxRef.current = idx; setPlayingIdx(idx); }
      songBlockStart.current = sessionSongStartBar(foreground);
      if (viewFollows.current && idx >= 0) { setSessionIdx(idx); reconcileSelToSession(list[idx]); setLibSel(null); }
    }
    setTick((t) => t + 1);
  };
  const scheduleNextSongBoundary = (fromBar: number) => {
    const e = eng.current; if (!e) return;
    if (songSchedId.current != null) { e.clearSched(songSchedId.current); songSchedId.current = null; }
    const total = songTotalBars(sessionsRef.current);
    const next = songNextBoundaryAfter(sessionsRef.current, fromBar);
    const boundary = next ?? (total > 0 ? total : null);
    if (boundary == null) return;
    // boundary == total(曲尾,total=最远 session 末)即整曲结束:loop 关→停、loop 开→回 0 重激活。
    //   旧逻辑用 `next==null` 判尾——但最后那个 session 末本身就是个 next(=total),永远走不到 null 分支 → loop 关时不停、空转过尾。
    const reachesEnd = boundary >= total - 1e-6;
    // 排到**绝对**走带位置(含已循环的圈偏移)。走带全程单调递增、永不回零 →
    //   边界回调虽在 lookahead 提前触发,但音频换场仍排在精确 time,而播放头(songPosBars % total)由走带时钟取模派生、
    //   恰在时钟跨界(=音频 time)那刻翻折,不再随提前触发的 JS 早跳(旧 setTransportPosition('0:0:0') 会把播放头提前约一个 lookahead 拽回头)。
    songSchedId.current = e.scheduleAt(`${songLapBars.current + boundary}:0:0`, (time) => {
      if (!eng.current) return;
      if (reachesEnd) {
        if (!loopSongRef.current) { eng.current.stopTransport(); playingRef.current = false; setPlaying(false); setSongActiveIds(new Set()); songSchedId.current = null; setTick((t) => t + 1); return; } // 曲尾停(playingRef 即时复位,免 coordinator 多跑一帧读已停走带)
        songLapBars.current += total; // loop:进下一圈,只挪偏移、不动走带 → 续排的绝对边界落在新圈、无缝重激活
        for (const inst of sessionsRef.current.flatMap((s) => resolveInstruments(s))) eng.current.setWantOn(inst.id, false);
        applySongActiveSet(0, time);
        scheduleNextSongBoundary(0);
        return;
      }
      applySongActiveSet(boundary, time);
      scheduleNextSongBoundary(boundary);
    });
  };

  // §39 无极起播:从任意全局 bar P(可小数)起播 Song —— ▶(P=0,从头)与点标尺跳播(P=点击位置)统一走这条。
  //   相位模型:每个 active voice 按「它在 P 处所处的相位」offset 起声(offset = ((P−session起点) mod 乐器bars)×每bar秒数)。
  //     · 主轨块在自己的 repeat 头 → offset 0;跨主轨边界的 sub 块 → 续在它真实的中段;sub-bar 点哪从哪起。
  //     · buffer 是均匀时间(warp 已烤进、长=乐器bars×每bar秒数),故 相位→offset 线性成立(见 §39 设计)。
  //   voice 复用:retainOnly(全 session 乐器)保住已载 voice + 只 load 缺的,不再每次 clearAll 重建 → 重复跳播/scrub 廉价;
  //     全量(不只 active)预载是为了 boundary 换场时下一块的 voice 现成可起,无加载缝隙。
  //   起播期间是异步窗口(load 缺的 voice),用 starting 锁挡住重入起播 + 并发 switchSession,避免交错混场。
  const songPlayFrom = async (P: number) => {
    const e = eng.current; if (!e || starting.current || playModeRef.current !== 'song') return;
    preloadAbort.current = true; // §44 起播即停后台预载(同步,先于一切 await)→ 让出主线程
    if (e.auditioningId() != null) { e.stopAudition(); setTick((t) => t + 1); } // 先停松散预览
    const list = sessionsRef.current; if (!list.length) return;
    const total = songTotalBars(list);
    const pos = Math.max(0, Math.min(P, Math.max(0, total - 1e-4))); // clamp 进曲长;不 floor(无极)
    const active = songActiveAt(list, pos);
    starting.current = true; beginPrepping();
    try {
      await e.resume().catch(() => {});
      cancelSongSchedule();
      if (e.isPlaying()) { e.stopTransport(); setPendingIdx(null); }
      clearSolo(); // song 不吃 solo(与旧 ▶ song 一致;retainOnly 不清 engine solo,故显式清)
      // voice 复用 + 预载:保仍在的、丢已删的、补缺的(缺的命中 buffer 缓存,loadInstrument 廉价)
      const allInstIds = list.flatMap((s) => resolveInstruments(s).map((i) => i.id));
      e.retainOnly(allInstIds);
      // ⚡ 长歌起播延迟:**只 await 起播位 active 块**的缺失 voice → 立即起声;其余块后台并行补
      //   (boundary 换场前几乎必然渲完;命中 buffer 缓存=毫秒级)。swapVoicesAt 对尚未就绪的 voice 自然跳过,
      //   极端慢载下该块那一遍静音、下一遍补上,不卡首播。
      const activeIdSet = new Set(active.flatMap((s) => resolveInstruments(s)).map((i) => i.id));
      const missing = list.flatMap((s) => resolveInstruments(s)).filter((i) => !e.hasVoice(i.id));
      await Promise.all(missing.filter((i) => activeIdSet.has(i.id)).map((inst) =>
        loadInstrumentToEngine(inst, false, false).catch((err) => console.warn('Song load skip:', inst.id, err))));
      if (eng.current !== e) return;
      const rest = missing.filter((i) => !activeIdSet.has(i.id));
      if (rest.length) void Promise.all(rest.map((inst) => loadInstrumentToEngine(inst, false, false).catch((err) => console.warn('Song bg-load skip:', inst.id, err)))); // 后台补:不阻塞起播
      // per-voice 相位 offset(秒)
      const mb = (beatsPerBar * 60) / (ctxRef.current?.bpm ?? masterBpm); // 每 bar 秒数(master 速率)
      const offsets = new Map<string, number>();
      for (const s of active) {
        const sStart = sessionSongStartBar(s);
        for (const inst of activeInstruments(s)) {
          const ib = Math.max(1, instrumentBars(inst));
          const phaseBars = (((pos - sStart) % ib) + ib) % ib; // 取模乐器bars:短乐器在 session 内循环多次
          offsets.set(inst.id, phaseBars * mb);
        }
      }
      // 前景块 / 视图跟随 / automation 起点(前景块驱动 XY,与稳态 coordinator 同口径)
      const fg = songForeground(active);
      viewFollows.current = true; playingRef.current = true; songLapBars.current = 0; songBlockStart.current = fg ? sessionSongStartBar(fg) : 0; // §39 起播=第 0 圈;走带置 pos(下方)即落在本圈
      setSongActiveIds(new Set(active.map((s) => s.id)));
      if (fg) { const bi = list.findIndex((s) => s.id === fg.id); if (bi >= 0) { setSessionIdx(bi); setPlayingIdx(bi); playingIdxRef.current = bi; reconcileSelToSession(list[bi]); setLibSel(null); } }
      await primeSongAutomation(active, pos); if (eng.current !== e) return;
      // wantOn:全关 → 只起 active 块的激活乐器(§37 禁用乐器不随块进活跃)。
      //   ⚠必须紧贴 startTransport(在 primeSongAutomation 的 await 之后):否则后台补载 rest(L847)的
      //   loadInstrumentToEngine 会在 await 窗口里 setWantOn(enabled=true)重新点亮别块乐器,
      //   startTransport 按 wantOn 全量起声 → 整个 session/别块乐器一起响(有一定几率的声音泄漏)。
      for (const inst of list.flatMap((s) => resolveInstruments(s))) e.setWantOn(inst.id, false);
      for (const inst of active.flatMap((s) => activeInstruments(s))) e.setWantOn(inst.id, true);
      // 走带置 pos(小数 bar → Bars:Beats[可小数]:0)+ 各 voice 按相位 offset 起声
      const bb = Math.floor(pos);
      e.setTransportPosition(`${bb}:${(pos - bb) * beatsPerBar}:0`);
      e.startTransport(offsets); setPlaying(true);
      scheduleNextSongBoundary(pos);
    } finally { starting.current = false; endPrepping(); }
  };

  // §20 起播(Live):收敛到「仅当前选中场景」再起,否则 startTransport 把别场残留 armed voice 一起点响。
  //   ① 当前场已在引擎(常态)→ retainOnly 瞬时剔残留(保 solo、不重建);② 不在(从 Song 钉住视图切回)→ loadSession 重灌。
  //   Song 模式统一委派 songPlayFrom(0)(从头无极起播)。starting 锁挡重入 + 并发 switchSession。
  const startPlayback = async () => {
    preloadAbort.current = true; // §44 起播即停后台预载(同步)→ 让出主线程
    if (playModeRef.current === 'song') { void songPlayFrom(0); return; } // §39 Song:从头无极起播
    const e = eng.current; if (!e || starting.current) return;
    if (e.auditioningId() != null) { e.stopAudition(); setTick((t) => t + 1); } // 提前关掉松散预览窗口
    const s = sessionsRef.current[sessionIdx]; if (!s) return;
    const ids = resolveInstruments(s).map((i) => i.id);
    starting.current = true; beginPrepping();
    try {
      await e.resume().catch(() => {});
      cancelSongSchedule();
      const loaded = ids.some((id) => e.hasVoice(id)); // 当前场已加载?(空场 ids=[] → false,走重灌兜底)
      if (!loaded) {
        await loadSession(s); if (eng.current !== e) return; // 重灌:引擎里只剩当前场
        reapplySoloFor(ids); // §18 clearAll 抹了 engine solo → 把本场仍存活的 solo 推回
      } else {
        e.retainOnly(ids); // 常态:瞬时剔别场残留(保 solo)
      }
      e.startTransport(); setPlaying(true);
    } finally { starting.current = false; endPrepping(); }
  };

  // 点场景卡:走带停 → 硬切(无声可断);走带在跑 → Live=量化换场(改播放);Song=只查看(不动播放,见 §20)。
  const switchSession = (idx: number) => {
    if (starting.current) return; // §20 起播异步窗口内忽略点卡:否则并发 loadSession 与起播的重灌交错,引擎混入别的场景
    if (idx === sessionIdx && pendingIdx === null) return;
    const e = eng.current;
    if (!e || !e.isPlaying()) {
      cancelSongSchedule(); clearSolo(); e?.stopAudition(); setPendingIdx(null); setPlaying(false); setSongActiveIds(new Set());
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
    if (eng.current?.isPlaying()) { cancelSongSchedule(); eng.current.stopTransport(); setPendingIdx(null); setPlaying(false); setSongActiveIds(new Set()); }
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
    const snapped = resnapSong(next); // §37 唯一重算入口:主轨吸附 startBar 派生 / sub 锚定跟随 / 孤儿保留;放在 setSessions 前,下游(播放头/调度/持久化)读派生好的绝对位置
    const curId = sessionsRef.current[sessionIdx]?.id;
    const playId = playingRef.current ? sessionsRef.current[playingIdxRef.current]?.id : undefined; // §26 播放块也按 id 锚:播放中增删/重排别的块会移动它的下标,不重锚则播放头(cum[playingIdx])与高亮漂到错块 = 进度条跑偏
    pushHistory(); setSessions(snapped);
    if (curId) { const ni = snapped.findIndex((s) => s.id === curId); if (ni >= 0 && ni !== sessionIdx) setSessionIdx(ni); }
    if (playId) { const pi = snapped.findIndex((s) => s.id === playId); if (pi >= 0 && pi !== playingIdxRef.current) { playingIdxRef.current = pi; setPlayingIdx(pi); } }
    if (playingRef.current && playModeRef.current === 'song') {
      sessionsRef.current = snapped;
      const bar = eng.current?.currentBar() ?? 0;
      const active = songActiveAt(snapped, bar);
      setSongActiveIds(new Set(active.map((s) => s.id)));
      scheduleNextSongBoundary(bar);
    }
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
    if (oldR === next) return; // 没变:不压空 undo、不重排调度
    const patch: Partial<Pick<Session, 'repeats' | 'xyAuto' | 'volAuto'>> = { repeats: next };
    const r = next / oldR;
    if (s?.xyAuto) { const set: XYAutoSet = {}; for (const p of PROG_ORDER) { const a = s.xyAuto[p]; if (a) set[p] = rescaleAuto(a, r); } patch.xyAuto = set; } // #2 改 repeat → 每条 automation 按比例缩放点重分布
    if (s?.volAuto) patch.volAuto = s.volAuto.map((pt) => ({ ...pt, bar: pt.bar * r })); // §41 音量曲线同样按比例缩放(对齐 §26 rescaleAuto;一维直接 map bar)
    mutateSessionsKeepActive(patchSession(sessionsRef.current, id, patch)); // #4 调度/ref 已在 mutateSessionsKeepActive 内按 resnap 后的派生位置重排;此前这里又用未 resnap 的 updated 覆盖 ref + 重排 = 这一拍调度跑在陈旧位置上
  };
  const setSessionColor = (id: string, color: string) => { if (sessionsRef.current.find((x) => x.id === id)?.color === color) return; mutateSessionsKeepActive(patchSession(sessionsRef.current, id, { color })); }; // 选同色不压空 undo 步
  // §37 指针拖拽:lane 命中(钉 lanes 容器顶,clamp 现有 lane 数)
  const songLaneAt = (clientY: number): number => {
    const el = songLanesRef.current; if (!el) return 0;
    return Math.max(0, Math.min(songLanes - 1, Math.floor((clientY - el.getBoundingClientRect().top) / songLaneH)));
  };
  // §37 指针 X → 绝对小节(鼠标真实位置;lanes 容器是滚动内容,其 rect.left 自带滚动偏移 → 不用加 scrollLeft)。主轨 reorder 用它当插入判据。
  const songBarAt = (clientX: number): number => {
    const el = songLanesRef.current; if (!el) return 0;
    return Math.max(0, (clientX - el.getBoundingClientRect().left) / songZoomRef.current);
  };
  const cloneSessionDeep = (src: Session): Session => ({ ...src, id: nid('sess'), index: sessionsRef.current.length, songAnchorId: null, songOffsetBar: 0, color: pickSessionColor(sessionsRef.current), instruments: src.instruments.map((i) => cloneInstrument(i, nid)) }); // §37 复制=新场景,取不撞色(不继承源色)
  const commitSongDrag = (id: string, vbar: number, vlane: number, clone: boolean, cursorBar: number) => {
    const list = sessionsRef.current;
    const src = list.find((s) => s.id === id); if (!src) return;
    if (playingRef.current && playModeRef.current === 'song') { cancelSongSchedule(); eng.current?.stopTransport(); setPlaying(false); setSongActiveIds(new Set()); }
    let next = list, workId = id;
    if (clone) { const cl = cloneSessionDeep(src); next = [...list, cl]; workId = cl.id; } // Alt=复制成独立 session(全新 id/乐器)
    if (vlane === 0) { // → 主轨:转主块(清锚)+ 按【鼠标所在小节】插入吸附序列(reorder 看指针,不看块左缘)
      next = patchSession(next, workId, { songLane: 0, songAnchorId: null, songOffsetBar: 0 });
      next = moveMainTo(next, workId, mainInsertIndex(next, cursorBar, workId));
    } else { // → sub:落点重锚(落主轨外=孤儿),reps 清 1(sub 不能 repeat)
      // §37 子轨禁止移动叠放:落点 [sb, sb+bars) 与同 lane 其他块相交 → 放置失败、弹回原位(叠放会一起出声,见 songActiveAt)。
      // #2 判定坐标必须 = 真实落点:别手算夹后位(主→sub 时块锚到自己→锚失效→落成孤儿 @裸 vbar、不夹,手算会偏)。
      //   subDropLanding = commit/单测共用纯函数:套同款 resnap 管线(被拖块排除出 #1 让位)算真实落点 + 叠放。
      if (subDropLanding(next, workId, vbar, vlane).overlap) {
        setStatus('放置失败:子轨 session 不能与同轨其他块重叠'); return; // 不提交 → 块弹回(songDrag 已在 up 清空,渲染回到已提交位置)
      }
      next = patchSession(next, workId, anchorPatchAt(next, vbar, vlane));
    }
    mutateSessionsKeepActive(next);
  };
  const songBlockDown = (e: React.PointerEvent, s: Session, idx: number) => {
    if (renamingId === s.id || e.button !== 0) return;
    if ((e.target as HTMLElement).closest('.sblk-rs')) return; // 右缘 resize 自理
    switchSession(idx); // 点即选
    songDragRef.current = { id: s.id, grabX: e.clientX, origStart: sessionSongStartBar(s), clone: e.altKey && isMainLane(s), moved: false, vbar: sessionSongStartBar(s), vlane: sessionSongLane(s), cursorBar: songBarAt(e.clientX) };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    setSongDrag({ id: s.id, vbar: songDragRef.current.vbar, vlane: songDragRef.current.vlane, clone: songDragRef.current.clone, cursorBar: songDragRef.current.cursorBar });
  };
  const songBlockMove = (e: React.PointerEvent) => {
    const d = songDragRef.current; if (!d) return;
    const vbar = Math.max(0, d.origStart + Math.round((e.clientX - d.grabX) / songZoomRef.current));
    const vlane = songLaneAt(e.clientY);
    const cursorBar = songBarAt(e.clientX); // 鼠标真实小节(主轨 reorder 判据;vbar 仅供浮块跟手)
    if (!d.moved && Math.abs(e.clientX - d.grabX) < 4 && vlane === d.vlane) return; // 阈值内不算拖(留给 click 选/改名)
    d.moved = true; d.vbar = vbar; d.vlane = vlane; d.cursorBar = cursorBar;
    setSongDrag({ id: d.id, vbar, vlane, clone: d.clone, cursorBar });
  };
  const songBlockUp = () => {
    const d = songDragRef.current; songDragRef.current = null; setSongDrag(null);
    if (d && d.moved) commitSongDrag(d.id, d.vbar, d.vlane, d.clone, d.cursorBar);
  };
  // §37 右缘拖拽改 repeat(仅主轨;拖时 transient 预览,松手一次落库=一条 undo)
  const songResizeDown = (e: React.PointerEvent, s: Session) => {
    e.stopPropagation(); e.preventDefault();
    songResizeRef.current = { id: s.id, grabX: e.clientX, bars: sessionBars(s), origReps: sessionRepeats(s) };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    setSongResize({ id: s.id, reps: sessionRepeats(s) });
  };
  const songResizeMove = (e: React.PointerEvent) => {
    const r = songResizeRef.current; if (!r) return;
    const dR = Math.round((e.clientX - r.grabX) / Math.max(1, r.bars * songZoomRef.current));
    setSongResize({ id: r.id, reps: Math.max(1, Math.min(16, r.origReps + dR)) });
  };
  const songResizeUp = () => {
    const r = songResizeRef.current, cur = songResize; songResizeRef.current = null; setSongResize(null);
    if (r && cur && cur.reps !== r.origReps) setSessionRepeats(r.id, cur.reps);
  };
  // §37 拖动中预览布局:把进行中的 move/resize 套到 sessions 副本上 resnap(不落库),让【其他】块在拖动中实时跟随(主轨重排吸附 / 联动 sub 跟随),而非落位才变。
  const dragPreview = useMemo(() => {
    try {
      if (songResize) return resnapSong(patchSession(sessions, songResize.id, { repeats: songResize.reps }));
      if (songDrag) {
        const id = songDrag.id; let next = sessions;
        if (songDrag.vlane === 0) { next = patchSession(next, id, { songLane: 0, songAnchorId: null, songOffsetBar: 0 }); next = moveMainTo(next, id, mainInsertIndex(next, songDrag.cursorBar, id)); }
        else next = patchSession(next, id, anchorPatchAt(next, songDrag.vbar, songDrag.vlane));
        return resnapSong(next, id); // 拖动中的块排除出 #1 让位:预览落点 = 真实落点,与松手时的叠放判定/落库一致(不会预览说能放、松手又弹回)
      }
    } catch { /* 预览容错:出错就退回已提交布局 */ }
    return sessions;
  }, [sessions, songDrag, songResize]);
  const posById = useMemo(() => {
    const m = new Map<string, { start: number; lane: number; reps: number }>();
    for (const s of dragPreview) m.set(s.id, { start: sessionSongStartBar(s), lane: sessionSongLane(s), reps: sessionRepeats(s) });
    return m;
  }, [dragPreview]);
  // §37 邻接判定:同 lane 内有别的 session 末端正好接到本块起点 → 本块去掉左边框(相连处不画双线)。按预览布局算 → 拖动中也即时。
  const joinLeft = useMemo(() => {
    const set = new Set<string>(); const byLane = new Map<number, { start: number; end: number; id: string }[]>();
    // 主轨与子轨同理:同 lane 内首尾相接的块去掉后块左框(相连处不画双线);各 lane 独立分组,不跨轨连体
    for (const s of dragPreview) { const lane = sessionSongLane(s); const arr = byLane.get(lane) ?? (byLane.set(lane, []), byLane.get(lane)!); arr.push({ start: sessionSongStartBar(s), end: sessionSongEndBar(s), id: s.id }); }
    for (const arr of byLane.values()) for (const a of arr) if (arr.some((b) => b.id !== a.id && Math.abs(b.end - a.start) < 1e-6)) set.add(a.id);
    return set;
  }, [dragPreview]);
  // §37 命名 track:取显示名/色(未自定义回退默认),改名/换色(乐观持久化 + 进 undo)。
  const laneName = (lane: number) => songTracks[lane]?.name || (lane === 0 ? 'Main' : 'Sub ' + lane);
  const laneColor = (lane: number) => songTracks[lane]?.color ?? null;
  const setLane = (lane: number, patch: Partial<SongLane>) => {
    pushHistory();
    const next = songTracksRef.current.slice();
    while (next.length <= lane) next.push({ id: nid('lane'), name: next.length === 0 ? 'Main' : 'Sub ' + next.length, color: null });
    next[lane] = { ...next[lane], ...patch };
    setSongTracks(next);
    api.projects.update(projectId, { songLanes: next }).catch(() => {});
  };
  // §37 分隔条:拖动改 arranger(track 区)高度,pad(乐器区)吃剩余。clamp:≥1 条 track+标尺,≤ 视口减底部。
  const splitterDown = (e: React.PointerEvent) => {
    e.preventDefault();
    const startY = e.clientY, startH = arrangerHc; // 从钳过的当前高起拖(避免越界值起跳)
    let finalH = startH;
    const mv = (ev: PointerEvent) => { finalH = Math.max(songMinH, Math.min(songMaxH, startH + (ev.clientY - startY))); setArrangerH(finalH); };
    const up = () => { window.removeEventListener('pointermove', mv); window.removeEventListener('pointerup', up); document.body.style.cursor = ''; try { localStorage.setItem('songArrangerH', String(Math.round(finalH))); } catch { /* */ } };
    document.body.style.cursor = 'ns-resize';
    window.addEventListener('pointermove', mv); window.addEventListener('pointerup', up);
  };
  useEffect(() => { try { const v = localStorage.getItem('songArrangerH'); if (v && Number(v) >= 96) setArrangerH(Number(v)); } catch { /* */ } }, []); // §37 恢复上次 arranger 高(localStorage,免 SSR 水合不一致 → 用 effect 而非 lazy init)
  useEffect(() => { const el = stageRef.current; if (!el) return; const upd = () => setStageH(el.clientHeight); upd(); const ro = new ResizeObserver(upd); ro.observe(el); window.addEventListener('resize', upd); return () => { ro.disconnect(); window.removeEventListener('resize', upd); }; }, []); // §37 量 stage 高(随窗口/底部编辑器变)→ arranger 上限
  // §26.v3 Song XY 自动化:改 session.xyAuto[program]。激活=自动判定——**非平才入 map,平则删该键**(=失效);全空 → null。无显式插入/toggle:在 lane 上画即激活。history=false → 实时更新不压栈(画线拖每帧)。活动场景不变。
  const changeXyAuto = (id: string, program: XYProgram, auto: XYAutomation | null, history = false) => {
    if (history) pushHistory();
    const s = sessionsRef.current.find((x) => x.id === id);
    const set: XYAutoSet = { ...(s?.xyAuto ?? {}) };
    if (auto && isActiveAuto(program, auto)) set[program] = auto; else delete set[program]; // 拉平=回未激活=移除
    setSessions(patchSession(sessionsRef.current, id, { xyAuto: Object.keys(set).length ? set : null }));
  };
  // §41 Song 音量自动化:改 session.volAuto(一维断点)。激活=自动判定(isActiveVol:非满音量平线才存,拉回 unity=删=null)。镜像 changeXyAuto:history=false 实时不压栈,活动场景不变。
  const changeVolAuto = (id: string, points: AutoPoint[] | null, history = false) => {
    if (history) pushHistory();
    setSessions(patchSession(sessionsRef.current, id, { volAuto: isActiveVol(points) ? points : null }));
  };

  // §26.4 单一仲裁 coordinator:唯一驱动引擎 XY 的地方(手动板退化成只写 xyManual ref)。常驻 rAF(Live 也跑,处理手动 + 接管)。
  // per-effect 优先级 手动 > 自动化 > 旁路;松手:spring 在 springMs 内交还滑回「地面」(自动线当前值 / 无则 NEUTRAL→旁路),latch 冻结在松手值。
  useEffect(() => {
    let raf = 0;
    type Src = 'manual' | 'auto' | 'glide' | 'latch' | 'bypass';
    const rt: Record<string, { prev: Src; t0: number; fx: number; fy: number; px: number; py: number }> = {};
    for (const p of PROG_ORDER) rt[p] = { prev: 'bypass', t0: 0, fx: 0.5, fy: 0, px: NaN, py: NaN }; // px/py=上帧已推给引擎的值;NaN=未推
    // ⚡ 去重推值:auto/latch 稳态逐帧推**同一** (x,y) → 每帧重排一条 20ms biquad rampTo = 无谓 AudioParam 事件洪流。
    //   ε 内未变则跳过(滤波 Q/freq 不再每帧重排);手动/glide 帧帧变,push 照发。旁路/复位时把 px 置 NaN,重新接管必推。
    const EPS = 1e-3;
    const pushXY = (en: import('@/audio/studioEngine').StudioEngine, program: XYProgram, x: number, y: number): void => {
      const st = rt[program];
      if (Math.abs(x - st.px) < EPS && Math.abs(y - st.py) < EPS) return;
      st.px = x; st.py = y; en.xySetValue(program, x, y);
    };
    let lastClear = xyClearRef.current;
    const tick = (now: number) => {
      const e = eng.current;
      if (e) {
        const cfg = fxRef.current.xy, m = xyManual.current;
        if (xyClearRef.current !== lastClear) { lastClear = xyClearRef.current; for (const p of PROG_ORDER) rt[p].prev = 'bypass'; } // 复位请求(关板/卸载/undo):清 latch/glide,下面按 手动/自动化/旁路 重判
        const songMode = playingRef.current && playModeRef.current === 'song';
        const block = (cfg.on && songMode) ? sessionsRef.current[playingIdxRef.current] : null;
        const set = block?.xyAuto ?? null;
        const localBar = songMode ? Math.max(0, e.songPosBars() - songLapBars.current - songBlockStart.current) : 0; // §39 扣圈偏移:走带单调递增,song-bar = songPosBars − songLapBars
        for (const program of PROG_ORDER) {
          const st = rt[program];
          if (!cfg.on) { e.xySetActive(program, false); st.prev = 'bypass'; st.px = NaN; continue; }
          if (!playingRef.current && !(m.down && m.program === program)) { e.xySetActive(program, false); st.prev = 'bypass'; st.px = NaN; continue; } // 停播且非手动 → 旁路:清掉 latch/glide,否则按停后 latch 效果永远卡 wet(stopTransport 不碰 XY)
          const auto = set?.[program];
          const autoOn = !!(auto && auto.x.length && auto.y.length); // §26.v3 map presence=激活(非平,changeXyAuto/normalize 守门),热路径不重算 isActiveAuto
          const ground = (): { x: number; y: number } => (autoOn ? sampleXY(program, auto!, localBar) : { x: NEUTRAL[program].x, y: NEUTRAL[program].y });
          if (m.down && m.program === program) { // ① 手动接管该效果
            pushXY(e, program, m.x, m.y); e.xySetActive(program, true); // 平滑斜坡(20ms):biquad 滤波器快变会 click,一律慢变
            st.prev = 'manual'; st.fx = m.x; st.fy = m.y; continue;
          }
          if (st.prev === 'manual') { if (cfg.mode === 'latch') st.prev = 'latch'; else { st.prev = 'glide'; st.t0 = now; } } // 刚松手 → latch 冻结 / spring 起滑
          if (st.prev === 'latch') { pushXY(e, program, st.fx, st.fy); e.xySetActive(program, true); continue; }
          if (st.prev === 'glide') { // 交还滑行:手位 → 地面值
            const e01 = Math.min(1, (now - st.t0) / Math.max(30, cfg.springMs)), k = 1 - Math.pow(1 - e01, 3), g = ground();
            pushXY(e, program, st.fx + (g.x - st.fx) * k, st.fy + (g.y - st.fy) * k); e.xySetActive(program, true);
            if (e01 >= 1) st.prev = autoOn ? 'auto' : 'bypass';
            continue;
          }
          if (autoOn) { const { x, y } = sampleXY(program, auto!, localBar); pushXY(e, program, x, y); e.xySetActive(program, true); st.prev = 'auto'; } // ② 自动化(平滑斜坡;起播由 prime 盖好,块边界平滑过渡不 click)
          else { e.xySetActive(program, false); st.prev = 'bypass'; st.px = NaN; } // ③ 旁路
        }
        // §41 音量自动化:逐**出声块**各按自己的 volAuto 驱动自己的 sessionGain(多轨同时发声各缩各的;与 XY 只驱动前景块不同)。
        //   localBar 用每块**自己**的 songStartBar 算(§39 扣圈);无 volAuto 的块 = unity(setSessionGain EPS 去重→no-op)。停播态由 stopTransport 复位,不在此碰。
        if (songMode) {
          const lap = songLapBars.current, posBar = e.songPosBars();
          for (const s of sessionsRef.current) {
            if (!playingSongIdsRef.current.has(s.id)) continue;
            const lb = Math.max(0, posBar - lap - sessionSongStartBar(s));
            const v = (s.volAuto && s.volAuto.length) ? sampleAuto(sortPoints(s.volAuto), lb) : VOL_NEUTRAL;
            e.setSessionGain(s.id, volGain(v));
          }
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => { cancelAnimationFrame(raf); eng.current?.xyReleaseAll(); };
  }, []);
  // §37 子轨副本落位:同 lane、紧贴原块之后的第一个空档(不够则顺次贴到下一块之后)→ anchorPatchAt 定锚。
  //   主轨副本不走这条(走 duplicateSessionAt 的吸附序列插队)。修「子轨 ⌘D 复制体跑到原块前面」:旧逻辑复制了 src 的锚+offset,resnap 把它拽回原位再被 #1 让位推到左边。
  const placeSubDuplicate = (list: Session[], src: Session | undefined, copy: Session): Session => {
    if (!src || isMainLane(src)) return copy;
    const start = nextFreeSubStart(list, sessionSongLane(src), sessionSongEndBar(src), sessionBars(src));
    return { ...copy, ...anchorPatchAt(list, start, sessionSongLane(src)) };
  };
  const duplicateSession = (idx: number) => { const list = sessionsRef.current; const { sessions: ns, newIndex } = duplicateSessionAt(list, idx, nid); ns[newIndex] = placeSubDuplicate(list, list[idx], { ...ns[newIndex], color: sessionColor(list[idx]) }); mutateSessionsKeepActive(ns); }; // 复制继承源场景显示色(主/sub 同);sessionColor 解析 explicit 或 id 稳定兜底;子轨副本紧贴原块之后
  const duplicateSessionOnce = (idx: number) => { const list = sessionsRef.current; const { sessions: ns, newIndex } = duplicateSessionAt(list, idx, nid); ns[newIndex] = placeSubDuplicate(list, list[idx], { ...ns[newIndex], repeats: 1, color: sessionColor(list[idx]) }); mutateSessionsKeepActive(ns); }; // 标题栏 ⧉:复制本 scene 但只留 1 个 repeat,插在其后;继承源场景显示色;子轨副本紧贴原块之后
  // §26 session 剪贴板(⌘C/⌘V;同工程内,粘贴=末尾追加独立副本,乐器全新 id、引用同库素材)。
  const sessionClipRef = useRef<Session | null>(null);
  const copySession = (idx: number) => { const s = sessionsRef.current[idx]; if (s) { sessionClipRef.current = s; setStatus(`Copied session “${s.name}”`); } };
  const pasteSession = () => {
    const src = sessionClipRef.current; if (!src) return;
    const copy: Session = { ...src, id: nid('sess'), index: sessionsRef.current.length, songStartBar: sessionSongEndBar(src), color: pickSessionColor(sessionsRef.current), instruments: src.instruments.map((i) => cloneInstrument(i, nid)) }; // §37 粘贴=新场景,取不撞色
    mutateSessionsKeepActive([...sessionsRef.current, copy]); setStatus(`Pasted session “${copy.name}”`);
  };
  const addNewSession = () => {
    const color = pickSessionColor(sessionsRef.current); // §37 取当前最少用的色=不撞;存进 s.color → 生成即定、永不洗牌
    const { sessions: ns } = docAddSession(sessionsRef.current, nid, `Scene ${sessionsRef.current.length + 1}`, color);
    pushHistory(); setSessions(resnapSong(ns)); // §37 新场景在末尾 → resnap 让它吸附接到主轨尾;活动场景不动
  };
  const removeSession = (idx: number) => {
    const list = sessionsRef.current;
    if (list.length <= 1) return; // 至少留一个场景
    const curId = list[sessionIdx]?.id;
    const playId = playingRef.current ? list[playingIdxRef.current]?.id : undefined;
    const removingPlaying = playingRef.current && idx === playingIdxRef.current; // 删的正是正在出声的块
    const ns = resnapSong(removeSessionAt(list, idx)); // §37 删除必须重算:主轨塌缩吸附 + 锚到被删块的 sub 降级孤儿(冻结绝对位置)
    pushHistory(); setSessions(ns);
    if (idx === sessionIdx) {
      const nextIdx = Math.min(idx, ns.length - 1);
      cancelSongSchedule(); clearSolo(); eng.current?.stopTransport(); eng.current?.stopAudition(); setPendingIdx(null); setPlaying(false); setSongActiveIds(new Set());
      setSessionIdx(nextIdx); setSelId(null); setSelClipId(null); setLibSel(null);
      loadSession(ns[nextIdx]).then(() => setTick((t) => t + 1));
    } else {
      if (curId) { const ni = ns.findIndex((s) => s.id === curId); if (ni >= 0 && ni !== sessionIdx) setSessionIdx(ni); }
      if (removingPlaying) { // §26 删了正在出声但非查看的块(Song 钉住视图)→ 干净停播,免播放头无主漂移、声音拖到块末才停
        cancelSongSchedule(); clearSolo(); eng.current?.stopTransport(); eng.current?.stopAudition(); setPendingIdx(null); setPlaying(false); setSongActiveIds(new Set());
      } else if (playId) { // 删的是出声块前面的块 → 出声块下标左移,按 id 重锚播放头/高亮,否则 cum[playingIdx] 漂到错块
        const pi = ns.findIndex((s) => s.id === playId); if (pi >= 0 && pi !== playingIdxRef.current) { playingIdxRef.current = pi; setPlayingIdx(pi); }
      }
    }
  };
  const requestRemoveSession = async (idx: number) => {
    const s = sessionsRef.current[idx]; if (!s) return;
    if (sessionsRef.current.length <= 1) { setStatus('At least one session is required'); return; }
    if (await askConfirm({ title: 'Delete session', message: `Delete session "${s.name}" and its ${s.instruments.length} instrument(s)?`, confirmLabel: 'Delete', danger: true })) removeSession(idx);
  };

  // §20:查看场景是否 == 正在出声的块。Song 模式钉住查看非播放块时为 false —— 此时改播放态(enable/solo)绝不能碰引擎,
  //   否则会把预载的别块 voice 凭空点响 / 把正在播的块整块静音(违反「同时只一个块出声」)。Live 模式播放块恒 = sessionIdx。
  const viewingSoundingBlock = () => playModeRef.current !== 'song' || playingSongIdsRef.current.has(sessionsRef.current[sessionIdx]?.id ?? '');

  // §18 独奏(瞬态):改集合 → 推引擎 setSolo;副作用在 setState updater 外只跑一次(同 undo 机制坑,见 §16)。
  const applySolo = (next: Set<string>) => { soloRef.current = next; setSoloIds(next); eng.current?.setSolo(next); setTick((t) => t + 1); };
  // 用户点 S:只对正在出声的块生效。Song 钉住看非播放块时忽略 —— solo 是实时监听工具,只对听得到的块有意义;
  //   若放行,setSolo 会重算全引擎 voice:把预载的该非播放块 voice 点响 + 让正在播的块(不在 soloIds 里)被遮罩静音。
  const toggleSolo = (id: string) => { if (!viewingSoundingBlock()) return; const next = new Set(soloRef.current); if (next.has(id)) next.delete(id); else next.add(id); applySolo(next); };
  const clearSolo = () => { if (soloRef.current.size) applySolo(new Set()); };
  // §18 重灌后保留 solo:loadSession 的 clearAll 抹了引擎 soloIds —— solo 是瞬态但应**跨停/起走带常驻**(同 ▶),
  //   故重播不复位,而是把仍存活于本场的 solo 重新推回引擎。跨块残留(soloIds 装的是别块乐器 id)被过滤掉 → solo 收敛。
  const reapplySoloFor = (ids: string[]) => {
    if (!soloRef.current.size) return;
    const idset = new Set(ids);
    const survivors = new Set([...soloRef.current].filter((id) => idset.has(id)));
    if (survivors.size < soloRef.current.size) applySolo(survivors); // 有失效 id → 同步 React+引擎+重渲
    else eng.current?.setSolo(survivors);                            // 全存活(同场重播)→ 只推引擎,React 态不变、免多余重渲
  };

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
    setSelClipId(null); // 选中乐器=只选乐器,不预选片:Del/⌘D 作用于乐器本身(与别的 pad 一致,不再先删里面的片)。底部编辑器仍默认展示最左片(arrangeInst 分支里派生,纯展示、arrange 不高亮);点片才真选中 → 此时 Del 删该片。
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
      selectInst(id);
      return;
    }
    // 走带停 + 已选中该乐器 + 无多选 → 第二次点 = 试听切换(§28 previewInst,自带 toggle:再点停);否则选中(selectInst 会停掉上一个试听)。
    if (!playing && selId === id && !markedIds.size) { previewInst(id); return; }
    setMarkedIds(new Set());
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
    const sess = sessionsRef.current[sessionIdx];
    const insts = sess ? resolveInstruments(sess) : [];
    // ⚠ Song 模式下别块 voice 也常驻引擎(预载):换速若只认 viewed 会话,别块仍是旧 warp 而 transport 已翻速 → 漂移到被切换才修。
    //   故解析口径在 Song 模式扩到所有会话的乐器(播放时让 retempo 回调能渲到别块;停时重渲所有常驻 voice)。
    const lookupInsts = playModeRef.current === 'song' ? sessionsRef.current.flatMap((s) => resolveInstruments(s)) : insts;
    const instById = new Map(lookupInsts.map((i) => [i.id, i]));
    if (e.isPlaying()) {
      // 走带在跑:协调到下一小节边界无缝换速(§6 —— transport 翻速 + 各乐器同边界保相位换 buffer;未渲完者 playbackRate 顶速过渡,就绪即换)。
      e.retempoPlaying(next, (id) => { const inst = instById.get(id); return inst ? buildBuffer(inst, next, nc.soundsById) : Promise.resolve(null); });
      setStatus(`Switched to ${next} BPM`);
    } else {
      // 停时:transport 直接跟随 + 逐乐器就地换 buffer(无声可断)。viewed 会话 + 所有常驻 voice 都重渲。
      e.setBpm(next);
      setStatus(`Master BPM → ${next} · re-rendering instruments…`);
      const toRender = playModeRef.current === 'song'
        ? [...new Map([...insts, ...lookupInsts.filter((i) => e.hasVoice(i.id))].map((i) => [i.id, i])).values()]
        : insts;
      Promise.all(toRender.map((inst) => loadInstrumentToEngine(inst, true).catch(() => {}))).then(() => { setStatus(`Switched to ${next} BPM`); setTick((t) => t + 1); });
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
    const tok = en.nextAuditionToken(); // §28.7 防陈旧:await 期间发生 stop / 更新预览则作废本次(并标记"加载中"供空格识别)
    const warmT = setTimeout(() => setWarming(id), 120); // ⑥ 命中缓存(<120ms)直接出声、不闪 spinner
    try {
      await en.resume();
      const buf = await warpToBuffer(s, c.bpm, regionFromClip(soundToClip(s))); // 走种子 Clip(含 timeMul),与建乐器后一致
      if (en.auditionStale(tok)) return; // §28.7 warp 期间被 stop / 新预览顶掉 → 不出声(否则停不下来/错位)
      en.audition(id, buf, undefined, en.isPlaying(), (startPhase ?? 0) * buf.duration); // §28 startPhase→从起播线偏移;走带在跑则量化跟随 bar
    } finally {
      clearTimeout(warmT); setWarming((w) => (w === id ? null : w)); en.clearAuditionPending(tok); // §28.7 按令牌清 pending(防抛错泄漏)
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
  // §37 Song 视图偏好:缩放 / 网格密度改即乐观持久化 gridPrefs(防抖 300ms,合并滑块/滚轮连续变化;§15.A 同 gridPrefs 套路)。视图态不进 undo(§16:缩放/网格=视图,排除)。
  // songZoom/songGrid 持久化已移进 <SongZoomScope>(防抖 + 首帧不回写),见 persistGrid。
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
          try { const d = await decodeAsset(snd.assetId); if (!alive) return; pk = peaksFromRegion(d.channels, r.startSample, r.endSample); lanePeaksCache.set(key, pk); } catch { continue; }
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
  // §34 粘贴入库:剪贴板里的音频文件(Splice ⌘C / Finder 复制的)→ 入库(§27 管线,自带运行态+检测)+ 自动建单 sample 乐器落空 pad。
  // 只收 wav/mp3 —— 对齐 /api/uploads 的 OK_TYPES + 上传按钮 accept;收别的格式(aiff/m4a/ogg/flac)会在服务端 415 = "Paste failed"。
  const AUDIO_EXT_RE = /\.(wav|mp3)$/i;
  const isAudioFile = (f: File) => /^audio\/(wav|x-wav|wave|vnd\.wave|mpeg|mp3)$/.test(f.type) || AUDIO_EXT_RE.test(f.name);
  const importPastedAudio = async (files: File[]) => {
    if (!files.length) return;
    setStatus(files.length > 1 ? `Pasting ${files.length} samples…` : 'Pasting sample…');
    const slots = freeSlots(sessionsRef.current[sessionIdx], files.length); // 一次性算好 n 个空位按 index 落位(别边建边重算,免撞位)
    let made = 0, padsFull = 0, failed = 0, lastErr = '';
    for (let i = 0; i < files.length; i++) {
      try {
        const soundId = await uploadToLibrary(projectId, files[i], genHooks()); // await 完检测;reload 已把新 sound 写回 soundsById,故可直接建乐器
        if (!soundId) { failed++; continue; }
        const slot = slots[i];
        if (slot == null) { padsFull++; continue; } // 入库成功但 pad 满 → 只进库、不建乐器
        addSampleFromSound(soundId, slot); made++;
      } catch (e) { failed++; lastErr = conciseError(e); } // 单条失败不中断其余;最后汇总,别让成功盖掉失败(免部分丢样静默)
    }
    if (!made && !padsFull) { setStatus(failed ? 'Paste failed' + (lastErr ? ': ' + lastErr : '') : 'Nothing pasted'); return; }
    const bits: string[] = [];
    if (made) bits.push(`${made} → pad${made > 1 ? 's' : ''}`);
    if (padsFull) bits.push(`${padsFull} → library (pads full)`);
    if (failed) bits.push(`${failed} failed`);
    setStatus('Pasted ' + bits.join(' · '));
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
  // §33.6 重切:总览改「每块」→ 重跑 chopSong 替换块(reload 后 ChopView 自动重渲;libSel 仍是歌 → 总览不退)。
  const rechopBlocks = async (song: ApiSound, blocks: ApiSound[], opts: { blockBars: number }) => {
    if (chopBusy) return;
    setChopBusy(true);
    try { await rechopSong(song, blocks, opts, async () => { await reloadLibrary(); await refreshGens(); }); setStatus('Re-chopped'); }
    catch (e) { setStatus('Re-chop failed: ' + conciseError(e)); }
    finally { setChopBusy(false); }
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
    const next = patchCollageClip(cur, instId, clip.id, { startSample: clip.startSample, endSample: clip.endSample, bars, timeMul: clip.timeMul, warpPts: clip.warpPts, semitones: clip.semitones, fadeOutBars: clip.fadeOutBars, fadeSilenceBars: clip.fadeSilenceBars, gainDb: clip.gainDb });
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
    const tok = e.nextAuditionToken(); // §28.7 防陈旧:同 auditionSound
    try {
      await e.resume();
      const buf = await warpToBuffer(s, c.bpm, regionFromClip(clip));
      if (e.auditionStale(tok)) return; // §28.7 warp 期间被 stop / 新预览顶掉 → 不出声
      e.audition(clip.id, buf, { mixer: clipMixer(clip) }, false, (startPhase ?? 0) * buf.duration); setTick((t) => t + 1);
    } finally {
      e.clearAuditionPending(tok); // §28.7 按令牌清 pending(防抛错泄漏)
    }
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
    const inst0 = cur.instruments.find((i) => i.id === instId);
    // §28.8 守卫(对齐 editSoundRegion):ClipEditor 在「选中/换素材/analysis 到达」重挂时会回流一次 emit。
    //   命门:粘贴/拖建乐器后 setSelId 选中它 → ClipEditor 挂载即 emit;若不早退会多触发一次 seamless 重载,
    //   它与初始 load 抢 buildSeq —— 大文件(慢 build)下初始 load 被判废、seamless 分支又因还没 voice 而 no-op
    //   → 乐器**永久无 voice**(预览/走带都不出声,要刷新)。无实质改动直接早退:不压栈、不落库、不重载引擎。
    if (inst0?.payload.kind === 'sample') {
      const o = inst0.payload.clip;
      if (o.startSample === clip.startSample && o.endSample === clip.endSample && o.bars === clip.bars
          && (o.timeMul ?? 1) === (clip.timeMul ?? 1) && (o.semitones || 0) === (clip.semitones || 0)
          && (o.fadeOutBars || 0) === (clip.fadeOutBars || 0) && (o.fadeSilenceBars || 0) === (clip.fadeSilenceBars || 0)
          && (o.gainDb || 0) === (clip.gainDb || 0)
          && warpPtsSig(o.warpPts) === warpPtsSig(clip.warpPts)) return; // §36:marker-only 改动也得过;用 warpPtsSig(beat 取 3 位)比,免非整数拍 FP 往返微差触发假重渲
    }
    const next = cur.instruments.map((i) => (i.id === instId && i.payload.kind === 'sample' ? { ...i, payload: { kind: 'sample' as const, clip } } : i));
    pushHistory();
    updateSession({ ...cur, instruments: next });
    const inst = next.find((i) => i.id === instId); if (inst) loadInstrumentToEngine(inst, true);
  };
  // 预调:ClipEditor 吐完整 Clip → 写回 Sound.warp(种子,同 Clip 同形:含 timeMul);出身标记 manual(库角标用)。
  const editSoundRegion = async (soundId: string, clip: Clip) => {
    const c = ctxRef.current; if (!c) return;
    const s = c.soundsById.get(soundId); if (!s) return;
    const cur = soundToClip(s); // §28.8 ClipEditor 在「选中/换素材/analysis 到达」重挂时会回流一次 emit;与现有 warp 无实质差异 → 早退:不压栈(免污染 undo)、不落库、不触发 auditionSwap(长 loop 会孤儿化正在响的 player = 停不下来)
    if (cur.startSample === clip.startSample && cur.endSample === clip.endSample && cur.bars === clip.bars
        && (cur.timeMul ?? 1) === (clip.timeMul ?? 1) && (cur.semitones || 0) === (clip.semitones || 0)
        && (cur.fadeOutBars || 0) === (clip.fadeOutBars || 0) && (cur.fadeSilenceBars || 0) === (clip.fadeSilenceBars || 0)
        && warpPtsSig(cur.warpPts) === warpPtsSig(clip.warpPts)) return; // §36:marker-only 改动也得过;warpPtsSig 比对免 FP 往返假触发
    pushHistory(); // §16:预调改 Sound.warp(快照口径②)→ 改动前压栈,可撤
    const warp: SampleWarp = { startSample: clip.startSample, endSample: clip.endSample, bars: clip.bars, timeMul: clip.timeMul, semitones: clip.semitones, fadeOutBars: clip.fadeOutBars, fadeSilenceBars: clip.fadeSilenceBars, warpPts: clip.warpPts, warpedBy: 'manual' };
    const sounds = new Map(c.soundsById); sounds.set(soundId, { ...s, warp }); // 不可变更新:免污染已压栈的快照引用
    ctxRef.current = { ...c, soundsById: sounds }; setCtx(ctxRef.current);
    api.sounds.patch(soundId, { warp }).then(() => refreshGens()).catch(() => {});
    const en = eng.current; // 试听中改 region → 不停下、边界无缝换上新 trim/长度/变调(否则要停了重播才生效)
    if (en?.auditioningId() === soundId) { const buf = await warpToBuffer(s, c.bpm, regionFromClip(clip)); en.auditionSwap(soundId, buf); }
  };
  // 自动保存(§15.C:没有 Save —— 改即存,字段级细粒度 op)。
  // 当前树 vs synced 快照做 diff → 最小 op 列表 → POST /api/studio/ops;成功后 synced=target。
  // 保存锁串行化;保存期间又有改动则存完再存一次;失败退避重试。
  useEffect(() => () => { if (collageRebakeTimer.current) clearTimeout(collageRebakeTimer.current); }, []); // 卸载清掉待跑的 collage 重 bake 定时器(否则引擎已 dispose 后 setState/动引擎);自动保存/退避重试/卸载守卫已抽进 usePersistence

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

  // perf:刷新 LIBRARY 回调 ref(libCb 稳定包装器在调用时读这里 → 闭包永远是最新一渲染的)。见 libCb 定义处。
  libCbRef.current = {
    onGenBpm, onGenKey, onGenerate, onUpload, onAudition: auditionSound, onSeparate: separateSound, onRetryGen, onCancelGen, onDeleteGen, onDeleteSound,
    onSelect: (id: string) => { eng.current?.stopAudition(); focusSound(id); },
    onAssignNext: (id: string) => { const slot = (() => { let s = 0; const used = new Set(curSession.instruments.map((i) => i.slot)); while (used.has(s)) s++; return s; })(); addSampleFromSound(id, slot); },
  };

  return (
    <main className="daw" translate="no">
      <header className="tbar">
        {/* 工程 */}
        <Link href="/projects" className="ic" title="Back to projects" style={{ textDecoration: 'none' }}>←</Link>
        <ProjectNameInput name={projName} onCommit={commitProjName} />

        {/* 走带 */}
        <span className="tb-sep" />
        <button className="tp" data-on={playing} disabled={prepping} onClick={togglePlay} aria-label={prepping ? 'Loading…' : playing ? 'Stop' : 'Play'} title={prepping ? 'Preparing playback…' : undefined}>{prepping ? <span className="sg-spin" aria-hidden="true" /> : <TransportIcon stop={playing} size={12} />}</button>
        {/* §20 播放模式 + 循环整首:演奏态,紧挨播放键 */}
        <span className="seg sm">
          <button className={playMode === 'live' ? 'on' : ''} onClick={() => changePlayMode('live')}>Live</button>
          <button className={playMode === 'song' ? 'on' : ''} onClick={() => changePlayMode('song')}>Song</button>
        </span>
        {playMode === 'song' && (<button className="tp" data-on={loopSong} onClick={toggleLoopSong} title="Loop song" style={{ width: 30, fontSize: 13 }}>↻</button>)}
        <Metronome on={metroOn} vol={metroVol} iv={metroIv} onToggle={toggleMetro} onVol={changeMetroVol} onIv={changeMetroIv} />
        <TransportPos engine={e} playing={playing} loopBars={playMode === 'song' && loopSong ? songTotalBars(sessions) : 0} />{/* §39 song 循环走带单调递增 → bar 读数回绕 */}

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

        {/* §31 输出设备选择:把整条出声链路由到指定声卡/接口(偏好存 localStorage,不入库/不进 undo) */}
        <OutputDevice onSelect={(id) => { eng.current?.setOutputDevice(id).catch(() => {}); }} />

        {/* §32 总混音导出:把 Song 模式整首歌离线渲成 WAV/MP3 下载(只读快照,不落库/不进 undo) */}
        <ExportDialog
          fileName={projName}
          onStopAll={stopAllAudio}
          getInput={() => ({ sessions: sessionsRef.current, soundsById: ctxRef.current?.soundsById ?? ctx.soundsById, fx: fxRef.current, bpm: ctx.bpm, beatsPerBar: ctx.beatsPerBar, masterVolDb: masterVol })}
        />

        {/* 主总线效果器(§17):失真 / 延迟 / 混响 */}
        <span className="tb-sep" />
        <FxRack fx={fx} bpm={ctx.bpm} onFx={commitFx} onStart={pushHistory} />

        {/* §42 Master Strip:总线母带链 / 缩混(EQ / 饱和 / 宽度 + 双 VU 表 + bypass);配置走 commitFx 便车 */}
        <MasterStrip fx={fx} engine={e} playing={playing} onFx={commitFx} onStart={pushHistory} />

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

        {/* §19 桌面化:打开内嵌 suno.com 窗口(登录 / 解验证码)。仅 Electron 显示,样式同 FX/XY 顶栏按钮。 */}
        {isDesktop && (
          <>
            <span className="tb-sep" />
            <button
              className="fx-btn"
              title="打开 Suno 窗口(登录 / 解验证码)"
              aria-label="Open Suno"
              onClick={() => (window as unknown as { sunogrid?: { showSunoLogin?: () => void } }).sunogrid?.showSunoLogin?.()}
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M9 18V5l12-2v13" /><circle cx="6" cy="18" r="3" /><circle cx="18" cy="16" r="3" /></svg>
              Suno
            </button>
          </>
        )}

        {/* §44 手动版本 / 存点:图标按钮,最右。Restore=回到上一次保存(可 ⌘Z 撤销);Save=存一版(⌘S,有未保存改动时橙点) */}
        <span className="tb-sep" />
        <button className="ic ic-rev" disabled={!ckptHas} title={ckptHas ? `Restore to last saved${ckptAt ? ' · ' + relTime(ckptAt) : ''} · ⌘Z to undo` : 'No saved version yet'} aria-label="Restore to last saved version" onClick={doRevertCheckpoint}>
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 7v6h6" /><path d="M3 13a9 9 0 1 0 3-7.7L3 8" /></svg>
        </button>
        <button className="ic ic-save" data-dirty={ckptDirty || undefined} disabled={ckptSaving} title={ckptDirty ? 'Save version (⌘S) · unsaved changes' : 'Save version (⌘S)'} aria-label="Save version" onClick={doSaveCheckpoint}>
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z" /><polyline points="17 21 17 13 7 13 7 21" /><polyline points="7 3 7 8 15 8" /></svg>
          {ckptDirty && <span className="ic-dot" aria-hidden="true" />}
        </button>
      </header>

      {/* §44 存点/回退 toast:短暂提示,3s 自消 */}
      {ckptToast && (
        <div role="status" style={{ position: 'fixed', left: '50%', bottom: 24, transform: 'translateX(-50%)', zIndex: 80, display: 'flex', alignItems: 'center', gap: 9, background: 'var(--bg-2)', border: '1px solid var(--line-2)', borderLeft: '3px solid var(--acc)', borderRadius: 'var(--r)', padding: '9px 13px', fontSize: 12, color: 'var(--tx)', boxShadow: '0 8px 22px rgba(0,0,0,.5)' }}>{ckptToast}</div>
      )}

      {sync === 'error' && (
        <div role="alert" style={{ position: 'sticky', top: 0, zIndex: 60, background: '#7f1d1d', color: '#fff', padding: '6px 12px', fontSize: 12, lineHeight: 1.45, borderBottom: '1px solid #b91c1c' }}>
          ⚠ 改动没能保存到库,正在自动重试(瞬态错误退避重试,多次失败后会暂停;再做一次改动可重新触发)—— <b>现在刷新或离开会丢失未保存的 pad</b>。{saveErr ? ` 原因:${saveErr}` : ''}
        </div>
      )}

      <div className="daw-main">
        <aside className="br">
          <LoopManager
            gens={gens} selectedLoopId={libSel} previewing={auditioning != null && auditioning === libSel} warmingId={warming} peaks={libPeaks} masterBpm={ctx.bpm}
            genPrompt={gp} genMode={gmode} genLoop={gloop} genBpm={gbpm} genKey={gkey}
            onGenPrompt={setGp} onGenMode={setGmode} onGenLoop={setGloop} onGenBpm={libCb.onGenBpm} onGenKey={libCb.onGenKey}
            onGenerate={libCb.onGenerate} onUpload={libCb.onUpload} onSelect={libCb.onSelect} onAudition={libCb.onAudition} onDragSound={setDragSoundId}
            onAssignNext={libCb.onAssignNext}
            onSeparate={libCb.onSeparate} onRetryGen={libCb.onRetryGen} onCancelGen={libCb.onCancelGen} onDeleteGen={libCb.onDeleteGen} onDeleteSound={libCb.onDeleteSound} stemServiceUp={stemUp}
          />
        </aside>

        {/* perf:整个 stage section(arranger+pad)包进 SongZoomScope;zoom 改动只重渲这里,StudioApp 体/toolbar/footer/library 全不动。pad 不用 zoom 但重渲它仅 ~0.7ms,不值得为它再拆 div。 */}
        <SongZoomScope initialZoom={gridPrefs?.songZoom ?? SONG_ZOOM_DEFAULT} initialGrid={gridPrefs?.songGrid ?? 1} zoomRef={songZoomRef} onPersist={persistGrid}>
        {(songZoom, songGrid, commitZoom, setSongGrid) => {
        const songTrackW = Math.max(1, songTotalBars(sessions) * songZoom);
        return (
        <section ref={stageRef} className={'stage' + (playMode === 'song' ? ' song' : '')} style={{ minWidth: 0, paddingBottom: arrangeInst ? arrangeH + 24 : undefined }}>
          <div className="srail-sticky">
          {playMode === 'song' && (
            <div className="song-ctl">
              {/* §26 顶栏标题 = 当前选中 session:色块换色 + 点名改名(和块标题一致),后缀 bar 数。 */}
              <span className="song-ctl-l" style={{ display: 'flex', alignItems: 'center', gap: 6, textTransform: 'none', letterSpacing: 0, fontSize: 11, fontWeight: 500, color: 'var(--tx-2)' }}>
                <SessionColorDot color={sessionColor(curSession)} onPick={(c) => setSessionColor(curSession.id, c)} />
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
                    const sel = autoProgram === p && !autoVol;
                    return <button key={p} className={'fx-chip' + (sel ? ' on' : '')} style={sel ? { background: PROG_COLOR[p], borderColor: PROG_COLOR[p], color: '#1c1b19' } : undefined} title={`编辑 ${PROG_LABEL[p]} automation`} onMouseDown={(ev) => ev.preventDefault()} onClick={() => { setAutoVol(false); setAutoProgram(p); }}>{PROG_LABEL[p]}</button>;
                  })}
                  {/* §41 音量:第 5 档,与 4 效果互斥;选中 → 隐 X/Y、lane 换音量曲线 */}
                  <button className={'fx-chip' + (autoVol ? ' on' : '')} style={autoVol ? { background: VOL_COLOR, borderColor: VOL_COLOR, color: '#1c1b19' } : undefined} title="编辑音量 automation" onMouseDown={(ev) => ev.preventDefault()} onClick={() => setAutoVol(true)}>{VOL_LABEL}</button>
                </div>
                {/* onMouseDown preventDefault:点选后不夺焦点 → 不留浏览器 focus 圈(键盘 Tab 仍可聚焦,a11y 不丢) */}
                {!autoVol && ( /* §41 音量是一维,选中音量时不出 X/Y 轴切换 */
                <div className="seg sm" role="group" aria-label="Automation axis (编辑用)">
                  <button className={autoAxis === 'x' ? 'on' : ''} onMouseDown={(ev) => ev.preventDefault()} onClick={() => setAutoAxis('x')}>X</button>
                  <button className={autoAxis === 'y' ? 'on' : ''} onMouseDown={(ev) => ev.preventDefault()} onClick={() => setAutoAxis('y')}>Y</button>
                </div>
                )}
              </>)}
              {/* §26.10 automation UI 显隐 toggle(zoom 左侧,大小同 X/Y seg)。开=显示中(高亮)。纯 UI 层,不动效果。 */}
              <button className={'song-auto-tg' + (showAutomation ? ' on' : '')} onMouseDown={(ev) => ev.preventDefault()} onClick={toggleAutomationUi} aria-pressed={showAutomation} title={showAutomation ? '隐藏 automation 界面(效果照常播)' : '显示 automation 界面'}>
                <svg width="14" height="10" viewBox="0 0 14 10" fill="none" aria-hidden="true"><polyline points="1,8 5,4 8,2.5 13,5.5" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" strokeLinecap="round" /><circle cx="8" cy="2.5" r="1.4" fill="currentColor" /></svg>
              </button>
              {/* §37 track 网格密度:每几 bar 一条全高竖线;— = 关。纯显示,不动 snap。 */}
              <span className="song-ctl-z" title="Grid (每几 bar 一条网格线;— 关)">
                <span className="song-ctl-zl">grid</span>
                <div className="seg sm" role="group" aria-label="Grid density">
                  {[1, 2, 4].map((g) => <button key={g} className={songGrid === g ? 'on' : ''} onMouseDown={(ev) => ev.preventDefault()} onClick={() => setSongGrid(g)}>{g}</button>)}
                </div>
              </span>
              <span className="song-ctl-z" title="Zoom (px per bar) — 双击回到中线">
                <span className="song-ctl-zl">zoom</span>
                <input type="range" min={20} max={60} step={1} value={songZoom} onChange={(ev) => commitZoom(Number(ev.target.value))} onDoubleClick={() => commitZoom(SONG_ZOOM_DEFAULT)} />
              </span>
            </div>
          )}
          <div style={playMode === 'song' ? { display: 'flex', alignItems: 'stretch', minWidth: 0, height: arrangerHc, marginLeft: -16, marginRight: -16 } : undefined}>{/* §37 负 16 抵掉 .srail-sticky 的左右 padding → track 区顶到 stage 两边,无 padding */}
          {/* §37 固定左侧 track gutter:10 条命名 track 表头钉在横滚区外(横滚不动);纵滚时表头随 lane 同步平移(冻结窗格),顶部 22px ruler 占位冻结。 */}
          {playMode === 'song' && (
            <div className="song-gutter" ref={songGutterRef}>
              <div className="song-gutter-ruler" aria-hidden="true" />
              <div className="song-gutter-tracks" style={{ transform: `translateY(${-songVScroll}px)` }}>
              {Array.from({ length: songLanes }, (_, lane) => {
                const tc = laneColor(lane) || (lane === 0 ? 'var(--acc)' : SESSION_COLORS[lane % SESSION_COLORS.length]);
                return (
                <div key={'th' + lane} className={'song-thead' + (lane === 0 ? ' main' : '')} style={{ height: songLaneH, ['--c' as string]: tc } as React.CSSProperties}>
                  <div className="song-thead-top">
                    <SessionColorDot color={tc} onPick={(c) => setLane(lane, { color: c })} />
                    {renamingLane === lane ? (
                      <input className="tb-proj-in" autoFocus defaultValue={laneName(lane)} style={{ flex: 1, minWidth: 0, height: 18 }}
                        onBlur={(ev) => { const v = ev.target.value.trim(); if (v) setLane(lane, { name: v }); setRenamingLane(null); }}
                        onKeyDown={(ev) => { if (ev.key === 'Enter') (ev.target as HTMLInputElement).blur(); else if (ev.key === 'Escape') setRenamingLane(null); }} />
                    ) : (
                      <span className="song-thead-nm" title="双击改名" onDoubleClick={() => setRenamingLane(lane)}>{laneName(lane)}</span>
                    )}
                  </div>
                </div>
                );
              })}
              </div>
            </div>
          )}
          <div style={playMode === 'song' ? { flex: 1, minWidth: 0, height: '100%' } : undefined}>
          <RailScroll song={playMode === 'song'} zoom={songZoom} onZoom={commitZoom} sessions={sessions} selectedIdx={sessionIdx} engine={e} playing={playing} onSeekBar={songPlayFrom} onVScroll={setSongVScroll} gridEvery={songGrid}>
            <div ref={songLanesRef} className={'banks srail' + (playMode === 'song' ? ' song' : '') + ((songDrag || songResize) ? ' song-reflow' : '')} style={playMode === 'song' ? { position: 'relative', display: 'block', width: songTrackW, minWidth: '100%', height: songLanes * songLaneH } : undefined}>{/* §37 minWidth:100% 让 lane 横线铺满可视宽;song-reflow:拖动/resize 时给其他块加位置过渡=平滑滑动不跳 */}
              {playMode === 'song' && Array.from({ length: songLanes }, (_, lane) => (
                <div key={'lane' + lane} className={'song-lane-bg' + (lane === 0 ? ' main' : '')} style={{ top: lane * songLaneH, height: songLaneH }} aria-hidden="true" />
              ))}
              {sessions.map((s, i) => {
                const insts = resolveInstruments(s);
                const chips = insts.slice(0, 6);
                const more = insts.length - chips.length;
                const cur = i === sessionIdx; // 选中/查看中(白描边 + 下方 pad 区显示它)
                const playHere = playing && (playMode === 'song' ? playingSongIds.has(s.id) : cur); // 正在出声的块:Song=active id 集、Live=当前场景 → 高亮 + 播放头跟它(与「查看」解耦)
                const n = sessionRepeats(s);
                const bars = sessionBars(s);
                const sc = sessionColor(s); // §37 per-session 上色绑 id(非数组下标)→ 生成即定、移动/复制/增删不洗牌;Live 卡 + Song 块共用
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
                  // §37.10 Live 卡对齐 §37 sblock:tinted 头条(色点·名·乐器数胶囊·bar 数)+ 内容带(乐器色块预览 + automation chips/sub 标记)。
                  // 全列主/Sub/孤儿(已拍板),Sub/孤儿降级打标——读起来与 Song 块同身份。repeat 在 Live 无意义故不显(职能差异,见 §37.10.1)。
                  const isSub = !isMainLane(s);
                  const orphan = isSub && !sessionSongAnchor(s);
                  const autoSet = s.xyAuto ?? null;
                  const activePrograms = autoSet ? PROG_ORDER.filter((p) => autoSet[p]) : []; // 该场景已激活(非平)的效果 → 头条同款字母方块(§37.10.2)
                  return (
                    <div key={s.id} data-sid={s.id} tabIndex={0} className={'scard' + (cur ? ' on' : '') + (playHere ? ' playing' : '') + (pendingIdx === i ? ' queued' : '') + dndCls + (isSub ? ' scard-sub' : '') + (orphan ? ' scard-orphan' : '')} style={{ order: cardOrder, '--c': sc } as React.CSSProperties} onClick={() => switchSession(i)} title={s.name} {...sessDnd}>
                      <div className="sc-h">
                        <SessionColorDot color={sc} onPick={(c) => setSessionColor(s.id, c)} />
                        {renamingId === s.id ? (
                          <input className="tb-proj-in" autoFocus defaultValue={s.name} style={{ flex: 1, minWidth: 0, height: 18 }} onClick={(ev) => ev.stopPropagation()}
                            onBlur={(ev) => { const v = ev.target.value.trim(); if (v) renameSession(s.id, v); setRenamingId(null); }}
                            onKeyDown={(ev) => { if (ev.key === 'Enter') (ev.target as HTMLInputElement).blur(); else if (ev.key === 'Escape') setRenamingId(null); }} />
                        ) : (
                          // 选中(当前)态再点名字 = 改名;未选中时点名走卡片 onClick 切场景
                          <span className="sc-nm" style={{ cursor: cur ? 'text' : 'pointer' }} title={cur ? '点击改名' : s.name} onClick={(ev) => { if (cur) { ev.stopPropagation(); setRenamingId(s.id); } }}>{s.name}</span>
                        )}
                        {orphan && <span className="sblk-orf" title="未锚定(孤儿):不跟随任何主块">⚲</span>}
                        <SongInstrumentCount session={s} />{/* §37.10 复用 Song 块的乐器数胶囊(active/total + hover 名单) */}
                        <span className="sc-bars">{bars}b</span>
                      </div>
                      <div className="sc-body">
                        <div className="sc-chips">
                          {chips.map((inst) => (<span key={inst.id} className="sc-chip" style={{ background: inst.color || 'rgba(236,233,227,.4)' }} />))}
                          {more > 0 && <span className="sc-more">+{more}</span>}
                        </div>
                        <div className="sc-meta">
                          {activePrograms.map((p) => (
                            <span key={p} className="sblk-achip" title={`${PROG_LABEL[p]} automation`} style={{ background: PROG_COLOR[p], borderColor: PROG_COLOR[p], color: '#1c1b19' }}>{PROG_LABEL[p][0]}</span>
                          ))}
                          {isSub && <span className="sc-subtag" title={orphan ? '未锚定(孤儿)' : `子轨叠层,锚定主场景(${laneName(sessionSongLane(s))})`}>↳ {laneName(sessionSongLane(s))}</span>}
                        </div>
                      </div>
                      {playHere && <SessionPlayhead engine={e} mode="live" startBar={0} barsPerRep={bars} repeats={n} playing={playing} />}
                    </div>
                  );
                }
                // §26 Song = 比例 arrange 时间轴:一个 block 整段(宽=bars×reps×zoom,内部 loop 刻度线)+ 下方内联自动化 lane。
                // 头:名字/小节竖排(左上)· 每遍序号(左下)· repeat 方角 +/−(右上,选中显)。效果/X-Y/清除在顶栏全局。
                // §37 拖拽/resize 实时态。pv=预览解析位(其他块让位后的位 / 被拖块的落点)。
                const isDragging = songDrag?.id === s.id;
                const pv = posById.get(s.id);
                // 主轨 reorder:被拖块「浮在鼠标下跟手」(vbar=保持抓取点的投影起点)、其余块靠 pv 让位开空(ghost 占位)。
                // 子轨拖拽(vlane>0):被拖块仍渲染在夹后落点(pv),约束放置显落点能避免误跳(#2)。
                const floatMain = isDragging && songDrag!.vlane === 0;
                const effLane = floatMain ? 0 : (pv?.lane ?? sessionSongLane(s));
                const effStart = floatMain ? songDrag!.vbar : (pv?.start ?? sessionSongStartBar(s));
                const effReps = pv?.reps ?? n;
                const isSub = !isMainLane(s);
                const orphan = isSub && !sessionSongAnchor(s);
                const bw = bars * effReps * songZoom; // §37 所有块都按 bars×reps×zoom 比例(随 zoom 一起变宽窄、与 bar 网格对齐);不再 floor(那会让 sub 不随 zoom 缩放 + 错位)——「太小」改由更大的 zoom 范围/默认解决
                const autoSet = s.xyAuto ?? null;             // §26.v3 该 session 的全部激活效果(map 只存非平;未触碰=不存=隐含中性平直线·非激活)
                const auto = autoSet?.[autoProgram] ?? defaultAutomation(autoProgram, bars * effReps); // §26.v3 当前显示那条;没有 → 可编辑的中性平直线(画即激活)
                const activePrograms = autoSet ? PROG_ORDER.filter((p) => autoSet[p]) : []; // 该 clip 已激活(非平)的效果
                const hasVol = !!(s.volAuto && s.volAuto.length); // §41 该块是否有音量曲线
                const volPts = hasVol ? s.volAuto! : [{ bar: 0, v: VOL_NEUTRAL }, { bar: bars * effReps, v: VOL_NEUTRAL }]; // 无 → 顶端 unity 平直线(画即激活)
                const volWrap: XYAutomation = { x: volPts, y: [] }; // 复用 AutomationLane:塞进 x 轴,onChange 回来取 .x
                return (
                  // §37 session 块:name + repeat 数字条 +(展开时)automation 子行,三段同一边框包住=一体(§旧包裹观感)。
                  //   automation 仍是独立子元素但嵌在块内:指针手势靠它自身 onPointerDown stopPropagation 与块拖拽分离。
                  <div data-sid={s.id} tabIndex={0} key={s.id}
                    className={'sblock' + (cur ? ' sblk-sel' : '') + (playHere ? ' playing' : '') + (pendingIdx === i ? ' queued' : '') + (isDragging ? ' dragging' : '') + (isSub ? ' sblk-sub' : '') + (orphan ? ' sblk-orphan' : '') + (!isDragging && joinLeft.has(s.id) ? ' sblk-joinl' : '')}
                    style={{ position: 'absolute', left: effStart * songZoom, top: effLane * songLaneH, height: showAutomation ? SONG_CLIP_H + SONG_AUTO_H : SONG_CLIP_H, width: bw, '--c': sc } as React.CSSProperties}
                    title={s.name}
                    onPointerDown={(ev) => songBlockDown(ev, s, i)} onPointerMove={songBlockMove} onPointerUp={songBlockUp}>
                    {/* 头条:色点 · 名字 · automation 标识(始终显,标这块挂了哪些效果)· 孤儿 · 乐器数 · bar 数。 */}
                    <div className="sblk-name">
                      <SessionColorDot color={sc} onPick={(c) => setSessionColor(s.id, c)} />
                      {renamingId === s.id ? (
                        <input className="tb-proj-in" autoFocus defaultValue={s.name} onPointerDown={(ev) => ev.stopPropagation()} onClick={(ev) => ev.stopPropagation()}
                          onBlur={(ev) => { const v = ev.target.value.trim(); if (v) renameSession(s.id, v); setRenamingId(null); }}
                          onKeyDown={(ev) => { if (ev.key === 'Enter') (ev.target as HTMLInputElement).blur(); else if (ev.key === 'Escape') setRenamingId(null); }} />
                      ) : (
                        <span className="sblk-nm" title={cur ? '双击改名' : s.name} onDoubleClick={(ev) => { ev.stopPropagation(); setRenamingId(s.id); }}>{s.name}</span>
                      )}
                      {orphan && <span className="sblk-orf" title="未锚定(孤儿):不跟随任何主块">⚲</span>}
                      <SongInstrumentCount session={s} />{/* §37 乐器数移到 name 条右侧(原在数字条左下) */}
                      <span className="sblk-bars">{bars}b</span>
                      {activePrograms.map((p) => (/* §37 automation 状态放最右(与 4b 调换位置) */
                        <span key={p} className="sblk-achip" title={`${PROG_LABEL[p]} automation`}
                          style={{ background: PROG_COLOR[p], borderColor: PROG_COLOR[p], color: '#1c1b19' }}>{PROG_LABEL[p][0]}</span>
                      ))}
                      {hasVol && <span className="sblk-achip" title="音量 automation" style={{ background: VOL_COLOR, borderColor: VOL_COLOR, color: '#1c1b19' }}>{VOL_LABEL[0]}</span>}{/* §41 音量状态标识 */}
                    </div>
                    {/* 数字条(原版观感:session 色 tint + 每遍 repeat 序号 + 左下乐器数胶囊);收起 automation 时叠一层只读 ghost 曲线(淡、pointer-events:none → 拖它=移动 clip,不冲突)。 */}
                    <div className="sblk-nums">
                      {!showAutomation && activePrograms.map((p) => (
                        <AutomationLane key={'g' + p} auto={autoSet![p]!} program={p} axis="x" bars={bars} reps={effReps} px={songZoom} editable={false} onStart={() => {}} onChange={() => {}} />
                      ))}
                      {!showAutomation && hasVol && (/* §41 收起态音量 ghost 曲线 */
                        <AutomationLane key="gvol" auto={volWrap} program={'filter'} axis="x" color={VOL_COLOR} refV={VOL_NEUTRAL} stepAxis={false} bars={bars} reps={effReps} px={songZoom} editable={false} onStart={() => {}} onChange={() => {}} />
                      )}
                      {Array.from({ length: effReps }, (_, k) => (<span key={'rn' + k} className="sblk-rn" style={{ left: k * bars * songZoom + 4 }}>{k + 1}</span>))}
                      {Array.from({ length: effReps - 1 }, (_, k) => (<span key={'t' + k} className="sblk-tick" style={{ left: (k + 1) * bars * songZoom }} aria-hidden="true" />))}
                    </div>
                    {/* §37 automation 子行:嵌在 name+nums 下方、被块边框一起包住=一体观感(§旧 .sblock-auto)。
                        指针手势靠自身 onPointerDown stopPropagation 与块拖拽分离 → 画/拖 automation 点不冒泡到 songBlockDown,不误起块拖。 */}
                    {showAutomation && (
                      <div className={'sblk-auto' + (cur ? ' sblk-auto-sel' : '')} style={{ height: SONG_AUTO_H - 3, '--c': sc } as React.CSSProperties}
                        onPointerDown={(ev) => ev.stopPropagation()}>{/* ⚠ 类名别用裸 sel:撞全局 .sel{max-width:170px} */}
                        {Array.from({ length: effReps - 1 }, (_, k) => (<span key={'t' + k} className="sblk-tick" style={{ left: (k + 1) * bars * songZoom }} aria-hidden="true" />))}
                        {autoVol
                          ? (/* §41 音量曲线:一维,塞 x 轴、onChange 取 .x;顶端 unity 参考线 + 吸附 */
                            <AutomationLane auto={volWrap} program={'filter'} axis="x" color={VOL_COLOR} refV={VOL_NEUTRAL} stepAxis={false} bars={bars} reps={effReps} px={songZoom} editable={cur} onStart={pushHistory} onChange={(a) => changeVolAuto(s.id, a.x)} />)
                          : (<AutomationLane auto={auto} program={autoProgram} axis={autoAxis} bars={bars} reps={effReps} px={songZoom} editable={cur} onStart={pushHistory} onChange={(a) => changeXyAuto(s.id, autoProgram, a)} />)}
                      </div>
                    )}
                    {/* §37 右缘 resize 改 repeat(仅主轨;sub 无手柄)。 */}
                    {isMainLane(s) && <span className="sblk-rs" title="拖动改 repeat" style={{ height: SONG_CLIP_H }} onPointerDown={(ev) => songResizeDown(ev, s)} onPointerMove={songResizeMove} onPointerUp={songResizeUp} />}{/* 只盖 clip 头:别让 handle 压住下方 automation lane 最右的尾点(否则点不到/抓不住) */}
                  </div>
                );
              })}
              {/* §37 拖拽落点占位:被拖块的预览槽位画一个虚线同色块,标「松手会落这里」(其他块已绕它排开);被拖块本身半透明浮在光标处,不再盖没经过的块。子轨叠放=无效落点 → 占位块变红(松手弹回)。 */}
              {playMode === 'song' && songDrag && songDragRef.current?.moved && (() => {
                const pv = posById.get(songDrag.id); const ds = sessions.find((x) => x.id === songDrag.id);
                if (!pv || !ds) return null;
                const dc = sessionColor(ds);
                const sb = Math.max(0, Math.round(songDrag.vbar)), db = sessionBars(ds);
                const invalid = songDrag.vlane > 0 && sessions.some((o) => sessionSongLane(o) === songDrag.vlane && (songDrag.clone || o.id !== songDrag.id) && sb < sessionSongEndBar(o) && sb + db > sessionSongStartBar(o)); // 子轨叠放
                return <div className={'song-drop-ghost' + (invalid ? ' invalid' : '')} aria-hidden="true" style={{ position: 'absolute', left: pv.start * songZoom, top: pv.lane * songLaneH, width: sessionBars(ds) * pv.reps * songZoom, height: songLaneH, '--c': dc } as React.CSSProperties} />;
              })()}
              {/* §37 Song 加场景按钮:满 lane 高 + 贴紧末块(去 +3 缝)+ 读 dragPreview.total → 拖/缩/删主块时随其他块实时跟随,不再松手才跳 */}
              {playMode === 'song'
                ? <button className="sadd song" onClick={addNewSession} title="New scene (主轨末尾追加)" style={{ position: 'absolute', left: mainLayout(dragPreview).total * songZoom, top: 0, height: songLaneH }}>＋</button>
                : <button className="sadd" onClick={addNewSession} title="New session">＋</button>}
            </div>
          </RailScroll>
          </div>
          </div>
          {playMode === 'song' && <div className="song-splitter" onPointerDown={splitterDown} title="拖动调 track 区 / 乐器区高度" aria-label="Resize arranger" style={{ marginLeft: -16, marginRight: -16 }} />}
          </div>
          <div className={'clipgrid' + (playMode === 'song' ? ' song' : '')} style={{ gridAutoRows: 120, flexShrink: 0, gap: 0, borderRadius: 'var(--r)', overflow: 'hidden', borderTop: `1px solid ${FAINT}`, borderLeft: `1px solid ${FAINT}`, ...(playMode === 'song' ? { flexGrow: 1, flexShrink: 1, flexBasis: 0, minHeight: 0, overflow: 'auto' } : null) }}>
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
                        <div style={{ margin: 'auto', padding: '6px 12px', border: '1px dashed var(--acc)', borderRadius: 'var(--r)', color: 'var(--acc)', fontSize: 11, fontWeight: 500, background: 'var(--acc-dim)', pointerEvents: 'none' }}>{/* pointerEvents:none:覆盖层必须对拖拽透明,否则光标移到这块文案上时父槽收到 dragleave→setOver(null)→层卸载→又 dragover→重挂,无限闪烁致 drop 失败(同 CollageEditor 落点徽标) */}
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
                  <div className={`clip filled ${inst.enabled ? 'st-playing' : ''}${playing && (st === 'queued' || st === 'stopping') ? (st === 'queued' ? ' st-queued' : ' st-stopping') : ''}${isSoloed ? ' solo-on' : soloDimmed ? ' solo-off' : ''}`} style={{ ...cvar(color), position: 'absolute', inset: 6, minHeight: 0, borderRadius: 'var(--r)', borderColor: isSel ? `color-mix(in srgb, ${color} 75%, #fff)` : undefined, boxShadow: isMarked && !isSel ? `inset 0 0 0 2px color-mix(in srgb, ${color} 70%, #fff)` : undefined }} onClick={(ev) => { if (gainDragged.current) { gainDragged.current = false; return; } clickInst(inst.id, ev.shiftKey); }}>
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
                              const up = (e2: PointerEvent) => { if (pushed) { gainDragged.current = true; setTimeout(() => { gainDragged.current = false; }, 0); } try { el.releasePointerCapture(e2.pointerId); } catch { /* */ } window.removeEventListener('pointermove', mv); window.removeEventListener('pointerup', up); };
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
        );
        }}
        </SongZoomScope>
      </div>

      {/* 底部常驻编辑器:按聚焦渲染(素材 / 单sample clip / 切片片 / 空)。切片乐器的 arrange 轨另在浮层(见下)。 */}
      <footer className="daw-editor">
        {(() => {
          // ① 聚焦库素材(预调)—— 最高优先;选中切片乐器时点素材也走这里(arrange 浮层不动,req5)
          if (libSel) {
            const s = ctx.soundsById.get(libSel);
            if (!s) return <EmptyEditor hint="Sample not found" />;
            // §33.6:选中的是「有块的歌」→ 切块总览(点段进块 ClipEditor);否则照常单 clip 编辑。
            const songBlocks = (s.stems ?? []).filter((k) => k.sliceIndex != null).sort((a, b) => (a.sliceIndex ?? 0) - (b.sliceIndex ?? 0));
            if (songBlocks.length) {
              return (
                <div className="ed-wrap">
                  <ChopView song={s} blocks={songBlocks} peaks={libPeaks[libSel]} busy={chopBusy} selectedId={libSel} onSelectBlock={focusSound} onDiscardBlock={onDeleteSound} onRechop={(o) => rechopBlocks(s, songBlocks, o)} />
                </div>
              );
            }
            return (
              <div className="ed-wrap">
                <ClipEditor key={'snd-' + libSel} clip={soundToClip(s)} sound={s} targetBpm={ctx.bpm} markersReadOnly={playing}
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
              <ClipEditor key={sel.id} clip={clip} sound={s} targetBpm={ctx.bpm} canPreview={!playing} markersReadOnly={playing}
                initGridBars={gridRef.current.warp} initSnap={gridRef.current.snap} onGridChange={(warp, snap) => saveGrid({ warp, snap })}
                onChange={(c) => writeSampleClip(sel.id, c)} header={header}
                mixer={<MixerStrip mixer={sel.mixer} engine={e} voiceId={sel.id} playing={playing} onMixer={(patch, history) => changeMixer(sel.id, patch, !!history)} sends={sel.sends} onSends={(patch, history) => changeSends(sel.id, patch, !!history)} />}
                preview={{ previewing: sounding, getPhase: () => aud ? (e?.auditionPhase(sel.id) ?? null) : (e?.voicePhase(sel.id) ?? null), toggle: (sp?: number) => previewInst(sel.id, sp) }} />
            );
          }
          // ③ 选中切片乐器 + 选了某片 → 该片的 clip(arrange 轨在浮层里)
          if (arrangeInst) {
            const cp = arrangeInst.payload; if (cp.kind !== 'collage') return null;
            const selPiece = cp.clips.find((c) => c.id === selClipId) ?? (cp.clips.length ? [...cp.clips].sort((a, b) => a.startStep - b.startStep)[0] : null); // 未显式选片时默认展示最左片(纯展示用;arrange 不高亮它、Del/⌘D 也不作用于它,只作用于乐器)
            const psSound = selPiece ? ctx.soundsById.get(selPiece.soundId) : null;
            if (selPiece && psSound) {
              return (
                <div className="ed-wrap">
                  <div className="ed-toplab"><span className="sec-l">Slice edit ({arrangeInst.label})</span><span className="muted small">{psSound.name}</span></div>
                  <ClipEditor key={selPiece.id} clip={selPiece} sound={psSound} targetBpm={ctx.bpm} canPreview={!playing} markersReadOnly={playing}
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

const COLLAGE_GRID = [{ label: '1/1', bars: 1 }, { label: '1/2', bars: 0.5 }, { label: '1/4', bars: 0.25 }, { label: '1/8', bars: 0.125 }, { label: '1/16', bars: 0.0625 }];
