// 核心数据模型 —— 所有模块共享的事实定义。改这里要全局对齐。

/** 12 个音名。 */
export type KeyRoot =
  | 'C' | 'C#' | 'D' | 'D#' | 'E' | 'F'
  | 'F#' | 'G' | 'G#' | 'A' | 'A#' | 'B';

/** 大调=空,小调=后缀 m。如 'C' / 'Am' / 'F#m'。与 Suno `user_key` 编码一致。 */
export type MusicalKey = `${KeyRoot}` | `${KeyRoot}m`;

/** loop 还是 one-shot(对应 Suno sound_configs.user_loop)。 */
export type SampleType = 'loop' | 'oneshot';

/** 素材来源。 */
export type LoopSource = 'suno' | 'import';

/**
 * 库里的一条素材。音频文件存后端磁盘,这里只是元数据。
 * nativeBpm/nativeKey:Suno 生成的已知(我们设了 user_tempo/user_key);导入的需检测,未知为 null。
 */
export interface LibraryLoop {
  id: string;
  name: string;
  source: LoopSource;
  type: SampleType;
  /** 后端可取的音频地址(本地服务路径)。 */
  audioUrl: string;
  nativeBpm: number | null;
  nativeKey: MusicalKey | null;
  durationSec: number;
  sampleRate: number;
  /** 音乐长度(整小节);conditioning 之后确定,未知为 null。 */
  bars: number | null;
  tags: string[];
  favorite: boolean;
  /** 来源细节。 */
  sourceMeta?: { sunoClipId?: string; prompt?: string };
  createdAt: string; // ISO
}

/** pad 运行态(对应生命周期状态机,见 PRODUCT.md §5)。运行时由引擎维护,不持久化。 */
export type PadState =
  | 'empty'
  | 'loading'   // 解码 + 测 BPM
  | 'warping'   // 离线对齐整小节 + 变速 + 变调
  | 'ready'     // 已就绪,可被启动
  | 'queued'    // 已按下,等下一个量化边界
  | 'playing'
  | 'stopping'  // 已按停,等量化边界
  | 'error';

/** 一个 pad(格子)。每个 bank 16 个。 */
export interface Pad {
  /** 0–15,bank 内位置。 */
  index: number;
  loopId: string | null;
  label: string;
  tags: string[];
  /** 用户给 pad 选的标签色;null=默认。 */
  color: string | null;
  /** 变调半音(变速比例由工程 BPM 推出,不在此存)。 */
  transposeSemitones: number;
  gainDb: number;
  /** 运行态(非持久化)。 */
  state: PadState;
}

/** pad bank = MPC 的一页。 */
export interface Bank {
  id: string;   // 'A' | 'B' | 'C' | 'D' | ...
  pads: Pad[];  // 长度 = PADS_PER_BANK
}

export type Quantize = 'off' | '1bar' | '1/2' | '1/4';

/** 生成窗口偏好(整体读写、形状演进中 → Project.genPrefs JSON,见 PRODUCT §4.1/§15.A)。 */
export interface GenPrefs {
  mode: 'sound' | 'advanced';
  loop: boolean;
  /** 持久化的生成 BPM;主 BPM 变化时单向覆盖一次(见 §4.1)。 */
  bpm: number;
}

/** 一个工程(整套设置)。 */
export interface Project {
  id: string;
  name: string;
  masterBpm: number;
  /** 工程调;生成时默认跟它。null=不限。 */
  masterKey: MusicalKey | null;
  /** 生成窗口偏好;null=用默认。 */
  genPrefs: GenPrefs | null;
  beatsPerBar: number;   // 目前固定 4
  quantize: Quantize;    // 默认 '1bar'
  banks: Bank[];
  createdAt: string;
  updatedAt: string;
}

export const PADS_PER_BANK = 16;
export const DEFAULT_QUANTIZE: Quantize = '1bar';
export const DEFAULT_BEATS_PER_BAR = 4;
