'use client';
/** §26.11 Song block 数字条左下:激活(enabled)乐器计数胶囊;hover 出名单浮层。
 *  浮层走 portal 挂 body,绕开 `.sblk-nums`/`.sblock` 的 overflow:hidden 裁剪(同 InstrumentChip)。
 *  纯只读派生:count/名单都从 session 实时算,无新状态、不进 undo;点击冒泡到块=选 session。 */
import { useState, useRef, useCallback, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { activeInstruments, resolveInstruments } from '@/contracts';
import type { Session } from '@/contracts';

export function SongInstrumentCount({ session }: { session: Session }) {
  const active = activeInstruments(session);
  const count = active.length;
  const total = resolveInstruments(session).length;
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ left: number; top: number; below: boolean } | null>(null);
  const badgeRef = useRef<HTMLSpanElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const openT = useRef<ReturnType<typeof setTimeout> | null>(null);
  const closeT = useRef<ReturnType<typeof setTimeout> | null>(null);
  const place = useCallback(() => {
    const r = badgeRef.current?.getBoundingClientRect(); if (!r) return;
    const winW = window.innerWidth || 1280;
    const below = r.top < 220; // 贴视口顶 → 翻下方,免跑出屏外
    setPos({ left: Math.max(8, Math.min(r.left, winW - 196)), top: below ? r.bottom + 6 : r.top - 6, below });
  }, []);
  const cancelTimers = () => { if (openT.current) clearTimeout(openT.current); if (closeT.current) clearTimeout(closeT.current); };
  const scheduleOpen = () => { cancelTimers(); openT.current = setTimeout(() => { place(); setOpen(true); }, 120); };
  const scheduleClose = () => { cancelTimers(); closeT.current = setTimeout(() => setOpen(false), 80); };
  useEffect(() => () => cancelTimers(), []); // 卸载清定时器
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('keydown', onKey);
    window.addEventListener('scroll', place, true); window.addEventListener('resize', place); // 滚动/resize 跟锚点走
    return () => { document.removeEventListener('keydown', onKey); window.removeEventListener('scroll', place, true); window.removeEventListener('resize', place); };
  }, [open, place]);
  return (
    <>
      <span ref={badgeRef} title="" className={'sblk-icount' + (count === 0 ? ' zero' : '')} aria-label={count ? `Active instruments: ${active.map((i) => i.label).join(', ')}` : 'No active instruments'}
        onMouseEnter={scheduleOpen} onMouseLeave={scheduleClose}>{count}</span>{/* title="" 抑制继承自 .sblock 的原生 name tooltip(否则与自定义浮层重叠=hover 出现两个) */}
      {open && pos && createPortal(
        <div ref={popRef} onMouseEnter={cancelTimers} onMouseLeave={scheduleClose}
          style={{ position: 'fixed', left: pos.left, top: pos.top, transform: pos.below ? 'none' : 'translateY(-100%)', zIndex: 260, background: 'var(--bg-1)', border: '1px solid var(--line-2)', borderRadius: 8, padding: '8px 9px', width: 180, boxSizing: 'border-box', boxShadow: '0 10px 28px rgba(0,0,0,0.45)' }}>
          <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: count ? 7 : 0, padding: '0 1px' }}>
            <span style={{ fontSize: 10, letterSpacing: '.08em', textTransform: 'uppercase', color: 'var(--tx-3)' }}>Active</span>
            <span style={{ fontSize: 10, fontVariantNumeric: 'tabular-nums', color: 'var(--tx-2)' }}>{count} / {total}</span>
          </div>
          {count === 0
            ? <div style={{ fontSize: 11, color: 'var(--tx-2)', paddingTop: 6 }}>No active instruments</div>
            : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 3, maxHeight: 168, overflowY: 'auto' }}>
                {active.map((i) => (
                  <div key={i.id} style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '2px 1px' }}>
                    <span style={{ flex: 'none', width: 9, height: 9, borderRadius: 2, background: i.color || 'var(--tx-3)' }} />
                    <span style={{ fontSize: 11, color: 'var(--tx)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{i.label}</span>
                  </div>
                ))}
              </div>
            )}
        </div>, document.body)}
    </>
  );
}
