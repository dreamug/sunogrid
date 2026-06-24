# 2026-06-24 部署记录原始摘录

本文件记录 2026-06-24 线上部署相关原始事实,来源为部署日志和操作者在聊天中提供的信息。后续不要直接编辑本文件;如部署形态变化,新增 raw 记录并更新 wiki 页面。

## 部署日志摘录

- 主机信息:GNU/Linux x86_64,hostname `cable00`。
- 部署流水线在服务器上执行 `git fetch --prune origin`,远端 `main` 从 `8e82a77` 更新到 `e4529c2`。
- 执行 `git merge --ff-only origin/main` 成功,部署到 `main@e4529c2`。
- `npm ci` 成功。
- `npm run build` 成功,包含 `prisma generate && next build`。
- `npm run db:deploy` 成功,Prisma 连接到 MySQL database `sunogrid` at `127.0.0.1:3306`,没有待应用迁移。
- 第一次部署失败点:`ERROR: No restart target found. Install systemd service 'sunogrid', create pm2 app 'sunogrid', or set RESTART_CMD.`

## 操作者补充

- 线上仓库根目录是 `/data/deploy/sunogrid`。
- 线上使用 supervisord 部署。
- `supervisorctl status` 显示:
  - `sunogrid-web` RUNNING
  - `sunogrid-stem` RUNNING
- 常规 web 上线应重启 `sunogrid-web`,不应顺带重启 `sunogrid-stem`。
- 线上存在本地目录:
  - `deploy/ssl/`
  - `stem-service/.torch/`
  - `web/public/downloads/`
