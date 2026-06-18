// pad 副本(老 loop 机):GET ?projectId 列出某项目的所有 pad / POST 放置(把 Sound 复制到 (bank,padIndex))。
// 放置 = 复制 Sound 的默认 warp 到一个 PadClip(音频字节共享 Asset),之后编辑都在这个副本上。校验项目/素材归属当前用户。
import { db } from '@/lib/db';
import { getCurrentUser, unauthorized } from '@/lib/auth';

export async function GET(req: Request) {
  const user = await getCurrentUser();
  if (!user) return unauthorized();
  const projectId = new URL(req.url).searchParams.get('projectId');
  if (!projectId) return Response.json({ error: 'projectId required' }, { status: 400 });
  const proj = await db.project.findFirst({ where: { id: projectId, userId: user.id }, select: { id: true } });
  if (!proj) return new Response('not found', { status: 404 });
  const pads = await db.padClip.findMany({
    where: { projectId },
    include: { asset: true, sourceSound: true },
    orderBy: [{ bank: 'asc' }, { padIndex: 'asc' }],
  });
  return Response.json(pads);
}

export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user) return unauthorized();
  const b = await req.json();
  const proj = await db.project.findFirst({ where: { id: b.projectId, userId: user.id }, select: { id: true } });
  if (!proj) return new Response('project not found', { status: 404 });
  const sound = await db.sound.findFirst({ where: { id: b.soundId, userId: user.id } });
  if (!sound) return Response.json({ error: 'sound not found' }, { status: 404 });
  const warp = (b.warp ?? sound.warp ?? {}) as object; // 放置时拷源 Sound 的 warp 当初值;移动/互换可传 warp 覆盖以保留该 pad 自己的 warp
  const pad = await db.padClip.upsert({
    where: { projectId_bank_padIndex: { projectId: b.projectId, bank: b.bank, padIndex: b.padIndex } },
    create: { projectId: b.projectId, bank: b.bank, padIndex: b.padIndex, sourceSoundId: sound.id, assetId: sound.assetId, warp, label: sound.name, gainDb: 0 },
    update: { sourceSoundId: sound.id, assetId: sound.assetId, warp, label: sound.name }, // 覆盖该位置
    include: { asset: true, sourceSound: true },
  });
  return Response.json(pad, { status: 201 });
}
