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
- 记录健康检查应使用线上实际 web 端口或显式 `HEALTHCHECK_URL`,不做端口猜测。
