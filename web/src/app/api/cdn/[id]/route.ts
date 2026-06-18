// 模拟 CDN:GET /api/cdn/:id → 按 Asset.id 流式吐出本地音频文件。
import { db } from '@/lib/db';
import { readStorage } from '@/lib/storage';

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const asset = await db.asset.findUnique({ where: { id } });
  if (!asset) return new Response('not found', { status: 404 });
  try {
    const buf = await readStorage(asset.path);
    return new Response(new Uint8Array(buf), {
      headers: {
        'content-type': asset.contentType,
        'content-length': String(buf.byteLength),
        'cache-control': 'public, max-age=31536000, immutable',
      },
    });
  } catch {
    return new Response('file missing', { status: 410 });
  }
}
