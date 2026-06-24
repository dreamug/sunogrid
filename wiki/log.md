# SunoGrid Wiki Log

## [2026-06-24] bootstrap | 初始化 wiki

- 创建项目级 wiki 结构。
- 准备摄取第一个来源。

## [2026-06-24] ingest | 线上部署与上线流程

- 新增 raw 来源摘录:`raw/deployment-2026-06-24.md`。
- 新增来源摘要:`pages/sources/deployment-2026-06-24.md`。
- 新增实体页:`pages/entities/production-server.md`。
- 新增概念页:`pages/concepts/release-flow.md`。
- 新增分析页:`pages/analyses/current-production-deployment.md`。
- 更新 `overview.md`,`index.md`,`schema.md`,统一为中文项目 wiki 语气。

## [2026-06-24] maintenance | 健康检查端口规则修正

- 修正 `release-flow` 和 `current-production-deployment` 中把健康检查固定到 3000 的描述。
- 记录当前线上 web 端口为 `3037`;健康检查应使用当前部署端口或显式 `HEALTHCHECK_URL`,不做端口猜测。

## [2026-06-24] maintenance | 健康检查认证放行

- 根据 20:23 部署日志,`release.sh` 已从 supervisord 读到实际端口 `3037`,但 `/api/health` 返回 401。
- 结论:健康检查接口被登录中间件拦截,应在 middleware 中公开放行 `/api/health`。
