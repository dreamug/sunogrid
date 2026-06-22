// 乐器 / Session 模型 —— loop 机的核心组织层(契约先行,实现各自填)。
// 层级:Project › Session(操场,4×25=100 slot) › Instrument(通用外壳 + payload) › Clip(叶,warp 副本)。
//
// 一个 **Clip 原子**在哪一层都是同一种东西(库内预处理 / Sample 乐器 / Collage 内一片),都用同一个 warp 编辑器。
// 排列只有两种方向:Session **竖排并行**(每件乐器一个开关、各自 free-loop);Collage **横排串行**(一件乐器内部 bake 成一条)。
// 拷贝独立性贯穿每层:乐器/片都是独立副本,只共享 Asset 字节;改一处不影响库与别处。

/** 叶子原子:一份 warp/trim 的独立拷贝,挂在共享 Asset 上。 */
export interface Clip {
  /** 稳定 id(§15 细粒度持久化:sample/collage clip 都靠它做字段级 diff)。CollageClip 必有;sample clip 创建/加载时也带。 */
  id?: string;
  /** 源 Sound id(= 库素材);删库不影响 —— asset 字节共享、warp 是副本。 */
  soundId: string;
  /** 共享音频字节(源 Asset)的引用;Clip 不复制字节。 */
  assetId: string;
  /** trim 区(源解码音频采样偏移,同 Sound.analysis 口径)。 */
  startSample: number;
  endSample: number;
  /** 对齐到的音乐长度(小节);决定时长(锁死,改要进 warp 编辑器)。 */
  bars: number;
  /** 半/倍速快捷:渲染目标小节数 = bars × timeMul(源区间不动)。2=半速(铺到 2× 小节)、0.5=倍速、空/1=原速。 */
  timeMul?: number;
  /** 变调半音(0=不变)。 */
  semitones: number;
  /** —— clip 尾淡出(sample 域,同 trim/warp;§24)。两点曲线:顶点=淡出起点、底点=到零点 —— 都以"距 loop 尾的小节数"存,跟着尾巴走 —— */
  /** 淡出起点:gain 从 1 开始下降处,距 loop 尾的小节数(顶点)。0/空=无淡出;≤ loopLen/2(只许吃 loop 后半)。 */
  fadeOutBars?: number;
  /** 淡出静音尾:gain 已到 0 后到 loop 尾的小节数(底点未拉到尾时留的空);0=正好淡到结尾;≤ fadeOutBars。 */
  fadeSilenceBars?: number;
  /** —— per-片 mixer(arrange 层;collage 片用,sample 片走乐器 mixer 故恒 0)—— gain + pan + 三段 EQ(low shelf / mid peaking / high shelf)。 */
  gainDb: number;
  pan?: number;
  eqLowDb?: number;
  eqMidDb?: number;
  eqHighDb?: number;
}

/** Sound 上的"原始 warp"种子:与 Clip 同形的 sample 域子集(soundId/assetId 来自 Sound、gainDb 属乐器层,故不在内)+ 出身标记。
 *  入库自动建(warpedBy:'auto')、预调改它(→'manual')、建乐器时与 Sound 合成一条独立 Clip 副本(realLibrary.soundToClip)。
 *  注:仍以 JSON 存在 `Sound.warp`(非独立表)—— 后端 pads route(/api/pads)仍读这块 JSON,不能挪走。 */
export type SampleWarp = Pick<Clip, 'startSample' | 'endSample' | 'bars' | 'timeMul' | 'semitones' | 'fadeOutBars' | 'fadeSilenceBars'> & { warpedBy?: 'auto' | 'manual' };

/** 乐器通用外壳的 mixer:gain + pan + 三段 EQ(low shelf / mid peaking / high shelf)。 */
export interface Mixer {
  gainDb: number;
  pan: number; // -1(左)..1(右)
  eq: { lowDb: number; midDb: number; highDb: number };
}

/** 三段 EQ 的频点/Q —— studioEngine 实时链与 realLibrary 离线 bake 必须共用这一组,听感才一致(别再各写各的魔法数)。
 *  低段从 120→200 Hz:lowshelf 在转折点只到半量,120 的 shelf 要到 ~60Hz 以下才切满,真正让人觉得糊/轰的低音 body(100~300)碰不到;
 *  抬到 200 让"切低"直接覆盖整段低音 body,一拧就有感(详见 PRODUCT.md EQ 调音说明)。 */
export const EQ_BANDS = {
  lowFreq: 200,   // lowshelf 转折点(原 120,偏低,切不到低音 body)
  midFreq: 1000,  // peaking 中心
  midQ: 0.7,      // peaking 宽度(~2 个八度,当 tone 控不当手术刀)
  highFreq: 4000, // highshelf 转折点
} as const;

/** EQ 每段旋钮的 dB 行程(±)。从 ±12 放宽到 ±18,让"切低"能下沉到真正听得出的深度。 */
export const EQ_DB_RANGE = 18;

/** per-乐器 send 量(§17):各乐器旁路进 3 个共享效果 return 的量,0..1(0=不送)。
 *  return 的核心参数 + 电平/开关是全局的(Project.fx),这里只存每件乐器送多少。 */
export interface InstrumentSends {
  dist: number;
  delay: number;
  reverb: number;
}
export const defaultSends = (): InstrumentSends => ({ dist: 0, delay: 0, reverb: 0 });

/** Collage payload 里的一片 = Clip + 轨上位置 + 摆放 id。单轨有序、不重叠。 */
export interface CollageClip extends Clip {
  /** 这次摆放的 id(选中 / 移动用;同一 Clip 可多次摆放各自独立)。 */
  id: string;
  /** 轨上位置(grid step)。 */
  startStep: number;
}

/** 乐器 payload:按类型不同(深度封顶 —— collage 不嵌 collage)。 */
export type InstrumentPayload =
  | { kind: 'sample'; clip: Clip }
  | { kind: 'collage'; bars: number; stepsPerBar: number; loopStartStep: number; clips: CollageClip[]; bakedAssetId: string | null };

/** 操场上的一件乐器 = 通用外壳 + payload。独立拷贝;开关随主走带量化启停。 */
export interface Instrument {
  id: string;
  /** session 的 4×25 网格位置(0..99)。 */
  slot: number;
  label: string;
  color: string | null;
  /** 乐器图标 key(见 instrumentIcons);空 = 默认 'wav' 波形。 */
  icon?: string | null;
  /** —— 通用外壳(所有乐器类型共有)—— */
  mixer: Mixer;
  /** 旁路进 3 个共享效果 return 的 send 量(§17);0..1。 */
  sends: InstrumentSends;
  /** 开关:开=随主走带量化播放(运行态;持久化默认态)。 */
  enabled: boolean;
  /** —— 类型相关 —— */
  payload: InstrumentPayload;
}

/** 一个 Session = 操场(一组并行乐器)= Ableton 式"场景"。长度 = 最长乐器。
 *  §20:`index` 顺序即 Song 线性模式的歌曲顺序;`repeats` = 该场景连播次数(Live 模式忽略);`color` = rail 彩色卡标识色。 */
export interface Session {
  id: string;
  name: string;
  index: number;
  /** §20 Song 线性模式:本场景连播次数(≥1;Live 切换模式忽略)。 */
  repeats: number;
  /** §20 场景标识色(rail 彩色卡;null = 默认色)。 */
  color: string | null;
  /** §26.v2 Song 模式 XY 自动化:每效果一条(filter/slicer/delay/brake),同时发声;null=无。仅 Song 模式回放。 */
  xyAuto?: import('./models').XYAutoSet | null;
  instruments: Instrument[];
}

/** 场景调色板(rail 彩色卡 / 新建场景轮取;暖色暗调,与乐器 pad 色互不强绑)。 */
export const SESSION_COLORS = ['#6f9e8b', '#7e8a9e', '#c2a24f', '#c2724f', '#8a6f9e', '#b07f86'];
/** 兜整次数(≥1 的有限整数)。 */
export const sessionRepeats = (s: Pick<Session, 'repeats'>): number => {
  const r = Math.round(s.repeats);
  return Number.isFinite(r) && r >= 1 ? r : 1;
};

export const SESSION_ROWS = 4;
export const SESSION_COLS = 25;
export const SLOTS_PER_SESSION = SESSION_ROWS * SESSION_COLS; // 100

/** §24 clip 尾淡出的归一化包络:输入 t(0..1),输出 gain(1..0);隆起抛物线 1-t²。
 *  编辑器画曲线/罩层 与 离线 bake(realLibrary.applyFade)**必须共用这一条** —— 改曲线只改这里,所见才永远=所听。 */
export const fadeGain = (t: number): number => { const u = t < 0 ? 0 : t > 1 ? 1 : t; return 1 - u * u; };

/** 一件乐器占多少小节(sample=clip.bars;collage=payload.bars)。 */
/** timeMul 兜成正有限数(默认 1),防 0/NaN/负值顺着 bars 扩散。 */
export const clipTimeMul = (c: Clip): number => (Number.isFinite(c.timeMul) && (c.timeMul as number) > 0 ? (c.timeMul as number) : 1);

export function instrumentBars(inst: Instrument): number {
  const p = inst.payload;
  return p.kind === 'sample' ? Math.max(1, Math.round(p.clip.bars * clipTimeMul(p.clip))) : Math.max(1, p.bars);
}

/** Session 长度 = 最长乐器(空 session 记 1)。 */
export function sessionBars(s: Session): number {
  return s.instruments.reduce((m, i) => Math.max(m, instrumentBars(i)), 1);
}

/** §26.11 该 session 当前激活(`enabled`=随主走带量化播放)的乐器;徽章计数 + hover 名单共用。solo 是瞬态隔离、不计在内。 */
export const activeInstruments = (s: Session): Instrument[] => s.instruments.filter((i) => i.enabled);

export const defaultMixer = (): Mixer => ({ gainDb: 0, pan: 0, eq: { lowDb: 0, midDb: 0, highDb: 0 } });

/** 把 Clip 的 per-片 mixer 字段拼成 Mixer(喂 MixerStrip);缺省补 0。 */
export const clipMixer = (c: Clip): Mixer => ({ gainDb: c.gainDb, pan: c.pan ?? 0, eq: { lowDb: c.eqLowDb ?? 0, midDb: c.eqMidDb ?? 0, highDb: c.eqHighDb ?? 0 } });
/** Mixer(patch)→ Clip 的 per-片字段 patch(写回时用)。 */
export const mixerToClipPatch = (m: Partial<Mixer>): Partial<Pick<Clip, 'gainDb' | 'pan' | 'eqLowDb' | 'eqMidDb' | 'eqHighDb'>> => ({
  ...(m.gainDb !== undefined ? { gainDb: m.gainDb } : {}),
  ...(m.pan !== undefined ? { pan: m.pan } : {}),
  ...(m.eq !== undefined ? { eqLowDb: m.eq.lowDb, eqMidDb: m.eq.midDb, eqHighDb: m.eq.highDb } : {}),
});
