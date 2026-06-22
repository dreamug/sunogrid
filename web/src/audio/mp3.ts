'use client';
// §32 总混音导出:声道(Float32)→ MP3 字节,用 @breezystack/lamejs(lamejs 维护分支,纯前端 JS 编码,无后端)。
// 浏览器原生无 MP3 编码(MediaRecorder 只能 webm/opus),故引这一个库;WAV 走 wav.ts 零依赖。
import { Mp3Encoder } from '@breezystack/lamejs';

function toInt16(ch: Float32Array): Int16Array {
  const out = new Int16Array(ch.length);
  for (let i = 0; i < ch.length; i++) { const s = ch[i] < -1 ? -1 : ch[i] > 1 ? 1 : ch[i]; out[i] = s < 0 ? s * 0x8000 : s * 0x7fff; }
  return out;
}

/** 1~2 声道 Float32 → MP3 Uint8Array(立体声;码率默认 256kbps;按 1152 样本/块喂编码器)。 */
export function encodeMp3(channels: Float32Array[], sampleRate: number, kbps = 256): Uint8Array {
  const numCh = channels.length >= 2 ? 2 : 1;
  const enc = new Mp3Encoder(numCh, sampleRate, kbps);
  const left = toInt16(channels[0] ?? new Float32Array(0));
  const right = numCh === 2 ? toInt16(channels[1] ?? channels[0]) : null;
  const blocks: Uint8Array[] = [];
  const BLOCK = 1152; // MP3 帧的样本数(lamejs 推荐分块粒度)
  for (let i = 0; i < left.length; i += BLOCK) {
    const l = left.subarray(i, i + BLOCK);
    const buf = right ? enc.encodeBuffer(l, right.subarray(i, i + BLOCK)) : enc.encodeBuffer(l);
    if (buf.length) blocks.push(buf);
  }
  const tail = enc.flush();
  if (tail.length) blocks.push(tail);
  let total = 0; for (const b of blocks) total += b.length;
  const out = new Uint8Array(total);
  let off = 0; for (const b of blocks) { out.set(b, off); off += b.length; }
  return out;
}
