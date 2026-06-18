// 项目:GET 列表(当前用户) / POST 新建(挂当前用户)。
import { db } from '@/lib/db';
import { getCurrentUser, unauthorized } from '@/lib/auth';

export async function GET() {
  const user = await getCurrentUser();
  if (!user) return unauthorized();
  const projects = await db.project.findMany({ where: { userId: user.id }, orderBy: { updatedAt: 'desc' } });
  return Response.json(projects);
}

export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user) return unauthorized();
  const b = await req.json().catch(() => ({}));
  const project = await db.project.create({
    data: {
      userId: user.id,
      name: b.name || '未命名项目',
      masterBpm: b.masterBpm ?? 90,
      quantize: b.quantize ?? '1bar',
      beatsPerBar: b.beatsPerBar ?? 4,
    },
  });
  return Response.json(project, { status: 201 });
}
