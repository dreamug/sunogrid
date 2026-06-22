'use client';
// §32 导出与 live 引擎共用的主总线零件 —— 抽出来防「导出渲染的音色和播放漂移」。
// softClipCurve = 主总线软削波天花板曲线;makeShelfEq = 三段串联 EQ 节点。
// studioEngine(实时)与 exportSong(离线 Tone.Offline)都从这里建,改一处两处一起对。
import * as Tone from 'tone';
import { EQ_BANDS } from '@/contracts';

// 软削波天花板(§17):阈 T=0.72(~-2.9dBFS)起软饱和,x=1 处输出≈0.92(~-0.7dBFS)=真天花板。
export const SOFT_CLIP_THRESH = 0.72;
export const SOFT_CLIP_CEIL = 0.96;

// 软削波曲线:|x|≤T 纯净直通;超 T 用 tanh 平滑趋近 ceil(memoryless,无抽吸)。给主总线 WaveShaper 当安全天花板。
export function softClipCurve(T = SOFT_CLIP_THRESH, ceil = SOFT_CLIP_CEIL, n = 2048): Float32Array {
  const c = new Float32Array(n), span = Math.max(1e-4, ceil - T);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1, ax = Math.abs(x);
    c[i] = ax <= T ? x : Math.sign(x) * (T + span * Math.tanh((ax - T) / span));
  }
  return c;
}

// 三段串联 EQ:lowshelf@200 + peaking@1k(Q0.7) + highshelf@4k(频点见 EQ_BANDS;low 为入口节点,接它即接整段)。
export interface ShelfEq { low: Tone.Filter; mid: Tone.Filter; high: Tone.Filter; }
export function makeShelfEq(): ShelfEq {
  return {
    low: new Tone.Filter({ type: 'lowshelf', frequency: EQ_BANDS.lowFreq, gain: 0 }),
    mid: new Tone.Filter({ type: 'peaking', frequency: EQ_BANDS.midFreq, Q: EQ_BANDS.midQ, gain: 0 }),
    high: new Tone.Filter({ type: 'highshelf', frequency: EQ_BANDS.highFreq, gain: 0 }),
  };
}
