// Studio 细粒度持久化(§15.C)。把 contract 嵌套树规范化成 DB 行的扁平快照,
// diff 两份快照 → 最小 op 列表(增 / 字段级改 / 删)。前端发件箱用,后端 /api/studio/ops 应用。
//
// 设计:不逐个 mutation site 埋点(易漏),而是“当前树 vs 上次已落库快照”整体 diff —— 任何变更都不会漏,
// 且天然合并(拖旋钮 100 次 → 只看最终值,产 1 条 field-level upd)。撤销/重做改了树也走同一条 diff。
import type { Session } from '@/contracts';
import { defaultSends } from '@/contracts';

// —— 扁平行(字段 = DB 列)——
export interface NSession { id: string; name: string; index: number; repeats: number; color: string | null }
export interface NInstrument {
  id: string; sessionId: string; slot: number; type: string; label: string; color: string | null; icon: string | null; enabled: boolean;
  gainDb: number; pan: number; eqLowDb: number; eqMidDb: number; eqHighDb: number;
  collageBars: number | null; stepsPerBar: number | null; loopStartStep: number | null; bakedAssetId: string | null; sends: unknown;
}
export interface NClip {
  id: string; instrumentId: string; soundId: string; assetId: string;
  startSample: number; endSample: number; bars: number; timeMul: number | null; semitones: number;
  fadeOutBars: number | null; fadeSilenceBars: number | null;
  gainDb: number; pan: number; eqLowDb: number; eqMidDb: number; eqHighDb: number;
  startStep: number | null; orderIndex: number;
}

export interface Snapshot {
  sessions: Record<string, NSession>;
  instruments: Record<string, NInstrument>;
  clips: Record<string, NClip>;
}

// —— ops ——
export type Op =
  | { t: 'sess.add'; row: NSession }
  | { t: 'sess.upd'; id: string; fields: Partial<NSession> }
  | { t: 'sess.del'; id: string }
  | { t: 'inst.add'; row: NInstrument }
  | { t: 'inst.upd'; id: string; fields: Partial<NInstrument> }
  | { t: 'inst.del'; id: string }
  | { t: 'clip.add'; row: NClip }
  | { t: 'clip.upd'; id: string; fields: Partial<NClip> }
  | { t: 'clip.del'; id: string };

const hasAsset = (assetId: string) => typeof assetId === 'string' && assetId.length > 0;

/** contract 树 → 扁平快照。空 sample 占位(assetId='')不产 clip 行,与后端一致。 */
export function normalize(sessions: Session[]): Snapshot {
  const snap: Snapshot = { sessions: {}, instruments: {}, clips: {} };
  for (const s of sessions) {
    snap.sessions[s.id] = { id: s.id, name: s.name, index: s.index, repeats: s.repeats ?? 1, color: s.color ?? null };
    for (const i of s.instruments) {
      snap.instruments[i.id] = {
        id: i.id, sessionId: s.id, slot: i.slot, type: i.payload.kind, label: i.label, color: i.color ?? null, icon: i.icon ?? null, enabled: !!i.enabled,
        gainDb: i.mixer.gainDb, pan: i.mixer.pan, eqLowDb: i.mixer.eq.lowDb, eqMidDb: i.mixer.eq.midDb, eqHighDb: i.mixer.eq.highDb,
        collageBars: i.payload.kind === 'collage' ? i.payload.bars : null,
        stepsPerBar: i.payload.kind === 'collage' ? i.payload.stepsPerBar : null,
        loopStartStep: i.payload.kind === 'collage' ? i.payload.loopStartStep : null,
        bakedAssetId: i.payload.kind === 'collage' ? (i.payload.bakedAssetId ?? null) : null,
        sends: i.sends ?? defaultSends(),
      };
      if (i.payload.kind === 'sample') {
        const c = i.payload.clip;
        if (c.id && hasAsset(c.assetId)) {
          snap.clips[c.id] = { id: c.id, instrumentId: i.id, soundId: c.soundId || '', assetId: c.assetId, startSample: Math.round(c.startSample), endSample: Math.round(c.endSample), bars: c.bars, timeMul: c.timeMul ?? null, semitones: c.semitones, fadeOutBars: c.fadeOutBars ?? null, fadeSilenceBars: c.fadeSilenceBars ?? null, gainDb: c.gainDb, pan: 0, eqLowDb: 0, eqMidDb: 0, eqHighDb: 0, startStep: null, orderIndex: 0 };
        }
      } else {
        i.payload.clips.forEach((c, idx) => {
          if (c.id && hasAsset(c.assetId)) {
            snap.clips[c.id] = { id: c.id, instrumentId: i.id, soundId: c.soundId || '', assetId: c.assetId, startSample: Math.round(c.startSample), endSample: Math.round(c.endSample), bars: c.bars, timeMul: c.timeMul ?? null, semitones: c.semitones, fadeOutBars: c.fadeOutBars ?? null, fadeSilenceBars: c.fadeSilenceBars ?? null, gainDb: c.gainDb, pan: c.pan ?? 0, eqLowDb: c.eqLowDb ?? 0, eqMidDb: c.eqMidDb ?? 0, eqHighDb: c.eqHighDb ?? 0, startStep: c.startStep, orderIndex: idx };
          }
        });
      }
    }
  }
  return snap;
}

const SESS_FIELDS: (keyof NSession)[] = ['name', 'index', 'repeats', 'color'];
const INST_FIELDS: (keyof NInstrument)[] = ['sessionId', 'slot', 'type', 'label', 'color', 'icon', 'enabled', 'gainDb', 'pan', 'eqLowDb', 'eqMidDb', 'eqHighDb', 'collageBars', 'stepsPerBar', 'loopStartStep', 'bakedAssetId', 'sends'];
const CLIP_FIELDS: (keyof NClip)[] = ['instrumentId', 'soundId', 'assetId', 'startSample', 'endSample', 'bars', 'timeMul', 'semitones', 'fadeOutBars', 'fadeSilenceBars', 'gainDb', 'pan', 'eqLowDb', 'eqMidDb', 'eqHighDb', 'startStep', 'orderIndex'];

// 字段相等:标量直接比,sends(对象)按 JSON 比。
function eq(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a === 'object' || typeof b === 'object') return JSON.stringify(a) === JSON.stringify(b);
  return false;
}
function changedFields<T extends object>(prev: T, next: T, keys: (keyof T)[]): Partial<T> {
  const out: Partial<T> = {};
  for (const k of keys) if (!eq(prev[k], next[k])) out[k] = next[k];
  return out;
}

/**
 * diff(prev, next) → 有序 op 列表:
 *   先 add(session→instrument→clip,满足 FK),再 upd,最后 del(子在前但抑制级联;只发幸存父下的删除)。
 * 级联抑制:删乐器/会话时其 clip 由 DB cascade 删,不再发 clip.del;删会话时其乐器同理。
 */
export function diff(prev: Snapshot, next: Snapshot): Op[] {
  const adds: Op[] = [];
  const upds: Op[] = [];
  const dels: Op[] = [];

  // adds + upds —— 顺序 session → instrument → clip(FK 依赖)
  for (const id in next.sessions) {
    if (!prev.sessions[id]) adds.push({ t: 'sess.add', row: next.sessions[id] });
    else { const f = changedFields(prev.sessions[id], next.sessions[id], SESS_FIELDS); if (Object.keys(f).length) upds.push({ t: 'sess.upd', id, fields: f }); }
  }
  for (const id in next.instruments) {
    if (!prev.instruments[id]) adds.push({ t: 'inst.add', row: next.instruments[id] });
    else { const f = changedFields(prev.instruments[id], next.instruments[id], INST_FIELDS); if (Object.keys(f).length) upds.push({ t: 'inst.upd', id, fields: f }); }
  }
  for (const id in next.clips) {
    if (!prev.clips[id]) adds.push({ t: 'clip.add', row: next.clips[id] });
    else { const f = changedFields(prev.clips[id], next.clips[id], CLIP_FIELDS); if (Object.keys(f).length) upds.push({ t: 'clip.upd', id, fields: f }); }
  }

  // dels —— 排序:clip 在前、inst 次之、session 最后;但父没了的子不发(cascade)
  for (const id in prev.clips) {
    if (next.clips[id]) continue;
    const instId = prev.clips[id].instrumentId;
    if (!next.instruments[instId]) continue; // 乐器也没了 → cascade 删 clip,不发
    dels.push({ t: 'clip.del', id });
  }
  for (const id in prev.instruments) {
    if (next.instruments[id]) continue;
    const sessId = prev.instruments[id].sessionId;
    if (!next.sessions[sessId]) continue; // 会话也没了 → cascade,不发
    dels.push({ t: 'inst.del', id });
  }
  for (const id in prev.sessions) {
    if (!next.sessions[id]) dels.push({ t: 'sess.del', id });
  }

  return [...adds, ...upds, ...dels];
}
