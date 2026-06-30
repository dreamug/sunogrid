'use client';
/** 顶栏工程名:点击改名;Enter/失焦提交,Esc 取消,空名回弹。提交走 commitProjName(乐观写 Project.name)。 */
import { useState, useRef, useEffect } from 'react';

export function ProjectNameInput({ name, onCommit }: { name: string; onCommit: (v: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [val, setVal] = useState(name);
  const ref = useRef<HTMLInputElement | null>(null);
  const escRef = useRef(false); // Esc 退出时跳过 blur 的提交
  useEffect(() => { if (!editing) setVal(name); }, [name, editing]); // 非编辑态跟随真值
  useEffect(() => { if (editing) { ref.current?.focus(); ref.current?.select(); } }, [editing]);
  const commit = () => {
    setEditing(false);
    if (escRef.current) { escRef.current = false; setVal(name); return; }
    const t = val.trim();
    if (t && t !== name) onCommit(t); else setVal(name);
  };
  if (!editing) return (
    <span className="tb-proj" title={`${name} — click to rename`} role="button" tabIndex={0}
      onClick={() => setEditing(true)}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setEditing(true); } }}>{name}</span>
  );
  return (
    <input ref={ref} className="tb-proj-in" value={val} maxLength={80} aria-label="Project name"
      onChange={(e) => setVal(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); else if (e.key === 'Escape') { escRef.current = true; e.currentTarget.blur(); } }} />
  );
}
