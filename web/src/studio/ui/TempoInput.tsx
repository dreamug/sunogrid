'use client';

/** 顶栏主 BPM:可编辑;Enter/失焦提交,Esc 取消,↑↓ 微调(±1)。提交后真正的 clamp/re-warp/undo 在 commitBpm 里。 */
import { useState, useEffect } from 'react';

export function TempoInput({ bpm, onCommit }: { bpm: number; onCommit: (v: number) => void }) {
  const [editing, setEditing] = useState(false);
  const [val, setVal] = useState(String(bpm));
  useEffect(() => { if (!editing) setVal(String(bpm)); }, [bpm, editing]); // 非编辑态跟随真值(含 undo/clamp 回弹)
  const commit = () => { setEditing(false); const n = parseInt(val, 10); if (Number.isFinite(n) && n !== bpm) onCommit(n); else setVal(String(bpm)); };
  return (
    <input className="tg-bpm" inputMode="numeric" value={val} title="Project master BPM · instruments re-warp to the new tempo after committing (Enter to commit · ↑↓ to nudge)"
      onFocus={() => setEditing(true)}
      onChange={(e) => setVal(e.target.value.replace(/[^0-9]/g, '').slice(0, 3))}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur();
        else if (e.key === 'Escape') { setVal(String(bpm)); setEditing(false); e.currentTarget.blur(); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); setVal((v) => String((parseInt(v, 10) || bpm) + 1)); }
        else if (e.key === 'ArrowDown') { e.preventDefault(); setVal((v) => String((parseInt(v, 10) || bpm) - 1)); }
      }} />
  );
}
