'use client';
/** perf:Song zoom/grid 状态隔离容器。把 songZoom/songGrid 从 StudioApp(3100 行单体)抽出 —— zoom 高频改动只重渲本 scope
 *  包住的 stage section(arranger+pad ~3ms),不再触发整树重渲(toolbar/footer/library 全在 scope 外、不动)。
 *  children 是 render-prop:闭包直接捕获 StudioApp 作用域里的 sessions/handlers,免线程几十个 props(参数命名同原变量 → section 内 JSX 零改动)。
 *  rAF 合并(每帧≤1 commit)+ 钳制 + 函数 updater(滚轮乘性累积不丢档)都在此;zoomRef 暴露当前 zoom 给 StudioApp 拖拽 handler;onPersist 防抖落 gridPrefs(首帧不回写)。 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { clampZoom } from '@/studio/shared';

export function SongZoomScope({ initialZoom, initialGrid, zoomRef, onPersist, children }: {
  initialZoom: number; initialGrid: number;
  zoomRef: React.MutableRefObject<number>;
  onPersist: (zoom: number, grid: number) => void;
  children: (zoom: number, grid: number, commitZoom: (n: number | ((b: number) => number)) => void, setGrid: (g: number) => void) => ReactNode;
}) {
  const [zoom, setZoom] = useState(() => clampZoom(initialZoom));
  const [grid, setGrid] = useState(initialGrid);
  zoomRef.current = zoom; // 每渲染回写:StudioApp 体内拖拽 handler 读当前 zoom
  const zRef = useRef(zoom); zRef.current = zoom;
  const pending = useRef<number | null>(null);
  const raf = useRef<number | null>(null);
  const commitZoom = useCallback((next: number | ((b: number) => number)) => {
    const base = pending.current ?? zRef.current;
    const v = clampZoom(typeof next === 'function' ? next(base) : next); // 统一钳上下限:滑块/Alt滚轮/pinch 都不越界
    if (typeof document !== 'undefined' && document.hidden) { pending.current = null; setZoom(v); return; } // 隐藏标签 rAF 暂停 → 同步提交兜底
    pending.current = v;
    if (raf.current != null) return;
    raf.current = requestAnimationFrame(() => { raf.current = null; const x = pending.current; pending.current = null; if (x != null) setZoom(x); });
  }, []);
  const persistRef = useRef(onPersist); persistRef.current = onPersist;
  const hydrated = useRef(false);
  useEffect(() => {
    if (!hydrated.current) { hydrated.current = true; return; } // 首帧=load 进来的值,不回写
    const t = setTimeout(() => persistRef.current(zoom, grid), 300);
    return () => clearTimeout(t);
  }, [zoom, grid]);
  return <>{children(zoom, grid, commitZoom, setGrid)}</>;
}
