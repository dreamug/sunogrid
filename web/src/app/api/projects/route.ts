// 项目:GET 列表(当前用户) / POST 新建(挂当前用户)。
import { db } from '@/lib/db';
import { getCurrentUser, unauthorized } from '@/lib/auth';

export async function GET() {
  const user = await getCurrentUser();
  if (!user) return unauthorized();
  // §25 并集:我的项目 ∪ 未被我隐藏的示例母版(别人标的)。每行带 owned/isExample,前端据此决定 fork/删除/角标。
  const dismissed = await db.exampleDismissal.findMany({ where: { userId: user.id }, select: { projectId: true } });
  const dismissedIds = dismissed.map((d) => d.projectId);
  const [own, examples] = await Promise.all([
    db.project.findMany({ where: { userId: user.id }, orderBy: { updatedAt: 'desc' } }),
    db.project.findMany({
      where: { isExample: true, userId: { not: user.id }, id: { notIn: dismissedIds } },
      orderBy: { updatedAt: 'desc' },
    }),
  ]);
  // 示例排在前(新用户一进来就看见);owned 标志区分"我的(含我自己的母版)"vs"只读示例"。
  const out = [
    ...examples.map((p) => ({ ...p, owned: false })),
    ...own.map((p) => ({ ...p, owned: true })),
  ];
  return Response.json(out);
}

export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user) return unauthorized();
  const b = await req.json().catch(() => ({}));
  const project = await db.project.create({
    data: {
      userId: user.id,
      name: b.name || 'Untitled project',
      masterBpm: b.masterBpm ?? 90,
      quantize: b.quantize ?? '1bar',
      beatsPerBar: b.beatsPerBar ?? 4,
      songLayoutVersion: 1,
    },
  });
  return Response.json(project, { status: 201 });
}
