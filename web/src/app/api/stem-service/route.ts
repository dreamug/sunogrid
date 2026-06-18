// GET /api/stem-service → 分离 sidecar 是否在跑(前端据此显示按钮可用/提示启动)。
import { stemServiceHealth } from '@/lib/stems';

export async function GET() {
  const health = await stemServiceHealth();
  return Response.json({ up: !!health, ...(health ?? {}) });
}
