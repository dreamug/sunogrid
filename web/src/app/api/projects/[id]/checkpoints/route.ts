// §44 手动版本 / 存点:POST 存一版(仅项目态快照)、GET 取最新一版(v1 单还原点)。全部校验归属当前用户。
// 快照是不可变归档(§15.A),回退不走此路由 —— 客户端取快照后经 §16 applyEntry + §15 发件箱自己落库(见 PRODUCT §44.5)。
import { db } from '@/lib/db';
import { getCurrentUser, unauthorized } from '@/lib/auth';

type P = { params: Promise<{ id: string }> };
const KEEP = 20; // 每项目保留最近 N 版,超出裁掉最老

async function owned(id: string, userId: string) {
  return db.project.findFirst({ where: { id, userId }, select: { id: true } });
}

// 最新一版(无则 null)。
export async function GET(_req: Request, { params }: P) {
  const { id } = await params;
  const user = await getCurrentUser();
  if (!user) return unauthorized();
  if (!(await owned(id, user.id))) return new Response('not found', { status: 404 });
  const checkpoint = await db.projectCheckpoint.findFirst({ where: { projectId: id }, orderBy: { createdAt: 'desc' } });
  return Response.json({ checkpoint });
}

// 存一版:body { snapshot, label? }。snapshot = 客户端序列化的项目态(§44.3)。存后裁到最近 KEEP 条。
export async function POST(req: Request, { params }: P) {
  const { id } = await params;
  const user = await getCurrentUser();
  if (!user) return unauthorized();
  if (!(await owned(id, user.id))) return new Response('not found', { status: 404 });
  const b = await req.json().catch(() => null);
  // review #6:拒绝数组 / 缺 sessions 的畸形快照 —— 否则存进永远 Restore 失败的垃圾行(还占 KEEP 名额、误让 ckptHas=true)。
  if (!b || typeof b.snapshot !== 'object' || b.snapshot == null || Array.isArray(b.snapshot) || !Array.isArray(b.snapshot.sessions)) return new Response('bad snapshot', { status: 400 });
  const checkpoint = await db.projectCheckpoint.create({
    data: { projectId: id, label: typeof b.label === 'string' ? b.label.slice(0, 120) : null, snapshot: b.snapshot },
  });
  // prune:保留最近 KEEP 条,删更老的(skip 前 KEEP 条 → 剩下的全删)。
  const stale = await db.projectCheckpoint.findMany({ where: { projectId: id }, orderBy: { createdAt: 'desc' }, skip: KEEP, select: { id: true } });
  if (stale.length) await db.projectCheckpoint.deleteMany({ where: { id: { in: stale.map((s) => s.id) } } });
  return Response.json({ checkpoint });
}
