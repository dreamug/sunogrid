# SunoGrid — 产品形态与架构设计

> 活文档。记录当前确定的产品形态与架构决策,后续按此分步实现。

## 1. 一句话

浏览器里的 **AI loop 机 / groovebox(任意风格)**:用 Suno 生成任意风格的 loop 素材,拖进 16-pad 网格,**小节级量化**启停,做 beat 和编曲。
> 初始用例是 jazzhiphop,但**产品本身风格无关**——任何 Suno 能生成的风格都能用(trap、house、ambient、funk…)。架构里没有任何 jazzhiphop 专属逻辑。

## 2. 背景与演变

记录下来,避免后人(或后续会话)丢失上下文:

- **v0 设想**:把手头 1000 首版权 jazzhiphop 本地拆分轨 + 切 loop(`hhgen/`,Demucs + librosa)。**已搁置**,可能仅在"导入外部样本估 BPM"时复用。
- **转向 Suno**:改为用 Suno 生成 loop。Suno 无公开 API → 写 Chrome 插件(`suno-bridge/`)桥接其私有接口。
- **形态收敛**:从"实时打击垫(finger drumming)"改为"**loop 机(clip launcher)**"。因为**小节级量化触发**去掉了唯一的硬实时延迟约束,浏览器从"勉强够用"变成"理想方案"。
- **ToS 提示**:逆向 Suno 私有接口可能违反其 ToS,这是已知并接受的风险。

## 3. 核心交互模型

- 范式 = **MPC 式 pad loop 机**。**模型已演进为 Session/Instrument/Clip,见 §14**(此前写"不用 session/scene"指的是不做 Ableton 的 clip 矩阵;§14 的"session"= 扁平操场/歌曲段落,概念不同)。
- **pad bank**:4×4 = 16 个 pad,**可翻 bank(A/B/C/D…)**,与 MPC 控制器的 pad banks 一一对应。每个 pad 一个 loop 槽。
- **无预设乐器轨**:音色由用户给每个 pad **打标签 / 命名**(如 keys/rhodes/drums),不按列分。
- **拖入 loop** → 预加载(读/测 BPM → 整小节对齐 → 离线变速到主 BPM + 变调 → 钉循环点)→ `ready` → 才可被启动。
- **pad(MIDI)** 只负责量化启动/停止,无力度、无实时精度要求;翻页对应 MPC bank 切换。
- 启动/停止都对齐到**下一个小节边界**(全局量化)。
- **主时钟**:全局 BPM + 跑动的小节/拍位置,驱动一切。

## 4. 模块

1. **素材生成(Suno 桥接)**:描述 + Type=Loop + BPM + Key → 生成 → 下载 mp3 → 入库。
2. **pad bank + clip 引擎**:4×4 pad、翻 bank、拖入、预加载/变速/变调、量化启动循环播放;pad 打标签命名。
3. **pad 控制**:Web MIDI,映射格子,启动/停止。
4. **编曲 / arrange**(后期):记录场景启动、时间线编排。

### 4.1 生成窗口重做(2026-06-19 ✅ 已实现 ①②⑥)

收口原状:生成参数与主走带**解耦**(`StudioApp` 里 `gbpm` 写死 90、`gkey` 本地 state、刷新即丢),改成"跟工程走 + 记得住"。本期只做 ①②⑥(已落,`tsc` 通过 · db push 已建 `Project.masterKey/genPrefs` 列;改完需重启 next 让 Prisma client 生效)。

**① BPM 单向透传(口径:持久化独立值 + 主速变覆盖一次)**
- 生成 BPM(`gbpm`)是个**持久化的独立值**,可随时改,落 `genPrefs.bpm`。**无链接态、无链子按钮**(早期的 link 模型已废)。
- **主走带改速(`commitBpm` / undo 还原 BPM 等任何来源)→ 单向把 `gbpm` 覆盖成新主速一次**(effect 监听 `ctx.bpm`,`prevBpmRef` 跳过首帧 hydrate 以保住上次持久化值)。覆盖后用户仍可改。
- 输入框:无 label,宽 50px(对齐顶栏主走带 `.tg-bpm`),去原生上下 spinner(`appearance:textfield` + 隐藏 `::-webkit-*-spin-button`)。

**①.5 顶部一排**
- `[Sound | Song]` 模式段在左;`Loop`(toggle 按钮,开=橙 `--acc`,仅 Sound 模式显示)+ `BPM` 输入一组 `margin-left:auto` 靠右,与模式段同排。三者统一 26px 高、严格对齐。Loop 不再是 checkbox。
- **文案**:`Advanced` 显示为 **`Song`**(内部枚举值仍是 `advanced`)。

**② Key 八度键盘 + GO**
- 替代 `LoopManager` 里 24 项 `<select>`。深色八度迷你键盘(7 白 + 5 黑 = 12 根音)选**根音** + `大/小` segment 决定后缀 → 合成 `MusicalKey`(`C`…`B` / 加 `m`)。
- **布局 = 一张表 + 右侧 GO(整行高 50px)**:Key 表一个外框,内部全靠共享 1px 细线分隔(**无嵌套盒**)。左列两行 = `KEY 读数`(同排,不选显示 `Any`)/ `大｜小`(两单元格);右列 = 跨满高的键盘(定宽 154px、白键 22px,黑键按缝绝对定位)。键盘右侧是方块**生成按钮 `GO`**(50×50,`--acc`)—— 取代原来的整宽"生成 → 进库"。左列/键盘/GO **严格等高对齐**。字号统一 10px。**无独立 Any 按钮 —— 再点已选中的键即清回 Any**(= 字段省略,见 §8/§9)。
- ⚠ 选中键"变宽"的真因 = 选中类名 `sel` **撞了全局 `.sel`**(顶栏项目选择器,带 `padding:5px 8px`/`max-width:170px`)→ 选中键被撑宽到 25.6px(浏览器实测)。改用**独立类名 `ksel`** 修掉(并把点击聚焦的 UA 外圈描边内嵌化)。教训:键盘/网格这类细控件别用 `sel`/`on` 等大众类名。
- Suno key 共 24,纯键盘只表 12 根音,故必须配大/小调切换。

**⑥ 记忆(落 Project,不放 localStorage)**
- 契约早留挂点:`models.ts` 的 `Project.masterKey: MusicalKey|null`(注释"生成时默认跟它")、`bridge.ts` 的 `bpm/key:'project'` 枚举 —— 这次接上(注:Prisma schema 当前**没有** `masterKey` 列,§15.B 文档却已把它当列,本期 db push 补齐)。
- 落法(§15.A/B):`Project.masterKey` = **列**(Prisma 加 + db push);生成偏好 `genPrefs{mode,loop,bpm}` 形状还在演进、整体读写 → 先走 **`Project.genPrefs Json?` 逃生口**,稳定再毕业成列。
- key 选择即写 `masterKey`(乐观,§15.C 走发件箱 ops);打开工程时生成窗口读 `masterKey` 回填。BPM 链接态变更进 `genPrefs`。

**③ Suno 连接状态灯(已实现)** —— `SunoStatus.tsx`,放在 BPM 旁(顶部一排最右)。26px 方块内一颗圆 LED:**绿=就绪**(`status().hasAuth`,**只看登录**)、**红=有问题**(8s 超时无响应 / 未登录)、灰闪=检测中。点开 popover 给具体状态 + 修复提示 + 重新检测;挂载时探一次、点开再探。
  - ⚠ **`hasTemplate` 不作硬条件**:模板首次生成时自动捕获,缺模板照样能生成 —— 早期把它当绿灯条件 → 误报红(已修)。绿灯 detail 里软提示一下即可。
  - ⚠ **类名两次撞车教训**:状态灯内圆点最初用 `.led` → 撞顶栏走带位置显示的 `.led`(被压成 9px 灰圆);改用 **`.sled`**。键盘选中态最初用 `.sel` → 撞顶栏项目选择器 `.sel`。**细控件一律用带前缀的私有类名(`sled`/`ksel`/`gk-*`…),别用 `led`/`sel`/`on` 这类大众名。**

**不在本期(已评估,后续按需)**:④ 变体数 ×2/×4(`GenerateCommand.count` 现成) · ⑤ 风格快捷词 + 最近 prompt 召回。

### 4.2 素材库重做(2026-06-19 ✅ 已实现)

把原来扁平、操作多、分组弱的库改成**清晰三层 + 专业卡片**(`LoopManager.tsx` 库区 + globals.css):

- **分组结构(2026-06-19 定稿)**:一次生成 = **透明分组 `.gencard`**(`prompt` + `genParams()` 当标题,上方统领,**无外框**)→ 每个变体 = **独立卡 `.vcard`**(变体行 + 它自己的分轨**同框**)→ 卡间留缝。口径:**变体↔它的分轨**黏在一起(同卡),**变体#1↔#2**分得开(两卡 + gap),一眼是"两个素材"。
- **主次**:变体行 `.vrow` = **亮底 `--bg-3` + 大波形(`.vwave` 62×26)+ 24px 实心 ▶** = 主角;分轨 `.stemblk` = **暗底 `--bg-2`(同卡内)+ 18px 透明 ▶ + 行加高(padding 8px)+ muted 文字** = 配角。`.lib-list` gap 16px 分隔各次生成,`.gencard` 内 gap 8px。**教训**:分轨别用亮底/等大控件喧宾夺主——生成的变体才是主角;但分轨仍保留"框 + 标题条"的 block 感(只是压暗、收进变体卡内)。
- **生成中 / 失败**:也包成卡(`.gen-busy`/`.gb-fail` 带框,和变体卡同级);生成中一条阶段进度 `生成›渲染›到达` + bar + `n/2 变体已到`,两变体当整体。
- **删除(无按钮)**:**删掉所有 × 删除按钮**;选中库素材按 **Del/Backspace → `requestRemoveSound` 弹 `ConfirmDialog` → 软删**(`onDeleteSound`,可恢复;Esc 取消)。键删处理器已挡输入框/弹窗。失败态卡保留 `↻重试 / 删除`(失败 gen 无可选 sound)。`✂分离` 改 hover 出(变体行 `can-sep` 时 `.vmeta`↔`.va.vsep` 互换)。
- **元数据**:`LoopView` 加 `durationSec` + `musicalKey`(`ApiSound` 已有,两处 `soundToLoop` 映射);变体行显示 `秒数 · 小节`,调/BPM 在标题。
- **波形**:`StudioApp.libPeaks` —— gens 变化时按 `regionFromSound` 懒解码每条变体/分轨的 region 峰值,复用 `lanePeaksCache`(decodeAsset 也缓存),非阻塞填入;`MiniWave` 复用 `Wave` 的镜像路径,峰值未到画基线。
- **精简**:删 `→pad`(纯拖拽)。保留:点选进编辑器、▶试听、拖放、撤销口径。
- **分离反馈(separateSound)**:`✂` 不清楚 → 改文字 chip **「分离」**(hover 出)。分离路由是**同步**的(Demucs 跑完才返回),所以:点击**乐观立刻标 `stemStatus='separating'`** → 出 `.vc-sepbusy`(分离中 + 进度条);成功 `refreshGens` 出分轨;失败(502 抛错)→ 顶栏提示 + `refreshGens` 拉回 DB 的 `failed` + 兜底乐观标 `failed` → 卡上「分离失败 · 点重试」。`lib/stems` 在 DB 标 `separating/done/failed`(line 33/80/83),但同步路由下客户端只在返回后 refresh,故 loading 必须靠**客户端乐观态**。

### 4.3 顶栏(transport bar)重做(2026-06-19 ✅ 已实现)

原顶栏:`← · ▶ · Tempo · LED(1.1.1 无标) · Quantize"1 Bar"(写死假按钮) · ↶↷ · 自动保存 · Session›Instrument›Clip 静态标签`。问题:Quantize 不可点、位置无标注、无工程名、缺节拍器/主音量、右侧静态标签无用、控件高低不齐。

重做成 **4 个带分隔线(`.tb-sep`)的组**,全控件统一 **30px 高**:
- **工程**:`←` + **工程名**(`name` prop,`page.tsx` 传 `project.name`)。
- **走带**:`▶/■` + **节拍器**(`Metronome` 组件:toggle 开=橙 + `▾` 弹面板=音量推子 + **响一次** `每拍/每小节/2小节/4小节`) + **位置**`小节·拍 1.1.1`(加标注、16分变暗)。
- **音乐**:`Tempo` BPM(可编辑,沿用 `TempoInput`) + **Quantize 真选择器**(`<select>` `1bar/½/¼/off`,改即 `eng.setQuantize` + 乐观持久化 `Project.quantize`)。
- **主输出**(靠右):**主音量推子**(横向 console fader = 样式化 range → `Tone.getDestination().volume`) + **L/R 电平表**(两条横条;引擎挂 `Tone.Split`+两 `Tone.Meter` 并联抽各乐器 panner,不改主路径;render 每帧 `e.masterLevel()` 取值,靠 rAF 重渲) + `↩↪` undo/redo(钩形,30px) + 保存态。

**引擎(StudioEngine)新增**:`setQuantize`(`nextBar`→`nextBoundary`:1bar/½/¼/off 量化 launch·stop·audition) · `setMasterVolume`/`masterLevel` · 节拍器(`clickSynth`+`clickVol`,`scheduleRepeat('4n')` 内按 interval/重音决定响不响;下拍 C6 重音、其余 C5)。
- ⚠ **节拍器静音 bug(已修)**:`scheduleRepeat` 原本只在 `init` 注册一次,但 `stopTransport()` 的 `t.cancel()` 会清掉 Transport 上**全部**已排事件(含节拍器)→ 停一次后节拍器永久失效。改为 `scheduleMetro()` 在**每次 `startTransport` 重注册**(存 `metroRepeatId`,先 `t.clear` 再排)。**教训**:任何要长期存活的 transport 事件,别只在 init 注册——`stopTransport` 会 `cancel()` 全清。
- ⚠ **节拍器/电平/走带前进依赖 AudioContext 真激活** —— 自动化(合成点击)下 context 常 suspended(Tone 会 warn),故这些音频态没在无头验过(代码路径接好、无报错,真机点击验);UI/对齐/Quantize 改值/节拍器面板均已实测。
- ⚠ 类名沿用私有前缀(`tb-*`/`metro-*`/`mp-*`),避开历史 `.led/.sel/.on` 撞名坑。

## 5. clip 生命周期状态机

```
empty ──拖入──▶ loading(解码+测BPM) ──得到BPM──▶ warping(变速到主BPM)
                                                      │ 成功
                                                      ▼
                          ready(就绪/可启动) ◀──停止@小节── playing(循环播放)
                                 └──启动@小节──▶──────────┘
warping 失败 ──▶ error(不可启动)
改主 BPM ──▶ 回到 warping 重渲染
```

**硬保证**:网格里能被启动的 clip,一定已经是主 BPM、能无缝循环的。播放路径里永远不会出现需要实时拉伸的东西。

## 6. warp(时间拉伸)策略

- **决定:不在播放时实时 warp。** 落格时(或改主 BPM 时)**离线一次性变速**。
- **WASM stretcher**(已选 `signalsmith-stretch`,MIT)做两件独立的事:① 时间拉伸保音高、对齐主 BPM;② 变调(半音)。因它是 AudioWorklet,离线 warp 走 **OfflineAudioContext 离线渲染**(异步、不卡主线程),而非裸 Web Worker。
- **conditioning**:把整段 snap 到最近的整数小节(`bars = round(inDur·nativeBpm/60/拍数)`,处理 Suno 非整小节);**渲染多圈、取稳态那一圈**,规避节点 latency 并保证无缝。产出"已是主 BPM、目标调"的 `AudioBuffer`,用普通循环 source 播放。已实测:90BPM·2 小节(5.33s)→ 120BPM·2 小节(4.00s),峰值 0.934。
- **WASM 只在 worker,不进音频渲染线程** → 再慢也只是格子转圈,绝不爆音。
- **先做 loop conditioning(Suno loop 必需,见 §10)**:Suno 的 loop 不是整小节。流水线先确定真实循环区——v1 简单做法:以 `user_tempo` 为已知拍速、从 t=0(内容基本对齐下拍,lead≈0)取整数小节区(1/2/4 选能放下的最大值);更稳做法:对音频做自相关找真实循环周期,再四舍五入到整小节。裁出 region 后再 warp。
- 目标长度 = **整数小节的精确采样数** = `小节数 × (60/主BPM) × 4 × 48000`;钉死 `loopStart/loopEnd`。
- 改主 BPM = 重跑预加载流水线。**走带在跑时已实现无缝过渡**(`StudioEngine.retempoPlaying`,见 §12):保旧速播到下一小节边界 B → B 处 transport 翻速 + 各乐器同边界保相位换新 buffer(众声同时换、不错拍)→ B 时没渲完的乐器先 `playbackRate` 顶速(tape pitch)桥接、就绪后在循环边界换高质量 buffer 并复位 rate。

## 7. 架构 / 技术栈

- **平台**:浏览器 Web app(Chrome)。不需要 Tauri/原生——量化触发去掉了延迟硬约束;且 Tauri 的 WKWebView 对 Web MIDI 支持差。
- **前端**:Next.js(React),核心当客户端 SPA 写(音频/MIDI/worklet 全 `'use client'`,SSR/RSC 不参与实时核心)+ `Tone.js`(Transport / 量化启动 / 循环)+ Web MIDI + WASM warp worker。音频引擎与 UI 框架解耦(引擎纯 TS,`AudioContext` 用模块单例、不进 React state)。高频视觉(playhead/电平)走 canvas + rAF。
- **Suno 桥接**:Chrome 插件(`suno-bridge/`),用 `externally_connectable` 让 app 页面直接 `chrome.runtime.sendMessage`。
- **后端**:Next.js Route Handlers(`app/api`,Node/TS)——**一套 TS 全栈**;数据用 **MySQL**(`Drizzle` / `Prisma` ORM)存 loop 库 / 工程 / 场景集,音频文件存磁盘;服务端下载 Suno mp3(绕 CORS)。(纯本地单用户的话 SQLite 更省事、无需起服务;MySQL 也可行。)仅当后期"导入外部样本需重度音频分析(librosa 级)"成为核心,才加 Python sidecar。
- **存储**:OPFS / IndexedDB 缓存 warped + 原始 buffer(键含主 BPM);后端磁盘为权威。
- **音频流**:Suno 云 → 插件 → 后端库 → 前端加载 → 预加载变速 → 引擎播放。

## 8. Suno Sound 接口(详见 `suno-bridge/api-map.md`)

- `POST /api/generate/v2-web/`:`task=sound`,`tags`=描述,`metadata.sound_configs={user_loop, user_tempo, user_key}`,`mv=chirp-fenix`。
- `POST /api/feed/v3` 轮询 `status`:`submitted → streaming → complete`。
- 下载 `cdn1.suno.ai/<id>.mp3`。
- 鉴权:Clerk 短命 JWT + `browser-token` + `device-id`(插件在页面内用活会话,token 不出浏览器)。

## 9. 关键决策与理由

| 决策 | 理由 |
|---|---|
| 浏览器而非原生 | 量化触发 = 有 ~1 小节调度提前量,Web Audio 理想;WKWebView 的 Web MIDI 差 |
| 离线 warp 而非实时 | 播放路径极简、无爆音、循环无缝;代价是改速重渲染(可接受) |
| WASM 放 worker | 计算重但离线;用成熟 C++ 库(同一套算法 WASM/原生通用) |
| 优先 Suno 生成的素材 | BPM 精确已知 → 变速确定性,免 BPM 检测 |

## 10. 待验证 / 开放问题

- ✅ **已验证:Suno Sound loop 不是整小节,必须做 loop conditioning。** 实测 120 BPM(2 小节=4.0s)下两条同设置 loop 为 **3.92s(1.96 小节)** 和 **3.48s(1.74 小节)**,首尾几乎无静音(lead≈0、trail<8ms),即内容本身就不是整数小节、且每条长度不一。`user_tempo` 影响律动但不锁文件长度。→ 预加载流水线**必须**加一步"自动找循环点 / 裁到整小节"(见 §6)。
- 附带确认:Suno cdn mp3 采样率为 **48kHz**,音频引擎按 48000 处理。
- ✅ **conditioning + warp 编辑器已实现并验证**(`web/src/warp/conditioning.ts` + `WarpEditor.tsx`,demo `/demo/warp-editor`):onset 自相关估速度 → snap 到整小节 + 置信度;低置信标黄、手动拖 head/tail + 吸附瞬态 + 预览循环。
- 小优化点:去静音目前头尾都 trim,对有 decay 尾音的 loop 应"只 trim 头、留尾"(实测 exactBars 1.89 而非 2.0,尾音被削)。
- BPM/Key = Auto/Any 时字段省略(已确认);非默认值落 `sound_configs.user_tempo` / `user_key`(已确认)。

## 11. v1 范围 / 暂不做

- **v1**:Suno 生成 → 网格拖入 → 预加载(整小节对齐 + 时间拉伸 + 变调)→ 量化启动循环 + pad 启停 + 改主 BPM 跟随。
- **引擎从 Phase 0 即具备变调能力**;但"根据 `user_key` 自动算半音对齐项目调"的自动 conform 可后置,先给手动移调控制。
- **暂不做**:实时 warp 自动化(连续变速)、编曲时间线、相似 loop 检索(CLAP)、外部样本导入(可早加)。

## 12. 开发顺序(模块化:先定契约,风险优先,最后组装)

UI 实验已完成(暗色专业 · 16-pad bank · 生成/库侧栏,见 mockup v1–v4)。

**进度**:Stage 0 ✓ · M1 引擎 ✓ · M2 warp + conditioning + 编辑器 ✓ · **M3 pad bank loop 机 ✓**(`/demo/loop-machine`)· **M4 Suno 驱动核心 ✓**(`suno-bridge/interceptor.js`:活 token + 克隆模板重放 `generate`→`feed` 轮询→拿 cdn mp3,已在 live 会话实测通过)。
· **M3 手动 warp 编辑 ✓**(pad ✎ → warp 编辑器 → 拖 head/tail/小节/变调 → re-warp)。
· **M4 Suno 桥接 ✓ 全链路**(Phase A 驱动重放 + Phase B app↔插件 bridge:localhost content script + background 精准路由[storage.session 抗 SW 休眠 + 遍历 suno 标签] + 代下载 mp3 → `assignLoop`)。**已 E2E 实测**:app 打词点生成 → 真 Suno loop 自动 conditioning+warp 进 pad 就绪。任意风格。
剩:M5 后端 + 库(存工程/素材)· M6 MIDI(接 MPC)。

**Stage 0 — 骨架 + 契约**
- Next.js(App Router、TS)工程,核心 `'use client'`。
- 定死模块间 TS 接口:Loop/Clip 数据模型、引擎 API、warp worker 消息协议、桥接命令协议、库 API。← 模块独立开发并顺利组装的前提,必须先冻结。

每个模块独立可跑(带最小 harness),依赖只到"契约":

- **M1 音频引擎**(纯 TS):`Tone.Transport` 主时钟 + 量化启停 + 循环 buffer 播放 + pad 触发。
  - 交付:demo 页按钮触发预置 buffer,验证量化/循环/同步。依赖:无。
- **M2 warp worker**(WASM / SoundTouch):解码 → 整小节对齐 → 变速到主 BPM + 变调 → 精确长度 buffer + loop 点。
  - 交付:demo 页喂本地 mp3,产物可试听/下载。依赖:无。
  - ⚠️ **M1 + M2 合测 = 核心听感验证(对拍/无缝/保音高/变调),最高风险,最先打通。**
- **M3 pad bank UI**:4×4 pad + 翻 bank + 五态 + 检视条 + 生成/库侧栏(照 mockup 规格);先连 mock 引擎。依赖:契约。
- **M4 Suno 桥接驱动**:`suno-bridge` 升级,generate→feed→mp3,`externally_connectable` 直连。协议:app→`{prompt,loop,bpm,key}`;插件→`{clipId,audioUrl,nativeBpm,nativeKey,duration}`。依赖:api-map(✅)。
- **M5 后端 + 库**:Next Route Handlers + MySQL;下载 mp3 存盘、库/工程 CRUD。依赖:契约。
- **M6 MIDI 输入**:Web MIDI,MPC pad→launch/stop、bank 切换。依赖:M1 引擎接口。

**组装**
1. M3 × M1 × M2 → 拖入本地 loop 即响的核心闭环;
2. + M4 + M5 → 生成入库、拖到 pad、持久化(OPFS 缓存 + MySQL 工程);
3. + M6 → MPC 硬件触发。

原则:契约先行;核心引擎(M1+M2)先验证;靠接口契约,避免组装期才暴露根本问题。

## 13. M7 拼贴器(单轨磁带)

把**库里已 warp 好的 clip**,在**单轨**时间线上重排,整条离线 **bake** 成一条整小节、可无缝循环的 buffer,当**普通 clip 落到一个 pad**。它是这台 loop 机把若干 warped clip 拼成一段律动的方式。

**核心决策(已定)**
| 决策 | 理由 |
|---|---|
| **拼贴里不做 trim / 变速 / 对齐** —— 都在 warp 工具里完成 | 职责单一;拼贴只管"排列 + 每音变调" |
| 拖进拼贴 = **复制一份该 clip 的 warp**(源 asset 不变、共享);**拖进来长度锁死** | 一个 CollageItem ≈ 一个 **PadClip**(warp 副本 + 共享 asset),只是摆在时间线(startStep)而非 pad 格子 |
| **拼贴里唯一可改 = 每个音单独 pitch**(+gain) | 用户明确;同一 clip 多次摆放各自独立变调 = 旋律化 |
| **单声部、不重叠、不叠层**;轨可很长(横向滚动/缩放) | 用户拍板;最简、最像"重排磁带" |
| **bake 成 buffer**(不做 live mini-sequencer) | 贴合 §6/§9"离线一次、播放极简、绝不爆音";**引擎(M1)零改动** —— bake 产物 = WarpDone/EngineClip 口径 |
| 位置用音乐时间(step);长度 = `warp.bars × stepsPerBar` | 改主 BPM 只 re-bake 重排距,碎片不变速只挪位 |
| collage = `Sound{kind:'collage'}` + pattern JSON + bakedAsset | pad→Sound 关系不变,pad 不知道自己是 collage;✎ 才进编辑器 re-bake |

**形状同构 WarpEditor / PadClip**:交互式编辑(沙箱预览)→ 离线 bake → 整小节 buffer + loop 点 → `loadClip` 落 pad。硬保证(§6/§9:能启动的 clip 一定已是主 BPM、能无缝循环)天然成立。

**红利**:单声部 + 不重叠 → 同一时刻最多一个碎片在响 → 编辑器**预览可用单 voice 调度(免 re-bake,白送)**,落 pad 才 bake。(scaffold 暂用"bake 后 loop 播"做预览,正式版换单 voice 调度。)

**bake 算法**(同 `signalsmithWarp` 的 OfflineAudioContext):`len = bars·beatsPerBar·(60/bpm)·SR`;每个 item 取源 `[warp.start,warp.end)` → 叠加 `semitones`(正式版调 `warpClip` 把源区拉到 `warp.bars@masterBpm` + 保音高变调)→ 摆到 `startStep·stepSec` → 在格尾 `stop()` **硬门限**(保证不重叠)。产出 `loopStart=0 / loopEnd=len`。

**数据模型**(`web/src/contracts/collage.ts`,已冻结):`ClipWarp`(trim 区 start/endSample + bars,= warp 工具产物子集,拼贴里只读)· `CollageItem`(`soundId` + `warp` 副本 + `startStep` + **`semitones`(唯一可改)** + `gainDb`,有序不重叠;长度派生自 `warp.bars`、不存字段)· `CollageDoc`(bars/stepsPerBar/beatsPerBar/masterBpm/items,无 material —— 素材池 = 库,在文档外;= 可撤销文档,同 history.ts 的 ProjectDoc)· `BakeResult/BakeCollage`。

**素材来源**(都是已 warp 的 clip):① 库里的 Sound(各带默认 warp)② stem 子 Sound ③ 任意 pad 上的 PadClip。

**交互**:从库拖 clip 到轨(snap 到 grid、复制其 warp)、拖中段移动(block 语义、不跨邻居);**不能改长度**(由 warp 锁死,要改回 warp 工具);选中只改 pitch/gain;撤销走快照式;横向滚动 + 缩放应对"长"。

**分期**:**P0** 库素材列 + 单轨(拖/移/snap)+ live 预览 · **P1** bake → 落 pad、量化同步(核心闭环)· **P2** 每音 pitch/gain + 总长取整小节 · **P3** 接真实库 Sound + 改 BPM re-bake。

**进度**:✅ 契约 `contracts/collage.ts` + 纯操作 `collage/collageDoc.ts` + bake `collage/collageAudio.ts` + demo `/demo/collage`(mock 合成素材,**P0 交互 + P1 bake 真实音频路径已跑通并浏览器实测**:拖 4 个不同 bars 的 clip → 按 `bars×stepsPerBar` 锁死宽度首尾平铺不重叠 → 每音独立变调 → bake 出 4 小节/512000 样本/峰值非零的可循环 buffer)。剩:接真实库 Sound(替换 mock)+ 单 voice 预览 + 落 pad 持久化(Sound 需加 `kind`/`pattern` 字段 + `db push` 后重启 next)。

**待定(留给你拍)**:移动语义 = block(现)还是 ripple/磁吸(删/移自动合拢空位)?

## 14. 核心组织模型:Project › Session › Instrument › Clip

把生成/库当**输入池**,把"pad 区"重定义为**操场(Session)**,上面躺着**乐器(Instrument)**。这是 loop 机的核心数据结构(取代旧的 bank/PadClip 描述)。

**层级**
```
Project（主 bar 时钟）
├─ Library/Gen        = 输入池（生成多、多数弃用；warp 定稿后才"出池"成乐器)
└─ Session[]          = 操场(4×25 = 100 slot 网格,每 session ≤100 乐器);长度 = 最长乐器
   └─ Instrument[]    = 通用外壳 + payload(独立拷贝;开关随主走带量化启停)
      ├─ sample 乐器   ：payload = 1 个 Clip
      └─ collage 乐器  ：payload = 一串 Clip(横排,bake 成一条)
```

**一个原子 + 两种排列方向**。`Clip` = 一份 warp/trim 的独立拷贝、挂共享 Asset。`PadClip` 与旧 `CollageItem` 收敛为同一个 `Clip`。
- **Session = 竖排并行**:乐器各自 free-loop、各有开关、同时响。
- **Collage = 横排串行**:一件乐器内部单轨不重叠、bake 成一条 buffer。
两者对引擎一样(都产 `EngineClip`),只在编辑器和排列维度不同 → collage 保留为独立类型、不强行合并。

**通用外壳 + payload**。每件乐器共有外壳:`slot · label · 开关 · mixer(gain/pan/两段EQ) · sends(未来)`;payload 随 `type` 变。落库 = 一张 `Instrument` 表,外壳是列、payload 是 `type + Json`。信号路径:`Clip → 乐器 mixer → [sends] → session/master 总线`。两级增益(Clip 片增益 + 乐器通道增益)。

**两层嵌套编辑(下钻栈)**。底部编辑区按选中谁显示谁的编辑器:
- 选 sample 乐器 → 它的 warp 编辑器(改自己的 Clip 副本)。
- 选 collage 乐器 → arrange 轨;再选一片 → **下钻**到那片的 warp 编辑器(带返回)。
- 进操场前的"预处理"也是同一个 warp 编辑器,只是 Clip 还在库里。
`Clip` 在哪一层都是叶子、都用同一个 warp 编辑器;深度封顶(Session › 乐器 › Clip,collage 不嵌 collage)→ 栈最深 2 层。

**重渲传播链**:改 collage 里某片 warp → 重 warp 那片 → 重 bake 该 collage → 更新该乐器 buffer。脏标记 + 边界统一渲,照 `WarpRender` 签名缓存 + collage 加一层 bake 缓存。sample 乐器只一层、改 warp 直接重渲。

**内存**:100 乐器/session,每条 warped/baked buffer 几 MB → 懒渲 + 只常驻"开着的 + 近期用的"、其余按需解码逐出(OPFS 已有)。别一进 session 全 bake。

**契约**(`contracts/instrument.ts`,已冻结):`Clip{soundId,assetId,startSample,endSample,bars,semitones,gainDb}` · `Mixer{gainDb,pan,eq}` · `Send`(占位) · `CollageClip extends Clip {id,startStep}` · `InstrumentPayload`(sample|collage 判别联合) · `Instrument`(外壳+payload) · `Session` · `instrumentBars/sessionBars`。`contracts/collage.ts` 的 `CollageDoc.items` 已收敛为 `CollageClip[]`。

**Prisma 迁移(已 additive apply —— `StudioSession/StudioInstrument` 与 PadClip 并存,不动现有表/数据;db push 已跑)**。下面是早期草案(实际落地见 `prisma/schema.prisma` 的 StudioSession/StudioInstrument + `/api/studio`):
```prisma
model Session {
  id        String  @id @default(cuid())
  projectId String
  project   Project @relation(fields: [projectId], references: [id], onDelete: Cascade)
  name      String
  index     Int
  instruments Instrument[]
  @@index([projectId])
}
// PadClip → Instrument(外壳列 + type/payload):
model Instrument {
  id        String  @id @default(cuid())
  sessionId String
  session   Session @relation(fields: [sessionId], references: [id], onDelete: Cascade)
  slot      Int                // 0..99(4×25)
  type      String             // sample | collage
  label     String?
  color     String?
  gainDb    Float   @default(0)
  pan       Float   @default(0)
  eq        Json?              // { lowDb, highDb }
  sends     Json?              // Send[]（未来)
  enabled   Boolean @default(false)
  payload   Json               // sample: Clip; collage: { bars, stepsPerBar, clips: CollageClip[] }
  bakedAssetId String?         // collage 的烘焙缓存
  @@unique([sessionId, slot])
}
```
迁移路径:旧 `PadClip(project,bank,padIndex,warp,gainDb)` → 每个 (project) 建一个 `Session`、`PadClip` 变 `Instrument{type:'sample', slot=bank*16+padIndex, payload=Clip(由 warp 展平)}`。Sound/Gen/Asset 不动。

**进度**:✅ 契约 `contracts/instrument.ts` + 操场 demo `/demo/playground`(纯前端 / mock 合成乐器 / 不碰 DB):`playground/playgroundEngine.ts`(Tone.Transport 主走带 + 每乐器 Player→EQ3→Panner→vol 链 + 开关量化 launch/stop)· `mockInstruments.ts`(合成 3 条 sample loop + bake 1 件 collage,搭 2 个 session)· `playgroundDoc.ts`(纯操作)。**已浏览器实测**:arm 乐器→play→量化点亮(走带 LED 走到 2.3.2)、session 切换(Verse/Break)、mixer 4 段、**collage 下钻改片 pitch→重 bake→引擎热替换**(重渲传播链跑通)、无 console 报错。

✅ **Studio demo `/demo/studio`**:把老 loop 机的 `.daw` 三段外壳 CSS(`.tbar/.daw-main/.br/.stage/.clipgrid/.clip/.daw-editor`,复用)套到新模型上 —— **生产 loop-machine 与 DB 一律不碰**。顶部走带 + 左库调色板(＋加乐器 = 独立拷贝进 session)+ 操场 `.clip` 卡(开关随走带量化、`st-playing` 点亮、× 移除)+ session tabs + 底部 mixer + collage 下钻。已实测:调色板加乐器(4→5)、play、clip 开关量化、Chops 下钻改 pitch 重 bake、无报错。

✅ **Studio 已全接真东西**(`/demo/studio` + `playground/realLibrary.ts` + `app/api/studio`):① **真实库** `/api/sounds` → 复用 loop 机解码 + signalsmith warp + warp-render 落盘缓存,造真 sample 乐器(实测:4 条 minimal jungle + 1 件库切片 collage)· ② sample 乐器底部嵌**真 WarpEditor**(改 region → re-warp → 引擎热替换)· ③ **undo/redo**(快照 + reconcile)· ④ **落库**:`StudioSession/StudioInstrument` 表(additive,db push 已应用,**不动 PadClip/老 loop 机**)+ `/api/studio` GET/PUT + Save 按钮。**全链路浏览器实测**:删乐器→Save→DB(Verse 4 / Break 2)→刷新→`已从库加载`还原,无 console 报错。

✅ **Studio UX 重做(贴近真 loop 机)**:左栏换成真正的 `LoopManager`(生成表单 + 真实素材库 + ▶试听 + ✂分离;**删掉调色板**);生成走 `playground/studioGens.ts`(复用 sunoBridge/api.gens/detectLoop,需插件)。**进 session 两条路**:① 点库素材→底部**预调**(真 WarpEditor 改 warp,PATCH 存回素材)→拖到空格=单 sample 乐器;② 空格 **hover→＋sample/＋切片**(空乐器,再拖素材进去填/加片);库卡 →pad 也行。session **clip 画波形**(复用 `Wave`/`.cwave`,播放=波形进度条)。`playgroundEngine` 加 audition 试听。已实测:库渲染、拖素材→slot=sample、hover＋切片、→pad、预调编辑器、波形,均通过无报错;**生成**因需本地 Suno 插件未在无头验。

✅ **可改主 BPM(2026-06-19)**:顶栏 Tempo 输入框可编辑(Enter/失焦提交,clamp 40–240,↑↓ 微调)。提交即:① `ctx.bpm` 置新值、`StudioEngine.setBpm` 让主走带 transport 立即跟随 · ② `api.projects.update(masterBpm)` **乐观持久化**(§15:Project 列,刷新读新值)· ③ **re-warp 到新速度并热替换**:**停时**逐乐器 `loadInstrumentToEngine(_, seamless)` 就地换 buffer;**走带在跑时**走 `StudioEngine.retempoPlaying` 的**协调无缝换速**(§6 的"可选"项,已实现)—— 保旧 buffer 旧速播到下一小节边界 B(其间无 drift)+ 后台离线渲全部,到 B 时 transport 翻新速 + **各乐器同一边界保相位换 buffer**(众声同时换→不错拍),B 时还没渲完的乐器先 `playbackRate` 顶速(tape pitch、即时跟拍)、其 HQ buffer 就绪后在循环边界补换并复位 rate。buffer 按 §6 的 `warpToBuffer/buildCollageBuffer` 以 bpm 为 cache key,别的 session 切过去时自然按新 bpm 渲染 · ④ **进 undo 口径**(见 §16:HistEntry 加 `bpm`;undo 走 reconcile 整树重灌,非无缝)。元数据(数字)即时、音频(重渲 buffer)最终一致,顶栏 status 给提示(§15.D)。

待定:① collage 现从库切片自动拼,真正"从库挑 clip 拼 collage"的编辑流后做 · ② 与生产 loop-machine 合流(共用一个 Project)。

**待定(留给你拍)**:① 移动语义 block vs ripple(同 §13);② EQ 是两段 shelf 够,还是要全参数;③ sends 总线放 session 级还是 project 级。

## 15. 数据持久化与同步(规范化落表 + 乐观更新)—— ⚠️ 做任何新功能都按此

> 这是**持久化宪法**。新增任何可编辑的东西(乐器参数、效果、自动化、排列…)之前,先回这一节判断:它落表/列还是 JSON?它的乐观更新和缓存怎么走?**不要再往 `payload Json` 这种大 blob 里堆东西。**

**三条定死的原则**
1. **分层**:`User › Project › Session › Instrument › Clip`。每个用户注册后有自己的工作台(`/projects`),在里面新建/管理自己的项目。
2. **没有 Save**:改即存。前端本地 store 是 UI 的事实来源,DB 是 **write-behind 副本**,UI 永不等网络(乐观更新)。
3. **规范化**:可编辑的东西落成表/列,不堆 JSON。改它 = UPDATE 对应的那一行/列。
- **部署形态**:托管多租户(**陌生人可注册**)。Suno 仍走**用户自己浏览器插件 + 自己的 Suno 登录,我们不碰** —— 所以生成天然 per-user / 客户端侧,不进我们后端。
- **素材库归属**:`Sound` = **用户级共享库**(加 `userId`),保留 `originProjectId` 做 filter(哪个项目生成的)。`Asset`(sha256 去重的字节)、`WarpRender`(签名缓存)继续**全局共享**。

### A. 落表/列 vs JSON 的判断标准(三选一)
- **落成列**:标量、能独立编辑、要 query/filter/sort、或有 FK 完整性 → autosave = UPDATE 一列。
- **落成表**:一组有独立身份、能增删改排序的集合元素(每个要 id)→ autosave = INSERT/UPDATE/DELETE 一行。
- **留 JSON**:派生/快照、整体读写从不查内部、同质基本类型数组、或形状还在演进。
- **逃生口**:每张表留一个 `extra Json?`,放还在试验、形状未定的参数;稳定了再"毕业"成正式列。

### B. 逐实体落法(已判定)
**StudioInstrument**:`slot/type/label/color/icon/enabled` = **列**;`mixer{gainDb,pan,eq}` = **拍平成 4 列** `gainDb,pan,eqLowDb,eqHighDb`(不留 JSON、不开表);`sends` = **暂 JSON 占位,总线落地再开 `InstrumentSend` 表**;collage 的 `bars/stepsPerBar` = **列**、`bakedAssetId` = **列+FK→Asset**;`clips` = **开 Clip 表**。→ **`payload Json` 与 `mixer Json` 都消失**。

**Clip(新表,单原子 —— 全列、无内嵌 JSON)**:`id(PK,客户端生成稳定 id) · instrumentId(FK) · soundId(FK,可空 SetNull) · assetId(FK) · startSample · endSample · bars · timeMul · semitones · gainDb · startStep(可空) · orderIndex`。**`startStep`=null 即 sample 的唯一片;有值即 collage 里的位置** —— 一张表表达 §14 的"sample 竖排 1 / collage 横排 N",比判别联合 JSON 更准。`soundId/assetId` 变真 FK。

**Sound(有个故意的不对称)**:标量/状态/FK 全 **列**(含 stem 三字段、trashed);`analysis{…,onsets[]}` = **JSON**(一次性快照、含同质数组);`warp`(默认 warp)= **JSON**(整体 PATCH 回来的默认种子);`tags` = **暂字符串**,要按 tag 筛库再升 `SoundTag` join 表。
> **关键洞察**:`startSample/endSample/bars/semitones` 这些**同样的数**,在 **Clip 上是列**、在 **Sound.warp 里是 JSON** —— 这个不对称是对的:Clip 是被引擎播放、被 FK 引用、要 query 的**活实体**;Sound.warp 只是个整体写入的**默认种子 blob**。**同样的数字,身份不同,落法就不同。**

**Gen**:标量全 **列**(status 要 filter);`sunoClipIds:string[]` = **JSON**(一小撮外部 id,整批取)。**Project**:masterBpm/masterKey/quantize/beatsPerBar 全 **列**(banks 早已规范化成 PadClip 表;⚠ `masterKey` 契约/本节已当列,但 Prisma schema 至今没落,生成窗口重做时补 db push,见 §4.1);生成偏好 `genPrefs{mode,loop,bpm}` = **JSON 逃生口**(形状演进中,稳定再毕业)。**Asset/WarpRender/User**:全标量列,**无 JSON**。

### C. 乐观更新 + 发件箱 + 缓存
**写路径**:`mutation → 按 id 寻址的细粒度 op → 发件箱队列 → 合并 → flush(PATCH/POST/DELETE)`。
- **op 形如** `{patch,'clip',id,{semitones}}` / `{create,'instrument',…}` / `{delete,'instrument',id}`;客户端生成稳定 id,乐观 create + 后续 patch 打同一行,无临时 id 重映射。
- **合并(coalesce)**:同一 `table:id` 的多次 patch 在 flush 前塌成最新一次(拖旋钮 100 patch → 1)。
- **分级触发**:即时 flush = 开关/移动 slot/增删乐器/增删片/session 增删改名;防抖(松手才发,接 WarpEditor 与滑块已有的 `onPointerUp/onCommit`)= mixer 旋钮/warp region 拖动/变调。
- **失败重试**:留发件箱、退避重试;UI 早是乐观态,用户继续干。**Save 按钮 → 一个 `同步中/已同步` 的小状态点。**
- **undo/redo 走同一管线**:对前一快照做 op-diff 再塞发件箱,DB 自动跟上。

**前端缓存(分两种)**:
1. **元数据缓存**(Session/Instrument/Clip 树 + 库列表)= 本地 store,可镜像 localStorage/IndexedDB,刷新先秒画再 GET reconcile(stale-while-revalidate)。
2. **音频 buffer 缓存(重)**:解码源 buffer = 内存 Map + LRU,可落 OPFS 省重解码;warped/baked 结果已按 `WarpRender` 签名内容寻址落盘,客户端再加内存 LRU。

**⚠️ 本 app 的特殊难点 —— 元数据即时、音频最终一致**:编辑和"听到结果"之间夹了一层计算。拖变调 → 乐器卡 `semitones` **乐观即时**更新(列 patch 立刻发);但**声音**要等 re-warp 跑完才换 —— 引擎**热替换** buffer。**UX 规则:元数据=乐观即时;音频=最终一致**,中间给个极小的"重渲中"提示。任何"改参数→要重渲音频"的新功能都按此处理。

### D. User/Project 层与 scoping
- **数据模型 delta**:新增 `User{id,email(unique),passwordHash,name?,…}`;`Project/Sound/Gen + userId`(索引);`StudioSession/StudioInstrument/Clip/PadClip` 经 `projectId→userId` 间接归属;`Asset/WarpRender` 不挂 userId(全局)。
- **鉴权(托管下最易出洞)**:现在所有 API 裸奔、任意 `projectId` 可读写 = 越权漏洞。每条路由必须:取会话 user → 查询按 userId 过滤 → **project-scoped 路由先校验该 project 属于当前用户,否则 403**。加 middleware 保护 `/projects` 与 `/api/*`。
- **路由**:`/login`、`/register`、`/projects`(工作台:列表/新建/重命名/删除/打开)、`/projects/[id]`(Studio 从 `/demo/studio` 毕业,读 `Project.masterBpm`,**停止硬编码 90**)。
- **迁移**(db push + Prisma):加 `userId` 为**可空** → 建默认用户 → backfill 现有行 → 收紧为必填 → 重启 next。Studio 规范化表(Instrument 拍平 + 新 Clip 表)dev 数据可直接 wipe 重建。

### E. 实施顺序与 TBD
**顺序**:① 规范化 Studio 表 + User/Project scoping → ② 认证 + 鉴权 middleware → ③ 工作台 `/projects` + Studio 毕业读项目 BPM → ④ 细粒度 PATCH 端点 + 前端发件箱/乐观更新,去掉 Save。

**✅ 已实现(2026-06-18,全链路浏览器+DB 实测)**:
- **认证(自建,最轻量)**:`User{username,passwordHash}` + `AuthSession{token,expiresAt}`;bcryptjs 哈希 + httpOnly cookie(`lib/auth.ts` / `lib/authConst.ts`)。`/api/auth/{register,login,logout,me}`;注册=用户名+双密码、登录=用户名+密码、**无邮箱**。`middleware.ts` 全站闸:未登录页→`/login?next=`、API→401;已登录访问登录页→`/projects`。
- **多租户 scoping**:`Project/Sound/Gen` 加 `userId`;`projects/sounds/gens/studio/pads` 全部按 userId 过滤 + project-scoped 路由校验归属(否则 404/401)。`Asset/WarpRender` 仍全局。stem 子 Sound 继承父 userId。
- **工作台 `/projects`**(`ui/Workbench.tsx`):列出/新建/重命名/删除/打开项目 + 退出登录。Studio 毕业到 `/projects/[id]`(`studio/StudioApp.tsx`,读 `project.masterBpm`,不再硬编码 90);老 `/demo/studio` 重定向。
- **规范化持久化**:`/api/studio` GET 组装嵌套 contract 树、PUT 删旧+按**客户端稳定 id(uuid)**重建。DB 实测:`StudioInstrument` mixer 拍平成列、`Clip` 子表(sample=1 startStep=null / collage=N)、无 payload/mixer JSON blob。
- **自动保存 = 细粒度发件箱(§15.C,已落地)**:**没有整树 PUT**。`studio/sync.ts` 把当前树规范化成扁平快照,`diff(synced, target)` 出**最小 op 列表**(`sess/inst/clip` 的 `add/upd/del`,字段级),350ms 防抖后 POST `/api/studio/ops` 批量应用;成功后 `synced=target` 推进基准,失败退避重试。**不逐个 mutation site 埋点**——整树 diff 保证任何变更都不漏、连续拖动天然合并,撤销/重做也走同一条 diff。Save 按钮 → `同步中…/已同步/保存失败` 状态点。
  - **统一原子身份**:给 contract `Clip` 加了 `id?`(sample clip 也有稳定 id),GET 回填 → 字段级 diff 对 sample/collage 一致。
  - **后端 `/api/studio/ops`**:事务内按序应用(add: session→instrument→clip 满足 FK;del: 子在前且抑制级联——删乐器/会话时 clip 由 DB cascade 删);**逐 op scoping**:`updateMany/deleteMany` 用关系把 where 锁到 `projectId`,create 前校验父在本项目;`clip.soundId` 不属于本用户则置 null。
  - **实测(浏览器+DB)**:开关乐器 = **1 条** `inst.upd{enabled}`(只改该列,slot/别的乐器/clip 全不动);删乐器 = 1 条 `inst.del`(其 clip 走 cascade,不发冗余 op);`clip.upd{semitones}`、`inst.add+clip.add` 均生效;跨项目 op→404、引用外项目 session 的 `inst.add` 被跳过、未拥有的 `soundId` 落库为 null;刷新还原、load 不产生多余 op。
- **健壮性**:单个乐器/collage 源解码失败不再拖垮整个操场加载(跳过该乐器)。
- **code review 已修**:注册并发撞唯一约束 → 干净 409(不抛 500);写入路径(原 PUT、现 ops)把不属于当前用户的 `clip.soundId` 置空(跨租户引用防护);load 后不产生无谓写。

**TBD(非阻塞)**:① 注册是否邮箱验证;② sends 表等总线落地;③ 本地 `storage/` 模拟 CDN → 上线换对象存储(`Asset.path` 已抽象,不动数据模型);④ `/api/cdn` 目前任意登录用户可按 id 取任意 Asset 字节(内容寻址、不可枚举),如需严格隔离再按 Sound 归属校验;⑤ 音频"重渲中"提示(§15.C 的最终一致 UX):改主 BPM 已在顶栏 status 给"重渲乐器…→已切到 N BPM",其余改参数路径(变调/trim 等)的细粒度"重渲中"角标仍待补。

## 16. 撤销/重做(Undo/Redo)宪法 —— ⚠️ 加任何新交互前必读

**模型(`web/src/studio/StudioApp.tsx`)= 快照栈。快照口径 = `{ sessions 整树 , 各库声音的 warp , 主 bpm }`。** `past`/`future: HistEntry[]`,`HistEntry = { sessions: Session[]; warps: Map<soundId, warp>; bpm: number }`。**口径会随需要扩展,改前先看本节列的口径。**
- `snapshot()`:抓 `sessionsRef.current`(引用即可,树是不可变更新)+ 遍历 `ctx.soundsById` 抓每条声音的 `warp`(预调改的就是它,而它**不在 sessions 里**,故单列进口径)+ 抓 `ctx.bpm`(主 BPM,项目级标量,亦在 sessions 外)。
- `pushHistory()`:把 `snapshot()` 压入 `past`(上限 50),清空 `future`(标准 redo 失效)。**必须在 mutation 之前调**。
- `mutate(fn)` = `pushHistory()` + `updateSession(fn(...))`,最常用入口。
- `undo()`/`redo()` → `applyEntry(entry)`:`setSessions(entry.sessions)` + **只把 warp 与当前不同的库声音改回**(并反向 `api.sounds.patch`;其余声音不碰 → 不误删之后生成的)+ **bpm 不同则还原**(`ctx.bpm` 置回 + `engine.setBpm` + 反向 `api.projects.update(masterBpm)`;**在 `reconcile` 之前置好** `ctxRef.current.bpm`,reconcile 重灌时自然按还原后的 bpm re-warp)+ **校验选中**(乐器/片还在就保留,看见 snap back;没了才清)+ `reconcile()` 整树重灌引擎。快捷键 ⌘Z / ⌘⇧Z(输入框/textarea 聚焦时不拦)。

### 两条铁律(同时满足才进 undo)
1. **改动前 `pushHistory()`**(直接调,或走 `mutate()`)。漏了 → 改动生效但没有撤销步。
2. **改动的数据必须落在快照口径里**——当前口径 = ① `sessions` 整树,② 库声音 `Sound.warp`,③ 主 `bpm`。**口径外的状态 `applyEntry` 一概还原不了**,哪怕 pushHistory 了也白搭。要纳入新的状态域 → **显式扩口径**:`snapshot()` 多抓一份、`applyEntry()` 多还原一份(+ 反向持久化),并回本节登记。

**派生态不入栈**:引擎/音频 buffer、peaks 都从 sessions 重算(undo 走 `reconcile` 重灌)。永远别把权威状态只存在引擎里。

### 怎么把新功能接进 undo(配方)
- **改 sessions 树**(增删乐器/改名/开关/贴片/删片、clip warp/trim/gain…):走 `mutate()`,或 `pushHistory()` 后 `updateSession()`。范例 `writeSampleClip` / `writeCollageClip` / `removeInst` / `dropOnCollageLane`。
- **改库资产 warp**(预调 `editSoundRegion`):`pushHistory()` 放在改动**之前**(快照抓旧 warp);改 `soundsById` 用**不可变更新**(`new Map` + `{...s, warp}`,别原地 `s.warp=`,免得污染已压栈的快照引用)。undo 时的还原 + 反向 patch 由 `applyEntry` 统一负责。
- **拖拽手势**(连续改位/调参):**手势开始**压一次(`beginCollageEdit`),拖动中只 `updateSession` 不再压,松手 bake → 整段 = 1 步,不是 60 步。
- **编辑器防抖提交**(ClipEditor):每手势只 commit 一次(松手 → `commitTick` → 一次 `onChange`),在那一次 handler 里压一次即可,**别在拖动中压**。
- **连续滑杆**(mixer):值即时落树跟手,但**只在 commit 时**传 `history=true` 压栈,别每帧都压(`changeMixer` / `setCollagePieceMixer`)。

### 判断标准(什么该进、什么不该)
**Litmus:用户期望 ⌘Z 能撤回这一步 ＆ 我改的东西在快照口径(sessions 树 / Sound.warp)里 —— 两个都 yes 才进。**
- **该进**:乐器增删/移位/改名/激活;clip warp/trim/起播/长度/变调/timeMul/gain;collage 片增删移、片 mixer、loop 区;**库预调 warp(含拖起始线)**(已纳入口径②);**改主 BPM**(已纳入口径③ —— 它确实改了产出、像改 warp 而非播放瞬态,故可撤)。
- **不该进**:走带/播放(play/stop、预览试听)= 瞬态;选中/聚焦/缩放/滚动 = 视图态(撤它反而突兀);生成新 Sound = 异步库生命周期。
- **灰区 = 口径外但用户期望能撤**:Sound 的非 warp 字段(label、分离出的 stem 等)、跨 project/session 的东西。要纳入 → 按铁律②**显式扩口径**(snapshot+applyEntry 各加一份 + 持久化),**别默默埋一半;拿不准先找人拍板**。

### 沿革
- 起初口径只有 `sessions` 整树,且 undo 清空选中 → 库预调 warp(拖起始线)撤不了、clip 级撤销看不到回弹。已扩口径纳入 `Sound.warp` + 改成校验选中(保留 snap back)。
- 2026-06-19:主 BPM 改成可编辑(§12),按本节铁律②**显式扩口径**纳入 `bpm`(snapshot 抓 / applyEntry 还原 + 反向 `api.projects.update`)。
