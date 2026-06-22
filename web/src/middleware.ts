// 全站登录闸(Edge):只看 cookie 是否存在(不查库,Edge 跑不了 Prisma);真正校验在各 route handler。
// 未登录访问受保护页 → 跳 /login;访问受保护 API → 401。已登录访问 /login /register → 跳 /projects。
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { SESSION_COOKIE } from '@/lib/authConst';

const PUBLIC_PAGES = ['/login', '/register'];

export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  // 认证 API 永远放行(注册/登录本身)。
  if (pathname.startsWith('/api/auth')) return NextResponse.next();

  const hasSession = req.cookies.has(SESSION_COOKIE);
  const isPublicPage = PUBLIC_PAGES.includes(pathname);

  if (!hasSession) {
    if (pathname.startsWith('/api/')) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
    if (!isPublicPage) {
      const url = req.nextUrl.clone();
      url.pathname = '/login';
      url.search = pathname === '/' ? '' : `?next=${encodeURIComponent(pathname)}`;
      return NextResponse.redirect(url);
    }
    return NextResponse.next();
  }

  // 已登录:别停在登录/注册页。
  if (isPublicPage) {
    const url = req.nextUrl.clone();
    url.pathname = '/projects';
    url.search = '';
    return NextResponse.redirect(url);
  }
  return NextResponse.next();
}

export const config = {
  // 排除 Next 静态资源 + public 里带扩展名的文件(suno.png / suno-bridge.zip 等,
  // 未登录访客在登录页就要下载,不能被闸门拦);其余(含 / 与 /api/*,均无扩展名)都过闸。
  matcher: ['/((?!_next/static|_next/image|favicon.ico|.*\\..*).*)'],
};
