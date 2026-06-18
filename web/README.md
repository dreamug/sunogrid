# Loop Machine (web)

hiphop loop 机的前端 + 后端(Next.js 全栈)。产品形态见 [../PRODUCT.md](../PRODUCT.md)。

## Stage 0:骨架 + 契约

当前是 Stage 0,只有工程骨架和**模块间接口(契约)**。契约先冻结,M1–M6 各自照接口独立开发,最后组装。

```
web/
  src/
    app/                 Next.js App Router(核心当客户端 SPA)
      layout.tsx page.tsx globals.css
    contracts/           ← 模块间接口,先冻结的事实
      models.ts          Loop / Pad / Bank / Project 数据模型
      engine.ts          M1 音频引擎 API
      warp.ts            M2 warp worker 消息协议
      bridge.ts          M4 Suno 桥接命令协议
      library.ts         M5 库 / 工程后端 API
      index.ts           统一出口(从 '@/contracts' 引入)
```

## 运行

```bash
cd web
npm install
npm run dev        # http://localhost:3000
npm run typecheck  # tsc --noEmit
```

> 注:依赖尚未安装(`npm install` 由你执行)。骨架基于 Next 15 + React 19 + TypeScript;`tone` 已列入依赖,供 M1 使用。

## 模块开发顺序(见 PRODUCT.md §12)

- **M1 音频引擎**(`contracts/engine.ts`)→ `/demo/engine`
- **M2 warp worker**(`contracts/warp.ts`)→ `/demo/warp` ⚠️ 与 M1 合测 = 核心听感验证
- **M3 pad bank UI**(照 mockup 规格)
- **M4 Suno 桥接**(`suno-bridge/` 升级)
- **M5 后端 + 库**(`contracts/library.ts` + MySQL)
- **M6 MIDI 输入**(Web MIDI)

模块间只依赖 `contracts/`,可各自独立开发与测试。
