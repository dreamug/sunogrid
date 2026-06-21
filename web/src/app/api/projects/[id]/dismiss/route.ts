// §25 示例项目:POST /api/projects/:id/dismiss —— 把某个示例母版"从我的列表移除"(per-user 隐藏)。
// 不删母版、不删任何副本;只在 ExampleDismissal 加一行。仅对【别人标的示例母版】有意义。
// DELETE = 取消隐藏(恢复;v1 前端未必接,但数据层备好)。
import { db } from '@/lib/db';
import { getCurrentUser, unauthorized } from '@/lib/auth';

type P = { params: Promise<{ id: string }> };

export async function POST(_req: Request, { params }: P) {
  const { id } = await params;
  const user = await getCurrentUser();
  if (!user) return unauthorized();

  const example = await db.project.findUnique({ where: { id }, select: { id: true, isExample: true, userId: true } });
  if (!example || !example.isExample || example.userId === user.id) {
    // 不是示例,或是自己的母版(自己的母版要删走 DELETE /api/projects/:id) → 不该 dismiss。
    return new Response('not found', { status: 404 });
  }
  await db.exampleDismissal.upsert({
    where: { userId_projectId: { userId: user.id, projectId: id } },
    create: { userId: user.id, projectId: id },
    update: {},
  });
  return Response.json({ ok: true });
}

export async function DELETE(_req: Request, { params }: P) {
  const { id } = await params;
  const user = await getCurrentUser();
  if (!user) return unauthorized();
  await db.exampleDismissal.deleteMany({ where: { userId: user.id, projectId: id } });
  return Response.json({ ok: true });
}
