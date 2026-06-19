// /api/studio —— Studio 规范化持久化(§15)。乐器外壳=列,mixer 拍平成列,Clip 是子表(sample=1 / collage=N)。
// GET ?projectId → 规范化行 → 组装回前端的嵌套 contract 树(Session › Instrument › payload)。引擎/UI 用的契约不变。
// 写入走细粒度 op:见 /api/studio/ops(POST 批量 add/upd/del)。本文件只读。全部按 userId 校验项目归属。
import { db } from '@/lib/db';
import { getCurrentUser, unauthorized } from '@/lib/auth';
import type { Clip, CollageClip, Instrument, InstrumentPayload } from '@/contracts';
import { defaultSends } from '@/contracts';

// —— DB 行 → contract 形状 ——
type DbClip = {
  id: string; soundId: string | null; assetId: string; startSample: number; endSample: number;
  bars: number; timeMul: number | null; semitones: number; gainDb: number; pan: number; eqLowDb: number; eqHighDb: number; startStep: number | null; orderIndex: number;
};
type DbInstrument = {
  id: string; slot: number; type: string; label: string; color: string | null; icon: string | null; enabled: boolean;
  gainDb: number; pan: number; eqLowDb: number; eqHighDb: number;
  collageBars: number | null; stepsPerBar: number | null; loopStartStep: number | null; bakedAssetId: string | null; sends: unknown; clips: DbClip[];
};

const EMPTY_CLIP: Clip = { soundId: '', assetId: '', startSample: 0, endSample: 0, bars: 1, semitones: 0, gainDb: 0 };

function clipFromDb(c: DbClip): Clip {
  return {
    id: c.id, soundId: c.soundId ?? '', assetId: c.assetId, startSample: c.startSample, endSample: c.endSample,
    bars: c.bars, ...(c.timeMul != null ? { timeMul: c.timeMul } : {}), semitones: c.semitones, gainDb: c.gainDb, pan: c.pan, eqLowDb: c.eqLowDb, eqHighDb: c.eqHighDb,
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
    mixer: { gainDb: i.gainDb, pan: i.pan, eq: { lowDb: i.eqLowDb, highDb: i.eqHighDb } },
    sends: i.sends && typeof i.sends === 'object' && !Array.isArray(i.sends) ? (i.sends as Instrument['sends']) : defaultSends(),
    enabled: i.enabled, payload: payloadFromDb(i),
  };
}

export async function GET(req: Request) {
  const user = await getCurrentUser();
  if (!user) return unauthorized();
  const projectId = new URL(req.url).searchParams.get('projectId');
  if (!projectId) return Response.json({ error: 'projectId required' }, { status: 400 });
  const proj = await db.project.findFirst({ where: { id: projectId, userId: user.id }, select: { id: true } });
  if (!proj) return new Response('not found', { status: 404 });

  const sessions = await db.studioSession.findMany({
    where: { projectId },
    include: { instruments: { orderBy: { slot: 'asc' }, include: { clips: { orderBy: { orderIndex: 'asc' } } } } },
    orderBy: { index: 'asc' },
  });
  return Response.json(
    sessions.map((s) => ({
      id: s.id, name: s.name, index: s.index,
      instruments: (s.instruments as unknown as DbInstrument[]).map(instrumentFromDb),
    })),
  );
}
