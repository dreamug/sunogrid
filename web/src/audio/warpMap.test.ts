// §36 warp marker 纯逻辑单测(采样/拍域):`npx tsx src/audio/warpMap.test.ts`。无 DOM/引擎依赖。
import {
  isLinearWarp, normalizeWarpPts, controlPoints, srcAtBeat, beatAtSrc,
  segments, addPoint, removePoint, movePointBeat, warpPtsSig, MIN_BEAT_GAP,
} from './warpMap';
import type { WarpPoint } from '@/contracts';

let fails = 0;
const eq = (name: string, got: number, exp: number, tol = 1e-9) => {
  if (Math.abs(got - exp) <= tol) console.log('ok  ', name);
  else { fails++; console.error('FAIL', name, '→ got', got, 'expected', exp); }
};
const truthy = (name: string, cond: boolean) => { if (cond) console.log('ok  ', name); else { fails++; console.error('FAIL', name); } };

// 一条 trim:源 [1000, 5000) 映到 8 拍(2 小节×4)。
const START = 1000, END = 5000, BEATS = 8;

// —— 退化:无 marker = 单段恒速,逐点等于线性 start→end(与 §6 现状一致)——
const lin = controlPoints(START, END, BEATS);
truthy('linear: only 2 endpoints', lin.length === 2);
truthy('isLinearWarp(undefined)', isLinearWarp(undefined));
truthy('isLinearWarp([])', isLinearWarp([]));
const linAt = (beat: number) => START + (END - START) * (beat / BEATS);
eq('linear beat0', srcAtBeat(lin, 0), START);
eq('linear beat8', srcAtBeat(lin, 8), END);
eq('linear mid(4)', srcAtBeat(lin, 4), linAt(4));
eq('linear q(2)', srcAtBeat(lin, 2), linAt(2));
eq('linear hold before', srcAtBeat(lin, -3), START);
eq('linear hold after', srcAtBeat(lin, 99), END);

// —— 一个中间 marker:把源 3000 钉到拍 2(本应在拍 4)→ 前段慢、后段快 ——
const one: WarpPoint[] = [{ src: 3000, beat: 2 }];
const cp1 = controlPoints(START, END, BEATS, one);
truthy('one marker: 3 control points', cp1.length === 3);
eq('seg1 endpoint at beat2', srcAtBeat(cp1, 2), 3000);
eq('seg1 mid beat1', srcAtBeat(cp1, 1), 1000 + (3000 - 1000) * (1 / 2)); // 2000
eq('seg2 mid beat5', srcAtBeat(cp1, 5), 3000 + (5000 - 3000) * ((5 - 2) / (8 - 2))); // 3000+2000*0.5=4000
// 段速:seg1 = (3000-1000)/2 = 1000 src/beat;seg2 = (5000-3000)/6 ≈ 333.3
const segs = segments(cp1);
truthy('2 segments', segs.length === 2);
eq('seg1 samplesPerBeat', segs[0].samplesPerBeat, 1000);
eq('seg2 samplesPerBeat', segs[1].samplesPerBeat, 2000 / 6);

// —— beatAtSrc 是 srcAtBeat 的逆 ——
eq('inverse: beatAtSrc(3000)=2', beatAtSrc(cp1, 2 === 2 ? 3000 : 0), 2);
eq('inverse roundtrip beat3', beatAtSrc(cp1, srcAtBeat(cp1, 3)), 3, 1e-6);
eq('inverse roundtrip beat6', beatAtSrc(cp1, srcAtBeat(cp1, 6)), 6, 1e-6);

// —— normalize:丢越界 / 非单调 / 贴太近 ——
const dirty: WarpPoint[] = [
  { src: 900, beat: 1 },     // src 越 trim 起 → 丢
  { src: 3000, beat: 9 },    // beat 越 totalBeats → 丢
  { src: 4000, beat: 6 },    // 合法
  { src: 3500, beat: 5 },    // 在 4000/6 之前(beat 排序后它在前)→ 与 4000 比是合法,但二者 src 须单调
  { src: 5500, beat: 7 },    // src 越 trim 止 → 丢
];
const cleaned = normalizeWarpPts(dirty, START, END, BEATS);
truthy('normalize keeps only in-range monotone', cleaned.every((p) => p.src > START && p.src < END && p.beat > 0 && p.beat < BEATS));
truthy('normalize sorted by beat', cleaned.every((p, i, a) => i === 0 || a[i - 1].beat < p.beat));
truthy('normalize strictly increasing src', cleaned.every((p, i, a) => i === 0 || a[i - 1].src < p.src));

// 非单调:两个点 beat 升但 src 降 → 后者被丢
const nonMono: WarpPoint[] = [{ src: 4000, beat: 2 }, { src: 2000, beat: 5 }];
const nm = normalizeWarpPts(nonMono, START, END, BEATS);
truthy('non-monotone src dropped', nm.length === 1 && nm[0].src === 4000);

// 贴太近(beat 间距 < MIN_BEAT_GAP)→ 第二个丢
const tooClose: WarpPoint[] = [{ src: 2500, beat: 3 }, { src: 2600, beat: 3 + MIN_BEAT_GAP / 2 }];
truthy('too-close marker dropped', normalizeWarpPts(tooClose, START, END, BEATS).length === 1);

// —— 编辑:add / move / remove ——
const added = addPoint(undefined, START, END, BEATS, 3000, 4);
truthy('addPoint to empty', added.length === 1 && added[0].src === 3000 && added[0].beat === 4);
const addBad = addPoint(added, START, END, BEATS, 900, 1); // 越界 → 不增
truthy('addPoint rejects out-of-range', addBad.length === 1);

const moved = movePointBeat(added, START, END, BEATS, 0, 2);
eq('movePointBeat changes beat only', moved[0].beat, 2);
eq('movePointBeat keeps src', moved[0].src, 3000);
// 夹到邻居之间:试图移过终点 → 夹回
const clamped = movePointBeat(added, START, END, BEATS, 0, 999);
truthy('movePointBeat clamps below totalBeats', clamped[0].beat < BEATS);

const twoPts = addPoint(added, START, END, BEATS, 4000, 6);
truthy('addPoint second', twoPts.length === 2);
const removed = removePoint(twoPts, START, END, BEATS, 0);
truthy('removePoint by index', removed.length === 1 && removed[0].src === 4000);

// —— 签名:空 = '';有点 = 稳定串 ——
truthy('sig empty', warpPtsSig(undefined) === '' && warpPtsSig([]) === '');
truthy('sig stable', warpPtsSig(one) === '3000:2.000');
truthy('sig differs when moved', warpPtsSig(added) !== warpPtsSig(moved)); // 4.000 vs 2.000

console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILED`);
if (fails) process.exit(1);
