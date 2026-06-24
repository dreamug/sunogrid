# production-server

## Summary

SunoGrid 当前生产环境运行在 `cable00` 上,仓库根目录为 `/data/deploy/sunogrid`。web 由 supervisord 的 `sunogrid-web` program 管理,stem-service 由 `sunogrid-stem` 独立管理。

## Current Facts

- 主机名:`cable00`。
- 仓库根目录:`/data/deploy/sunogrid`。
- web 工作目录:`/data/deploy/sunogrid/web`。
- 部署分支:`main`,远端为 `origin/main`。
- 进程管理器:supervisord。
- web program:`sunogrid-web`。
- web 端口:`3037`。
- stem program:`sunogrid-stem`。
- 常规 web 上线只重启 `sunogrid-web`,不重启 `sunogrid-stem`。
- Prisma 部署日志显示数据库为 MySQL `sunogrid` at `127.0.0.1:3306`。
- 需要忽略的线上本地目录:
  - `deploy/ssl/`
  - `stem-service/.torch/`
  - `web/public/downloads/`

## Relationships

- Related concept: [release-flow](../concepts/release-flow.md)
- Related source: [2026-06-24 线上部署记录](../sources/deployment-2026-06-24.md)
- Related analysis: [current-production-deployment](../analyses/current-production-deployment.md)

## Open Questions

- 生产域名、TLS 证书来源、nginx 配置路径尚未记录。
- `sunogrid-stem` 的模型目录、启动命令、资源要求尚未单独归档。
