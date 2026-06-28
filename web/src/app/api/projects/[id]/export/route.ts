// §38 项目导出:GET /api/projects/:id/export —— 把自己的项目打包成自包含 zip 下载(子图 + 音频字节)。
// 只能导自己的项目(owner 校验);别人的只读示例需先 fork 再导。设计见 PRODUCT.md §38。
import { db } from '@/lib/db';
import { getCurrentUser, unauthorized } from '@/lib/auth';
import { bundleToZip, collectBundle } from '@/lib/projectBundle';

type P = { params: Promise<{ id: string }> };

const slug = (s: string) => (s.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'project');

export async function GET(_req: Request, { params }: P) {
  const { id } = await params;
  const user = await getCurrentUser();
  if (!user) return unauthorized();

  const project = await db.project.findUnique({ where: { id }, select: { userId: true, name: true } });
  if (!project) return new Response('not found', { status: 404 });
  if (project.userId !== user.id) return new Response('forbidden', { status: 403 });

  const { bundle, audio } = await collectBundle(id);
  const zip = bundleToZip(bundle, audio);
  const filename = `${slug(project.name)}.sgproj.zip`;
  // Uint8Array → 干净的 ArrayBuffer 切片(避免 SharedArrayBuffer 联合类型),交给 Response。
  const body = zip.slice().buffer;
  return new Response(body, {
    headers: {
      'content-type': 'application/zip',
      'content-disposition': `attachment; filename="${filename}"`,
      'content-length': String(zip.byteLength),
    },
  });
}
