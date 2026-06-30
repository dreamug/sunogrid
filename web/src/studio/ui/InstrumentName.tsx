'use client';
/** 乐器名:单击就地编辑;Enter/失焦提交,Esc 取消。 */
import { useState, useEffect } from 'react';
import type { CSSProperties } from 'react';

export function InstrumentName({ label, onCommit, style }: { label: string; onCommit: (v: string) => void; style?: CSSProperties }) {
  const [editing, setEditing] = useState(false);
  const [val, setVal] = useState(label);
  useEffect(() => { if (!editing) setVal(label); }, [label, editing]);
  if (editing) {
    return (
      <input autoFocus value={val} onChange={(e) => setVal(e.target.value)}
        onBlur={() => { setEditing(false); const v = val.trim(); if (v && v !== label) onCommit(v); else setVal(label); }}
        onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); else if (e.key === 'Escape') { setVal(label); setEditing(false); } }}
        style={{ font: 'inherit', fontSize: 13, color: 'var(--tx)', background: 'var(--bg-0)', border: '1px solid var(--line-2)', borderRadius: 4, padding: '1px 6px', minWidth: 0, width: Math.max(80, Math.min(220, val.length * 9 + 22)), ...style }} />
    );
  }
  return <span onClick={() => setEditing(true)} title="Click to rename" style={{ cursor: 'text', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', ...style }}>{label}</span>;
}
