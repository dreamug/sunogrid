// 单个项目:GET / PATCH(改主BPM/量化/名) / DELETE。全部校验归属当前用户。
import { db } from '@/lib/db';
import { getCurrentUser, unauthorized } from '@/lib/auth';

type P = { params: Promise<{ id: string }> };

async function ownedOr(id: string): Promise<{ ok: true } | { ok: false; res: Response }> {
  const user = await getCurrentUser();
  if (!user) return { ok: false, res: unauthorized() };
  const owned = await db.project.findFirst({ where: { id, userId: user.id }, select: { id: true } });
  if (!owned) return { ok: false, res: new Response('not found', { status: 404 }) };
  return { ok: true };
}

export async function GET(_req: Request, { params }: P) {
  const { id } = await params;
  const guard = await ownedOr(id);
  if (!guard.ok) return guard.res;
  const project = await db.project.findUnique({ where: { id } });
  return project ? Response.json(project) : new Response('not found', { status: 404 });
}

export async function PATCH(req: Request, { params }: P) {
  const { id } = await params;
  const guard = await ownedOr(id);
  if (!guard.ok) return guard.res;
  const b = await req.json();
  const data: Record<string, unknown> = {};
  for (const k of ['name', 'masterBpm', 'quantize', 'beatsPerBar'] as const) if (k in b) data[k] = b[k];
  const project = await db.project.update({ where: { id }, data });
  return Response.json(project);
}

export async function DELETE(_req: Request, { params }: P) {
  const { id } = await params;
  const guard = await ownedOr(id);
  if (!guard.ok) return guard.res;
  await db.project.delete({ where: { id } });
  return Response.json({ ok: true });
}
