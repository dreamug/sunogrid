# current-production-deployment

## Question

当前线上到底怎么部署,以后应该怎么上线?

## Conclusion

生产机为 `cable00`,仓库根目录是 `/data/deploy/sunogrid`,web 服务由 supervisord 的 `sunogrid-web` 管理,当前 web 端口为 `3037`。以后常规上线在仓库根目录执行 `./release.sh`;脚本会对齐 `origin/main`,构建、迁移、重启 `sunogrid-web`,再检查 `/api/health`。`sunogrid-stem` 是独立服务,常规 web 上线不重启。

## Evidence

- 操作者确认线上目录为 `/data/deploy/sunogrid`。
- 操作者确认线上使用 supervisord,并给出 `sunogrid-web` 与 `sunogrid-stem` 均 RUNNING。
- 2026-06-24 部署日志显示 `npm ci`,`npm run build`,`npm run db:deploy` 均成功。
- 同一次日志显示失败只发生在旧版 `release.sh` 的 restart target 检测阶段。
- `release.sh` 已更新为支持 supervisord,并自动从默认 `sunogrid` fallback 到 `sunogrid-web`。

## Runbook

```bash
cd /data/deploy/sunogrid
git pull --ff-only
./release.sh
```

如果自动检测失败:

```bash
cd /data/deploy/sunogrid
RESTART_CMD='supervisorctl restart sunogrid-web' ./release.sh
```

上线后检查:

```bash
supervisorctl status sunogrid-web sunogrid-stem
curl -f https://你的域名/api/health
# 或:
curl -f http://127.0.0.1:3037/api/health
```

## Implications

- 发布脚本不能只假设 systemd 或 pm2;当前生产环境必须保留 supervisord 支持。
- 文档中所有“上线”命令应从仓库根目录 `/data/deploy/sunogrid` 执行,不是 `web/` 目录。
- `sunogrid-stem` 的生命周期独立,除非修改 stem-service 或模型配置,否则 web 发布不应重启它。

## Related Pages

- [production-server](../entities/production-server.md)
- [release-flow](../concepts/release-flow.md)
- [2026-06-24 线上部署记录](../sources/deployment-2026-06-24.md)
