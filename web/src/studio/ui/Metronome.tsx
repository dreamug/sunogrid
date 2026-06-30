'use client';
/** 顶栏节拍器:按钮 toggle 开关(开=橙),▾ 弹设置面板(音量 + 几小节响一次)。点外面关。 */
import { useState, useRef, useEffect } from 'react';

export type MetroIv = 'beat' | 'bar' | '2bar' | '4bar';
export function Metronome({ on, vol, iv, onToggle, onVol, onIv }: { on: boolean; vol: number; iv: MetroIv; onToggle: () => void; onVol: (db: number) => void; onIv: (iv: MetroIv) => void }) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (ev: MouseEvent) => { if (!wrapRef.current?.contains(ev.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);
  const IVS: [string, MetroIv][] = [['Beat', 'beat'], ['Bar', 'bar'], ['2 bars', '2bar'], ['4 bars', '4bar']];
  return (
    <div className="tb-metro" ref={wrapRef}>
      <button className={'metro-btn' + (on ? ' on' : '')} title={on ? 'Metronome: on (click to stop)' : 'Metronome: off (click to start)'} aria-pressed={on} onClick={onToggle}>♩</button>
      <button className="metro-caret" title="Metronome settings" aria-label="Metronome settings" onClick={() => setOpen((o) => !o)}>▾</button>
      {open && (
        <div className="metro-pop" role="dialog">
          <div className="mp-h">Metronome</div>
          <div className="mp-row"><span className="mp-l">Volume</span><input type="range" min={-30} max={0} step={1} value={vol} onChange={(ev) => onVol(Number(ev.target.value))} /></div>
          <div className="mp-row"><span className="mp-l">Interval</span><div className="seg sm mp-iv">{IVS.map(([lab, v]) => <button type="button" key={v} className={iv === v ? 'on' : ''} onClick={() => onIv(v)}>{lab}</button>)}</div></div>
        </div>
      )}
    </div>
  );
}
