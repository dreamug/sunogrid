# SunoGrid Wiki Index

这个 wiki 记录 SunoGrid 项目里需要长期保留的工程事实、上线流程和分析结论。

## 核心

- [overview](overview.md): 项目 wiki 的当前总览。
- [schema](schema.md): 本 wiki 的目录约定和维护规则。
- [log](log.md): 来源摄取、分析和维护记录。

## Pages

### Sources

- [2026-06-24 线上部署记录](pages/sources/deployment-2026-06-24.md): 首次记录当前生产部署形态、部署失败原因和 supervisord 结论。

### Entities

- [production-server](pages/entities/production-server.md): 当前生产机、仓库路径、supervisord program 和数据库事实。

### Concepts

- [release-flow](pages/concepts/release-flow.md): `release.sh` 上线流程、重启策略和健康检查。

### Analyses

- [current-production-deployment](pages/analyses/current-production-deployment.md): 当前线上部署情况和以后上线 runbook。
