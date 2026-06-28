// 健康检查:验证 DB 连得上 + 表已建(迁移后用)。
import { db } from '@/lib/db';

export async function GET() {
  try {
    const [projects, sounds, assets, gens] = await Promise.all([
      db.project.count(),
      db.sound.count(),
      db.asset.count(),
      db.gen.count(),
    ]);
    return Response.json({ ok: true, counts: { projects, sounds, assets, gens } });
  } catch (e) {
    console.error('[health]', e); // 错误细节落日志,不回客户端
    return Response.json({ ok: false, error: 'db unavailable' }, { status: 500 });
  }
}
