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
  /** —— per-片 mixer(arrange 层;collage 片用,sample 片走乐器 mixer 故恒 0)—— gain + pan + 两段 shelf EQ。 */
  gainDb: number;
  pan?: number;
  eqLowDb?: number;
  eqHighDb?: number;
}

/** Sound 上的"原始 warp"种子:与 Clip 同形的 sample 域子集(soundId/assetId 来自 Sound、gainDb 属乐器层,故不在内)+ 出身标记。
 *  入库自动建(warpedBy:'auto')、预调改它(→'manual')、建乐器时与 Sound 合成一条独立 Clip 副本(realLibrary.soundToClip)。
 *  注:仍以 JSON 存在 `Sound.warp`(非独立表)—— 老 pad 机也读这块 JSON(pads route / useLoopMachine),不能挪走。 */
export type SampleWarp = Pick<Clip, 'startSample' | 'endSample' | 'bars' | 'timeMul' | 'semitones'> & { warpedBy?: 'auto' | 'manual' };

/** 乐器通用外壳的 mixer:gain + pan + 两段 shelf EQ。 */
export interface Mixer {
  gainDb: number;
  pan: number; // -1(左)..1(右)
  eq: { lowDb: number; highDb: number };
}

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

/** 一个 Session = 操场(一组并行乐器)。长度 = 最长乐器;未来按 index 排进歌曲时间线。 */
export interface Session {
  id: string;
  name: string;
  index: number;
  instruments: Instrument[];
}

export const SESSION_ROWS = 4;
export const SESSION_COLS = 25;
export const SLOTS_PER_SESSION = SESSION_ROWS * SESSION_COLS; // 100

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

export const defaultMixer = (): Mixer => ({ gainDb: 0, pan: 0, eq: { lowDb: 0, highDb: 0 } });

/** 把 Clip 的 per-片 mixer 字段拼成 Mixer(喂 MixerStrip);缺省补 0。 */
export const clipMixer = (c: Clip): Mixer => ({ gainDb: c.gainDb, pan: c.pan ?? 0, eq: { lowDb: c.eqLowDb ?? 0, highDb: c.eqHighDb ?? 0 } });
/** Mixer(patch)→ Clip 的 per-片字段 patch(写回时用)。 */
export const mixerToClipPatch = (m: Partial<Mixer>): Partial<Pick<Clip, 'gainDb' | 'pan' | 'eqLowDb' | 'eqHighDb'>> => ({
  ...(m.gainDb !== undefined ? { gainDb: m.gainDb } : {}),
  ...(m.pan !== undefined ? { pan: m.pan } : {}),
  ...(m.eq !== undefined ? { eqLowDb: m.eq.lowDb, eqHighDb: m.eq.highDb } : {}),
});
