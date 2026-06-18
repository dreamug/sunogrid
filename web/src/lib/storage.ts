// 本地"模拟 CDN":音频文件存在 web/storage/ 下,内容寻址(文件名=sha256)→ 天然去重。
// Asset 行记元数据,文件按 path 落盘;GET /api/cdn/:id 流式吐出。
import { createHash } from 'crypto';
import { mkdir, readFile, writeFile } from 'fs/promises';
import path from 'path';
import { db } from './db';
import type { Asset } from '@prisma/client';

const ROOT = path.join(process.cwd(), 'storage');
const AUDIO_DIR = path.join(ROOT, 'audio');

export const sha256 = (buf: Buffer) => createHash('sha256').update(buf).digest('hex');
export const storageAbs = (rel: string) => path.join(ROOT, rel);
export const readStorage = (rel: string) => readFile(storageAbs(rel));

/** 落盘音频(内容寻址)+ 建/复用 Asset 行(按 sha256 去重)。 */
export async function putAudioAsset(
  buf: Buffer,
  opts: { kind?: 'source' | 'warped' | 'stem'; contentType?: string; sourceUrl?: string } = {},
): Promise<Asset> {
  const hash = sha256(buf);
  const existing = await db.asset.findUnique({ where: { sha256: hash } });
  if (existing) return existing;
  await mkdir(AUDIO_DIR, { recursive: true });
  const rel = path.posix.join('audio', hash + '.mp3');
  await writeFile(storageAbs(rel), buf);
  return db.asset.create({
    data: {
      kind: opts.kind ?? 'source',
      path: rel,
      contentType: opts.contentType ?? 'audio/mpeg',
      bytes: buf.byteLength,
      sha256: hash,
      sourceUrl: opts.sourceUrl,
    },
  });
}

/** base64 → Buffer(app 把下载的 mp3 以 base64 传给后端)。 */
export const base64ToBuffer = (b64: string) => Buffer.from(b64, 'base64');
