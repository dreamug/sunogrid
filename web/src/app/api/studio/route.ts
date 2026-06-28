// /api/studio —— Studio 规范化持久化(§15)。乐器外壳=列,mixer 拍平成列,Clip 是子表(sample=1 / collage=N)。
// GET ?projectId → 规范化行 → 组装回前端的嵌套 contract 树(Session › Instrument › payload)。引擎/UI 用的契约不变。
// 写入走细粒度 op:见 /api/studio/ops(POST 批量 add/upd/del)。本文件只读。全部按 userId 校验项目归属。
import { db } from '@/lib/db';
import { getCurrentUser, unauthorized } from '@/lib/auth';
import type { Clip, CollageClip, Instrument, InstrumentPayload } from '@/contracts';
import { defaultSends, sessionBars, sessionRepeats, type Session } from '@/contracts';

// —— DB 行 → contract 形状 ——
type DbClip = {
  id: string; soundId: string | null; assetId: string; startSample: number; endSample: number;
  bars: number; timeMul: number | null; warpPts: unknown; semitones: number; fadeOutBars: number | null; fadeSilenceBars: number | null; gainDb: number; pan: number; eqLowDb: number; eqMidDb: number; eqHighDb: number; startStep: number | null; orderIndex: number;
};
type DbInstrument = {
  id: string; slot: number; type: string; label: string; color: string | null; icon: string | null; enabled: boolean;
  gainDb: number; pan: number; eqLowDb: number; eqMidDb: number; eqHighDb: number;
  collageBars: number | null; stepsPerBar: number | null; loopStartStep: number | null; bakedAssetId: string | null; sends: unknown; clips: DbClip[];
};

const EMPTY_CLIP: Clip = { soundId: '', assetId: '', startSample: 0, endSample: 0, bars: 1, semitones: 0, gainDb: 0 };

function clipFromDb(c: DbClip): Clip {
  return {
    id: c.id, soundId: c.soundId ?? '', assetId: c.assetId, startSample: c.startSample, endSample: c.endSample,
    bars: c.bars, ...(c.timeMul != null ? { timeMul: c.timeMul } : {}), ...(Array.isArray(c.warpPts) && c.warpPts.length ? { warpPts: c.warpPts as Clip['warpPts'] } : {}), semitones: c.semitones, ...(c.fadeOutBars != null ? { fadeOutBars: c.fadeOutBars } : {}), ...(c.fadeSilenceBars != null ? { fadeSilenceBars: c.fadeSilenceBars } : {}), gainDb: c.gainDb, pan: c.pan, eqLowDb: c.eqLowDb, eqMidDb: c.eqMidDb, eqHighDb: c.eqHighDb,
  };
}

function payloadFromDb(i: DbInstrument): InstrumentPayload {
  if (i.type === 'collage') {
    const clips: CollageClip[] = [...i.clips]
      .sort((a, b) => a.orderIndex - b.orderIndex)
      .map((c) => ({ ...clipFromDb(c), id: c.id, startStep: c.startStep ?? 0 }));
    return { kind: 'collage', bars: i.collageBars ?? 2, stepsPerBar: i.stepsPerBar ?? 16, loopStartStep: i.loopStartStep ?? 0, bakedAssetId: i.bakedAssetId ?? null, clips };
  }
  const first = i.clips[0];
  return { kind: 'sample', clip: first ? clipFromDb(first) : { ...EMPTY_CLIP } };
}

function instrumentFromDb(i: DbInstrument): Instrument {
  return {
    id: i.id, slot: i.slot, label: i.label, color: i.color, icon: i.icon,
    mixer: { gainDb: i.gainDb, pan: i.pan, eq: { lowDb: i.eqLowDb, midDb: i.eqMidDb ?? 0, highDb: i.eqHighDb } },
    sends: i.sends && typeof i.sends === 'object' && !Array.isArray(i.sends) ? (i.sends as Instrument['sends']) : defaultSends(),
    enabled: i.enabled, payload: payloadFromDb(i),
  };
}

export async function GET(req: Request) {
  const user = await getCurrentUser();
  if (!user) return unauthorized();
  const projectId = new URL(req.url).searchParams.get('projectId');
  if (!projectId) return Response.json({ error: 'projectId required' }, { status: 400 });
  const proj = await db.project.findFirst({ where: { id: projectId, userId: user.id }, select: { id: true, songLayoutVersion: true } });
  if (!proj) return new Response('not found', { status: 404 });

  const query = {
    where: { projectId },
    include: { instruments: { orderBy: { slot: 'asc' as const }, include: { clips: { orderBy: { orderIndex: 'asc' as const } } } } },
    orderBy: { index: 'asc' as const },
  };
  let sessions = await db.studioSession.findMany(query);
  // 空工程:服务端落地默认会话(Verse/Break),给真实持久化 id。否则客户端会兜底造 emptySessions(),
  // 那批 id 不在库 → 之后 inst.add 引用孤儿 sessionId,被 /api/studio/ops 静默丢弃(返回 200 却 0 落库)——
  // 新工程的 pad 永远存不进去就是这么来的。确定性 id + skipDuplicates → 并发 GET(StrictMode 双挂载)也不会建重复。
  if (sessions.length === 0) {
    // 新工程只落地 1 个默认会话(确定性 id + skipDuplicates → StrictMode 双挂载/并发 GET 也不会建重复)。
    await db.studioSession.createMany({
      data: [{ id: `${projectId}-scene1`, projectId, name: 'Scene 1', index: 0, songLane: 0, songStartBar: 0, color: null }],
      skipDuplicates: true,
    });
    sessions = await db.studioSession.findMany(query);
  }
  const migrateSongLayout = (proj.songLayoutVersion ?? 0) < 1;
  let acc = 0;
  const out = sessions.map((s) => {
    const inferredStart = acc;
    const songLane = s.songLane ?? 0;
    const songStartBar = migrateSongLayout && songLane === 0 && (s.songStartBar ?? 0) === 0 && s.index > 0 ? inferredStart : (s.songStartBar ?? 0);
    const row = {
      id: s.id, name: s.name, index: s.index, songLane, songStartBar, songAnchorId: s.songAnchorId ?? null, songOffsetBar: s.songOffsetBar ?? 0, repeats: s.repeats ?? 1, color: s.color ?? null, xyAuto: (s.xyAuto ?? null) as Session['xyAuto'], // §26 Json 列,Prisma 已反序列化为对象
      instruments: (s.instruments as unknown as DbInstrument[]).map(instrumentFromDb),
    } satisfies Session;
    // 老项目迁移兜底:版本 0 的旧线性 Song 按 index 推导一次,随后写回并升到版本 1。
    acc += sessionBars(row) * sessionRepeats(row);
    return row;
  });
  if (migrateSongLayout) {
    await db.$transaction([
      ...out.map((s) => db.studioSession.updateMany({ where: { id: s.id, projectId }, data: { songLane: s.songLane ?? 0, songStartBar: s.songStartBar ?? 0 } })),
      db.project.update({ where: { id: projectId }, data: { songLayoutVersion: 1 } }),
    ]);
  }
  return Response.json(out);
}
