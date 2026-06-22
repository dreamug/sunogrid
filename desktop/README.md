# SunoGrid Desktop(Electron 宿主)

> **web 为主,这是 bonus 外壳。** 设计与分期见仓库根 [`PRODUCT.md`](../PRODUCT.md) §19。
>
> **§19 铁律**:桌面只往共享核心里「加分支」,绝不改 web 行为。删掉本 `desktop/` 目录,web 必须照跑不误。

## 形态(2026-06-22 云端化)

桌面 = **指向云端 web 后端的原生客户端 + 内嵌 Suno**。**不做任何本地存储**:不用 SQLite、不落本地盘、不跑本地 Next 服务。数据 / 存储 / 账号全在云端(同一套 web 后端)。桌面相对 web 的唯一实体差异是**在 app 里内嵌 suno.com 来驱动生成**(替代 Chrome 插件)。

- dev:窗口指向本地 `next dev`(`localhost:3007`,连 `web/.env` 的 MySQL);主进程按需拉起,已起则附着。
- prod:窗口直接 `loadURL` 云端部署 —— `SUNOGRID_URL`(默认 `https://sunogrid.com`)。

## 跑起来(dev)

```bash
cd desktop && npm install   # 首次:下载 Electron 二进制
npm run dev                 # 自动拉起/附着 ../web 的 next dev,再开窗口
```

## 现状

- ✅ **Phase 1**:Electron 外壳 + preload 注入最小 `window.sunogrid`(`contextIsolation` 开 / `nodeIntegration` 关 / `sandbox`)→ 共享核心 `isDesktop` 成立(探针实测 `{isDesktop:true,platform:"desktop"}`)。外链走系统浏览器。
- 🚧 **Phase 2(桌面核心)**:内嵌 suno.com `BrowserView`(独立持久 session,登录一次重启不丢)+ IPC。把 [`suno-bridge/interceptor.js`](../suno-bridge/interceptor.js) 收成 `suno-preload.js`,主进程用 `executeJavaScript` 驱动 `window.__sunoDrive`;web 侧 [`sunoBridge.ts`](../web/src/studio/sunoBridge.ts) 改薄 shim(有 `window.sunogrid` → IPC,否则原 postMessage)。桌面退役插件;web 仍用插件。
- 🚧 **Phase 3**:登录态生命周期(静默续期 / 感知登出)、可选「读本地文件 → 传云端」上传。

## prod 打包(骨架)

```bash
npm run dist:mac   # 只装外壳;运行时连云端,无需打包服务/DB(见 electron-builder.yml)
```
