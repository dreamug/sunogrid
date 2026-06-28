// 操场 demo —— Session 的纯操作(无 React/音频/DOM)。同 history.ts:返回新对象、原对象不动。
// enabled 是模型态(开关);mixer/collage 片 pitch 都走这里改 → UI 与引擎据此追上。
import type { CollageClip, Instrument, Mixer, Session } from '@/contracts';
import { SLOTS_PER_SESSION, sessionSongEndBar, sessionSongLane } from '@/contracts';

const mapInst = (s: Session, id: string, f: (i: Instrument) => Instrument): Session => ({
  ...s,
  instruments: s.instruments.map((i) => (i.id === id ? f(i) : i)),
});

export const findInst = (s: Session, id: string | null): Instrument | null =>
  s.instruments.find((i) => i.id === id) ?? null;

/** 翻开关。 */
export const toggleEnabled = (s: Session, id: string): Session =>
  mapInst(s, id, (i) => ({ ...i, enabled: !i.enabled }));

export const setEnabled = (s: Session, id: string, on: boolean): Session =>
  mapInst(s, id, (i) => ({ ...i, enabled: on }));

/** 改乐器外壳 mixer。 */
export const patchMixer = (s: Session, id: string, patch: Partial<Mixer>): Session =>
  mapInst(s, id, (i) => ({ ...i, mixer: { ...i.mixer, ...patch } }));

export const patchInstrument = (s: Session, id: string, patch: Partial<Pick<Instrument, 'label' | 'slot' | 'color'>>): Session =>
  mapInst(s, id, (i) => ({ ...i, ...patch }));

/** 下钻第二层:改 collage 乐器里某一片 Clip 的可调字段(pitch/gain)。 */
export function patchCollageClip(s: Session, instId: string, clipId: string, patch: Partial<Pick<CollageClip, 'startSample' | 'endSample' | 'bars' | 'timeMul' | 'warpPts' | 'semitones' | 'fadeOutBars' | 'fadeSilenceBars' | 'gainDb'>>): Session {
  return mapInst(s, instId, (i) => {
    if (i.payload.kind !== 'collage') return i;
    return { ...i, payload: { ...i.payload, clips: i.payload.clips.map((c) => (c.id === clipId ? { ...c, ...patch } : c)) } };
  });
}

export const removeInstrument = (s: Session, id: string): Session => ({
  ...s,
  instruments: s.instruments.filter((i) => i.id !== id),
});

// —— §20 场景级 CRUD(数组级,纯函数;id 生成器作参数传入以保持可测)——
type NewId = (prefix: string) => string;

/** 按数组下标重排 index(增删/复制后保证 index = 数组序 = Song 歌曲顺序)。 */
const reindex = (sessions: Session[]): Session[] => sessions.map((s, i) => (s.index === i ? s : { ...s, index: i }));

/** 旧线性 Song 语义的插入点:同 lane 跟在当前最末块后面。 */
const appendSongStart = (sessions: Session[], lane = 0): number =>
  sessions.reduce((m, s) => (sessionSongLane(s) === lane ? Math.max(m, sessionSongEndBar(s)) : m), 0);

/** 深拷贝一件乐器:重生乐器 id + 各 clip id;mixer/sends/payload 按值复制;assetId/soundId/bakedAssetId 共享(内容寻址,不必重 bake)。 */
export function cloneInstrument(inst: Instrument, newId: NewId): Instrument {
  const base = { ...inst, id: newId('inst'), mixer: { ...inst.mixer, eq: { ...inst.mixer.eq } }, sends: { ...inst.sends } };
  if (inst.payload.kind === 'sample') return { ...base, payload: { kind: 'sample', clip: { ...inst.payload.clip, id: newId('clip') } } };
  return { ...base, payload: { ...inst.payload, clips: inst.payload.clips.map((c) => ({ ...c, id: newId('clip') })) } };
}

/** §23 paste 落位:从 anchor 起 row-major 找最多 n 个空 slot(跳过被占),环回填到 anchor 前的空位;不足则返回能找到的(调用方据数量提示丢弃)。
 *  不还原 copy 时的相对几何 —— 紧凑填空位。anchor 越界/省略 = 从 0 起。 */
export function freeSlots(s: Session, n: number, anchor = 0): number[] {
  const used = new Set(s.instruments.map((i) => i.slot));
  const start = Math.max(0, Math.min(Math.floor(anchor) || 0, SLOTS_PER_SESSION - 1));
  const out: number[] = [];
  for (let k = 0; k < SLOTS_PER_SESSION && out.length < n; k++) {
    const slot = (start + k) % SLOTS_PER_SESSION; // anchor..末尾,再 0..anchor
    if (!used.has(slot)) out.push(slot);
  }
  return out;
}

/** 复制场景(连乐器一并复制独立副本),插在原场景之后;返回新数组 + 副本所在下标。 */
export function duplicateSessionAt(sessions: Session[], idx: number, newId: NewId): { sessions: Session[]; newIndex: number } {
  const src = sessions[idx];
  if (!src) return { sessions, newIndex: idx };
  const copyStart = sessionSongEndBar(src);
  const copy: Session = { ...src, id: newId('sess'), name: `${src.name} copy`, songStartBar: copyStart, instruments: src.instruments.map((i) => cloneInstrument(i, newId)) };
  const next = [...sessions.slice(0, idx + 1), copy, ...sessions.slice(idx + 1)];
  return { sessions: reindex(next), newIndex: idx + 1 };
}

/** 删场景(按下标),其余 reindex。调用方保证至少留一个。 */
export const removeSessionAt = (sessions: Session[], idx: number): Session[] => reindex(sessions.filter((_, i) => i !== idx));

/** 拖拽换位:把 from 处的场景移到 to 处(splice 语义),其余 reindex。 */
export function moveSession(sessions: Session[], from: number, to: number): Session[] {
  if (from === to || from < 0 || to < 0 || from >= sessions.length || to >= sessions.length) return sessions;
  const next = [...sessions];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  return reindex(next);
}

/** 新建空场景(追加到末尾);返回新数组 + 新场景下标。 */
export function addSession(sessions: Session[], newId: NewId, name: string, color: string | null): { sessions: Session[]; newIndex: number } {
  const s: Session = { id: newId('sess'), name, index: sessions.length, songLane: 0, songStartBar: appendSongStart(sessions), repeats: 1, color, instruments: [] };
  return { sessions: [...sessions, s], newIndex: sessions.length };
}

/** 按 id 改场景外壳字段(改名 / 次数 / 颜色 / §26 XY 自动化)。 */
export const patchSession = (sessions: Session[], id: string, patch: Partial<Pick<Session, 'name' | 'repeats' | 'color' | 'xyAuto' | 'songLane' | 'songStartBar' | 'songAnchorId' | 'songOffsetBar'>>): Session[] =>
  sessions.map((s) => (s.id === id ? { ...s, ...patch } : s));
