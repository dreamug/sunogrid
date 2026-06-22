'use client';
// §33.6 切块总览:整曲波形 + 块段(可点选/丢弃)+「每块」大小重切。渲在底部编辑坞(daw-editor)。
//  · 点一段 = 选中该块 → 进 ClipEditor 精修(onSelectBlock = focusSound)。
//  · ✕ = 丢弃该块(软删,可撤销)。
//  · 改「每块 8/16/32」= 重跑 chopSong 替换块(非破坏:块 = 歌 asset 内开窗 + 元数据,重切零字节)。
import { useMemo } from 'react';
import type { ApiSound } from '@/studio/api';

const BLOCK_SIZES = [8, 16, 32];

/** 歌的总样本数(块的 startSample/endSample 都在这套坐标里;块共享歌 asset)。 */
function songEndSample(song: ApiSound): number {
  const a = (song.analysis || {}) as Record<string, number>;
  return a.endSample && a.endSample > 0 ? a.endSample : Math.max(1, Math.round(song.durationSec * song.sampleRate));
}
/** 块在歌 asset 里的开窗(startSample/endSample/bars):优先 warp 种子,兜底 analysis。 */
function win(b: ApiSound): { s: number; e: number; bars: number } {
  const a = (b.analysis || {}) as Record<string, number>;
  const w = (b.warp || {}) as Record<string, number>;
  return { s: w.startSample ?? a.startSample ?? 0, e: w.endSample ?? a.endSample ?? 0, bars: w.bars ?? a.bars ?? 1 };
}
const fmtTime = (sec: number) => `${Math.floor(sec / 60)}:${String(Math.round(sec % 60)).padStart(2, '0')}`;

interface Props {
  song: ApiSound;
  blocks: ApiSound[];               // 按 sliceIndex 排好、未软删的块
  peaks?: number[];                 // 歌的波形峰值(整曲)
  busy?: boolean;                   // 重切进行中 → 禁「每块」+ 转圈
  selectedId?: string | null;       // 高亮哪一段(= libSel)
  onSelectBlock: (id: string) => void;  // 点段 → focusSound(进 ClipEditor)
  onDiscardBlock: (id: string) => void; // ✕ → 软删
  onRechop: (opts: { blockBars: number }) => void;
}

export function ChopView({ song, blocks, peaks, busy, selectedId, onSelectBlock, onDiscardBlock, onRechop }: Props) {
  const total = songEndSample(song);

  // 当前每块大小 = 块小节数的众数(中间块都一样;兜底 16)。
  const curSize = useMemo(() => {
    const counts = new Map<number, number>();
    for (const b of blocks) { const { bars } = win(b); counts.set(bars, (counts.get(bars) ?? 0) + 1); }
    let best = 16, bestN = -1;
    for (const [bars, n] of counts) if (n > bestN) { best = bars; bestN = n; }
    return BLOCK_SIZES.includes(best) ? best : 16;
  }, [blocks]);

  // 整曲波形(镜像填充路径,同库卡 MiniWave)。
  const wavePath = useMemo(() => {
    const pk = peaks && peaks.length >= 2 ? peaks : null;
    if (!pk) return null;
    const n = pk.length, sx = 100 / (n - 1);
    const yT = (p: number) => (50 - Math.max(p, 0.03) * 46).toFixed(1);
    const yB = (p: number) => (50 + Math.max(p, 0.03) * 46).toFixed(1);
    let d = `M0 ${yT(pk[0])}`;
    for (let i = 1; i < n; i++) d += `L${(i * sx).toFixed(1)} ${yT(pk[i])}`;
    for (let i = n - 1; i >= 0; i--) d += `L${(i * sx).toFixed(1)} ${yB(pk[i])}`;
    return d + 'Z';
  }, [peaks]);

  const origin = blocks.length ? win(blocks[0]).s : 0;

  return (
    <div className="cv-wrap">
      <div className="cv-bar">
        <span className="cv-ic" aria-hidden="true">✂</span>
        <span className="cv-title" title={song.name}>{song.name}</span>
        <span className="cv-meta">{Math.round(song.sourceBpm)} BPM · {fmtTime(song.durationSec)}</span>
        <span className="cv-spacer" />
        <span className="cv-lab">每块</span>
        <span className="cv-seg">
          {BLOCK_SIZES.map((sz) => (
            <button key={sz} className={sz === curSize ? 'on' : ''} disabled={busy} title={`每块 ${sz} 小节 → 重切整首`} onClick={() => { if (sz !== curSize) onRechop({ blockBars: sz }); }}>{sz}</button>
          ))}
        </span>
        <span className="cv-keep">{blocks.length} blocks</span>
        {busy && <span className="sg-spin sm" aria-hidden="true" />}
      </div>

      <div className="cv-stage">
        <svg className="cv-wave" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
          {wavePath ? <path d={wavePath} /> : <path className="cv-base" d="M0 50 L100 50" />}
        </svg>
        {blocks.map((b) => {
          const { s, e, bars } = win(b);
          const left = (s / total) * 100;
          const width = ((e - s) / total) * 100;
          const label = b.sectionLabel || `Block ${(b.sliceIndex ?? 0) + 1}`;
          const sel = selectedId === b.id;
          return (
            <div key={b.id} className={'cv-seg-ov' + (sel ? ' sel' : '')} style={{ left: `${left}%`, width: `${width}%` }}
              onClick={() => onSelectBlock(b.id)} title={`${label} · ${bars} bar — 点开进 ClipEditor`}>
              <span className="cv-seg-lab">{label}<i>{bars}b</i></span>
              <button className="cv-x" title="丢弃此块(软删,可撤销)" aria-label="Discard block" onClick={(ev) => { ev.stopPropagation(); onDiscardBlock(b.id); }}>✕</button>
            </div>
          );
        })}
        <div className="cv-origin" style={{ left: `${(origin / total) * 100}%` }} title="下拍 origin" />
      </div>

      <div className="cv-hint">点一段 = 进 ClipEditor 精修 · ✕ = 丢弃 · 改「每块」= 重切整首(非破坏)</div>
    </div>
  );
}
