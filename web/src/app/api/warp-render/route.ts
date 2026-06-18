// warp 渲染缓存:GET ?signature 查已渲染的(返回 assetId+cdn);POST 把渲染结果(b64)落盘存成 warped Asset + WarpRender。
// 签名 = sha(assetId|start|end|bars|semitones|masterBpm),客户端算好传上来。
import { db } from '@/lib/db';
import { base64ToBuffer, putAudioAsset } from '@/lib/storage';

export async function GET(req: Request) {
  const signature = new URL(req.url).searchParams.get('signature');
  if (!signature) return Response.json({ error: 'signature required' }, { status: 400 });
  const hit = await db.warpRender.findUnique({ where: { signature } });
  return Response.json(hit ? { assetId: hit.assetId, cdn: `/api/cdn/${hit.assetId}` } : null);
}

export async function POST(req: Request) {
  const b = await req.json();
  if (!b.signature || !b.audioB64) return Response.json({ error: 'signature + audioB64 required' }, { status: 400 });
  const existing = await db.warpRender.findUnique({ where: { signature: b.signature } });
  if (existing) return Response.json({ assetId: existing.assetId, cdn: `/api/cdn/${existing.assetId}` });
  const asset = await putAudioAsset(base64ToBuffer(b.audioB64), { kind: 'warped', contentType: b.contentType || 'audio/wav' });
  const wr = await db.warpRender.create({
    data: { signature: b.signature, assetId: asset.id, bars: b.bars ?? 0, masterBpm: b.masterBpm ?? 0 },
  });
  return Response.json({ assetId: wr.assetId, cdn: `/api/cdn/${wr.assetId}` }, { status: 201 });
}
