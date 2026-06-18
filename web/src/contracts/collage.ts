// M7 拼贴器(单轨)契约 —— 编辑器工作文档 + bake。
// 原子统一用 ./instrument 的 Clip;轨上一片 = CollageClip(Clip + startStep)。
// CollageDoc 是编辑器的工作态(带 masterBpm/beatsPerBar 便于独立预览/烘焙);
// 持久化时它对应 Instrument.payload(kind:'collage')的 { bars, stepsPerBar, clips }。
import type { CollageClip } from './instrument';

export interface CollageDoc {
  bars: number;          // 总长(整小节)
  stepsPerBar: number;   // 网格分辨率(snap),如 16(=1/16)
  beatsPerBar: number;   // 4
  masterBpm: number;     // bake 目标 BPM(= 工程/Session BPM)
  items: CollageClip[];  // 轨上摆放(按 startStep 有序、不重叠)
}

/** bake 产物:已是 masterBpm、整小节,附采样级 loop 点 —— 与 WarpDone 同口径,直接进 EngineClip。 */
export interface BakeResult {
  buffer: AudioBuffer;
  bars: number;
  loopStartSample: number;
  loopEndSample: number;
}

/** 把一条拼贴离线烘成一条 loop buffer。sources:soundId → 已解码到工程 SR 的源 AudioBuffer。 */
export type BakeCollage = (doc: CollageDoc, sources: Map<string, AudioBuffer>) => Promise<BakeResult>;
