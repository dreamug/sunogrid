'use client';
// §35 AI 提示词助手浮层:gen-ta 角落 ✨ 唤起。写自然语言 → qwen 生成一行 Suno 提示词 → "Use this" 写回 gen-ta。
// 纯 UI 全英文。瞬态:idea/结果都不落库、不进 undo(只在用户点 Use this 时调上层 onGenPrompt)。
import { useEffect, useRef, useState } from 'react';
import { api } from '@/studio/api';

interface Props {
  mode: 'sound' | 'advanced';
  bpm: number;
  musicalKey: string;
  onApply: (prompt: string) => void; // 写回 gen-ta(复用 onGenPrompt)
  onClose: () => void;
}

export function PromptAssist({ mode, bpm, musicalKey, onApply, onClose }: Props) {
  const [idea, setIdea] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => { taRef.current?.focus(); }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  async function generate() {
    const trimmed = idea.trim();
    if (!trimmed || busy) return;
    setBusy(true); setError(null);
    try {
      const { prompt } = await api.ai.prompt({ idea: trimmed, mode, bpm, key: musicalKey || undefined });
      setResult(prompt);
    } catch (e) {
      setError(String((e as Error).message || e));
      setResult(null);
    } finally {
      setBusy(false);
    }
  }

  function use() {
    if (result) { onApply(result); onClose(); }
  }

  return (
    <>
      <div className="pa-backdrop" onClick={onClose} />
      <div className="pa-pop" onClick={(e) => e.stopPropagation()}>
        <div className="pa-head">
          <span className="pa-tt">✨ Prompt assist</span>
        </div>
        <div className="pa-body">
          <div>
            <div className="pa-lab">Describe your idea</div>
            <textarea
              ref={taRef}
              className="pa-in"
              rows={2}
              value={idea}
              onChange={(e) => setIdea(e.target.value)}
              onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); generate(); } }}
              placeholder="e.g. a dark trap beat with heavy 808s and a melancholic piano"
            />
          </div>

          <button className="pa-gen" onClick={generate} disabled={busy || !idea.trim()}>
            {busy ? <><span className="sg-spin sm" /> Generating…</> : 'Generate prompt →'}
          </button>

          {error && <div className="pa-err">{error}</div>}

          {result && (
            <div className="pa-res">
              <div className="pa-res-l">SUNO PROMPT</div>
              <div className="pa-res-t">{result}</div>
              <div className="pa-acts">
                <button className="pa-use" onClick={use}>Use this ✓</button>
                <button className="pa-redo" onClick={generate} disabled={busy}>Redo ↻</button>
              </div>
            </div>
          )}
        </div>
      </div>
    </>
  );
}
