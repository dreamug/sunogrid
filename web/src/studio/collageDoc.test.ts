// 纯逻辑单测(placeNear:cross-into-gaps 拖动)。跑:  node src/studio/collageDoc.test.ts   (Node 25 直接擦类型)
import assert from 'node:assert';
import { placeNear, itemEnd } from './collageDoc.ts';
import type { CollageClip, CollageDoc } from '@/contracts';

let passed = 0;
const test = (name: string, fn: () => void) => {
  try { fn(); passed++; console.log('  ✓ ' + name); }
  catch (e) { console.error('  ✗ ' + name + '\n    ' + (e as Error).message); process.exitCode = 1; }
};

const clip = (id: string, startStep: number, bars = 1): CollageClip =>
  ({ id, startStep, bars, soundId: id, assetId: id, startSample: 0, endSample: 1000, semitones: 0, gainDb: 0 });
const doc = (items: CollageClip[], bars = 100, stepsPerBar = 4): CollageDoc =>
  ({ bars, stepsPerBar, beatsPerBar: 4, masterBpm: 90, items });
const startOf = (d: CollageDoc, id: string) => d.items.find((i) => i.id === id)!.startStep;
const noOverlap = (d: CollageDoc) => {
  const s = [...d.items].sort((a, b) => a.startStep - b.startStep);
  for (let i = 1; i < s.length; i++) assert.ok(s[i].startStep >= itemEnd(d, s[i - 1]), 'overlap!');
};

console.log('collageDoc.ts placeNear');

test('落点空着 → 就放那（spb4:a[0,4) b[8,12),挪 a 到 4）', () => {
  const r = placeNear(doc([clip('a', 0), clip('b', 8)]), 'a', 4);
  assert.equal(startOf(r, 'a'), 4); noOverlap(r);
});

test('落点被占 → 吸到最近能放下的空隙(不重叠、不落在被占点)', () => {
  const r = placeNear(doc([clip('a', 0), clip('b', 8)]), 'a', 8);
  assert.notEqual(startOf(r, 'a'), 8); noOverlap(r);
});

test('能跨过邻居落到对面空位(a 越过紧贴的 b 落到 10)', () => {
  const r = placeNear(doc([clip('a', 0), clip('b', 4)]), 'a', 10);
  assert.equal(startOf(r, 'a'), 10); noOverlap(r);
});

test('负落点夹到 ≥0、不越界、不重叠', () => {
  const r = placeNear(doc([clip('a', 8), clip('b', 0)]), 'a', -5);
  assert.ok(startOf(r, 'a') >= 0); noOverlap(r);
});

console.log(`\n${passed} 通过` + (process.exitCode ? ' (有失败)' : ''));
