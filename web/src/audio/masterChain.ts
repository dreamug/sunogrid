'use client';
// §32 导出与 live 引擎共用的主总线零件 —— 抽出来防「导出渲染的音色和播放漂移」。
// softClipCurve = 主总线软削波天花板曲线;makeShelfEq = 三段串联 EQ 节点。
// studioEngine(实时)与 exportSong(离线 Tone.Offline)都从这里建,改一处两处一起对。
import * as Tone from 'tone';
import { EQ_BANDS, DEFAULT_MASTER, type MasterConfig, type MasterSat, type MasterWidth } from '@/contracts';

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

// ============================ §42 Master Strip(总线母带链 / 缩混)============================
// 可插拔黑盒(§42.0):live(studioEngine)与离线导出(exportSong)调同一个 makeMasterStrip(),防音色漂移。
// v1 = memoryless 三件(EQ / Saturation / Stereo Width)+ strip 真旁路 + RMS 近似电平表;comp/limiter 留 v2(配置带着、引擎暂不建)。
const mclamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const METER_FLOOR = -100;
const toDb = (v: number) => (v > 1e-5 ? 20 * Math.log10(v) : METER_FLOOR);

/** strip 输出的只读表(§42.0)。v1:gr 恒 0(无压缩),lufs/tp 为 RMS/峰值近似;v2 接真 LUFS/真峰。 */
export interface MasterMeters { gr: number; lufsST: number; lufsI: number; tpL: number; tpR: number; }

/** §42.0 可插拔接口:外部只认 input/output + 这几个方法,不认内核实现(v1 原生 Tone,v2 可换 Faust/WASM)。 */
export interface MasterStrip {
  readonly input: Tone.ToneAudioNode;
  readonly output: Tone.ToneAudioNode;
  setConfig(cfg: MasterConfig): void;
  setBypass(b: boolean): void;
  setBpm(bpm: number): void;
  getMeters(): MasterMeters;
  ready(): Promise<void>;
  dispose(): void;
}

// 饱和曲线:小信号斜率=1(电平中性),峰值处压软 = 加谐波"胶水"。drive 由前级增益喂入,character 改形状。
function satCurve(character: MasterSat['character'], n = 2048): Float32Array {
  const c = new Float32Array(n);
  const shape = character === 'soft' ? 1.2 : character === 'tube' ? 1.8 : 1.5; // tape=1.5
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    if (character === 'tube') { const k = x < 0 ? 0.85 : 1.15; c[i] = Math.tanh(x * shape * k) / shape; } // 非对称=偶次谐波暖
    else c[i] = Math.tanh(x * shape) / shape;
  }
  return c;
}

// 饱和块:dry/wet 并联(mix=0 → 纯干声直通);on=false 即 mix 视作 0。
class SatNode {
  readonly input = new Tone.Gain(1);
  readonly output = new Tone.Gain(1);
  private dry = new Tone.Gain(1);
  private wet = new Tone.Gain(0);
  private pre = new Tone.Gain(1);
  private shaper = new Tone.WaveShaper(satCurve('tape'));
  private character: MasterSat['character'] = 'tape';
  constructor() {
    this.shaper.oversample = '4x';
    this.input.connect(this.dry); this.dry.connect(this.output);
    this.input.chain(this.pre, this.shaper, this.wet); this.wet.connect(this.output);
  }
  set(c: MasterSat): void {
    if (c.character !== this.character) { this.character = c.character; this.shaper.curve = satCurve(c.character); }
    this.pre.gain.value = 1 + c.drive * c.drive * 6;       // 0..1 → 1..7 前级喂入
    const m = c.on ? mclamp(c.mix, 0, 1) : 0;              // dry/wet 交叉;off=纯干声
    this.wet.gain.value = m; this.dry.gain.value = 1 - m;
  }
  dispose(): void { [this.input, this.output, this.dry, this.wet, this.pre, this.shaper].forEach((nd) => { try { nd.dispose(); } catch { /* */ } }); }
}

// 立体声宽度:M/S 编解码。M=0.5(L+R),S=0.5(L−R);side 经 monoBelowHz 高通(以下转单声道)+ air 高架 + width 增益;
// 重建 L=M+S' / R=M−S'。on=false → dry 直通(零改动);on=true → 走 M/S(width=1/mono=0/air=0 时仍透明)。
class WidthNode {
  readonly input = new Tone.Gain(1);
  readonly output = new Tone.Gain(1);
  private dry = new Tone.Gain(0);
  private wet = new Tone.Gain(1);
  private split = new Tone.Split();
  private merge = new Tone.Merge();
  private midL = new Tone.Gain(0.5); private midR = new Tone.Gain(0.5); private mid = new Tone.Gain(1);
  private sideL = new Tone.Gain(0.5); private sideR = new Tone.Gain(-0.5); private side = new Tone.Gain(1);
  private sideHp = new Tone.Filter(10, 'highpass');
  private sideAir = new Tone.Filter({ type: 'highshelf', frequency: 8000, gain: 0 });
  private sideW = new Tone.Gain(1);
  private sideNeg = new Tone.Gain(-1);
  private lOut = new Tone.Gain(1); private rOut = new Tone.Gain(1);
  constructor() {
    this.input.connect(this.dry); this.dry.connect(this.output);
    this.input.connect(this.split);
    this.split.connect(this.midL, 0, 0); this.split.connect(this.midR, 1, 0);
    this.midL.connect(this.mid); this.midR.connect(this.mid);
    this.split.connect(this.sideL, 0, 0); this.split.connect(this.sideR, 1, 0);
    this.sideL.connect(this.side); this.sideR.connect(this.side);
    this.side.chain(this.sideHp, this.sideAir, this.sideW);
    this.mid.connect(this.lOut); this.sideW.connect(this.lOut);                 // L = M + S'
    this.mid.connect(this.rOut); this.sideW.connect(this.sideNeg); this.sideNeg.connect(this.rOut); // R = M − S'
    this.lOut.connect(this.merge, 0, 0); this.rOut.connect(this.merge, 0, 1);
    this.merge.connect(this.wet); this.wet.connect(this.output);
  }
  set(c: MasterWidth): void {
    this.sideW.gain.value = mclamp(c.width, 0, 2);
    this.sideHp.frequency.value = Math.max(10, c.monoBelowHz);                  // 0 → 10Hz(等于不动)
    this.sideAir.gain.value = mclamp(c.air, -12, 12);
    const on = c.on;
    this.wet.gain.value = on ? 1 : 0; this.dry.gain.value = on ? 0 : 1;
  }
  dispose(): void {
    [this.input, this.output, this.dry, this.wet, this.split, this.merge, this.midL, this.midR, this.mid,
     this.sideL, this.sideR, this.side, this.sideHp, this.sideAir, this.sideW, this.sideNeg, this.lOut, this.rOut]
      .forEach((nd) => { try { nd.dispose(); } catch { /* */ } });
  }
}

// ---- §42.3 Bus Glue 压缩器(AudioWorklet,路线 A)----
// 抗抽吸(§17 教训):侧链 HPF(kick 不踩整 mix)+ lookahead(控瞬态不靠快攻)+ 慢攻软膝低比率(只胶水)
// + auto-release(混向更慢的释放=抗规律 pump)。并行 mix 在 worklet 外做(CompNode 的 dry/wet,dry 同步延迟对齐 lookahead 防梳状)。
// softClip 天花板(§17)永远在 strip 之后兜底 → 压缩器永不需当 brickwall,这是它能温柔的根。
const GLUE_WORKLET_SRC = `
class GlueComp extends AudioWorkletProcessor {
  constructor() {
    super();
    this.sr = sampleRate;
    this.cfg = { on:false, threshold:-18, ratio:2, attack:0.03, release:0.2, autoRelease:true, knee:6, makeup:0, scHpf:80, lookahead:0.003 };
    this.gain = 1; this.hpIn = 0; this.hpOut = 0;
    this.maxLook = Math.ceil(0.012 * this.sr) + 4;
    this.bL = new Float32Array(this.maxLook); this.bR = new Float32Array(this.maxLook);
    this.w = 0; this.blk = 0; this.minG = 1;
    this.port.onmessage = (e) => { if (e.data && e.data.cfg) this.cfg = e.data.cfg; };
  }
  process(inputs, outputs) {
    const inp = inputs[0], out = outputs[0];
    if (!out || out.length === 0) return true;
    const oL = out[0], oR = out[1] || out[0], n = oL.length, c = this.cfg;
    // 旁路:comp.on=false 或无输入 → 直通 + 上报 gr:0(并清状态,免再开时残留)。真旁路 = 不应报 GR、不应留状态。
    if (!c.on || !inp || inp.length === 0) {
      const iL = inp && inp[0], iR = inp && (inp[1] || inp[0]);
      for (let i = 0; i < n; i++) { oL[i] = iL ? iL[i] : 0; if (oR !== oL) oR[i] = iR ? iR[i] : 0; }
      this.gain = 1; this.minG = 1; this.hpIn = 0; this.hpOut = 0;
      if (++this.blk >= 4) { this.blk = 0; this.port.postMessage({ gr: 0 }); }
      return true;
    }
    const L = inp[0], R = inp[1] || inp[0], sr = this.sr;
    const atkC = Math.exp(-1 / (Math.max(0.0002, c.attack) * sr));
    const relBase = Math.max(0.01, c.release);
    const relFastC = Math.exp(-1 / (relBase * sr));
    const relSlowC = Math.exp(-1 / (Math.min(2.5, relBase * 5) * sr));
    const thr = c.threshold, ratio = Math.max(1, c.ratio), knee = Math.max(0.0001, c.knee);
    const makeup = Math.pow(10, c.makeup / 20), slope = 1 - 1 / ratio;
    const hpCut = Math.min(0.49 * sr, Math.max(10, c.scHpf)), hpA = Math.exp(-2 * Math.PI * hpCut / sr);
    const look = Math.min(this.maxLook - 1, Math.max(0, Math.round((c.lookahead || 0) * sr)));
    for (let i = 0; i < n; i++) {
      const l = L[i], r = R[i];
      const dIn = 0.5 * (l + r);
      const hp = hpA * (this.hpOut + dIn - this.hpIn); this.hpIn = dIn; this.hpOut = hp; // 侧链一阶高通
      const det = Math.abs(hp), detDb = det > 1e-9 ? 20 * Math.log10(det) : -120;
      const over = detDb - thr;
      let grDb; // 软膝增益计算 → 增益衰减(dB,>=0)
      if (over <= -knee / 2) grDb = 0;
      else if (over >= knee / 2) grDb = slope * over;
      else { const x = over + knee / 2; grDb = slope * x * x / (2 * knee); }
      const target = Math.pow(10, -grDb / 20);
      if (target < this.gain) this.gain = atkC * this.gain + (1 - atkC) * target;                    // attack
      else { const relC = c.autoRelease ? (relFastC * 0.35 + relSlowC * 0.65) : relFastC; this.gain = relC * this.gain + (1 - relC) * target; } // release(auto=混向更慢)
      if (this.gain < this.minG) this.minG = this.gain;   // 跨块累积真实最深 GR(实例字段,上报后才清)
      this.bL[this.w] = l; this.bR[this.w] = r;                                                       // lookahead:延迟音频,侧链不延迟
      const ri = (this.w - look + this.maxLook) % this.maxLook, dl = this.bL[ri], dr = this.bR[ri];
      this.w = (this.w + 1) % this.maxLook;
      const g = this.gain * makeup;
      oL[i] = dl * g; if (oR !== oL) oR[i] = dr * g;
    }
    if (++this.blk >= 4) { this.blk = 0; this.port.postMessage({ gr: this.minG < 1 ? -20 * Math.log10(this.minG) : 0 }); this.minG = 1; } // 上报整窗最深 GR 后清
    return true;
  }
}
registerProcessor('glue-comp', GlueComp);

// ---- §42 Bus Limiter:真峰 lookahead 砖墙限幅(opt-in,strip 最后一级)。softClip(§17)仍在 strip 之后做最终兜底。----
class BrickLimiter extends AudioWorkletProcessor {
  constructor() {
    super();
    this.sr = sampleRate;
    this.cfg = { on:false, gainDb:0, ceilingDb:-1, release:0.2 };
    this.look = Math.max(1, Math.round(0.0015 * this.sr)); // 1.5ms lookahead
    this.maxLook = this.look + 4;
    this.bL = new Float32Array(this.maxLook); this.bR = new Float32Array(this.maxLook);
    this.w = 0; this.gain = 1;
    this.port.onmessage = (e) => { if (e.data && e.data.cfg) this.cfg = e.data.cfg; };
  }
  process(inputs, outputs) {
    const inp = inputs[0], out = outputs[0];
    if (!out || out.length === 0) return true;
    const oL = out[0], oR = out[1] || out[0], n = oL.length, c = this.cfg;
    if (!c.on || !inp || inp.length === 0) { // 旁路:直通,无 lookahead 余延迟
      const iL = inp && inp[0], iR = inp && (inp[1] || inp[0]);
      for (let i = 0; i < n; i++) { oL[i] = iL ? iL[i] : 0; if (oR !== oL) oR[i] = iR ? iR[i] : 0; }
      this.gain = 1; return true;
    }
    const L = inp[0], R = inp[1] || inp[0], sr = this.sr;
    const ceil = Math.pow(10, c.ceilingDb / 20);
    const drive = Math.pow(10, (c.gainDb || 0) / 20); // maximizer:输入 drive 把信号灌进天花板=推响度
    const relC = Math.exp(-1 / (Math.max(0.005, c.release) * sr));
    const atkC = Math.exp(-1 / (0.0003 * sr)); // 快攻(在 lookahead 窗内压下)
    const look = this.look;
    for (let i = 0; i < n; i++) {
      const l = L[i] * drive, r = R[i] * drive;   // 先灌增益,再砖墙;峰值恒钉天花板,平均电平随 drive 升
      this.bL[this.w] = l; this.bR[this.w] = r;
      const peak = Math.max(Math.abs(l), Math.abs(r)), target = peak > ceil ? ceil / peak : 1;
      this.gain = target < this.gain ? atkC * this.gain + (1 - atkC) * target : relC * this.gain + (1 - relC) * target;
      const ri = (this.w - look + this.maxLook) % this.maxLook, dl = this.bL[ri], dr = this.bR[ri];
      this.w = (this.w + 1) % this.maxLook;
      let yl = dl * this.gain, yr = dr * this.gain;
      if (yl > ceil) yl = ceil; else if (yl < -ceil) yl = -ceil;   // 砖墙硬夹(brickwall 保证)
      if (yr > ceil) yr = ceil; else if (yr < -ceil) yr = -ceil;
      oL[i] = yl; if (oR !== oL) oR[i] = yr;
    }
    return true;
  }
}
registerProcessor('brick-limiter', BrickLimiter);
`;
let _glueUrl: string | null = null;
function glueWorkletUrl(): string { if (!_glueUrl) _glueUrl = URL.createObjectURL(new Blob([GLUE_WORKLET_SRC], { type: 'application/javascript' })); return _glueUrl; }

// 压缩块:worklet 全压缩声 + CompNode 外做并行(dry/wet);dry 同步延迟对齐 lookahead 防梳状。on=false 或未就绪 → 纯干声旁路。
class CompNode {
  readonly input = new Tone.Gain(1);
  readonly output = new Tone.Gain(1);
  private dryDelay = new Tone.Delay(0.012, 0.012);
  private dry = new Tone.Gain(1);
  private wet = new Tone.Gain(0);
  private node?: AudioWorkletNode;
  private _gr = 0;
  private cfg: import('@/contracts').MasterComp = { ...DEFAULT_MASTER.comp };
  private readyPromise?: Promise<void>;
  constructor() {
    this.input.connect(this.dryDelay); this.dryDelay.connect(this.dry); this.dry.connect(this.output);
    this.wet.connect(this.output);
  }
  gr(): number { return this._gr; }
  set(c: import('@/contracts').MasterComp): void {
    this.cfg = c;
    // 干声延迟 = lookahead(相位对齐并行);comp 关 → 0(真旁路,主总线不带 3ms 余延迟)
    this.dryDelay.delayTime.value = c.on ? Math.min(0.012, Math.max(0, c.lookahead / 1000)) : 0;
    if (!c.on) this._gr = 0; // 关 → GR 表即刻归零(worklet 也会上报 0,这里先即时响应)
    if (this.node) {
      this.node.port.postMessage({ cfg: { ...c, attack: c.attack / 1000, release: c.release / 1000, lookahead: c.lookahead / 1000 } }); // ms→s
      const m = c.on ? mclamp(c.mix, 0, 1) : 0;
      this.wet.gain.value = m; this.dry.gain.value = 1 - m;
    } else { this.wet.gain.value = 0; this.dry.gain.value = 1; } // 未就绪 → 旁路(纯干声),不丢信号
  }
  ready(): Promise<void> { if (!this.readyPromise) this.readyPromise = this.load(); return this.readyPromise; }
  private async load(): Promise<void> {
    try {
      const ctx = Tone.getContext();
      await ctx.addAudioWorkletModule(glueWorkletUrl());
      const raw = ctx.rawContext as unknown as BaseAudioContext;
      this.node = new AudioWorkletNode(raw, 'glue-comp', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2] });
      this.node.port.onmessage = (e: MessageEvent) => { const d = e.data as { gr?: number }; if (d && typeof d.gr === 'number') this._gr = d.gr; };
      this.input.connect(this.node);
      this.node.connect(this.wet.input as unknown as AudioNode);
      this.set(this.cfg); // node 就绪 → 应用当前 cfg + 并行 mix
    } catch { /* worklet 加载失败 → comp 保持旁路(dry 直通) */ }
  }
  dispose(): void {
    try { this.node?.disconnect(); } catch { /* */ }
    [this.input, this.output, this.dryDelay, this.dry, this.wet].forEach((nd) => { try { nd.dispose(); } catch { /* */ } });
  }
}

// 限幅块:on → 经 worklet(带 lookahead 延迟);off → 直通(零延迟,真旁路)。无并行(串行 insert,最后一级)。
class LimiterNode {
  readonly input = new Tone.Gain(1);
  readonly output = new Tone.Gain(1);
  private bypass = new Tone.Gain(1);
  private wet = new Tone.Gain(0);
  private node?: AudioWorkletNode;
  private cfg: import('@/contracts').MasterLimiter = { ...DEFAULT_MASTER.limiter };
  private readyPromise?: Promise<void>;
  constructor() {
    this.input.connect(this.bypass); this.bypass.connect(this.output);
    this.wet.connect(this.output);
  }
  set(c: import('@/contracts').MasterLimiter): void {
    this.cfg = c;
    if (this.node) {
      this.node.port.postMessage({ cfg: { on: c.on, gainDb: c.gainDb, ceilingDb: c.ceilingDb, release: c.release / 1000 } }); // ms→s
      this.wet.gain.value = c.on ? 1 : 0; this.bypass.gain.value = c.on ? 0 : 1;
    } else { this.wet.gain.value = 0; this.bypass.gain.value = 1; } // 未就绪 → 直通
  }
  ready(): Promise<void> { if (!this.readyPromise) this.readyPromise = this.load(); return this.readyPromise; }
  private async load(): Promise<void> {
    try {
      const ctx = Tone.getContext();
      await ctx.addAudioWorkletModule(glueWorkletUrl()); // 同一模块(含 glue-comp + brick-limiter),_workletPromise 缓存
      const raw = ctx.rawContext as unknown as BaseAudioContext;
      this.node = new AudioWorkletNode(raw, 'brick-limiter', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2] });
      this.input.connect(this.node);
      this.node.connect(this.wet.input as unknown as AudioNode);
      this.set(this.cfg);
    } catch { /* 加载失败 → 保持直通 */ }
  }
  dispose(): void {
    try { this.node?.disconnect(); } catch { /* */ }
    [this.input, this.output, this.bypass, this.wet].forEach((nd) => { try { nd.dispose(); } catch { /* */ } });
  }
}

class MasterStripImpl implements MasterStrip {
  readonly input = new Tone.Gain(1);
  readonly output = new Tone.Gain(1);
  private dry = new Tone.Gain(0);   // §42.1a strip 真旁路:input → dry → output(bypass 时 dry=1/wet=0)
  private wet = new Tone.Gain(1);   // input → [EQ→Sat→Width] → wet → output
  private eq = makeShelfEq();
  private comp = new CompNode();
  private sat = new SatNode();
  private width = new WidthNode();
  private limiter = new LimiterNode();
  private analyser = new Tone.Analyser('waveform', 1024); // strip 后电平表(LUFS/真峰近似)
  private msI = 0;                  // integrated mean-square 的慢 EMA
  constructor() {
    // 干路(bypass):input 直连 output
    this.input.connect(this.dry); this.dry.connect(this.output);
    // 湿路(处理链):input → EQ(low→mid→high) → Sat → Width → wet → output
    this.input.connect(this.eq.low);
    this.eq.low.connect(this.eq.mid); this.eq.mid.connect(this.eq.high);
    this.eq.high.connect(this.comp.input);          // §42.2 顺序:EQ → Comp(glue) → Sat → Width
    this.comp.output.connect(this.sat.input);
    this.sat.output.connect(this.width.input);
    this.width.output.connect(this.limiter.input);  // §42.2 顺序:… → Width → Limiter(永远最后一级)
    this.limiter.output.connect(this.wet); this.wet.connect(this.output);
    this.output.connect(this.analyser); // 并联抽头(strip 后),只读表用
  }
  setConfig(cfg: MasterConfig): void {
    this.setBypass(!cfg.on);
    this.eq.low.gain.value = cfg.eq.on ? cfg.eq.low : 0;
    this.eq.mid.gain.value = cfg.eq.on ? cfg.eq.mid : 0;
    this.eq.high.gain.value = cfg.eq.on ? cfg.eq.high : 0;
    this.comp.set(cfg.comp);
    this.sat.set(cfg.sat);
    this.width.set(cfg.width);
    this.limiter.set(cfg.limiter);
  }
  setBypass(b: boolean): void {
    // 交叉淡入淡出防 click(memoryless,15ms)。softClip 天花板在 strip 之后,不受影响。
    this.dry.gain.rampTo(b ? 1 : 0, 0.015);
    this.wet.gain.rampTo(b ? 0 : 1, 0.015);
  }
  setBpm(_bpm: number): void { /* v1 无时间基节点;v2 给 comp lookahead / 同步用 */ }
  getMeters(): MasterMeters {
    const buf = this.analyser.getValue() as Float32Array;
    let sum = 0, peak = 0;
    for (let i = 0; i < buf.length; i++) { const x = buf[i]; sum += x * x; if (Math.abs(x) > peak) peak = Math.abs(x); }
    const ms = buf.length ? sum / buf.length : 0;
    this.msI = this.msI * 0.95 + ms * 0.05;                       // 慢积分近似 integrated LUFS
    const rms = Math.sqrt(ms);
    const lufsST = ms > 1e-7 ? -0.691 + 10 * Math.log10(ms) : METER_FLOOR; // K 加权略去(v1 近似)
    const lufsI = this.msI > 1e-7 ? -0.691 + 10 * Math.log10(this.msI) : METER_FLOOR;
    const tp = toDb(peak);                                        // v1:单声道下混峰值近似真峰(L/R 暂同值)
    void rms;
    return { gr: this.comp.gr(), lufsST, lufsI, tpL: tp, tpR: tp };
  }
  ready(): Promise<void> { return Promise.all([this.comp.ready(), this.limiter.ready()]).then(() => {}); } // §42.3/§42 等压缩器+限幅器 worklet 就绪(同一模块;离线导出 await,live fire-and-forget)
  dispose(): void {
    [this.input, this.output, this.dry, this.wet, this.eq.low, this.eq.mid, this.eq.high, this.analyser]
      .forEach((nd) => { try { nd.dispose(); } catch { /* */ } });
    this.comp.dispose(); this.sat.dispose(); this.width.dispose(); this.limiter.dispose();
  }
}

/** §42.0 共用工厂:live 与离线导出都从这里建 master strip(防音色漂移)。bpm 给 v2 的时间基节点用,v1 忽略。 */
export function makeMasterStrip(_bpm: number): MasterStrip {
  const strip = new MasterStripImpl();
  strip.setConfig(DEFAULT_MASTER);
  return strip;
}
