'use client';
// arrange 轨(占单 sample 壳的 main 位):网格吸附拖移(夹邻不重叠、可留白)、拖库素材进网格位、尾部 headroom 供延长。
// 选中片不在这里改 —— 点片弹出浮层 ClipEditor(在 footer 分支里渲染);片带 data-clip-id 供浮层锚定。
import { useState, useRef, useEffect } from 'react';
import type { Instrument } from '@/contracts';
import { PX, cvar, sliceColorFor } from '@/studio/shared';
import { lanePeaksCache, peaksFromRegion } from '@/studio/peaks';
import { decodeAsset } from '@/studio/realLibrary';
import { Wave } from './live';
import { TransportIcon } from './glyphs';

export function CollageEditor({ inst, gridBars, selClipId, onSelectClip, onMoveStart, onMove, onMoveEnd, onAltDuplicate, onDropSound, onDropInst, onLoop, previewing, getPhase, onPreviewToggle, canPreview, dragBars, acceptDrop = true }: {
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
          {/* 网格线移到波形之上(放到片前面,做对齐参考,与 pad 的叠加式网格同观感);zIndex:2 在片(auto)之上、loop 暗罩(3)之下 → out-of-loop 仍被罩暗 */}
          <div aria-hidden="true" style={{ position: 'absolute', inset: 0, pointerEvents: 'none', zIndex: 2, backgroundImage: `repeating-linear-gradient(90deg, rgba(255,255,255,0.18) 0 1px, transparent 1px ${spb * stepPx}px), repeating-linear-gradient(90deg, rgba(255,255,255,0.07) 0 1px, transparent 1px ${snapSteps * stepPx}px)` }} />
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
