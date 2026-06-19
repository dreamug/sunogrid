// M7 拼贴器 —— 单轨文档的纯操作(无 React、无音频、无 DOM,可直接跑测)。
// 不变式:items 按 startStep 升序、互不重叠、都落在 [0, totalSteps) 内。所有改动走这里 → 不变式集中守。
// 长度锁死:片占多宽 = clip.bars × stepsPerBar(warp 编辑器定,拼贴 lane 上不可拖改)。同 history.ts:返回新 doc、原 doc 不动。
import type { CollageClip, CollageDoc } from '@/contracts';

export const totalSteps = (doc: CollageDoc): number => Math.max(1, doc.bars * doc.stepsPerBar);

/** 一个 step 的秒数:1 bar = beatsPerBar 拍;step = bar / stepsPerBar。 */
export const stepDurSec = (doc: CollageDoc): number =>
  (doc.beatsPerBar * (60 / doc.masterBpm)) / doc.stepsPerBar;

/** 片在轨上占多少格 = clip.bars × stepsPerBar(锁死,不可拖改)。 */
export const itemLengthSteps = (doc: CollageDoc, it: CollageClip): number =>
  Math.max(1, Math.round(it.bars * doc.stepsPerBar));

export const itemEnd = (doc: CollageDoc, it: CollageClip): number => it.startStep + itemLengthSteps(doc, it);

const bySt = (a: CollageClip, b: CollageClip) => a.startStep - b.startStep;
const sortItems = (items: CollageClip[]): CollageClip[] => [...items].sort(bySt);

const overlap = (doc: CollageDoc, a: CollageClip, b: CollageClip): boolean =>
  a.startStep < itemEnd(doc, b) && b.startStep < itemEnd(doc, a);

/** 从 start 起、排除 excludeId,最多能放多长(到下一个 item 起点或轨尾);start 落在某 item 内则 0。 */
export function roomAt(doc: CollageDoc, start: number, excludeId?: string): number {
  if (start < 0) return 0;
  let limit = totalSteps(doc);
  for (const it of doc.items) {
    if (it.id === excludeId) continue;
    if (it.startStep >= start && it.startStep < limit) limit = it.startStep;
    if (it.startStep < start && itemEnd(doc, it) > start) return 0;
  }
  return Math.max(0, limit - start);
}

/** 找能放下 len 的最早空位起点;放不下返回 -1。 */
export function firstFreeStart(doc: CollageDoc, len: number): number {
  const sorted = sortItems(doc.items);
  let cursor = 0;
  for (const it of sorted) {
    if (it.startStep - cursor >= len) return cursor;
    cursor = Math.max(cursor, itemEnd(doc, it));
  }
  return totalSteps(doc) - cursor >= len ? cursor : -1;
}

// --- 改动操作(immutable) ---

/** 放一个新片(长度由 clip.bars 锁死):放得下才放,放不下原样返回(不缩短)。 */
export function placeItem(doc: CollageDoc, item: CollageClip): CollageDoc {
  const len = itemLengthSteps(doc, item);
  if (roomAt(doc, item.startStep, item.id) < len) return doc;
  return { ...doc, items: sortItems([...doc.items.filter((i) => i.id !== item.id), item]) };
}

/** 拖动:把 id 移到 desiredStart 附近,按"当前左右邻居"夹住(block 语义,不跨邻居)。长度不变。 */
export function moveItem(doc: CollageDoc, id: string, desiredStart: number): CollageDoc {
  const it = doc.items.find((i) => i.id === id);
  if (!it) return doc;
  const len = itemLengthSteps(doc, it);
  let lo = 0;
  let hi = totalSteps(doc) - len;
  for (const o of doc.items) {
    if (o.id === id) continue;
    if (itemEnd(doc, o) <= it.startStep) lo = Math.max(lo, itemEnd(doc, o));
    if (o.startStep >= itemEnd(doc, it)) hi = Math.min(hi, o.startStep - len);
  }
  const start = Math.max(lo, Math.min(hi, Math.round(desiredStart)));
  if (start === it.startStep) return doc;
  return { ...doc, items: sortItems(doc.items.map((i) => (i.id === id ? { ...i, startStep: start } : i))) };
}

/** 拖动(cross-into-gaps):把 id 移到 desiredStart;落点空着就用它,否则吸进离它最近、放得下的空隙。
 *  长度不变、永不重叠、保留留白;能跨过邻居落到对面空位(区别于 moveItem 的"夹邻不可跨")。packed 无空位则原样返回。 */
export function placeNear(doc: CollageDoc, id: string, desiredStart: number): CollageDoc {
  const it = doc.items.find((i) => i.id === id);
  if (!it) return doc;
  const len = itemLengthSteps(doc, it);
  const total = totalSteps(doc);
  const others = sortItems(doc.items.filter((i) => i.id !== id));
  const want = Math.max(0, Math.min(total - len, Math.round(desiredStart)));
  const fits = (start: number) => start >= 0 && start + len <= total && others.every((o) => start >= itemEnd(doc, o) || start + len <= o.startStep);
  const commit = (start: number) => (start === it.startStep ? doc : { ...doc, items: sortItems(doc.items.map((i) => (i.id === id ? { ...i, startStep: start } : i))) });
  if (fits(want)) return commit(want);
  // 落点被占 → 枚举空隙 [gapStart, gapEnd),挑离 want 最近、能放下 len 的,夹进去
  let best: number | null = null;
  let bestDist = Infinity;
  let cursor = 0;
  const consider = (gapStart: number, gapEnd: number) => {
    if (gapEnd - gapStart < len) return;
    const cand = Math.max(gapStart, Math.min(gapEnd - len, want));
    const dist = Math.abs(cand - want);
    if (dist < bestDist) { bestDist = dist; best = cand; }
  };
  for (const o of others) { consider(cursor, o.startStep); cursor = Math.max(cursor, itemEnd(doc, o)); }
  consider(cursor, total);
  return best == null ? doc : commit(best);
}

/** 改 lane 上的可编辑字段(semitones / gainDb;trim/长度走下钻的 warp 编辑器)。 */
export function patchItem(doc: CollageDoc, id: string, patch: Partial<Pick<CollageClip, 'semitones' | 'gainDb'>>): CollageDoc {
  return { ...doc, items: doc.items.map((i) => (i.id === id ? { ...i, ...patch } : i)) };
}

export function removeItem(doc: CollageDoc, id: string): CollageDoc {
  return { ...doc, items: doc.items.filter((i) => i.id !== id) };
}

/** 调整总长(整小节);缩短时裁掉越界 item。 */
export function setBars(doc: CollageDoc, bars: number): CollageDoc {
  const b = Math.max(1, Math.round(bars));
  const next = { ...doc, bars: b };
  return { ...next, items: doc.items.filter((i) => itemEnd(next, i) <= totalSteps(next)) };
}
