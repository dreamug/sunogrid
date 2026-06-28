'use client';
// 自驱动「活叶子」—— 高频视觉(电平表/走带位置/播放头/电平条)各自订阅一个**共享单 rAF**,
// 每帧只重渲自己这片小组件,不再让 StudioApp 整树每帧 setTick。离散态(voice on/off/呼吸、
// 编辑器布尔)仍由父树在用户动作 + 引擎 onChange 边界跃迁时重渲(见 studioEngine.onChange)。
import { memo, useEffect, useReducer, useRef } from 'react';
import type { StudioEngine } from '@/audio/studioEngine';

// --- 共享单 rAF:所有活跃叶子每帧被叫一次;无人订阅则停表 ---
const subs = new Set<() => void>();
let rafId: number | null = null;
function tickAll(): void { for (const f of [...subs]) f(); rafId = subs.size ? requestAnimationFrame(tickAll) : null; }
function subscribe(f: () => void): () => void {
  subs.add(f);
  if (rafId == null) rafId = requestAnimationFrame(tickAll);
  return () => { subs.delete(f); if (subs.size === 0 && rafId != null) { cancelAnimationFrame(rafId); rafId = null; } };
}
/** active 时订阅共享 rAF,每帧强制本组件重渲;false 时静止(不订阅、不重渲)。 */
export function useFrame(active: boolean): void {
  const [, bump] = useReducer((x: number) => (x + 1) & 0xffff, 0);
  useEffect(() => { if (!active) return; return subscribe(bump); }, [active]);
}

// --- 波形多边形:memo —— peaks/className 不变就不重建 path 字符串(播放时整树不再每帧重算它) ---
export const Wave = memo(function Wave({ peaks, className }: { peaks: number[]; className: string }) {
  const n = peaks.length; if (n < 2) return null;
  const sx = 100 / (n - 1);
  const yT = (p: number) => (50 - Math.max(p, 0.03) * 46).toFixed(2);
  const yB = (p: number) => (50 + Math.max(p, 0.03) * 46).toFixed(2);
  let d = `M 0 ${yT(peaks[0])}`;
  for (let i = 1; i < n; i++) d += `L${(i * sx).toFixed(2)} ${yT(peaks[i])}`;
  for (let i = n - 1; i >= 0; i--) d += `L${(i * sx).toFixed(2)} ${yB(peaks[i])}`;
  d += 'Z';
  return <svg className={className} viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true"><path d={d} fill="currentColor" /></svg>;
});

// 主峰值表配色:归一窗口 [-48,0]dBFS。peak ≥-3dBFS(逼近软削波天花板)→ 红 · ≥-6 → 琥珀 · 其余 → 绿。
function meterColor(v: number): string { return v >= 0.9375 ? '#e5564b' : v >= 0.875 ? '#e0a32e' : '#5dcaa5'; }

/** 顶栏主 L/R 峰值表:自驱动每帧抽真实总线(master,post-FX/post 主音量/pre-软削波)的 peak(引擎内做快攻慢落弹道)。 */
export function MasterMeter({ engine, playing }: { engine: StudioEngine | null; playing: boolean }) {
  useFrame(playing && !!engine);
  const [l, r] = playing && engine ? engine.masterLevel() : [0, 0];
  return (
    <span className="tb-meter">
      <span className="mrow"><i style={{ width: `${Math.round(l * 100)}%`, background: meterColor(l) }} /></span>
      <span className="mrow"><i style={{ width: `${Math.round(r * 100)}%`, background: meterColor(r) }} /></span>
    </span>
  );
}

/** 顶栏走带位置 bar.beat.16th:自驱动。loopBars>0(song 循环)→ bar 按总长回绕,免走带单调递增时读数无限增大。 */
export function TransportPos({ engine, playing, loopBars = 0 }: { engine: StudioEngine | null; playing: boolean; loopBars?: number }) {
  useFrame(playing && !!engine);
  const p = playing && engine ? engine.barBeat() : { bar: 1, beat: 1, sixteenth: 1 };
  const bar = loopBars > 0 ? ((p.bar - 1) % loopBars + loopBars) % loopBars + 1 : p.bar; // §39 单调走带 → 回绕到 [1,loopBars]
  return <span className="tb-pos" title="bar · beat · 16th"><b>{bar}</b><i>.</i><b>{p.beat}</b><i>.</i><b className="dim">{p.sixteenth}</b></span>;
}

/** 乐器实时电平 0..1:自驱动取数(给 tile launch fill / mixer fader 共用)。active=false → fallback。 */
export function useVoiceLevel(getLevel: (() => number) | undefined, active: boolean, fallback = 0): number {
  useFrame(active && !!getLevel);
  return active && getLevel ? getLevel() : fallback;
}

/** sample tile 波形:base(memo,常显)+ 已播 fill(clipPath)+ 播放头线;自驱动读 voicePhase。 */
export function SampleWave({ engine, id, peaks, color, playing }: { engine: StudioEngine | null; id: string; peaks: number[]; color: string; playing: boolean }) {
  useFrame(playing && !!engine);
  const ph = playing && engine ? engine.voicePhase(id) : null;
  return (
    <div className="cwave" aria-hidden="true">
      <Wave className="cwave-base" peaks={peaks} />
      <div className="cwave-fill" style={{ clipPath: ph != null ? `inset(0 ${(100 - ph * 100).toFixed(1)}% 0 0)` : 'inset(0 100% 0 0)' }}><Wave className="" peaks={peaks} /></div>
      {ph != null && <div style={{ position: 'absolute', top: 0, bottom: 0, left: `${(ph * 100).toFixed(1)}%`, width: 1, background: color, opacity: 0.95, pointerEvents: 'none' }} />}
    </div>
  );
}

/** collage tile 播放头线:自驱动读 voicePhase(底块/波形/网格由 memo 的 CollagePadBody 一次渲好)。
 *  包一层 .cwave —— 与 CollagePadBody / SampleWave 同一坐标系(让开左侧 24px launch 键),
 *  否则 ph% 会按整 pad 算 → 从最左边(播放键背后)起跳,且与波形/小节网格错位。 */
export function CollageHead({ engine, id, playing }: { engine: StudioEngine | null; id: string; playing: boolean }) {
  useFrame(playing && !!engine);
  const ph = playing && engine ? engine.voicePhase(id) : null;
  if (ph == null) return null;
  return (
    <div className="cwave" aria-hidden="true">
      <div style={{ position: 'absolute', top: 0, bottom: 0, left: `${(ph * 100).toFixed(1)}%`, width: 1, background: '#fff', opacity: 0.9, pointerEvents: 'none' }} />
    </div>
  );
}

/** §20 场景播放态(自驱动,类 pad 播放头但无波形):
 *  Live —— 卡内一条线随 loop 一直扫(period = 本场 bar 数);Song —— 线在"当前第几遍"那格内扫 + 该格柔和同色高亮,逐格推进。 */
export function SessionPlayhead({ engine, mode, startBar, barsPerRep, repeats, playing, cardW = 168, cellW = 40, px }: { engine: StudioEngine | null; mode: 'live' | 'song'; startBar: number; barsPerRep: number; repeats: number; playing: boolean; cardW?: number; cellW?: number; px?: number }) {
  useFrame(playing && !!engine && barsPerRep > 0);
  const ref = useRef<HTMLDivElement>(null);
  // §26 播放与横向滚动完全解耦:播放头不再带动 scrollLeft(用户手动滚动;播放头自由扫,可滚出视口)。
  if (!playing || !engine || barsPerRep <= 0) return null;
  const pos = engine.songPosBars();
  const frac = (x: number) => ((x % barsPerRep) + barsPerRep) % barsPerRep / barsPerRep; // loop 内相位 0..1
  if (mode === 'live') {
    const x = frac(pos) * cardW; // 卡内 loop 相位 → 像素
    return (
      <>
        <div className="ph" style={{ left: 0, width: x }} aria-hidden="true" />{/* 已播进度色块(类 pad fill) */}
        <div ref={ref} className="sphead" style={{ left: x }} aria-hidden="true" />{/* 播放头线 */}
      </>
    );
  }
  const rel = pos - startBar;
  if (rel < 0) return null;
  if (px != null) { // §26 比例式 song:整块连续定位(无 cardW 前缀、无定宽格)
    const total = barsPerRep * repeats;
    const x = Math.max(0, Math.min(total, rel)) * px;
    return (<><div className="ph" style={{ left: 0, width: x }} aria-hidden="true" /><div ref={ref} className="sphead" style={{ left: x }} aria-hidden="true" /></>);
  }
  const idx = Math.max(0, Math.min(repeats - 1, Math.floor(rel / barsPerRep)));
  return (
    <>
      <div className="ph" style={{ left: cardW + idx * cellW, width: cellW }} aria-hidden="true" />
      <div ref={ref} className="sphead" style={{ left: cardW + idx * cellW + frac(rel) * cellW }} aria-hidden="true" />
    </>
  );
}

/** §26.9 列级播放头:song 模式整条时间轴(标尺+块)穿一条线。
 *  走带单调递增不回零(§39),loopBars>0 时按 songPosBars % loopBars 取模 → 由时钟派生的回绕,
 *  恰在时钟跨界(=音频换场 time)那刻翻折,不再随提前触发的 JS 早跳(旧 setTransportPosition 重置会让播放头提前约一个 lookahead 拽回头)。 */
export function SongPlayhead({ engine, playing, px, blockStartBars, loopBars = 0 }: { engine: StudioEngine | null; playing: boolean; px: number; blockStartBars: number; loopBars?: number }) {
  useFrame(playing && !!engine);
  if (!playing || !engine) return null;
  const raw = engine.songPosBars();
  const pos = loopBars > 0 ? raw % loopBars : raw; // §39 时钟取模:循环回绕与音频换场同刻,无早跳
  const x = Math.max(0, (blockStartBars + pos) * px);
  return <div className="song-ph" style={{ left: x }} aria-hidden="true" />;
}

/** tile launch 键的电平填充(竖向):自驱动读 voiceLevel。 */
export function LaunchLevel({ engine, id, color, playing }: { engine: StudioEngine | null; id: string; color: string; playing: boolean }) {
  const level = useVoiceLevel(engine ? () => engine.voiceLevel(id) : undefined, playing);
  return <span style={{ position: 'absolute', left: 0, right: 0, bottom: 0, height: `${Math.round(level * 100)}%`, background: `color-mix(in srgb, ${color} 60%, #fff)`, opacity: 0.6, pointerEvents: 'none' }} />;
}
