// 重置某个用户的密码(本地运维)。passwordHash 走和 lib/auth.ts 同一套 bcryptjs(cost 10)。
// 用法:node scripts/reset-password.mjs <username> <newPassword>
import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';

const db = new PrismaClient();
const username = process.argv[2];
const newPassword = process.argv[3];

if (!username || !newPassword) {
  console.error('用法: node scripts/reset-password.mjs <username> <newPassword>');
  process.exit(1);
}

const user = await db.user.findUnique({ where: { username } });
if (!user) {
  console.error(`找不到用户: ${username}`);
  process.exit(1);
}

const passwordHash = await bcrypt.hash(newPassword, 10);
await db.user.update({ where: { id: user.id }, data: { passwordHash } });
console.log(`✓ ${username} 的密码已重置`);
await db.$disconnect();
