// 用户级素材库:GET 列表(当前用户;可 ?originProjectId 过滤;默认排除 trashed) / POST 落库(音频 b64 → Asset + Sound)。
import { db } from '@/lib/db';
import { base64ToBuffer, putAudioAsset } from '@/lib/storage';
import { getCurrentUser, unauthorized } from '@/lib/auth';

export async function GET(req: Request) {
  const user = await getCurrentUser();
  if (!user) return unauthorized();
  const sp = new URL(req.url).searchParams;
  const originProjectId = sp.get('originProjectId');
  const sounds = await db.sound.findMany({
    where: { userId: user.id, trashed: false, parentSoundId: null, ...(originProjectId ? { originProjectId } : {}) },
    include: {
      asset: true,
      stems: { where: { trashed: false }, include: { asset: true }, orderBy: { createdAt: 'asc' } },
    },
    orderBy: { createdAt: 'desc' },
  });
  return Response.json(sounds);
}

export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user) return unauthorized();
  const b = await req.json();
  if (!b.audioB64) return Response.json({ error: 'audioB64 required' }, { status: 400 });
  const asset = await putAudioAsset(base64ToBuffer(b.audioB64), { kind: 'source', sourceUrl: b.sourceUrl });
  const sound = await db.sound.create({
    data: {
      userId: user.id,
      originProjectId: b.originProjectId || null,
      genId: b.genId || null,
      name: b.name ?? '未命名',
      mode: b.mode ?? 'sound',
      sourceBpm: b.sourceBpm ?? 90,
      musicalKey: b.key || null,
      durationSec: b.durationSec ?? 0,
      sampleRate: b.sampleRate ?? 48000,
      channels: b.channels ?? 2,
      analysis: b.analysis ?? undefined,
      warp: b.warp ?? undefined,
      assetId: asset.id,
    },
    include: { asset: true },
  });
  return Response.json(sound, { status: 201 });
}
