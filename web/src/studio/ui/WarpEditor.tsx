'use client';
// 两层(对外只暴露 ClipEditor):
//  - ClipEditor:studio 唯一的「clip 调整」入口。吃一个 Clip + 源 Sound,内部负责解码 asset、拼 analysis、
//    把 WarpRegion 改动映射回 Clip(含 timeMul)、并按注入的 preview adapter 试听。库预调 / 单 sample 乐器 /
//    (将来)collage 片 / 采样器 都调它 —— 调的永远是同一个 Clip 模型。gain/eq 等乐器层数据由 mixer/header 槽注入。
//  - WarpCanvas(私有):底层 warp 画布(模型无关、同步、零 I/O)。时间轴=主 BPM 网格(钉死的尺子),波形按 warp 贴在轴上。
//    · 网格 1 · 1/2 · 1/4 · 1/8 · 1/16 决定画线密度 + trim 吸附粒度。trim 两锚点独立按网格吸附(瞬态只做视觉参考)。
//    · 拖波形=平移;Shift+拖=变速(以 trim 起点为支点伸缩,起点不动);底部横向滚动条 + Alt 滚轮缩放。
//    warp 不变量:源区间恒 = [srcSecAt(trimStart), srcSecAt(trimEnd)] = loopLen·secPerBar,
//      故 warpClip 的 rate = secPerBar/masterBar 与显示永远一致(无论 loopLen 是否整数);clamp 保证不越界。
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { LoopAnalysis } from '@/audio/conditioning';
import { decodeAsset } from '@/studio/realLibrary';
import { TransportIcon } from '@/studio/ui/glyphs';
import type { Clip } from '@/contracts';
import { fadeGain } from '@/contracts';
import type { ApiSound } from '@/studio/api';

export interface WarpRegion {
  startSample: number;
  endSample: number;
  bars: number; // loop 长度(小节,可分数)
  semitones: number;
  fadeOutBars: number;     // §24 尾淡出起点(距 loop 尾的小节数,顶点);0=无淡出
  fadeSilenceBars: number; // §24 静音尾(到零点后到 loop 尾的小节数,底点);0=淡到正好结尾
}

/** 预览路由(因场景而异,由宿主注入):库素材=裸试听;乐器=过自己的 mixer。 */
export interface ClipPreview {
  previewing: boolean;
  getPhase: () => number | null;
  toggle: (startPhase?: number) => void; // §28 startPhase 0..1=从该相位起播;省略=从头/切换
  queued?: boolean; // 量化预览正等小节边界(还没出声)→ 波形背景呼吸
  warming?: boolean; // ⑥ 正在 build buffer(出声前)→ 播放键转圈;命中缓存不传
}

interface ClipEditorProps {
  clip: Clip;          // 被编辑的模型(单 sample=那条;库预调=Sound.warp 适配出的 Clip;collage=选中片)
  sound: ApiSound;     // 源:解码 asset + analysis(瞬态)+ nativeBpm
  targetBpm: number;
  beatsPerBar?: number;
  onChange: (next: Clip) => void;   // 改动写回(宿主决定落到 Sound原始 / 乐器Clip / collage片)
  preview: ClipPreview;
  mixer?: ReactNode;   // 乐器场景传 MixerStrip;库/collage 不传
  header?: ReactNode;  // 乐器场景传 名称+激活LED;其余不传
  canPreview?: boolean;
  showTimeMul?: boolean; // 是否显示 ÷2/×2 倍速排(库预调 step1 暂不支持 → false)
  onDragOut?: (e: React.DragEvent) => void; // 给定 → 波形身体可拖出(宿主写 dataTransfer);trim 锚 / Shift 区不触发
  maxBars?: number; // loop 长度上限(collage 片传 = 到下一片的空档);不传 = 无限
  initGridBars?: number; // 载入网格(从持久化偏好);不传 = 1/4
  initSnap?: boolean;    // 载入吸附开关
  onGridChange?: (bars: number, snap: boolean) => void; // 改网格/吸附 → 上层持久化
}

/** studio 唯一的 clip 调整入口。解码 + region↔Clip 映射 + 预览接线都收在这,调用点只管喂 Clip、收 Clip。 */
export function ClipEditor({ clip, sound, targetBpm, beatsPerBar = 4, onChange, preview, mixer, header, canPreview = true, showTimeMul = true, onDragOut, maxBars, initGridBars, initSnap, onGridChange }: ClipEditorProps) {
  const [audio, setAudio] = useState<{ channels: Float32Array[]; sampleRate: number } | null>(null);
  useEffect(() => {
    let alive = true;
    setAudio(null);
    decodeAsset(clip.assetId).then((d) => { if (alive) setAudio({ channels: d.channels, sampleRate: d.sampleRate }); }).catch(() => { /* 源缺失:保持解码态 */ });
    return () => { alive = false; };
  }, [clip.assetId]);

  if (!audio) return (
    <div className="ed-decode" aria-busy="true" aria-label="Decoding waveform">
      <div className="sg-skel ed-decode-wave" aria-hidden="true" />
      <span className="ed-decode-lab">Decoding waveform…</span>
    </div>
  );

  // analysis = 源瞬态 + 这条 clip 的 warp 区(startSample/endSample/bars);不用 sound 原始检测区,否则把整段当 trim。
  const analysis = { ...(sound.analysis as object), startSample: clip.startSample, endSample: clip.endSample, bars: clip.bars } as LoopAnalysis;
  return (
    <WarpCanvas
      channels={audio.channels} sampleRate={audio.sampleRate} analysis={analysis}
      nativeBpm={sound.sourceBpm} targetBpm={targetBpm} beatsPerBar={beatsPerBar} initSemitones={clip.semitones}
      initFadeOut={clip.fadeOutBars} initFadeSilence={clip.fadeSilenceBars}
      previewing={preview.previewing} queued={preview.queued} warming={preview.warming} getPhase={preview.getPhase} onPreviewToggle={(_r, sp) => preview.toggle(sp)}
      onChange={(r) => onChange({ ...clip, startSample: r.startSample, endSample: r.endSample, bars: r.bars, semitones: r.semitones, fadeOutBars: r.fadeOutBars || undefined, fadeSilenceBars: r.fadeSilenceBars || undefined })}
      hideHead compact compactHeader={header} compactMixer={mixer} canPreview={canPreview} onDragOut={onDragOut} maxBars={maxBars}
      initGridBars={initGridBars} initSnap={initSnap} onGridChange={onGridChange}
      timeMul={clip.timeMul ?? 1} onTimeMul={showTimeMul ? (m) => onChange({ ...clip, timeMul: m }) : undefined}
    />
  );
}

interface Props {
  channels: Float32Array[];
  sampleRate: number;
  analysis: LoopAnalysis;
  nativeBpm: number;
  targetBpm: number;
  beatsPerBar?: number;
  initSemitones?: number;         // 载入时的变调(从保存的 warp 来),否则每次选中都被重置成 0 并回写覆盖掉
  initFadeOut?: number;           // §24 载入时的尾淡出起点(距尾小节数);空=无淡出
  initFadeSilence?: number;       // §24 载入时的静音尾(距尾小节数);空=0
  previewing: boolean;            // 受控:由上层(库▶ / 编辑器播放键)统一管
  getPhase: () => number | null;  // 预览播放线相位 0..1(引擎按真实起播算);null=没在播
  onPreviewToggle: (r: WarpRegion, startPhase?: number) => void; // 播放/暂停;startPhase=从该相位起播(§28)
  onChange: (r: WarpRegion) => void;        // region 变更 → 自动应用(上层持久化 + 即调即听)
  onReset?: () => void;                     // 退回自动检测默认(上层提供;无则不显示重置键)
  hideHead?: boolean;                       // 隐藏内置「片段/Warp」标题栏(播放键由上层通栏提供)
  compact?: boolean;                        // 紧凑工具区:rail 更窄、四盒更小、无「网格/吸附」标题、网格不可关
  compactHeader?: ReactNode;                // compact:左侧控制块顶部通栏(名称+播放),只跨控制块
  compactMixer?: ReactNode;                 // compact:控制块里 rail 左侧的 mixer 条
  timeMul?: number;                         // compact:半/倍速快捷当前值(0.5 / 1 / 2)
  onTimeMul?: (m: number) => void;          // compact:点 1/2·1·2 → 设半/倍速(网格下面那排)
  canPreview?: boolean;                      // compact:预览键是否可用(主走带停=可用;运行时置灰)
  queued?: boolean;                          // 量化预览等边界 → 波形背景呼吸
  warming?: boolean;                         // ⑥ build buffer 中(出声前)→ 播放键转圈
  onDragOut?: (e: React.DragEvent) => void;  // 波形身体拖出(宿主写 dataTransfer)
  maxBars?: number;                          // loop 长度上限(collage 片 = 到下一片的空档,不可拖超);sample 不传 = 无限
  initGridBars?: number;                     // 载入时的网格(从持久化偏好来),否则默认 1/4
  initSnap?: boolean;                        // 载入时的吸附开关
  onGridChange?: (bars: number, snap: boolean) => void; // 改网格/吸附 → 上层持久化(记住不重置)
}

const RULER_H = 22;
const ANCHOR_HIT = 8; // px
const FADE_DOT_HIT = 12; // px:fade 两点(顶/底)的命中半径(需 x+y 同时近)
const FADE_INSET = 8;    // 顶/底点圆心离画布上/下边的内缩;曲线端点也用它 → 曲线恰穿过点心,且点不被边缘裁切
const FADE_DOT_R = 4;    // 实心点半径(小)
const FADE_RING_R = 6;   // 外圈半径
const FADE_RING_HOVER_R = 8; // hover 时外圈放大
const MIN_BARS = 0.5; // 缩放下限:半小节铺满舞台(深放大)
const MAX_BARS = 256; // 缩放上限
const TIME_OPTS: { label: string; m: number; tip: string }[] = [
  { label: '1/2', m: 0.5, tip: 'Rate ×2: fills half a bar (double speed)' },
  { label: '1', m: 1, tip: 'Native: follows master BPM' },
  { label: '2', m: 2, tip: 'Rate ÷2: fills 2× bars (e.g. 85 in a 170 session)' },
];
const GRID_OPTS: { label: string; bars: number; tip: string }[] = [
  { label: '1/1', bars: 1, tip: 'Whole bar' },
  { label: '1/2', bars: 0.5, tip: 'Half bar · 2 beats' },
  { label: '1/4', bars: 0.25, tip: '1 beat' },
  { label: '1/8', bars: 0.125, tip: '½ beat' },
  { label: '1/16', bars: 0.0625, tip: '¼ beat' },
];

type DragMode = 'trimStart' | 'trimEnd' | 'stretch' | 'fadeStart' | 'fadeEnd';
interface DragSnap { mode: DragMode; grabSrcSec: number; anchorSrcSec0: number; secPerBar0: number; grabBarOffset: number; loopLen0: number; }

function WarpCanvas({ channels, sampleRate, analysis, nativeBpm, targetBpm, beatsPerBar = 4, initSemitones = 0, initFadeOut = 0, initFadeSilence = 0, previewing, getPhase, onPreviewToggle, onChange, onReset, hideHead = false, compact = false, compactHeader, compactMixer, timeMul = 1, onTimeMul, canPreview = true, queued = false, warming = false, onDragOut, maxBars, initGridBars, initSnap, onGridChange }: Props) {
  const total = channels[0].length;
  const srcDur = total / sampleRate;
  const beatsBar = beatsPerBar;
  const masterBar = (beatsBar * 60) / targetBpm;
  const nativeBar = (beatsBar * 60) / (nativeBpm > 0 ? nativeBpm : 90); // 源真实每小节秒数 = 可靠锚(nativeBpm 靠生成时填的 BPM)
  const STRETCH_BAND = Math.SQRT2; // 连续变速(Shift 拖)只许在源速 ±半个八度内微调;更大变速走 ÷2/×2(timeMul)。防 warp 漂到 360BPM 这种离谱值,且与八度步进无缝拼接

  // 初始 secPerBar 用检测区间长/N(= 无缝速度,最准);兜底用 nativeBpm。
  const init = useMemo(() => {
    const s0 = analysis.startSample / sampleRate;
    const s1 = analysis.endSample / sampleRate;
    const N = analysis.bars > 0 ? analysis.bars : 1; // 允许 sub-bar(切片):别夹到 1,否则 0.25 小节会被当成 1 小节 → secPerBar(速度)×4、loop 长度自涨
    const fromRegion = (s1 - s0) / N;
    const fromInput = (beatsBar * 60) / (nativeBpm > 0 ? nativeBpm : 90);
    const secPerBar = fromRegion > 0.05 ? fromRegion : fromInput;
    const sig = `${analysis.startSample}|${analysis.endSample}|${analysis.bars}|${initSemitones}|${initFadeOut}|${initFadeSilence}`; // 这条 clip 的 region 身份(用于区分「自家改动回流」vs 外部变更)
    return { anchorOutBar: 1, anchorSrcSec: s0, secPerBar, trimStartBar: 1, trimEndBar: 1 + N, N, semitones: initSemitones, fadeOutBars: initFadeOut, fadeSilenceBars: initFadeSilence, sig };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [analysis, sampleRate, nativeBpm, beatsBar, initSemitones, initFadeOut, initFadeSilence]);

  const [anchorOutBar, setAnchorOutBar] = useState(init.anchorOutBar);
  const [anchorSrcSec, setAnchorSrcSec] = useState(init.anchorSrcSec);
  const [secPerBar, setSecPerBar] = useState(init.secPerBar);
  const [trimStartBar, setTrimStartBar] = useState(init.trimStartBar);
  const [trimEndBar, setTrimEndBar] = useState(init.trimEndBar);
  const [gridBars, setGridBars] = useState(initGridBars ?? 0.25); // 默认 1/4(拍);载入时用持久化偏好,选片不再重置
  const pickGrid = (bars: number) => { setSnap(true); setGridBars(bars); onGridChange?.(bars, true); }; // 改网格 → 持久化
  const toggleSnapOff = () => { setSnap(false); onGridChange?.(gridBars, false); };
  const [semitones, setSemitones] = useState(init.semitones);
  const [fadeOutBars, setFadeOutBars] = useState(init.fadeOutBars); // §24 尾淡出起点(距尾小节数,顶点)
  const [fadeSilenceBars, setFadeSilenceBars] = useState(init.fadeSilenceBars); // §24 静音尾(距尾小节数,底点)
  const [fadeDragging, setFadeDragging] = useState(false); // 拖 fade 点中 → 画 ½-trim 上限参考线
  const [fadeHover, setFadeHover] = useState<null | 'start' | 'end'>(null); // 悬停在哪个 fade 点 → 外圈放大
  const [snap, setSnap] = useState(initSnap ?? true);
  const [barsVisible, setBarsVisible] = useState(init.N + 2);
  const [vStart, setVStart] = useState(0);
  const [armed, setArmed] = useState(false); // 光标在波形身体(非 trim 锚 / 非 Shift)→ 波形可拖出乐器
  const [menu, setMenu] = useState<{ x: number; y: number; ob: number } | null>(null); // §28 右键菜单(设起止);x/y=视口坐标

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const playheadRef = useRef<HTMLDivElement>(null);
  const hoverRef = useRef<HTMLDivElement>(null); // §28 起播线(瞬态,直改 DOM)
  const activeStartRef = useRef<number | null>(null); // §28 当前预览从哪条起播线起(phase);"同线再点=停"用,▶从头起=null
  const rafRef = useRef<number | null>(null);
  const playRef = useRef({ trimStartBar: 1, loopLen: 1 }); // 正在播放那段的几何(起播 / 提交时锁定;拖动中不变)→ 播放线按真正在响的 loop 算,不随未提交的 loopLen 漂
  const drag = useRef<DragSnap | null>(null);
  const clickCand = useRef<{ x: number; y: number; startPhase?: number } | null>(null); // 「点击试听」候选;startPhase=§28 从起播线相位起播
  const sbDrag = useRef<{ x0: number; v0: number } | null>(null);
  const semiDrag = useRef<{ y0: number; v0: number } | null>(null);
  // 播放线/自动应用用的最新值镜像
  const getPhaseRef = useRef(getPhase); getPhaseRef.current = getPhase;
  const onChangeRef = useRef(onChange); onChangeRef.current = onChange;
  const firstChange = useRef(true);
  const lastEmitSig = useRef<string | null>(null); // 最近一次我们 emit 的 region 签名;init 回流若匹配 → 自家改动,别重置视图(缩放/滚动/锚点)
  const draggingRef = useRef(false);            // compact:拖动中不提交(旧 loop 继续放),松手才渲染
  const [commitTick, setCommitTick] = useState(0); // 松手 → 触发一次提交

  useEffect(() => {
    if (init.sig === lastEmitSig.current) return; // 自家改动回流:trim/缩放/滚动都保持原样,别重置
    firstChange.current = true; // 选中/换素材/撤销造成的这批状态重置不当成"用户改动",别回写覆盖已存的 warp
    setAnchorOutBar(init.anchorOutBar); setAnchorSrcSec(init.anchorSrcSec); setSecPerBar(init.secPerBar);
    setTrimStartBar(init.trimStartBar); setTrimEndBar(init.trimEndBar);
    setSemitones(init.semitones); setFadeOutBars(init.fadeOutBars); setFadeSilenceBars(init.fadeSilenceBars); setBarsVisible(init.N + 2); setVStart(0);
    lastEmitSig.current = init.sig; // 重置后已与这条 region 对齐
  }, [init]);

  const mono = useMemo(() => {
    if (channels.length === 1) return channels[0];
    const n = channels[0].length;
    const out = new Float32Array(n);
    for (const ch of channels) for (let i = 0; i < n; i++) out[i] += ch[i] / channels.length;
    return out;
  }, [channels]);

  const srcSecAt = useCallback((outBar: number) => anchorSrcSec + (outBar - anchorOutBar) * secPerBar, [anchorSrcSec, anchorOutBar, secPerBar]);
  const outBarAt = useCallback((srcSec: number) => anchorOutBar + (srcSec - anchorSrcSec) / secPerBar, [anchorOutBar, anchorSrcSec, secPerBar]);

  const loopLen = trimEndBar - trimStartBar; // 小节,网格倍数(可分数)
  // §24 fade 两点几何:都钉在 loop 后半(≤ loopLen/2),顶点=fadeStart(gain 1→开始降)、底点=fadeEnd(gain→0);
  // 存的是「距尾小节数」,读时按当前 loopLen 夹紧(loop 变长/变短自动归位,不必额外 effect)。
  const fadeMax = loopLen / 2;
  const fadeMidBar = trimStartBar + fadeMax; // 上限线:fade 点不得越过此处(loop 中点)
  const fadeOut = Math.max(0, Math.min(fadeMax, fadeOutBars));
  const fadeSilence = Math.max(0, Math.min(fadeOut, fadeSilenceBars));
  const fadeStartBar = trimEndBar - fadeOut; // 顶点 outBar
  const fadeEndBar = trimEndBar - fadeSilence; // 底点 outBar
  const hasFade = fadeOut > 1e-4;
  const fadeGainAtBar = (b: number) => {
    if (!hasFade || b <= fadeStartBar) return 1;
    if (b >= fadeEndBar) return 0;
    return fadeGain((b - fadeStartBar) / Math.max(1e-6, fadeEndBar - fadeStartBar)); // 与离线 bake 共用 fadeGain(隆起抛物线 1-t²)
  };
  // 不夹到 [0,total]:loop 可滑出音频(超出部分渲染时补零);srcEnd-srcStart 恒 = loopLen·secPerBar → 速率不变量成立
  const srcStart = Math.round(srcSecAt(trimStartBar) * sampleRate);
  const srcEnd = Math.max(srcStart + 1, Math.round(srcSecAt(trimEndBar) * sampleRate));
  const trimBpm = secPerBar > 0 ? (beatsBar * 60) / secPerBar : 0;
  const rate = masterBar > 0 ? secPerBar / masterBar : 1;
  // 罩层/曲线阈值(hasFade)与落库口径统一:低于阈值一律按 0 发出,避免 UI 显示"无淡出"却烘了个微淡出。
  const region: WarpRegion = { startSample: srcStart, endSample: srcEnd, bars: loopLen, semitones, fadeOutBars: hasFade ? fadeOut : 0, fadeSilenceBars: hasFade ? fadeSilence : 0 };

  const hiBar = outBarAt(srcDur);
  const contentBars = Math.max(trimEndBar, hiBar); // 内容(波形+loop)实际跨度,不含视口富余
  const totalBars = Math.max(contentBars, barsVisible) + 0.5;

  const viewRef = useRef({ barsVisible, vStart, trimStartBar, loopLen, masterBar, contentBars });
  viewRef.current = { barsVisible, vStart, trimStartBar, loopLen, masterBar, contentBars };
  const regionRef = useRef(region); regionRef.current = region; // 提交时取最新 region(避免闭包过期)

  const draw = useCallback(() => {
    const cv = canvasRef.current;
    const stage = stageRef.current;
    if (!cv || !stage) return;
    const dpr = window.devicePixelRatio || 1;
    const W = stage.clientWidth;
    const H = stage.clientHeight;
    if (!W || !H) return;
    cv.width = W * dpr; cv.height = H * dpr;
    const c = cv.getContext('2d');
    if (!c) return;
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.clearRect(0, 0, W, H);
    const waveH = H - RULER_H;
    const mid = RULER_H + waveH / 2;
    const pxPerBar = W / barsVisible;
    const bx = (outBar: number) => (outBar - vStart) * pxPerBar;

    const tx0 = bx(trimStartBar), tx1 = bx(trimEndBar);
    c.fillStyle = 'rgba(232,163,61,0.07)';
    c.fillRect(tx0, RULER_H, tx1 - tx0, waveH);

    // 波形(贴在 warp 坐标上)
    for (let px = 0; px < W; px++) {
      const ob = vStart + px / pxPerBar;
      const s0 = srcSecAt(ob) * sampleRate;
      const s1 = srcSecAt(ob + 1 / pxPerBar) * sampleRate;
      const a0 = Math.max(0, Math.floor(Math.min(s0, s1)));
      const a1 = Math.min(total, Math.max(a0 + 1, Math.ceil(Math.max(s0, s1))));
      if (a1 <= 0 || a0 >= total) continue;
      let peak = 0;
      for (let i = a0; i < a1; i++) { const v = Math.abs(mono[i]); if (v > peak) peak = v; }
      const h = peak * (waveH * 0.46);
      const inLoop = ob >= trimStartBar && ob <= trimEndBar;
      c.strokeStyle = inLoop ? 'rgba(196,206,216,0.95)' : 'rgba(70,82,94,0.5)';
      c.beginPath(); c.moveTo(px + 0.5, mid - h); c.lineTo(px + 0.5, mid + h); c.stroke();
    }

    // 网格:标尺密度 = 所选分辨率(与吸附一致)。整小节粗+编号,拍中等,细分淡;太密的细分不画(防糊)。
    // 网格原点 = 起始线(trimStartBar):所有小节/拍线从起点算起,起点一动,整套网格跟着走。
    const beatStep = 1 / beatsBar;
    const step = gridBars;
    const origin = trimStartBar;
    const subSpacingPx = step * pxPerBar;
    const isMul = (v: number, m: number) => Math.abs(v / m - Math.round(v / m)) < 1e-4;
    let k = Math.floor((vStart - origin) / step) - 1;
    for (; ; k++) {
      const pos = origin + k * step;
      const rel = k * step; // 距起点的小节数(起点 = 0)
      const x = bx(pos);
      if (x > W + 1) break;
      if (x < -1) continue;
      const isBar = isMul(rel, 1);
      const isBeat = isMul(rel, beatStep);
      if (!isBar && !isBeat && subSpacingPx < 4) continue; // 细分太密,只保留小节/拍线
      c.strokeStyle = isBar ? 'rgba(255,255,255,0.42)' : isBeat ? 'rgba(255,255,255,0.16)' : 'rgba(255,255,255,0.07)';
      c.beginPath(); c.moveTo(x, RULER_H); c.lineTo(x, H); c.stroke();
      if (isBar) {
        const n = Math.round(rel) + 1; // 起点 = 第 1 小节
        if (n >= 1) { c.fillStyle = '#8a8a8a'; c.font = '10px system-ui'; c.fillText(String(n), x + 3, 13); }
      }
    }

    // 瞬态(warp 点,视觉参考)
    c.fillStyle = 'rgba(232,163,61,0.85)';
    for (const o of analysis.onsets) {
      const x = bx(outBarAt(o / sampleRate));
      if (x >= -2 && x <= W + 2) c.fillRect(x, RULER_H, 1.5, 8);
    }

    // §24 淡出:一块实心(非渐变)更深罩层,下沿 = 抛物线(gain 1→0);罩住的部分即被衰减,越靠尾越满 → 读作淡出到静音。
    // 抛物线竖直区间内缩到 [顶点心, 底点心] = [RULER_H+INSET, H-INSET],曲线端点正好落在两个圆点心上。
    const fadeTopY = RULER_H + FADE_INSET, fadeBotY = H - FADE_INSET;
    if (hasFade) {
      const STEPS = 40;
      c.beginPath();
      c.moveTo(bx(fadeStartBar), RULER_H); // 顶边起,i=0 竖直降到顶点心
      for (let i = 0; i <= STEPS; i++) {   // 沿抛物线从顶点心降到底点心
        const b = fadeStartBar + (fadeEndBar - fadeStartBar) * (i / STEPS);
        c.lineTo(bx(b), fadeTopY + (1 - fadeGainAtBar(b)) * (fadeBotY - fadeTopY));
      }
      c.lineTo(bx(fadeEndBar), H);   // 底点心直落底边 → fadeEnd 处整列盖满(无亮缝)
      c.lineTo(bx(trimEndBar), H);   // 静音尾沿底边到结束线
      c.lineTo(bx(trimEndBar), RULER_H); // 右边上到顶,closePath 沿顶回起点 → 罩层 = 抛物线之上 + 静音尾整列
      c.closePath();
      c.fillStyle = 'rgba(15,14,13,0.55)';
      c.fill();
    }

    const anchor = (x: number, color: string) => {
      c.strokeStyle = color; c.lineWidth = 1.5;
      c.beginPath(); c.moveTo(x, 0); c.lineTo(x, H); c.stroke();
      c.fillStyle = color;
      c.beginPath(); c.moveTo(x - 5, 0); c.lineTo(x + 5, 0); c.lineTo(x, 9); c.closePath(); c.fill();
    };
    anchor(tx0, '#7cd17c');
    anchor(tx1, '#e8a33d');

    // §24 fade 两点(画在最上层)。拖动时显 ½-trim 上限线(两点都不得越过)。无连接线 —— 抛物线即罩层下沿。
    if (fadeDragging) {
      const xm = bx(fadeMidBar);
      c.save(); c.setLineDash([4, 4]); c.strokeStyle = 'rgba(240,201,138,0.45)'; c.lineWidth = 1;
      c.beginPath(); c.moveTo(xm, RULER_H); c.lineTo(xm, H); c.stroke(); c.restore();
    }
    const fadeDot = (x: number, y: number, hovered: boolean) => {
      c.beginPath(); c.arc(x, y, hovered ? FADE_RING_HOVER_R : FADE_RING_R, 0, Math.PI * 2); c.strokeStyle = 'rgba(240,201,138,0.45)'; c.lineWidth = 1.5; c.stroke();
      c.beginPath(); c.arc(x, y, FADE_DOT_R, 0, Math.PI * 2); c.fillStyle = '#f0c98a'; c.fill(); c.strokeStyle = '#2a1a0b'; c.lineWidth = 1.2; c.stroke();
    };
    fadeDot(bx(fadeStartBar), fadeTopY, fadeHover === 'start'); // 顶点(圆心在曲线端点):无 fade 时停在结束线顶,供拉出
    if (hasFade) fadeDot(bx(fadeEndBar), fadeBotY, fadeHover === 'end'); // 底点:有 fade 才显
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fade 几何为派生常量,随下列 state 一并重建
  }, [mono, total, sampleRate, barsVisible, vStart, trimStartBar, trimEndBar, beatsBar, gridBars, srcSecAt, outBarAt, analysis.onsets, fadeOutBars, fadeSilenceBars, fadeDragging, fadeHover]);

  useEffect(() => { draw(); }, [draw]);
  useEffect(() => {
    const o = new ResizeObserver(() => draw());
    if (stageRef.current) o.observe(stageRef.current);
    return () => o.disconnect();
  }, [draw]);

  // 无极缩放/平移:Alt+滚轮 = 以光标为支点连续缩放;普通滚轮 = 左右平移。
  // 原生非被动监听才能 preventDefault;读 viewRef 拿最新视口,避免闭包过期。
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const onWheel = (e: WheelEvent) => {
      const W = stage.clientWidth;
      if (!W) return;
      const v = viewRef.current;
      const pxPerBar = W / v.barsVisible;
      const x = e.clientX - stage.getBoundingClientRect().left;
      if (e.altKey) {
        e.preventDefault();
        const cursorBar = v.vStart + x / pxPerBar; // 光标下的输出小节,缩放后保持不动
        const factor = Math.exp(e.deltaY * 0.0015); // 下滚(deltaY>0)→ 看得更多 = 缩小
        const nb = Math.max(MIN_BARS, Math.min(MAX_BARS, v.barsVisible * factor));
        const newTotal = Math.max(v.contentBars, nb) + 0.5;
        const nv = Math.max(0, Math.min(Math.max(0, newTotal - nb), cursorBar - x / (W / nb)));
        setBarsVisible(nb);
        setVStart(nv);
      } else {
        const d = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
        if (d === 0) return;
        e.preventDefault();
        const newTotal = Math.max(v.contentBars, v.barsVisible) + 0.5;
        const nv = Math.max(0, Math.min(Math.max(0, newTotal - v.barsVisible), v.vStart + d / pxPerBar));
        setVStart(nv);
      }
    };
    stage.addEventListener('wheel', onWheel, { passive: false });
    return () => stage.removeEventListener('wheel', onWheel);
  }, []);

  // 吸附到「相对起点」的网格(网格原点 = 起始线)。只有终点锚用它 → loop 长度落在网格整数倍。
  const snapGrid = (ob: number) => (snap ? trimStartBar + Math.round((ob - trimStartBar) / gridBars) * gridBars : ob);

  const commitNow = () => setCommitTick((t) => t + 1);
  const onDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return; // §28 只接左键;右键交给 onContextMenu(否则右键也会起 trim 拖拽/试听候选)
    const stage = stageRef.current!;
    const rectB = stage.getBoundingClientRect();
    const W = stage.clientWidth, Hpx = stage.clientHeight;
    const pxPerBar = W / barsVisible;
    const x = e.clientX - rectB.left, y = e.clientY - rectB.top;
    const ob = vStart + x / pxPerBar;
    const xStart = (trimStartBar - vStart) * pxPerBar;
    const xEnd = (trimEndBar - vStart) * pxPerBar;
    // §24 fade 两点优先命中(需 x+y 同时近 → 不抢 trim 锚的整条竖线):顶点(RULER_H+INSET)、底点(Hpx-INSET)
    const xFadeStart = (fadeStartBar - vStart) * pxPerBar, xFadeEnd = (fadeEndBar - vStart) * pxPerBar;
    let mode: DragMode;
    if (Math.hypot(x - xFadeStart, y - (RULER_H + FADE_INSET)) <= FADE_DOT_HIT) mode = 'fadeStart';
    else if (hasFade && Math.hypot(x - xFadeEnd, y - (Hpx - FADE_INSET)) <= FADE_DOT_HIT) mode = 'fadeEnd';
    else if (Math.abs(x - xEnd) <= ANCHOR_HIT) mode = 'trimEnd';
    else if (Math.abs(x - xStart) <= ANCHOR_HIT) mode = 'trimStart';
    else if (e.shiftKey) mode = 'stretch';
    else {
      // 空白/身体区不平移波形;记为点击候选,松手没怎么动 = 从起播线试听一次。
      // §28:仅当落点(吸格)在 trim 内才记 clickCand(带 startPhase);trim 外 = null → 点了不出声。
      // 可拖出时身体区永不夺指针捕获(捕获会压住原生 HTML5 拖拽);轻点走 clickCand 试听,一动就起原生 drag。
      if (!onDragOut) (e.target as Element).setPointerCapture(e.pointerId);
      const sob = snapGrid(ob), loop = trimEndBar - trimStartBar;
      clickCand.current = sob >= trimStartBar && sob < trimEndBar && loop > 0
        ? { x: e.clientX, y: e.clientY, startPhase: (sob - trimStartBar) / loop }
        : null;
      return;
    }
    (e.target as Element).setPointerCapture(e.pointerId);
    draggingRef.current = true;
    if (mode === 'fadeStart' || mode === 'fadeEnd') setFadeDragging(true);
    drag.current = { mode, grabSrcSec: srcSecAt(ob), anchorSrcSec0: anchorSrcSec, secPerBar0: secPerBar, grabBarOffset: trimStartBar - ob, loopLen0: trimEndBar - trimStartBar };
    applyDrag(e.clientX);
  };
  const applyDrag = (clientX: number) => {
    const d = drag.current;
    const stage = stageRef.current;
    if (!d || !stage) return;
    const W = stage.clientWidth;
    const pxPerBar = W / barsVisible;
    const x = clientX - stage.getBoundingClientRect().left;
    const ob = vStart + x / pxPerBar;

    if (d.mode === 'trimStart') {
      // 无极:绿线跟光标连续移动(不吸附);终点等距跟随 → loop 长度不变,整窗在固定波形上滑动。
      const ns = Math.max(0, ob + d.grabBarOffset);
      setTrimStartBar(ns);
      setTrimEndBar(ns + d.loopLen0);
    } else if (d.mode === 'trimEnd') {
      const s = snapGrid(ob);
      const capped = maxBars != null ? Math.min(trimStartBar + maxBars, s) : s; // collage:loop 不得长过到下一片的空档
      const ne = Math.max(trimStartBar + gridBars, capped);
      setTrimEndBar(ne); // 吸附到相对起点的网格 → 长度=网格整数倍;可超出音频(补零)
      const nm = (ne - trimStartBar) / 2; // loop 变短 → fade 不得超过新后半;把 state 也夹回去(否则 loop 再变长会复活旧值,与已落库的夹后值背离)
      setFadeOutBars((f) => Math.min(f, nm));
      setFadeSilenceBars((f) => Math.min(f, nm));
    } else if (d.mode === 'stretch') {
      // 支点 = trim 起点,抓住的源点跟随光标 → 改 secPerBar;锚定到源速 ±半个八度(超出走 ÷2/×2)
      const pivotSrc = srcSecAt(trimStartBar);
      const denom = ob - trimStartBar;
      if (Math.abs(denom) > 1e-4) {
        const sp = Math.min(Math.max((d.grabSrcSec - pivotSrc) / denom, nativeBar / STRETCH_BAND), nativeBar * STRETCH_BAND);
        setAnchorOutBar(trimStartBar);
        setAnchorSrcSec(pivotSrc);
        setSecPerBar(sp);
      }
    } else if (d.mode === 'fadeStart') {
      // 顶点:无极(不吸网格),夹在 [loop 中点, 结束线];越过底点则把底点一起右推(顶点不可在底点右侧)。
      // 允许一路拉到结束线 → fadeOut=0 = 取消淡出(即便此前有静音尾也能彻底清掉)。
      const fs = Math.max(fadeMidBar, Math.min(trimEndBar, ob));
      const newOut = trimEndBar - fs;
      setFadeOutBars(newOut);
      if (fadeSilence > newOut) setFadeSilenceBars(newOut); // 底点不能落在顶点左侧 → 顶点推着底点走
    } else if (d.mode === 'fadeEnd') {
      // 底点:无极,夹在 [max(loop 中点, 顶点), 结束线];往左拉 = 在 loop 结束前就到静音(尾巴留空)。
      const fe = Math.max(Math.max(fadeMidBar, fadeStartBar), Math.min(trimEndBar, ob));
      setFadeSilenceBars(trimEndBar - fe);
    }
  };
  const onMove = (e: React.PointerEvent) => {
    if (menu) return; // §28 右键菜单开着时冻结起播线(光标不再跟手移动)
    if (drag.current) { applyDrag(e.clientX); return; }
    const cc = clickCand.current; // 移动超过阈值 → 不是点击,取消试听候选
    if (cc && (Math.abs(e.clientX - cc.x) > 4 || Math.abs(e.clientY - cc.y) > 4)) clickCand.current = null;
    // 悬停光标:锚点附近(或按住 Shift 变速)= 横向拖拽箭头;波形身体(可拖出时)= 抓手;其余 = 喇叭(CSS)
    const stage = stageRef.current;
    if (stage) {
      const rectB = stage.getBoundingClientRect();
      const pxPerBar = stage.clientWidth / barsVisible;
      const x = e.clientX - rectB.left, y = e.clientY - rectB.top;
      const onStart = Math.hypot(x - (fadeStartBar - vStart) * pxPerBar, y - (RULER_H + FADE_INSET)) <= FADE_DOT_HIT;
      const onEnd = hasFade && Math.hypot(x - (fadeEndBar - vStart) * pxPerBar, y - (stage.clientHeight - FADE_INSET)) <= FADE_DOT_HIT;
      const nearFadeDot = onStart || onEnd;
      const hov = onStart ? 'start' : onEnd ? 'end' : null;
      if (hov !== fadeHover) setFadeHover(hov); // 悬停 → 外圈放大
      const nearAnchor = Math.abs(x - (trimEndBar - vStart) * pxPerBar) <= ANCHOR_HIT || Math.abs(x - (trimStartBar - vStart) * pxPerBar) <= ANCHOR_HIT;
      const canDrag = !!onDragOut && !nearAnchor && !nearFadeDot && !e.shiftKey; // 身体区可拖出(避开 trim 锚 / fade 点 / Shift 变速)→ 切到 draggable
      if (canDrag !== armed) setArmed(canDrag);
      stage.style.cursor = nearFadeDot || nearAnchor || e.shiftKey ? 'ew-resize' : canDrag ? 'grab' : '';
      // §28 起播线:吸网格、仅 trim 内显示(瞬态直改 DOM,不进 state)
      if (hoverRef.current) {
        const sob = snapGrid(vStart + x / pxPerBar);
        if (sob >= trimStartBar && sob < trimEndBar) { hoverRef.current.style.display = 'block'; hoverRef.current.style.left = (((sob - vStart) * pxPerBar) / stage.clientWidth) * 100 + '%'; }
        else hoverRef.current.style.display = 'none';
      }
    }
  };
  // 波形身体拖出:HTML5 drag(目标 pad/轨复用现成 text/plain 落点)。
  // ⚠setPointerCapture 并不会压住原生 HTML5 drag —— 拖 trim 锚/Shift 变速时 dragstart 照样起,会把波形拖出、抢走 pointermove
  // 导致 trim 失效。pointerdown 永远先于 dragstart 触发,故 onDown 设的 drag.current 在这儿一定已就位 → 以它判定「正在 trim/stretch」并拦下原生 drag。
  // 只有真·身体区(drag.current 为空 + 非 Shift)才放行拖出;不再看异步 armed —— 那会丢掉「按下即拖」的首帧。
  const onStageDragStart = (e: React.DragEvent) => {
    if (!onDragOut || e.shiftKey || drag.current) { e.preventDefault(); return; }
    clickCand.current = null; // 拖出时不再当作轻点试听
    onDragOut(e);
  };
  const onUp = () => {
    if (clickCand.current) { // §28 trim 内轻点 = 从起播线试听
      const sp = clickCand.current.startPhase; clickCand.current = null;
      if (canPreview && sp != null) {
        if (previewing && activeStartRef.current != null && Math.abs(sp - activeStartRef.current) < 1e-4) { activeStartRef.current = null; onPreviewToggle(region); } // 还在原起播线上点 → 停(无 startPhase = host 当 toggle 关)
        else { activeStartRef.current = sp; onPreviewToggle(region, sp); } // 其余 → 从这条线起播/重起
      }
      return;
    }
    const wasFade = drag.current?.mode === 'fadeStart' || drag.current?.mode === 'fadeEnd';
    drag.current = null; draggingRef.current = false; if (wasFade) setFadeDragging(false); if (compact) commitNow();
  };
  // §28 右键:设为开始/结束。改 trim state → 既有防抖 useEffect 自动 emit onChange(落库 + undo),零新链路。
  const onContext = (e: React.MouseEvent) => {
    e.preventDefault();
    const stage = stageRef.current; if (!stage) return;
    const pxPerBar = stage.clientWidth / barsVisible;
    const ob = vStart + (e.clientX - stage.getBoundingClientRect().left) / pxPerBar;
    setMenu({ x: e.clientX, y: e.clientY, ob: snapGrid(ob) });
  };
  // §28 设起点 = 整体平移(终点跟过去、保 loop 长,同拖起始线);故可越过原终点(终点跟着走,不夹)。
  const setAsStart = () => { if (!menu) return; const ns = Math.max(0, menu.ob); setTrimEndBar(ns + (trimEndBar - trimStartBar)); setTrimStartBar(ns); setMenu(null); };
  const setAsEnd = () => {
    if (!menu) return;
    const cap = maxBars != null ? trimStartBar + maxBars : Infinity;
    const ne = Math.max(trimStartBar + gridBars, Math.min(menu.ob, cap));
    setTrimEndBar(ne);
    const nm = (ne - trimStartBar) / 2; setFadeOutBars((f) => Math.min(f, nm)); setFadeSilenceBars((f) => Math.min(f, nm));
    setMenu(null);
  };

  // 变调值框:上下拖(≈6px / 半音)+ 滚轮 ±1,clamp ±12。换掉原来的滑杆,贴 Live 的数字框交互。
  const onSemiDown = (e: React.PointerEvent) => { (e.target as Element).setPointerCapture(e.pointerId); draggingRef.current = true; semiDrag.current = { y0: e.clientY, v0: semitones }; };
  const onSemiMove = (e: React.PointerEvent) => { const d = semiDrag.current; if (!d) return; setSemitones(Math.max(-12, Math.min(12, d.v0 + Math.round((d.y0 - e.clientY) / 6)))); };
  const onSemiUp = () => { semiDrag.current = null; draggingRef.current = false; if (compact) commitNow(); };
  const onSemiWheel = (e: React.WheelEvent) => { setSemitones((s) => Math.max(-12, Math.min(12, s - Math.sign(e.deltaY)))); };

  const onSbDown = (e: React.PointerEvent) => { (e.target as Element).setPointerCapture(e.pointerId); sbDrag.current = { x0: e.clientX, v0: vStart }; };
  const onSbMove = (e: React.PointerEvent) => {
    const sb = sbDrag.current; const track = e.currentTarget as HTMLElement;
    if (!sb) return;
    const w = track.clientWidth || 1;
    const dBar = ((e.clientX - sb.x0) / w) * totalBars;
    setVStart(Math.max(0, Math.min(Math.max(0, totalBars - barsVisible), sb.v0 + dBar)));
  };
  const onSbUp = () => { sbDrag.current = null; };

  const stopPlayhead = () => { if (rafRef.current != null) { cancelAnimationFrame(rafRef.current); rafRef.current = null; } };
  // 播放线:相位由引擎按音频真实起播时刻 + loop 时长给(自由/量化都精确,重播即归零)。
  useEffect(() => {
    stopPlayhead();
    if (!previewing) { activeStartRef.current = null; return; } // §28 预览停 → 清"当前起播线"(下次同位点是起播而非停)
    playRef.current = { trimStartBar: viewRef.current.trimStartBar, loopLen: viewRef.current.loopLen }; // 起播:锁定当前在响的 loop 几何
    const animate = () => {
      const stage = stageRef.current;
      if (stage && playheadRef.current) {
        const v = viewRef.current;
        const W = stage.clientWidth;
        const pxPerBar = W / v.barsVisible;
        const phase = getPhaseRef.current() ?? 0; // 起播=0,量化等边界时也=0
        const pg = playRef.current; // 用"正在播放那段"的几何(非拖动中的实时 loopLen)→ 拖结束/起始线时播放线不错位
        const ob = pg.trimStartBar + phase * pg.loopLen;
        playheadRef.current.style.left = (((ob - v.vStart) * pxPerBar) / W) * 100 + '%';
      }
      rafRef.current = requestAnimationFrame(animate);
    };
    rafRef.current = requestAnimationFrame(animate);
    return () => stopPlayhead();
  }, [previewing]);

  // region 任何变更 → 防抖自动应用(上层持久化 + 若在播则即调即听);跳过首挂。
  // compact(studio):拖动中不提交(旧 loop 继续放),松手(commitTick)才渲染一次;非 compact 维持原"拖动中防抖"行为。
  useEffect(() => {
    if (firstChange.current) { firstChange.current = false; return; }
    if (compact && draggingRef.current) return;
    const id = setTimeout(() => {
      const r = regionRef.current;
      lastEmitSig.current = `${r.startSample}|${r.endSample}|${r.bars}|${r.semitones}|${r.fadeOutBars}|${r.fadeSilenceBars}`; // 记下这次 emit:回流时 init.sig 会匹配 → 不重置视图
      playRef.current = { trimStartBar: viewRef.current.trimStartBar, loopLen: viewRef.current.loopLen }; // 提交 = 引擎换新 buffer(重 audition)→ 播放线几何同步切到新 loop
      onChangeRef.current(r);
    }, 200);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trimStartBar, trimEndBar, anchorOutBar, anchorSrcSec, secPerBar, semitones, fadeOutBars, fadeSilenceBars, commitTick]);
  useEffect(() => () => stopPlayhead(), []);

  const slow = rate < 0.985, fast = rate > 1.015;
  const thumbLeft = (Math.max(0, Math.min(vStart, Math.max(0, totalBars - barsVisible))) / totalBars) * 100;
  const thumbW = Math.min(100, (barsVisible / totalBars) * 100);
  const lenBars = Math.round(loopLen * 1000) / 1000;
  const barsStr = Number.isInteger(lenBars) ? `${lenBars}` : lenBars.toFixed(3).replace(/0+$/, '').replace(/\.$/, '');
  const beatsN = Math.round(loopLen * beatsBar);
  const lenTxt = compact ? `${barsStr} : ${beatsN}` : `${barsStr} bar(s) · ${beatsN} beat(s)`;

  const rail = (
      <div className="we-rail">
        {!hideHead && (
          <div className="we-head">
            <span className="we-title">Clip / Warp</span>
            <div className="we-head-act">
              {onReset && <button className="we-reset" onClick={onReset} title="Reset trim / bars / pitch to auto-detected defaults">↺</button>}
              <button className={'we-play' + (previewing ? ' on' : '')} onClick={() => onPreviewToggle(region)} title="Play / stop (quantises to bar boundary when transport is running)" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><TransportIcon stop={previewing} size={11} />{previewing ? 'Stop' : 'Play'}</button>
            </div>
          </div>
        )}

        <div className="we-grid">
          <div className="we-cell">
            <span className="we-lab">Speed</span>
            <div className="we-box" title="Source BPM → master BPM">{Math.round(trimBpm)}<i>→</i>{targetBpm}</div>
          </div>
          <div className="we-cell">
            <span className="we-lab">Length</span>
            <div className="we-box" title="Loop length">{lenTxt}</div>
          </div>
          <div className="we-cell">
            <span className="we-lab">Pitch</span>
            <div className="we-box drag" onPointerDown={onSemiDown} onPointerMove={onSemiMove} onPointerUp={onSemiUp} onWheel={onSemiWheel} title="Drag up/down or scroll to change pitch (semitones)">{semitones > 0 ? '+' : ''}{semitones} st</div>
          </div>
          <div className="we-cell">
            <span className="we-lab">Stretch</span>
            <div className="we-box" title="Stretch ratio to match master BPM">{slow || fast ? `×${rate.toFixed(2)}` : 'Native'}</div>
          </div>
        </div>

        {compact && onTimeMul && (
          <div className="we-tmrow">
            <span className="we-lab">Rate</span>
            <div className="seg we-gseg">
              {TIME_OPTS.map((o) => (
                <button key={o.m} title={o.tip} className={Math.abs((timeMul || 1) - o.m) < 1e-6 ? 'on' : ''} onClick={() => onTimeMul(o.m)}>{o.label}</button>
              ))}
            </div>
          </div>
        )}

        {!compact && <div className="we-subh"><span className="we-title" title="Controls both ruler line density and trim snap resolution">Grid / Snap</span></div>}
        <div className="we-gridrow">
          <div className="seg we-gseg">
            {!compact && <button className={!snap ? 'on' : ''} onClick={toggleSnapOff} title="Disable snap (free drag)">Off</button>}
            {GRID_OPTS.map((g) => (
              <button key={g.label} title={g.tip} className={snap && Math.abs(gridBars - g.bars) < 1e-6 ? 'on' : ''} onClick={() => pickGrid(g.bars)}>{g.label}</button>
            ))}
          </div>
        </div>
      </div>
  );

  const main = (
      <div className="we-main">
        <div className={'we-stage' + (previewing && queued ? ' is-queued' : '')} ref={stageRef}
          draggable={!!onDragOut} onDragStart={onStageDragStart} onPointerLeave={() => { if (armed) setArmed(false); if (fadeHover) setFadeHover(null); if (hoverRef.current) hoverRef.current.style.display = 'none'; }}
          onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onContextMenu={onContext}>
          <canvas ref={canvasRef} />
          <div className="we-hover" ref={hoverRef} style={{ display: 'none' }} />
          <div className="we-playhead" ref={playheadRef} style={{ display: previewing ? 'block' : 'none' }} />
          {menu && (
            <>
              <div className="we-menu-scrim" onPointerDown={(ev) => { ev.stopPropagation(); setMenu(null); }} onContextMenu={(ev) => { ev.preventDefault(); setMenu(null); }} />
              <div className="we-menu" style={{ left: menu.x, top: menu.y }} onPointerDown={(ev) => ev.stopPropagation()}>
                <button type="button" onClick={setAsStart}>Set as start</button>
                <button type="button" onClick={setAsEnd}>Set as end</button>
              </div>
            </>
          )}
          {onDragOut && (
            <div style={{ position: 'absolute', left: 8, top: 8, zIndex: 5, pointerEvents: 'none', display: 'flex', alignItems: 'center', gap: 4, padding: '2px 7px', borderRadius: 'var(--r)', fontSize: 10,
              background: 'color-mix(in srgb, var(--acc) 20%, var(--bg-1))', border: '1px solid color-mix(in srgb, var(--acc) 40%, var(--line))', color: 'var(--acc)', opacity: armed ? 1 : 0.55, transition: 'opacity .1s' }}>
              <span style={{ fontSize: 11, lineHeight: 1 }}>⠿</span>Drag waveform → instrument / track
            </div>
          )}
          {compact && (
            <button draggable={false} onPointerDown={(e) => e.stopPropagation()} onClick={() => canPreview && onPreviewToggle(region)} disabled={!canPreview}
              title={canPreview ? 'Preview this sample (only when transport is stopped)' : 'Transport is running — preview unavailable'}
              style={{ position: 'absolute', right: 8, bottom: 8, width: 26, height: 26, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 10, lineHeight: 1, border: 'none', borderRadius: 'var(--r)', zIndex: 5,
                cursor: canPreview ? 'pointer' : 'default', opacity: canPreview ? 1 : 0.35,
                background: warming ? 'var(--bg-3)' : previewing ? 'var(--play)' : 'var(--acc)', color: previewing ? '#23201d' : 'var(--acc-ink)' }}>{warming ? <span className="sg-spin sm" aria-hidden="true" /> : <TransportIcon stop={previewing} size={11} />}</button>
          )}
        </div>

        <div className="we-scroll" onPointerDown={onSbDown} onPointerMove={onSbMove} onPointerUp={onSbUp}>
          <div className="we-thumb" style={{ left: thumbLeft + '%', width: thumbW + '%' }} />
        </div>

        <div className="we-hint">Click waveform = preview · drag green line = move start (free) · drag orange anchor = change length · drag the cream dots (top/bottom) = fade-out tail · Shift+drag = stretch · scroll / Alt+scroll = pan / zoom</div>
      </div>
  );

  // compact:左侧控制块(通栏 + [mixer | rail])+ 右侧波形占满整高;否则沿用 [rail | main]。
  if (compact) {
    return (
      <div className="we we-compact">
        <div className="we-ctrl">
          {compactHeader}
          <div className="we-ctrl-body">
            {compactMixer}
            {rail}
          </div>
        </div>
        {main}
      </div>
    );
  }
  return <div className="we">{rail}{main}</div>;
}
