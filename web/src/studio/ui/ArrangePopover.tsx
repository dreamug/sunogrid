'use client';
/** arrange 轨浮层:portal 挂 body,落在底部编辑器(footer)之上、左缘让开素材列表(aside.br),近满主区宽;Esc 收起;resize/scroll 跟随。 */
import { useState, useRef, useEffect } from 'react';
import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';

export function ArrangePopover({ onClose, onHeight, children }: { onClose: () => void; onHeight?: (h: number) => void; children: ReactNode }) {
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
