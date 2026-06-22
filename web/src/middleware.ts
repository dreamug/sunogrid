// 全站登录闸(Edge):只看 cookie 是否存在(不查库,Edge 跑不了 Prisma);真正校验在各 route handler。
// 未登录访问受保护页 → 跳 /login;访问受保护 API → 401。已登录访问 /login /register → 跳 /projects。
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { SESSION_COOKIE } from '@/lib/authConst';

const PUBLIC_PAGES = ['/login', '/register'];

function redirectUrl(req: NextRequest, pathname: string, search = '') {
  const forwardedHost = req.headers.get('x-forwarded-host');
  const host = forwardedHost || req.headers.get('host') || req.nextUrl.host;
  const forwardedProto = req.headers.get('x-forwarded-proto');
  const proto = forwardedProto || req.nextUrl.protocol.replace(/:$/, '') || 'https';
  const url = new URL(`${proto}://${host}`);
  url.pathname = pathname;
  url.search = search;
  return url;
}

export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  // 认证 API 永远放行(注册/登录本身)。
  if (pathname.startsWith('/api/auth')) return NextResponse.next();

  const hasSession = req.cookies.has(SESSION_COOKIE);
  const isPublicPage = PUBLIC_PAGES.includes(pathname);

  if (!hasSession) {
    if (pathname.startsWith('/api/')) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
    if (!isPublicPage) {
      const url = redirectUrl(req, '/login', pathname === '/' ? '' : `?next=${encodeURIComponent(pathname)}`);
      return NextResponse.redirect(url);
    }
    return NextResponse.next();
  }

  // 已登录:别停在登录/注册页。
  if (isPublicPage) {
    return NextResponse.redirect(redirectUrl(req, '/projects'));
  }
  return NextResponse.next();
}

export const config = {
  // 排除 Next 静态资源 + public 里带扩展名的文件(suno.png / suno-bridge.zip 等,
  // 未登录访客在登录页就要下载,不能被闸门拦);其余(含 / 与 /api/*,均无扩展名)都过闸。
  matcher: ['/((?!_next/static|_next/image|favicon.ico|.*\\..*).*)'],
};
