// 单个 gen:GET / PATCH 更新生命周期状态 / DELETE。校验归属当前用户。
import { db } from '@/lib/db';
import { getCurrentUser, unauthorized } from '@/lib/auth';

type P = { params: Promise<{ id: string }> };

async function ownsGen(id: string): Promise<boolean> {
  const user = await getCurrentUser();
  if (!user) return false;
  const owned = await db.gen.findFirst({ where: { id, userId: user.id }, select: { id: true } });
  return !!owned;
}

export async function GET(_req: Request, { params }: P) {
  const { id } = await params;
  if (!(await ownsGen(id))) return new Response('not found', { status: 404 });
  const gen = await db.gen.findUnique({ where: { id }, include: { sounds: true } });
  return gen ? Response.json(gen) : new Response('not found', { status: 404 });
}

export async function PATCH(req: Request, { params }: P) {
  const { id } = await params;
  if (!(await ownsGen(id))) return new Response('not found', { status: 404 });
  const b = await req.json();
  const data: Record<string, unknown> = {};
  for (const k of ['status', 'error', 'sunoBatchId', 'sunoClipIds', 'trashed'] as const) if (k in b) data[k] = b[k]; // trashed:撤销恢复整组(§16 口径⑦)
  const gen = await db.gen.update({ where: { id }, data });
  return Response.json(gen);
}

// 删除一组生成:全软删 —— 标记 gen.trashed + 软删其下所有变体(及变体的 stem)。整组可被 undo 恢复(§16 口径⑦:gen 行不再硬删)。
export async function DELETE(_req: Request, { params }: P) {
  const { id } = await params;
  if (!(await ownsGen(id))) return new Response('not found', { status: 404 });
  const variants = await db.sound.findMany({ where: { genId: id }, select: { id: true } });
  const ids = variants.map((s) => s.id);
  if (ids.length) {
    await db.sound.updateMany({
      where: { OR: [{ genId: id }, { parentSoundId: { in: ids } }] },
      data: { trashed: true },
    });
  }
  await db.gen.update({ where: { id }, data: { trashed: true } });
  return Response.json({ ok: true });
}
