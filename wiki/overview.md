# SunoGrid Wiki Overview

SunoGrid 项目 wiki 用来沉淀仓库内外的长期工程事实,尤其是部署、上线、运行状态和后续排障需要反复引用的信息。

## Current State

- 当前生产机为 `cable00`,仓库根目录为 `/data/deploy/sunogrid`。
- 当前生产 web 服务由 supervisord program `sunogrid-web` 管理。
- `sunogrid-stem` 是独立 stem-service program,常规 web 上线不重启。
- 上线入口为仓库根目录的 `./release.sh`,脚本负责对齐 `origin/main`,安装依赖、构建、迁移、重启 web 并检查 `/api/health`。
- 2026-06-24 的部署失败点已明确:旧版脚本只支持 systemd/pm2,没有识别 supervisord;脚本已修复。

## Priority Questions

- 生产域名、nginx/TLS 配置路径是否需要纳入 wiki。
- `sunogrid-stem` 是否需要单独 runbook,包括模型目录、启动命令和资源要求。
- 数据库备份和 `web/storage/` 备份策略是否已经落地。
