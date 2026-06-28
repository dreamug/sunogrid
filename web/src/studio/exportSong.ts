'use client';
// §32 总混音导出 —— 把 Song 模式整首歌离线渲成一个 AudioBuffer(再由 ExportDialog 编码成 WAV/MP3 下载)。
// 核心:Tone.Offline 把全局 context 临时换成 OfflineAudioContext → 复用 live 的同一套节点构造
// (FxBus/XYPad/三段 EQ/softClipCurve),配一条确定性预排时间线(所有 voice 起停 + XY 自动化采样点都
// transport.scheduleOnce 预排),保证「导出 = 你听到的那一版」。时间线按 §37 Song 多轨的 songStartBar/songLane 定位。
// ⚠ 本环境(headless)测不了音频,音色正确性须真浏览器 A/B(尤其混响尾巴 / XY 扫滤波),见 PRODUCT.md §32.1/§32.6。
import * as Tone from 'tone';
import type { ApiSound } from '@/studio/api';
import type { FxConfig, Session, XYProgram } from '@/contracts';
import { activeInstruments, resolveInstruments, sessionBars, sessionRepeats, sessionSongEndBar, sessionSongStartBar } from '@/contracts';
import { buildBuffer } from './realLibrary';
import { FxBus } from '@/audio/fxBus';
import { XYPad } from '@/audio/xyPad';
import { softClipCurve, makeShelfEq } from '@/audio/masterChain';
import { sampleXY, sampleAuto, sortPoints, volGain } from './xyAutomation';

const SR = 48000; // 同 collage bake 的 buildCollageBuffer 采样率
const PROGS: XYProgram[] = ['filter', 'slicer', 'delay', 'brake'];

export interface ExportInput {
  sessions: Session[];                    // 全曲 session(按 index 顺序 = §20 线性顺序)
  soundsById: Map<string, ApiSound>;      // 库(给 buildBuffer 解析 soundId)
  fx: FxConfig;                           // 主总线 FX(§17)+ XY 配置(§21)
  bpm: number;
  beatsPerBar: number;
  masterVolDb: number;                    // 顶栏主音量推子(mix 的一部分,导出按它渲;软削波在其后兜底)
}

export interface SongBlock { session: Session; startBar: number; endBar: number; lenBars: number; }
export interface ExportPlan { blocks: SongBlock[]; totalBars: number; totalSec: number; enabledCount: number; }

/** 编排成定位 block 列表:session 可在不同 lane/不同 startBar 并行重叠。 */
export function planSong(input: Pick<ExportInput, 'sessions' | 'bpm' | 'beatsPerBar'>): ExportPlan {
  const barSec = (input.beatsPerBar * 60) / input.bpm;
  const blocks: SongBlock[] = [];
  let totalBars = 0, enabledCount = 0;
  for (const s of input.sessions) {
    const lenBars = sessionRepeats(s) * sessionBars(s);
    const startBar = sessionSongStartBar(s);
    const endBar = sessionSongEndBar(s);
    blocks.push({ session: s, startBar, endBar, lenBars });
    enabledCount += activeInstruments(s).length;
    totalBars = Math.max(totalBars, endBar);
  }
  blocks.sort((a, b) => a.startBar - b.startBar);
  return { blocks, totalBars, totalSec: totalBars * barSec, enabledCount };
}

export interface RenderProgress { phase: 'prepare' | 'render' | 'done'; done: number; total: number; }

/** 离线渲染整首歌 → AudioBuffer(2ch @ 48k)。onProgress 报「预渲 buffer x/N → 渲染 → 完成」。 */
export async function renderSong(input: ExportInput, onProgress?: (p: RenderProgress) => void): Promise<AudioBuffer> {
  const plan = planSong(input);
  if (plan.totalSec <= 0 || plan.enabledCount === 0) throw new Error('空工程:没有可导出的乐器(给 session 里放点乐器再导出)');
  const barSec = (input.beatsPerBar * 60) / input.bpm;

  // [1] 预渲每个 block 每件 enabled 乐器的 buffer(在外部 ctx,带 warp-render 缓存)。key 含 session.id 防跨块撞 id。
  const bufKey = (sid: string, iid: string) => `${sid}|${iid}`;
  const bufById = new Map<string, AudioBuffer>();
  let prepared = 0;
  for (const blk of plan.blocks) {
    for (const inst of resolveInstruments(blk.session)) {
      if (!inst.enabled) continue;
      try { const buf = await buildBuffer(inst, input.bpm, input.soundsById); if (buf) bufById.set(bufKey(blk.session.id, inst.id), buf); }
      catch { /* 单件失败不阻断整首;该乐器静默 */ }
      onProgress?.({ phase: 'prepare', done: ++prepared, total: plan.enabledCount });
    }
  }

  onProgress?.({ phase: 'render', done: 0, total: 1 });

  // [2] Tone.Offline 复刻信号链 + 时间线。
  const rendered = await Tone.Offline(async () => {
    const transport = Tone.getTransport();
    transport.bpm.value = input.bpm;

    // master 段:乐器汇入 master(主音量)→ XY insert → 软削波天花板 → destination(同 studioEngine.init)。
    const master = new Tone.Volume(input.masterVolDb);
    const xy = new XYPad(input.bpm);
    const clip = new Tone.WaveShaper(softClipCurve()); clip.oversample = '4x';
    master.connect(xy.input); xy.output.connect(clip); clip.toDestination();
    xy.setXy(input.fx.xy); // master arm(on/off)

    // FX 总线(§17 失真/延迟/混响 return);混响 IR 必须 await(命门 32.1)。
    const fxBus = new FxBus(input.bpm, master);
    fxBus.setAll(input.fx);
    await fxBus.ready();

    for (const blk of plan.blocks) {
      const t0 = blk.startBar * barSec, t1 = blk.endBar * barSec;
      // §41 per-block 输出 gain(音量自动化落点,镜像 live 引擎 sessionGain):干声经此再进 master;send 仍在 panner 分叉(方案 A:只缩干声)。
      const blkGain = new Tone.Gain(1); blkGain.connect(master);
      // 该块的乐器:同 loadInstrument 的链 Player → EQ → panner → [blkGain] → master(+ 3 条 aux send),sync 到 transport,块内连续循环、块末停。
      for (const inst of resolveInstruments(blk.session)) {
        if (!inst.enabled) continue;
        const buf = bufById.get(bufKey(blk.session.id, inst.id));
        if (!buf) continue;
        const player = new Tone.Player(buf);
        player.loop = true; player.loopStart = 0; player.loopEnd = buf.duration;
        player.volume.value = inst.mixer.gainDb;
        const eq = makeShelfEq();
        eq.low.gain.value = inst.mixer.eq.lowDb; eq.mid.gain.value = inst.mixer.eq.midDb; eq.high.gain.value = inst.mixer.eq.highDb;
        const panner = new Tone.Panner(Math.max(-1, Math.min(1, inst.mixer.pan)));
        player.chain(eq.low, eq.mid, eq.high, panner, blkGain);
        const send = (amt: number, dest: Tone.ToneAudioNode) => { const g = new Tone.Gain(Math.max(0, Math.min(1, amt))); panner.connect(g); g.connect(dest); };
        send(inst.sends.dist, fxBus.distInput); send(inst.sends.delay, fxBus.delayInput); send(inst.sends.reverb, fxBus.reverbInput);
        player.sync().start(t0).stop(t1);
      }
      // §41 音量自动化:该块按 1/8 bar 栅格预排 blkGain 增益(纯自动化,无 live 手动接管);无 volAuto → 恒 1。
      const vol = blk.session.volAuto;
      if (vol && vol.length) {
        const pts = sortPoints(vol), stepSec = barSec / 8;
        for (let t = t0; t <= t1 + 1e-6; t += stepSec) {
          const at = Math.min(t, t1), localBar = (at - t0) / barSec, g = volGain(sampleAuto(pts, localBar));
          transport.scheduleOnce((time) => blkGain.gain.setValueAtTime(g, time), at);
        }
      }
      // XY 自动化(§26):该块每个激活 program 在块内按栅格预排采样点(纯自动化,无 live 的手动接管/latch/spring)。
      const set = blk.session.xyAuto;
      if (set && input.fx.xy.on) {
        for (const program of PROGS) {
          const auto = set[program];
          if (!auto || !auto.x.length || !auto.y.length) continue;
          transport.scheduleOnce(() => xy.setActive(program, true), t0);
          const stepSec = barSec / 8; // 1/8 bar 栅格(≈一帧密度,够平滑)
          let first = true;
          for (let t = t0; t <= t1 + 1e-6; t += stepSec) {
            const at = Math.min(t, t1), localBar = (at - t0) / barSec;
            const { x, y } = sampleXY(program, auto, localBar);
            const immediate = first; first = false; // 块首瞬时设值(防头一拍停在中性再滑过去,同 §26.4#3)
            transport.scheduleOnce(() => xy.setValue(program, x, y, immediate), at);
          }
          transport.scheduleOnce(() => xy.setActive(program, false), t1);
        }
      }
    }

    transport.start(0);
  }, plan.totalSec, 2, SR);

  onProgress?.({ phase: 'done', done: 1, total: 1 });
  return rendered.get() as AudioBuffer;
}

/** AudioBuffer → 声道数组(导出编码用)。 */
export function bufferChannels(buf: AudioBuffer): Float32Array[] {
  const chs: Float32Array[] = [];
  for (let c = 0; c < buf.numberOfChannels; c++) chs.push(buf.getChannelData(c));
  return chs;
}
