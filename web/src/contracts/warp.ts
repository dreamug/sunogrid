// M2 warp 协议 —— 数据形状(WarpRequest 进 / WarpDone 出)。
// 当前实现:`@/audio/signalsmithWarp` 的 warpClip(req) Promise,内部用 OfflineAudioContext + signalsmith(WASM)离线渲染。
// (Progress / Response 这套消息类型留给"以后挪进 Web Worker"时用。)

/** conditioning(整小节对齐)策略。 */
export type ConditioningMode =
  | 'trust-tempo'  // 信 nativeBpm,从 t=0 取整数小节(v1 默认)
  | 'autocorr';    // 自相关找真实循环周期(后期升级)

/** 主线程 → worker:处理一条素材。channels 用 transferable 传以免拷贝。 */
export interface WarpRequest {
  id: string;
  channels: Float32Array[]; // 每声道一个
  sampleRate: number;
  nativeBpm: number;        // 原始拍速(已知)
  targetBpm: number;        // 目标 = 工程 BPM
  semitones: number;        // 变调,0=不变
  beatsPerBar: number;      // 4
  conditioning: ConditioningMode;
  /** 指定目标小节数;不给则自动取能放下的最大整数小节。 */
  targetBars?: number;
}

export interface WarpProgress {
  id: string;
  type: 'progress';
  pct: number; // 0–100
}

/** 完成:已是主 BPM、整小节,附采样级 loop 点。 */
export interface WarpDone {
  id: string;
  type: 'done';
  channels: Float32Array[];
  sampleRate: number;
  bars: number;
  loopStartSample: number;
  loopEndSample: number;
}

export interface WarpError {
  id: string;
  type: 'error';
  message: string;
}

export type WarpResponse = WarpProgress | WarpDone | WarpError;
