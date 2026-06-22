'use client';
// §31 顶栏输出设备选择:喇叭按钮 + 右对齐浮层单选列。点外/Esc 关(同 Metronome/FxRack)。
// 选择写 localStorage(机器本地偏好,不入库、不进 undo §31.5);实际路由由 onSelect → 引擎 setOutputDevice。
import { useEffect, useRef, useState } from 'react';
import { useAudioOutputs, outputSwitchSupported, OUTPUT_KEY } from '@/studio/useAudioOutputs';

export function OutputDevice({ onSelect }: { onSelect: (deviceId: string) => void }) {
  const { devices, hasLabels, requestLabels } = useAudioOutputs();
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState('default');
  const wrapRef = useRef<HTMLDivElement>(null);
  const supported = outputSwitchSupported();

  useEffect(() => { try { setSelected(localStorage.getItem(OUTPUT_KEY) || 'default'); } catch { /* */ } }, []);
  useEffect(() => {
    if (!open) return;
    const onDoc = (ev: MouseEvent) => { if (!wrapRef.current?.contains(ev.target as Node)) setOpen(false); };
    const onEsc = (ev: KeyboardEvent) => { if (ev.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onEsc);
    return () => { document.removeEventListener('mousedown', onDoc); document.removeEventListener('keydown', onEsc); };
  }, [open]);

  // 选中的设备若已不在列表(拔掉/跨机器陈旧)→ 显示回落 System default(§31.1)
  const effective = devices.some((d) => d.deviceId === selected) ? selected : 'default';
  const active = effective !== 'default'; // 改了路由 → 图标染橙提示

  const pick = (deviceId: string) => {
    setSelected(deviceId);
    try {
      if (deviceId === 'default') localStorage.removeItem(OUTPUT_KEY);
      else localStorage.setItem(OUTPUT_KEY, deviceId);
    } catch { /* localStorage 不可用:本次会话仍生效,只是不持久 */ }
    onSelect(deviceId);
  };

  return (
    <div className="tb-out" ref={wrapRef}>
      <button className={'out-btn' + (active ? ' on' : '')} aria-haspopup="dialog" aria-expanded={open}
        title="Audio output device" onClick={() => setOpen((o) => !o)}>
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M11 5 6 9H2v6h4l5 4z" /><path d="M15.5 8.5a5 5 0 0 1 0 7" /><path d="M19 5a9 9 0 0 1 0 14" />
        </svg>
        <span className="out-lbl">Output</span>
      </button>
      {open && (
        <div className="out-pop" role="dialog" aria-label="Audio output device">
          <div className="op-h">Output device</div>
          {!supported ? (
            <div className="op-note">This browser routes audio to the system default. Use Chrome or Edge to pick a device.</div>
          ) : (
            <>
              <div className="op-list">
                {devices.map((d) => (
                  <button key={d.deviceId} type="button" className={'op-row' + (d.deviceId === effective ? ' op-sel' : '')} onClick={() => pick(d.deviceId)}>
                    <span className="op-ck">{d.deviceId === effective ? '✓' : ''}</span>
                    <span className="op-text">
                      <span className="op-name">{d.label}</span>
                      {d.note && <span className="op-sub">→ {d.note}</span>}
                    </span>
                  </button>
                ))}
              </div>
              {!hasLabels && (
                <button type="button" className="op-grant" onClick={requestLabels}>Show device names</button>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
