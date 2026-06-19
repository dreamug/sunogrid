'use client';
// 通用确认 dialog —— 跟随 design system(暗暖主题 / .btn / CSS 变量),portal 挂 body 绕开 overflow 裁剪。
// 用法见 studio page 的 askConfirm():const ok = await askConfirm({...}); if (ok) ...。Enter=确定 / Esc=取消 / 点遮罩=取消。
import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';

export interface ConfirmOpts {
  title: string;
  message?: string;
  confirmLabel?: string; // 默认「确定」
  cancelLabel?: string;  // 默认「取消」
  danger?: boolean;      // 破坏性操作 → 红色确定键
}

export function ConfirmDialog({ title, message, confirmLabel = 'Confirm', cancelLabel = 'Cancel', danger, onConfirm, onCancel }: ConfirmOpts & { onConfirm: () => void; onCancel: () => void }) {
  const confirmRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    confirmRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onCancel(); }
      else if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); onConfirm(); }
    };
    window.addEventListener('keydown', onKey, true); // 捕获阶段,先于页面快捷键
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onConfirm, onCancel]);

  return createPortal(
    <div onMouseDown={(e) => { if (e.target === e.currentTarget) onCancel(); }}
      style={{ position: 'fixed', inset: 0, zIndex: 500, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
      <div role="dialog" aria-modal="true" onMouseDown={(e) => e.stopPropagation()}
        style={{ width: 'min(360px, 100%)', background: 'var(--bg-1)', border: '1px solid var(--line-2)', borderRadius: 8, boxShadow: '0 16px 48px rgba(0,0,0,0.55)', overflow: 'hidden' }}>
        <div style={{ padding: '16px 18px 0' }}>
          <div style={{ fontSize: 14, fontWeight: 500, color: 'var(--tx)' }}>{title}</div>
          {message && <div style={{ marginTop: 8, fontSize: 12.5, lineHeight: 1.55, color: 'var(--tx-2)' }}>{message}</div>}
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, padding: '16px 18px' }}>
          <button className="btn" onClick={onCancel} style={{ padding: '7px 16px', fontSize: 12.5 }}>{cancelLabel}</button>
          <button ref={confirmRef} className={'btn ' + (danger ? 'danger' : 'primary')} onClick={onConfirm} style={{ padding: '7px 16px', fontSize: 12.5 }}>{confirmLabel}</button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
