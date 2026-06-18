'use client';
// Studio 音频引擎 —— 区别于 ToneAudioEngine(loop 机那条),studio 走这条:
// 在 M1 的"量化 launch/stop"基础上,每件乐器多挂一条 mixer 链 Player → EQ3 → Panner → (volume) → dest。
// 主走带 = Tone.Transport(全局唯一时钟);乐器"开关"= 量化到下一个小节边界的 launch/stop。
// 假设:每件乐器的 buffer 已是整小节、可无缝循环(sample=warp 产物 / collage=bake 产物)。
import * as Tone from 'tone';
import type { Mixer } from '@/contracts';

type VoiceState = 'off' | 'queued' | 'on' | 'stopping';

interface Voice {
  player: Tone.Player;
  eq: Tone.EQ3;
  panner: Tone.Panner;
  meter: Tone.Meter;
  bars: number;
  wantOn: boolean;      // 用户开关意图(走带停时也记着,起播时一并点亮)
  state: VoiceState;
  scheduledId?: number;
  startTime?: number;   // 真实起播上下文时刻(算 phase)
  loopDur?: number;
  pending?: Tone.Player; // 无缝换 buffer:已建好、等下一个小节边界接管的新 player
}

export class StudioEngine {
  private voices = new Map<string, Voice>();
  private beatsPerBar = 4;
  private inited = false;
  private disposeTimers = new Set<ReturnType<typeof setTimeout>>(); // 无缝换 buffer 后延迟销毁旧 player 的墙钟定时器

  init(bpm: number, beatsPerBar = 4): void {
    this.beatsPerBar = beatsPerBar;
    if (!this.inited) {
      Tone.getTransport().bpm.value = bpm;
      this.inited = true;
    } else {
      Tone.getTransport().bpm.value = bpm;
    }
  }
  async resume(): Promise<void> { await Tone.start(); }

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

  /** 装载/替换一件乐器的可播放 buffer + mixer 链。 */
  loadInstrument(id: string, buffer: AudioBuffer, bars: number, mixer: Mixer): void {
    this.clearInstrument(id);
    const player = new Tone.Player(buffer);
    player.loop = true;
    player.loopStart = 0;
    player.loopEnd = buffer.duration;
    const eq = new Tone.EQ3(0, 0, 0);
    const panner = new Tone.Panner(0);
    player.chain(eq, panner, Tone.getDestination());
    const meter = new Tone.Meter();
    panner.connect(meter); // 旁路抽头,给 mixer 电平表
    const v: Voice = { player, eq, panner, meter, bars, wantOn: false, state: 'off' };
    this.voices.set(id, v);
    this.applyMixer(v, mixer);
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
      np.connect(v.eq);
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
      }, this.nextBar());
      return;
    }
    // 没在出声:就地换(排队中的 fire 会自然用到新 buffer)
    try { v.player.buffer.set(buffer); } catch { /* */ }
    v.player.loopEnd = buffer.duration;
    v.loopDur = buffer.duration;
  }
  private cancelPending(v: Voice): void {
    if (v.pending) { try { v.pending.dispose(); } catch { /* */ } v.pending = undefined; }
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
    v.eq.low.value = m.eq.lowDb;
    v.eq.high.value = m.eq.highDb;
  }

  clearInstrument(id: string): void {
    const v = this.voices.get(id);
    if (!v) return;
    this.cancelPending(v);
    this.clearScheduled(v);
    v.player.stop();
    v.player.dispose();
    v.eq.dispose();
    v.panner.dispose();
    v.meter.dispose();
    this.voices.delete(id);
  }
  clearAll(): void {
    [...this.voices.keys()].forEach((id) => this.clearInstrument(id));
  }

  /** 开关:总走带在跑→量化进/出(UI 闪烁等边界);没起走带→on 立即起走带+出声、off 直接停。 */
  setEnabled(id: string, on: boolean): void {
    const v = this.voices.get(id);
    if (!v) return;
    this.cancelPending(v); // 开关变更 → 作废还没接管的换 buffer
    v.wantOn = on;
    const t = Tone.getTransport();
    if (t.state !== 'started') {
      // 没总走带:不出声。播放态只记在 wantOn(UI 用 enabled 体现);按总播放才一起响。
      this.clearScheduled(v);
      v.player.stop();
      v.state = 'off';
      return;
    }
    this.clearScheduled(v);
    if (on) {
      if (v.state === 'on') return;
      v.state = 'queued';
      v.scheduledId = t.scheduleOnce((time) => { v.scheduledId = undefined; this.fire(v, time); v.state = 'on'; }, this.nextBar());
    } else {
      if (v.state === 'queued') { v.state = 'off'; return; }
      if (v.state !== 'on') return;
      v.state = 'stopping';
      v.scheduledId = t.scheduleOnce((time) => { v.scheduledId = undefined; v.player.stop(time); v.state = 'off'; }, this.nextBar());
    }
  }

  startTransport(): void {
    this.stopAudition(); // 走带一开就停掉预览(预览只在走带停时用)
    const t = Tone.getTransport();
    t.start();
    this.voices.forEach((v) => {
      if (v.wantOn) { this.fire(v, Tone.now()); v.state = 'on'; } else v.state = 'off';
    });
  }
  stopTransport(): void {
    const t = Tone.getTransport();
    t.stop();
    t.cancel();
    this.voices.forEach((v) => {
      this.cancelPending(v);
      v.scheduledId = undefined;
      v.player.stop();
      v.state = 'off'; // 停走带=都不出声(state 只管出声);播放态保留在 wantOn,UI 仍显示激活
      v.startTime = undefined;
    });
  }

  // --- 试听:独立预览 player(不挂主走带);库素材 + 乐器预览共用。可量化:走带在跑时排到下一小节边界再起(等待期 queued=true,UI 呼吸)---
  private auditionPlayer: Tone.Player | null = null;
  private auditionId: string | null = null;
  private auditionStart = 0;
  private auditionDur = 0;
  private auditionQueued = false;        // 量化预览:已排队、等小节边界(还没出声)
  private auditionSchedId?: number;       // 排队的 scheduleOnce id
  // through 给定 → 预览走该乐器的 mixer 链(eq→panner→dest)+ 应用 gain,听感与走带出声一致;
  // 不给(库素材裸试听,没有乐器 mixer)→ 直连 destination。
  // quantize 且走带在跑 → 排到下一小节边界再起(跟随 bar);否则立即自由循环。
  audition(id: string, buffer: AudioBuffer, through?: { eq: Tone.EQ3; gainDb: number }, quantize = false): void {
    this.stopAudition();
    const p = new Tone.Player(buffer);
    if (through) { p.volume.value = through.gainDb; p.connect(through.eq); }
    else { p.toDestination(); }
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
      }, this.nextBar());
    } else {
      p.start();
      this.auditionStart = Tone.now();
      this.auditionQueued = false;
    }
  }
  /** 试听中改了 region(trim/长度/变调)→ 不停下,在下一个 loop 边界保接缝换 buffer(新 loop 从头起,即"第二次播放"就是新长度);
   *  还没出声(排队/已停)→ 直接重起(无可闻打断)。手感同 voice 的 swapBuffer。through 同 audition 的路由。 */
  auditionSwap(id: string, buffer: AudioBuffer, through?: { eq: Tone.EQ3; gainDb: number }): void {
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
    if (through) np.connect(through.eq); else np.toDestination();
    np.volume.value = old.volume.value;                        // 保留当前音量
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
  stopAudition(): void {
    if (this.auditionSchedId != null) { Tone.getTransport().clear(this.auditionSchedId); this.auditionSchedId = undefined; }
    this.auditionQueued = false;
    if (this.auditionPlayer) { try { this.auditionPlayer.stop(); } catch { /* */ } this.auditionPlayer.dispose(); this.auditionPlayer = null; }
    this.auditionId = null;
  }
  auditioningId(): string | null { return this.auditionId; }
  /** 试听播放线相位 0..1;没在试听该 id / 还在排队 → null。 */
  auditionPhase(id: string): number | null {
    if (!this.auditionPlayer || this.auditionId !== id || this.auditionQueued || this.auditionDur <= 0) return null;
    const el = Tone.now() - this.auditionStart;
    return el <= 0 ? 0 : (el % this.auditionDur) / this.auditionDur;
  }

  dispose(): void { this.disposeTimers.forEach((t) => clearTimeout(t)); this.disposeTimers.clear(); this.stopTransport(); this.clearAll(); this.stopAudition(); }

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
  /** 下一个小节边界(量化固定 1 bar)。 */
  private nextBar(): string {
    const bar = parseInt(String(Tone.getTransport().position).split(':')[0], 10);
    return `${bar + 1}:0:0`;
  }
}
