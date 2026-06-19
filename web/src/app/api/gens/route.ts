// 生成记录:GET ?projectId 列表(当前用户) / POST 新建(状态 queued,校验项目归属)。生命周期靠 PATCH /api/gens/:id 更新。
import { db } from '@/lib/db';
import { getCurrentUser, unauthorized } from '@/lib/auth';

export async function GET(req: Request) {
  const user = await getCurrentUser();
  if (!user) return unauthorized();
  const projectId = new URL(req.url).searchParams.get('projectId');
  const gens = await db.gen.findMany({
    where: { userId: user.id, trashed: false, ...(projectId ? { projectId } : {}) }, // 软删的整组不列(可被 undo 恢复)
    include: {
      sounds: {
        where: { trashed: false, parentSoundId: null }, // 只列顶层;stem 嵌在父下
        include: {
          asset: true,
          stems: { where: { trashed: false }, include: { asset: true }, orderBy: { createdAt: 'asc' } },
        },
        orderBy: { createdAt: 'asc' },
      },
    },
    orderBy: { createdAt: 'desc' },
    take: 50,
  });
  return Response.json(gens);
}

export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user) return unauthorized();
  const b = await req.json();
  const proj = await db.project.findFirst({ where: { id: b.projectId, userId: user.id }, select: { id: true } });
  if (!proj) return new Response('project not found', { status: 404 });
  const gen = await db.gen.create({
    data: {
      userId: user.id,
      projectId: b.projectId,
      mode: b.mode ?? 'sound',
      prompt: b.prompt ?? '',
      bpm: b.bpm ?? 90,
      musicalKey: b.key || null,
      loop: b.loop ?? true,
      instrumental: b.instrumental ?? false,
      status: 'queued',
    },
  });
  return Response.json(gen, { status: 201 });
}
