// 登录/注册的进程内限流(固定窗口,按 key 聚合,key 一般取客户端 IP)。
// ⚠️ 进程内存:单实例够用;**重启清零、多实例不共享**。要多实例横向扩展时换 Redis/DB(见 DEPLOY.md §10)。
import 'server-only';

type Bucket = { count: number; resetAt: number };
const buckets = new Map<string, Bucket>();

export type RateResult = { ok: boolean; retryAfterSec: number };

/** 计一次并判断是否超限。超限返回 ok:false + 距窗口重置的秒数。 */
export function rateLimit(key: string, limit: number, windowMs: number): RateResult {
  const now = Date.now();
  // 顺手回收过期桶,避免 Map 无限增长。
  if (buckets.size > 5000) for (const [k, b] of buckets) if (b.resetAt <= now) buckets.delete(k);

  let b = buckets.get(key);
  if (!b || b.resetAt <= now) {
    b = { count: 0, resetAt: now + windowMs };
    buckets.set(key, b);
  }
  b.count++;
  if (b.count > limit) return { ok: false, retryAfterSec: Math.max(1, Math.ceil((b.resetAt - now) / 1000)) };
  return { ok: true, retryAfterSec: 0 };
}

/** 清空某 key(如登录成功后,别让之前的失败次数继续累计惩罚)。 */
export function rateLimitReset(key: string): void {
  buckets.delete(key);
}

/** 取客户端 IP:优先反代设的 X-Forwarded-For(见 deploy/nginx.conf.example)。 */
export function clientIp(req: Request): string {
  const xff = req.headers.get('x-forwarded-for');
  if (xff) return xff.split(',')[0].trim();
  return req.headers.get('x-real-ip') ?? 'unknown';
}
