// §25 示例项目:POST /api/projects/:id/fork —— 进入示例即写时复制出「我自己的可编辑副本」(去重 resume)。
// 只对 isExample 母版有效。owner 开自己的母版 = 直接返回母版 id(编母版,不 fork)。
import { db } from '@/lib/db';
import { getCurrentUser, unauthorized } from '@/lib/auth';
import { forkExampleProject } from '@/lib/forkProject';

type P = { params: Promise<{ id: string }> };

export async function POST(_req: Request, { params }: P) {
  const { id } = await params;
  const user = await getCurrentUser();
  if (!user) return unauthorized();

  const example = await db.project.findUnique({ where: { id }, select: { id: true, isExample: true, userId: true } });
  if (!example || !example.isExample) return new Response('not found', { status: 404 });
  // owner(站长)开自己标的母版 → 直接进母版编辑,不生副本。
  if (example.userId === user.id) return Response.json({ id: example.id, resumed: true });

  const { id: copyId, resumed } = await forkExampleProject(example.id, user.id);
  return Response.json({ id: copyId, resumed });
}
