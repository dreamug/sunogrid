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
import type { Clip } from '@/contracts';
import type { ApiSound } from '@/studio/api';

export interface WarpRegion {
  startSample: number;
  endSample: number;
  bars: number; // loop 长度(小节,可分数)
  semitones: number;
}

/** 预览路由(因场景而异,由宿主注入):库素材=裸试听;乐器=过自己的 mixer。 */
export interface ClipPreview {
  previewing: boolean;
  getPhase: () => number | null;
  toggle: () => void;
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
}

/** studio 唯一的 clip 调整入口。解码 + region↔Clip 映射 + 预览接线都收在这,调用点只管喂 Clip、收 Clip。 */
export function ClipEditor({ clip, sound, targetBpm, beatsPerBar = 4, onChange, preview, mixer, header, canPreview = true, showTimeMul = true, onDragOut }: ClipEditorProps) {
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
      previewing={preview.previewing} queued={preview.queued} warming={preview.warming} getPhase={preview.getPhase} onPreviewToggle={() => preview.toggle()}
      onChange={(r) => onChange({ ...clip, startSample: r.startSample, endSample: r.endSample, bars: r.bars, semitones: r.semitones })}
      hideHead compact compactHeader={header} compactMixer={mixer} canPreview={canPreview} onDragOut={onDragOut}
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
  previewing: boolean;            // 受控:由上层(库▶ / 编辑器播放键)统一管
  getPhase: () => number | null;  // 预览播放线相位 0..1(引擎按真实起播算);null=没在播
  onPreviewToggle: (r: WarpRegion) => void; // 播放/暂停
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
}

const RULER_H = 22;
const ANCHOR_HIT = 8; // px
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

type DragMode = 'trimStart' | 'trimEnd' | 'stretch';
interface DragSnap { mode: DragMode; grabSrcSec: number; anchorSrcSec0: number; secPerBar0: number; grabBarOffset: number; loopLen0: number; }

function WarpCanvas({ channels, sampleRate, analysis, nativeBpm, targetBpm, beatsPerBar = 4, initSemitones = 0, previewing, getPhase, onPreviewToggle, onChange, onReset, hideHead = false, compact = false, compactHeader, compactMixer, timeMul = 1, onTimeMul, canPreview = true, queued = false, warming = false, onDragOut }: Props) {
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
    const sig = `${analysis.startSample}|${analysis.endSample}|${analysis.bars}|${initSemitones}`; // 这条 clip 的 region 身份(用于区分「自家改动回流」vs 外部变更)
    return { anchorOutBar: 1, anchorSrcSec: s0, secPerBar, trimStartBar: 1, trimEndBar: 1 + N, N, semitones: initSemitones, sig };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [analysis, sampleRate, nativeBpm, beatsBar, initSemitones]);

  const [anchorOutBar, setAnchorOutBar] = useState(init.anchorOutBar);
  const [anchorSrcSec, setAnchorSrcSec] = useState(init.anchorSrcSec);
  const [secPerBar, setSecPerBar] = useState(init.secPerBar);
  const [trimStartBar, setTrimStartBar] = useState(init.trimStartBar);
  const [trimEndBar, setTrimEndBar] = useState(init.trimEndBar);
  const [gridBars, setGridBars] = useState(0.25); // 默认 1/4(拍)
  const [semitones, setSemitones] = useState(init.semitones);
  const [snap, setSnap] = useState(true);
  const [barsVisible, setBarsVisible] = useState(init.N + 2);
  const [vStart, setVStart] = useState(0);
  const [armed, setArmed] = useState(false); // 光标在波形身体(非 trim 锚 / 非 Shift)→ 波形可拖出乐器

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const playheadRef = useRef<HTMLDivElement>(null);
  const rafRef = useRef<number | null>(null);
  const playRef = useRef({ trimStartBar: 1, loopLen: 1 }); // 正在播放那段的几何(起播 / 提交时锁定;拖动中不变)→ 播放线按真正在响的 loop 算,不随未提交的 loopLen 漂
  const drag = useRef<DragSnap | null>(null);
  const clickCand = useRef<{ x: number; y: number } | null>(null); // 空白区「点击试听」候选:松手时若没怎么动 → 触发一次预览
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
    setSemitones(init.semitones); setBarsVisible(init.N + 2); setVStart(0);
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
  // 不夹到 [0,total]:loop 可滑出音频(超出部分渲染时补零);srcEnd-srcStart 恒 = loopLen·secPerBar → 速率不变量成立
  const srcStart = Math.round(srcSecAt(trimStartBar) * sampleRate);
  const srcEnd = Math.max(srcStart + 1, Math.round(srcSecAt(trimEndBar) * sampleRate));
  const trimBpm = secPerBar > 0 ? (beatsBar * 60) / secPerBar : 0;
  const rate = masterBar > 0 ? secPerBar / masterBar : 1;
  const region: WarpRegion = { startSample: srcStart, endSample: srcEnd, bars: loopLen, semitones };

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

    const anchor = (x: number, color: string) => {
      c.strokeStyle = color; c.lineWidth = 1.5;
      c.beginPath(); c.moveTo(x, 0); c.lineTo(x, H); c.stroke();
      c.fillStyle = color;
      c.beginPath(); c.moveTo(x - 5, 0); c.lineTo(x + 5, 0); c.lineTo(x, 9); c.closePath(); c.fill();
    };
    anchor(tx0, '#7cd17c');
    anchor(tx1, '#e8a33d');
  }, [mono, total, sampleRate, barsVisible, vStart, trimStartBar, trimEndBar, beatsBar, gridBars, srcSecAt, outBarAt, analysis.onsets]);

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
    const stage = stageRef.current!;
    const W = stage.clientWidth;
    const pxPerBar = W / barsVisible;
    const x = e.clientX - stage.getBoundingClientRect().left;
    const ob = vStart + x / pxPerBar;
    const xStart = (trimStartBar - vStart) * pxPerBar;
    const xEnd = (trimEndBar - vStart) * pxPerBar;
    let mode: DragMode;
    if (Math.abs(x - xEnd) <= ANCHOR_HIT) mode = 'trimEnd';
    else if (Math.abs(x - xStart) <= ANCHOR_HIT) mode = 'trimStart';
    else if (e.shiftKey) mode = 'stretch';
    else {
      // 空白/身体区不平移波形(起播位置只由绿色起始线决定);记为点击候选,松手没怎么动 = 试听一次。
      // 可拖出且在身体区(armed)时不夺指针捕获 —— 否则会压住原生 HTML5 拖拽,波形就拖不出去。
      if (!(onDragOut && armed)) (e.target as Element).setPointerCapture(e.pointerId);
      clickCand.current = { x: e.clientX, y: e.clientY };
      return;
    }
    (e.target as Element).setPointerCapture(e.pointerId);
    draggingRef.current = true;
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
      setTrimEndBar(Math.max(trimStartBar + gridBars, s)); // 吸附到相对起点的网格 → 长度=网格整数倍;可超出音频(补零)
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
    }
  };
  const onMove = (e: React.PointerEvent) => {
    if (drag.current) { applyDrag(e.clientX); return; }
    const cc = clickCand.current; // 移动超过阈值 → 不是点击,取消试听候选
    if (cc && (Math.abs(e.clientX - cc.x) > 4 || Math.abs(e.clientY - cc.y) > 4)) clickCand.current = null;
    // 悬停光标:锚点附近(或按住 Shift 变速)= 横向拖拽箭头;波形身体(可拖出时)= 抓手;其余 = 喇叭(CSS)
    const stage = stageRef.current;
    if (stage) {
      const pxPerBar = stage.clientWidth / barsVisible;
      const x = e.clientX - stage.getBoundingClientRect().left;
      const nearAnchor = Math.abs(x - (trimEndBar - vStart) * pxPerBar) <= ANCHOR_HIT || Math.abs(x - (trimStartBar - vStart) * pxPerBar) <= ANCHOR_HIT;
      const canDrag = !!onDragOut && !nearAnchor && !e.shiftKey; // 身体区可拖出(避开 trim 锚 / Shift 变速)→ 切到 draggable
      if (canDrag !== armed) setArmed(canDrag);
      stage.style.cursor = nearAnchor || e.shiftKey ? 'ew-resize' : canDrag ? 'grab' : '';
    }
  };
  // 波形身体拖出:HTML5 drag(目标 pad/轨复用现成 text/plain 落点);只在 armed(非锚、非 Shift)时允许,否则取消让位给 trim。
  const onStageDragStart = (e: React.DragEvent) => {
    if (!onDragOut || !armed) { e.preventDefault(); return; }
    clickCand.current = null; // 拖出时不再当作轻点试听
    onDragOut(e);
  };
  const onUp = () => {
    if (clickCand.current) { clickCand.current = null; if (canPreview) onPreviewToggle(region); return; } // 空白区轻点 = 试听一次(不提交)
    drag.current = null; draggingRef.current = false; if (compact) commitNow();
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
    if (!previewing) return;
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
      lastEmitSig.current = `${r.startSample}|${r.endSample}|${r.bars}|${r.semitones}`; // 记下这次 emit:回流时 init.sig 会匹配 → 不重置视图
      playRef.current = { trimStartBar: viewRef.current.trimStartBar, loopLen: viewRef.current.loopLen }; // 提交 = 引擎换新 buffer(重 audition)→ 播放线几何同步切到新 loop
      onChangeRef.current(r);
    }, 200);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trimStartBar, trimEndBar, anchorOutBar, anchorSrcSec, secPerBar, semitones, commitTick]);
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
              <button className={'we-play' + (previewing ? ' on' : '')} onClick={() => onPreviewToggle(region)} title="Play / stop (quantises to bar boundary when transport is running)">{previewing ? '⏸ Stop' : '▶ Play'}</button>
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
            {!compact && <button className={!snap ? 'on' : ''} onClick={() => setSnap(false)} title="Disable snap (free drag)">Off</button>}
            {GRID_OPTS.map((g) => (
              <button key={g.label} title={g.tip} className={snap && Math.abs(gridBars - g.bars) < 1e-6 ? 'on' : ''} onClick={() => { setSnap(true); setGridBars(g.bars); }}>{g.label}</button>
            ))}
          </div>
        </div>
      </div>
  );

  const main = (
      <div className="we-main">
        <div className={'we-stage' + (previewing && queued ? ' is-queued' : '')} ref={stageRef}
          draggable={!!onDragOut && armed} onDragStart={onStageDragStart} onPointerLeave={() => { if (armed) setArmed(false); }}
          onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp}>
          <canvas ref={canvasRef} />
          <div className="we-playhead" ref={playheadRef} style={{ display: previewing ? 'block' : 'none' }} />
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
                background: warming ? 'var(--bg-3)' : previewing ? 'var(--play)' : 'var(--acc)', color: previewing ? '#23201d' : 'var(--acc-ink)' }}>{warming ? <span className="sg-spin sm" aria-hidden="true" /> : previewing ? '■' : '▶'}</button>
          )}
        </div>

        <div className="we-scroll" onPointerDown={onSbDown} onPointerMove={onSbMove} onPointerUp={onSbUp}>
          <div className="we-thumb" style={{ left: thumbLeft + '%', width: thumbW + '%' }} />
        </div>

        <div className="we-hint">Click waveform = preview · drag green line = move start (free) · drag orange anchor = change length · Shift+drag = stretch · scroll / Alt+scroll = pan / zoom</div>
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
