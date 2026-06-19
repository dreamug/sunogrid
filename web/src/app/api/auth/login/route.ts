// 登录:用户名 + 密码。
import { db } from '@/lib/db';
import { verifyPassword, createSession } from '@/lib/auth';

export async function POST(req: Request) {
  const b = (await req.json().catch(() => ({}))) as { username?: string; password?: string };
  const username = (b.username ?? '').trim();
  const password = b.password ?? '';
  if (!username || !password) return Response.json({ error: 'Enter your username and password' }, { status: 400 });

  const user = await db.user.findUnique({ where: { username } });
  if (!user || !(await verifyPassword(password, user.passwordHash))) {
    return Response.json({ error: 'Wrong username or password' }, { status: 401 });
  }
  await createSession(user.id);
  return Response.json({ id: user.id, username: user.username });
}
