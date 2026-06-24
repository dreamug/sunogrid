# release-flow

## Summary

SunoGrid 的上线流程以服务器仓库根目录中的 `release.sh` 为入口。脚本负责对齐远端 `origin/main`,安装依赖、构建 Next.js、执行 Prisma 迁移、重启 web 进程并检查 `/api/health`。

## Evidence

- `release.sh` 默认参数:
  - `REMOTE=origin`
  - `BRANCH=main`
  - `SERVICE_NAME=sunogrid`
  - `PORT` 默认为空,需要使用线上实际 web 端口或从 supervisord 进程环境/命令中读取。
  - `RUN_DB_MIGRATIONS=1`
  - `RUN_HEALTHCHECK=1`
- 更新逻辑:
  - `git fetch --prune origin`
  - `git merge --ff-only origin/main`
  - 确认本地 `HEAD` 等于远端 head。
- 构建逻辑:
  - `npm ci`
  - `npm run build`
  - `npm run db:deploy`
- 重启逻辑:
  - 优先使用显式 `RESTART_CMD`。
  - 然后尝试 systemd。
  - 然后尝试 pm2。
  - 然后尝试 supervisord 的 `SERVICE_NAME`,并在 `SERVICE_NAME` 不以 `-web` 结尾时自动尝试 `${SERVICE_NAME}-web`。
- 当前线上 supervisord web program 是 `sunogrid-web`。
- 健康检查不猜测端口:优先使用 `HEALTHCHECK_URL`,其次使用显式 `PORT`,再其次读取 supervisord 进程实际 `PORT`;读不到即失败。

## Standard Command

```bash
cd /data/deploy/sunogrid
git pull --ff-only
./release.sh
```

如需显式指定 supervisord 重启:

```bash
cd /data/deploy/sunogrid
RESTART_CMD='supervisorctl restart sunogrid-web' ./release.sh
```

如需显式指定健康检查:

```bash
cd /data/deploy/sunogrid
HEALTHCHECK_URL=https://你的域名/api/health ./release.sh
# 或:
PORT=<实际web端口> ./release.sh
```

## Related Pages

- [production-server](../entities/production-server.md)
- [2026-06-24 线上部署记录](../sources/deployment-2026-06-24.md)
- [current-production-deployment](../analyses/current-production-deployment.md)

## Tensions Or Contradictions

- 早期 `DEPLOY.md` 只提 systemd/pm2;当前已补充 supervisord。
- `SERVICE_NAME=sunogrid` 是通用默认值,而当前生产 web program 是 `sunogrid-web`;脚本用 fallback 兼容该差异。
