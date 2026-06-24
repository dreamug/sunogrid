'use client';
// §36 渲染 spike 的 dev 页(throwaway):/dev/warp-spike。挂载即跑 runWarpSpike,画段边/缝 + 给试听。
// 验证分段 warp 后可删。
import { useEffect, useRef, useState } from 'react';
import { runWarpSpike, type SpikeResult } from '@/audio/warpSpike';

export default function WarpSpikePage() {
  const [res, setRes] = useState<SpikeResult | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const acRef = useRef<AudioContext | null>(null);
  const srcRef = useRef<AudioBufferSourceNode | null>(null);
  const baseCv = useRef<HTMLCanvasElement>(null);
  const pwCv = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    runWarpSpike()
      .then((r) => { setRes(r); (window as unknown as { __spike: unknown }).__spike = r; })
      .catch((e) => setErr(String(e?.message || e)));
  }, []);

  useEffect(() => {
    if (!res) return;
    const m = res.metrics, n = m.targetSamples;
    const nominalBeat2 = Math.round(m.pin.beat * (60 / m.bpm) * m.sampleRate); // 拍 2 名义位(两图同基准)
    const draw = (cv: HTMLCanvasElement | null, buf: AudioBuffer, joins: number[]) => {
      if (!cv) return;
      const W = cv.width, H = cv.height, ch = buf.getChannelData(0), mid = H / 2;
      const c = cv.getContext('2d')!; c.clearRect(0, 0, W, H); c.fillStyle = '#1c1b19'; c.fillRect(0, 0, W, H);
      c.strokeStyle = '#c4ced8'; c.beginPath();
      for (let x = 0; x < W; x++) { const i = Math.floor((x / W) * n); const y = mid - ch[i] * mid * 0.95; if (x === 0) c.moveTo(x, y); else c.lineTo(x, y); }
      c.stroke();
      c.strokeStyle = '#c2724f'; c.lineWidth = 1.5; const bx = (nominalBeat2 / n) * W; c.beginPath(); c.moveTo(bx, 0); c.lineTo(bx, H); c.stroke(); c.lineWidth = 1;
      c.strokeStyle = '#7cd17c'; for (const j of joins) { const jx = (j / n) * W; c.beginPath(); c.moveTo(jx, 0); c.lineTo(jx, H); c.stroke(); } // 绿=段边交叉淡化处
    };
    draw(baseCv.current, res.baseline, []);
    draw(pwCv.current, res.piecewise, [m.joinSample]);
  }, [res]);

  const play = (buf: AudioBuffer) => {
    srcRef.current?.stop();
    const ac = acRef.current ?? (acRef.current = new AudioContext());
    const s = ac.createBufferSource(); s.buffer = buf; s.loop = true; s.connect(ac.destination); s.start(); srcRef.current = s;
  };
  const stop = () => { srcRef.current?.stop(); srcRef.current = null; };

  const m = res?.metrics;
  const box: React.CSSProperties = { background: '#232220', border: '1px solid #39352f', borderRadius: 3, padding: '10px 13px', fontFamily: 'ui-monospace,Menlo,monospace', fontSize: 12, color: '#ece9e3', whiteSpace: 'pre-wrap' };
  const btn: React.CSSProperties = { background: '#c2724f', color: '#2a150b', border: 'none', borderRadius: 3, padding: '7px 16px', cursor: 'pointer', marginRight: 8, fontSize: 13 };

  return (
    <div style={{ background: '#1c1b19', minHeight: '100vh', color: '#ece9e3', padding: 24, fontFamily: '-apple-system,system-ui,sans-serif' }}>
      <h2 style={{ fontWeight: 500 }}>§36 warp marker — 渲染 spike</h2>
      <p style={{ color: '#a39d92', fontSize: 13 }}>同一显式排帧渲染器:单段(baseline)vs 2 段(把源 45824 钉到拍 2)。量稳态圈的段边/缝跳变 ÷ 噪声底。</p>
      {err && <div style={{ ...box, color: '#cf8a7a' }}>ERROR: {err}</div>}
      {!res && !err && <div style={box}>rendering… (signalsmith 离线渲 2×4 圈,约几秒)</div>}
      {m && (
        <>
          <div style={{ ...box, color: m.verdict.startsWith('PASS') ? '#7cd17c' : '#c2a24f', marginBottom: 14 }}>{m.verdict}</div>
          <div style={{ marginBottom: 6, fontSize: 11, color: '#6f6a60' }}>BASELINE（单段;橙线=拍 2 名义位 → 瞬态应在它左侧 ≈拍1.8）</div>
          <canvas ref={baseCv} width={900} height={120} style={{ width: '100%', height: 120, border: '1px solid #39352f', borderRadius: 3, display: 'block', marginBottom: 12 }} />
          <div style={{ marginBottom: 6, fontSize: 11, color: '#6f6a60' }}>PIECEWISE（2 段;同一橙线 → 同一瞬态应右移到拍 2 附近）</div>
          <canvas ref={pwCv} width={900} height={120} style={{ width: '100%', height: 120, border: '1px solid #39352f', borderRadius: 3, display: 'block', marginBottom: 14 }} />
          <div style={{ marginBottom: 14 }}>
            <button style={btn} onClick={() => play(res!.baseline)}>▶ baseline (loop)</button>
            <button style={btn} onClick={() => play(res!.piecewise)}>▶ piecewise (loop)</button>
            <button style={{ ...btn, background: '#322f2b', color: '#ece9e3' }} onClick={stop}>■ stop</button>
          </div>
          <div style={box}>{JSON.stringify({
            sampleRate: m.sampleRate, bpm: m.bpm, totalBeats: m.totalBeats, targetSamples: m.targetSamples, pin: m.pin, joinSample: m.joinSample,
            baseRms: m.baseRms, basePeak: m.basePeak, pwRms: m.pwRms, pwPeak: m.pwPeak,
            medDelta: m.medDelta, joinPeak: m.joinPeak, joinRatio: m.joinRatio, loopSeamRatio: m.loopSeamRatio,
          }, null, 2)}</div>
        </>
      )}
    </div>
  );
}
