// 认证(轻量自建):用户名 + 密码哈希(bcryptjs) + DB 会话(cookie token → AuthSession → User)。
// 详见 PRODUCT.md §15.D。无邮箱、无 OAuth —— 注册=用户名+双密码,登录=用户名+密码。
import 'server-only';
import { cookies } from 'next/headers';
import { randomBytes } from 'crypto';
import bcrypt from 'bcryptjs';
import { db } from './db';
import { SESSION_COOKIE } from './authConst';

export { SESSION_COOKIE };
const SESSION_DAYS = 30;

export type SessionUser = { id: string; username: string };

export function hashPassword(pw: string): Promise<string> {
  return bcrypt.hash(pw, 10);
}
export function verifyPassword(pw: string, hash: string): Promise<boolean> {
  return bcrypt.compare(pw, hash);
}

export async function createSession(userId: string): Promise<void> {
  const token = randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 24 * 3600 * 1000);
  await db.authSession.create({ data: { token, userId, expiresAt } });
  const jar = await cookies();
  jar.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    expires: expiresAt,
    secure: process.env.NODE_ENV === 'production',
  });
}

export async function destroySession(): Promise<void> {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (token) {
    await db.authSession.deleteMany({ where: { token } }).catch(() => {});
    jar.delete(SESSION_COOKIE);
  }
}

/** 读 cookie → 查会话 → 返回当前用户(过期/无效返回 null)。 */
export async function getCurrentUser(): Promise<SessionUser | null> {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (!token) return null;
  const session = await db.authSession.findUnique({ where: { token }, include: { user: true } });
  if (!session) return null;
  if (session.expiresAt.getTime() < Date.now()) {
    await db.authSession.delete({ where: { token } }).catch(() => {});
    return null;
  }
  return { id: session.user.id, username: session.user.username };
}

/** 401 JSON 响应。 */
export function unauthorized(): Response {
  return Response.json({ error: 'unauthorized' }, { status: 401 });
}

/** 路由里取当前用户;无则返回 null + 已备好的 401。用法:const { user, res } = await requireUser(); if (!user) return res; */
export async function requireUser(): Promise<{ user: SessionUser | null; res: Response }> {
  const user = await getCurrentUser();
  return { user, res: unauthorized() };
}
