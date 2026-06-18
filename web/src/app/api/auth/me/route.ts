// 当前用户(前端判断登录态)。
import { getCurrentUser } from '@/lib/auth';

export async function GET() {
  const user = await getCurrentUser();
  return Response.json({ user });
}
