'use client';

/** 乐器色块 + 图标:展示当前图标(底色 = 乐器色),点开浮层换颜色/图标。浮层用 portal 挂到 body 上弹,绕开外壳的 overflow:hidden 裁剪。 */

import { useState, useRef, useCallback, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { CHIP_COLORS } from '@/studio/shared';
import { InstrumentIcon, INSTRUMENT_ICONS, ICON_KEYS, DEFAULT_ICON } from './instrumentIcons';

export function InstrumentChip({ color, icon, size = 26, onPick }: { color: string; icon?: string | null; size?: number; onPick: (patch: { color?: string; icon?: string }) => void }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ left: number; top: number; below: boolean } | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  // 上方放不下(如 arrange 浮层贴到视口顶,chip 在很上面)→ 翻到锚点下方;左缘夹进视口。否则浮层会跑到屏幕外。
  const place = useCallback(() => {
    const r = btnRef.current?.getBoundingClientRect(); if (!r) return;
    const winW = window.innerWidth || 1280;
    const below = r.top < 200;
    setPos({ left: Math.max(8, Math.min(r.left, winW - 230)), top: below ? r.bottom + 6 : r.top - 6, below });
  }, []);
  const toggle = () => { place(); setOpen((o) => !o); };
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => { const t = e.target as Node; if (!btnRef.current?.contains(t) && !popRef.current?.contains(t)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDoc); document.addEventListener('keydown', onKey);
    window.addEventListener('scroll', place, true); window.addEventListener('resize', place); // 滚动/resize 跟着锚点走
    return () => { document.removeEventListener('mousedown', onDoc); document.removeEventListener('keydown', onKey); window.removeEventListener('scroll', place, true); window.removeEventListener('resize', place); };
  }, [open, place]);
  const cur = icon || DEFAULT_ICON;
  return (
    <>
      <button ref={btnRef} onClick={toggle} title="Change icon / color" style={{ flex: 'none', width: size, height: size, borderRadius: 6, border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', background: `color-mix(in srgb, ${color} 30%, transparent)`, color: `color-mix(in srgb, ${color} 80%, #fff)` }}>
        <InstrumentIcon icon={cur} size={Math.round(size * 0.7)} />
      </button>
      {open && pos && createPortal(
        <div ref={popRef} style={{ position: 'fixed', left: pos.left, top: pos.top, transform: pos.below ? 'none' : 'translateY(-100%)', zIndex: 260, background: 'var(--bg-1)', border: '1px solid var(--line-2)', borderRadius: 8, padding: 9, width: 222, boxShadow: '0 10px 28px rgba(0,0,0,0.45)' }}>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 9 }}>
            {CHIP_COLORS.map((c) => (
              <button key={c} onClick={() => onPick({ color: c })} title={c} style={{ width: 20, height: 20, borderRadius: 5, cursor: 'pointer', background: c, border: c === color ? '2px solid #fff' : '1px solid var(--line-2)' }} />
            ))}
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(6,1fr)', gap: 4 }}>
            {ICON_KEYS.map((k) => (
              <button key={k} title={INSTRUMENT_ICONS[k].label} onClick={() => onPick({ icon: k })} style={{ height: 30, display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: 5, cursor: 'pointer', color: cur === k ? `color-mix(in srgb, ${color} 80%, #fff)` : 'var(--tx-2)', background: cur === k ? `color-mix(in srgb, ${color} 24%, transparent)` : 'var(--bg-2)', border: cur === k ? `1px solid ${color}` : '1px solid transparent' }}>
                <InstrumentIcon icon={k} size={16} />
              </button>
            ))}
          </div>
        </div>, document.body)}
    </>
  );
}
