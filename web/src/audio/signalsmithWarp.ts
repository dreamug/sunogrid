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
  const { channels, sampleRate, nativeBpm, targetBpm, semitones, beatsPerBar, targetBars, warpFracs } = req;
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

  // §36 分段 warp:有中间控制点 → 走分段渲染(每段单渲 + 段边交叉淡化)。无 → 下面的单段恒速(产物与历史逐字一致,缓存兼容)。
  if (warpFracs && warpFracs.length > 0) {
    return warpClipPiecewise(req, { bars, targetSamples, semitones });
  }

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

/** 把每声道一段重复 n 次拼一条(给「渲 3 份取中间份」跳起播暖机用)。 */
const repeatCh = (seg: Float32Array[], n: number): Float32Array[] => seg.map((ch) => { const o = new Float32Array(ch.length * n); for (let k = 0; k < n; k++) o.set(ch, k * ch.length); return o; });

/**
 * 单段恒速一次性拉伸(复用单 schedule 路径,已验):segSrc → outSamples + tailX 个稳态样本(给段边交叉淡化用)。
 * 渲 3 份取「中间份 + 进入第三份 tailX」→ 跳过 signalsmith 起播暖机/latency 且整段稳态;rate = inLen/outSamples。
 */
async function stretchSegmentSteady(SignalsmithStretch: (ctx: BaseAudioContext, o?: object) => Promise<{ addBuffers(b: Float32Array[]): Promise<number>; schedule(o: Record<string, number | boolean>): Promise<unknown>; connect(n: AudioNode): unknown }>, segSrc: Float32Array[], sampleRate: number, semitones: number, outSamples: number, tailX: number): Promise<Float32Array[]> {
  const numCh = segSrc.length;
  const inLen = segSrc[0].length;
  const rate = inLen / outSamples;
  const rep = repeatCh(segSrc, 3);
  const total = 3 * outSamples + Math.round(0.1 * sampleRate);
  const ctx = new OfflineAudioContext(numCh, total, sampleRate);
  const st = await SignalsmithStretch(ctx, { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [numCh] });
  await st.addBuffers(rep);
  await st.schedule({ output: 0, input: 0, rate, semitones, loopStart: 0, loopEnd: rep[0].length / sampleRate, active: true });
  st.connect((ctx as OfflineAudioContext).destination);
  const r = await (ctx as OfflineAudioContext).startRendering();
  return Array.from({ length: numCh }, (_, c) => r.getChannelData(c).slice(outSamples, 2 * outSamples + tailX)); // 中间份 + tailX
}

/**
 * §36 分段 warp 渲染:warpFracs 把 trim 切成段,每段恒速拉伸到其输出长度(+X 尾),等功率淡入淡出后**环形 overlap-add**
 * 拼成正好 targetSamples 一圈 —— 段边与「末↔首」loop 缝用同一套交叉淡化(末段尾 wrap 回叠首段头),无零隙、无方向错。
 * spike 实测段边/缝跳变 ~3–6× 噪声底,与单段听感一致。
 */
async function warpClipPiecewise(req: WarpRequest, ctxv: { bars: number; targetSamples: number; semitones: number }): Promise<WarpDone> {
  const { default: SignalsmithStretch } = await import('signalsmith-stretch');
  const { channels, sampleRate, warpFracs } = req;
  const { bars, targetSamples, semitones } = ctxv;
  const numCh = channels.length;
  const sliceLen = channels[0].length;
  // 完整控制点(输出域用采样):首=(0,0)、中间点、尾=(sliceLen,targetSamples)。
  const fr = (warpFracs ?? []).slice().sort((a, b) => a.beatFrac - b.beatFrac);
  const cps = [{ src: 0, out: 0 }, ...fr.map((f) => ({ src: Math.round(f.srcFrac * sliceLen), out: Math.round(f.beatFrac * targetSamples) })), { src: sliceLen, out: targetSamples }];
  const outLens = cps.slice(0, -1).map((a, i) => Math.max(1, cps[i + 1].out - a.out));
  const X = Math.max(1, Math.min(Math.round(0.006 * sampleRate), ...outLens.map((l) => Math.floor(l / 3)))); // 交叉淡化长度;至少 1 样本,否则极短段(outLen<3)X=0 → 缝处无淡化爆音

  // 每段渲到 outLen+X(多出的 X 尾用于和下一段头叠混;末段的 X 尾 wrap 回叠首段头 = loop 缝)。
  const parts: Float32Array[][] = [];
  for (let i = 0; i < cps.length - 1; i++) {
    const a = cps[i], b = cps[i + 1];
    const segSrc = channels.map((ch) => ch.slice(Math.max(0, a.src), Math.max(a.src + 1, b.src)));
    parts.push(await stretchSegmentSteady(SignalsmithStretch as never, segSrc, sampleRate, semitones, outLens[i], X));
  }

  // 每段头 X 淡入(sin)、尾 X 淡出(cos):重叠处 sin²+cos²=1 保功率。环形 overlap-add 到 targetSamples(末段尾 wrap)。
  const out = Array.from({ length: numCh }, () => new Float32Array(targetSamples));
  let off = 0;
  for (let p = 0; p < parts.length; p++) {
    const len = outLens[p], L = len + X;
    for (let c = 0; c < numCh; c++) {
      const dst = out[c], src = parts[p][c];
      for (let i = 0; i < L; i++) {
        let g = 1;
        if (i < X) g *= Math.sin(((i + 0.5) / X) * (Math.PI / 2));       // 头淡入(与上一段/末段尾叠)
        if (i >= len) g *= Math.cos(((i - len + 0.5) / X) * (Math.PI / 2)); // 尾淡出(与下一段/首段头叠)
        const o = (off + i) % targetSamples;
        dst[o] += src[i] * g;
      }
    }
    off += len;
  }
  return { id: req.id, type: 'done', channels: out, sampleRate, bars, loopStartSample: 0, loopEndSample: targetSamples };
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
