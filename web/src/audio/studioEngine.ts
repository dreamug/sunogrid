'use client';
// Studio 音频引擎 —— 当前 studio app 唯一的引擎(旧 pad 机的 ToneAudioEngine 已退场):
// 在 M1 的"量化 launch/stop"基础上,每件乐器多挂一条 mixer 链 Player → EQ(low shelf / mid peaking / high shelf) → Panner → (volume) → dest。
// EQ = 三段串联 biquad(lowshelf@200 + peaking@1k(Q0.7) + highshelf@4k,频点见 contracts EQ_BANDS),与 realLibrary 离线 bake 路径同算法,听感一致;
// 用串联(每颗 biquad 0dB 时透明)而非 Tone.EQ3(三段分频后求和)—— 后者会在交叉点相位抵消产生梳状染色,即使 0/0/0 也变味,故弃用。
// 主走带 = Tone.Transport(全局唯一时钟);乐器"开关"= 量化到下一个小节边界的 launch/stop。
// 假设:每件乐器的 buffer 已是整小节、可无缝循环(sample=warp 产物 / collage=bake 产物)。
import * as Tone from 'tone';
import type { FxConfig, InstrumentSends, Mixer, Quantize } from '@/contracts';
import { EQ_BANDS } from '@/contracts';
import { FxBus } from './fxBus';
import { XYPad } from './xyPad';
import { softClipCurve, makeShelfEq, type ShelfEq } from './masterChain'; // §32:与离线导出共用软削波曲线 + 三段 EQ 构造(防音色漂移)

type VoiceState = 'off' | 'queued' | 'on' | 'stopping';

interface Voice {
  player: Tone.Player;
  eq: ShelfEq;
  muteGain: Tone.Gain;  // §18 solo 遮罩(audible?1:0):接在 sends 分叉之前 → 静音连干声带 FX send 一起灭;不动 player → 保相位
  panner: Tone.Panner;
  sendDist: Tone.Gain; sendDelay: Tone.Gain; sendReverb: Tone.Gain; // aux send 量(post-panner 旁路进 3 个 fx return,§17)
  meter: Tone.Meter;
  bars: number;
  mixer: Mixer;         // §34 最新 mixer 快照:clip 预览(previewInstrument)走 auditionChain 用它现搭一条到 dest,绕开下面的 muteGain 遮罩
  wantOn: boolean;      // 用户开关意图(走带停时也记着,起播时一并点亮)
  state: VoiceState;
  scheduledId?: number;
  startTime?: number;   // 真实起播上下文时刻(算 phase)
  loopDur?: number;
  pending?: Tone.Player; // 无缝换 buffer:已建好、等下一个小节边界接管的新 player
}

// 主峰值表弹道(见 masterLevel):窗口短 → 抓得到瞬态;归一窗收窄 → 短表条上动态可见;慢落 → 余辉而不闪。
const METER_FLOOR_DB = -48;   // 峰值表归一下限(dBFS):窗口 [-48,0] 铺满短表条,鼓点动态吃满量程
const PEAK_RELEASE = 0.88;    // 慢落系数(每 rAF 帧 ×0.88;~60fps 下视觉余辉约 300ms,落到 37% ≈130ms)
// 起播去咔哒(declick):播放器一次性淡入秒数(~3ms)。从静音瞬跳到 buffer[0](几乎从不为 0)= 宽带咔哒;
// Tone.Player.fadeIn 的语义是"start 时淡一次,loop 不重触发"→ 只磨掉这记起播阶跃,不碰每圈下拍的 attack(2-3ms 足够消阶跃又几乎不削瞬态)。
const DECLICK = 0.003;

export class StudioEngine {
  private voices = new Map<string, Voice>();
  private beatsPerBar = 4;
  private inited = false;
  private disposeTimers = new Set<ReturnType<typeof setTimeout>>(); // 无缝换 buffer 后延迟销毁旧 player 的墙钟定时器
  private retempoSchedId?: number; // 改速:排在下一小节边界的"翻速+换 buffer"协调点
  private retempoTarget?: number;  // 改速目标 BPM(边界前停走带也要把 transport 落到它,免重启后 buffer 与 transport 不匹配)
  private retempoBuilds?: Map<string, Promise<AudioBuffer | null>>; // 改速在渲的新 buffer;边界前停走带 → 由 stopTransport 就地兜底应用(否则只剩旧长度 buffer 配新速度 = drift)
  private retempoGen = 0; // 改速代号:停走带 / 新一次改速会 ++ 它,作废上一次还在渲、就绪后才补换的 swapBuffer(否则迟到的旧速 buffer 盖到新状态上=相位/速度错乱)
  private quantize: Quantize = '1bar';                              // 启停量化粒度(顶栏 Quantize 选择器);launch/stop/audition 用 nextBoundary 读它
  private soloIds = new Set<string>();                              // §18 独奏集(隔离式+多选,瞬态);仅经 setSolo 改 + clearAll 清;UI soloRef 是 authority
  private master?: Tone.Volume; private masterClip?: Tone.WaveShaper; // 主总线:汇总(FX链+节拍器)→ 主音量(master Volume)→ 软削波天花板(memoryless)→ destination
  private split?: Tone.Split; private analyserL?: Tone.Analyser; private analyserR?: Tone.Analyser; // 总输出 L/R 峰值表(抽 master = post-FX/post 主音量/pre-软削波;waveform analyser,masterLevel 自算 peak)
  private peakHold: [number, number] = [0, 0];                     // 峰值表弹道状态:快攻(瞬时跳上)慢落(每帧 ×PEAK_RELEASE),masterLevel 每帧推进一次
  private clickSynth?: Tone.Synth; private clickVol?: Tone.Volume;  // 节拍器:click synth → 音量节点 → master(随主音量+限制器,但不进 FX)
  private fx?: FxBus; private fxCfg?: FxConfig;                     // 主总线效果器(§17):各乐器 panner → fx.input → 失真→延迟→混响 → master;节拍器不进
  private xy?: XYPad;                                              // §21 XY 表演板:主总线 insert,串在 master 与软削波天花板之间(吃完整最终 mix)
  /** 离散态(voice off/queued/on/stopping、audition 起停)在**异步边界**跃迁时回调上层重渲;连续视觉(电平/播放头/走带位置)由 UI 叶子自驱动 rAF,不走这里。 */
  onChange?: () => void;
  private metroOn = false;
  private metroInterval: 'beat' | 'bar' | '2bar' | '4bar' = 'beat'; // 几小节响一次:每拍/每小节/每2小节/每4小节
  private metroRepeatId?: number; // 节拍器的 scheduleRepeat id —— 每次 startTransport 重注册(stopTransport 的 t.cancel() 会清掉它)
  private metroClock?: Tone.Clock; // 走带停时给自由跑的 clip 试听配的独立节拍器时钟(脱离 Transport,锚 auditionStart;走带在跑用上面的 scheduleRepeat,二者互斥)

  init(bpm: number, beatsPerBar = 4): void {
    this.beatsPerBar = beatsPerBar;
    Tone.getTransport().bpm.value = bpm;
    if (!this.inited) {
      // 主总线:所有声源(乐器 FX 链 + 节拍器)汇入 master(主音量)→ 软削波天花板 → destination。
      // 天花板是兜底:Suno loop 多是成品母带级、单条已贴近 0dBFS,数条 unity 叠加会越过 0dBFS,无它则终点硬削顶(方波失真)。
      // ⚠ 不用压缩器型限制器(Tone.Limiter/Compressor):它有 attack/release 时间常数,会对鼓点/loop 接缝的瞬态
      //   做"压下→弹回"的增益起伏 = 抽吸 click(走带满混音时每圈触发,单条预览电平低不触发 → 只在走带、每圈听到)。
      //   改用 **memoryless 软削波**(WaveShaper):无时间常数 → 物理上不可能抽吸/咔;阈下纯净直通,超阈 tanh 平滑饱和
      //   到天花板内(轻微谐波暖色,适合 lofi/hiphop),0dBFS 永不硬削。4× 过采样抗混叠。
      this.master = new Tone.Volume(0);
      this.masterClip = new Tone.WaveShaper(softClipCurve(0.72, 0.96)); // 阈 T=0.72(~-2.9dBFS)起软饱和;x=1 处实际输出≈0.92(~-0.7dBFS)=真实天花板(|x|>1 取曲线端点,永不到 0dBFS)
      this.masterClip.oversample = '4x';
      // §21 XY 表演板:主总线 insert 串在 master → 天花板 之间(吃干声 + 所有 FX return 湿声的最终和;电平表抽在 master=XY 前)。
      this.xy = new XYPad(bpm);
      this.master.connect(this.xy.input);
      this.xy.output.connect(this.masterClip);
      this.masterClip.toDestination();
      // 总输出 L/R 电平表:抽在 master(post-FX、post 主音量、pre-软削波)= 真实总线电平,
      // 能反映 delay/reverb 尾巴、失真、主音量与"逼近限制器"的过载(旧实现抽各 voice panner=pre-FX,测不到这些)。
      this.split = new Tone.Split();
      // 峰值表:waveform analyser(短窗 256 samples ≈5ms@48k)→ masterLevel 自算 peak=max|x|,而非 Tone.Meter 的 RMS。
      // RMS 把瞬态(鼓击)在窗口内一平均就抹平 → 表跟不动节拍;peak 每个鼓点都顶一下 = 真正"跟手"。
      this.analyserL = new Tone.Analyser('waveform', 256); this.analyserR = new Tone.Analyser('waveform', 256);
      this.master.connect(this.split);
      this.split.connect(this.analyserL, 0, 0);
      this.split.connect(this.analyserR, 1, 0);
      // 节拍器:click → 音量 → 软削波天花板(不经 master→XY:click 是监听辅助,不该被 XY 表演插入 brake/slicer/filter/delay 切改,也不进 FxBus 混响/失真;音量走独立 clickVol,不随主音量推子)。
      this.clickVol = new Tone.Volume(-8);
      this.clickVol.connect(this.masterClip);
      this.clickSynth = new Tone.Synth({ oscillator: { type: 'triangle' }, envelope: { attack: 0.001, decay: 0.045, sustain: 0, release: 0.02 } }).connect(this.clickVol);
      // 主总线效果器:乐器汇入 fx.input → 失真→延迟→混响 → master(节拍器不经此)。
      this.fx = new FxBus(bpm, this.master);
      if (this.fxCfg) this.fx.setAll(this.fxCfg);
      if (this.fxCfg?.xy) this.xy.setXy(this.fxCfg.xy); // §21:初始 XY 配置(program/wet/on)
      this.inited = true;
    }
  }

  /** 应用主总线效果器配置(§17)+ XY 表演板配置(§21:program/wet/on)。 */
  setFx(cfg: FxConfig): void { this.fxCfg = cfg; this.fx?.setAll(cfg); if (cfg.xy) this.xy?.setXy(cfg.xy); }

  // --- §21.v2 / §26.4 XY 多效果链:per-effect 瞬态驱动(coordinator 独占,不进 undo/不落库;对标 §18 Solo)---
  xySetValue(program: import('@/contracts').XYProgram, nx: number, ny: number, immediate = false): void { this.xy?.setValue(program, nx, ny, immediate); }
  xySetActive(program: import('@/contracts').XYProgram, active: boolean): void { this.xy?.setActive(program, active); }
  xyReleaseAll(): void { this.xy?.releaseAll(); }

  // --- 主输出:主音量(master Volume,在限制器之前) + L/R 峰值电平 ---
  setMasterVolume(db: number): void { if (this.master) this.master.volume.value = db; }
  // L/R 峰值电平 0..1(供顶栏电平表):从 waveform analyser 取窗口峰值 peak=max|x|,做快攻(瞬时跳上)慢落
  // (每帧 ×PEAK_RELEASE)弹道,再以 [METER_FLOOR_DB,0]dBFS 线性归一。⚠ 含状态推进,约定**每帧只调一次**
  // (顶栏唯一 MasterMeter 叶子,见 live.tsx)。改 RMS→peak:鼓点瞬态不再被窗口平均抹平,表跟得动节拍。
  masterLevel(): [number, number] {
    const ch = (a: Tone.Analyser | undefined, i: 0 | 1): number => {
      let peak = 0;
      if (a) { const buf = a.getValue() as Float32Array; for (let k = 0; k < buf.length; k++) { const x = Math.abs(buf[k]); if (x > peak) peak = x; } }
      const held = this.peakHold[i] = Math.max(peak, this.peakHold[i] * PEAK_RELEASE); // 攻=Math.max 瞬时,落=×release 衰减
      const db = held > 1e-5 ? 20 * Math.log10(held) : -Infinity;
      return isFinite(db) ? Math.max(0, Math.min(1, (db - METER_FLOOR_DB) / -METER_FLOOR_DB)) : 0;
    };
    return [ch(this.analyserL, 0), ch(this.analyserR, 1)];
  }

  // --- 节拍器 ---
  setQuantize(q: Quantize): void { this.quantize = q; }
  setMetronome(on: boolean): void {
    this.metroOn = on;
    // 走带停 + 有自由预览在响 → 预览中开/关节拍器即时跟上(走带在跑则由 scheduleRepeat 那条覆盖,这里不掺和)。
    if (Tone.getTransport().state !== 'started' && this.auditionPlayer && !this.auditionQueued) { if (on) this.startAuditionMetro(); else this.stopAuditionMetro(); }
  }
  // 每次起播重挂节拍器节拍回调(stopTransport 的 t.cancel() 会把它清掉,故不能只在 init 注册一次)。
  private scheduleMetro(): void {
    const t = Tone.getTransport();
    if (this.metroRepeatId != null) { try { t.clear(this.metroRepeatId); } catch { /* */ } }
    this.metroRepeatId = t.scheduleRepeat((time) => this.onClick(time), '4n', 0);
  }
  setMetronomeVolume(db: number): void { if (this.clickVol) this.clickVol.volume.value = db; }
  setMetronomeInterval(iv: 'beat' | 'bar' | '2bar' | '4bar'): void { this.metroInterval = iv; }
  // 给定绝对拍号 → 按 interval/重音决定这一拍是否响、响哪个音(走带节拍器与试听节拍器共用,避免两份 interval 逻辑漂移)。
  private clickForBeat(beats: number): { play: boolean; note: 'C6' | 'C5' } {
    const beatInBar = ((beats % this.beatsPerBar) + this.beatsPerBar) % this.beatsPerBar;
    const barIdx = Math.floor(beats / this.beatsPerBar);
    const down = beatInBar === 0;
    const play = this.metroInterval === 'beat' ? true : this.metroInterval === 'bar' ? down : this.metroInterval === '2bar' ? down && barIdx % 2 === 0 : down && barIdx % 4 === 0;
    return { play, note: down ? 'C6' : 'C5' };
  }
  private onClick(time: number): void {
    if (!this.metroOn || !this.clickSynth) return;
    const t = Tone.getTransport();
    const { play, note } = this.clickForBeat(Math.round(t.getTicksAtTime(time) / t.PPQ));
    if (play) this.clickSynth.triggerAttackRelease(note, '32n', time);
  }
  // §节拍器·试听:走带停时给自由跑的预览配一条独立 click 时钟(Transport 冻结,scheduleRepeat 不 fire)。
  // 网格按 master bpm,锚回 auditionStart 的 phase-0(整小节 loop 的下拍 = 重音);带 startPhase 偏移时只打未来的格点。
  private startAuditionMetro(): void {
    this.stopAuditionMetro();
    if (!this.metroOn || !this.clickSynth || this.auditionDur <= 0) return;
    const beatDur = 60 / Tone.getTransport().bpm.value; // buffer warp 到 master bpm,故一拍 = 60/bpm 秒
    if (!(beatDur > 0) || !isFinite(beatDur)) return;
    let n = Math.max(0, Math.ceil((Tone.now() - this.auditionStart - 1e-4) / beatDur)); // 只 fire 未来拍,锚 phase-0
    const first = this.auditionStart + n * beatDur;
    const clk = new Tone.Clock((time) => {
      if (!this.clickSynth) return;
      const { play, note } = this.clickForBeat(n); n++;
      if (play) this.clickSynth.triggerAttackRelease(note, '32n', time);
    }, 1 / beatDur);
    clk.start(Math.max(Tone.now(), first));
    this.metroClock = clk;
  }
  private stopAuditionMetro(): void { if (this.metroClock) { try { this.metroClock.stop(); this.metroClock.dispose(); } catch { /* */ } this.metroClock = undefined; } }
  async resume(): Promise<void> { await Tone.start(); }
  /** §31 把整条出声链路由到指定输出设备。全应用只有 Tone 这一个 context 真驱动扬声器(解码/离线 ctx 不出声),
   *  故只切它即全局生效。deviceId='default' → setSinkId('') = 跟随系统默认;Safari/Firefox 无 setSinkId → 静默走默认。 */
  async setOutputDevice(deviceId: string): Promise<void> {
    const raw = Tone.getContext().rawContext as AudioContext & { setSinkId?: (id: string) => Promise<void> };
    if (typeof raw.setSinkId !== 'function') return;
    await raw.setSinkId(deviceId === 'default' ? '' : deviceId);
  }
  /** 改主 BPM:主走带 transport 立即跟随(buffer 的 re-warp/热替换由上层逐乐器做)。 */
  setBpm(bpm: number): void { Tone.getTransport().bpm.value = bpm; this.fx?.setBpm(bpm); this.xy?.setBpm(bpm); if (this.metroClock) this.startAuditionMetro(); /* 预览中改速 → 按新速重锚试听节拍器(buffer re-warp 由上层做) */ }

  isPlaying(): boolean { return Tone.getTransport().state === 'started'; }
  transportBeats(): number { const t = Tone.getTransport(); return t.ticks / t.PPQ; }
  barBeat(): { bar: number; beat: number; sixteenth: number } {
    const [b, be, si] = String(Tone.getTransport().position).split(':');
    return { bar: parseInt(b, 10) + 1, beat: Math.floor(parseFloat(be)) + 1, sixteenth: Math.floor(parseFloat(si)) + 1 };
  }
  voiceState(id: string): VoiceState { return this.voices.get(id)?.state ?? 'off'; }
  voicePhase(id: string): number | null {
    const v = this.voices.get(id);
    if (!v || (v.state !== 'on' && v.state !== 'stopping') || v.startTime == null || !v.loopDur) return null; // on 与 stopping 都在出声
    const el = Tone.now() - v.startTime;
    return el <= 0 ? 0 : (el % v.loopDur) / v.loopDur;
  }

  /** 建一段三段串联 EQ(low shelf / mid peaking / high shelf,各一颗 biquad,gain 单位 dB,初值 0)。频点来自 EQ_BANDS,与 realLibrary 离线 bake 共用一组。
   *  shelf 只吃 gain(Web Audio 的 shelf 忽略 Q,斜率固定);只有 mid peaking 用 Q(0.7=约 2 个八度宽钟形,当 tone 控不当手术刀)。每颗 0dB 时透明 → 0/0/0 不染色。 */
  private makeEq(): ShelfEq { return makeShelfEq(); } // §32:构造移到 masterChain,与离线导出共用

  /** 装载/替换一件乐器的可播放 buffer + mixer 链 + 3 条 aux send。 */
  loadInstrument(id: string, buffer: AudioBuffer, bars: number, mixer: Mixer, sends?: InstrumentSends): void {
    this.clearInstrument(id);
    const player = new Tone.Player(buffer);
    player.loop = true;
    player.loopStart = 0;
    player.loopEnd = buffer.duration;
    player.fadeIn = DECLICK; // 起播去咔哒(一次性,loop 不重触发)
    const eq = this.makeEq();
    const muteGain = new Tone.Gain(1); // §18 solo 遮罩(audible?1:0);在 sends 分叉前 → 静音连干声带 FX send 一起灭
    const panner = new Tone.Panner(0);
    player.chain(eq.low, eq.mid, eq.high, muteGain, panner, this.master ?? Tone.getDestination()); // low→mid→high→muteGain→panner→master(干声,随主音量+限制器)
    // aux send(§17):post-panner 旁路进 3 个共享 fx return,各自一个量;送量 0 = 不出。
    const sendDist = new Tone.Gain(0), sendDelay = new Tone.Gain(0), sendReverb = new Tone.Gain(0);
    if (this.fx) {
      panner.connect(sendDist); sendDist.connect(this.fx.distInput);
      panner.connect(sendDelay); sendDelay.connect(this.fx.delayInput);
      panner.connect(sendReverb); sendReverb.connect(this.fx.reverbInput);
    }
    const meter = new Tone.Meter();
    panner.connect(meter); // 旁路抽头(pre-FX),只给本乐器 mixer 电平表;主 L/R 表抽在 master(见 init)= 真实总线,不再逐 panner 并联(那样会与 master 双计)
    const v: Voice = { player, eq, muteGain, panner, sendDist, sendDelay, sendReverb, meter, bars, mixer, wantOn: false, state: 'off' };
    this.voices.set(id, v);
    this.applyMixer(v, mixer);
    if (sends) this.applySends(v, sends);
  }

  hasVoice(id: string): boolean { return this.voices.has(id); }

  /** 无缝替换乐器 buffer(改 trim/变调/bake 后用):正在出声 → 建第二个 player,在下一个小节边界**保相位接管**
   *  (新 buffer 从旧 loop 当前相位接着放,不跳回从头)+ 交叉淡化防爆音;没在出声 → 就地换 buffer。 */
  swapBuffer(id: string, buffer: AudioBuffer, bars: number): void {
    const v = this.voices.get(id);
    if (!v) return;
    v.bars = bars;
    if (this.auditionId === id) this.auditionSwap(id, buffer, { mixer: v.mixer, sends: this.voiceSends(v) }); // 预览(audition)正放这件乐器(走带停时常态)→ 同步无缝换上新 buffer(走 auditionChain,绕开 muteGain,保留 mixer + send→FX),否则改 trim/长度只动画不出声
    this.cancelPending(v);
    const t = Tone.getTransport();
    if (t.state === 'started' && v.state === 'on' && !v.player.disposed) {
      const XF = 0.012; // 交叉淡化秒数(防接缝爆音)
      const np = new Tone.Player(buffer);
      np.loop = true; np.loopStart = 0; np.loopEnd = buffer.duration;
      np.fadeIn = XF; // 接管时淡入,和旧的淡出对冲
      np.connect(v.eq.low);
      v.pending = np;
      const old = v.player;
      this.clearScheduled(v);
      v.scheduledId = t.scheduleOnce((time) => {
        v.scheduledId = undefined;
        if (np.disposed) return;
        np.volume.value = old.volume.value; // 接管时取最新增益(切换窗口内改过的 gain 不丢)
        // 保相位:用旧 loop 此刻相位算新 buffer 的起播偏移 → 不从头跳回,groove 不重置
        const oldDur = v.loopDur && v.loopDur > 0 ? v.loopDur : buffer.duration;
        const oldStart = v.startTime ?? time;
        const elapsed = (((time - oldStart) % oldDur) + oldDur) % oldDur;
        const offset = (elapsed / oldDur) * buffer.duration;
        old.fadeOut = XF;          // 旧的淡出
        np.start(time, offset);    // 新的从同相位淡入接上
        try { old.stop(time); } catch { /* */ }
        v.player = np; v.pending = undefined;
        v.startTime = time - offset; // 虚拟相位起点 → voicePhase / 播放线连续
        v.loopDur = buffer.duration;
        const delayMs = Math.max(0, (time - Tone.now()) * 1000) + XF * 1000 + 300; // 淡出走完再销毁
        const tid = setTimeout(() => { this.disposeTimers.delete(tid); try { old.dispose(); } catch { /* */ } }, delayMs);
        this.disposeTimers.add(tid);
      }, this.nextBoundary());
      return;
    }
    // 没在出声:就地换(排队中的 fire 会自然用到新 buffer;顺带复位可能残留的顶速)
    this.replaceBufferInPlace(v, buffer);
  }
  private cancelPending(v: Voice): void {
    if (v.pending) { try { v.pending.dispose(); } catch { /* */ } v.pending = undefined; }
  }

  /** 改主 BPM(走带在跑)—— §6 的"可选无缝过渡":
   *  ① 保持旧 buffer + 旧速度播到**下一个小节边界 B**(其间不动 transport,旧声与旧网格仍对齐、无 drift),同时后台离线 re-warp 全部乐器;
   *  ② 到 B:transport 翻新速 + 各乐器**同一边界**保相位换上新 buffer(众声同时换→不错拍);
   *  ③ B 时某乐器的 HQ buffer 还没渲完 → 先用 `playbackRate` 顶速(tape pitch、即时跟拍、保持与别的声对齐),其 HQ buffer 就绪后在循环边界补换、复位 rate。
   *  没在出声的 voice 在边界后就地换 buffer(被启用时即正确长度)。getBuffer(id) 由上层按新 bpm 离线渲染该乐器。 */
  retempoPlaying(newBpm: number, getBuffer: (id: string) => Promise<AudioBuffer | null>): void {
    const t = Tone.getTransport();
    const oldBpm = t.bpm.value;
    if (oldBpm === newBpm) return;
    const gen = ++this.retempoGen; // 本次改速代号:迟到的就绪回调据此判断是否已被新改速 / 停走带作废
    // 立刻启动所有 re-warp;记录就绪结果(到边界时已渲完的直接换、没渲完的顶速桥接)。
    const builds = new Map<string, Promise<AudioBuffer | null>>();
    const ready = new Map<string, AudioBuffer | null>();
    this.voices.forEach((_, id) => { const p = getBuffer(id).catch(() => null); builds.set(id, p); p.then((b) => ready.set(id, b ?? null)); });
    this.retempoBuilds = builds; // 边界前停走带的兜底应用句柄(边界真正触发时清掉,改由边界回调负责应用)
    if (t.state !== 'started') { // 没在跑:直接翻速 + 渲好就地换(防御;正常由上层 isPlaying 分流)
      t.bpm.value = newBpm; this.fx?.setBpm(newBpm); this.xy?.setBpm(newBpm);
      this.retempoBuilds = undefined; // 本分支自行应用,不留给 stopTransport
      this.voices.forEach((v, id) => builds.get(id)?.then((b) => { if (b && gen === this.retempoGen) this.replaceBufferInPlace(v, b); }));
      return;
    }
    const ratio = newBpm / oldBpm;
    const XF = 0.012;
    if (this.retempoSchedId != null) { t.clear(this.retempoSchedId); this.retempoSchedId = undefined; } // 作废上一次还没到的改速
    this.retempoTarget = newBpm;
    this.retempoSchedId = t.scheduleOnce((time) => {
      this.retempoSchedId = undefined; this.retempoTarget = undefined; // 边界已触发,应用归本回调
      t.bpm.value = newBpm; this.fx?.setBpm(newBpm); this.xy?.setBpm(newBpm); // B 处翻新速(此前老 buffer 老速正常播,无 drift)
      const bridge = new Map<string, Promise<AudioBuffer | null>>(); // 边界时仍未渲完(顶速桥接 / off 未渲)的 voice → 留住其 build 句柄,供 stopTransport 兜底就地换;否则桥接中途停走带 → 残留旧长 buffer 配新速度 = 漂移
      for (const [id, v] of this.voices) {
        if (v.state !== 'on' || v.player.disposed) continue;
        const oldDur = (v.loopDur && v.loopDur > 0) ? v.loopDur : v.player.buffer.duration;
        const elapsed = v.startTime != null ? (((time - v.startTime) % oldDur) + oldDur) % oldDur : 0;
        const phase = oldDur > 0 ? elapsed / oldDur : 0; // 该乐器循环内相位(B 是小节边界→相位对齐网格)
        const buf = ready.get(id);
        if (buf) {
          this.crossfadeAt(v, buf, time, phase * buf.duration, XF); // 已渲完:B 处保相位无缝换(不顶速、不变调)
        } else {
          v.player.playbackRate = ratio; // 没渲完:顶速跟拍(tape pitch);相位时钟改用有效周期
          const effDur = oldDur / ratio;
          v.startTime = time - phase * effDur;
          v.loopDur = effDur;
          const p = builds.get(id);
          if (p) { bridge.set(id, p); p.then((b) => { if (b && gen === this.retempoGen) this.swapBuffer(id, b, v.bars); }); } // 就绪后在循环边界补换;期间又改速/停走带(gen 变)则丢弃这迟到的旧速 buffer(swapBuffer 建新 player→自动复位 rate)
        }
      }
      this.voices.forEach((v, id) => { if (v.state !== 'on') { const p = builds.get(id); if (!p) return; if (!ready.has(id)) bridge.set(id, p); p.then((b) => { if (b && gen === this.retempoGen) this.replaceBufferInPlace(v, b); }); } }); // 没出声的:就地换(gen 变则丢弃迟到 buffer);未渲完的也登记进 bridge,停走带兜底
      this.retempoBuilds = bridge.size ? bridge : undefined; // 仍有未渲完桥接 → 留给 stopTransport 兜底;全渲完则清空(普通停走带不再多做)
    }, this.nextBoundary());
  }
  /** 就地把 voice 的 buffer 换成新的(没在出声时用):复位顶速、对齐 loop 点。 */
  private replaceBufferInPlace(v: Voice, buffer: AudioBuffer): void {
    if (v.player.disposed) return;
    try { v.player.playbackRate = 1; } catch { /* */ }
    try { v.player.buffer.set(buffer); } catch { /* */ }
    v.player.loopEnd = buffer.duration;
    v.loopDur = buffer.duration;
  }
  /** 在给定上下文时刻 time 保相位无缝换 buffer(交叉淡化防爆音);更新相位参考、延迟销毁旧 player。 */
  private crossfadeAt(v: Voice, buffer: AudioBuffer, time: number, offset: number, XF: number): void {
    const np = new Tone.Player(buffer);
    np.loop = true; np.loopStart = 0; np.loopEnd = buffer.duration; np.fadeIn = XF;
    np.connect(v.eq.low);
    np.volume.value = v.player.volume.value;
    const old = v.player;
    old.fadeOut = XF;
    np.start(time, Math.max(0, Math.min(buffer.duration - 1e-4, offset)));
    try { old.stop(time); } catch { /* */ }
    v.player = np; v.pending = undefined;
    v.startTime = time - offset; v.loopDur = buffer.duration;
    const delayMs = Math.max(0, (time - Tone.now()) * 1000) + XF * 1000 + 300;
    const tid = setTimeout(() => { this.disposeTimers.delete(tid); try { old.dispose(); } catch { /* */ } }, delayMs);
    this.disposeTimers.add(tid);
  }
  /** voice 输出电平 0..1(-48dB..0dB 归一);没在响→0。 */
  voiceLevel(id: string): number {
    const v = this.voices.get(id);
    if (!v || (v.state !== 'on' && v.state !== 'stopping')) return 0; // stopping(量化停止前那一小节)仍在出声 → 电平表别提前熄灭(与 voicePhase 口径一致)
    const raw = v.meter.getValue();
    const db = typeof raw === 'number' ? raw : raw[0];
    if (!isFinite(db)) return 0;
    return Math.max(0, Math.min(1, (db + 48) / 48));
  }
  setMixer(id: string, mixer: Mixer): void {
    const v = this.voices.get(id);
    if (v) this.applyMixer(v, mixer);
    // 预览中拖 mixer → 即时跟手:gain 直接补到 audition player;eq/pan 经 setAuditionMix 刷到预览专用的 audEq/audPan 链
    // (§34 预览不再走 voice 的共享节点 v.eq/v.panner,故这里不能只靠 applyMixer;裸链试听时 setAuditionMix 自身 gate 掉)。
    if (this.auditionId === id) { if (this.auditionPlayer) this.auditionPlayer.volume.value = mixer.gainDb; this.setAuditionMix(mixer); }
  }
  private applyMixer(v: Voice, m: Mixer): void {
    v.mixer = m; // §34 存最新 mixer 快照(clip 预览走 auditionChain 用,见 previewInstrument)
    v.player.volume.value = m.gainDb;
    v.panner.pan.value = Math.max(-1, Math.min(1, m.pan));
    v.eq.low.gain.value = m.eq.lowDb;
    v.eq.mid.gain.value = m.eq.midDb;
    v.eq.high.gain.value = m.eq.highDb;
  }
  /** 改一件乐器的 3 条 aux send 量(§17)。 */
  setSends(id: string, sends: InstrumentSends): void { const v = this.voices.get(id); if (v) this.applySends(v, sends); if (this.auditionId === id) this.applyAuditionSends(sends); } // 预览中拖 send 旋钮 → 即时跟手刷预览 aux send(乐器整体预览,audSendX 已随 auditionChain 建好)
  private applySends(v: Voice, s: InstrumentSends): void {
    const c = (x: number) => Math.max(0, Math.min(1, Number.isFinite(x) ? x : 0));
    v.sendDist.gain.value = c(s.dist);
    v.sendDelay.gain.value = c(s.delay);
    v.sendReverb.gain.value = c(s.reverb);
  }

  clearInstrument(id: string): void {
    const v = this.voices.get(id);
    if (!v) return;
    this.cancelPending(v);
    this.clearScheduled(v);
    v.player.stop();
    v.player.dispose();
    v.eq.low.dispose();
    v.eq.mid.dispose();
    v.eq.high.dispose();
    v.muteGain.dispose();
    v.panner.dispose();
    v.sendDist.dispose(); v.sendDelay.dispose(); v.sendReverb.dispose();
    v.meter.dispose();
    this.voices.delete(id);
  }
  clearAll(): void {
    [...this.voices.keys()].forEach((id) => this.clearInstrument(id));
    this.soloIds.clear(); // §18:无 voice = 无 solo(切 session / undo 重灌时自然清掉,UI 侧也 clearSolo 保持同步)
  }
  /** 只保留 ids 对应的 voice、其余全部释放。§20 Live (重)起播前剔掉被打断的换场残留:
   *  快速连切会把"没提交的目标场"预载进引擎(armed,wantOn=true,只是没到边界没出声),stopTransport 不清它们;
   *  若不剔,startTransport 会把所有 armed voice 一并点响 = 多场景叠加 / 听到的不是当前选中场景。
   *  比 clearAll+loadSession 省:当前场 voice 已在引擎里,无需重建,瞬时。 */
  retainOnly(ids: string[]): void {
    const keep = new Set(ids);
    for (const id of [...this.voices.keys()]) if (!keep.has(id)) this.clearInstrument(id);
  }

  // --- 开关(enabled)+ 独奏(solo,§18)。可听性 = solo 遮罩后的最终结果。 ---
  private soloActive(): boolean { return this.soloIds.size > 0; }
  /** 该乐器是否可听(solo 遮罩后):有 solo → 只听被 solo 的;无 solo → 听所有 armed。 */
  private isAudible(id: string, v: Voice): boolean { return this.soloActive() ? this.soloIds.has(id) : v.wantOn; }
  /** 该乐器 player 是否该在跑:armed,或被 solo 强行点起(隔离一个 ▶ 关着的乐器)。 */
  private shouldRun(id: string, v: Voice): boolean { return v.wantOn || this.soloIds.has(id); }

  /** 开关:只改播放意图 wantOn,再让 reconcile 按 solo 算最终的"跑/听"。 */
  setEnabled(id: string, on: boolean): void {
    const v = this.voices.get(id);
    if (!v) return;
    v.wantOn = on;
    this.reconcileVoice(id, v);
  }

  /** 设置独奏集(§18,隔离式 + 多选):替换 soloIds 后重算所有 voice 的"跑 + 听"。 */
  setSolo(ids: Iterable<string>): void {
    this.soloIds = new Set(ids);
    this.voices.forEach((v, id) => this.reconcileForSolo(id, v));
  }

  /** 设 muteGain 遮罩到可听性:已出声(on/stopping)→ 15ms 斜坡(solo/静音切换防 click,保相位);
   *  尚未出声(off/queued,即将 fire)→ 直接置值,免那条斜坡骑在首拍 attack 上把它削弱(起播去咔哒由 player.fadeIn 负责)。 */
  private applyMute(id: string, v: Voice): void {
    const target = this.isAudible(id, v) ? 1 : 0;
    if (v.state === 'on' || v.state === 'stopping') v.muteGain.gain.rampTo(target, 0.015);
    else v.muteGain.gain.value = target;
  }

  /** 按当前 wantOn + soloIds 重算单个 voice:muteGain 遮罩(即时、保相位)+ player 跑/停(量化)。 */
  private reconcileVoice(id: string, v: Voice): void {
    this.applyMute(id, v); // 遮罩跟随(出声中走斜坡;未出声直接置,见 applyMute)
    this.setRunning(v, this.shouldRun(id, v));
  }

  /** §20 solo 专用重算:遮罩照常,但只对"已在跑 / 被显式 solo 点起"的 voice 动 player 起停。
   *  走带在跑时引擎里除了当前出声块,还驻着下一块的 lookahead 预载 voice(state=off、wantOn=enabled)。
   *  若用通用 reconcileVoice(shouldRun=wantOn||solo),会把这些 off 预载 voice 在边界点响 = 别块声音泄漏 ——
   *  连正常 solo/取消 solo 当前块都会触发(setSolo 重算的是全引擎,不分块)。这里加 running||soloed 闸:
   *  预载/未被 solo 的 off voice 一律不碰(留给换场边界 swapVoicesAt 起);solo 显式点起一件关着的乐器(§18)仍生效。 */
  private reconcileForSolo(id: string, v: Voice): void {
    this.applyMute(id, v); // 出声中(solo 常态)走斜坡防 click;未出声的预载 voice 直接置(不会被下面 setRunning 点起)
    const running = v.state === 'on' || v.state === 'queued' || v.state === 'stopping';
    if (running || this.soloIds.has(id)) this.setRunning(v, this.shouldRun(id, v));
  }

  /** player 跑/停:走带在跑→量化进/出(UI 等边界);没起走带→只记意图、不出声。
   *  原 setEnabled 的启停逻辑抽到这里,键于 run(=wantOn||solo)而非 enabled —— solo 能点起 ▶ 关着的乐器。 */
  private setRunning(v: Voice, run: boolean): void {
    // ⚠ 不在此无条件 cancelPending:跑/停状态没真变(如已在响时 solo/enable 反复点)时打断在途换 buffer,
    //   会把刚改好的 trim/变调新 buffer 丢掉、继续放旧声(画面=新、声音=旧)。只在真要重排 player 起停的分支才 cancel。
    const t = Tone.getTransport();
    if (t.state !== 'started') {
      // 没总走带:不出声。播放态只记在 wantOn(UI 用 enabled 体现);按总播放才一起响。
      this.cancelPending(v);
      this.clearScheduled(v);
      v.player.stop();
      v.state = 'off';
      return;
    }
    if (run) {
      if (v.state === 'on' || v.state === 'queued') return; // 已在响 / 已排队 → 不重排(保留在途换 buffer)
      this.cancelPending(v);
      this.clearScheduled(v);
      v.state = 'queued';
      v.scheduledId = t.scheduleOnce((time) => { v.scheduledId = undefined; this.fire(v, time); v.state = 'on'; this.onChange?.(); }, this.nextBoundary()); // 边界:queued→on,通知上层(呼吸 className 收掉)
    } else {
      if (v.state === 'off' || v.state === 'stopping') return; // 已停 / 已在停途中 → 不重排
      this.cancelPending(v);
      this.clearScheduled(v);
      if (v.state === 'queued') { v.state = 'off'; return; } // 还没出声 → 直接取消
      v.state = 'stopping';
      v.scheduledId = t.scheduleOnce((time) => { v.scheduledId = undefined; v.player.stop(time); v.state = 'off'; this.onChange?.(); }, this.nextBoundary()); // 边界:stopping→off
    }
  }

  startTransport(): void {
    this.stopAudition(); // 走带一开就停掉预览(预览只在走带停时用)
    const t = Tone.getTransport();
    this.scheduleMetro(); // 重挂节拍器(上次 stop 的 t.cancel() 清掉了)
    t.start();
    this.voices.forEach((v, id) => {
      if (this.shouldRun(id, v)) { this.fire(v, Tone.now()); v.state = 'on'; } else v.state = 'off'; // §18:armed 或被 solo 点起的都起声
      v.muteGain.gain.value = this.isAudible(id, v) ? 1 : 0; // 起播即按 solo 置遮罩(瞬时,非斜坡)
    });
  }
  stopTransport(): void {
    const t = Tone.getTransport();
    // 改速边界前停(retempoTarget 还在)→ 把 transport 落到目标速;边界后停(顶速桥接中)→ target 已清、bpm 已是新速。scheduleOnce 由下面 t.cancel() 清掉。
    if (this.retempoTarget != null) { t.bpm.value = this.retempoTarget; this.fx?.setBpm(this.retempoTarget); this.xy?.setBpm(this.retempoTarget); }
    // 把在渲/桥接的新 buffer 就地兜底换上(否则重启后旧长度 buffer 配新速度 = drift):边界前停=全部在渲;边界后停=retempoBuilds 只剩顶速桥接那几个。
    const pendingBuilds = this.retempoBuilds;
    this.retempoSchedId = undefined; this.retempoTarget = undefined; this.retempoBuilds = undefined;
    const g = ++this.retempoGen; // 停走带代号:作废边界回调里"就绪后补换"的迟到 swapBuffer;下面兜底的 replaceBufferInPlace 也据此判废(之后再改速会 ++,让这批迟到 buffer 失效)
    if (pendingBuilds) { for (const [id, p] of pendingBuilds) p.then((b) => { if (this.retempoGen !== g) return; const v = this.voices.get(id); if (v && b) this.replaceBufferInPlace(v, b); }); }
    t.stop();
    t.cancel();
    this.voices.forEach((v) => {
      this.cancelPending(v);
      v.scheduledId = undefined;
      try { v.player.playbackRate = 1; } catch { /* */ } // 清掉可能残留的顶速桥接
      v.player.stop();
      v.muteGain.gain.value = 1; // §18:走带停 → 解除 solo 遮罩(预览/audition 走同一链,不该被静音);下次起播 startTransport 再按 solo 重置
      v.state = 'off'; // 停走带=都不出声(state 只管出声);播放态保留在 wantOn,UI 仍显示激活
      v.startTime = undefined;
    });
  }

  // --- §20 会话量化换场原语(Live 切换 / Song 线性共用)---
  /** 只记播放意图、不调度 —— 预载非活动场景的 voice 用(到边界/块头再由 swapVoicesAt 起声)。 */
  setWantOn(id: string, on: boolean): void { const v = this.voices.get(id); if (v) v.wantOn = on; }
  /** 在给定上下文时刻 time:停 stopIds、起 startIds 中该响的 voice(保相位,不再二次量化)= 换场的实际动作。 */
  swapVoicesAt(stopIds: string[], startIds: string[], time: number): void {
    for (const id of stopIds) { const v = this.voices.get(id); if (!v) continue; this.cancelPending(v); this.clearScheduled(v); try { v.player.stop(time); } catch { /* */ } v.state = 'off'; v.startTime = undefined; }
    for (const id of startIds) { const v = this.voices.get(id); if (!v || !this.shouldRun(id, v)) continue; this.clearScheduled(v); this.fire(v, time); v.state = 'on'; v.muteGain.gain.value = this.isAudible(id, v) ? 1 : 0; }
    this.onChange?.();
  }
  /** 换场 + **延迟**释放旧场 voice。swapVoicesAt 已把旧 voice 排成在 time 停;真正销毁必须等过了 time 再做 ——
   *  否则同步 clearInstrument 里的 player.stop()(立即停)会顶掉 stop(time),把旧场尾音切早约一个 lookahead(~100ms),
   *  而新场是 fire(time) 准点起 → 听感 = 每次换场中间一段静音/咔。释放走 disposeTimers(随引擎销毁清理),口径不变(过了边界即只剩新场常驻)。 */
  swapAndRelease(stopIds: string[], startIds: string[], time: number): void {
    this.swapVoicesAt(stopIds, startIds, time);
    // 捕获此刻要释放的 voice 引用:同时又要起的(stop∩start,如 A→B→A 抢回当前场)不释放;延迟到边界后再销毁。
    const startSet = new Set(startIds);
    const captured = stopIds.filter((id) => !startSet.has(id)).map((id) => ({ id, v: this.voices.get(id) }));
    const delayMs = Math.max(0, (time - Tone.now()) * 1000) + 80; // 过了边界(+安全余量)再销毁,确保 stop(time) 已执行
    const tid = setTimeout(() => {
      this.disposeTimers.delete(tid);
      for (const { id, v } of captured) if (v && this.voices.get(id) === v) this.clearInstrument(id); // 仍是同一 voice 才释放(被后续换场重建过 → 交给新主,别误销)
    }, delayMs);
    this.disposeTimers.add(tid);
  }
  /** 在下一量化边界做一次性回调(Live 量化换场:边界到了再停旧起新 + 翻 UI)。返回句柄。 */
  swapAtBoundary(cb: (time: number) => void): number { return Tone.getTransport().scheduleOnce((time) => { cb(time); this.onChange?.(); }, this.nextBoundary()); }
  /** 在指定 transport 位置(Bars:Beats:Sixteenths)做一次性回调(Song 线性:块末推进)。返回句柄。 */
  scheduleAt(position: string, cb: (time: number) => void): number { return Tone.getTransport().scheduleOnce((time) => { cb(time); this.onChange?.(); }, position); }
  /** 取消一个 scheduleOnce 句柄(Song 切歌/停播时撤销待推进)。 */
  clearSched(id: number): void { try { Tone.getTransport().clear(id); } catch { /* */ } }
  /** 设置走带位置(Song 起播归零给干净播放头)。 */
  setTransportPosition(pos: string): void { Tone.getTransport().position = pos; }
  /** 当前走带整小节序号(Song 块头定位 / 中途跳块)。 */
  currentBar(): number { return parseInt(String(Tone.getTransport().position).split(':')[0], 10) || 0; }
  /** 当前走带位置(分数小节,Song 时间轴播放头平滑用)。 */
  songPosBars(): number { const t = Tone.getTransport(); return t.ticks / (t.PPQ * this.beatsPerBar); }

  // --- 试听:独立预览 player(不挂主走带);库素材 + 乐器预览共用。可量化:走带在跑时排到下一小节边界再起(等待期 queued=true,UI 呼吸)---
  private auditionPlayer: Tone.Player | null = null;
  private auditionId: string | null = null;
  private auditionStart = 0;
  private auditionDur = 0;
  private auditionQueued = false;        // 量化预览:已排队、等小节边界(还没出声)
  private auditionSchedId?: number;       // 排队的 scheduleOnce id
  private auditionGen = 0;                 // §28.7 异步预览防陈旧令牌:每次 stopAudition 自增 → 作废 await 窗口里 in-flight 的预览(stop/新预览顶掉迟到的 audition)
  private auditionPendingTok = 0;          // §28.7 当前"加载中"预览的令牌(还在 warp、未出声);供空格识别 warm-up 窗口先停、不误启走带。0=无
  private auditionFading = new Set<Tone.Player>(); // §28.8 auditionSwap 淡出中的旧 player(在未来 loop boundary 才停)。⚠ 长 loop 的 boundary 可能在很久之后 → 必须能被 stopAudition 立即灭掉,否则旧 player 漏播 = "停不下来"
  private audEq?: ShelfEq;               // collage 片 / 乐器整体预览的常驻 mixer 链(low/mid/high → panner → master,频点同 EQ_BANDS/离线 bake);懒建复用、随实例销毁
  private audPan?: Tone.Panner;
  private audSendDist?: Tone.Gain; private audSendDelay?: Tone.Gain; private audSendReverb?: Tone.Gain; // §17 预览 aux send:镜像 voice 的 sends(audPan 旁路进 fx return),让带 send 的乐器整体预览也出 FX(听感对齐走带);piece/库预览送量=0=纯干声
  private auditionUsesChain = false;     // 当前试听是否走 audEq 片链(走才允许 setAuditionMix 实时改;区别于库素材裸链 / 乐器共享 eq 链)
  // through 给定 → 预览带上 mixer:
  //   {eq,gainDb} = 走某乐器的共享 mixer 节点链(eq→panner→dest),听感与走带出声一致(乐器预览);
  //   {mixer,sends?} = collage 片 / 乐器整体:按片/乐器自己的 gain/pan/3 段 EQ 现搭一条常驻链(audEq→audPan→master),
  //                    给了 sends(乐器整体预览)则 audPan 旁路进 3 条 fx send → 预览也出 FX,与走带一致;不给(片预览)=纯干声。
  // 不给(库素材裸试听,没有乐器 mixer)→ 直连 destination。
  // quantize 且走带在跑 → 排到下一小节边界再起(跟随 bar);否则立即自由循环。
  audition(id: string, buffer: AudioBuffer, through?: { eq: ShelfEq; gainDb: number } | { mixer: Mixer; sends?: InstrumentSends }, quantize = false, startSec = 0): void {
    this.stopAudition();
    const p = new Tone.Player(buffer);
    p.fadeIn = DECLICK; // 试听同样起播去咔哒(预览路径自身淡入兜底)
    if (through && 'mixer' in through) { p.volume.value = through.mixer.gainDb; p.connect(this.auditionChain(through.mixer)); this.applyAuditionSends(through.sends); this.auditionUsesChain = true; }
    else if (through) { p.volume.value = through.gainDb; p.connect(through.eq.low); this.auditionUsesChain = false; }
    else { p.toDestination(); this.auditionUsesChain = false; }
    p.loop = true;
    this.auditionPlayer = p;
    this.auditionId = id;
    this.auditionDur = buffer.duration;
    const off = Math.max(0, Math.min(startSec, buffer.duration - 1e-3)); // §28 从起播线偏移入点(夹防越界);auditionStart 反推偏移 → 播放线相位正确
    const t = Tone.getTransport();
    if (quantize && t.state === 'started') {
      this.auditionQueued = true;
      this.auditionStart = 0; // 等边界期间没起播,phase=null(UI 呼吸)
      this.auditionSchedId = t.scheduleOnce((time) => {
        this.auditionSchedId = undefined;
        if (p.disposed) return;
        p.start(time, off);
        this.auditionStart = time - off;
        this.auditionQueued = false;
        this.onChange?.(); // 边界:预览 queued→playing,通知上层(波形呼吸收掉)
      }, this.nextBoundary());
    } else {
      p.start(undefined, off);
      this.auditionStart = Tone.now() - off;
      this.auditionQueued = false;
      if (t.state !== 'started') this.startAuditionMetro(); // 走带停 → 自由预览自配节拍器;走带在跑(非量化预览)归 Transport 节拍器,不重复
    }
  }
  /** 试听中改了 region(trim/长度/变调)→ 不停下,在下一个 loop 边界保接缝换 buffer(新 loop 从头起,即"第二次播放"就是新长度);
   *  还没出声(排队/已停)→ 直接重起(无可闻打断)。手感同 voice 的 swapBuffer。through 同 audition 的路由。 */
  auditionSwap(id: string, buffer: AudioBuffer, through?: { eq: ShelfEq; gainDb: number } | { mixer: Mixer; sends?: InstrumentSends }): void {
    if (this.auditionId !== id) return; // 没在试听这条 → 下次起播自然用新 region
    const old = this.auditionPlayer;
    if (!old || this.auditionQueued || this.auditionDur <= 0) { // 还没出声 → 重起
      this.audition(id, buffer, through, Tone.getTransport().state === 'started');
      return;
    }
    const XF = 0.012;                                          // 交叉淡化秒数(防接缝爆音)
    const dur = this.auditionDur;
    const now = Tone.now();
    const k = Math.max(1, Math.ceil((now - this.auditionStart) / dur)); // 下一个 loop 完成点(绝对上下文时刻)
    const boundary = this.auditionStart + k * dur;
    const np = new Tone.Player(buffer);
    np.loop = true; np.loopStart = 0; np.loopEnd = buffer.duration; np.fadeIn = XF;
    if (through && 'mixer' in through) { np.connect(this.auditionChain(through.mixer)); this.applyAuditionSends(through.sends); np.volume.value = through.mixer.gainDb; this.auditionUsesChain = true; } // 片/乐器链:接常驻 audEq + 用 gain + 刷 send 量
    else if (through) { np.connect(through.eq.low); np.volume.value = old.volume.value; } // 乐器共享链:保留当前音量
    else { np.toDestination(); np.volume.value = old.volume.value; }                       // 裸链
    old.fadeOut = XF;
    np.start(boundary);                                        // 边界对齐起、新 loop 从头
    try { old.stop(boundary + XF); } catch { /* */ }
    this.auditionFading.add(old);                              // §28.8 旧 player 登记为"淡出中":boundary 前若 stopAudition(空格/切换)→ 立即被一并灭掉,不漏播到远期 boundary
    this.auditionPlayer = np;                                  // 立即换引用(后续 stop 走新的);相位参考等到边界再切,免得切前 phase 错乱
    const flipMs = Math.max(0, (boundary - now) * 1000);
    const tid = setTimeout(() => {
      this.disposeTimers.delete(tid);
      this.auditionFading.delete(old);
      this.auditionStart = boundary; this.auditionDur = buffer.duration; // 边界后:播放线相位参考切到新 loop
      try { old.dispose(); } catch { /* */ }
    }, flipMs + XF * 1000 + 60);
    this.disposeTimers.add(tid);
  }
  /** 该 id 的预览正排队等小节边界(还没出声)→ true;UI 据此让波形背景呼吸。 */
  auditionQueuedFor(id: string): boolean { return this.auditionId === id && this.auditionQueued; }
  /** 预览某乐器当前已加载的 warp 产物(自由循环,不挂主走带);仅走带停时用。过该乐器自己的 gain/eq/pan + aux send(出 FX)。 */
  previewInstrument(id: string, startPhase = 0): void {
    const v = this.voices.get(id);
    const buf = v?.player.buffer?.get?.() as AudioBuffer | undefined;
    if (v && buf) this.audition(id, buf, { mixer: v.mixer, sends: this.voiceSends(v) }, false, startPhase * buf.duration); // §28/§34 clip 预览(总走带停时):走 auditionChain(mixer→master + sends→fx,听感对齐走带),绕开 voice 的 muteGain(enable/solo 遮罩)→ 禁用/未起声的乐器也能试听;也走起播线偏移
  }
  /** 从 voice 的 send gain 节点回读当前 3 条 aux send 量(预览镜像用,免在 Voice 上另存一份 sends)。 */
  private voiceSends(v: Voice): InstrumentSends { return { dist: v.sendDist.gain.value, delay: v.sendDelay.gain.value, reverb: v.sendReverb.gain.value }; }
  /** collage 片 / 乐器整体预览的常驻 mixer 链(lowshelf/peaking/highshelf → panner → master,频点同离线 bake 的 EQ_BANDS)。
   *  懒建一次复用,每次按 dB 刷 gain/pan,返回入口节点(audEq.low)。
   *  干声进 master(随主音量/软削波天花板/XY,与走带同口径,不再裸到 destination);panner 另旁路出 3 条 aux send
   *  (audSendX → fx return.input),让带 send 的乐器整体预览也出 FX —— 送量由 applyAuditionSends 单独刷(默认 0 = 纯干声),
   *  故 setAuditionMix 只刷 eq/pan 不会把 send 清零。 */
  private auditionChain(mixer: Mixer): Tone.Filter {
    if (!this.audEq || !this.audPan) {
      this.audEq = {
        low: new Tone.Filter({ type: 'lowshelf', frequency: EQ_BANDS.lowFreq, gain: 0 }),
        mid: new Tone.Filter({ type: 'peaking', frequency: EQ_BANDS.midFreq, Q: EQ_BANDS.midQ, gain: 0 }),
        high: new Tone.Filter({ type: 'highshelf', frequency: EQ_BANDS.highFreq, gain: 0 }),
      };
      this.audPan = new Tone.Panner(0);
      this.audEq.low.chain(this.audEq.mid, this.audEq.high, this.audPan);
      this.audPan.connect(this.master ?? Tone.getDestination()); // 干声进主总线(与走带一致);init 前兜底裸到 destination
      // aux send 旁路(§17):panner → audSendX → fx return.input;送量默认 0(piece/库预览=纯干声),乐器整体预览经 applyAuditionSends 打开
      this.audSendDist = new Tone.Gain(0); this.audSendDelay = new Tone.Gain(0); this.audSendReverb = new Tone.Gain(0);
      if (this.fx) {
        this.audPan.connect(this.audSendDist); this.audSendDist.connect(this.fx.distInput);
        this.audPan.connect(this.audSendDelay); this.audSendDelay.connect(this.fx.delayInput);
        this.audPan.connect(this.audSendReverb); this.audSendReverb.connect(this.fx.reverbInput);
      }
    }
    this.audEq.low.gain.value = mixer.eq.lowDb;
    this.audEq.mid.gain.value = mixer.eq.midDb;
    this.audEq.high.gain.value = mixer.eq.highDb;
    this.audPan.pan.value = Math.max(-1, Math.min(1, mixer.pan));
    return this.audEq.low;
  }
  /** 刷预览 aux send 量(§17):乐器整体预览给 sends → audPan 旁路出 FX;piece/库预览不给 → 送量 0 = 纯干声。
   *  与 auditionChain 解耦,故 setAuditionMix 拖 eq/pan 时不会把 send 清零。 */
  private applyAuditionSends(sends?: InstrumentSends): void {
    const c = (x: number) => Math.max(0, Math.min(1, Number.isFinite(x) ? x : 0));
    if (this.audSendDist) this.audSendDist.gain.value = sends ? c(sends.dist) : 0;
    if (this.audSendDelay) this.audSendDelay.gain.value = sends ? c(sends.delay) : 0;
    if (this.audSendReverb) this.audSendReverb.gain.value = sends ? c(sends.reverb) : 0;
  }
  /** 预览正走片链({mixer} 路由)时,实时改 gain/eq/pan —— 让片 MixerStrip 拖旋钮跟手(同乐器 MixerStrip 的 live 口径)。其它路由(裸/乐器共享)忽略。 */
  setAuditionMix(mixer: Mixer): void {
    if (!this.auditionUsesChain || !this.auditionPlayer) return;
    this.auditionPlayer.volume.value = mixer.gainDb;
    this.auditionChain(mixer);
  }
  /** §28.7 异步预览防陈旧:起播前(任何 await 之前)取令牌 → await 解析后用 auditionStale(tok) 校验是否被顶掉。
   *  本调用**不停**当前预览(保「旧预览放到新的就绪」无缝手感);停旧由随后 audition() 内部的 stopAudition 完成。 */
  nextAuditionToken(): number { this.auditionPendingTok = ++this.auditionGen; return this.auditionPendingTok; }
  /** 令牌已被后续 stopAudition / 新预览顶掉 → true:此时迟到的 audition() 应放弃,不出声(否则 stop 反悔 / 后解析者错位)。 */
  auditionStale(token: number): boolean { return token !== this.auditionGen; }
  /** 有预览正在加载(已取令牌、还没出声/没被停)→ true。空格据此在 warm-up 窗口先停预览,而非误启走带。 */
  auditionPending(): boolean { return this.auditionPendingTok !== 0; }
  /** host 在 finally 调:**按令牌清** pending(只清自己那次)→ 扛并发 in-flight + warp 抛错不泄漏(后来者/已停者的 0 不被误覆盖)。 */
  clearAuditionPending(token: number): void { if (this.auditionPendingTok === token) this.auditionPendingTok = 0; }
  stopAudition(): void {
    this.auditionGen++; // §28.7 作废任何 in-flight 异步预览(stop 落在 warp await 窗口内时,迟到的 audition 据此放弃)
    this.auditionPendingTok = 0; // §28.7 stop 取消"加载中"标志(空格第二下才走带)
    this.stopAuditionMetro(); // 试听节拍器随预览一并拆(切预览/停预览/起走带都经此中央口)
    if (this.auditionSchedId != null) { Tone.getTransport().clear(this.auditionSchedId); this.auditionSchedId = undefined; }
    this.auditionQueued = false;
    if (this.auditionPlayer) { try { this.auditionPlayer.stop(); } catch { /* */ } this.auditionPlayer.dispose(); this.auditionPlayer = null; }
    this.auditionFading.forEach((p) => { try { p.stop(); } catch { /* */ } try { p.dispose(); } catch { /* */ } }); // §28.8 连淡出中的旧 swap player 一起灭(否则长 loop 漏播到远期 boundary = 停不下来)
    this.auditionFading.clear();
    this.auditionId = null;
    this.auditionUsesChain = false;
  }
  auditioningId(): string | null { return this.auditionId; }
  /** 试听播放线相位 0..1;没在试听该 id / 还在排队 → null。 */
  auditionPhase(id: string): number | null {
    if (!this.auditionPlayer || this.auditionId !== id || this.auditionQueued || this.auditionDur <= 0) return null;
    const el = Tone.now() - this.auditionStart;
    return el <= 0 ? 0 : (el % this.auditionDur) / this.auditionDur;
  }

  dispose(): void {
    this.disposeTimers.forEach((t) => clearTimeout(t)); this.disposeTimers.clear();
    this.stopTransport(); this.clearAll(); this.stopAudition();
    [this.audEq?.low, this.audEq?.mid, this.audEq?.high, this.audPan, this.audSendDist, this.audSendDelay, this.audSendReverb].forEach((n) => { try { n?.dispose(); } catch { /* */ } });
    this.audEq = undefined; this.audPan = undefined;
    this.audSendDist = this.audSendDelay = this.audSendReverb = undefined;
    this.fx?.dispose(); this.fx = undefined;
    this.xy?.dispose(); this.xy = undefined;
    // 主总线 + 节拍器 + 电平表节点(常驻、随实例销毁;旧实现漏清这些)
    [this.clickSynth, this.clickVol, this.split, this.analyserL, this.analyserR, this.master, this.masterClip].forEach((n) => { try { n?.dispose(); } catch { /* */ } });
    this.clickSynth = this.clickVol = undefined; this.split = this.analyserL = this.analyserR = undefined; this.master = undefined; this.masterClip = undefined;
  }

  private fire(v: Voice, time: number): void {
    if (v.player.disposed || !v.player.loaded) return;
    if (v.player.state === 'started') v.player.restart(time);
    else v.player.start(time);
    v.startTime = time;
    v.loopDur = Math.max(0, v.player.loopEnd as number) || v.player.buffer.duration;
  }
  private clearScheduled(v: Voice): void {
    if (v.scheduledId != null) { Tone.getTransport().clear(v.scheduledId); v.scheduledId = undefined; }
  }
  /** 下一个量化边界(按当前 quantize):1bar=下一小节 · 1/2=下一半小节 · 1/4=下一拍 · off=立即(下个音频块)。 */
  private nextBoundary(): string {
    const t = Tone.getTransport();
    const [bs, bes] = String(t.position).split(':');
    const bar = parseInt(bs, 10), beat = parseFloat(bes), bpb = this.beatsPerBar;
    switch (this.quantize) {
      case 'off': return '+0.02'; // 不量化:立即起
      case '1/4': { const nb = Math.floor(beat) + 1; return nb >= bpb ? `${bar + 1}:0:0` : `${bar}:${nb}:0`; }
      case '1/2': { const h = bpb / 2; const nb = (Math.floor(beat / h) + 1) * h; return nb >= bpb ? `${bar + 1}:0:0` : `${bar}:${nb}:0`; }
      default: return `${bar + 1}:0:0`; // 1bar
    }
  }
}
