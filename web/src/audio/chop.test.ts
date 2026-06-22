// §33 切块纯逻辑单测(无 DOM/引擎)。跑:  npx tsx src/audio/chop.test.ts
import { chopSong, estimateOrigin, shouldChop, MAX_LOOP_BARS, DEFAULT_BLOCK_BARS } from './chop.ts';

let fails = 0;
const ok = (name: string, cond: boolean, extra = '') => {
  if (cond) console.log('ok   ', name);
  else { fails++; console.error('FAIL ', name, extra); }
};
const near = (name: string, got: number, exp: number, tol: number) =>
  ok(name, Math.abs(got - exp) <= tol, `→ got ${got}, expected ${exp} ±${tol}`);

const SR = 48000;
const BPB = 4;
const spb = (bpm: number) => ((BPB * 60) / bpm) * SR; // 样本/小节

// 合成点击轨:每小节下拍(响)+ 每拍(弱),起点偏移 originOffset;尾留 0.3 小节。
function clickTrack(bpm: number, bars: number, originOffset: number): Float32Array[] {
  const s = spb(bpm);
  const beat = s / BPB;
  const len = Math.round(originOffset + bars * s + s * 0.3);
  const x = new Float32Array(len);
  for (let bar = 0; bar < bars; bar++)
    for (let bt = 0; bt < BPB; bt++) {
      const pos = Math.round(originOffset + bar * s + bt * beat);
      const amp = bt === 0 ? 1.0 : 0.4; // 下拍更响 → 相位扫描应锁到它
      for (let i = 0; i < 240 && pos + i < len; i++) x[pos + i] += amp * Math.exp(-i / 40) * (i % 2 ? 1 : -1);
    }
  return [x];
}

const barList = (r: { blocks: { bars: number }[] }) => r.blocks.map((b) => b.bars).join(',');
const contiguous = (r: { blocks: { startSample: number; endSample: number }[] }, len: number) => {
  if (r.blocks[0].startSample !== r.blocks[0].startSample) return false;
  for (let i = 1; i < r.blocks.length; i++) if (r.blocks[i].startSample !== r.blocks[i - 1].endSample) return false;
  return r.blocks[r.blocks.length - 1].endSample === len;
};

// —— 闸门(§33.2)
ok('gate: 32 bars 不切', shouldChop(32) === false);
ok('gate: 33 bars 要切', shouldChop(33) === true);
ok('gate: MAX_LOOP_BARS=32', MAX_LOOP_BARS === 32);

// —— grid origin(§33.1):恢复已知下拍相位
{
  const off = Math.round(spb(120) * 0.3);
  const got = estimateOrigin(clickTrack(120, 8, off), SR, spb(120));
  near('origin: 恢复 0.3 小节偏移', got, off, 2 * 256);
}
{
  const got = estimateOrigin(clickTrack(140, 8, 0), SR, spb(140));
  ok('origin: 0 偏移 → 近 0', got < 2 * 256, `→ got ${got}`);
}

// —— 整除:40 bar @120,默认 16 → [16,16,8]
{
  const r = chopSong(clickTrack(120, 40, 0), SR, 120, { originSamples: 0 });
  ok('chop 40bar: blockBars 默认 16', r.blockBars === DEFAULT_BLOCK_BARS);
  ok('chop 40bar: 3 块', r.blocks.length === 3, `→ ${r.blocks.length}`);
  ok('chop 40bar: bars=[16,16,8]', barList(r) === '16,16,8', `→ ${barList(r)}`);
  ok('chop 40bar: 块首尾相接铺满', contiguous(r, clickTrack(120, 40, 0)[0].length));
  ok('chop 40bar: 每块整数小节', r.blocks.every((b) => Number.isInteger(b.bars)));
}

// —— 余数并入(§33.1):33 bar @120,默认 16 → 末块 1 bar < MIN(4) 并入 → [16,17]
{
  const r = chopSong(clickTrack(120, 33, 0), SR, 120, { originSamples: 0 });
  ok('chop 33bar: 末块并入 → 2 块', r.blocks.length === 2, `→ ${r.blocks.length}`);
  ok('chop 33bar: bars=[16,17]', barList(r) === '16,17', `→ ${barList(r)}`);
}

// —— UI 改每块大小:40 bar,blockBars=8 → 5×8
{
  const r = chopSong(clickTrack(120, 40, 0), SR, 120, { originSamples: 0, blockBars: 8 });
  ok('chop blockBars=8: 5 块', r.blocks.length === 5, `→ ${r.blocks.length}`);
  ok('chop blockBars=8: 全 8 小节', barList(r) === '8,8,8,8,8', `→ ${barList(r)}`);
}

// —— blockBars 吸附:传 12 → 吸到 16
{
  const r = chopSong(clickTrack(120, 40, 0), SR, 120, { originSamples: 0, blockBars: 12 });
  ok('chop blockBars=12 吸到 16', r.blockBars === 16, `→ ${r.blockBars}`);
}

// —— 太短:< 一块 → 整段一块
{
  const r = chopSong(clickTrack(120, 10, 0), SR, 120, { originSamples: 0, blockBars: 16 });
  ok('chop 10bar(<16): 整段一块', r.blocks.length === 1, `→ ${r.blocks.length}`);
}

console.log(fails === 0 ? '\nAll passed.' : `\n${fails} FAILED.`);
if (fails > 0) process.exit(1);
