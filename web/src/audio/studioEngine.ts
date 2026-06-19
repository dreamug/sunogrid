'use client';
// Studio 音频引擎 —— 区别于 ToneAudioEngine(loop 机那条),studio 走这条:
// 在 M1 的"量化 launch/stop"基础上,每件乐器多挂一条 mixer 链 Player → EQ3 → Panner → (volume) → dest。
// 主走带 = Tone.Transport(全局唯一时钟);乐器"开关"= 量化到下一个小节边界的 launch/stop。
// 假设:每件乐器的 buffer 已是整小节、可无缝循环(sample=warp 产物 / collage=bake 产物)。
import * as Tone from 'tone';
import type { Mixer, Quantize } from '@/contracts';

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
  private retempoSchedId?: number; // 改速:排在下一小节边界的"翻速+换 buffer"协调点
  private retempoTarget?: number;  // 改速目标 BPM(边界前停走带也要把 transport 落到它,免重启后 buffer 与 transport 不匹配)
  private retempoBuilds?: Map<string, Promise<AudioBuffer | null>>; // 改速在渲的新 buffer;边界前停走带 → 由 stopTransport 就地兜底应用(否则只剩旧长度 buffer 配新速度 = drift)
  private quantize: Quantize = '1bar';                              // 启停量化粒度(顶栏 Quantize 选择器);launch/stop/audition 用 nextBoundary 读它
  private split?: Tone.Split; private meterL?: Tone.Meter; private meterR?: Tone.Meter; // 总输出 L/R 电平表(并联抽各乐器 panner,不改主信号路径)
  private clickSynth?: Tone.Synth; private clickVol?: Tone.Volume;  // 节拍器:click synth → 音量节点 → dest(+并联进总表)
  private metroOn = false;
  private metroInterval: 'beat' | 'bar' | '2bar' | '4bar' = 'beat'; // 几小节响一次:每拍/每小节/每2小节/每4小节
  private metroRepeatId?: number; // 节拍器的 scheduleRepeat id —— 每次 startTransport 重注册(stopTransport 的 t.cancel() 会清掉它)

  init(bpm: number, beatsPerBar = 4): void {
    this.beatsPerBar = beatsPerBar;
    Tone.getTransport().bpm.value = bpm;
    if (!this.inited) {
      // 总输出 L/R 电平表(并联抽头)
      this.split = new Tone.Split();
      this.meterL = new Tone.Meter(); this.meterR = new Tone.Meter();
      this.split.connect(this.meterL, 0, 0);
      this.split.connect(this.meterR, 1, 0);
      // 节拍器:click → 音量 → 主输出(并联进总表,让总电平也含 click)
      this.clickVol = new Tone.Volume(-8).toDestination();
      this.clickVol.connect(this.split);
      this.clickSynth = new Tone.Synth({ oscillator: { type: 'triangle' }, envelope: { attack: 0.001, decay: 0.045, sustain: 0, release: 0.02 } }).connect(this.clickVol);
      this.inited = true;
    }
  }

  // --- 主输出:音量(dest 上的 Volume) + L/R 电平 ---
  setMasterVolume(db: number): void { Tone.getDestination().volume.value = db; }
  masterLevel(): [number, number] {
    const norm = (m?: Tone.Meter): number => { const v = m?.getValue(); const db = typeof v === 'number' ? v : Array.isArray(v) ? v[0] : -Infinity; return isFinite(db) ? Math.max(0, Math.min(1, (db + 48) / 48)) : 0; };
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
  setBpm(bpm: number): void { Tone.getTransport().bpm.value = bpm; }

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
    if (this.split) panner.connect(this.split); // 再并联进总输出 L/R 表
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
    // 立刻启动所有 re-warp;记录就绪结果(到边界时已渲完的直接换、没渲完的顶速桥接)。
    const builds = new Map<string, Promise<AudioBuffer | null>>();
    const ready = new Map<string, AudioBuffer | null>();
    this.voices.forEach((_, id) => { const p = getBuffer(id).catch(() => null); builds.set(id, p); p.then((b) => ready.set(id, b ?? null)); });
    this.retempoBuilds = builds; // 边界前停走带的兜底应用句柄(边界真正触发时清掉,改由边界回调负责应用)
    if (t.state !== 'started') { // 没在跑:直接翻速 + 渲好就地换(防御;正常由上层 isPlaying 分流)
      t.bpm.value = newBpm;
      this.retempoBuilds = undefined; // 本分支自行应用,不留给 stopTransport
      this.voices.forEach((v, id) => builds.get(id)?.then((b) => b && this.replaceBufferInPlace(v, b)));
      return;
    }
    const ratio = newBpm / oldBpm;
    const XF = 0.012;
    if (this.retempoSchedId != null) { t.clear(this.retempoSchedId); this.retempoSchedId = undefined; } // 作废上一次还没到的改速
    this.retempoTarget = newBpm;
    this.retempoSchedId = t.scheduleOnce((time) => {
      this.retempoSchedId = undefined; this.retempoTarget = undefined; this.retempoBuilds = undefined; // 边界已触发,应用归本回调
      t.bpm.value = newBpm; // B 处翻新速(此前老 buffer 老速正常播,无 drift)
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
          builds.get(id)?.then((b) => { if (b) this.swapBuffer(id, b, v.bars); }); // 就绪后在循环边界补换(swapBuffer 建新 player→自动复位 rate)
        }
      }
      this.voices.forEach((v, id) => { if (v.state !== 'on') builds.get(id)?.then((b) => b && this.replaceBufferInPlace(v, b)); }); // 没出声的:就地换
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
    np.connect(v.eq);
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
      v.scheduledId = t.scheduleOnce((time) => { v.scheduledId = undefined; this.fire(v, time); v.state = 'on'; }, this.nextBoundary());
    } else {
      if (v.state === 'queued') { v.state = 'off'; return; }
      if (v.state !== 'on') return;
      v.state = 'stopping';
      v.scheduledId = t.scheduleOnce((time) => { v.scheduledId = undefined; v.player.stop(time); v.state = 'off'; }, this.nextBoundary());
    }
  }

  startTransport(): void {
    this.stopAudition(); // 走带一开就停掉预览(预览只在走带停时用)
    const t = Tone.getTransport();
    this.scheduleMetro(); // 重挂节拍器(上次 stop 的 t.cancel() 清掉了)
    t.start();
    this.voices.forEach((v) => {
      if (v.wantOn) { this.fire(v, Tone.now()); v.state = 'on'; } else v.state = 'off';
    });
  }
  stopTransport(): void {
    const t = Tone.getTransport();
    // 改速边界前就停 → 仍把 transport 落到目标速 + 把在渲的新 buffer 就地兜底换上(否则重启后旧长度 buffer 配新速度 = drift);scheduleOnce 由下面 t.cancel() 清掉。
    if (this.retempoTarget != null) t.bpm.value = this.retempoTarget;
    if (this.retempoBuilds) { for (const [id, p] of this.retempoBuilds) p.then((b) => { const v = this.voices.get(id); if (v && b) this.replaceBufferInPlace(v, b); }); }
    this.retempoSchedId = undefined; this.retempoTarget = undefined; this.retempoBuilds = undefined;
    t.stop();
    t.cancel();
    this.voices.forEach((v) => {
      this.cancelPending(v);
      v.scheduledId = undefined;
      try { v.player.playbackRate = 1; } catch { /* */ } // 清掉可能残留的顶速桥接
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
      }, this.nextBoundary());
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
