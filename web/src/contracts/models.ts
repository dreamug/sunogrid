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

/** 编辑器网格偏好(per-project,持久化 → Project.gridPrefs JSON,见 §15.A)。记住不重置:
 *  arrange = chop 拼贴轨吸附格(bars/格),warp = clip warp 编辑器的网格,snap = warp 编辑器吸附开关,
 *  §37 songZoom = Song 比例时间轴缩放(px/bar),songGrid = Song track 网格密度(每几 bar 一竖线)。 */
export interface GridPrefs {
  arrange: number;
  warp: number;
  snap: boolean;
  songZoom?: number; // §37 Song 时间轴缩放;缺省回退 SONG_ZOOM_DEFAULT
  songGrid?: number; // §37 Song 网格密度;缺省回退 1
}

/** 主总线效果器配置(per-project,持久化 → Project.fx JSON,见 §15.A/§17)。
 *  三个 insert 效果器串在所有乐器与主输出之间:失真 → 延迟 → 混响。`on=false` 或 `mix=0` = 直通。 */
export interface FxDistortion {
  on: boolean;
  drive: number;                       // 0..1 失真量(前级增益喂入波形整形器)
  tone: number;                        // 0..1 后置低通(0=暗 1=亮)
  character: 'soft' | 'hard' | 'fuzz'; // soft=tanh 管味 / hard=hard-clip / fuzz=非对称重谐波
  mix: number;                         // 0..1 直/湿
}
export interface FxDelay {
  on: boolean;
  sync: '1/4' | '1/8' | '1/8.' | '1/16' | 'ms'; // 同步分割跟工程 BPM;'ms'=自由毫秒
  timeMs: number;                      // sync='ms' 时用(20..1000)
  feedback: number;                    // 0..0.95 反馈量(回声次数)
  tone: number;                        // 0..1 反馈环阻尼低通(越小回声越暗=模拟味)
  pingpong: boolean;                   // 左右弹跳
  mix: number;                         // 0..1 直/湿
}
export interface FxReverb {
  on: boolean;
  decay: number;                       // 秒 0.3..12(卷积 IR 长度=房间大小)
  preDelay: number;                    // 秒 0..0.15(混响前的间隙)
  damp: number;                        // 0..1 高频阻尼(越大越暗)
  mix: number;                         // 0..1 直/湿
}
/** XY 表演板(§21):Kaoss Pad 式主总线 insert。配置(program/wet/mode/on)折进 Project.fx 持久化 + 进 undo;
 *  实时手指位置 X/Y/engage 是瞬态演奏态(直连引擎,不落库/不进 undo,对标 §18 Solo)。 */
export type XYProgram = 'filter' | 'slicer' | 'delay' | 'brake';
export interface XYConfig {
  on: boolean;                          // 总开关(armed);off=insert 恒旁路
  program: XYProgram;                   // 当前激活的效果(单板单 program)
  wet: number;                          // 0..1 engaged 时的湿量(WET 旋钮;1=纯效果)
  mode: 'spring' | 'latch';            // 松手回中(spring,效果归零)/ 不回中(latch,保持锁定)
  springMs: number;                     // spring 模式:松手后 X/Y 滑回中点的时长(ms;效果随之扫回中性,UI 驱动)
}
export const DEFAULT_XY: XYConfig = { on: true, program: 'filter', wet: 1, mode: 'spring', springMs: 300 };

/** §26 Song XY 自动化:断点(直线插值,端点 hold)。bar=session 内 bar 偏移(0..bars×reps,跨全部 reps),v=参数值 0..1。
 *  统一 bar 度量(全曲 1 bar 等宽);改 repeat 次数=按比例缩放点重分布(rescaleAuto)。 */
export interface AutoPoint { bar: number; v: number; }
/** §26.v3 一条效果的自动化:X/Y 两条断点序列。无 `on`——激活=线非平(isActiveAuto);program 由 XYAutoSet 的键给(不存值里)。 */
export interface XYAutomation { x: AutoPoint[]; y: AutoPoint[]; }
/** §26.v3 一个 session 的 XY 自动化:每效果一条,最多 4(filter/slicer/delay/brake),互相独立、可同时发声。**只存非平(激活)的效果**——`program in xyAuto` ⟺ 激活。挂 Session.xyAuto(JSON,§15)。 */
export type XYAutoSet = Partial<Record<XYProgram, XYAutomation>>;

export interface FxConfig {
  distortion: FxDistortion;
  delay: FxDelay;
  reverb: FxReverb;
  xy: XYConfig;                         // §21 XY 表演板(主总线 insert)
}
/** 默认全部 bypass —— 不改默认音色,加进信号链零副作用。 */
export const DEFAULT_FX: FxConfig = {
  distortion: { on: false, drive: 0.3, tone: 0.5, character: 'soft', mix: 1 },
  delay: { on: false, sync: '1/8', timeMs: 250, feedback: 0.35, tone: 0.5, pingpong: false, mix: 0.3 },
  reverb: { on: false, decay: 2.5, preDelay: 0.02, damp: 0.5, mix: 0.3 },
  xy: DEFAULT_XY,
};

/** §37 Song 多轨的一条命名 arrangement track。有序数组,下标 0 = 主轨(吸附,始终存在)。 */
export interface SongLane {
  id: string;
  name: string;
  color: string | null;
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
  /** 编辑器网格偏好;null=用默认。 */
  gridPrefs: GridPrefs | null;
  /** 主总线效果器配置(§17);null=用 DEFAULT_FX。 */
  fx: FxConfig | null;
  beatsPerBar: number;   // 目前固定 4
  quantize: Quantize;    // 默认 '1bar'
  songLayoutVersion?: number; // Studio Song 多轨布局迁移标记;业务 UI 不直接使用
  /** §37 Song 多轨命名 track 列表(下标 0=主轨);null/空 = 仅默认主轨。 */
  songLanes?: SongLane[] | null;
  banks: Bank[];
  createdAt: string;
  updatedAt: string;
}

export const PADS_PER_BANK = 16;
export const DEFAULT_QUANTIZE: Quantize = '1bar';
export const DEFAULT_BEATS_PER_BAR = 4;
