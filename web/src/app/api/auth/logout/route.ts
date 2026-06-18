// 退出登录:删会话 + 清 cookie。
import { destroySession } from '@/lib/auth';

export async function POST() {
  await destroySession();
  return Response.json({ ok: true });
}
