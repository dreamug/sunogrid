// 单个 sound:PATCH 改名/标签/默认warp/软删 ; DELETE 软删(trashed)。校验归属当前用户。
import { db } from '@/lib/db';
import { getCurrentUser, unauthorized } from '@/lib/auth';

type P = { params: Promise<{ id: string }> };

async function ownsSound(id: string): Promise<boolean> {
  const user = await getCurrentUser();
  if (!user) return false;
  const owned = await db.sound.findFirst({ where: { id, userId: user.id }, select: { id: true } });
  return !!owned;
}

export async function PATCH(req: Request, { params }: P) {
  const { id } = await params;
  if (!(await ownsSound(id))) return new Response('not found', { status: 404 });
  const b = await req.json();
  const data: Record<string, unknown> = {};
  for (const k of ['name', 'tags', 'warp', 'trashed', 'musicalKey'] as const) if (k in b) data[k] = b[k];
  const sound = await db.sound.update({ where: { id }, data, include: { asset: true } });
  return Response.json(sound);
}

export async function DELETE(req: Request, { params }: P) {
  const { id } = await params;
  if (!(await ownsSound(id))) return new Response('not found', { status: 404 });
  // 默认软删(可撤,§16 库存活集)。?hard=1 = 硬删(§33 重切旧块):级联清块的 stem(parentSoundId Cascade),
  //   引用它的 clip/pad SetNull(字节仍在 Asset);硬删后 undo 也无法复活已删行 → 免重切产生重复块。
  if (new URL(req.url).searchParams.get('hard') === '1') {
    await db.sound.delete({ where: { id } });
  } else {
    await db.sound.update({ where: { id }, data: { trashed: true } });
  }
  return Response.json({ ok: true });
}
