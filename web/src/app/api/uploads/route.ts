// §27 web 上传:收 multipart wav/mp3 → putAudioAsset(sha256 去重落盘)→ 回 assetId。
// 「uploading」态 = 这趟字节传输;之后客户端解码 + 检测 BPM/调,再 api.sounds.create({assetId}) 入库。
import { putAudioAsset } from '@/lib/storage';
import { getCurrentUser, unauthorized } from '@/lib/auth';

const MAX_BYTES = 50 * 1024 * 1024; // 50MB(WAV 可大)
const OK_TYPES = new Set(['audio/wav', 'audio/x-wav', 'audio/wave', 'audio/vnd.wave', 'audio/mpeg', 'audio/mp3']);

export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user) return unauthorized();
  const form = await req.formData();
  const file = form.get('file');
  // 错误用纯文本(不是 JSON):客户端 J() 把非 2xx 的响应体当 Error.message 直接显示在卡片上,
  // 回 {error:..} 会让用户看到原始 JSON;回一句话即直接可读(见 conciseError 兜底)。
  if (!(file instanceof File)) return new Response('No file received', { status: 400 });
  const name = file.name || '';
  const okExt = /\.(wav|mp3)$/i.test(name);
  if (!OK_TYPES.has(file.type) && !okExt) return new Response('Please upload a WAV or MP3 file', { status: 415 });
  if (file.size > MAX_BYTES) return new Response('File too large (max 50MB)', { status: 413 });
  const buf = Buffer.from(await file.arrayBuffer());
  // content-type:优先浏览器给的,否则按扩展名兜底(CDN 回放时按此 header 吐出)。
  const contentType = OK_TYPES.has(file.type) ? file.type : /\.wav$/i.test(name) ? 'audio/wav' : 'audio/mpeg';
  const asset = await putAudioAsset(buf, { kind: 'source', contentType });
  return Response.json({ assetId: asset.id, contentType: asset.contentType, bytes: asset.bytes }, { status: 201 });
}
