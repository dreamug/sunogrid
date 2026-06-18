// 纯逻辑单测。跑:  node src/loopmachine/history.test.ts   (Node 25 直接擦类型)
import assert from 'node:assert';
import {
  emptyDoc, cloneDoc, produceDoc, diffDoc, docChanged,
  initHist, histApply, histUndo, histRedo, canUndo, canRedo, MAX_HISTORY,
  type ProjectDoc, type PadEntry,
} from './history.ts';

let passed = 0;
const test = (name: string, fn: () => void) => {
  try { fn(); passed++; console.log('  ✓ ' + name); }
  catch (e) { console.error('  ✗ ' + name + '\n    ' + (e as Error).message); process.exitCode = 1; }
};

const pad = (soundId: string, bars = 2, warpedBy = 'auto'): PadEntry =>
  ({ soundId, warp: { startSample: 0, endSample: 1000, bars, semitones: 0, warpedBy }, label: soundId, gainDb: 0 });

console.log('history.ts');

test('cloneDoc 深拷贝,改克隆不串改原件', () => {
  const a: ProjectDoc = { masterBpm: 90, quantize: '1bar', pads: { 0: pad('s1') } };
  const b = cloneDoc(a);
  b.pads[0]!.warp.bars = 99;
  b.masterBpm = 120;
  assert.equal(a.pads[0]!.warp.bars, 2, '原 doc 的 warp 不应被改');
  assert.equal(a.masterBpm, 90);
});

test('produceDoc 返回新 doc、原 doc 不动', () => {
  const a: ProjectDoc = { masterBpm: 90, quantize: '1bar', pads: {} };
  const b = produceDoc(a, (d) => { d.pads[3] = pad('s2'); });
  assert.equal(a.pads[3], undefined);
  assert.equal(b.pads[3]!.soundId, 's2');
});

test('diffDoc 检出 pad 增/删/改 + 标量', () => {
  const before: ProjectDoc = { masterBpm: 90, quantize: '1bar', pads: { 0: pad('s1'), 1: pad('s2') } };
  const after: ProjectDoc = { masterBpm: 120, quantize: '1/2', pads: { 0: pad('s1'), 1: pad('s2b'), 5: pad('s3') } };
  const d = diffDoc(before, after);
  assert.equal(d.masterBpm, true);
  assert.equal(d.quantize, true);
  const gids = d.pads.map((p) => p.gid).sort((x, y) => x - y);
  assert.deepEqual(gids, [1, 5], 'gid 0 没变不应出现;1 改了、5 新增');
  const g1 = d.pads.find((p) => p.gid === 1)!;
  assert.equal(g1.before!.soundId, 's2');
  assert.equal(g1.after!.soundId, 's2b');
});

test('diffDoc:warp 内容变化也算变(按值比较)', () => {
  const before: ProjectDoc = { masterBpm: 90, quantize: '1bar', pads: { 0: pad('s1', 2) } };
  const after: ProjectDoc = { masterBpm: 90, quantize: '1bar', pads: { 0: pad('s1', 4) } };
  const d = diffDoc(before, after);
  assert.equal(d.pads.length, 1);
  assert.equal(d.pads[0].gid, 0);
});

test('diffDoc:同值不同引用 → 不算变(按值比较,避免误重 warp)', () => {
  const before: ProjectDoc = { masterBpm: 90, quantize: '1bar', pads: { 0: pad('s1', 2) } };
  const after: ProjectDoc = { masterBpm: 90, quantize: '1bar', pads: { 0: pad('s1', 2) } };
  assert.equal(diffDoc(before, after).pads.length, 0);
  assert.equal(docChanged(before, after), false);
});

test('删除 pad(置 null)被检出', () => {
  const before: ProjectDoc = { masterBpm: 90, quantize: '1bar', pads: { 0: pad('s1') } };
  const after: ProjectDoc = { masterBpm: 90, quantize: '1bar', pads: { 0: null } };
  const d = diffDoc(before, after);
  assert.equal(d.pads.length, 1);
  assert.equal(d.pads[0].before!.soundId, 's1');
  assert.equal(d.pads[0].after, null);
});

test('histApply 压栈 + 清空 redo', () => {
  let s = initHist(emptyDoc());
  s = histApply(s, '放 A', produceDoc(s.present, (d) => { d.pads[0] = pad('A'); }));
  assert.equal(s.past.length, 1);
  assert.equal(canUndo(s), true);
  assert.equal(canRedo(s), false);
  s = histUndo(s);
  assert.equal(canRedo(s), true);
  // 撤销后再做新动作 → redo 被清空
  s = histApply(s, '放 B', produceDoc(s.present, (d) => { d.pads[1] = pad('B'); }));
  assert.equal(canRedo(s), false, '新提交应清空 future');
  assert.equal(s.present.pads[1]!.soundId, 'B');
  assert.equal(s.present.pads[0], undefined, '被撤销的 A 不应回来');
});

test('undo/redo 往返,present 正确', () => {
  let s = initHist(emptyDoc());
  s = histApply(s, '放 A', produceDoc(s.present, (d) => { d.pads[0] = pad('A'); }));
  s = histApply(s, '放 B', produceDoc(s.present, (d) => { d.pads[1] = pad('B'); }));
  assert.equal(Object.keys(s.present.pads).length, 2);
  s = histUndo(s); // 撤销 B
  assert.equal(s.present.pads[1], undefined);
  assert.equal(s.present.pads[0]!.soundId, 'A');
  s = histUndo(s); // 撤销 A
  assert.equal(s.present.pads[0], undefined);
  assert.equal(canUndo(s), false);
  s = histRedo(s); // 重做 A
  assert.equal(s.present.pads[0]!.soundId, 'A');
  s = histRedo(s); // 重做 B
  assert.equal(s.present.pads[1]!.soundId, 'B');
  assert.equal(canRedo(s), false);
});

test('coalesce:同 key 合并到栈顶,保留首次 before、推进 after', () => {
  let s = initHist({ masterBpm: 90, quantize: '1bar', pads: {} });
  s = histApply(s, 'BPM', produceDoc(s.present, (d) => { d.masterBpm = 100; }), 'masterBpm');
  s = histApply(s, 'BPM', produceDoc(s.present, (d) => { d.masterBpm = 110; }), 'masterBpm');
  s = histApply(s, 'BPM', produceDoc(s.present, (d) => { d.masterBpm = 120; }), 'masterBpm');
  assert.equal(s.past.length, 1, '三次同 key 改动应合并成一条');
  assert.equal(s.present.masterBpm, 120);
  s = histUndo(s);
  assert.equal(s.present.masterBpm, 90, '撤销应一次回到首次之前(90),而非 110');
});

test('coalesce:合并回原值 → 丢弃该步(无幽灵 undo)', () => {
  let s = initHist({ masterBpm: 90, quantize: '1bar', pads: {} });
  s = histApply(s, 'BPM', produceDoc(s.present, (d) => { d.masterBpm = 120; }), 'masterBpm');
  assert.equal(s.past.length, 1);
  s = histApply(s, 'BPM', produceDoc(s.present, (d) => { d.masterBpm = 90; }), 'masterBpm'); // 拖回原值
  assert.equal(s.past.length, 0, '净变化为零 → 该 coalesce 步应被丢弃');
  assert.equal(canUndo(s), false, '不应留下点了无效果的幽灵 undo');
  assert.equal(s.present.masterBpm, 90);
});

test('warp 键序无关:同值不同键序判等(不误判变化)', () => {
  const before: ProjectDoc = { masterBpm: 90, quantize: '1bar', pads: { 0: { soundId: 'A', label: 'A', gainDb: 0, warp: { startSample: 0, endSample: 100, bars: 4 } } } };
  const after: ProjectDoc = { masterBpm: 90, quantize: '1bar', pads: { 0: { soundId: 'A', label: 'A', gainDb: 0, warp: { bars: 4, endSample: 100, startSample: 0 } } } };
  assert.equal(diffDoc(before, after).pads.length, 0, '同值不同键序的 warp 不应判为变化');
  assert.equal(docChanged(before, after), false);
});

test('coalesce:不同 key 不合并', () => {
  let s = initHist({ masterBpm: 90, quantize: '1bar', pads: {} });
  s = histApply(s, 'BPM', produceDoc(s.present, (d) => { d.masterBpm = 120; }), 'masterBpm');
  s = histApply(s, '量化', produceDoc(s.present, (d) => { d.quantize = '1/2'; }), 'quantize');
  s = histApply(s, 'BPM', produceDoc(s.present, (d) => { d.masterBpm = 130; }), 'masterBpm');
  assert.equal(s.past.length, 3, '被别的 key 隔开 → 不合并');
});

test('coalesce:warp:gid 连续微调合并,被其它操作打断后另起一条', () => {
  let s = initHist({ masterBpm: 90, quantize: '1bar', pads: { 0: pad('A') } });
  s = histApply(s, '调片段', produceDoc(s.present, (d) => { d.pads[0]!.warp.bars = 3; }), 'warp:0');
  s = histApply(s, '调片段', produceDoc(s.present, (d) => { d.pads[0]!.warp.bars = 4; }), 'warp:0');
  assert.equal(s.past.length, 1);
  s = histApply(s, '放 B', produceDoc(s.present, (d) => { d.pads[1] = pad('B'); })); // 无 key,打断
  s = histApply(s, '调片段', produceDoc(s.present, (d) => { d.pads[0]!.warp.bars = 5; }), 'warp:0');
  assert.equal(s.past.length, 3, 'warp:0 被「放 B」打断 → 第二段微调另起一条');
});

test('历史长度封顶', () => {
  let s = initHist(emptyDoc());
  for (let i = 0; i < MAX_HISTORY + 20; i++) {
    s = histApply(s, 'op' + i, produceDoc(s.present, (d) => { d.masterBpm = 90 + (i % 50); }));
  }
  assert.equal(s.past.length, MAX_HISTORY, '超过上限应丢最旧的');
});

console.log(`\n${passed} 通过` + (process.exitCode ? ' (有失败)' : ''));
