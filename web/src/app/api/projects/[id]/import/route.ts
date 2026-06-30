// §38 项目导入(覆盖):POST /api/projects/:id/import —— 用上传的 zip 整个替换掉自己的这个项目。
// ⚠ 分块上传:Next 对 route handler 的 raw body 在 10MiB 处硬截断,而 req.formData() 在大 multipart 上会触发
// undici 解析 bug;故客户端把 zip 切成 <10MiB 的块逐个 POST(query: uploadId/off/final),服务端按 off 幂等追加到
// storage/tmp 临时文件(响应丢失重发不重复),final 时整体解包覆盖。只能覆盖自己的项目(owner 校验)。破坏性:原项目子图全删。设计见 PRODUCT.md §38。
import { appendFile, mkdir, readFile, stat, unlink } from 'fs/promises';
import { db } from '@/lib/db';
import { getCurrentUser, unauthorized } from '@/lib/auth';
import { storageAbs } from '@/lib/storage';
import { overwriteProjectFromBundle, zipToBundle } from '@/lib/projectBundle';

type P = { params: Promise<{ id: string }> };

const MAX_BYTES = 500 * 1024 * 1024; // 500MB:整项目音频可大
// 临时文件按 user.id 命名空间隔离:uploadId 客户端自选,不隔离则两用户/两标签撞同名会互相污染追加流。
const tmpPath = (userId: string, uploadId: string) => storageAbs(`tmp/import-${userId}-${uploadId}.part`);

export async function POST(req: Request, { params }: P) {
  const { id } = await params;
  const user = await getCurrentUser();
  if (!user) return unauthorized();

  const project = await db.project.findUnique({ where: { id }, select: { userId: true } });
  if (!project) return new Response('not found', { status: 404 });
  if (project.userId !== user.id) return new Response('forbidden', { status: 403 });

  const q = new URL(req.url).searchParams;
  const uploadId = q.get('uploadId') || '';
  const final = q.get('final') === '1';
  const off = Number(q.get('off') ?? '0'); // 本块在拼接文件中的字节起点(幂等键)。旧客户端不带 off → 0,退化成纯追加。
  if (!/^[A-Za-z0-9-]{8,64}$/.test(uploadId)) return new Response('bad uploadId', { status: 400 });
  if (!Number.isInteger(off) || off < 0) return new Response('bad offset', { status: 400 });
  const part = tmpPath(user.id, uploadId);

  // 幂等追加(每块 <10MiB,走 raw body 不触发截断)。按 off 对齐:网络层丢响应后客户端重发同块不会重复写。
  const chunk = Buffer.from(await req.arrayBuffer());
  try {
    if (chunk.byteLength > 0) {
      const sofar = await stat(part).then((s) => s.size).catch(() => 0);
      if (sofar === off + chunk.byteLength) {
        // 这一块此前已写入(上次响应在网络层丢了,客户端重试)——跳过,不重复追加。
      } else if (sofar === off) {
        // 累计大小上限在每块追加时即校验,挡"只追加不 final"的撑盘攻击(不能只在 final 才查)。
        if (off + chunk.byteLength > MAX_BYTES) {
          await unlink(part).catch(() => {});
          return new Response('file too large (max 500MB)', { status: 413 });
        }
        await mkdir(storageAbs('tmp'), { recursive: true });
        await appendFile(part, chunk);
      } else {
        // 落差/错位(乱序到达,或临时文件已被清):让客户端重开一次导入(换 uploadId)。
        return new Response(`offset mismatch: have ${sofar}, got ${off}`, { status: 409 });
      }
    }
  } catch (e) {
    console.error('[projects/import] chunk write failed', e);
    return new Response('chunk write failed', { status: 500 });
  }

  if (!final) return Response.json({ ok: true });

  // 收尾:读全量临时文件 → 解包 → 覆盖。⚠清理时机:成功 / 坏 bundle / 超限(4xx,重试无益)才删临时文件;
  // 意外 500(客户端会重试)保留 .part,让重试从完整文件再次幂等收尾(overwriteProjectFromBundle 走事务 +
  // 内容寻址 Asset,重跑安全)。代价=中断的导入会留残片(已知泄漏,见 §38.5.1)。
  let cleanup = false;
  try {
    const buf = new Uint8Array(await readFile(part).catch(() => Buffer.alloc(0)));
    if (buf.byteLength === 0) { cleanup = true; return new Response('empty upload', { status: 400 }); }
    if (buf.byteLength > MAX_BYTES) { cleanup = true; return new Response('file too large (max 500MB)', { status: 413 }); }
    let bundle, audio;
    try { ({ bundle, audio } = zipToBundle(buf)); }
    catch (e) { cleanup = true; return new Response(`invalid bundle: ${(e as Error).message}`, { status: 400 }); }
    await overwriteProjectFromBundle(id, user.id, bundle, audio);
    cleanup = true;
    return Response.json({ id });
  } catch (e) {
    console.error('[projects/import] import failed', e);
    return new Response('import failed', { status: 500 }); // 保留 .part 供客户端重试收尾
  } finally {
    if (cleanup) await unlink(part).catch(() => {});
  }
}
