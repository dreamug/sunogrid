# Source: 2026-06-24 线上部署记录

## Summary

2026-06-24 的部署记录确认:生产机 `cable00` 上的仓库位于 `/data/deploy/sunogrid`,构建和 Prisma 迁移均可成功执行,失败点只在 `release.sh` 当时未支持 supervisord。线上实际使用 supervisord 管理 `sunogrid-web` 和 `sunogrid-stem`,其中常规 web 上线只应重启 `sunogrid-web`。

## Key Points

- 仓库根目录:`/data/deploy/sunogrid`。
- 构建命令 `npm run build` 成功。
- 数据库迁移命令 `npm run db:deploy` 成功,目标库为 MySQL `sunogrid` at `127.0.0.1:3306`。
- 第一次失败原因不是构建或数据库,而是重启逻辑没有找到 systemd/pm2 target。
- 线上进程管理器是 supervisord。
- supervisord program:
  - `sunogrid-web`:web 服务,上线后需要重启。
  - `sunogrid-stem`:stem-service,常规 web 上线不重启。
- 已将线上本地目录 `deploy/ssl/`,`stem-service/.torch/`,`web/public/downloads/` 加入 `.gitignore`。

## Entities

- [production-server](../entities/production-server.md)

## Concepts

- [release-flow](../concepts/release-flow.md)

## Open Questions

- 线上对外域名和 HTTPS/nginx 配置是否需要进一步写入 wiki。
- `sunogrid-stem` 是否需要独立 release/runbook。
