// 注册:用户名 + 密码 + 确认密码。成功即建会话(自动登录)。
import { db } from '@/lib/db';
import { hashPassword, createSession } from '@/lib/auth';
import { rateLimit, clientIp } from '@/lib/rateLimit';

export async function POST(req: Request) {
  // 限流:同 IP 10 次/小时,挡批量注册刷号。
  const rl = rateLimit(`register:${clientIp(req)}`, 10, 60 * 60_000);
  if (!rl.ok) {
    return Response.json({ error: 'Too many attempts. Try again later.' }, { status: 429, headers: { 'retry-after': String(rl.retryAfterSec) } });
  }

  const b = (await req.json().catch(() => ({}))) as { username?: string; password?: string; confirm?: string };
  const username = (b.username ?? '').trim();
  const password = b.password ?? '';
  const confirm = b.confirm ?? '';

  if (username.length < 2) return Response.json({ error: 'Username must be at least 2 characters' }, { status: 400 });
  if (password.length < 6) return Response.json({ error: 'Password must be at least 6 characters' }, { status: 400 });
  if (password !== confirm) return Response.json({ error: "Passwords don't match" }, { status: 400 });

  const exists = await db.user.findUnique({ where: { username } });
  if (exists) return Response.json({ error: 'Username taken' }, { status: 409 });

  const passwordHash = await hashPassword(password);
  let user;
  try {
    user = await db.user.create({ data: { username, passwordHash } });
  } catch (e) {
    // 并发注册撞唯一约束(check-then-create 的 TOCTOU)→ 干净 409,不抛 500。
    if (e && typeof e === 'object' && 'code' in e && (e as { code?: string }).code === 'P2002') {
      return Response.json({ error: 'Username taken' }, { status: 409 });
    }
    throw e;
  }
  await createSession(user.id);
  return Response.json({ id: user.id, username: user.username }, { status: 201 });
}
