// /api/studio/ops —— 细粒度持久化(§15.C)。POST { projectId, ops[] }。
// 事务内按序应用 session/instrument/clip 的 add/upd/del,每个写操作都按“归属当前用户的这个项目”作用域 ——
// updateMany/deleteMany 用关系把 where 锁到 projectId(不属于则影响 0 行);create 前校验父在本项目内。
import { db } from '@/lib/db';
import { getCurrentUser, unauthorized } from '@/lib/auth';
import type { Op, NInstrument, NClip } from '@/studio/sync';

const INST_COLS = ['sessionId', 'slot', 'type', 'label', 'color', 'icon', 'enabled', 'gainDb', 'pan', 'eqLowDb', 'eqHighDb', 'collageBars', 'stepsPerBar', 'loopStartStep', 'bakedAssetId', 'sends'] as const;
const CLIP_COLS = ['instrumentId', 'soundId', 'assetId', 'startSample', 'endSample', 'bars', 'timeMul', 'semitones', 'gainDb', 'pan', 'eqLowDb', 'eqHighDb', 'startStep', 'orderIndex'] as const;

const pick = <T extends object>(o: T, cols: readonly (keyof T)[]): Record<string, unknown> => {
  const out: Record<string, unknown> = {};
  for (const k of cols) if (k in o) out[k as string] = o[k];
  return out;
};

// 把 soundId(空串或不属于本用户)归一成 null;assetId 全局,不在此限。
function clipData(row: Partial<NClip>, ownedSounds: Set<string>): Record<string, unknown> {
  const d = pick(row as NClip, CLIP_COLS);
  if ('soundId' in d) {
    const sid = d.soundId as string;
    d.soundId = sid && ownedSounds.has(sid) ? sid : null;
  }
  return d;
}
function instData(row: Partial<NInstrument>): Record<string, unknown> {
  const d = pick(row as NInstrument, INST_COLS);
  if ('sends' in d) d.sends = (d.sends ?? { dist: 0, delay: 0, reverb: 0 }) as object;
  return d;
}

export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user) return unauthorized();
  const b = (await req.json()) as { projectId?: string; ops?: Op[] };
  if (!b.projectId || !Array.isArray(b.ops)) return Response.json({ error: 'projectId + ops[] required' }, { status: 400 });
  const { projectId, ops } = b;
  if (ops.length === 0) return Response.json({ ok: true, applied: 0 });

  const proj = await db.project.findFirst({ where: { id: projectId, userId: user.id }, select: { id: true } });
  if (!proj) return new Response('not found', { status: 404 });

  // soundId 归属:收集 ops 里引用的 soundId,只放行属于本用户的。
  const soundIds = new Set<string>();
  for (const op of ops) {
    if (op.t === 'clip.add' && op.row.soundId) soundIds.add(op.row.soundId);
    if (op.t === 'clip.upd' && op.fields.soundId) soundIds.add(op.fields.soundId);
  }
  const ownedSounds = new Set<string>();
  if (soundIds.size) {
    const owned = await db.sound.findMany({ where: { id: { in: [...soundIds] }, userId: user.id }, select: { id: true } });
    for (const s of owned) ownedSounds.add(s.id);
  }

  const skipped: Op[] = []; // 父不在本项目而被丢弃的 add(正常流程下应为空;非空=客户端基准与 DB 失配的 bug 信号)
  try {
    await db.$transaction(async (tx) => {
      // 本项目现存的 session / instrument id(用于校验 create 的父合法 + 维护批内新建)。
      const existSessions = await tx.studioSession.findMany({ where: { projectId }, select: { id: true } });
      const existInstruments = await tx.studioInstrument.findMany({ where: { session: { projectId } }, select: { id: true } });
      const liveSessions = new Set(existSessions.map((s) => s.id));
      const liveInstruments = new Set(existInstruments.map((i) => i.id));

      for (const op of ops) {
        switch (op.t) {
          case 'sess.add':
            await tx.studioSession.create({ data: { id: op.row.id, projectId, name: op.row.name, index: op.row.index } });
            liveSessions.add(op.row.id);
            break;
          case 'sess.upd':
            await tx.studioSession.updateMany({ where: { id: op.id, projectId }, data: pick(op.fields, ['name', 'index']) });
            break;
          case 'sess.del':
            await tx.studioSession.deleteMany({ where: { id: op.id, projectId } });
            liveSessions.delete(op.id);
            break;
          case 'inst.add':
            if (!liveSessions.has(op.row.sessionId)) { skipped.push(op); break; } // 父会话不在本项目 → 拒绝
            await tx.studioInstrument.create({ data: { id: op.row.id, ...instData(op.row) } as never });
            liveInstruments.add(op.row.id);
            break;
          case 'inst.upd':
            await tx.studioInstrument.updateMany({ where: { id: op.id, session: { projectId } }, data: instData(op.fields) });
            break;
          case 'inst.del':
            await tx.studioInstrument.deleteMany({ where: { id: op.id, session: { projectId } } });
            liveInstruments.delete(op.id);
            break;
          case 'clip.add':
            if (!liveInstruments.has(op.row.instrumentId)) { skipped.push(op); break; } // 父乐器不在本项目 → 拒绝
            await tx.clip.create({ data: { id: op.row.id, ...clipData(op.row, ownedSounds) } as never });
            break;
          case 'clip.upd':
            await tx.clip.updateMany({ where: { id: op.id, instrument: { session: { projectId } } }, data: clipData(op.fields, ownedSounds) });
            break;
          case 'clip.del':
            await tx.clip.deleteMany({ where: { id: op.id, instrument: { session: { projectId } } } });
            break;
        }
      }
    });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : 'apply failed' }, { status: 500 });
  }
  // 静默丢弃过 add(孤儿父)→ 这是 bug,不是正常路径。打日志 + 据实回报 skipped,让客户端别再当"已保存"。
  if (skipped.length) console.warn(`[studio/ops] 丢弃 ${skipped.length} 条孤儿 add(父 session/instrument 不在 DB):`, skipped.map((o) => o.t));
  return Response.json({ ok: true, applied: ops.length - skipped.length, skipped: skipped.length });
}
