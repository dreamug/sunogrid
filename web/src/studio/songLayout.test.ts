// §37 Song 多轨布局纯逻辑单测:`npx tsx src/studio/songLayout.test.ts`。无 DOM/引擎/DB 依赖。
// 逐条断言 PRODUCT §37.4 联动矩阵。
import type { Session } from '@/contracts';
import { sessionSongStartBar, sessionSongAnchor } from '@/contracts';
import { resnapSong, mainLayout, mainAtBar, anchorPatchAt, mainInsertIndex, moveMainTo, songTotalBars, subDropLanding, nextFreeSubStart } from './songLayout';

let fails = 0;
const eq = (name: string, got: number, exp: number) => {
  if (got === exp) console.log('ok  ', name);
  else { fails++; console.error('FAIL', name, '→ got', got, 'expected', exp); }
};
const is = (name: string, got: unknown, exp: unknown) => {
  if (got === exp) console.log('ok  ', name);
  else { fails++; console.error('FAIL', name, '→ got', got, 'expected', exp); }
};

function mk(id: string, o: { index: number; lane?: number; bars?: number; reps?: number; anchorId?: string | null; offset?: number; start?: number }): Session {
  const bars = o.bars ?? 4;
  return {
    id, name: id, index: o.index,
    songLane: o.lane ?? 0, songStartBar: o.start ?? 0,
    songAnchorId: o.anchorId ?? null, songOffsetBar: o.offset ?? 0,
    repeats: o.reps ?? 1, color: null,
    instruments: [{ payload: { kind: 'sample', clip: { bars, timeMul: 1 } } }],
  } as unknown as Session;
}
const start = (ss: Session[], id: string) => sessionSongStartBar(ss.find((s) => s.id === id)!);

// —— 1. 主轨吸附累加 ——
{
  const ss = resnapSong([
    mk('A', { index: 0, bars: 4, reps: 2 }), // len 8 → 0
    mk('B', { index: 1, bars: 8, reps: 2 }), // len 16 → 8
    mk('C', { index: 2, bars: 4, reps: 1 }), // len 4 → 24
  ]);
  eq('main A @0', start(ss, 'A'), 0);
  eq('main B @8', start(ss, 'B'), 8);
  eq('main C @24', start(ss, 'C'), 24);
  eq('total 28', songTotalBars(ss), 28);
}

// —— 2. sub 锚定跟随 ——
{
  const ss = resnapSong([
    mk('A', { index: 0, bars: 8, reps: 1 }),                              // @0 len8
    mk('B', { index: 1, bars: 8, reps: 1 }),                              // @8 len8
    mk('S', { index: 2, lane: 1, bars: 4, anchorId: 'B', offset: 4 }),    // @12
  ]);
  eq('sub S @12 (B.start8+off4)', start(ss, 'S'), 12);
  is('sub S keeps anchor B', sessionSongAnchor(ss.find((s) => s.id === 'S')!), 'B');
}

// —— 3. 改 repeat → 后面主块 + 锚定 sub 全跟随 ——
{
  const base = [
    mk('A', { index: 0, bars: 4, reps: 1 }),                             // @0 len4
    mk('B', { index: 1, bars: 4, reps: 1 }),                             // @4
    mk('Sb', { index: 2, lane: 1, bars: 2, anchorId: 'B', offset: 0 }),  // @4
  ];
  // A reps 1→3 (len 4→12) → B 推到 @12,锚 B 的 sub 跟到 @12
  base[0] = mk('A', { index: 0, bars: 4, reps: 3 });
  const ss = resnapSong(base);
  eq('B shifted to @12', start(ss, 'B'), 12);
  eq('sub anchored B follows @12', start(ss, 'Sb'), 12);
}

// —— 4. 删主块 A → 锚它的 sub 变孤儿,冻结原绝对位置 ——
{
  let ss = resnapSong([
    mk('A', { index: 0, bars: 8, reps: 1 }),                            // @0 len8
    mk('B', { index: 1, bars: 8, reps: 1 }),                            // @8
    mk('S', { index: 2, lane: 1, bars: 4, anchorId: 'A', offset: 2 }),  // @2
  ]);
  eq('pre-delete sub @2', start(ss, 'S'), 2);
  ss = resnapSong(ss.filter((s) => s.id !== 'A')); // 删 A
  eq('orphan sub frozen @2', start(ss, 'S'), 2);
  is('orphan sub anchor cleared', sessionSongAnchor(ss.find((s) => s.id === 'S')!), null);
  eq('B slid to @0 after A removed', start(ss, 'B'), 0);
}

// —— 5. anchorPatchAt:落点在主块内=锚,落点外=孤儿 ——
{
  const ss = resnapSong([
    mk('A', { index: 0, bars: 8, reps: 1 }), // [0,8)
    mk('B', { index: 1, bars: 8, reps: 1 }), // [8,16)
  ]);
  const p1 = anchorPatchAt(ss, 10, 1); // 落 B 内
  is('drop@10 anchors B', p1.songAnchorId, 'B');
  eq('drop@10 offset 2', p1.songOffsetBar ?? -1, 2);
  const p2 = anchorPatchAt(ss, 99, 1); // 落主轨外
  is('drop@99 orphan', p2.songAnchorId, null);
  eq('drop@99 start 99', p2.songStartBar ?? -1, 99);
}

// —— 6. mainAtBar / mainInsertIndex 边界 ——
{
  const ss = resnapSong([
    mk('A', { index: 0, bars: 8, reps: 1 }), // [0,8)
    mk('B', { index: 1, bars: 8, reps: 1 }), // [8,16)
  ]);
  is('bar0 → A', mainAtBar(ss, 0)?.id, 'A');
  is('bar7 → A', mainAtBar(ss, 7)?.id, 'A');
  is('bar8 → B', mainAtBar(ss, 8)?.id, 'B');
  is('bar16 → none', mainAtBar(ss, 16)?.id ?? null, null);
  eq('insert before A (bar1)', mainInsertIndex(ss, 1), 0);
  eq('insert between (bar10)', mainInsertIndex(ss, 10), 1);
  eq('insert at end (bar99)', mainInsertIndex(ss, 99), 2);
}

// —— 7. moveMainTo:主块换序,sub 不动 index 但绝对位置跟锚 ——
{
  let ss = resnapSong([
    mk('A', { index: 0, bars: 4, reps: 1 }),                            // @0
    mk('B', { index: 1, bars: 4, reps: 1 }),                            // @4
    mk('C', { index: 2, bars: 4, reps: 1 }),                            // @8
    mk('Sa', { index: 3, lane: 1, bars: 2, anchorId: 'A', offset: 0 }), // 跟 A
  ]);
  ss = resnapSong(moveMainTo(ss, 'C', 0)); // C 移到首 → C,A,B
  eq('C now @0', start(ss, 'C'), 0);
  eq('A now @4', start(ss, 'A'), 4);
  eq('B now @8', start(ss, 'B'), 8);
  eq('sub follows A to @4', start(ss, 'Sa'), 4);
}

// —— 8. 子轨夹进锚主块范围(#5/#7):缩短锚主块 → 子轨骑末端跟走;加长复原(非破坏);锚比子轨短 → 夹到 0 ——
{
  const A3S = [mk('A', { index: 0, bars: 4, reps: 3 }), mk('S', { index: 1, lane: 1, bars: 2, anchorId: 'A', offset: 8 })]; // A=12bar,sub 锚 A、offset 8(在 A 内)
  eq('fit: sub @8', start(resnapSong(A3S), 'S'), 8);
  const A2S = [mk('A', { index: 0, bars: 4, reps: 2 }), mk('S', { index: 1, lane: 1, bars: 2, anchorId: 'A', offset: 8 })]; // A 缩到 8bar → maxOff=6
  eq('shrink: sub rides end @6', start(resnapSong(A2S), 'S'), 6);
  eq('grow back: sub returns @8', start(resnapSong(A3S), 'S'), 8); // 加回 → 回原 offset(非破坏)
  const tiny = [mk('A', { index: 0, bars: 1, reps: 1 }), mk('S', { index: 1, lane: 1, bars: 2, anchorId: 'A', offset: 5 })]; // 锚比子轨短 → 夹到 0
  eq('tiny anchor: sub @0', start(resnapSong(tiny), 'S'), 0);
}

// —— 8b. #1 同 lane 锚定子轨禁叠放守恒:多个子轨锚同主块、缩短主块全被夹到末端 → 顺次往左堆、不互叠 ——
{
  // A 缩到 8bar(maxOff=6),S1/S2 都锚 A、同 lane,offset 都超 6 → 不让位会都落 @6 互叠。
  const two = [
    mk('A', { index: 0, bars: 4, reps: 2 }),                              // @0 len8
    mk('S1', { index: 1, lane: 1, bars: 2, anchorId: 'A', offset: 8 }),   // 夹 → 6
    mk('S2', { index: 2, lane: 1, bars: 2, anchorId: 'A', offset: 10 }),  // 夹 → 6,与 S1 撞 → 让到 4
  ];
  const r = resnapSong(two);
  const s1 = start(r, 'S1'), s2 = start(r, 'S2');
  is('pack: S1≠S2 (no overlap)', s1 === s2, false);
  is('pack: gap ≥ 2bars (no overlap)', Math.abs(s1 - s2) >= 2, true);
  eq('pack: rightmost rides end @6', Math.max(s1, s2), 6);
  eq('pack: other stacks left @4', Math.min(s1, s2), 4);
  // 单子轨路径不受影响(夹后位逐字不变)
  eq('pack: single sub unchanged @6', start(resnapSong([two[0], two[1]]), 'S1'), 6);
}

// —— 9. #2 子轨落子叠放判定(subDropLanding):主→sub / sub→sub 落点恒 = 真实落点,占位则 overlap=true ——
{
  // 主轨块拖到子轨:M2 锚到自己→转 sub 锚失效→降级孤儿落在裸 vbar(不夹)。旧手算会夹到主块范围 → 判定坐标≠落点、漏判。
  const base = [
    mk('M1', { index: 0, bars: 4, reps: 1 }),                            // 主 @0..4
    mk('M2', { index: 1, bars: 4, reps: 1 }),                            // 主 @4..8(将被拖去 sub)
    mk('S', { index: 2, lane: 1, bars: 4, anchorId: 'M1', offset: 0 }),  // sub lane1 @0..4
  ];
  // M2 → lane1 @bar5(主轨外):孤儿落 @5、与 S(0..4)不叠 → 合法
  const d1 = subDropLanding(base, 'M2', 5, 1);
  eq('drop M2→sub @5 lands @5 (orphan, no clamp)', d1.startBar, 5);
  is('drop M2→sub @5 no overlap', d1.overlap, false);
  // M2 → lane1 @bar0:落 @0 压在 S(0..4)上 → 必须判叠放(这正是之前漏掉的主→sub 重叠)
  const d2 = subDropLanding(base, 'M2', 0, 1);
  is('drop M2→sub @0 overlaps S', d2.overlap, true);
  // sub→sub:把 S 自己拖到 @0(原位)→ 不该和自己算叠放
  is('drop S→@0 self not overlap', subDropLanding(base, 'S', 0, 1).overlap, false);
  // 落到空 lane2 → 任意位置都合法
  is('drop M2→empty lane2 no overlap', subDropLanding(base, 'M2', 0, 2).overlap, false);
}

// —— 10. 子轨复制落点 nextFreeSubStart:同 lane 向右找第一个放得下的空档,紧贴前块 ——
{
  const L = (id: string, start: number, bars: number, lane = 1) => mk(id, { index: 0, lane, bars, start });
  // 紧贴:src[0,2] 之后空到 @5 → 落 @2(紧贴原块)
  eq('free: tight after src @2', nextFreeSubStart([L('S', 0, 2), L('B', 5, 2)], 1, 2, 2), 2);
  // 空隙不够:src[0,2] 紧跟 B[2,4] → 跳到 B 之后 @4
  eq('free: gap too small → after B @4', nextFreeSubStart([L('S', 0, 2), L('B', 2, 2)], 1, 2, 2), 4);
  // 连续不够:src[0,2]·B1[2,4]·B2[4,6] → 一路跳到 @6
  eq('free: chain past B1+B2 @6', nextFreeSubStart([L('S', 0, 2), L('B1', 2, 2), L('B2', 4, 2)], 1, 2, 2), 6);
  // 别的 lane 的块不影响本 lane
  eq('free: other lane ignored @2', nextFreeSubStart([L('S', 0, 2), L('X', 2, 2, 2)], 1, 2, 2), 2);
}

const layout = mainLayout([mk('X', { index: 0, bars: 4, reps: 2 })]);
eq('mainLayout total', layout.total, 8);

if (fails) { console.error('\n' + fails + ' FAILED'); process.exit(1); }
else console.log('\nall songLayout tests passed');
