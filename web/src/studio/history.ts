// 撤销/重做内核 —— 纯逻辑、无依赖、框架无关(可直接 `node history.ts` 跑测)。
// 设计:ProjectDoc 是「真相」,DB/引擎是它的投影。所有编排变更走 applyDoc(label, recipe) →
// 算出新 doc → reconcile(before, after) 让 DB/引擎追上。undo/redo 只是在 past/future 间
// 搬快照,再走同一个 reconcile —— 所以每个操作的逆操作都「免费」,新增操作无需写撤销代码。
//
// 范围(本期):仅项目编排 —— pad 布局 + 每 pad 的 warp + 主 BPM + 量化。库编辑不在此 doc。
import type { Quantize } from '@/contracts';

/** pad 上的 warp(与 DB PadClip.warp / Sound.warp 同形状的 JSON)。 */
export type WarpJson = {
  startSample?: number;
  endSample?: number;
  bars?: number;
  semitones?: number;
  warpedBy?: string;
} & Record<string, unknown>;

/** 放到一个 pad 上的 clip 副本 —— 可撤销的编排单元。 */
export interface PadEntry {
  soundId: string;
  warp: WarpJson;
  label: string;
  gainDb: number;
}

/** 可撤销的项目编排文档。pads 的 key = gid(= bank*PADS_PER_BANK + index)。 */
export interface ProjectDoc {
  masterBpm: number;
  quantize: Quantize;
  pads: Record<number, PadEntry | null>;
}

export const emptyDoc = (): ProjectDoc => ({ masterBpm: 90, quantize: '1bar', pads: {} });

/** 深拷贝(doc 很小,直接克隆;保证历史快照之间互不串改)。 */
export function cloneDoc(d: ProjectDoc): ProjectDoc {
  const pads: Record<number, PadEntry | null> = {};
  for (const k in d.pads) {
    const e = d.pads[k];
    pads[k] = e ? { soundId: e.soundId, warp: { ...e.warp }, label: e.label, gainDb: e.gainDb } : null;
  }
  return { masterBpm: d.masterBpm, quantize: d.quantize, pads };
}

/** 在克隆上做改动(immer 式人体工学,但无依赖):返回新 doc,原 doc 不动。 */
export function produceDoc(base: ProjectDoc, recipe: (draft: ProjectDoc) => void): ProjectDoc {
  const draft = cloneDoc(base);
  recipe(draft);
  return draft;
}

/** warp 的键序无关规范化:DB 取回(MySQL JSON 归一化键序)与代码插入序的同值 warp 应判等,否则误判变化→多余重 warp / 幽灵 undo 步。 */
const canonWarp = (w: WarpJson): string => {
  let s = '';
  for (const k of Object.keys(w).sort()) s += k + ':' + JSON.stringify(w[k]) + ';';
  return s;
};

const padEq = (a: PadEntry | null | undefined, b: PadEntry | null | undefined): boolean => {
  if (!a && !b) return true;
  if (!a || !b) return false;
  return (
    a.soundId === b.soundId &&
    a.label === b.label &&
    a.gainDb === b.gainDb &&
    canonWarp(a.warp) === canonWarp(b.warp)
  );
};

export interface PadDelta { gid: number; before: PadEntry | null; after: PadEntry | null }
export interface DocDelta { pads: PadDelta[]; masterBpm: boolean; quantize: boolean }

/** 结构化 diff:reconcile 据此「只动变了的 pad / 标量」,避免无谓重 warp。 */
export function diffDoc(before: ProjectDoc, after: ProjectDoc): DocDelta {
  const gids = new Set<number>();
  for (const k in before.pads) gids.add(Number(k));
  for (const k in after.pads) gids.add(Number(k));
  const pads: PadDelta[] = [];
  for (const gid of gids) {
    const a = before.pads[gid] ?? null;
    const b = after.pads[gid] ?? null;
    if (!padEq(a, b)) pads.push({ gid, before: a, after: b });
  }
  return { pads, masterBpm: before.masterBpm !== after.masterBpm, quantize: before.quantize !== after.quantize };
}

/** doc 是否有实质变化(用于跳过空提交)。 */
export const docChanged = (before: ProjectDoc, after: ProjectDoc): boolean => {
  const d = diffDoc(before, after);
  return d.pads.length > 0 || d.masterBpm || d.quantize;
};

// --- 历史栈(纯快照式) ---

/** 一条历史记录 = 一步可撤销操作的前后快照。 */
export interface HistEntry { label: string; before: ProjectDoc; after: ProjectDoc; coalesceKey?: string }
export interface HistState { past: HistEntry[]; present: ProjectDoc; future: HistEntry[] }

export const MAX_HISTORY = 200;

export const initHist = (present: ProjectDoc): HistState => ({ past: [], present, future: [] });

/**
 * 提交一次变更:压栈、清空 redo;若给了 coalesceKey 且与栈顶相同,则合并到栈顶
 * (保留首次的 before、把 after 推进到最新)—— 用于 BPM 拖动、连续微调 warp 等高频改动。
 */
export function histApply(s: HistState, label: string, next: ProjectDoc, coalesceKey?: string): HistState {
  const top = s.past[s.past.length - 1];
  if (coalesceKey && top && top.coalesceKey === coalesceKey) {
    // 合并后若净变化为零(如拖 BPM 升又降回原值),丢弃该步,别留点了无效果的幽灵 undo
    if (!docChanged(top.before, next)) return { past: s.past.slice(0, -1), present: next, future: [] };
    const merged: HistEntry = { ...top, after: next };
    return { past: [...s.past.slice(0, -1), merged], present: next, future: [] };
  }
  const entry: HistEntry = { label, before: s.present, after: next, coalesceKey };
  const past = [...s.past, entry];
  while (past.length > MAX_HISTORY) past.shift();
  return { past, present: next, future: [] };
}

export const canUndo = (s: HistState): boolean => s.past.length > 0;
export const canRedo = (s: HistState): boolean => s.future.length > 0;

/** 撤销:栈顶记录的 before 成为 present,记录移入 future 头部。 */
export function histUndo(s: HistState): HistState {
  const top = s.past[s.past.length - 1];
  if (!top) return s;
  return { past: s.past.slice(0, -1), present: top.before, future: [top, ...s.future] };
}

/** 重做:future 头部记录的 after 成为 present,记录移回 past。 */
export function histRedo(s: HistState): HistState {
  const top = s.future[0];
  if (!top) return s;
  return { past: [...s.past, top], present: top.after, future: s.future.slice(1) };
}
