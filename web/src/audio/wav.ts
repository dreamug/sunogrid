'use client';
// 把声道(Float32)编码成 16-bit PCM WAV。
// `encodeWav` → ArrayBuffer(给 Blob 下载,§32 总混音导出);`encodeWavBase64` → base64(warp 渲染落盘 POST /api/warp-render)。
// decodeAudioData 按字节头(RIFF/WAVE)识别,与文件扩展名无关,所以回读能正常解码。

/** 声道数组 → 16-bit PCM WAV 字节(含 44 字节头,交错写样本)。 */
export function encodeWav(channels: Float32Array[], sampleRate: number): ArrayBuffer {
  const numCh = channels.length;
  const len = channels[0]?.length ?? 0;
  const blockAlign = numCh * 2; // 16-bit
  const dataSize = len * blockAlign;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);
  const ascii = (off: number, s: string) => { for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i)); };
  ascii(0, 'RIFF'); view.setUint32(4, 36 + dataSize, true); ascii(8, 'WAVE');
  ascii(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true); // PCM
  view.setUint16(22, numCh, true); view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true); view.setUint16(32, blockAlign, true); view.setUint16(34, 16, true);
  ascii(36, 'data'); view.setUint32(40, dataSize, true);
  let off = 44;
  for (let i = 0; i < len; i++) {
    for (let c = 0; c < numCh; c++) {
      const s = Math.max(-1, Math.min(1, channels[c][i]));
      view.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      off += 2;
    }
  }
  return buffer;
}

export function encodeWavBase64(channels: Float32Array[], sampleRate: number): string {
  const bytes = new Uint8Array(encodeWav(channels, sampleRate));
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK) as unknown as number[]);
  return btoa(bin);
}
