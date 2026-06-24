'use client';
// §36 渲染验证 spike —— 直接驱动**生产** warpClip(单段 vs 分段),确认 phase-2 代码端到端对。
// 用法:开 /dev/warp-spike,听 baseline / piecewise,看波形 + 指标。验完即可删本文件 + 该页。
import { decodeAsset } from '@/studio/realLibrary';
import { sliceChannelsPadded, warpClip, toAudioBuffer } from '@/audio/signalsmithWarp';

const rmsOf = (ch: Float32Array, from: number, to: number) => { let s = 0, c = 0; for (let i = Math.max(0, from); i < to && i < ch.length; i++) { s += ch[i] * ch[i]; c++; } return c ? Math.sqrt(s / c) : 0; };
const peakOf = (ch: Float32Array, from: number, to: number) => { let p = 0; for (let i = Math.max(0, from); i < to && i < ch.length; i++) { const a = Math.abs(ch[i]); if (a > p) p = a; } return p; };
const deltaAt = (ch: Float32Array, i: number) => (i > 0 && i < ch.length ? Math.abs(ch[i] - ch[i - 1]) : 0);
const medianDelta = (ch: Float32Array, from: number, to: number) => { const ds: number[] = []; for (let i = Math.max(1, from); i < to && i < ch.length; i++) ds.push(Math.abs(ch[i] - ch[i - 1])); ds.sort((a, b) => a - b); return ds.length ? ds[Math.floor(ds.length / 2)] : 0; };

export interface SpikeMetrics {
  sampleRate: number; bpm: number; totalBeats: number; targetSamples: number;
  pin: { src: number; beat: number }; joinSample: number;
  baseRms: number; basePeak: number; pwRms: number; pwPeak: number;
  medDelta: number; joinPeak: number; joinRatio: number; loopSeamRatio: number;
  verdict: string;
}
export interface SpikeResult { metrics: SpikeMetrics; baseline: AudioBuffer; piecewise: AudioBuffer; }

/** 默认 = 那条鼓 fill(80 标注 / 90 主;把源采样 pinSrc 钉到 pinBeat=2)。 */
export async function runWarpSpike(opts?: Partial<{
  assetId: string; startSample: number; endSample: number; bars: number; beatsPerBar: number;
  bpm: number; semitones: number; pinSrc: number; pinBeat: number;
}>): Promise<SpikeResult> {
  const o = {
    assetId: 'cmqs5rb470004xydkknbsk97w', startSample: 0, endSample: 101823, bars: 1, beatsPerBar: 4,
    bpm: 90, semitones: 0, pinSrc: 45824, pinBeat: 2, ...opts,
  };
  const dec = await decodeAsset(o.assetId);
  const sr = dec.sampleRate;
  const sliced = sliceChannelsPadded(dec.channels, o.startSample, o.endSample);
  const totalBeats = o.bars * o.beatsPerBar;
  const targetSamples = Math.round(((o.bars * o.beatsPerBar * 60) / o.bpm) * sr);
  const reqBase = { id: 'spike-base', channels: sliced, sampleRate: sr, nativeBpm: 80, targetBpm: o.bpm, semitones: o.semitones, beatsPerBar: o.beatsPerBar, conditioning: 'trust-tempo' as const, targetBars: o.bars };
  const frac = { srcFrac: (o.pinSrc - o.startSample) / (o.endSample - o.startSample), beatFrac: o.pinBeat / totalBeats };

  const baseline = toAudioBuffer(await warpClip(reqBase));
  const piecewise = toAudioBuffer(await warpClip({ ...reqBase, id: 'spike-pw', warpFracs: [frac] }));

  const bCh = baseline.getChannelData(0), pCh = piecewise.getChannelData(0);
  const joinSample = Math.round(o.pinBeat * (60 / o.bpm) * sr); // 段边名义位(拍2)
  const medDelta = medianDelta(pCh, 0, targetSamples);
  const winPeak = (i: number) => { let m = 0; for (let j = i - 50; j <= i + 50; j++) m = Math.max(m, deltaAt(pCh, j)); return m; };
  const joinPeak = winPeak(joinSample);
  const joinRatio = medDelta > 1e-9 ? joinPeak / medDelta : 0;
  const loopSeamPeak = Math.max(deltaAt(pCh, 1), Math.abs(pCh[targetSamples - 1] - pCh[0]));
  const loopSeamRatio = medDelta > 1e-9 ? loopSeamPeak / medDelta : 0;

  const pwRms = +rmsOf(pCh, 0, targetSamples).toFixed(5);
  const notSilent = pwRms > 0.02;
  const differs = (() => { let m = 0; const N = Math.min(bCh.length, pCh.length); for (let i = 0; i < N; i++) m = Math.max(m, Math.abs(bCh[i] - pCh[i])); return m; })();
  const clean = joinRatio < 8;
  const verdict = (notSilent && clean && differs > 0.1)
    ? `PASS(生产路径)— 分段出声 rms ${pwRms}、与单段确实不同(maxΔ ${differs.toFixed(2)})、段边 ${joinRatio.toFixed(1)}× 噪声底(<8×)。`
    : `CHECK — rms ${pwRms} / maxΔ ${differs.toFixed(2)} / 段边 ${joinRatio.toFixed(1)}×。`;

  return {
    baseline, piecewise,
    metrics: {
      sampleRate: sr, bpm: o.bpm, totalBeats, targetSamples, pin: { src: o.pinSrc, beat: o.pinBeat }, joinSample,
      baseRms: +rmsOf(bCh, 0, targetSamples).toFixed(5), basePeak: +peakOf(bCh, 0, targetSamples).toFixed(5),
      pwRms, pwPeak: +peakOf(pCh, 0, targetSamples).toFixed(5),
      medDelta: +medDelta.toFixed(6), joinPeak: +joinPeak.toFixed(6), joinRatio: +joinRatio.toFixed(2),
      loopSeamRatio: +loopSeamRatio.toFixed(2), verdict,
    },
  };
}
