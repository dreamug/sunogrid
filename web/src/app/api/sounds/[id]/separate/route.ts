// 乐器分离:POST /api/sounds/:id/separate → 调本地 Demucs sidecar,建 stem 子 Sound。校验归属当前用户。
import { db } from '@/lib/db';
import { separateSound } from '@/lib/stems';
import { getCurrentUser, unauthorized } from '@/lib/auth';

type P = { params: Promise<{ id: string }> };

export async function POST(_req: Request, { params }: P) {
  const { id } = await params;
  const user = await getCurrentUser();
  if (!user) return unauthorized();
  const owned = await db.sound.findFirst({ where: { id, userId: user.id }, select: { id: true } });
  if (!owned) return new Response('not found', { status: 404 });
  try {
    const stems = await separateSound(id);
    return Response.json({ ok: true, stems });
  } catch (e) {
    console.error('[sounds/separate]', e); // 细节落服务端日志,不回客户端(可能含 sidecar 路径/内部状态)
    return Response.json({ ok: false, error: 'stem separation failed' }, { status: 502 });
  }
}
