// 登录:用户名 + 密码。
import { db } from '@/lib/db';
import { verifyPassword, createSession } from '@/lib/auth';
import { rateLimit, rateLimitReset, clientIp } from '@/lib/rateLimit';

// 用户不存在时也跑一次 bcrypt 比对(对一个固定假哈希),抹平"已知用户名 vs 未知"的响应耗时差 —— 否则计时即可枚举用户名。
const DUMMY_HASH = '$2b$10$62QauEqF2cv/kkTMcDp7rOg8fB5H5LWB4nTjYrvpmaH15DABoFqZS';

export async function POST(req: Request) {
  // 限流:同 IP 10 次/10 分钟,挡暴力撞库。成功后清零,不惩罚误输的正常用户。
  const ip = clientIp(req);
  const rlKey = `login:${ip}`;
  const rl = rateLimit(rlKey, 10, 10 * 60_000);
  if (!rl.ok) {
    return Response.json({ error: 'Too many attempts. Try again later.' }, { status: 429, headers: { 'retry-after': String(rl.retryAfterSec) } });
  }

  const b = (await req.json().catch(() => ({}))) as { username?: string; password?: string };
  const username = (b.username ?? '').trim();
  const password = b.password ?? '';
  if (!username || !password) return Response.json({ error: 'Enter your username and password' }, { status: 400 });

  const user = await db.user.findUnique({ where: { username } });
  const ok = await verifyPassword(password, user?.passwordHash ?? DUMMY_HASH); // 无论用户是否存在都比对一次,恒定耗时
  if (!user || !ok) {
    return Response.json({ error: 'Wrong username or password' }, { status: 401 });
  }
  await createSession(user.id);
  rateLimitReset(rlKey);
  return Response.json({ id: user.id, username: user.username });
}
