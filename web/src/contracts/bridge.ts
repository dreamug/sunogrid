// M4 Suno 桥接命令协议 —— app <-> Chrome 插件(底层走 chrome.runtime.sendMessage / WS)。
// 插件在 suno.com 活会话里调私有接口(见 suno-bridge/api-map.md),token 不出浏览器。
import type { MusicalKey, SampleType } from './models';

/** app → 插件:发起生成。bpm/key 用 'project' 表示跟随工程当前值。 */
export interface GenerateCommand {
  requestId: string;
  prompt: string;
  type: SampleType;
  bpm: number | 'project';
  key: MusicalKey | 'project';
  count?: number;   // 默认 2(Suno 一次出 2 条变体)
  model?: string;   // 默认 'chirp-fenix'(v5.5)
}

export type GenStatus = 'submitted' | 'streaming' | 'complete' | 'error';

/** 插件 → app:每条 clip 的进度/结果。 */
export interface GenerateProgress {
  requestId: string;
  clipId: string;
  status: GenStatus;
  pct?: number;
  /** complete 时给最终可下载 mp3(cdn1.suno.ai/<id>.mp3)。 */
  audioUrl?: string;
  nativeBpm?: number;
  nativeKey?: MusicalKey | null;
  durationSec?: number;
  message?: string; // error 时
}

/** app 侧对桥接的抽象。 */
export interface SunoBridge {
  isConnected(): boolean;
  generate(cmd: GenerateCommand): Promise<void>;
  /** 订阅进度,返回取消订阅。 */
  onProgress(cb: (p: GenerateProgress) => void): () => void;
}
