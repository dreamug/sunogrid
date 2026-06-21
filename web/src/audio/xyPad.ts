'use client';
// XY 表演板(§21)—— Kaoss Pad 式主总线 insert。串在 master 与软削波天花板之间(StudioEngine.init splice)。
// 结构:input ─┬─ dry ──────────────┐
//             └─ [program] ─ wet ───┴─► output
// engage(手按下)= wet→e·mix / dry→1-e·mix(15ms ramp);release(松手)= dry=1,wet=0。没演奏且非锁定时恒旁路。
// 单板单 program;切 program = dispose 旧、build 新、重连(重的 PitchShift 只在 brake 选中才建)。
// 实时 X/Y/engage/release 由 UI 直连(瞬态,不进 undo/不落库);program/wet/on 由 setXy(config)应用(搭 Project.fx 持久化)。
// ⚠ 防爆音(click):拖动改参一律走 param.rampTo(短斜坡),不直接 .value=;滤波用 HP+LP 串联(不切 type,避开断点);slicer 门在 LFO 后接平滑低通磨钝方波边沿。
import * as Tone from 'tone';
import type { XYConfig, XYProgram } from '@/contracts';

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, Number.isFinite(v) ? v : lo));
const expMap = (t: number, lo: number, hi: number) => lo * Math.pow(hi / lo, clamp(t, 0, 1));
const R = 0.02;                                   // 参数斜坡秒数(防 zipper/click)
// 切片/延迟同步分割 → 秒(period):X 轴 0..1 吸附到 1/4·1/8·1/8.·1/16。
const RATE_BEATS = [1, 0.5, 0.75, 0.25];          // 1/4 · 1/8 · 1/8. · 1/16(以四分音符为 1)
const rateIndex = (x: number) => Math.min(3, Math.max(0, Math.floor(clamp(x, 0, 1) * 4)));

interface XYProgramImpl {
  readonly input: Tone.ToneAudioNode;
  readonly output: Tone.ToneAudioNode;
  setXY(nx: number, ny: number): void;
  setBpm(bpm: number): void;
  dispose(): void;
}

// --- 滤波:双极 DJ 滤波 = HP + LP **串联**(不切 type,避开断点 click)。中点全开;左半 LP 下扫、右半 HP 上扫;Y = resonance。 ---
class FilterProgram implements XYProgramImpl {
  readonly input = new Tone.Gain(1);
  readonly output = new Tone.Gain(1);
  private hp = new Tone.Filter({ type: 'highpass', frequency: 20, Q: 0.7, rolloff: -24 });
  private lp = new Tone.Filter({ type: 'lowpass', frequency: 20000, Q: 0.7, rolloff: -24 });
  constructor() { this.input.chain(this.hp, this.lp, this.output); }
  setXY(nx: number, ny: number): void {
    const q = 0.7 + clamp(ny, 0, 1) * 11.3;                                   // 0.7..12
    this.hp.Q.rampTo(q, R); this.lp.Q.rampTo(q, R);
    if (nx < 0.5) { this.hp.frequency.rampTo(20, R); this.lp.frequency.rampTo(expMap((0.5 - nx) / 0.5, 20000, 20), R); }   // 左:LP 下扫,HP 开
    else { this.lp.frequency.rampTo(20000, R); this.hp.frequency.rampTo(expMap((nx - 0.5) / 0.5, 20, 20000), R); }         // 右:HP 上扫,LP 开
  }
  setBpm(): void { /* 与 BPM 无关 */ }
  dispose(): void { [this.input, this.output, this.hp, this.lp].forEach((n) => n.dispose()); }
}

// --- Slicer:BPM 同步节奏门。LFO(方波)→ 平滑低通(磨钝边沿防 click)→ gate.gain;X=切片速率(吸附),Y=深度。 ---
class SlicerProgram implements XYProgramImpl {
  readonly input = new Tone.Gain(1);
  readonly output = new Tone.Gain(1);
  private gate = new Tone.Gain(0);                 // base 0,由(平滑后的)LFO 驱动 1-depth..1
  private smooth = new Tone.Filter(200, 'lowpass'); // 磨钝方波边沿:~1ms 圆角去 click,门率 ≤50Hz 不掉深度
  private lfo = new Tone.LFO({ frequency: 4, min: 1, max: 1, type: 'square' });
  private bpm = 120;
  private rateBeats = 0.5;
  constructor() {
    this.input.connect(this.gate); this.gate.connect(this.output);
    this.lfo.connect(this.smooth); this.smooth.connect(this.gate.gain);
    this.lfo.start();
    this.applyRate();
  }
  private applyRate(): void { this.lfo.frequency.rampTo(1 / Math.max(0.02, this.rateBeats * (60 / this.bpm)), 0.05); }
  setXY(nx: number, ny: number): void {
    this.rateBeats = RATE_BEATS[rateIndex(nx)];
    this.applyRate();
    const depth = 0.5 + 0.5 * clamp(ny, 0, 1);      // 0.5..1:底部也有清晰 -6dB 门(整个 Y 轴可用),顶部全斩
    this.lfo.min = 1 - depth; this.lfo.max = 1;     // 门:谷=1-depth,峰=1(平滑滤波吸收瞬变)
  }
  setBpm(bpm: number): void { this.bpm = bpm; this.applyRate(); }
  dispose(): void { this.lfo.dispose(); [this.input, this.output, this.gate, this.smooth].forEach((n) => n.dispose()); }
}

// --- Delay throw:insert 反馈延迟(含直声)。X=延迟时值(同步,rampTo→tape 式滑音不爆),Y=反馈。 ---
class DelayProgram implements XYProgramImpl {
  readonly input = new Tone.Gain(1);
  readonly output = new Tone.Gain(1);
  private direct = new Tone.Gain(1);
  private delay = new Tone.Delay(0.25, 2);
  private lp = new Tone.Filter(8000, 'lowpass');   // 反馈环阻尼(回声逐次变暗)
  private fb = new Tone.Gain(0);
  private bpm = 120;
  private rateBeats = 0.5;
  constructor() {
    this.input.connect(this.direct); this.direct.connect(this.output);           // 直声
    this.input.connect(this.delay); this.delay.connect(this.lp);
    this.lp.connect(this.fb); this.fb.connect(this.delay);                        // 反馈环
    this.lp.connect(this.output);                                                 // 回声出
  }
  private applyTime(): void { this.delay.delayTime.rampTo(clamp(this.rateBeats * (60 / this.bpm), 0.001, 2), 0.06); }
  setXY(nx: number, ny: number): void {
    this.rateBeats = RATE_BEATS[rateIndex(nx)];
    this.applyTime();
    this.fb.gain.rampTo(clamp(ny, 0, 1) * 0.7, R);   // 上限 0.7(原 0.95 太大,回声堆爆)
  }
  setBpm(bpm: number): void { this.bpm = bpm; this.applyTime(); }
  dispose(): void { [this.input, this.output, this.direct, this.delay, this.lp, this.fb].forEach((n) => n.dispose()); }
}

// --- 刹车(tape-stop 近似):PitchShift 音高俯冲 + 低通收死 + 音量 duck。X=俯冲深度档,Y=刹车量。 ---
// 真 tape-stop(音高+速度齐降)在 web 主总线和上做不到,这是听感近似(groove 实际不慢),见 §21。
class BrakeProgram implements XYProgramImpl {
  readonly input = new Tone.Gain(1);
  readonly output = new Tone.Gain(1);
  private pitch = new Tone.PitchShift({ pitch: 0, windowSize: 0.1, wet: 0 }); // wet=0:amt=0 时全干旁路(PitchShift granular 即便 pitch=0 也会糊,故顶部要旁路)
  private lp = new Tone.Filter(18000, 'lowpass');
  private duck = new Tone.Gain(1);
  constructor() { this.input.chain(this.pitch, this.lp, this.duck, this.output); }
  setXY(nx: number, ny: number): void {
    const amt = clamp(ny, 0, 1);                       // 刹车量
    const maxDive = 12 + clamp(nx, 0, 1) * 12;         // X:俯冲深度档 12..24 半音
    this.pitch.pitch = -amt * maxDive;                 // PitchShift.pitch 非 AudioParam,直设(granular,平滑)
    this.pitch.wet.rampTo(Math.min(1, amt * 4), R);    // amt=0→全干(不糊),往下拉淡入颗粒变调
    this.lp.frequency.rampTo(expMap(1 - amt, 200, 18000), R);
    this.duck.gain.rampTo(1 - amt * 0.4, R);
  }
  setBpm(): void { /* 与 BPM 无关 */ }
  dispose(): void { [this.input, this.output, this.pitch, this.lp, this.duck].forEach((n) => n.dispose()); }
}

function buildProgram(id: XYProgram): XYProgramImpl {
  switch (id) {
    case 'slicer': return new SlicerProgram();
    case 'delay': return new DelayProgram();
    case 'brake': return new BrakeProgram();
    default: return new FilterProgram();
  }
}

export class XYPad {
  readonly input = new Tone.Gain(1);
  readonly output = new Tone.Gain(1);
  private dry = new Tone.Gain(1);
  private wet = new Tone.Gain(0);
  private prog: XYProgramImpl;
  private programId: XYProgram = 'filter';
  private bpm: number;
  private on = true;
  private mix = 1;        // WET 旋钮:engaged 时的湿量
  private engaged = false;
  private lastX = 0.5; private lastY = 0.5; // 最近 X/Y:切 program 重建子图后补位,免新效果落在默认值而非当前手指位
  private readonly RAMP = 0.02;

  constructor(bpm: number) {
    this.bpm = bpm;
    this.input.connect(this.dry); this.dry.connect(this.output);
    this.wet.connect(this.output);
    this.prog = buildProgram(this.programId);
    this.connectProg();
  }
  private connectProg(): void { this.prog.setBpm(this.bpm); this.prog.setXY(this.lastX, this.lastY); this.input.connect(this.prog.input); this.prog.output.connect(this.wet); }

  /** 应用配置(program/wet/on);program 变则重建子图。mode 由 UI 决定 release 语义,引擎不需要。 */
  setXy(cfg: XYConfig): void {
    if (!cfg) return;
    if (cfg.program !== this.programId) {
      this.programId = cfg.program;
      this.prog.dispose();
      this.prog = buildProgram(this.programId);
      this.connectProg();
    }
    this.mix = clamp(cfg.wet, 0, 1);
    this.on = cfg.on;
    if (!this.on) this.engaged = false;
    this.applyGains();
  }
  setBpm(bpm: number): void { this.bpm = bpm; this.prog.setBpm(bpm); }

  // --- 瞬态演奏(UI 直连,不进 undo/不落库)---
  engage(): void { if (!this.on) return; this.engaged = true; this.applyGains(); }
  move(nx: number, ny: number): void { this.lastX = nx; this.lastY = ny; this.prog.setXY(nx, ny); }
  release(): void { this.engaged = false; this.applyGains(); }

  private applyGains(): void {
    const w = (this.on && this.engaged) ? this.mix : 0;
    this.wet.gain.rampTo(w, this.RAMP);
    this.dry.gain.rampTo(1 - w, this.RAMP);
  }
  dispose(): void { this.prog.dispose(); [this.input, this.output, this.dry, this.wet].forEach((n) => n.dispose()); }
}
