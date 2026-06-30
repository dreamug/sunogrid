# 部署 / 上线指南(DEPLOY)

> 面向**开源 + 公开自托管**形态:任何人可以拿这份代码部署到自己的服务器,用户**自带 Suno 账号 + 自己安装桥接插件**(见 §8)。本文档覆盖生产环境的服务清单、依赖、数据库、存储、反代、插件分发与上线检查。
>
> 唯一事实源是 [`PRODUCT.md`](PRODUCT.md);本文件只讲“怎么把它跑到生产”。

---

## 0. 生产要跑哪些东西(架构)

```
                 用户浏览器
   ┌─────────────────────────────────────┐
   │  你的站点 (https://你的域名)         │   ← Next.js (web/),Node 进程
   │  + Suno Bridge 插件(用户自己装)     │   ← 在用户登录的 suno.com 会话里生成
   └─────────────────────────────────────┘
                 │ HTTPS
                 ▼
   ┌─────────────────────────────────────┐
   │ 反向代理 (nginx/Caddy) + TLS        │
   └─────────────────────────────────────┘
                 │
                 ▼
   ┌─────────────────────────────────────┐
   │ web (next start, Node 20+)          │
   │   ├── MySQL 8            (必需)      │
   │   ├── web/storage/  持久卷 (必需)   │   ← 音频“模拟 CDN”,内容寻址
   │   ├── stem-service :8008 (可选)     │   ← Demucs 乐器分离,Python
   │   └── DashScope 外呼     (可选)     │   ← §35 AI 提示词助手,服务端转发
   └─────────────────────────────────────┘
```

**关键事实(决定部署形态)**:
- Web 服务端**不依赖任何系统二进制**(无 ffmpeg / child_process —— 解码与 warp 全在浏览器 WASM)。生产机只要 **Node + MySQL**。
- 音频文件写在本地磁盘 `web/storage/`(见 [`src/lib/storage.ts`](web/src/lib/storage.ts))。**因此不能上 Vercel/Netlify 这类 serverless**(没有可写持久盘)。要用**带持久卷的 VPS / 容器**。
- 生成走用户浏览器里的插件,不是服务端能力(见 §8)。

---

## 1. 依赖清单

| 组件 | 依赖 | 必需? |
|---|---|---|
| web | Node **20 LTS+**(无 `engines` 字段,Next 15 要 ≥18.18,建议 20)、npm | ✅ |
| 数据库 | **MySQL 8**(本机或托管) | ✅ |
| 存储 | 一块**持久、可写、有备份**的磁盘挂到 `web/storage/` | ✅ |
| 反代 | nginx / Caddy(TLS + 提高上传体积上限) | ✅(公网) |
| stem-service | Python 3.10+、`torch`/`torchaudio`/`demucs==4.0.1`、模型 checkpoint(htdemucs_6s;drumsep 另需 167MB) | ⬜ 可选 |

> stem-service 不上,只是“乐器分离 / 拆鼓”功能不可用,**主流程(生成→warp→编排→播放→持久化)完全不受影响**。建议首发先不上,稳定后再加。

---

## 2. 数据库

### 2.1 建库 + 连接串
建一个 MySQL 8 库(默认库名 `hiphop_gen`,可改),生产 `web/.env` 填:

```bash
DATABASE_URL="mysql://用户:密码@数据库主机:3306/hiphop_gen"
```

### 2.2 数据库迁移
**迁移基线已重做**:`prisma/migrations/20260622120000_baseline` 反映重做时的完整 schema(此前只有过期的 6/15 `init`,只有半套表,已替换)。基线之后又叠了几支增量迁移(§37 多轨 arranger):

- `20260626090000_song_multilane`
- `20260626103000_song_layout_version`
- `20260626110000_song_sub_anchor`

> `migrate deploy` 会按顺序自动跑全部迁移(基线 + 上面这些),无需手动逐条点名;这里列出只为让你知道线上 schema 已超出基线。今后加迁移就追加到 `prisma/migrations/`,部署时 `db:deploy` 自动带上。

建表二选一:

- **全新空库 · 走迁移(推荐)**:
  ```bash
  cd web && npm run db:deploy     # = prisma migrate deploy
  ```
- **全新空库 · 直接同步(更省事)**:
  ```bash
  cd web && npm run db:push       # = prisma db push,不记迁移历史
  ```

> 已经用 `db push` 建好、又想改用迁移的旧库(比如本地 dev 库):一次性
> `npx prisma migrate resolve --applied 20260622120000_baseline` 把基线标记为已应用,之后再 deploy。
> 继续用 `db push` 也行,但记住[加列后必须重启 next](PRODUCT.md),否则报 Unknown arg / 永久 500。

### 2.3 首个 super admin
注册一个账号后,把它提成站长(才有 ★Example 开关、能标记示例母版,见 PRODUCT.md §25):

```bash
cd web
node scripts/promote-admin.mjs <username>     # 降回:加 --demote
```

### 2.4 把示例母版从本地搬到线上(可选)
示例项目(★Example 母版,见 PRODUCT.md §25/§30)的导出/导入脚本**已实现**。流程是:本地把一个项目连同它引用到的音频字节打包成 bundle,拷到生产机,再导入成归属站长的只读母版。

```bash
# ① 本地(读本机 DB + web/storage,不改任何东西):
cd web && node scripts/export-example.mjs <本地projectId> ./out/example-bundle

# ② 把 ./out/example-bundle 整个目录拷到生产机的 web/ 下(scp/rsync 均可)。

# ③ 生产机(直连 prod DB、写 prod web/storage;先确保站长已 promote-admin):
cd web && node scripts/import-example.mjs ./example-bundle <站长username>
```

> 导入会把 bundle 里的音频按内容寻址写进生产 `web/storage/`(已存在则去重跳过),并把项目挂成 `isExample=true` 归属该站长。新用户进入示例即 fork 出可编辑副本(连 Sound 库一起克隆)。设计与字段口径见 PRODUCT.md §30。

---

## 3. 环境变量

| 变量 | 必需 | 说明 |
|---|---|---|
| `DATABASE_URL` | ✅ | MySQL 连接串 |
| `NODE_ENV=production` | ✅ | **不设的话登录 cookie 的 `secure` 不会开**(见 [`auth.ts`](web/src/lib/auth.ts));`next start` 也按生产跑 |
| `PORT` | ⬜ | `next start` 默认 **3000**(注意:`npm run dev` 才是 3007)。反代后随意 |
| `STEM_SERVICE_URL` | ⬜ | 乐器分离服务地址,默认 `http://127.0.0.1:8008`(见 [`stems.ts`](web/src/lib/stems.ts));不上 stem-service 可忽略 |
| `DASHSCOPE_API_KEY` | ⬜ | §35 AI 提示词助手(gen-ta 角落 ✨ → 自然语言 → Suno 提示词)。阿里云百炼 DashScope key,**只在服务端读、绝不下发前端**(见 [`api/ai/prompt/route.ts`](web/src/app/api/ai/prompt/route.ts))。**不设则 ✨ 浮层返回 503 提示"未配置",生成主流程不受影响** |
| `QWEN_MODEL` | ⬜ | AI 助手用的模型档,默认 `qwen-flash`(最便宜)。可换 `qwen-turbo` / `qwen-plus` |
| `DASHSCOPE_BASE_URL` | ⬜ | DashScope OpenAI 兼容接口地址,默认 `https://dashscope.aliyuncs.com/compatible-mode/v1`。**国际账号**换 `dashscope-intl` 那个域名 |

> **大模型(AI 助手)是纯可选的外呼依赖**:web 不内置任何模型,只在用户点 ✨ 时由服务端转发一次到 DashScope。不配 `DASHSCOPE_API_KEY` 整站照常跑,只是 ✨ 功能关闭。配了它会按用户 + IP 限流 30 次/分(进程内存计数,同 §10 的限流局限)。

`.env.example` 已含上面全部变量(`DATABASE_URL` 必填,其余按需放开注释),生产请按上表补齐。

---

## 4. 构建与运行(web)

```bash
cd web
npm ci                      # 干净安装(含 dev 依赖,next build 需要;Node 20+,见 package.json engines)
npm run build               # = prisma generate && next build(generate 已并进 build,不会漏)
NODE_ENV=production PORT=3000 npm start   # next start(默认 3000)
```

服务器上已经配置好 systemd/supervisord/pm2 后,之后上线可以直接在仓库根目录运行:

```bash
./release.sh
```

默认流程:拉取 `origin/main` 的快进更新 → `npm ci` → `npm run build` → `npm run db:deploy` → 重启 web 服务 → 请求 `/api/health`。常用覆盖:

```bash
BRANCH=main SERVICE_NAME=sunogrid ./release.sh
HEALTHCHECK_URL=https://你的域名/api/health ./release.sh
DEFAULT_WEB_PORT=3037 ./release.sh
RESTART_CMD='supervisorctl restart sunogrid-web' ./release.sh
RESTART_CMD='pm2 restart sunogrid' ./release.sh
```

建议用进程管理器常驻。**systemd 样例见 [`deploy/sunogrid.service.example`](deploy/sunogrid.service.example)**;或 pm2:

```bash
pm2 start "npm start" --name sunogrid --cwd /path/to/sunogrid/web \
  --env "NODE_ENV=production" --env "PORT=3000"
```

### 4.1 当前线上部署情况

当前生产机记录(2026-06-24):

- 主机:`cable00`
- 仓库根目录:`/data/deploy/sunogrid`
- web 工作目录:`/data/deploy/sunogrid/web`
- 分支:`main`,远端:`origin/main`
- 进程管理器:`supervisord`
- web program:`sunogrid-web`
- web 端口:`3037`
- stem program:`sunogrid-stem`(独立服务,常规 web 上线不重启它)
- 数据库:MySQL `sunogrid` at `127.0.0.1:3306`(由 `web/.env` 的 `DATABASE_URL` 决定)
- 线上本地目录:`deploy/ssl/`,`stem-service/.torch/`,`web/public/downloads/` 已加入 `.gitignore`

生产机上线命令:

```bash
cd /data/deploy/sunogrid
git pull --ff-only
./release.sh
```

`release.sh` 默认会尝试重启 `sunogrid`,并在 supervisord 场景自动尝试 `sunogrid-web`。健康检查优先使用 `HEALTHCHECK_URL`,其次使用显式 `PORT`,再其次从 supervisord 进程环境或命令中读取实际 `PORT`;读不到时使用当前线上默认 web 端口 `3037`。如果需要显式指定:

```bash
cd /data/deploy/sunogrid
RESTART_CMD='supervisorctl restart sunogrid-web' ./release.sh
HEALTHCHECK_URL=https://你的域名/api/health ./release.sh
```

上线后检查:

```bash
supervisorctl status sunogrid-web sunogrid-stem
curl -f https://你的域名/api/health
# 或:
curl -f http://127.0.0.1:3037/api/health
```

---

## 5. 持久化存储(音频“CDN”)

- 音频(源 / warp 渲染 / stem)写在 `web/storage/`,文件名 = sha256(内容寻址、天然去重)。`/storage/` 在 `.gitignore`,**部署时它是空的**,运行中由 `/api/sounds`、`/api/warp-render`、`/api/uploads` 写入。
- **必须把 `web/storage/` 挂成持久卷**(容器尤其注意,否则重启即丢全部音频)。本地现状起步 ~1.4G,会随用量增长 —— **定期备份**这块盘 + 备份 MySQL。
- 服务路径:`GET /api/cdn/:id`(见 [`cdn/[id]/route.ts`](web/src/app/api/cdn/[id]/route.ts)),带 `immutable` 长缓存头,可放心让前置 CDN/反代缓存。
- **已知局限(够用版 CDN)**:整文件读进内存吐出、**无 HTTP Range**。loop 短,够用;若日后体量大或要长音频拖拽 seek,换对象存储(S3/R2)+ 真 CDN —— 那是 storage 层改造,不在本次范围。

---

## 6. 反向代理 / HTTPS / 上传体积

- 前置 nginx/Caddy 做 TLS,反代到 web 端口。**完整样例见 [`deploy/nginx.conf.example`](deploy/nginx.conf.example)**(把里面的 `your-domain.example` 换成你的域名)。
- **⚠️ 提高上传体积上限**:生成的 mp3 以 **base64** POST 到 `/api/sounds`(base64 比原文件大 ~33%),还有用户上传 wav/mp3(§27)。nginx 默认 `client_max_body_size 1m` 会**直接拦掉生成落库** —— 样例里已设 `50m`。
- **⚠️ 放宽项目导入(§38)的反代超时**:导入走 zip 分块上传,`final` 块要整体解包 + 覆盖落库(大项目可能阻塞数十秒)。nginx 默认 `proxy_read/send_timeout 60s` 会在收尾时打掉连接,浏览器表现为 `net::ERR_HTTP2_PING_FAILED` / `ERR_TIMED_OUT` 导入失败。样例已给 `/api/projects/*/import` 单独放宽到 `300s`。客户端已做超时 + 幂等重试兜底(块缩到 4MiB、按 off 幂等追加),反代不放宽时大项目仍可能反复触发重试。

---

## 7. Suno 桥接插件(生产关键)

生成发生在**用户自己浏览器里的插件**(在其登录的 suno.com 会话重放私有接口,token 不出浏览器)。要让你的线上站点能驱动它,必须做两件事:

### 7.1 让插件认你的生产域名
插件已内建 `localhost` + 本项目生产域名 `sunogrid.com`(零配置即用)。**自托管到别的域名**有两种办法:

**① 推荐 · 插件 popup 一键授权(免改任何文件)** —— 打开你的站点 → 点插件图标 → 在 “Bridge — app sites” 里点 **Connect** → 同意权限提示。插件用 `optional_host_permissions` + 运行时 `chrome.scripting.registerContentScripts` 把 bridge.js 注册到你的域名(持久,刷新不掉;可在同处 Disconnect)。

**② 或 · 手改 manifest 两处 `matches`**(见 [`suno-bridge/manifest.json`](suno-bridge/manifest.json) 的 `host_permissions` 与 bridge.js 那条 content_script)再重新加载:

```jsonc
// host_permissions 里加:
"https://你的域名/*"
// content_scripts 中 bridge.js 那条的 matches 加:
"https://你的域名/*"
```

> 桥接靠 content-script `postMessage`(`bridge.js` 注释:“无需 app 知道插件 ID”),所以**插件 ID 不稳定不影响**,唯一耦合点就是上面这两处 `matches`。
>
> 开源给别人自托管:首选上面 ① 的 popup **Connect**(零文件改动、用户自助授权);需要预置/批量分发时再用 ② 手改 `matches`。

### 7.2 分发给公众用户
插件没上架商店、是未打包扩展。公开分发的现实选项:

- **(推荐, 开源味)GitHub Release**:把 `suno-bridge/` 打成 zip 挂 Release,文档教用户 `chrome://extensions → 开发者模式 → 加载已解压的扩展程序`。诚实、零审核,但用户需手动开发者模式。
- **Chrome 应用商店 / Edge Add-ons**:用户一键装、体验最好,但**审核可能因“自动化 / 逆向 suno.com”被拒或下架**(ToS 风险),且要开发者账号($5)。要上架就接受可能被下的风险。

### 7.3 用户首次使用步骤(写进你的用户文档)
1. 安装本桥接插件(见上)。
2. 打开一个**已登录的 suno.com 标签页**(驱动需要活会话)。
3. **首次**在 Suno 手动生成一次 → 插件捕获请求模板(之后持久化,不必重复)。
4. 回到你的站点 → Studio 左栏点生成。

### 7.4 合规提示
逆向 Suno 私有接口**可能违反其 ToS**(README 已声明本项目接受此风险)。公开运营前自行评估法律与封号风险;每个用户用**自己的** Suno 账号生成 —— 成本/限流/封号风险落在各用户身上,这正是“自带账号 + 插件”模型对开源最合适的地方。

---

## 8. stem-service(可选,乐器分离)

独立 Python 服务,默认 `127.0.0.1:8008`,web 通过 `STEM_SERVICE_URL` 调用。

```bash
cd stem-service
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
# 放好 Demucs 模型 checkpoint(htdemucs_6s;拆鼓另需 drumsep 167MB,见 stem-service/README.md)
./run.sh        # uvicorn :8008(可用 STEM_PORT 改端口)
```

重型(torch + 模型常驻内存,有 GPU 更好)。建议**首发不上**,需要分离功能时再加。不上时分离相关按钮失效,主流程不受影响。

---

## 9. 上线冒烟检查清单

- [ ] 访问站点能注册 / 登录(确认 `NODE_ENV=production` 已设,cookie 带 `Secure`)。
- [ ] 装好插件 + 登录 suno.com → Studio 里生成一段 → 出现在库里、能播。
- [ ] 刷新页面音频不 404(`web/storage/` 是持久卷)。
- [ ] 大一点的 loop 也能落库(反代 `client_max_body_size` 够大)。
- [ ] 站长账号已 `promote-admin`,能看到 ★Example 开关。
- [ ] (若导入了示例母版)新用户进入示例 → 自动 fork 出可编辑副本、音频不 404、collage 不重 bake。
- [ ] MySQL + `web/storage/` 都进了备份计划。

---

## 10. 已知薄弱点(知道就行,小规模可接受)

- **认证**:bcrypt + DB 会话 + httpOnly/secure cookie。**登录/注册已加限流**(`src/lib/rateLimit.ts`,登录 10 次/10 分、注册 10 次/小时,按 IP)—— ⚠️ 限流计数在**进程内存**:单实例够用,**重启清零、多实例不共享**,横向扩展时换 Redis/DB。仍**无 CSRF token**(靠 `sameSite=lax` 兜)、无找回密码 —— 小规模可接受。
- **CDN**:见 §5,无 Range、整文件进内存,体量大要换对象存储。
