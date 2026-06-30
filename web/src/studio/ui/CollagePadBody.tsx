'use client';

/** collage 乐器 pad 的**静态**底:每片一个彩色底块 + 片色波形 + 小节/拍网格线。memo:payload 不变就不重渲
 *  (播放头是独立的 <CollageHead> 自驱动叶子,不在这里;故播放时本体一帧都不用重算)。
 *  peaksSig:各片峰值是否已进 lanePeaksCache 的签名('0'/'1' 串)。reload 后缓存是异步填的、payload 不变,
 *  纯 memo(payload) 会跳过重渲 → pad 只剩色块不显波形;靠此 prop 从 '0…' 变 '1…' 打破 memo,峰值到位即重画。 */
import { memo } from 'react';
import type { InstrumentPayload } from '@/contracts';
import { lanePeaksCache, pieceKey } from '@/studio/peaks';
import { sliceColorFor } from '@/studio/shared';
import { Wave } from './live';

export const CollagePadBody = memo(function CollagePadBody({ payload }: { payload: Extract<InstrumentPayload, { kind: 'collage' }>; peaksSig: string }) {
  const spb = payload.stepsPerBar;
  const loopLen = Math.max(1, Math.round(payload.bars * spb));
  const barPct = (spb / loopLen) * 100, beatPct = barPct / 4; // 每小节/每拍一条线
  return (
    <div className="cwave" aria-hidden="true">
      {payload.clips.map((c) => {
        const x = ((c.startStep - payload.loopStartStep) / loopLen) * 100;
        const w = (Math.max(1, Math.round(c.bars * spb)) / loopLen) * 100;
        const vx = Math.max(0, x), vw = Math.min(100, x + w) - vx;
        if (vw <= 0) return null;
        const col = sliceColorFor(c.id), pk = lanePeaksCache.get(pieceKey(c));
        return (
          <div key={c.id} style={{ position: 'absolute', top: 0, bottom: 0, left: `${vx}%`, width: `${vw}%`, overflow: 'hidden', background: `color-mix(in srgb, ${col} 26%, transparent)`, borderRight: `1px solid color-mix(in srgb, ${col} 50%, transparent)` }}>
            {pk && pk.length > 1 && <div style={{ position: 'absolute', inset: 0, color: `color-mix(in srgb, ${col} 88%, #fff)`, opacity: 0.92 }}><Wave className="" peaks={pk} /></div>}
          </div>
        );
      })}
      {/* 网格线叠在彩色块之上 */}
      <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none', backgroundImage: `repeating-linear-gradient(90deg, rgba(255,255,255,0.14) 0 1px, transparent 1px ${barPct}%), repeating-linear-gradient(90deg, rgba(255,255,255,0.06) 0 1px, transparent 1px ${beatPct}%)` }} />
    </div>
  );
});
