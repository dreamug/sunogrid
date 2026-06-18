// 单个 pad 副本:PATCH 改 warp/标签/增益(pad 级编辑都写这);DELETE 清空该 pad。校验该 pad 所属项目归属当前用户。
import { db } from '@/lib/db';
import { getCurrentUser, unauthorized } from '@/lib/auth';

type P = { params: Promise<{ id: string }> };

async function ownsPad(id: string): Promise<boolean> {
  const user = await getCurrentUser();
  if (!user) return false;
  const owned = await db.padClip.findFirst({ where: { id, project: { userId: user.id } }, select: { id: true } });
  return !!owned;
}

export async function PATCH(req: Request, { params }: P) {
  const { id } = await params;
  if (!(await ownsPad(id))) return new Response('not found', { status: 404 });
  const b = await req.json();
  const data: Record<string, unknown> = {};
  for (const k of ['warp', 'label', 'gainDb'] as const) if (k in b) data[k] = b[k];
  const pad = await db.padClip.update({ where: { id }, data, include: { asset: true, sourceSound: true } });
  return Response.json(pad);
}

export async function DELETE(_req: Request, { params }: P) {
  const { id } = await params;
  if (!(await ownsPad(id))) return new Response('not found', { status: 404 });
  await db.padClip.delete({ where: { id } });
  return Response.json({ ok: true });
}
