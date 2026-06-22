'use client';
// M2 warp 处理器:OfflineAudioContext + signalsmith-stretch(WASM)离线渲染。
// 不放 Web Worker —— WASM 是 AudioWorklet,需要 AudioContext;startRendering 异步,不卡主线程。
import type { WarpDone, WarpRequest } from '@/contracts';

/**
 * 把一段素材 conditioning(snap 到整小节)+ 变速到主 BPM + 变调,产出无缝循环 buffer。
 * 做法:让 signalsmith 自动循环输入区,离线渲染多圈,取稳态那一圈(跳过起始 latency)。
 */
export async function warpClip(req: WarpRequest): Promise<WarpDone> {
  const { default: SignalsmithStretch } = await import('signalsmith-stretch');
  const { channels, sampleRate, nativeBpm, targetBpm, semitones, beatsPerBar, targetBars } = req;
  const numCh = channels.length;
  const inDur = channels[0].length / sampleRate;

  // 防御:targetBpm / bars 若是 0 · NaN · ∞(主 BPM 被清空、旧 DB 行 bars 坏值),会让 targetDur 变 ∞/NaN,
  // 进而 OfflineAudioContext 帧数被 ToUint32 成 0 直接崩。统一兜成正常值——宁可渲染一小段也不让整 app 挂。
  const bpb = Number.isFinite(beatsPerBar) && beatsPerBar > 0 ? beatsPerBar : 4;
  const tgtBpm = Number.isFinite(targetBpm) && targetBpm > 0 ? targetBpm : 90;
  // conditioning:把整段输入当作 round(...) 个整小节(snap 到拍格,处理 Suno 的非整小节)
  const barsRaw = targetBars ?? Math.max(1, Math.round((inDur * nativeBpm) / 60 / bpb));
  const bars = Number.isFinite(barsRaw) && barsRaw > 0 ? barsRaw : 1;
  const targetDur = (bars * bpb * 60) / tgtBpm;
  const targetSamples = Math.max(1, Math.round(targetDur * sampleRate));
  const rate = inDur / targetDur; // 输出循环一圈 = targetDur

  // 渲染多圈,取稳态那一圈:跳过起始 latency、规避相位偏移、保证无缝
  const skipLoops = Math.max(1, Math.ceil(0.3 / targetDur));
  const total = Math.max(1, (skipLoops + 1) * targetSamples + Math.round(0.05 * sampleRate));

  const ctx = new OfflineAudioContext(numCh, total, sampleRate);
  const stretch = await SignalsmithStretch(ctx, {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [numCh],
  });
  await stretch.addBuffers(channels);
  await stretch.schedule({
    output: 0, input: 0, rate, semitones, loopStart: 0, loopEnd: inDur, active: true,
  });
  stretch.connect(ctx.destination);
  const rendered = await ctx.startRendering();

  const startSample = skipLoops * targetSamples;
  // loop 缝去咔哒:把每条声道末 X 样本与"循环起点前 X 样本"(自然 pre-roll = rendered[A-X..A),
  // 与末段相位差正好一圈 → ≈等值)线性交叉淡化。结果末样本落到 rendered[A-1]、首样本仍是 rendered[A] →
  // 循环接缝 = 连续渲染里相邻两样本 rendered[A-1]→rendered[A] 的自然过渡,消掉 warp 稳态循环的残余阶跃(实测 ~-20dBFS)。
  // ⚠ 这是循环属性(每圈缝),该烘进 buffer;起播头部的去咔哒不在此(那是一次性的,由播放器 fadeIn 负责,烘进去会每圈淡掉下拍)。
  const X = Math.min(Math.round(0.005 * sampleRate), Math.floor(targetSamples / 8), startSample);
  const out: Float32Array[] = [];
  for (let c = 0; c < numCh; c++) {
    const ch = rendered.getChannelData(c);
    const seg = ch.slice(startSample, startSample + targetSamples);
    for (let i = 0; i < X; i++) {
      const t = (i + 0.5) / X;                       // 0→1
      const preRoll = ch[startSample - X + i];       // rendered[A-X+i]:与 seg[T-X+i] 同相位(差一圈)
      seg[targetSamples - X + i] = seg[targetSamples - X + i] * (1 - t) + preRoll * t; // 等值信号 → 线性淡化和恒定,不抬不掉
    }
    out.push(seg);
  }
  return {
    id: req.id,
    type: 'done',
    channels: out,
    sampleRate,
    bars,
    loopStartSample: 0,
    loopEndSample: targetSamples,
  };
}

/** 按 [start,end) 取源(可越界):越界部分补零,保证返回长度恰为 end-start(平移/裁切自由,渲染长度仍准确)。 */
export function sliceChannelsPadded(channels: Float32Array[], start: number, end: number): Float32Array[] {
  const len = Math.max(1, end - start);
  return channels.map((ch) => {
    const out = new Float32Array(len);
    const from = Math.max(0, start);
    const to = Math.min(ch.length, end);
    if (to > from) out.set(ch.subarray(from, to), from - start);
    return out;
  });
}

/** WarpDone.channels → AudioBuffer(给引擎/播放)。 */
export function toAudioBuffer(done: WarpDone): AudioBuffer {
  const buf = new AudioBuffer({
    length: done.channels[0].length,
    sampleRate: done.sampleRate,
    numberOfChannels: done.channels.length,
  });
  done.channels.forEach((ch, c) => buf.copyToChannel(ch, c));
  return buf;
}
