'use client';
// 主总线效果器(§17)—— 三个并联 aux return:失真 / 延迟 / 混响。各乐器经 send 量旁路进对应 return.input。
// 每块 = 纯湿声 return:input → [core] → wet → output(dry 恒 0,不并入干声;干声走乐器自己的 panner→master)。
// on=false 或 mix=0 → wet=0 = 该 return 静默。节拍器不进这里(StudioEngine 让它走 master,不进 FX)。
import * as Tone from 'tone';
import type { FxConfig, FxDistortion, FxDelay, FxReverb } from '@/contracts';

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
// 0..1 → [lo,hi] 指数映射(滤波频率听感才线性)。
const expMap = (t: number, lo: number, hi: number) => lo * Math.pow(hi / lo, clamp(t, 0, 1));

// 波形整形曲线 —— 形状固定(drive 由前级增益体现,不必每次重算曲线)。
function distCurve(character: FxDistortion['character'], n = 2048): Float32Array {
  const c = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    let y: number;
    if (character === 'hard') y = clamp(x * 1.5, -1, 1);                                        // hard clip
    else if (character === 'fuzz') { const k = x < 0 ? 1.1 : 2.0; y = Math.sign(x) * (1 - Math.exp(-Math.abs(x * 3 * k))); } // 非对称重谐波
    else y = Math.tanh(x * 2);                                                                  // soft = 管味
    c[i] = y;
  }
  return c;
}

// --- 失真:WaveShaper(4× 过采样)+ 后置低通(tone)。drive = 喂入非线性的前级增益。 ---
class DistFx {
  readonly input = new Tone.Gain(1);
  readonly output = new Tone.Gain(1);
  private dry = new Tone.Gain(0); // return 是纯湿声:dry 恒 0(即便 set() 还没跑也不漏干声)
  private wet = new Tone.Gain(0);
  private pre = new Tone.Gain(1);
  private shaper = new Tone.WaveShaper(distCurve('soft'));
  private toneLp = new Tone.Filter(18000, 'lowpass');
  private outGain = new Tone.Gain(0.7); // 整形后偏热,统一压一下
  private character: FxDistortion['character'] = 'soft';
  constructor() {
    this.shaper.oversample = '4x';
    this.input.connect(this.dry); this.dry.connect(this.output);
    this.input.chain(this.pre, this.shaper, this.toneLp, this.outGain, this.wet); this.wet.connect(this.output);
  }
  set(c: FxDistortion): void {
    if (c.character !== this.character) { this.character = c.character; this.shaper.curve = distCurve(c.character); }
    this.pre.gain.value = 1 + c.drive * c.drive * 40;            // 0..1 → 1..41(指数感)
    this.toneLp.frequency.value = expMap(c.tone, 400, 18000);
    const m = c.on ? clamp(c.mix, 0, 1) : 0; // send/return:本块是 return,只出湿声;mix = return 输出电平
    this.wet.gain.value = m; this.dry.gain.value = 0;
  }
  dispose(): void { [this.input, this.output, this.dry, this.wet, this.pre, this.shaper, this.toneLp, this.outGain].forEach((n) => { try { n.dispose(); } catch { /* */ } }); }
}

// --- 延迟:自建反馈环 + 环内低通阻尼(回声逐次变暗=模拟味)+ ping-pong 交叉耦合。 ---
// ping-pong 切换会改拓扑 → 重建子图(rebuild);其余参数都是即时 param set。
class DelayFx {
  readonly input = new Tone.Gain(1);
  readonly output = new Tone.Gain(1);
  private dry = new Tone.Gain(0); // return 是纯湿声:dry 恒 0(即便 set() 还没跑也不漏干声)
  private wet = new Tone.Gain(0);
  private graph: Tone.ToneAudioNode[] = [];
  private dL!: Tone.Delay; private lpL!: Tone.Filter; private fbL!: Tone.Gain;
  private dR?: Tone.Delay; private lpR?: Tone.Filter; private fbR?: Tone.Gain; // 仅 ping-pong 时存在
  private pingpong = false;
  private bpm = 120;
  private cfg: FxDelay | null = null;
  constructor() {
    this.input.connect(this.dry); this.dry.connect(this.output);
    this.wet.connect(this.output);
    this.build(false);
  }
  private build(pingpong: boolean): void {
    this.graph.forEach((n) => { try { n.dispose(); } catch { /* */ } });
    this.graph = [];
    this.pingpong = pingpong;
    const dL = new Tone.Delay(0.25, 2), lpL = new Tone.Filter(8000, 'lowpass'), fbL = new Tone.Gain(0);
    this.input.connect(dL); dL.connect(lpL); lpL.connect(fbL);
    if (pingpong) {
      const dR = new Tone.Delay(0.25, 2), lpR = new Tone.Filter(8000, 'lowpass'), fbR = new Tone.Gain(0);
      const panL = new Tone.Panner(-1), panR = new Tone.Panner(1);
      fbL.connect(dR); dR.connect(lpR); lpR.connect(fbR); fbR.connect(dL); // 交叉耦合:左反馈进右、右反馈进左
      lpL.connect(panL); lpR.connect(panR); panL.connect(this.wet); panR.connect(this.wet);
      this.dR = dR; this.lpR = lpR; this.fbR = fbR;
      this.graph = [dL, lpL, fbL, dR, lpR, fbR, panL, panR];
    } else {
      fbL.connect(dL);          // 各自反馈
      lpL.connect(this.wet);    // 居中
      this.dR = this.lpR = this.fbR = undefined;
      this.graph = [dL, lpL, fbL];
    }
    this.dL = dL; this.lpL = lpL; this.fbL = fbL;
  }
  setBpm(bpm: number): void { this.bpm = bpm; if (this.cfg) this.applyTime(this.cfg); }
  private timeSec(c: FxDelay): number {
    if (c.sync === 'ms') return clamp(c.timeMs / 1000, 0.001, 2);
    const q = 60 / this.bpm; // 四分音符秒
    const t = c.sync === '1/4' ? q : c.sync === '1/8' ? q / 2 : c.sync === '1/8.' ? q * 0.75 : q / 4; // 默认 1/16
    return clamp(t, 0.001, 2);
  }
  private applyTime(c: FxDelay): void { const t = this.timeSec(c); this.dL.delayTime.value = t; if (this.dR) this.dR.delayTime.value = t; }
  set(c: FxDelay): void {
    if (c.pingpong !== this.pingpong) this.build(c.pingpong);
    this.cfg = c;
    this.applyTime(c);
    const fb = clamp(c.feedback, 0, 0.95);
    this.fbL.gain.value = fb; if (this.fbR) this.fbR.gain.value = fb;
    const co = expMap(c.tone, 300, 16000);
    this.lpL.frequency.value = co; if (this.lpR) this.lpR.frequency.value = co;
    const m = c.on ? clamp(c.mix, 0, 1) : 0; // send/return:本块是 return,只出湿声;mix = return 输出电平
    this.wet.gain.value = m; this.dry.gain.value = 0;
  }
  dispose(): void { this.graph.forEach((n) => { try { n.dispose(); } catch { /* */ } }); [this.input, this.output, this.dry, this.wet].forEach((n) => { try { n.dispose(); } catch { /* */ } }); }
}

// --- 混响:卷积(Tone.Reverb = ConvolverNode,衰减噪声离线生成 IR)+ 湿声后置低通(damp)。 ---
// 节点设全湿(wet=1),直/湿由本块自管,这样 damp 只滤湿声、不碰直声。decay/preDelay 改 → IR 重生成(防抖,异步)。
class ReverbFx {
  readonly input = new Tone.Gain(1);
  readonly output = new Tone.Gain(1);
  private dry = new Tone.Gain(0); // return 是纯湿声:dry 恒 0(即便 set() 还没跑也不漏干声)
  private wet = new Tone.Gain(0);
  private rev: Tone.Reverb;
  private damp = new Tone.Filter(16000, 'lowpass');
  private decay = 2.5; private preDelay = 0.02;
  private regenTimer?: ReturnType<typeof setTimeout>;
  constructor() {
    this.rev = new Tone.Reverb({ decay: this.decay, preDelay: this.preDelay });
    this.rev.wet.value = 1;
    this.input.connect(this.dry); this.dry.connect(this.output);
    this.input.chain(this.rev, this.damp, this.wet); this.wet.connect(this.output);
  }
  set(c: FxReverb): void {
    const decay = clamp(c.decay, 0.1, 12), pre = clamp(c.preDelay, 0, 0.2);
    if (decay !== this.decay || pre !== this.preDelay) {
      this.decay = decay; this.preDelay = pre;
      if (this.regenTimer) clearTimeout(this.regenTimer);     // IR 重生成较重 → 防抖(最终一致,§15.D)
      this.regenTimer = setTimeout(() => { this.rev.decay = this.decay; this.rev.preDelay = this.preDelay; this.rev.generate().catch(() => {}); }, 200);
    }
    this.damp.frequency.value = expMap(1 - c.damp, 400, 16000); // damp 越大 → cutoff 越低 = 越暗
    const m = c.on ? clamp(c.mix, 0, 1) : 0; // send/return:本块是 return,只出湿声;mix = return 输出电平
    this.wet.gain.value = m; this.dry.gain.value = 0;
  }
  /** §32 离线导出:跳过 set() 的 200ms 防抖,立即用当前 decay/preDelay 同步重生成 IR 并 await。
   *  离线渲染等不到 setTimeout,不 await 就会拿到旧/空 IR(混响 send 出不来)。 */
  async ready(): Promise<void> {
    if (this.regenTimer) { clearTimeout(this.regenTimer); this.regenTimer = undefined; }
    this.rev.decay = this.decay; this.rev.preDelay = this.preDelay;
    await this.rev.generate();
  }
  dispose(): void { if (this.regenTimer) clearTimeout(this.regenTimer); [this.input, this.output, this.dry, this.wet, this.rev, this.damp].forEach((n) => { try { n.dispose(); } catch { /* */ } }); }
}

/** 主总线效果器 = 3 个并联 aux return。各乐器经 send 量旁路进对应 return.input;return 出湿声 → destination。 */
export class FxBus {
  private dist = new DistFx();
  private delay = new DelayFx();
  private reverb = new ReverbFx();
  constructor(bpm: number, destination: Tone.ToneAudioNode) {
    this.dist.output.connect(destination);
    this.delay.output.connect(destination);
    this.reverb.output.connect(destination);
    this.delay.setBpm(bpm);
  }
  /** 乐器 send 旁路汇入的目标节点(每个 return 的入口)。 */
  get distInput(): Tone.ToneAudioNode { return this.dist.input; }
  get delayInput(): Tone.ToneAudioNode { return this.delay.input; }
  get reverbInput(): Tone.ToneAudioNode { return this.reverb.input; }
  /** delay 同步分割跟工程 BPM。 */
  setBpm(bpm: number): void { this.delay.setBpm(bpm); }
  setAll(cfg: FxConfig): void { this.dist.set(cfg.distortion); this.delay.set(cfg.delay); this.reverb.set(cfg.reverb); }
  /** §32 离线导出:等混响 IR 就绪(setAll 后调,transport.start 前 await)。 */
  async ready(): Promise<void> { await this.reverb.ready(); }
  dispose(): void { this.dist.dispose(); this.delay.dispose(); this.reverb.dispose(); }
}
