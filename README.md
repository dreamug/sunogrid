# SunoGrid

> 浏览器里的 **AI loop 机 / groovebox(风格无关)**:用 Suno 生成任意风格的 loop,自动对齐到工程 BPM,拖进网格,**小节级量化**启停,做 beat 与编曲。

**SunoGrid** 把"用 AI 生成素材"和"像 groovebox 一样演奏 / 编排"合进同一个浏览器 app。你描述想要的声音 → Suno 生成一段 loop → 自动测速、对齐整小节、离线变速到工程 BPM、钉好循环点 → 拖进网格,踩着小节边界量化启动。

**风格无关**:trap、house、ambient、funk、jazzhiphop…… 任何 Suno 能生成的都行,引擎里没有任何风格专属逻辑。(初始用例是 jazzhiphop,但产品本身风格无关。)

## 它怎么工作

核心是一条 **生成 → 预处理 → 就绪 → 量化播放** 的流水线,关键决策是 **绝不在播放时实时变速**:

```
描述词 ──▶ Suno 生成 loop ──▶ conditioning(找循环区 · snap 到整小节)
                                       │
                                       ▼
                             离线 warp(变速到工程 BPM + 变调,WASM)
                                       │
                                       ▼
                       ready ──拖入网格──▶ 量化启停(对齐小节边界)
```

- **离线 warp**:落格 / 改速时用 `signalsmith-stretch`(WASM)在 `OfflineAudioContext` 一次性渲染出"已是工程 BPM、目标调、能无缝循环"的 buffer。播放路径只跑普通循环 source——再慢也只是格子转圈,**绝不爆音**。
- **conditioning**:Suno 的 loop 不是整小节。流水线先自相关找真实循环周期、snap 到最近整数小节,裁出区域再去 warp。
- **小节级量化**:启停都对齐到下一个小节边界。正是这一点去掉了实时延迟的硬约束,让浏览器从"勉强够用"变成理想平台。

组织模型已从单纯的 pad 机演进为 **Project › Session › Instrument › Clip**(详见 `PRODUCT.md` §14):工程下有多个 session(段落 / 操场),每个乐器挂若干 clip,**clip 是 sample 域唯一的处理单元**(warp / trim / slice)。

## 仓库结构

| 目录 | 作用 |
|---|---|
| **`web/`** | **主产品**。Next.js + TS 全栈 studio app(入口 `/projects`)。React 客户端 SPA 核心 + Tone.js 主时钟 + Web Audio / AudioWorklet + WASM warp;后端 Route Handlers + Prisma / MySQL 持久化;服务端代下载 Suno mp3(绕 CORS)。 |
| **`suno-bridge/`** | **Suno 桥接 Chrome 插件**。Suno 无公开 API,插件在页面活会话里桥接其私有接口(generate → feed 轮询 → 取 cdn mp3),token 不出浏览器;`externally_connectable` 让 app 页面直连。 |
| **`stem-service/`** | **自托管 Demucs 乐器分离 sidecar**(FastAPI,`:8008`)。把一条 loop 拆成多条 stem 子 sound,继承父 warp 锁相。 |
| **`hhgen/`** | **v0 遗留(已搁置)**。Python(Demucs + librosa)把整曲拆分轨、切小节做本地 loop 库——就是旧描述里的方案。现仅可能在"导入外部样本估 BPM"时复用,详见 `hhgen/README.md`。 |
| **`PRODUCT.md`** | **唯一事实源**:完整产品形态、架构决策、持久化 / undo 宪法、开发顺序与进度。改任何功能前先读。 |

## 技术栈

- **前端**:Next.js(App Router)· React(核心 `'use client'` SPA)· Tone.js · Web Audio / AudioWorklet · WASM(signalsmith-stretch)· Web MIDI
- **后端**:Next.js Route Handlers(Node / TS)· Prisma 6 · MySQL · 磁盘存音频(模拟 CDN)
- **生成**:Suno(经 Chrome 插件桥接)
- **乐器分离**:Demucs(Python FastAPI sidecar)

## 进度

- ✅ 音频引擎(量化启停 + 无缝循环)· warp + conditioning + clip 编辑器
- ✅ pad bank loop 机 · **Suno 驱动全链路**(app 打词 → 真 Suno loop 自动 conditioning + warp 进格就绪,已 E2E 实测,任意风格)
- ✅ 自由网格 arrange · 拼贴器(逐片 warp 重排)· 乐器分离 · undo / redo · 规范化持久化 + 乐观同步 + 多租户 scoping
- ☐ Web MIDI(接 MPC 硬件)等后续模块

## 本地运行(简)

需要本机 **MySQL** + **ffmpeg**。

```bash
# 1) web 主 app
cd web
npm install
cp .env.example .env          # 填 DATABASE_URL(本机 MySQL)
npx prisma db push            # 建库 / 建表
npm run dev                   # 打开 http://localhost:3001/projects

# 2) Suno 桥接插件(生成 loop 必需)
#    chrome://extensions → 开启开发者模式 → 加载 suno-bridge/,并登录 Suno

# 3) 乐器分离 sidecar(可选)
cd stem-service && ./run.sh   # :8008
```

> 联调细节(token 现取、改完要重载插件 + 刷两个标签等)见 `suno-bridge/README.md`。

## 说明

逆向 Suno 私有接口用于生成可能违反其 ToS,这是本项目已知并接受的风险。本仓库仅供学习与研究。
