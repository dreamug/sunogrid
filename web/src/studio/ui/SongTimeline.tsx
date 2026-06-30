'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { sessionColor, sessionSongStartBar, sessionSongEndBar } from '@/contracts';
import type { Session } from '@/contracts';
import type { StudioEngine } from '@/audio/studioEngine';
import { songTotalBars } from '@/studio/songQuery';
import { SongPlayhead } from './live';

type SongTimelineProps = { zoom: number; onZoom: (z: number | ((base: number) => number)) => void; sessions: Session[]; selectedIdx: number; engine: StudioEngine | null; playing: boolean; onSeekBar: (bar: number) => void; onVScroll?: (top: number) => void; gridEvery?: number; children: ReactNode };

/** §26.9 song 用滚动容器:在 HScroll 之上加 ① 滚轮平移 ② Alt 滚轮缩放(光标钉住) ③ 全局 bar 标尺(播放头穿标尺 + hover 引导线 + 喇叭点击跳播)。
 *  blocks 作 children 原样塞入(flex order 拖拽不变);标尺/播放头/引导线在同一 scroll 内容里按 cumBars 定位。 */
function SongTimeline({ zoom, onZoom, sessions, selectedIdx, engine, playing, onSeekBar, onVScroll, gridEvery = 1, children }: SongTimelineProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const guideRef = useRef<HTMLDivElement>(null);
  const zoomRef = useRef(zoom); zoomRef.current = zoom;
  const zoomApply = useRef<{ contentBar: number; cx: number } | null>(null); // Alt 缩放后回正 scrollLeft(光标钉住)
  const [thumb, setThumb] = useState({ left: 0, width: 100, show: false });
  const [viewW, setViewW] = useState(0); // §37 滚动容器可视宽 → bar 号画满整条标尺(不止 session 长度)

  const total = Math.max(1, songTotalBars(sessions)); const W = Math.max(1, total * zoom);
  const divs = [...new Set([0, total, ...sessions.flatMap((s) => [sessionSongStartBar(s), sessionSongEndBar(s)])])].sort((a, b) => a - b);
  // 选中 session → 标尺上对应 bar 段铺同色淡底(left/width 用 cum,与块精确对齐)
  const selS = sessions[selectedIdx];
  const selColor = selS ? sessionColor(selS) : null;
  const selLeft = selS ? sessionSongStartBar(selS) * zoom : 0;
  const selW = selS ? (sessionSongEndBar(selS) - sessionSongStartBar(selS)) * zoom : 0;

  const onVScrollRef = useRef(onVScroll); onVScrollRef.current = onVScroll; // §37 纵向 scrollTop → gutter 同步(ref 防 [] 闭包过期)
  // 自定义横向滚动条 thumb 同步(同 HScroll)+ 上报纵向 scrollTop(冻结窗格:gutter 表头跟着平移)
  useEffect(() => {
    const el = scrollRef.current; if (!el) return;
    const update = () => { const w = el.clientWidth, sw = el.scrollWidth; setViewW(w); const width = sw > 0 ? Math.min(100, (w / sw) * 100) : 100; setThumb({ left: sw > w ? (el.scrollLeft / (sw - w)) * (100 - width) : 0, width, show: sw > w + 1 }); onVScrollRef.current?.(el.scrollTop); };
    update(); el.addEventListener('scroll', update, { passive: true });
    const ro = new ResizeObserver(update); ro.observe(el); if (el.firstElementChild) ro.observe(el.firstElementChild);
    return () => { el.removeEventListener('scroll', update); ro.disconnect(); };
  }, []);
  // 滚轮=平移;Alt+滚轮=以光标为支点缩放(原生非被动监听才能 preventDefault);照搬 CollageEditor。
  useEffect(() => {
    const el = scrollRef.current; if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (e.altKey || e.ctrlKey) { // §37 Alt 滚轮缩放;ctrlKey = macOS 触控板 pinch(浏览器以 ctrl+wheel 暴露)→ 同一条缩放路径
        e.preventDefault();
        const cx = e.clientX - el.getBoundingClientRect().left;
        zoomApply.current = { contentBar: (el.scrollLeft + cx) / zoomRef.current, cx };
        // perf:函数 updater —— rAF 合并同帧多个滚轮事件时,从 pending base 累积(乘性缩放不丢档),而非读已 commit 的旧 zoom。
        //   上下限交给 commitZoom 统一钳(SONG_ZOOM_MIN..MAX,与滑块一致)→ pinch/Alt 滚轮不再越界到极端 zoom 卡顿。
        onZoom((base) => base * Math.exp(-e.deltaY * 0.0015));
      } else if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) { // §37 横滚(bar):Shift+滚轮 或 横向 trackpad
        const d = e.deltaX || e.deltaY; if (d === 0) return; e.preventDefault(); el.scrollLeft += d;
      } // §37 else 平 wheel = 纵向滚 track:不 preventDefault,交给容器 overflow-y 原生处理
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [onZoom]);
  useEffect(() => { const el = scrollRef.current, z = zoomApply.current; if (el && z) { el.scrollLeft = Math.max(0, z.contentBar * zoom - z.cx); zoomApply.current = null; } }, [zoom]);

  const barAtX = (clientX: number, snap = false) => { const el = scrollRef.current; if (!el) return 0; const raw = (el.scrollLeft + clientX - el.getBoundingClientRect().left) / zoom; return Math.max(0, Math.min(total - 1e-6, snap ? Math.round(raw) : raw)); }; // §39 底层无极(songPlayFrom 吃小数 bar);snap=吸附到整 bar 的体验层(Alt 绕过=精细无极)
  const onRulerMove = (e: React.PointerEvent) => { const g = guideRef.current; if (g) { g.style.display = 'block'; g.style.left = barAtX(e.clientX, !e.altKey) * zoom + 'px'; } }; // guide 吸到 bar 线:所见即起播点
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

  // perf:标尺 bar 号 memo —— 横向 scroll 走 setThumb 重渲 SongTimeline,但 nums(长歌可达成百上千个 <span>)只依赖 zoom/总长/可视宽,
  //   scroll 时这些不变 → 直接复用,不再每个 scroll 事件重建整条标尺(拖动滚动条卡顿的隐形大头,随歌越长越明显)。
  const nums = useMemo(() => {
    const labelEvery = Math.max(gridEvery || 1, zoom >= 26 ? 1 : zoom >= 15 ? 2 : 4); // §37 bar 号间隔跟 GRID(2→1 3 5、4→1 5 9),低 zoom 再按密度疏一档
    const lastBar = Math.max(total, Math.ceil(viewW / zoom)); // §37 画到 session 长度 与 可视宽度 的较大者 → 标尺数字铺满整条
    const out: React.ReactNode[] = [];
    for (let b = 0; b < lastBar; b++) if (b % labelEvery === 0) out.push(<span key={b} className="song-rn" style={{ left: b * zoom + 3 }}>{b + 1}</span>);
    return out;
  }, [total, viewW, zoom, gridEvery]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0, height: '100%' }}>
      <div ref={scrollRef} className="lane-scroll" style={{ overflowX: 'auto', overflowY: 'auto', minWidth: 0, scrollbarWidth: 'none', flex: 1, minHeight: 0 }}>
        <div className="song-content" style={{ position: 'relative', width: 'max-content', minWidth: '100%', backgroundImage: gridEvery > 0 ? `repeating-linear-gradient(90deg, rgba(236,233,227,.08) 0 1px, transparent 1px ${gridEvery * zoom}px, rgba(236,233,227,.025) ${gridEvery * zoom}px ${gridEvery * zoom + 1}px, transparent ${gridEvery * zoom + 1}px ${gridEvery * zoom * 2}px)` : undefined }}>{/* §37 全高 bar 网格:两边通、一深一浅交替(深.08@0 / 浅.025@1单位,周期2单位) */}
          <div className="song-ruler" style={{ width: W, minWidth: '100%', backgroundImage: gridEvery > 0 ? `repeating-linear-gradient(90deg, rgba(236,233,227,.07) 0 1px, transparent 1px ${gridEvery * zoom}px, rgba(236,233,227,.022) ${gridEvery * zoom}px ${gridEvery * zoom + 1}px, transparent ${gridEvery * zoom + 1}px ${gridEvery * zoom * 2}px)` : undefined }} onPointerMove={onRulerMove} onPointerLeave={onRulerLeave} onClick={(e) => onSeekBar(barAtX(e.clientX, !e.altKey))}>
            {nums}
          </div>
          {children}
          <div ref={guideRef} className="song-guide" style={{ display: 'none' }} aria-hidden="true" />
          <SongPlayhead engine={engine} playing={playing} px={zoom} blockStartBars={0} loopBars={total} />{/* §39 走带单调递增 → 按总长取模回绕(非循环时 pos≤total,取模恒等) */}
        </div>
      </div>
      {thumb.show && <div className="we-scroll song-hscroll" onPointerDown={thumbDown}><div className="we-thumb" style={{ left: thumb.left + '%', width: thumb.width + '%' }} /></div>}
    </div>
  );
}

/** Song 模式走 SongTimeline(标尺/滚轮/缩放),Live 模式走朴素 HScroll。 */
export function RailScroll({ song, children, ...rest }: SongTimelineProps & { song: boolean }) {
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
