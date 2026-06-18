'use client';
// M1 音频引擎实现(Tone.js)。
// 职责:主时钟 + 量化启停 + 循环 buffer 播放。不做 warp —— 只接收"已就绪 buffer"。
// 假设:clip buffer 已是主 BPM、整小节(由 M2 保证;M1 demo 用合成 buffer 替代)。
import * as Tone from 'tone';
import type {
  AudioEngine,
  EngineClip,
  EngineEvent,
  EngineListener,
  PadState,
  Quantize,
  TransportPosition,
} from '@/contracts';

interface PadRuntime {
  clip: EngineClip;
  player: Tone.Player;
  state: PadState;
  /** 待触发的量化事件 id(scheduleOnce 返回)。 */
  scheduledId?: number;
  /** 真实起播的上下文时刻 + loop 时长(秒),用于进度条 launch-relative 相位。 */
  startTime?: number;
  loopDur?: number;
}

export class ToneAudioEngine implements AudioEngine {
  private pads = new Map<number, PadRuntime>();
  private quantize: Quantize = '1bar';
  private listeners = new Set<EngineListener>();
  private raf: number | null = null;
  private initialized = false;

  async init(): Promise<void> {
    if (this.initialized) return;
    // 创建(suspended)上下文 + 装载/解码都不需要手势;出声才需要 resume()。
    Tone.getTransport().bpm.value = 120;
    this.initialized = true;
  }

  /** 用户手势(首次点播放/pad/试听)里调用,解锁音频输出。Tone.start 幂等。 */
  async resume(): Promise<void> {
    await Tone.start();
  }

  dispose(): void {
    this.stopTransport();
    this.pads.forEach((p) => p.player.dispose());
    this.pads.clear();
    this.listeners.clear();
  }

  // --- transport / clock ---
  setBpm(bpm: number): void {
    Tone.getTransport().bpm.value = bpm;
    this.emit({ type: 'bpm', bpm });
  }
  getBpm(): number {
    return Tone.getTransport().bpm.value;
  }
  transportBeats(): number {
    const t = Tone.getTransport();
    return t.ticks / t.PPQ; // tick→四分音符(拍)
  }
  setQuantize(q: Quantize): void {
    this.quantize = q;
  }
  startTransport(): void {
    Tone.getTransport().start();
    this.startTicker();
  }
  stopTransport(): void {
    const transport = Tone.getTransport();
    transport.stop();
    transport.cancel(); // 清掉所有待触发的量化事件
    this.pads.forEach((p, i) => {
      p.scheduledId = undefined;
      if (p.state !== 'ready' && p.state !== 'empty') {
        p.player.stop();
        this.setState(i, 'ready');
      }
    });
    this.stopTicker();
    this.emitTransport();
  }
  isPlaying(): boolean {
    return Tone.getTransport().state === 'started';
  }

  // --- clips ---
  loadClip(clip: EngineClip): void {
    this.clearPad(clip.padIndex);
    const player = new Tone.Player(clip.buffer).toDestination();
    player.loop = true;
    player.loopStart = clip.loopStartSample / clip.buffer.sampleRate;
    player.loopEnd = clip.loopEndSample / clip.buffer.sampleRate;
    player.volume.value = clip.gainDb;
    this.pads.set(clip.padIndex, { clip, player, state: 'ready' });
    this.setState(clip.padIndex, 'ready');
  }
  clearPad(padIndex: number): void {
    const p = this.pads.get(padIndex);
    if (!p) return;
    this.clearScheduled(p); // 取消该 pad 待触发的量化事件,避免触到已 dispose 的 player
    p.player.stop();
    p.player.dispose();
    this.pads.delete(padIndex);
    this.setState(padIndex, 'empty');
  }

  // --- quantized launch / stop ---
  // startTransport=false:不碰主走带(给 warp 试听 SCRATCH 用)——走带没跑就直接自由起播(只播这个 sample),走带在跑才量化进入跟整曲一起响。
  launchPad(padIndex: number, startTransport = true): void {
    const p = this.pads.get(padIndex);
    if (!p) return;
    const transport = Tone.getTransport();
    const wasStarted = transport.state === 'started';
    if (!wasStarted && startTransport) {
      transport.start();
      this.startTicker();
    }
    this.clearScheduled(p); // 取消上一次还没触发的排队
    // 走带没在跑(无论是否由本次启动)或关闭量化时立即起;否则排到下一个边界
    if (!wasStarted || this.quantize === 'off') {
      this.fire(p, Tone.now());
      this.setState(padIndex, 'playing');
      return;
    }
    this.setState(padIndex, 'queued');
    p.scheduledId = transport.scheduleOnce((time) => {
      p.scheduledId = undefined;
      this.fire(p, time);
      this.setState(padIndex, 'playing'); // 在 transport 回调里直接翻;早 ~lookahead 无妨
    }, this.nextBoundary());
  }
  stopPad(padIndex: number): void {
    const p = this.pads.get(padIndex);
    if (!p) return;
    // 还在排队(没真正起声)→ 直接取消,回到就绪
    if (p.state === 'queued') {
      this.clearScheduled(p);
      this.setState(padIndex, 'ready');
      return;
    }
    if (p.state !== 'playing') return;
    const transport = Tone.getTransport();
    this.clearScheduled(p);
    if (this.quantize === 'off' || transport.state !== 'started') {
      p.player.stop();
      this.setState(padIndex, 'ready');
      return;
    }
    this.setState(padIndex, 'stopping');
    p.scheduledId = transport.scheduleOnce((time) => {
      p.scheduledId = undefined;
      p.player.stop(time);
      this.setState(padIndex, 'ready');
    }, this.nextBoundary());
  }
  stopAll(): void {
    this.pads.forEach((_p, i) => this.stopPad(i));
  }
  setPadGain(padIndex: number, gainDb: number): void {
    const p = this.pads.get(padIndex);
    if (p) p.player.volume.value = gainDb;
  }

  private auditionPlayer: Tone.Player | null = null;
  private auditionScheduled?: number;
  private auditionStart: number | null = null; // 音频真实起播的上下文时刻;等量化边界时为 null
  private auditionLoopDur = 0;                  // loop 时长(秒)
  /** 试听/预览。quantize=true 且主走带在跑 → 排到下一个整小节边界进入(像 Live);否则立即。 */
  audition(buffer: AudioBuffer, loopStartSample = 0, loopEndSample?: number, quantize = false): void {
    this.stopAudition();
    const p = new Tone.Player(buffer).toDestination();
    p.loop = true;
    p.loopStart = loopStartSample / buffer.sampleRate;
    p.loopEnd = (loopEndSample ?? buffer.length) / buffer.sampleRate;
    this.auditionPlayer = p;
    this.auditionLoopDur = Math.max(0, p.loopEnd - p.loopStart);
    this.auditionStart = null;
    const transport = Tone.getTransport();
    if (quantize && transport.state === 'started' && this.quantize !== 'off') {
      this.auditionScheduled = transport.scheduleOnce((time) => {
        this.auditionScheduled = undefined;
        if (this.auditionPlayer === p && !p.disposed && p.loaded) { p.start(time); this.auditionStart = time; }
      }, this.nextBoundary());
    } else {
      p.start();
      this.auditionStart = Tone.now();
    }
  }
  stopAudition(): void {
    if (this.auditionScheduled != null) { Tone.getTransport().clear(this.auditionScheduled); this.auditionScheduled = undefined; }
    if (this.auditionPlayer) {
      this.auditionPlayer.stop();
      this.auditionPlayer.dispose();
      this.auditionPlayer = null;
    }
    this.auditionStart = null;
  }
  /** 预览播放线相位 0..1:按真实起播时刻 + loop 时长算。未在预览→null;已排队未起声→0。 */
  auditionPhase(): number | null {
    if (!this.auditionPlayer) return null;
    if (this.auditionStart == null || this.auditionLoopDur <= 0) return 0;
    const el = Tone.now() - this.auditionStart;
    if (el <= 0) return 0; // 量化边界(lookahead)还没真正到
    return (el % this.auditionLoopDur) / this.auditionLoopDur;
  }

  /** pad 进度相位 0..1:按该 pad 真实起播时刻 + loop 时长算(重启即归零;launch 量化 → 仍锁主时钟)。
   *  没在播返回 null。 */
  padPhase(padIndex: number): number | null {
    const p = this.pads.get(padIndex);
    if (!p || p.state !== 'playing' || p.startTime == null || !p.loopDur) return null;
    const el = Tone.now() - p.startTime;
    if (el <= 0) return 0;
    return (el % p.loopDur) / p.loopDur;
  }

  on(listener: EngineListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  // --- internals ---
  private fire(p: PadRuntime, time: number): void {
    if (p.player.disposed || !p.player.loaded) return; // 守卫:player 已释放/未加载
    if (p.player.state === 'started') p.player.restart(time);
    else p.player.start(time);
    p.startTime = time; // 每次起播(含 restart)刷新 → 进度条重启即归零
    p.loopDur = Math.max(0, (p.clip.loopEndSample - p.clip.loopStartSample) / p.clip.buffer.sampleRate);
  }
  private clearScheduled(p: PadRuntime): void {
    if (p.scheduledId != null) {
      Tone.getTransport().clear(p.scheduledId);
      p.scheduledId = undefined;
    }
  }
  private setState(padIndex: number, state: PadState): void {
    const p = this.pads.get(padIndex);
    if (p) p.state = state;
    this.emit({ type: 'padState', padIndex, state });
  }
  private emit(e: EngineEvent): void {
    this.listeners.forEach((l) => l(e));
  }
  /** 下一个量化边界的 transport 时间(BarsBeatsSixteenths)。 */
  private nextBoundary(): string {
    const [barS, beatS] = String(Tone.getTransport().position).split(':');
    const bar = parseInt(barS, 10);
    const beat = parseFloat(beatS);
    switch (this.quantize) {
      case '1/4': {
        const nb = Math.floor(beat) + 1;
        return nb >= 4 ? `${bar + 1}:0:0` : `${bar}:${nb}:0`;
      }
      case '1/2':
        return beat < 2 ? `${bar}:2:0` : `${bar + 1}:0:0`;
      case '1bar':
      default:
        return `${bar + 1}:0:0`;
    }
  }
  private startTicker(): void {
    if (this.raf != null) return;
    const tick = () => {
      this.emitTransport();
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  }
  private stopTicker(): void {
    if (this.raf != null) {
      cancelAnimationFrame(this.raf);
      this.raf = null;
    }
  }
  private emitTransport(): void {
    const [b, be, si] = String(Tone.getTransport().position).split(':');
    const position: TransportPosition = {
      bar: parseInt(b, 10) + 1,
      beat: Math.floor(parseFloat(be)) + 1,
      sixteenth: Math.floor(parseFloat(si)) + 1,
    };
    this.emit({ type: 'transport', position, isPlaying: this.isPlaying() });
  }
}
