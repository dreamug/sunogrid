'use client';
// §32 总混音导出:顶栏 Export 按钮 → 居中模态(createPortal,绕 overflow)。两态:
//  idle —— 选格式(WAV/MP3)+ 时长预览,可 Esc/遮罩/取消关;
//  busy —— 点导出先 onStopAll() 停掉一切音频,再切阻塞进度态(spinner + 进度条,不可关),导出完成才退出。
// 渲染走 exportSong.renderSong(Tone.Offline),编码走 wav.ts/mp3.ts,Blob 下载。不落库、不进 undo(§32.6)。
import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { planSong, renderSong, bufferChannels, type ExportInput, type RenderProgress } from '@/studio/exportSong';
import { encodeWav } from '@/audio/wav';
import { encodeMp3 } from '@/audio/mp3';

type Fmt = 'wav' | 'mp3';
type Phase = 'idle' | 'busy' | 'done' | 'error';

const fmtDur = (sec: number): string => {
  const s = Math.max(0, Math.round(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};
const safeName = (s: string): string => (s || 'song').replace(/[\\/:*?"<>|]+/g, '_').trim() || 'song';

function download(bytes: Uint8Array, name: string, mime: string): void {
  const blob = new Blob([bytes], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// 进度 → 百分比(预渲占 0..70%,渲染 88%,编码 96%,完成 100%)。
const pctFor = (p: RenderProgress): number =>
  p.phase === 'prepare' ? Math.round((p.done / Math.max(1, p.total)) * 70) : p.phase === 'render' ? 88 : 100;

export function ExportDialog({ getInput, fileName, onStopAll }: { getInput: () => ExportInput; fileName: string; onStopAll: () => void }) {
  const [open, setOpen] = useState(false);
  const [fmt, setFmt] = useState<Fmt>('wav');
  const [phase, setPhase] = useState<Phase>('idle');
  const [msg, setMsg] = useState('');
  const [pct, setPct] = useState(0);
  const [indet, setIndet] = useState(false); // 渲染/编码阶段无子进度 → 不确定流动条(预渲阶段才是确定百分比)
  const [err, setErr] = useState('');

  const busy = phase === 'busy';
  const close = () => { if (!busy) { setOpen(false); setPhase('idle'); setMsg(''); setErr(''); setPct(0); setIndet(false); } };

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !busy) { e.preventDefault(); e.stopPropagation(); close(); } };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [open, busy]); // eslint-disable-line react-hooks/exhaustive-deps

  // 打开时算编排预览(总小节 / 时长 / 可导出乐器数)。
  const plan = useMemo(() => { if (!open) return null; try { return planSong(getInput()); } catch { return null; } }, [open, getInput]);
  const empty = !plan || plan.enabledCount === 0 || plan.totalSec <= 0;

  const doExport = async () => {
    onStopAll();                       // ① 停止一切音频
    setPhase('busy'); setErr(''); setMsg('Preparing…'); setPct(2); setIndet(false);
    try {
      const input = getInput();
      const buf = await renderSong(input, (p) => {
        if (p.phase === 'prepare') { setIndet(false); setPct(pctFor(p)); setMsg(`Preparing instruments… ${p.done}/${p.total}`); }
        else if (p.phase === 'render') { setIndet(true); setMsg('Rendering mix…'); } // 离线渲染是单个 await,无子进度 → 流动条
      });
      setIndet(true); setMsg('Encoding…');
      await new Promise((r) => setTimeout(r, 16)); // 先渲一帧再做同步编码,免大文件卡住 UI
      const channels = bufferChannels(buf);
      const name = `${safeName(fileName)}.${fmt}`;
      if (fmt === 'wav') download(new Uint8Array(encodeWav(channels, buf.sampleRate)), name, 'audio/wav');
      else download(encodeMp3(channels, buf.sampleRate), name, 'audio/mpeg');
      setIndet(false); setPct(100); setMsg('Done ✓'); setPhase('done');
      setTimeout(() => { setOpen(false); setPhase('idle'); setMsg(''); setPct(0); }, 900);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e)); setMsg(''); setPhase('error');
    }
  };

  return (
    <div className="tb-xp">
      <button className="fx-btn" aria-haspopup="dialog" aria-expanded={open} title="Export the full song to an audio file" onClick={() => { setErr(''); setMsg(''); setPct(0); setIndet(false); setPhase('idle'); setOpen(true); }}>
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><path d="M7 10l5 5 5-5" /><path d="M12 15V3" />
        </svg>
        Export
      </button>
      {open && createPortal(
        <div className="xp-back" onMouseDown={(e) => { if (e.target === e.currentTarget) close(); }}>
          <div className="xp-modal" role="dialog" aria-modal="true" onMouseDown={(e) => e.stopPropagation()}>
            <div className="xp-h">Export song</div>

            {phase === 'idle' && (empty ? (
              <>
                <div className="xp-note">Add some instruments to a session first, then export.</div>
                <div className="xp-row"><button className="btn" onClick={close}>Close</button></div>
              </>
            ) : (
              <>
                <div className="xp-meta">{plan!.totalBars} bars · {fmtDur(plan!.totalSec)} · {plan!.blocks.length} section{plan!.blocks.length === 1 ? '' : 's'}</div>
                <div className="xp-fmt" role="group" aria-label="Format">
                  <button type="button" className={'xp-seg' + (fmt === 'wav' ? ' xp-on' : '')} onClick={() => setFmt('wav')}>WAV</button>
                  <button type="button" className={'xp-seg' + (fmt === 'mp3' ? ' xp-on' : '')} onClick={() => setFmt('mp3')}>MP3</button>
                </div>
                <div className="xp-sub">{fmt === 'wav' ? '16-bit PCM · lossless · larger file' : '256 kbps · smaller file'}</div>
                <div className="xp-row">
                  <button className="btn" onClick={close}>Cancel</button>
                  <button className="btn primary" onClick={doExport}>Export</button>
                </div>
              </>
            ))}

            {(busy || phase === 'done') && (
              <div className="xp-prog">
                <div className="xp-prog-top"><span className="sg-spin" aria-hidden="true" /><span className="xp-prog-msg">{msg || 'Working…'}</span></div>
                <div className="xp-bar">{indet
                  ? <div className="xp-bar-fill xp-bar-indet" />
                  : <div className="xp-bar-fill" style={{ width: `${pct}%` }} />}</div>
                <div className="xp-prog-note">Keep this tab open — exporting…</div>
              </div>
            )}

            {phase === 'error' && (
              <>
                <div className="xp-err">⚠ {err}</div>
                <div className="xp-row"><button className="btn" onClick={close}>Close</button></div>
              </>
            )}
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}
