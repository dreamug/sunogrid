'use client';

/** §26 session 标题栏换色点:展示当前 session 色,点开 SESSION_COLORS 浮层换色(管理颜色)。portal 挂 body,绕开块的 overflow:hidden。 */
import { useState, useRef, useCallback, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { SESSION_COLORS } from '@/contracts';

export function SessionColorDot({ color, onPick }: { color: string; onPick: (c: string) => void }) {
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
