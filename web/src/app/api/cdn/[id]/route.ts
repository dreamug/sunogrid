// 模拟 CDN:GET /api/cdn/:id → 按 Asset.id 流式吐出本地音频文件。
// ⚠ Asset 是内容寻址、跨用户去重共享的(同字节 = 同行),无法逐用户归属而不破坏去重模型;
// 故这里只要求"已登录"(挡匿名访问 + id 枚举),并用 private 缓存,避免中间代理跨用户公开缓存。
import { db } from '@/lib/db';
import { readStorage } from '@/lib/storage';
import { getCurrentUser, unauthorized } from '@/lib/auth';

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return unauthorized();
  const { id } = await params;
  const asset = await db.asset.findUnique({ where: { id } });
  if (!asset) return new Response('not found', { status: 404 });
  try {
    const buf = await readStorage(asset.path);
    return new Response(new Uint8Array(buf), {
      headers: {
        'content-type': asset.contentType,
        'content-length': String(buf.byteLength),
        'cache-control': 'private, max-age=31536000, immutable',
      },
    });
  } catch {
    return new Response('file missing', { status: 410 });
  }
}
