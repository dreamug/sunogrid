// 操场 demo —— Session 的纯操作(无 React/音频/DOM)。同 history.ts:返回新对象、原对象不动。
// enabled 是模型态(开关);mixer/collage 片 pitch 都走这里改 → UI 与引擎据此追上。
import type { CollageClip, Instrument, Mixer, Session } from '@/contracts';

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
export function patchCollageClip(s: Session, instId: string, clipId: string, patch: Partial<Pick<CollageClip, 'startSample' | 'endSample' | 'bars' | 'timeMul' | 'semitones' | 'gainDb'>>): Session {
  return mapInst(s, instId, (i) => {
    if (i.payload.kind !== 'collage') return i;
    return { ...i, payload: { ...i.payload, clips: i.payload.clips.map((c) => (c.id === clipId ? { ...c, ...patch } : c)) } };
  });
}

export const removeInstrument = (s: Session, id: string): Session => ({
  ...s,
  instruments: s.instruments.filter((i) => i.id !== id),
});
