// §25:把某个用户提为 SUPER_ADMIN(能标记/取消示例母版)。
// 用法:node scripts/promote-admin.mjs <username>   (加 --demote 降回 USER)
import { PrismaClient } from '@prisma/client';

const db = new PrismaClient();
const username = process.argv[2];
const role = process.argv.includes('--demote') ? 'USER' : 'SUPER_ADMIN';

if (!username) {
  console.error('用法: node scripts/promote-admin.mjs <username> [--demote]');
  process.exit(1);
}

const user = await db.user.findUnique({ where: { username } });
if (!user) {
  console.error(`找不到用户: ${username}`);
  process.exit(1);
}
await db.user.update({ where: { id: user.id }, data: { role } });
console.log(`✓ ${username} → ${role}`);
await db.$disconnect();
