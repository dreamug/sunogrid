// M1 音频引擎契约 —— 纯 TS,框架无关。
// 引擎不做 warp(那是 M2/worker 的事);只接收"已就绪 buffer"并量化调度循环播放。
import type { PadState, Quantize } from './models';

/** 喂给引擎的、已 conditioning + warp 完成的可播放 clip。 */
export interface EngineClip {
  padIndex: number;
  /** 已是主 BPM、整小节的音频。 */
  buffer: AudioBuffer;
  bars: number;
  /** 无缝循环的采样级 loop 点。 */
  loopStartSample: number;
  loopEndSample: number;
  gainDb: number;
}

export interface TransportPosition {
  bar: number;       // 从 1 开始
  beat: number;      // 1–beatsPerBar
  sixteenth: number; // 1–4
}

/** 引擎对外事件。 */
export type EngineEvent =
  | { type: 'transport'; position: TransportPosition; isPlaying: boolean }
  | { type: 'padState'; padIndex: number; state: PadState }
  | { type: 'bpm'; bpm: number };

export type EngineListener = (e: EngineEvent) => void;

/** 音频引擎接口。M1 实现(基于 Tone.Transport)。 */
export interface AudioEngine {
  init(): Promise<void>;
  /** 首次用户手势里调用,解锁浏览器音频输出(幂等)。 */
  resume(): Promise<void>;
  dispose(): void;

  setBpm(bpm: number): void;
  getBpm(): number;
  setQuantize(q: Quantize): void;

  /** 走带连续位置(拍/四分音符,小数),用于 pad 波形播放进度。 */
  transportBeats(): number;

  startTransport(): void;
  stopTransport(): void;
  isPlaying(): boolean;

  /** 装载/替换某 pad 的可播放 clip。 */
  loadClip(clip: EngineClip): void;
  clearPad(padIndex: number): void;

  /** 量化启动/停止 —— 对齐到下一个量化边界,不立即生效。startTransport=false 时不启动主走带(warp 试听用)。 */
  launchPad(padIndex: number, startTransport?: boolean): void;
  stopPad(padIndex: number): void;
  stopAll(): void;

  setPadGain(padIndex: number, gainDb: number): void;

  /** 试听/预览:独立通道循环播放一个 buffer。quantize=true 且走带在跑则按整小节进入。 */
  audition(buffer: AudioBuffer, loopStartSample?: number, loopEndSample?: number, quantize?: boolean): void;
  stopAudition(): void;
  /** 预览播放线相位 0..1(按真实起播时刻算,重播即归零);没在预览返回 null。 */
  auditionPhase(): number | null;
  /** pad 进度相位 0..1(按该 pad 真实起播算,重启即归零);没在播返回 null。 */
  padPhase(padIndex: number): number | null;

  /** 订阅事件,返回取消订阅函数。 */
  on(listener: EngineListener): () => void;
}
