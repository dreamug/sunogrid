# Suno Bridge — Driver (v0.2)

MV3 Chrome 插件:在你已登录的 suno.com 活会话里**驱动** Suno 生成(重放私有接口),并把能力**桥接给本地 app**(localhost)。token 全程不出浏览器。

```
本地 app (localhost:3007)
  │ window.postMessage {source:'APP_SUNO', cmd, args}
  ▼  bridge.js (注入 localhost)
  │ chrome.runtime
  ▼  background.js (路由)
  │ tabs.sendMessage → suno.com 标签页
  ▼  relay.js (注入 suno.com, ISOLATED)
  │ window.postMessage
  ▼  interceptor.js (注入 suno.com, MAIN) —— 驱动:capture 鉴权+模板 / generate / poll / download
```

支持命令:`status` · `generate({prompt,loop,bpm,key})` · `poll(clipIds)` · `download(url)→base64`。
generate 用"克隆最近一次真实请求模板 + 改参 + 刷新 UUID"的方式重放,模板持久化在 `chrome.storage`(一次手动生成后跨会话复用)。

## 用法

1. `chrome://extensions` → 开开发者模式 → **加载/重新加载**本目录(改过代码要点「重新加载」)。
2. 开一个 **suno.com 标签页并登录**(驱动需要活会话)。
3. **首次**在 Suno 的 Sounds 手动生成一次 → 捕获请求模板(之后持久化,不必再做)。
4. 打开本地 app(`web` 的 `/projects/[id]` Studio)→ 在左栏点生成。

## 文件

| 文件 | 作用 |
|---|---|
| `interceptor.js` | suno.com MAIN:驱动(capture/generate/poll/download)|
| `relay.js` | suno.com ISOLATED:background ↔ 驱动桥接 + 模板持久化 |
| `bridge.js` | localhost ISOLATED:app ↔ background 桥接 |
| `background.js` | 路由 localhost 标签 ↔ suno.com 标签 |
| `manifest.json` | MV3 配置 |
| `api-map.md` | 逆向出的接口 map |
