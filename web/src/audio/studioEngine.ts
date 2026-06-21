'use client';
// Studio 音频引擎 —— 区别于 ToneAudioEngine(loop 机那条),studio 走这条:
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

type VoiceState = 'off' | 'queued' | 'on' | 'stopping';

// 三段串联 EQ:lowshelf@200 + peaking@1k(Q0.7) + highshelf@4k(频点见 EQ_BANDS;low 为入口节点,接它即接整段)。
interface ShelfEq { low: Tone.Filter; mid: Tone.Filter; high: Tone.Filter; }

interface Voice {
  player: Tone.Player;
  eq: ShelfEq;
  muteGain: Tone.Gain;  // §18 solo 遮罩(audible?1:0):接在 sends 分叉之前 → 静音连干声带 FX send 一起灭;不动 player → 保相位
  panner: Tone.Panner;
  sendDist: Tone.Gain; sendDelay: Tone.Gain; sendReverb: Tone.Gain; // aux send 量(post-panner 旁路进 3 个 fx return,§17)
  meter: Tone.Meter;
  bars: number;
  wantOn: boolean;      // 用户开关意图(走带停时也记着,起播时一并点亮)
  state: VoiceState;
  scheduledId?: number;
  startTime?: number;   // 真实起播上下文时刻(算 phase)
  loopDur?: number;
  pending?: Tone.Player; // 无缝换 buffer:已建好、等下一个小节边界接管的新 player
}

// 软削波曲线:|x|≤T 纯净直通;超 T 用 tanh 平滑趋近天花板 ceil(memoryless,无抽吸)。给主总线 WaveShaper 当安全天花板。
function softClipCurve(T: number, ceil: number, n = 2048): Float32Array {
  const c = new Float32Array(n), span = Math.max(1e-4, ceil - T);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1, ax = Math.abs(x);
    c[i] = ax <= T ? x : Math.sign(x) * (T + span * Math.tanh((ax - T) / span));
  }
  return c;
}

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
  private split?: Tone.Split; private meterL?: Tone.Meter; private meterR?: Tone.Meter; // 总输出 L/R 电平表(抽 master = post-FX/post 主音量/pre-软削波 的真实总线电平)
  private clickSynth?: Tone.Synth; private clickVol?: Tone.Volume;  // 节拍器:click synth → 音量节点 → master(随主音量+限制器,但不进 FX)
  private fx?: FxBus; private fxCfg?: FxConfig;                     // 主总线效果器(§17):各乐器 panner → fx.input → 失真→延迟→混响 → master;节拍器不进
  private xy?: XYPad;                                              // §21 XY 表演板:主总线 insert,串在 master 与软削波天花板之间(吃完整最终 mix)
  /** 离散态(voice off/queued/on/stopping、audition 起停)在**异步边界**跃迁时回调上层重渲;连续视觉(电平/播放头/走带位置)由 UI 叶子自驱动 rAF,不走这里。 */
  onChange?: () => void;
  private metroOn = false;
  private metroInterval: 'beat' | 'bar' | '2bar' | '4bar' = 'beat'; // 几小节响一次:每拍/每小节/每2小节/每4小节
  private metroRepeatId?: number; // 节拍器的 scheduleRepeat id —— 每次 startTransport 重注册(stopTransport 的 t.cancel() 会清掉它)

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
      this.masterClip = new Tone.WaveShaper(softClipCurve(0.72, 0.96)); // 阈 ~-2.9dBFS 起软饱和,天花板 ~-0.35dBFS
      this.masterClip.oversample = '4x';
      // §21 XY 表演板:主总线 insert 串在 master → 天花板 之间(吃干声 + 所有 FX return 湿声的最终和;电平表抽在 master=XY 前)。
      this.xy = new XYPad(bpm);
      this.master.connect(this.xy.input);
      this.xy.output.connect(this.masterClip);
      this.masterClip.toDestination();
      // 总输出 L/R 电平表:抽在 master(post-FX、post 主音量、pre-软削波)= 真实总线电平,
      // 能反映 delay/reverb 尾巴、失真、主音量与"逼近限制器"的过载(旧实现抽各 voice panner=pre-FX,测不到这些)。
      this.split = new Tone.Split();
      this.meterL = new Tone.Meter(); this.meterR = new Tone.Meter();
      this.master.connect(this.split);
      this.split.connect(this.meterL, 0, 0);
      this.split.connect(this.meterR, 1, 0);
      // 节拍器:click → 音量 → master(随主音量+限制器一起走,但不进 FX:click 不该带混响/失真)。
      this.clickVol = new Tone.Volume(-8);
      this.clickVol.connect(this.master);
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

  // --- §21 XY 表演板:瞬态演奏(UI 直连,不进 undo/不落库;对标 §18 Solo)---
  xyEngage(): void { this.xy?.engage(); }
  xyMove(nx: number, ny: number): void { this.xy?.move(nx, ny); }
  xyRelease(): void { this.xy?.release(); }

  // --- 主输出:主音量(master Volume,在限制器之前) + L/R 电平 ---
  setMasterVolume(db: number): void { if (this.master) this.master.volume.value = db; }
  // 归一窗口收窄到 [-54,0]dBFS(1.0=0dBFS):危险区铺在表顶,UI 据此上红(逼近限制器即变红)。
  masterLevel(): [number, number] {
    const norm = (m?: Tone.Meter): number => { const v = m?.getValue(); const db = typeof v === 'number' ? v : Array.isArray(v) ? v[0] : -Infinity; return isFinite(db) ? Math.max(0, Math.min(1, (db + 54) / 54)) : 0; };
    return [norm(this.meterL), norm(this.meterR)];
  }

  // --- 节拍器 ---
  setQuantize(q: Quantize): void { this.quantize = q; }
  setMetronome(on: boolean): void { this.metroOn = on; }
  // 每次起播重挂节拍器节拍回调(stopTransport 的 t.cancel() 会把它清掉,故不能只在 init 注册一次)。
  private scheduleMetro(): void {
    const t = Tone.getTransport();
    if (this.metroRepeatId != null) { try { t.clear(this.metroRepeatId); } catch { /* */ } }
    this.metroRepeatId = t.scheduleRepeat((time) => this.onClick(time), '4n', 0);
  }
  setMetronomeVolume(db: number): void { if (this.clickVol) this.clickVol.volume.value = db; }
  setMetronomeInterval(iv: 'beat' | 'bar' | '2bar' | '4bar'): void { this.metroInterval = iv; }
  private onClick(time: number): void {
    if (!this.metroOn || !this.clickSynth) return;
    const t = Tone.getTransport();
    const beats = Math.round(t.getTicksAtTime(time) / t.PPQ);
    const beatInBar = ((beats % this.beatsPerBar) + this.beatsPerBar) % this.beatsPerBar;
    const barIdx = Math.floor(beats / this.beatsPerBar);
    const down = beatInBar === 0;
    const play = this.metroInterval === 'beat' ? true : this.metroInterval === 'bar' ? down : this.metroInterval === '2bar' ? down && barIdx % 2 === 0 : down && barIdx % 4 === 0;
    if (play) this.clickSynth.triggerAttackRelease(down ? 'C6' : 'C5', '32n', time);
  }
  async resume(): Promise<void> { await Tone.start(); }
  /** 改主 BPM:主走带 transport 立即跟随(buffer 的 re-warp/热替换由上层逐乐器做)。 */
  setBpm(bpm: number): void { Tone.getTransport().bpm.value = bpm; this.fx?.setBpm(bpm); this.xy?.setBpm(bpm); }

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
  private makeEq(): ShelfEq {
    return {
      low: new Tone.Filter({ type: 'lowshelf', frequency: EQ_BANDS.lowFreq, gain: 0 }),
      mid: new Tone.Filter({ type: 'peaking', frequency: EQ_BANDS.midFreq, Q: EQ_BANDS.midQ, gain: 0 }),
      high: new Tone.Filter({ type: 'highshelf', frequency: EQ_BANDS.highFreq, gain: 0 }),
    };
  }

  /** 装载/替换一件乐器的可播放 buffer + mixer 链 + 3 条 aux send。 */
  loadInstrument(id: string, buffer: AudioBuffer, bars: number, mixer: Mixer, sends?: InstrumentSends): void {
    this.clearInstrument(id);
    const player = new Tone.Player(buffer);
    player.loop = true;
    player.loopStart = 0;
    player.loopEnd = buffer.duration;
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
    const v: Voice = { player, eq, muteGain, panner, sendDist, sendDelay, sendReverb, meter, bars, wantOn: false, state: 'off' };
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
    if (this.auditionId === id) this.auditionSwap(id, buffer, { eq: v.eq, gainDb: v.player.volume.value }); // 预览(audition)正放这件乐器(走带停时常态)→ 同步无缝换上新 buffer,否则改 trim/长度只动画不出声
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
      this.retempoSchedId = undefined; this.retempoTarget = undefined; this.retempoBuilds = undefined; // 边界已触发,应用归本回调
      t.bpm.value = newBpm; this.fx?.setBpm(newBpm); this.xy?.setBpm(newBpm); // B 处翻新速(此前老 buffer 老速正常播,无 drift)
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
          builds.get(id)?.then((b) => { if (b && gen === this.retempoGen) this.swapBuffer(id, b, v.bars); }); // 就绪后在循环边界补换;期间又改速/停走带(gen 变)则丢弃这迟到的旧速 buffer(swapBuffer 建新 player→自动复位 rate)
        }
      }
      this.voices.forEach((v, id) => { if (v.state !== 'on') builds.get(id)?.then((b) => { if (b && gen === this.retempoGen) this.replaceBufferInPlace(v, b); }); }); // 没出声的:就地换(gen 变则丢弃迟到 buffer)
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
    if (!v || v.state !== 'on') return 0;
    const raw = v.meter.getValue();
    const db = typeof raw === 'number' ? raw : raw[0];
    if (!isFinite(db)) return 0;
    return Math.max(0, Math.min(1, (db + 48) / 48));
  }
  setMixer(id: string, mixer: Mixer): void {
    const v = this.voices.get(id);
    if (v) this.applyMixer(v, mixer);
    // 预览中拖 gain → 即时跟手(eq/pan 走的是共享节点 v.eq/v.panner,已随 applyMixer 生效;gain 在 player 上要单独补)。
    if (this.auditionId === id && this.auditionPlayer) this.auditionPlayer.volume.value = mixer.gainDb;
  }
  private applyMixer(v: Voice, m: Mixer): void {
    v.player.volume.value = m.gainDb;
    v.panner.pan.value = Math.max(-1, Math.min(1, m.pan));
    v.eq.low.gain.value = m.eq.lowDb;
    v.eq.mid.gain.value = m.eq.midDb;
    v.eq.high.gain.value = m.eq.highDb;
  }
  /** 改一件乐器的 3 条 aux send 量(§17)。 */
  setSends(id: string, sends: InstrumentSends): void { const v = this.voices.get(id); if (v) this.applySends(v, sends); }
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
    this.voices.forEach((v, id) => this.reconcileVoice(id, v));
  }

  /** 按当前 wantOn + soloIds 重算单个 voice:muteGain 遮罩(即时、保相位)+ player 跑/停(量化)。 */
  private reconcileVoice(id: string, v: Voice): void {
    v.muteGain.gain.rampTo(this.isAudible(id, v) ? 1 : 0, 0.015); // 遮罩即时跟随,不动 player → 保相位、清 solo 原相位接回
    this.setRunning(v, this.shouldRun(id, v));
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
    // 改速边界前就停 → 仍把 transport 落到目标速 + 把在渲的新 buffer 就地兜底换上(否则重启后旧长度 buffer 配新速度 = drift);scheduleOnce 由下面 t.cancel() 清掉。
    if (this.retempoTarget != null) { t.bpm.value = this.retempoTarget; this.fx?.setBpm(this.retempoTarget); this.xy?.setBpm(this.retempoTarget); }
    if (this.retempoBuilds) { for (const [id, p] of this.retempoBuilds) p.then((b) => { const v = this.voices.get(id); if (v && b) this.replaceBufferInPlace(v, b); }); }
    this.retempoSchedId = undefined; this.retempoTarget = undefined; this.retempoBuilds = undefined; this.retempoGen++; // 停走带 → 作废改速边界回调里"就绪后补换"的迟到 swapBuffer(本函数已就地兜底,别再让它在停后/重启后盖上去)
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
  private audEq?: ShelfEq;               // collage 片预览的常驻 mixer 链(low/mid/high → panner → dest,频点同 EQ_BANDS/离线 bake);懒建复用、随实例销毁
  private audPan?: Tone.Panner;
  private auditionUsesChain = false;     // 当前试听是否走 audEq 片链(走才允许 setAuditionMix 实时改;区别于库素材裸链 / 乐器共享 eq 链)
  // through 给定 → 预览带上 mixer:
  //   {eq,gainDb} = 走某乐器的共享 mixer 节点链(eq→panner→dest),听感与走带出声一致(乐器预览);
  //   {mixer}     = collage 片:按片自己的 gain/pan/3 段 EQ 现搭一条常驻片链(audEq),听感与离线 bake 一致(片预览);
  // 不给(库素材裸试听,没有乐器 mixer)→ 直连 destination。
  // quantize 且走带在跑 → 排到下一小节边界再起(跟随 bar);否则立即自由循环。
  audition(id: string, buffer: AudioBuffer, through?: { eq: ShelfEq; gainDb: number } | { mixer: Mixer }, quantize = false): void {
    this.stopAudition();
    const p = new Tone.Player(buffer);
    if (through && 'mixer' in through) { p.volume.value = through.mixer.gainDb; p.connect(this.auditionChain(through.mixer)); this.auditionUsesChain = true; }
    else if (through) { p.volume.value = through.gainDb; p.connect(through.eq.low); this.auditionUsesChain = false; }
    else { p.toDestination(); this.auditionUsesChain = false; }
    p.loop = true;
    this.auditionPlayer = p;
    this.auditionId = id;
    this.auditionDur = buffer.duration;
    const t = Tone.getTransport();
    if (quantize && t.state === 'started') {
      this.auditionQueued = true;
      this.auditionStart = 0; // 等边界期间没起播,phase=null(UI 呼吸)
      this.auditionSchedId = t.scheduleOnce((time) => {
        this.auditionSchedId = undefined;
        if (p.disposed) return;
        p.start(time);
        this.auditionStart = time;
        this.auditionQueued = false;
        this.onChange?.(); // 边界:预览 queued→playing,通知上层(波形呼吸收掉)
      }, this.nextBoundary());
    } else {
      p.start();
      this.auditionStart = Tone.now();
      this.auditionQueued = false;
    }
  }
  /** 试听中改了 region(trim/长度/变调)→ 不停下,在下一个 loop 边界保接缝换 buffer(新 loop 从头起,即"第二次播放"就是新长度);
   *  还没出声(排队/已停)→ 直接重起(无可闻打断)。手感同 voice 的 swapBuffer。through 同 audition 的路由。 */
  auditionSwap(id: string, buffer: AudioBuffer, through?: { eq: ShelfEq; gainDb: number } | { mixer: Mixer }): void {
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
    if (through && 'mixer' in through) { np.connect(this.auditionChain(through.mixer)); np.volume.value = through.mixer.gainDb; this.auditionUsesChain = true; } // 片链:接常驻 audEq + 用片 gain
    else if (through) { np.connect(through.eq.low); np.volume.value = old.volume.value; } // 乐器共享链:保留当前音量
    else { np.toDestination(); np.volume.value = old.volume.value; }                       // 裸链
    old.fadeOut = XF;
    np.start(boundary);                                        // 边界对齐起、新 loop 从头
    try { old.stop(boundary + XF); } catch { /* */ }
    this.auditionPlayer = np;                                  // 立即换引用(后续 stop 走新的);相位参考等到边界再切,免得切前 phase 错乱
    const flipMs = Math.max(0, (boundary - now) * 1000);
    const tid = setTimeout(() => {
      this.disposeTimers.delete(tid);
      this.auditionStart = boundary; this.auditionDur = buffer.duration; // 边界后:播放线相位参考切到新 loop
      try { old.dispose(); } catch { /* */ }
    }, flipMs + XF * 1000 + 60);
    this.disposeTimers.add(tid);
  }
  /** 该 id 的预览正排队等小节边界(还没出声)→ true;UI 据此让波形背景呼吸。 */
  auditionQueuedFor(id: string): boolean { return this.auditionId === id && this.auditionQueued; }
  /** 预览某乐器当前已加载的 warp 产物(自由循环,不挂主走带);仅走带停时用。过该乐器自己的 gain/eq/pan。 */
  previewInstrument(id: string): void {
    const v = this.voices.get(id);
    const buf = v?.player.buffer?.get?.() as AudioBuffer | undefined;
    if (v && buf) this.audition(id, buf, { eq: v.eq, gainDb: v.player.volume.value });
  }
  /** collage 片预览的常驻 mixer 链(lowshelf/peaking/highshelf → panner → destination,频点同离线 bake 的 EQ_BANDS)。
   *  懒建一次复用,每次按片的 dB 刷 gain/pan,返回入口节点(audEq.low)。裸到 destination(不过主总线,同库素材试听口径),只补上片自己的 gain/eq/pan。 */
  private auditionChain(mixer: Mixer): Tone.Filter {
    if (!this.audEq || !this.audPan) {
      this.audEq = {
        low: new Tone.Filter({ type: 'lowshelf', frequency: EQ_BANDS.lowFreq, gain: 0 }),
        mid: new Tone.Filter({ type: 'peaking', frequency: EQ_BANDS.midFreq, Q: EQ_BANDS.midQ, gain: 0 }),
        high: new Tone.Filter({ type: 'highshelf', frequency: EQ_BANDS.highFreq, gain: 0 }),
      };
      this.audPan = new Tone.Panner(0);
      this.audEq.low.chain(this.audEq.mid, this.audEq.high, this.audPan, Tone.getDestination());
    }
    this.audEq.low.gain.value = mixer.eq.lowDb;
    this.audEq.mid.gain.value = mixer.eq.midDb;
    this.audEq.high.gain.value = mixer.eq.highDb;
    this.audPan.pan.value = Math.max(-1, Math.min(1, mixer.pan));
    return this.audEq.low;
  }
  /** 预览正走片链({mixer} 路由)时,实时改 gain/eq/pan —— 让片 MixerStrip 拖旋钮跟手(同乐器 MixerStrip 的 live 口径)。其它路由(裸/乐器共享)忽略。 */
  setAuditionMix(mixer: Mixer): void {
    if (!this.auditionUsesChain || !this.auditionPlayer) return;
    this.auditionPlayer.volume.value = mixer.gainDb;
    this.auditionChain(mixer);
  }
  stopAudition(): void {
    if (this.auditionSchedId != null) { Tone.getTransport().clear(this.auditionSchedId); this.auditionSchedId = undefined; }
    this.auditionQueued = false;
    if (this.auditionPlayer) { try { this.auditionPlayer.stop(); } catch { /* */ } this.auditionPlayer.dispose(); this.auditionPlayer = null; }
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
    [this.audEq?.low, this.audEq?.mid, this.audEq?.high, this.audPan].forEach((n) => { try { n?.dispose(); } catch { /* */ } });
    this.audEq = undefined; this.audPan = undefined;
    this.fx?.dispose(); this.fx = undefined;
    this.xy?.dispose(); this.xy = undefined;
    // 主总线 + 节拍器 + 电平表节点(常驻、随实例销毁;旧实现漏清这些)
    [this.clickSynth, this.clickVol, this.split, this.meterL, this.meterR, this.master, this.masterClip].forEach((n) => { try { n?.dispose(); } catch { /* */ } });
    this.clickSynth = this.clickVol = undefined; this.split = this.meterL = this.meterR = undefined; this.master = undefined; this.masterClip = undefined;
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
