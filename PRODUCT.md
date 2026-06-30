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
- **主输出**(靠右):**主音量推子**(横向 console fader = 样式化 range → `master.volume`,master=主总线 `Tone.Volume`,在软削波天花板之前;见 §17 信号链) + **L/R 电平表**(两条横条;`Tone.Split`+两 `Tone.Meter` 抽在 `master`=真实总线,绿/琥珀/红上色;由 `<MasterMeter>` **自驱动叶子**每帧取 `e.masterLevel()`,不再让整个 StudioApp 每帧 rAF 重渲) + `↩↪` undo/redo(钩形,30px) + 保存态。

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
- **单段线性是默认;分段 warp(warp marker)见 §36**——把"走音/飘速"的 loop 掰正到网格,仍走同一条"离线渲一次→缓存→傻放"的管线,复杂度只落在 `warpClip` 一步。

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

**通用外壳 + payload**。每件乐器共有外壳:`slot · label · 开关 · mixer(pan/gain/三段EQ) · sends(未来)`;payload 随 `type` 变。落库 = 一张 `Instrument` 表,外壳是列、payload 是 `type + Json`。信号路径:`Clip → 乐器 mixer → [sends] → session/master 总线`。两级增益(Clip 片增益 + 乐器通道增益)。

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

**待定(留给你拍)**:① 移动语义 block vs ripple(同 §13);③ sends 总线放 session 级还是 project 级。
（②已定:EQ = 三段串联 biquad —— lowshelf@200 + peaking@1k(Q0.7) + highshelf@4k,每段 0dB 透明、不用 EQ3 分频求和;乐器/clip 共用;mixer 竖排 pan 在 gain 之上。频点/Q + dB 行程统一收进 `contracts/instrument.ts` 的 `EQ_BANDS` / `EQ_DB_RANGE`,实时链(studioEngine)与离线 bake(realLibrary)共用一组,别再各写魔法数。)
- **EQ 调音说明(2026-06-21)**:低段 lowshelf 转折点从 **120→200 Hz**、每段旋钮行程从 **±12→±18 dB**。原因:lowshelf 在转折点只到半量(要再下一个八度才切满),120 的 shelf 实际只切满 ~60Hz 以下,真正让人觉得糊/轰的低音 body(100~300 Hz)碰不到 → "切低"没感觉。抬到 200 Hz 让"切低"直接覆盖整段低音 body、行程放宽到能听出深度。注:shelf 切到底也只是压低不归零,若日后要"切干净"那种 DJ low-cut 手感,需另加可滚到静音的 high-pass(独立控件,留作后续)。

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
**StudioInstrument**:`slot/type/label/color/icon/enabled` = **列**;`mixer{gainDb,pan,eq}` = **拍平成 4 列** `gainDb,pan,eqLowDb,eqHighDb`(不留 JSON、不开表);`sends` = **JSON 列**(§17 落地:固定三效果 `{dist,delay,reverb}` 0..1,整体读写、形状固定小 → 留 JSON 不开表;原 `Send[]` 占位已定型);collage 的 `bars/stepsPerBar` = **列**、`bakedAssetId` = **列+FK→Asset**;`clips` = **开 Clip 表**。→ **`payload Json` 与 `mixer Json` 都消失**。

**Clip(新表,单原子 —— 全列、无内嵌 JSON)**:`id(PK,客户端生成稳定 id) · instrumentId(FK) · soundId(FK,可空 SetNull) · assetId(FK) · startSample · endSample · bars · timeMul · semitones · gainDb · startStep(可空) · orderIndex`。**`startStep`=null 即 sample 的唯一片;有值即 collage 里的位置** —— 一张表表达 §14 的"sample 竖排 1 / collage 横排 N",比判别联合 JSON 更准。`soundId/assetId` 变真 FK。

**Sound(有个故意的不对称)**:标量/状态/FK 全 **列**(含 stem 三字段、trashed);`analysis{…,onsets[]}` = **JSON**(一次性快照、含同质数组);`warp`(默认 warp)= **JSON**(整体 PATCH 回来的默认种子);`tags` = **暂字符串**,要按 tag 筛库再升 `SoundTag` join 表。
> **关键洞察**:`startSample/endSample/bars/semitones` 这些**同样的数**,在 **Clip 上是列**、在 **Sound.warp 里是 JSON** —— 这个不对称是对的:Clip 是被引擎播放、被 FK 引用、要 query 的**活实体**;Sound.warp 只是个整体写入的**默认种子 blob**。**同样的数字,身份不同,落法就不同。**

**Gen**:标量全 **列**(status 要 filter);`sunoClipIds:string[]` = **JSON**(一小撮外部 id,整批取)。**Project**:masterBpm/masterKey/quantize/beatsPerBar 全 **列**(banks 早已规范化成 PadClip 表;⚠ `masterKey` 契约/本节已当列,但 Prisma schema 至今没落,生成窗口重做时补 db push,见 §4.1);生成偏好 `genPrefs{mode,loop,bpm}` = **JSON 逃生口**(形状演进中,稳定再毕业);编辑器网格偏好 `gridPrefs{arrange,warp,snap}` = **JSON 逃生口**(per-project UI 偏好:`arrange`=chop 拼贴轨吸附格、`warp`/`snap`=clip warp 编辑器网格/吸附;选片/刷新不再重置,改即乐观写 `Project.gridPrefs`,跟 `genPrefs` 同套路,2026-06-20)。主总线效果器 `fx{distortion,delay,reverb}` = **JSON 逃生口**(固定小配置、整体读写、形状演进中 → 同 `gridPrefs` 套路;详见 §17,2026-06-20)。**Asset/WarpRender/User**:全标量列,**无 JSON**。

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

**模型(`web/src/studio/StudioApp.tsx`)= 快照栈。快照口径 = `{ ① sessions 整树 , ② 各库声音的 warp , ③ 主 bpm , ④ 主总线 fx , ⑤ 活动 sessionId , ⑥ 量化 quantize , ⑦ 库存活集(声音/生成组 id) }`。** `past`/`future: HistEntry[]`,`HistEntry = { sessions; warps: Map<soundId, warp>; bpm; fx; sessionId; quantize; liveSounds: Set; liveGens: Set }`。**口径会随需要扩展,改前先看本节列的口径。**
- `snapshot(sessionId?)`:抓 `sessionsRef.current`(引用即可,树是不可变更新)+ 遍历 `ctx.soundsById` 抓每条声音的 `warp`(预调改的就是它,而它**不在 sessions 里**)+ `ctx.bpm` + `fxRef` + `quantizeRef` + **活动 session id**(默认当前;undo/redo 显式传"改动归属 session")+ **存活的库声音/生成组 id 集**(= `soundsById.keys()` / `gens.map(id)`,用于软删可撤)。
- `pushHistory()`:把 `snapshot()` 压入 `past`(上限 50),清空 `future`(标准 redo 失效)。**必须在 mutation 之前调**。
- `mutate(fn)` = `pushHistory()` + `updateSession(fn(...))`,最常用入口。
- `undo()`/`redo()` → `applyEntry(entry)`:`setSessions` + **⑤ 跳回 `entry.sessionId` 对应的 session**(`setSessionIdx` + reconcile 那一格 —— 否则改动在别的 session 时 ⌘Z 看似毫无反应)+ **② 只把 warp 不同的库声音改回**(反向 `api.sounds.patch`;其余不碰 → 不误删之后生成的)+ **③ bpm 还原**(置回 + `engine.setBpm` + 反向 PATCH;`reconcile` 前置好 `ctxRef.bpm`)+ **④ fx 还原** + **⑥ quantize 还原**(`setQuantize` + 引擎 + 反向 PATCH)+ **⑦ 库存活集对齐**(见下"软删可撤")+ **校验选中**(还在就留,看见 snap back)+ `reconcile()` 重灌引擎。`undo`/`redo` 给对侧压栈的 snapshot **携带 `entry.sessionId`**,保证两个方向都跳回改动现场。快捷键 ⌘Z / ⌘⇧Z(输入框/textarea 聚焦时不拦)。

**库删除全软删 + 可撤(⑦,2026-06-20)**:声音 `DELETE` 早就软删(`Sound.trashed`);生成组 `DELETE` 改为**软删整组**(`Gen.trashed=true` + 连带软删变体/stem,不再 `db.gen.delete` 硬删);两处列表路由都按 `trashed:false` 过滤,`PATCH` 可置回 `trashed:false` 恢复。`onDeleteSound`/`onDeleteGen` 删前(或删成功后、重载库前)`pushHistory`。`applyEntry` 的库对齐用 **restore-only + 白名单**,绝不做对称差集:**恢复** = 快照里存活、现在没了 → un-trash;**重删** = 现在存活、快照里没有、**且该 id 曾真删过**(`trashableSounds`/`trashableGens` ref 白名单)→ re-trash。这样撤回到很早的快照时,之后生成的声音既不在快照也不在白名单 → **绝不误删**(延续"不误删之后生成的"原则)。库有增删时,等 `trashed` 落定 → `reloadLibrary()` → 再 `reconcile` 一次(恢复的声音回到 `soundsById` 后,引用它的乐器才能重建出声)。

### 两条铁律(同时满足才进 undo)
1. **改动前 `pushHistory()`**(直接调,或走 `mutate()`)。漏了 → 改动生效但没有撤销步。
2. **改动的数据必须落在快照口径里**——当前口径 = ① `sessions` 整树,② 库声音 `Sound.warp`,③ 主 `bpm`,④ 主总线 `fx`,⑤ 活动 `sessionId`,⑥ `quantize`,⑦ 库存活集(`Sound.trashed` / `Gen.trashed`,经存活 id 集 + 白名单)。**口径外的状态 `applyEntry` 一概还原不了**,哪怕 pushHistory 了也白搭。要纳入新的状态域 → **显式扩口径**:`snapshot()` 多抓一份、`applyEntry()` 多还原一份(+ 反向持久化),并回本节登记。

**派生态不入栈**:引擎/音频 buffer、peaks 都从 sessions 重算(undo 走 `reconcile` 重灌)。永远别把权威状态只存在引擎里。

### 怎么把新功能接进 undo(配方)
- **改 sessions 树**(增删乐器/改名/开关/贴片/删片、clip warp/trim/gain…):走 `mutate()`,或 `pushHistory()` 后 `updateSession()`。范例 `writeSampleClip` / `writeCollageClip` / `removeInst` / `dropOnCollageLane`。
- **改库资产 warp**(预调 `editSoundRegion`):`pushHistory()` 放在改动**之前**(快照抓旧 warp);改 `soundsById` 用**不可变更新**(`new Map` + `{...s, warp}`,别原地 `s.warp=`,免得污染已压栈的快照引用)。undo 时的还原 + 反向 patch 由 `applyEntry` 统一负责。
- **拖拽手势**(连续改位/调参):**手势开始**压一次(`beginCollageEdit`),拖动中只 `updateSession` 不再压,松手 bake → 整段 = 1 步,不是 60 步。
- **编辑器防抖提交**(ClipEditor):每手势只 commit 一次(松手 → `commitTick` → 一次 `onChange`),在那一次 handler 里压一次即可,**别在拖动中压**。
- **连续滑杆**(mixer):值即时落树跟手,但**只在 commit 时**传 `history=true` 压栈,别每帧都压(`changeMixer` / `setCollagePieceMixer`)。

### 判断标准(什么该进、什么不该)
**Litmus:用户期望 ⌘Z 能撤回这一步 ＆ 我改的东西在快照口径(sessions 树 / Sound.warp)里 —— 两个都 yes 才进。**
- **该进**:乐器增删/移位/改名/激活;clip warp/trim/起播/长度/变调/timeMul/gain;collage 片增删移、片 mixer、loop 区;**库预调 warp(含拖起始线)**(口径②);**改主 BPM**(口径③);**主总线 fx**(口径④);**量化 quantize**(口径⑥ —— 同 bpm 是项目级音乐设置,口径对称);**删库素材 / 删整组生成**(口径⑦ —— 全软删,可撤、可 redo 重删)。
- **不该进**:走带/播放(play/stop、预览试听)= 瞬态;选中/聚焦/缩放/滚动 = 视图态(撤它反而突兀);**生成**新 Sound = 异步库生命周期(且生成的声音必须挺过早期快照的 undo,见⑦白名单);主音量 master/节拍器/生成偏好 = 设置/演奏态。
- **灰区 = 口径外但用户期望能撤**:Sound 的非 warp 字段(label、tags 等)。要纳入 → 按铁律②**显式扩口径**(snapshot+applyEntry 各加一份 + 持久化),**别默默埋一半;拿不准先找人拍板**。

### 沿革
- 起初口径只有 `sessions` 整树,且 undo 清空选中 → 库预调 warp(拖起始线)撤不了、clip 级撤销看不到回弹。已扩口径纳入 `Sound.warp` + 改成校验选中(保留 snap back)。
- 2026-06-19:主 BPM 改成可编辑(§12),按本节铁律②**显式扩口径**纳入 `bpm`(snapshot 抓 / applyEntry 还原 + 反向 `api.projects.update`)。
- 2026-06-20:效果器(§17)。① 全局 return 设置 `Project.fx`(口径外标量集)按铁律②**显式扩口径**纳入 —— `HistEntry` 加 `fx`,snapshot 抓 `fxRef.current`,applyEntry 比 JSON 不同则 `setFx` 回引擎 + setFx 回 state(浮层跟随)+ 反向 `api.projects.update({fx})`;FxRack 旋钮拖动**开始**(及 chip/电源点击前)调一次 `pushHistory`(经 `onStart` prop),连续拖只压一帧。② per-乐器 send 在 `sessions` 树里(`Instrument.sends`)→ 本就在口径,`changeSends` 同 `changeMixer` 走 `pushHistory`+树更新,免费可撤。③ **顺带修了 undo/redo 机制隐患**:`pushHistory`/`undo`/`redo` 原把 `snapshot()`/`applyEntry()` 等副作用写在 `setState` updater **内部** → React StrictMode(dev,Next15 默认开)双调 updater 时副作用重复跑、把 past/future 栈搞乱(表现:redo 还原不出来,bpm/warps/fx 同病)。改为 `pastRef`/`futureRef` 读最新栈、副作用在 updater **外**只跑一次 → undo+redo 都正常(DB 实测 fx 切换 → 撤销 → 重做 往返正确)。
- 2026-06-20(undo 整体 review 补缺):①**跨 session 静默 bug** —— 改动在 A、切到 B 再 ⌘Z 时,旧实现用当前 `sessionIdx` reconcile,Verse 的还原看不到。扩口径⑤ `sessionId`:snapshot 抓活动 session id,applyEntry 跳回该 session,`undo`/`redo` 给对侧 snapshot 携带改动归属 id(否则切过 session 后 redo 跳错)。②**quantize 口径不对称** —— bpm 可撤、同级的 quantize 不可撤。扩口径⑥(照 bpm 模板:snapshot 抓 / applyEntry `setQuantize`+引擎+反向 PATCH;`commitQuantize` 改前 pushHistory)。③**库删除不可撤** —— 生成组 `DELETE` 原**硬删** gen 行(无法恢复)。改为全软删(`Gen.trashed` 新列 + db push)+ 扩口径⑦(restore-only + trashable 白名单,绝不误删之后生成的)。验证:tsc 0 错;gen 软删/恢复 API 往返实测(删 → 列表消失、行仍在且 trashed、PATCH 恢复 → 回列表);quantize 改 → ⌘Z → ⌘⇧Z 往返 UI 实测正确,无 console/server 报错。**未端到端 UI 实测**(库为空、无 Suno 插件):库删除→undo 的整链、跨 session undo(项目仅一个 session)—— 但其服务端原语已测、客户端接线 tsc 通过。
- 2026-06-22(undo 全功能复核 —— 接线完整性 + 空步整治):两路独立审计(接线 / 正确性)交叉确认 **7 项口径的所有持久化改动都已 `pushHistory`,无漏接**(会话/乐器 CRUD·移位·开关·标签·色·copy/paste/duplicate、乐器级 + collage 片级 mixer/sends、三条 clip 编辑路径 sample/预调 warp/collage 含 timeMul、collage 全部编排 加片/落素材/落乐器/移/Alt 复制/⌘D/删/loop 拉杆、XY automation 加删拖点 + repeat 缩放、bpm/quantize/fx/XY 配置/库删除);每个拖拽都在**拖起**只压一帧。核心机器(跨 session 跳转、fx 与 bpm 的 ctxRef 同步时序差异、库 restore-only、solo/XY/audition/Song 待推进的瞬态清理、不可变更新无快照串改)复核**无误**。**唯一缺陷=空 undo 步(phantom)**:共享 `Knob`/`Fader`/chip 在 **pointerdown / 无变化重置 / 重选同值** 时无条件 `onStart→pushHistory`,造成「⌘Z 像没反应」且把 50 上限的真历史挤掉。**两层修复**:① 源头——`Knob`/`XYPad`/`MixerStrip` 把 `onStart` 推迟到**首次真移动**(对齐 AutomationLane/pad gain 线既有写法)、双击复位加 `value!==def` 守门、FxRack 字符/sync chip 与 XYPad program/mode 加**等值守门**、`renameSession`/`setSessionColor` 同值早退;② 兜底——`undo`/`redo` 用 `histDataKey`(6 项数据口径稳定串、`` 分隔、**不含活动 sessionId**)**透明丢弃空步**(拖回原位等净零变化也吃掉):只可能因 JSON 键序差异「多留空步」(退回原行为,安全),**绝不会把真改动误判为空**(无 false-positive)。验证:`tsc --noEmit` 0 错;history/collageDoc/xyAutomation 纯逻辑单测全过。

## 17. 主总线效果器(Master FX 总线 / insert 效果器)—— 2026-06-20

浏览器 AI loop 机的"成品感"靠效果器。三个效果器 **失真 Distortion · 延迟 Delay · 混响 Reverb**,做成 **send/return(aux 返送)** —— 每件乐器经各自的 send 量旁路进 3 个共享效果 return,return 出湿声回主输出。**只有乐器能 send**(不是片、不是主总线),正是 §14 早定的 `Clip → 乐器 mixer → [sends] → 总线`。

> 沿革:最初(2026-06-20 上午)先做成**主总线 insert**(全体串 dist→delay→reverb)当过渡(那时"先不管 send");同日下午按 §14 定稿改为 send/return —— insert 行为退场,效果器只由乐器 send 喂。

**信号链落点**(`audio/studioEngine.ts` + `audio/fxBus.ts`):
```
各乐器 (Player→EQ→Panner) ──┬─────────────────────────────────────┐ [干声]
                            ├─ sendDist  ─► [Distortion return] ─┐ │
                            ├─ sendDelay ─► [Delay return]       ├─┤ [湿声]
                            └─ sendReverb─► [Reverb return]      ─┘ │
节拍器 click ──────────────────────────────────────────────────────┤ [干声, 不进 return]
                                                                    ▼
                                  master(Tone.Volume=主音量) ─► 软削波天花板(WaveShaper, memoryless) ─► Tone.Destination
                                          │
                                          └─► Split → MeterL/R (真实总线电平: post-FX/post 主音量/pre-软削波)
```
- 每个 voice:`panner → master`(干声)+ `panner → sendGain[i] → return[i].input`(3 条 aux 旁路,**post-fader/post-eq/post-pan**,接在 panner 之后)。3 个 return 各 `input → 效果核心(全湿) → returnLevel → master`。**并联**,互不串联。
- 3 个 send 量 = **per-乐器**(`Instrument.sends{dist,delay,reverb}`,0..1);效果核心参数 + return 电平/开关 = **全局**(`Project.fx`,见下持久化)。
- **主总线兜底(电平标准)**:所有声源(干声 + 湿声 return + 节拍器)先汇入 `master`(主音量推子的作用点,`Tone.Volume`)→ **软削波天花板(`Tone.WaveShaper`,4× 过采样)** → `Destination`。理由:Suno loop 多是成品母带级、单条已贴近 0dBFS,数条 unity 叠加会越过 0dBFS,无兜底则终点节点硬削顶(方波失真);软削波把峰值平滑饱和到天花板内(~-0.35dBFS),0dBFS 永不硬削。主音量从"`Destination.volume`"移到 `master.volume`(在天花板之前,推子动作能被表和天花板看见)。
  - ⚠ **为什么不用压缩器型限制器**(`Tone.Limiter`/`Compressor`):它有 attack/release 时间常数,会对鼓点/loop 接缝的瞬态做"压下→弹回"的增益起伏 = **抽吸 click**(走带满混音电平触发、单条预览不触发 → 表现为"单放干净、走带每圈咔")。软削波是 **memoryless**(纯波形映射、无时间常数),物理上不可能抽吸/咔;代价是峰值处轻微谐波饱和(暖色,适合 lofi/hiphop)。曲线 `softClipCurve(T=0.72, ceil=0.96)`:|x|≤T(~-2.9dBFS)纯净直通,超阈 tanh 平滑趋近 ceil。
- **L/R 总电平表抽头改在 `master`**(= post-FX/post 主音量/pre-软削波 的**真实总线电平**,能反映 return 尾巴/主音量/逼近天花板的过载;旧实现抽各 voice panner=pre-FX、测不到这些,已退场)。归一窗口 `[-54,0]dBFS`,UI 据此上色(≥-3 红 / ≥-6 琥珀 / 其余绿)。节拍器进 master(随主音量+软削波),但不进任何 return。
- 默认所有乐器 send=0 → 效果器静默(标准 aux 行为);return 的 `on`/`level` 在 FX 浮层控全局。delay 的 ping-pong 切换重建子图,其余都是 param set。

**三个效果器的算法(web 端最优解)+ 参数**:
| 效果 | 算法 | 参数 |
|---|---|---|
| **Distortion** | `WaveShaper`(自定义曲线/字符)+ **4× 过采样**抗混叠;drive = 前级增益喂入固定非线性 | `on` · `drive`(0..1) · `tone`(0..1 后置低通 400Hz–18kHz) · `character`(soft=tanh 管味 / hard=hard-clip / fuzz=非对称重谐波) · `mix`(0..1,直/湿线性交叉) |
| **Delay** | **自建反馈延迟 + 反馈环内低通阻尼**(回声逐次变暗=模拟/磁带味,优于无阻尼的内置 FeedbackDelay)+ ping-pong 交叉耦合左右两条延迟线 | `on` · `sync`(1/4·1/8·1/8.附点·1/16·ms;同步分割跟工程 BPM,ms=自由毫秒) · `timeMs`(ms 档用) · `feedback`(0..0.95) · `tone`(0..1 反馈阻尼) · `pingpong` · `mix` |
| **Reverb** | **卷积混响**(`Tone.Reverb` = ConvolverNode,衰减噪声离线生成 IR;web 金标准,比 Schroeder/Freeverb 真实)+ 湿声后置低通实现 `damp` | `on` · `decay`(0.3–12s,IR 长度=房间大小) · `preDelay`(0–150ms) · `damp`(0..1 高频阻尼,越大越暗) · `mix` |
- 每个效果块 = `{input,output}` 两个 Gain 包一段**直/湿并联**:`on=false` 或 `mix=0` → wet 增益 0 = 直通。改 `decay/preDelay` 触发 IR 重生成(`Tone.Reverb.generate()`,**防抖**,异步=最终一致,见 §15.D);改 wet/feedback/cutoff/gain 都是即时的 param set。`sync`/工程 BPM 变 → 重算 delayTime。

**UI 两处**:
- **全局 return 设置(顶栏最右 · `studio/ui/FxRack.tsx`)**:撤销键左边一个 `FX` 按钮(任一 return 开着=陶土高亮),点开**下拉浮层**(右对齐、`right:0` 向左展开,沿用 `.metro-pop` 范式 + 点外/Esc 关闭)。顶部面包屑 `SENDS ▸ DIST · DELAY · REVERB ▸ OUT`,下面**三栏并排**,每栏:标题 + 右上 `⏻` 电源(=bypass return) + 陶土弧形旋钮(沿用 MixerStrip 画法:竖拖/双击复位) + 选择器 chip(失真字符 / 延迟同步分割) + ping-pong 开关。末位旋钮 `LVL` = 该 return 输出电平(原 `mix`,send/return 下 return 全湿,故是电平不是干湿)。
- **per-乐器 send(`studio/ui/MixerStrip.tsx`)**:乐器 mixer 条在推子 + EQ 旋钮列**右边**加一个 block,竖排 3 个 send 旋钮(DIST / DLY / REV,0..1)。**只在乐器级 mixer 显示**(单 sample 乐器 + collage 乐器);collage **片**级 mixer 不显示(`sends` prop 可选,不传即不画)。

**持久化(§15.A/B)**:① 全局 = `Project.fx` JSON 逃生口(同 `gridPrefs` 套路;改参即 `eng.setFx()` + 防抖乐观 PATCH;load 走 `page.tsx`→`StudioApp`→建引擎后 `setFx`)。② per-乐器 send = `Instrument.sends{dist,delay,reverb}`,走**已有的 `sends` JSON 列**(schema/sync `NInstrument.sends`/`/api/studio` GET+ops 全程已带,原是 `Send[]` 占位,现定型为固定三效果对象);在 sessions 树里 → 走细粒度发件箱 diff,改即存。

**undo**:① 全局 `Project.fx` 按 §16 铁律②**显式扩口径**纳入(snapshot 抓 `fx` + applyEntry 还原 + 引擎 `setFx` + 反向 PATCH;FxRack 旋钮拖动**开始**压一次 `pushHistory`,不是每帧)。② per-乐器 send 在 sessions 树里 → **天然在快照口径**,`changeSends` 走 `pushHistory`+树更新,自动可撤。

## 18. Solo(每件乐器独奏)—— 2026-06-20

每件乐器 pad **右下角**一个方形 **S** 按钮(hover 显形、active 常驻、再点取消),做**隔离式 + 多选**独奏:点 S = 只听被 solo 的乐器,其余全部静音;可同时 solo 多个;清掉所有 solo 回到原 ▶ 混音。是 ▶(`enabled`,运行态/持久化)之上的**第二层瞬态遮罩**,不替代 ▶。

**语义(隔离式 + 多选,2026-06-20 用户拍板)** —— 设 `soloActive = 任一乐器被 solo`,每件乐器:
- **是否可听** `audible = soloActive ? soloed : enabled`。
- **player 是否在跑** `running = enabled || soloed` —— solo 一个 ▶ 关着的乐器会把它**点起来发声**(隔离它),清 solo 再停;armed 但没被 solo 的乐器在 solo 期被静音但 **player 不停**(保相位,清 solo 即原相位接回)。

| pad | 无 solo | solo 它 | solo 别的 |
|---|---|---|---|
| ▶ 开(armed) | 响 | 响 | 静音(仍在跑、保相位) |
| ▶ 关(stopped) | 不响 | **响**(被点起) | 不响 |

**引擎落点(`audio/studioEngine.ts`)**:每个 voice 在 `eq.high → panner` 之间插一个 `muteGain`(`Tone.Gain`,在 sends 分叉**之前** → 静音连干声带 FX send 一起灭)。`setSolo(ids)` 替换内部 `soloIds` 集后对所有 voice `reconcileVoice`:`muteGain.rampTo(audible?1:0, 15ms)`(即时、防 click、不动 player → 保相位)+ `setRunning(running)`(把原 `setEnabled` 的量化 fire/stop 逻辑抽出、键于 `running` 而非 `enabled`)。`setEnabled` 改为只设 `wantOn` 再 `reconcileVoice`;`startTransport` 按 `running` 起声 + 按 `audible` 置 muteGain;`stopTransport` 把所有 muteGain 复位 1(走带停时不静音 → 预览/audition 经同一链不被 solo 灭,下次起播再按 solo 重置);`clearAll` 清空 `soloIds`(无 voice = 无 solo)。meter 抽在 muteGain 之后 → 被静音的 pad 电平表自然归零。

**状态/持久化/undo**:solo 是**瞬态演奏态** —— **不落库、不进 undo**(§16:走带/播放=瞬态,同 play/stop)。但**跨「停/起走带」常驻**(§20 起播收敛:Live `retainOnly` 天然保留;Song/冷起 `loadSession` 后 `reapplySoloFor` 把本场 solo 推回引擎)—— solo 像 ▶ 一样停一次再播仍在,不重播即复位。authority 在 `StudioApp` 的 `soloRef`/`soloIds`(state),`toggleSolo` 改集合 + `eng.setSolo`;切 session(`switchSession`)、跨块(块推进)、undo/redo(`applyEntry`)→ `clearSolo()`(切换到**别的内容**才清,soloIds 装的是旧场/旧块乐器 id);删乐器(`removeInst`)→ 从集合剔除再 `setSolo`。引擎 `soloIds` 仅经 `setSolo` 改 + `clearAll` 清,两边保持同步。

**UI(`StudioApp.tsx` + `globals.css`)**:`.solobtn` 绝对定位 pad 右下角 19px 方形,三态 —— 静止 `opacity:0`、`.clip.filled:hover` 显形描边、`.on` 填充 solo-amber 常驻;`onMouseDown` 置 `dragOK=false`(同 `.launch`,防误拖)、`onClick` `stopPropagation`+`toggleSolo`。`soloActive` 时非 soloed 的 pad 加 `.solo-off`(`opacity:.4`,hover 抬到 .72,看清在点什么);soloed 的加 `.solo-on`(amber 内环)。新 token `--solo:#e3b53f` / `--solo-ink:#2a1f05`。空 sample 乐器(无声)不显 S。

## 19. 桌面化 / Electron 宿主(📐 设计 · 2026-06-20)—— 灵感来自 Ableton×Splice

**目标体验**:像 Ableton 挂 Splice 那样——一个能托管 Suno 登录态、能直接读本地采样库、不出 app 就浏览+就地贴速试听+一拖即用的**桌面宿主**。注意:Splice 之所以爽,根子不是"库大",是它是**能摸到本地文件系统 + 托管登录态的原生宿主**;而那套"就地贴速预览"我们 [`auditionSound`](web/src/studio/StudioApp.tsx:444)(`warpToBuffer(s, c.bpm, …)`)**已经在做**,贴调待 §11 的 auto key-conform 补上。

**为什么是 Electron 而不是 Tauri**:§9 当初否原生的**唯一理由是 WKWebView 的 Web MIDI 差**(冲着 Tauri)。Electron 自带 **Chromium** → Web Audio / Web MIDI / WASM warp / OPFS / AudioWorklet **零改动平移**。即整个实时音频核心(最难、最怕动)不碰。Electron 是唯一不推翻任何既有技术决策的原生外壳。

### 形态:双轨并存(2026-06-20 用户拍板)
web 版与桌面版**共享同一个 Next app + 同一份音频/数据核心**,平台差异收进**一个适配层**,代码不分叉。三处接缝(seam),各给 web / desktop 两种实现:

| seam | web(现状,保留) | desktop(新增) |
|---|---|---|
| **Suno 桥** | Chrome 插件(`suno-bridge/` 的 `interceptor/relay/bridge` 跨三上下文 + `externally_connectable`) | **隐藏 suno.com `BrowserView` + preload + IPC**(见②) |
| **数据库** | MySQL(`prisma` `provider="mysql"`,多租户) | **SQLite**(本地单用户;§7 早注"本地单用户 SQLite 更省事") |
| **素材源 / 文件系统(统一 ingest,见③)** | Suno CDN 下载 + **网页上传 file/folder**(`<input>`/拖拽/`webkitdirectory`) | + **Node fs 选夹 + watch + 本地采样拷贝入 storage** |
| **外壳** | 浏览器标签页 | **Electron 包 `next start` 子进程**(窗口指 localhost;音频核心 Chromium 零改动) |

- **统一接口**:桥抽成 `SunoBridge`(`gens/generate/feed/detectLoop`,签名 = 现 `playground/studioGens.ts` 调的那套),web 注入插件实现、desktop 注入 IPC 实现;调用方(`StudioApp`/`studioGens`)无感。DB 走 Prisma 同一 schema、仅切 provider(注意 `@db.Text` 等 MySQL 专属类型在 SQLite 的等价/降级)。素材源抽成"产出 `Asset{path}` 的 ingest"——Suno 下载与本地拷贝是它的两个实现。
- **后端**:desktop 先走 **`next start` 当 Electron 子进程**、窗口指向 localhost(改动最小,先出活);路由逻辑搬进主进程 IPC 是后续可选优化。`stem-service`(Demucs :8008)由 Electron 拉子进程 / 仍作本地 sidecar,逻辑不变。
- **多租户/scoping(§15.D)**:web 保持 User 层多租户;desktop 退化为**固定一个本地 user**(数据模型仍带 `userId`,只是只有一个)。web↔desktop 云同步 = 开放问题(见下)。
- **适配层(一处收口)**:Electron preload(`contextIsolation` 开、`nodeIntegration` 关、`sandbox`,只暴露一个 typed 最小 API)注入 `window.sunogrid`。`isDesktop = !!window.sunogrid` 是**唯一**的平台判定点;桥实现、ingest 源、(打包期)DB provider 全据此分流。`sunoBridge`(`web/src/studio/sunoBridge.ts`)改成**薄 shim**:有 `window.sunogrid` → 走 IPC,否则 → 走现在的插件 `postMessage`,调用方(`studioGens`/`StudioApp`)无感。
- **数据库(决策 A,2026-06-20 拍板):一份 schema + 构建期切 provider**。web=MySQL 不动;desktop 构建跑自己的 `prisma generate`(`provider="sqlite"` + 本地文件 URL)打进包。业务码只经 `db` 单例(`web/src/lib/db.ts`),零改动。一次性工作:过一遍 `@db.Text` / `Json` / 默认值在 SQLite 的等价(Prisma 的 `Json` 在 SQLite 落 TEXT,可用但要验);**否决** libSQL/Turso 统一(干净但要迁 web)与"desktop 连远端"(违背离线宿主)。

### ② Suno 登录搬进 Electron(收益最大;是简化不是移植)
现状痛点([suno-bridge-ops] 笔记):token 现取、改完重载插件 + 刷两标签、chrome:// 不能自动 —— 根因是要横跨 `bridge.js↔relay.js↔interceptor.js` 三个隔离上下文借用 Suno 页面活会话(`externally_connectable` + 三 content script)。

桌面端**塌缩成一个 preload + IPC**:
- 隐藏 `BrowserView` 指向 suno.com,**独立持久 session 分区** → 用户登录一次(Clerk),cookie **重启不丢**。
- generate/feed 仍走**页面内 fetch**(`interceptor.js` 现在的活、`suno-bridge/api-map.md` 逻辑完全不变),由 preload 执行 → IPC 回渲染进程。
- 安全模型不变(**token 不落地、在活会话里跑**),但第一方、无插件安装/重载、无两标签刷新、登录持久、生命周期可控(静默续期 / 感知登出)。
- ⚠ ToS 风险同 §2(已知接受),不因桥换壳而变。退役插件**仅 desktop**;web 仍用插件。

### ③ 统一 ingest:本地采样(desktop)+ 网页上传(web)(2026-06-20 用户拍板)
**支点**:入库流水线([`studioGens.ts:77-91`](web/src/studio/studioGens.ts:77))现在就是 `拿字节 → Web Audio 解码 → detectLoop/分析 → api.sounds.create({audioB64,…})`。Suno 下载、本地文件、网页上传**只差"字节从哪来"**。所以抽一个客户端 `ingestAudio(bytes, meta)`(解码+分析+落库,**解码/分析留客户端** —— 两端都是 Chromium,不必在 Node 重写 WASM),再给它三个字节源 adapter:
- **Suno 下载**(两端,现状,`sunoBridge.download`)。
- **网页上传(web)**:`<input type=file>` / 拖拽 / `webkitdirectory` 选夹 → `File.arrayBuffer()` → ingest。= 你点 3"web 体验变成上传文件"。
- **本地文件/夹(desktop)**:`dialog.showOpenDialog`(文件或文件夹)→ preload 读字节 → ingest;文件夹 = 主进程枚举音频文件。

数据模型早就为它留好:[`Asset`](web/prisma/schema.prisma:68) 本就是源无关的 `{path, kind, sha256, sourceUrl}`,[`Sound`](web/prisma/schema.prisma:112) 有 `sourceBpm/musicalKey`。库导入 UI 只调一个 `importAudio()`,平台差异只剩"取字节"那一步。desktop 额外能力:
1. **选夹 + watch**(主进程 Node fs,像 Ableton 指向 Splice 下载夹)。
2. **入库 = 拷贝进 app storage**(和 Suno 下载成素材一致,库自包含、不怕源文件挪位;代价是磁盘占用翻倍 —— 已选此权衡而非原地引用)。`sha256` 去重 schema 已有。warped 缓存照旧另放(`WarpRender`)。
3. **补 BPM/调**:① Splice 文件名自带(`...90bpm...Cmin...`)→ 解析,近乎免费;② 无标签 → 跑现成 [`conditioning.ts`](web/src/audio/conditioning.ts)(onset 自相关估速,§10 已验证)。③ **one-shot vs loop** 区分(loop 走 warp;one-shot 走切片/触发,后置)。
4. **汇入现有流水线**:warp 到主 BPM → 试听(已贴速)→ 拖进 slot。= §11 "外部样本导入(可早加)"在桌面端几乎白送。

### 持久化 / undo(不破宪法)
本地采样入库、桥调用都走 §15 乐观更新/发件箱;入库/删除走 §16 软删口径(库存活集已在 undo 口径,见 [undo-constitution])。SQLite 下发件箱/乐观更新机制不变(只换 Prisma 后端)。

### 分期
1. **Electron 外壳**:新增 `desktop/`(主进程+preload+electron-builder),包 `next start` 子进程(dev 指 localhost、prod 用 Next `output:'standalone'`)+ 桌面构建切 SQLite(决策 A)→ 能双击启动;验证音频/MIDI(Chromium,基本白跑通)。
2. **Suno 桥搬进 Electron**(②)→ `sunoBridge` 改薄 shim + BrowserView/preload/IPC + 持久 session 分区 → 桌面退役插件。← 干掉最大运维痛点。
3. **统一 ingest 重构(三源)**(③)→ 抽 `ingestAudio` + adapter:**web 上传**(file/folder)与 **desktop 选夹/拷贝入库** 一次落地(同一重构两端都受益)+ BPM/调(文件名→`conditioning.ts`)+ 汇入试听/拖拽。← Splice-夹 + 网页上传。
4. **打磨**:desktop `fs.watch` 实时夹、预览 auto key-conform(§11)、库搜索/按 BPM·调筛选/收藏。

### 开放问题
- web↔desktop **云同步**(MySQL 多租户 ↔ 本地 SQLite):暂留 desktop 纯本地,后续按需。
- (决策 A 的落地子任务,非开放)SQLite 与 MySQL 的 schema 类型差异清单(`@db.Text`/`Json`/`Float`/默认值)Phase 1 逐列过一遍。
- 打包签名:electron-builder + Mac 公证 + 自动更新(标准开销)。
- one-shot 触发(非 loop)= 新乐器形态 or 复用 sample 乐器,后置。

### 本次复核 + 落地约束(2026-06-22,🚧 Phase 1 实现中)
重新拍板(本次会话):**web 永远为主、desktop 是 bonus 但要好用**;分发目标 = 普通用户**下载即用**;桥走 **C 案**(② 内嵌 suno.com + IPC,desktop 退役插件)。据此把 §19 从 📐 设计推进到实现,补三条硬约束:

- **铁律:桌面只准「加分支」,不准改共享核心里 web 的行为。** 全局唯一判定点 = `isDesktop = !!window.sunogrid`;不带此标志走的就是现状 web 路径(插件 / MySQL / 多租户原样、一等公民)。**删掉整个 `desktop/` 目录,web 必须照跑不误**——这就是「一套代码、不维护两套」的可证伪判据。
- **数据全在云端(2026-06-22 再拍板,⚠ 推翻 §19 决策 A 的 SQLite 本地化):** 用户定:**桌面不做任何本地存储** —— 不用 SQLite、不落本地盘;desktop 直接连**同一套云端 web 后端**(同一 MySQL + storage + 多租户账号,用户登自己的 SunoGrid 云账号)。因此 **Phase 1b(sqlite 派生 / 本地库 / Prisma 引擎打包)整条取消**;desktop 退化为「指向云端 URL 的原生客户端 + 内嵌 Suno」,连本地 `next start` 子进程都不需要(prod 直接 `loadURL(云端)`)。`schema.prisma` / `db.ts` / `output:'standalone'` 一概不动。
- **桌面唯一的实体差异 = 内嵌 Suno(2026-06-22 用户拍板,即 ② C 案):** 用户定:**桌面版要在桌面里开 suno.com 来连接**(隐藏 BrowserView + 独立持久 session 登录一次、IPC 驱动),不靠 Chrome 插件。这是 desktop 相对 web 的核心增量、也是几乎唯一的桌面专属工程。
- 本地选夹入库(原 ③)在「无本地存储」下退化为「读本地文件 → 上传云端 storage」,可选、后置,不在当前范围。

落地分期(已按上面的云端化重排):
- **Phase 1 ✅(已实现并验证):** 新增 `desktop/`(Electron 主进程 + preload + electron-builder)。dev 指向 `localhost:3007`(主进程按需拉起 `web` 的 `next dev`)、prod 指向云端 URL(`SUNOGRID_URL`,默认 `https://sunogrid.com`)。preload 在 `contextIsolation` 开 / `nodeIntegration` 关下注入最小 `window.sunogrid` → 探针实测 `{isDesktop:true,platform:"desktop"}` 于 `/login`。**不碰任何 web 文件。**
- **~~Phase 1b~~ 取消**(改云端,无本地库)。
- **Phase 2(下一步,桌面核心):** 内嵌 suno.com BrowserView + 独立持久 session + IPC;[`sunoBridge.ts`](web/src/studio/sunoBridge.ts) 改薄 shim(`window.sunogrid`→IPC,否则走原 postMessage;**web 走原路、改完做 web 回归**)。桌面退役插件;web 仍用插件。
- **Phase 3:** 打磨(登录态生命周期 / 静默续期 / 感知登出;可选「读本地文件 → 传云端」上传)。

## 20. Session 场景 × 双播放模式(Live 切换 / Song 线性)—— 📐 设计 · 2026-06-20

把 Ableton 的 **Session/Arrangement 二象**搬进 loop 机:`Session` 升格为**可命名、可上色、可复制、能排次数**的"场景";一个**引擎量化换场原语**,两套驱动(Live 点击 / Song 线性自动推进)。需求来源:① 每场景 ≤100 乐器(已满足,`SLOTS_PER_SESSION`)② 场景间**量化**切换播放 ③ 复制场景(连乐器一并复制副本)④ 每场景设播放次数 → 生成歌曲时间线 ⑤ 两种播放模式。

### 核心决策(方案 A —— 次数挂在 Session 上)
时间线 = **场景 rail 本身**(按 `index` 顺序,每个场景播 `repeats` 遍),**不开独立时间线表**。理由:数据最省(只加列)、自动吃现有 undo 口径①与整树 diff 持久化、零额外管线。代价:同段落重复(ABA)靠**复制场景**(需求 ③ 正好是这个的逃生口)。曾考虑方案 B(独立 `TimelineBlock` 表,可任意复用/重排),否决:要新表 + 扩 undo 口径 + 单独编排轨,超出范围;两者数据结构不冲突,将来要真·编排再演进。

### 两种播放模式(共用一个量化换场原语)
- **Live 切换模式**(现有 `switchSession` 硬停 → 升级为量化):点场景卡 → 排队(目标卡呼吸)→ **下一量化边界**停旧场全部 voice + 起新场 `enabled` voice(保相位)。复用 `nextBoundary()`(顶栏 Quantize 粒度)。
- **Song 线性模式**(新):按场景顺序,每场播 `repeats × sessionBars` 小节后,在该边界**自动推进**到下一场(同一换场原语);末尾按 `loopSong` 决定**停止**或**循环整首**。
- 走带**停**时切场景:沿用硬切(`clearAll` + `loadSession`),无声可断,不必量化。
- **(重)起播必先把引擎收敛到「仅当前选中场景」**(关键 bug,两模式同根因):`startTransport` 会把引擎里**所有 armed voice**(`wantOn=true`)一并 `fire`,**不分属于哪个场景**。而引擎会残留别的场景的 armed voice:① Song 每进一块都预载下一块(`enterSongBlock`,下一块 armed 但未到边界没出声);② Live 快速连切时,被 `swapGen` 作废的中间目标场**已被 `loadSessionAdditive` 装进引擎**(只是没去排边界),留下 armed 残渣;且 `stopTransport` 只停 player、**不清 voice / 不动 wantOn**。于是「停→再播」(Live 还含连切后)就把残留的别的场景一起点响 → 多场景叠加 / 听到的不是当前选中场景。
- **统一起播 `startPlayback`(Live/Song 共用)**,起播前按"当前场是否已在引擎"二选一收敛:
  - **已在引擎**(`当前场 ids.some(hasVoice)`,Live 常态)→ `engine.retainOnly(当前场 ids)`:瞬时剔掉别场残渣、不重建、**保 solo**。
  - **不在引擎**(Song 必走;Live 从 Song 钉住视图切回时也会遇到 —— 钉住查看只 `ensurePeaksForView` **不建 voice**)→ `await loadSession(当前场)`(`clearAll`+只装当前场,buffer 命中缓存故廉价)+ `reapplySoloFor(当前场 ids)`:`clearAll` 抹了引擎 soloIds,把 `soloRef` 里**仍存活于本场**的 solo 重新推回引擎(跨块残留的别块 id 过滤掉),让 solo **跨停/起走带常驻**(§18,2026-06-22 修:原为 `clearSolo` 重播即复位 → 用户反馈 Song 模式停一次再播 solo 就丢,违反「solo 应像 ▶ 一样常驻」)。⚠ 这条不能用 `retainOnly`,否则当前场没 voice 会被剔成空引擎 = **静音**(早期 Live 分支只 `retainOnly` 的真 bug)。同理 `startPlayFromBar`(跳播)也由 `clearSolo` 改 `reapplySoloFor`。
  - Song 额外:`setTransportPosition('0:0:0')` 归零 + `viewFollows=true` + `setPlayingIdx` + `enterSongBlock` 排块末推进。
  - **`starting` ref 锁**:loadSession 是异步窗口,锁住①重入起播(连点 ▶)②并发 `switchSession`(`switchSession` 开头 `if (starting.current) return`)—— 否则点卡的 `loadSession` 与起播的重灌**交错**,引擎混入别的场景,又退化成"选中的不是播放的"。

### 引擎(`audio/studioEngine.ts`)
voice 按乐器 id 唯一 → 新旧场景的 voice 可**短暂共存**于 `voices` Map,这是无缝量化换场的关键。新增最小原语:
- `swapAtBoundary(cb)` / `scheduleAt(pos, cb)`:在下一量化边界 / 指定 bar 位做一次性回调(`scheduleOnce` 包装,跑完 `onChange()`);用于"边界到了再翻活动场景 + 清旧场 voice"。
- 换场用**既有** `setEnabled`(走带在跑时它本就把 launch/stop 量化到 `nextBoundary`):切场 = 旧场全 `setEnabled(false)` + 新场 enabled 全 `setEnabled(true)`,同边界一起翻。
- **预载**:切场前 `loadInstrument` 目标场 enabled 乐器(不 `clearAll`,与当前场并存);buffer 命中 `WarpRender` 磁盘缓存即快,未就绪者在其后的循环边界补入(late entry,可接受;Song 模式可在当前块播放时**预取下一块**避免)。
- **内存**:只常驻"当前场 + 下一场的 enabled",换场提交后延迟 `clearInstrument` 旧场(守 §14 内存原则:别一进场全 bake)。

### 数据模型(§15 合规)
- `StudioSession` 加两列:`repeats Int @default(1)`(标量、可编辑 → 落列)、`color String?`(场景标识色 → 落列)。**不开新表**。
- `Project` 加 `loopSong Boolean @default(false)`(循环整首开关)。
- 复制场景:深拷贝 session + 乐器 + clip,**每层重生稳定 id**;`assetId/soundId/bakedAssetId` 共享(内容寻址,不必重 bake)。整树 diff 自动产 `sess.add + inst.add×N + clip.add×M`,**零埋点**。
- 链路触点:`contracts/instrument.ts`(`Session.repeats/color`)· `studio/sync.ts`(`NSession` + `SESS_FIELDS` + `normalize`)· `api/studio/ops`(`sess.add/upd` 带上)· `api/studio`(GET 组装回 + 默认场景给色)· `StudioApp.emptySessions`。

### Undo(§16)/ 持久化(§15)合规
- `repeats`/`color` 在 `sessions` 整树 → **已在口径①**;复制/删除/改名/改色/改次数走 `pushHistory()` + 数组级 `setSessions`(新增 `mutateSessions` 助手:`pushHistory` + setSessions),**免费可撤**。删活动场景顺带移 `activeSessionId`(口径⑤已含)。**无需扩口径**。
- `playMode`(live/song)= 演奏态,**不入栈**(同 play/stop 瞬态);可不持久化或后置为 UI 偏好。`loopSong` = `Project` 列乐观持久化;v1 **不入 undo**(playback 偏好,同 masterVol;要对称再按模板扩,记此处)。
- 持久化全走整树 diff,复制/删除零额外埋点。

### UI(原生 design system)
- **场景层 = 彩色卡片**(`StudioApp` 的 `.banks` 区升级):标识色 tinted 卡 + 名 + **乐器色块预览**(块=内含乐器,色对应下面 pad)+ `N 乐器` 计数;Song 模式右下出现**干净的次数微调器**(`×N` + 上下 chevron);当前/播放卡白描边;复制/删除 hover 出现;`＋` 新建场景。
- **乐器层 = pad**(现有 `.clip`):启动条 + 名 + bars/key + 波形。与场景卡刻意不同结构 → 一眼分层级。
- 顶栏:`Live 切换 | Song 线性` 段选 + 循环整首开关(Song 时可见)。

### 落地顺序
① 数据模型(列 + 契约 + sync + 路由)→ ② 场景 CRUD 纯函数(`sessionDoc`:duplicate/remove/rename/setRepeats/setColor/add)+ rail UI → ③ 引擎量化换场原语 + 改造 `switchSession`(需求②)→ ④ Song 模式 `playTimeline` + 循环开关(需求④⑤)→ ⑤ 预载/内存打磨。

### 性能(守则)
决定性能的是"同时被解码/常驻的 enabled 乐器数"与"每帧 React 重渲面积",**不是**场景数或 100 槽上限。守则:① 只常驻当前+下一场 enabled + `WarpRender` 磁盘缓存兜底 → 稳态 RAM 几十 MB;② 复制只拷元数据(共享音频字节),廉价;③ 连续视觉(播放头/电平/波形进度)走 `live.tsx` 自驱 RAF 叶子,换场/推进是离散事件(数秒一次)→ 不产生重渲风暴;④ 别一次性把整首歌 schedule 进 transport,链式推进 + 1–2 块 lookahead;⑤ buffer 预热只在主线程空闲期/边界前,边界回调里只 `player.start/stop`。

## 21. XY 表演板(Kaoss Pad 式主总线 insert)—— 📐 设计 · 2026-06-21

灵感来自 Korg Kaoss Pad:一块 XY 触控方块,手指位置实时控两个参数(左右=X、上下=Y),用手"演奏"整条混音。区别于 §17 的 send/return(乐器旁路进共享 return、永远留干声):XY 板是**主总线 insert**(整条 mix 串过去),要能 100% 吃全混音——把整段滤掉、gate 切碎、刹车。§17 那条"只有乐器能 send、主总线不能 send"**不冲突**:XY 不走 send,是 insert。

**为什么是 insert 而非 send**:send 并联、保干声,做不出"全 mix 低通扫死 / 整段被门切 / tape-stop"这种吃全混音的效果。insert 串在 `master` 与软削波天花板之间,吃到干声 + 所有 FX return 湿声的**最终和**。

**信号链落点**(`audio/studioEngine.ts` + `audio/xyPad.ts`):
```
干声 + 3 个 FX return 湿声 + 节拍器 ──► master(Tone.Volume) ──► 【XY insert】──► 软削波天花板 ──► Destination
                                              │
                                              └─► Split → MeterL/R(抽在 XY **之前** = 不被 XY 染色)
```
- splice:原 `master.connect(masterClip)` 改为 `master → xy.input`、`xy.output → masterClip`。一切先汇到 master(§17 已定),故 XY 吃到完整最终 mix。电平表仍抽 master(XY 前),表头反映"送进 XY 的电平",不随滤波/gate 抖动。

**XY insert 结构 —— 🔁 v2(2026-06-22):4 效果常驻串联**(v1 是「单 program 可切换、一个全局干/湿交叉淡」;改版起因 = §26 要「一段挂 4 种独立自动化、同时发声」,见 §26.2):
```
input ─► [filter] ─► [slicer] ─► [delay] ─► [brake] ─► output
          每个效果节点 = ┬─ dry ──────────┐
                         └─ effect ─ wet ─┴─►   (active→wet 渐入、inactive→纯 dry 透明旁路)
```
- 4 效果**常驻链上**(不再 dispose/build 切换);每个有独立 **active** 态:active=处理(wet 15ms 渐入)、inactive=硬旁路(dry=1、透明)。**多个可同时 active**(filter 扫 + delay 进 + slicer 切 叠加)。重的 `PitchShift`(brake)仍只在被 active 过才惰性建。
- 一个效果 active 的来源:**该效果的自动化 on(§26 Song 回放)** 或 **手动板正演奏它**;都无→旁路。驱动**统一由 §26.4 的单一 coordinator** 下达——手动板与回放都**不再各自直调引擎**(这正是修掉 v1「双驱动抢同一 insert→一干一湿/接管不了」的根)。
- **手动板一次只演奏一个效果**(顶栏选中的 program),即对该效果做手动 override;其余 3 个继续各自自动化/旁路。
- v2 每效果 NEUTRAL≈透明、强度由各自 Y(depth)给 → **去掉全局 WET 交叉淡**;spring/latch 仍在(松手=该效果交还/回旁路 vs 粘住,见 §26.4 交还滑行)。

**四个 program(X/Y 映射 + 算法)**:
| program | X 轴 | Y 轴 | 算法 |
|---|---|---|---|
| **滤波** | 双极 DJ 滤波(中点全开、左半 LP 下扫、右半 HP 上扫,对数 20Hz–20kHz) | resonance (Q 0.7–12) | 单颗 `BiquadFilter` 切 type+freq+Q |
| **Slicer** | 切片速率(吸附 1/4·1/8·1/8.·1/16,BPM 同步) | 深度/占空(门关多狠) | `Tone.LFO`(方波,sync 到 transport)调一个 `Gain` |
| **Delay** | 延迟时值(BPM 同步,同上分割) | 反馈量(0–0.95) | 自建反馈延迟(同 §17 DelayFx,insert 含直声) |
| **刹车** | tone(额外低通) | 刹车量(音高俯冲 + 低通收死 + duck) | `PitchShift` + `Filter` + Gain(tape-stop **近似**) |
- **刹车是近似**:真 tape-stop 音高+速度一起掉,但 web 主总线是实时声源之和,无法对"和"整体变速。v1 用 Y 连续控"音高俯冲 + 滤波收死 + 音量 duck"做刹车/断电听感(groove 实际没真慢)。真·变速留 v2(要碰 transport/自动化,跟"录手势进 loop"一起)。

**两种触发模式(用户拍板 2026-06-21)**:
- **回中 spring**:松手→ insert 淡回全干声(真旁路),圆点弹回中点(视觉)。不管松手在哪,效果干净归零(不必算每 program 的中性点)。
- **不回中 latch**:松手→ 参数停在最后位置、保持湿声(松手**不**调 release),直到再抓或关电源。即 Freeze 手感。

**状态色(接 §17/§18 既有语义)**:演奏中=陶土 `--acc`(同播放态)、锁定=暖金 `--solo`(同独奏的保持态)、旁路=灰、关=暗。

**持久化(§15.A)**:折进 `Project.fx` —— `FxConfig.xy{on,program,wet,mode}`,搭 §17 `fx` JSON 列便车,**不新增列**。改 program/wet/mode/on 走 `commitFx`(即时 `eng.setFx` + 防抖 PATCH);老工程缺 `xy` → load 时 `{...DEFAULT_XY, ...}` 合并。

**undo(§16)**:program/wet/mode/on 在 `FxConfig` 内 → 天然搭 §17 口径④便车(snapshot 抓 `fx`、applyEntry 整体比对还原),改前 `onStart=pushHistory`。**实时 X/Y/engage/release = 瞬态演奏态**,直连引擎 `xyMove/xyEngage/xyRelease`,**不碰 fx state、不落库、不进 undo**(对标 §18 Solo)。重载后从中点旁路起。

**引擎 API(`StudioEngine`)**:`setFx(cfg)` 顺带 `xy.setXy(cfg.xy)`(program/wet/on);`xyEngage()/xyMove(nx,ny)/xyRelease()`(瞬态);`setBpm`/retempo 边界顺带 `xy.setBpm`(slicer/delay 同步)。

**UI(`studio/ui/XYPad.tsx` + `globals.css` §21 块)**:顶栏 FX 按钮旁一个 `XY` 按钮(`.fx-btn`,armed=陶土),点开浮层(同 `.fx-pop` 范式、点外/Esc 关)。左=XY 方块(grid + 十字准星 + 圆点,Slicer/Delay 显吸附竖线),右栏=状态条 + X/Y 读数(两列 `.we-box`)+ 模式分段(`.seg`)+ WET 旋钮(沿用 FxRack Knob 画法)。program 用 `.fx-chip`。

**v1(已发)**:纯实时表演(不录进 loop)、**单 program**、四效果全做(刹车近似)。**🔁 v2(2026-06-22,设计中)**:4 效果常驻链**同时开** + §26 per-effect 自动化 + 单一 coordinator 仲裁接管(本节结构已按 v2 写;落地与 §26 v2 合并做)。真 tape-stop / 录手势进 loop 仍 v2+。

## 22. 采样器乐器(Sampler / Drum Rack —— MPC 式 pad 触发)—— 📐 设计 · 2026-06-21

灵感来自 Akai MPC / Ableton Drum Rack:一格 pad 一个**单发(one-shot)样本**,被**音序点 / live 弹**触发才响。**这是第一种事件驱动乐器** —— 现在 §14 的 `sample`/`collage` 全是 **loop 驱动**(整小节 buffer 常驻循环,开关只量化 launch/stop);采样器不是第三种 loop 乐器,而是把"触发时刻"变成一等公民。定位:把"切 loop 重排"从 collage 的**离线 bake 一条**升级成**实时可重触发 + 可排点**,贴合 SunoGrid「AI loop 机」的核心动作。

**双模式(MPC 式,2026-06-21 用户拍板「两者都要」)** —— 共用同一个事件型 voice,只差**映射**与**序列 UI**:
- **Drum**:N 个 pad,每 pad 钉死一个切片,按各自原生音高(+ pad tune)触发。lane = pad index。序列 UI = **step 网格**(行=pad、列=step,808 式)。
- **Keygroup**:**一个**切片沿键盘半音铺开(pitch 走 `playbackRate`,以 rootNote 为基准),弹旋律/bassline。lane = 半音。序列 UI = **音符网格**(行=音阶/半音的迷你 piano roll)。
> 一套数据、两种投影:序列只存 `NoteEvent{ step, lane, velocity, lengthSteps? }`,`lane` 在 drum 是 pad index、在 keygroup 是半音。引擎对两者一视同仁(都是"在某时刻以某 pitch 起一个带包络的 one-shot")。

**内容来源 = 自动切片库里 loop/stem(2026-06-21 拍板;v1 不做单发导入)**。库里全是 loop、没有独立 kick/snare,故 pad 内容由**切片**来:复用 `Sound.analysis.onsets`(已是 Sound 上 JSON)按瞬态切,或等分切;切法/切片→Clip 逻辑直接搬 `studio/realLibrary.ts`(`soundToClip`/`regionFromSound`)+ `studio/collageDoc.ts`(step 摆放)。**单发素材入口(web 上传 / desktop ingest §19)留 v2**,届时 pad 也能直接挂单发,数据模型不变(pad 仍是一条切片/Clip)。

**与 collage 的关系(别重复造)**:collage = 切片**横排 bake 成一条固定 buffer**、不可单独重触发;采样器 = 同样的切片**保持各自可触发** + 一条 pattern 排点。两者共享"把 loop 切成 Clip 碎片"的前半段,分叉在后半段(bake vs 实时触发)。切片→pad 的 UI 可复用 collage 的 chop 视图。

**引擎(`audio/studioEngine.ts` 新增 `SamplerVoice`,与现 `Voice` 并存)**:
- 现 `Voice` = 1 个常驻循环 `Tone.Player`;`SamplerVoice` = **每 pad 一份解码 buffer(切片) + 一个复音池**(`AudioBufferSourceNode` + 包络 `GainNode`,按需起/弃),不预拉伸(one-shot 用 `playbackRate` 调 pitch,**不做 time-stretch** → 比 loop voice 还简单)。
- **调度**:armed + 走带在跑时,`Tone.Transport.scheduleRepeat(cb, 本乐器 patternLen)`,每个 loop 周期把 `pattern` 里各 `NoteEvent` 的 `source.start(t + stepOffset)` 预排到该圈的 step 时刻。launch/stop **复用现有量化 arm**(`nextBoundary`/enabled toggle):armed → 下个边界起调度;disarm → 停排(响着的尾巴自然衰减或硬切)。
- **choke group**:同组新触发 → 对前一个 voice 走 fast release(hi-hat 开/闭)。**包络** = per-pad ADSR(`GainNode` 线性段)。
- **retempo 极简**:one-shot 不拉伸 → 改速**只需按新 step 时刻重排**,pitch 不受影响(无 §6 那套保相位换 buffer 的复杂度)。可选"切片随速拉伸"(warp-to-tempo)留 v2。
- **复用乐器外壳**:把现 `Voice` 里的"乐器条"(`muteGain → eq → panner → sends → meter`,§17/§18 都挂在这)抽出来,loop-Player 与 sampler 的 pad 汇总母线都接它的入口 —— solo/sends/EQ/pan 外壳零改动复用。

**信号链落点**:
```
pad 复音池(每 pad: source → ampEnv Gain →[pad gain/pan])─┐
                            … N pad 汇总 ────────────────► muteGain(§18 遮罩)─► EQ ─► panner ─┬─► (master 干声)
                                                                                                ├─► sendDist/Delay/Reverb(§17)
                                                                                                └─► meter
```
- v1 pad 共用乐器条(整件乐器一条 EQ/pan/sends),pad 级只给 **gain/pan/tune/choke/ADSR**;**每 pad 独立 mixer strip 留 v2**。

**触发源(三条,v1 不录制)**:
1. **step/note 网格点击** —— 排点的主路径(行=pad/半音、列=step)。
2. **电脑键盘 live 触发** —— drum:经典 4×4(`1234/qwer/asdf/zxcv`);keygroup:半音键位。**瞬态演奏**,直连引擎即响。
3. **Web MIDI best-effort** —— `navigator.requestMIDIAccess()` 有则映射 note→pad/半音(Chrome/Edge 好、Safari 弱),**接不上不挡路**;桌面(§19 Electron)更稳。
> live 触发(2、3)= **瞬态、不落库、不进 undo**(对标 §18 Solo / §21 XY 实时手势)。**录制(armed 时 live 弹→量化录进 pattern,这部分要进 undo/落库)留 v2**。

**持久化(§15)—— 重数据规范化、小参数走逃生口,不堆大 payload blob**:
- **pad 切片 = 复用 `Clip` 表**(每 pad 本质是一条切片 Clip:`soundId/assetId/startSample/endSample`,FK 引用、要 query 的活实体 → 必须落表,§15.B)。加判别(`padIndex`,类比 collage 用 `startStep` 区分)。**这是和 §15「payload Json 已消失」一致的做法 —— 重的、共享的、被引用的数据照样进 Clip 表。**
- **per-pad sampler 参数(tune/choke/ampEnv/pan)+ `pattern: NoteEvent[]` + `mode`** = 形状还在演进、同质数组/小配置 → 走 **`StudioInstrument.extra Json?` 逃生口**(§15.A 明确允许:"同质基本类型数组/形状还在演进 → 留 JSON";每张表留一个 `extra Json?`),稳定后毕业成 `SamplerPad`/`Note` 表。**不开新的大 payload blob**。
- 写路径同 §15.C 发件箱:排点/调参走字段级 op,连续拖动天然合并。

**撤销(§16)—— 口径不扩**:pad/pattern/mode 都活在 instrument payload 里、而 payload 在 `sessions` 整树(口径①)→ **编辑序列/pad 参数自动进 undo**,只要改前 `pushHistory`(§16 配方)。live 触发/MIDI 实时 = 瞬态,不进。

**下钻栈(§14,正好填满 2 层)**:选 sampler 乐器 → 底部 **pad 网格 + 序列编辑器**;再选一个 pad → **下钻**到该 pad 的 **Clip 编辑器**(改这片切片的 trim/tune,复用 `WarpEditor`,带返回)。深度封顶 Session › 乐器 › Clip,与现有一致。

**契约(`contracts/instrument.ts`)**:`InstrumentPayload` 判别联合加一支
```ts
| { kind: 'sampler'; mode: 'drum' | 'keygroup'; bars: number; stepsPerBar: number;
    pads: SamplerPad[];           // drum: ≤16;keygroup: 1(zone 多区留 v2)
    pattern: NoteEvent[] }        // { step, lane, velocity, lengthSteps? }
// SamplerPad = Clip 子集(切片) + { rootNote?, tuneSemitones, gainDb, pan, choke?, ampEnv?{a,d,s,r} }
```
`instrumentBars(sampler) = payload.bars`(pattern loop 长度);引擎/UI 都按它对齐主走带。

**UI(`studio/ui/` 新增 `SamplerEditor.tsx` 等)**:pad 网格(4×4,触发高亮=陶土 `--acc`、波形缩略复用 `.cwave`/`Wave`)+ 模式分段(drum/keygroup,`.seg`)+ step/note 网格(复用 collage 轨网格画法)+ per-pad 调(tune/choke/ADSR 用 FxRack 的 Knob 画法)。左栏库素材**拖到空 pad = 自动切片填**;hover 空格 `＋采样器`(同 §14 现有 ＋sample/＋切片 范式)。

**v1 范围 / 落地顺序**(drum 先、keygroup 次,共用 voice):
1. 契约加 `sampler` payload + `SamplerVoice` 引擎(drum 模式) + 量化 arm 复用。
2. 自动切片(onset/等分)→ 16 pad;step 网格排点;电脑键盘触发;per-pad tune/gain/choke/ADSR 基础;§15 持久化(Clip 表 + extra JSON)+ §16 undo。→ **可玩切片鼓机**。
3. keygroup 模式(rootNote 半音映射 + 音符网格,复用同 voice)。

## 23. 乐器复制/粘贴(pad 上 copy/paste,含跨场景 + 多选)—— 📐 设计 · 2026-06-21

把操场 pad 上的乐器**复制/粘贴**:同场景内复制,或**跨场景**(Verse copy → 切到 Break paste);**shift 多选**一把抓多件一起复制。**语义 = paste 即新建一件独立乐器**(深拷贝、重生 id、改一处不动另一处)。范围 **2026-06-21 用户拍板:同项目内(同/跨场景),不跨项目**——故剪贴板只是组件级 ref,**不落 localStorage**(跨项目/跨标签页/刷新留 v2,届时才序列化)。

**核心复用(不重造轮子)**:paste 的克隆原语**已存在** —— `studio/sessionDoc.ts` 的 `cloneInstrument(inst, newId)`:重生乐器 id + 每个 clip id;mixer/sends/payload **不可变深拷贝**;`assetId/soundId/bakedAssetId` 共享(内容寻址,**collage 不必重 bake**)。这正是 `duplicateSessionAt` 复制整场景时用的同一把刀。**paste 必走它,永不浅拷、永不复用 id。**

**编辑独立性 = 本功能的命门(用户点名的"编辑问题,100 个实例上线")**。两层:
1. **改原件不动副本**:靠 `cloneInstrument` 的不可变深拷贝 + 全新 id 保证。⚠️ **唯一的雷是浅拷贝/复用 id**,会同时炸三处 —— ① 一个 clip 对象被两件乐器共享 → 改一个改俩;② `studio/sync.ts` 的 diff 以 id 作字典 key,**同 id 互相覆盖 → 持久化损坏**;③ 引擎 `voices = new Map<id, Voice>`(`audio/studioEngine.ts`)按乐器 id 缓存,撞 id 串声。**铁律:每件粘贴出的乐器全新 id。**
2. **100 slot 上限 + 100 实例的代价**:每场景 `SLOTS_PER_SESSION`=100。paste 空位不足 → **能贴几个贴几个 + 顶栏提示丢了几件**,绝不静默丢、绝不覆盖已占 slot。粘贴出的乐器一律 **`enabled:false`**(同现 `addSampleFromSound`,不随主走带自动响)。paste 后逐个 `loadInstrumentToEngine` —— **关键**:克隆与源同 asset/warp 参数 → **必中 `warpCache`**(键 = `assetId|region|sourceBpm|masterBpm`,不含乐器/clip id),所以"加载"只剩建 voice + 取 peaks(decode 也有缓存),廉价;pad 立即出波形且可播、**不会真渲 N 条 buffer** → 大批量 paste 也安全(已浏览器实测:单件/3 件多选/跨场景 paste + undo 一步撤,均通过)。

**剪贴板模型(组件级 ref,瞬态)**:
- `clipboardRef = useRef<ClipboardItem[] | null>`,`ClipboardItem` = 去掉 `id/slot` 的乐器净荷(`label/color/icon/mixer/sends/payload`,payload 内 clip/clips 也剥掉 id)。
- **copy 当下 deep-detach**(剥 id/slot)→ 之后再编辑源乐器,剪贴板内容不变(常识 copy 语义)。
- **跨场景天然成立**:ref 不随 `sessionIdx` 变;copy 在 Verse、切 Break、paste,零成本。
- **剪贴板不进 undo**:同选中/播放,是瞬态视图态(§16"不该进"清单)。copy **不** `pushHistory`。

**多选(shift)—— 分层加 `markedIds`,不动现有单选语义(2026-06-21 拍板)**:现选中是单个 `selId`(`StudioApp.tsx`),被编辑器/删除/solo/拖拽多处依赖,直接改多选牵一发动全身。故:
- 新增 `markedIds: Set<string>`,**只服务 copy 的多选集**;`selId` 仍是"主选中"驱动底部编辑器(编辑器本就只编辑一件)。
- 普通点击 = 单选(`selId=id`,`markedIds={id}`);**Shift+点击** = 往 `markedIds` 增删,`selId` 跟到最后点的。
- 网格两种高亮:`isSel`(粗框,驱动编辑器)+ `isMarked`(淡底,在 copy 集里)。
- copy 读 `markedIds`(空则退化成 `{selId}`)。将来要多选删除/solo 再把它们接上同一个集合。

**粘贴落位(用户:"不必照 copy 时的顺序和形状")—— 紧凑填空位,不还原相对几何**:
```
锚点 = 目标 slot(右键/hover 处);无则取第一个空位
从锚点起 row-major 扫描,跳过被占 slot,
把 N 个克隆依次塞进遇到的前 N 个空位;
空位 < N → 贴能贴的,顶栏提示丢弃数
```
- 单 copy→单 paste 退化成"落在锚点空位"。**永不覆盖已有乐器**(避免"贴一下毁掉别人")。

**撤销(§16)—— 口径不扩**:整个 paste(哪怕一把贴 10 件)= **一次 `mutate()`**(`pushHistory` 只压一帧)→ 一次 ⌘Z 撤销全部贴出乐器。乐器活在口径①`sessions` 整树,**无需扩口径**。

**持久化(§15)—— 零新端点**:新乐器+新 clip 走 `sync.ts` 整树 `normalize→diff`,自动产 `inst.add`+`clip.add` op,**不碰 API/schema**。前提就一条:id 必须新且唯一(`cloneInstrument` 已保证)。音频最终一致:贴出乐器 `enabled:false`,选中/启用时才懒渲 buffer + 顶栏"重渲中"提示(§15.C)。

**边界 case**:① 贴到占用 slot → 跳过找下一空位;② 空位不足 → 部分 paste + 提示;③ collage 乐器 → `cloneInstrument` 已处理(每片重生 id、共享 `bakedAssetId` 不重 bake);④ 空壳 sample(`soundId===''`)→ 允许,贴出仍空壳;⑤ solo 是瞬态 per-id 集 → 新 id 不在 `soloRef`,不继承独奏;⑥ label 沿用原名 or 加" copy"(小事,实现时定;`duplicateSessionAt` 是加"copy")。

**键盘 / 入口**(复用 `StudioApp.tsx` 现有全局 `onKey`,已带 INPUT/TEXTAREA/contentEditable 聚焦护栏):
- **⌘C** = copy `markedIds`(或 `selId`);**⌘V** = paste 到锚点空位。
- **⌘D** 现绑拼贴片复制(需 `selClipId`);可扩展:选中乐器、无片聚焦时 ⌘D = 就地复制该乐器到最近空位(= copy+paste 快捷)。
- 鼠标:乐器卡右键菜单 Copy / Paste,空格右键 Paste here。

**落地顺序**:
1. `sessionDoc.ts` 加 `cloneForPaste`(剥 id/slot)+ 落位纯函数 `firstFreeSlots(session, n)`;clipboard ref + copy/paste handler(单件先跑通)。
2. 键盘 ⌘C/⌘V 接线 + 顶栏"空位不足"提示;验证 undo 一步撤、刷新还原(sync diff)。
3. `markedIds` 多选 + shift-click + 双高亮;多件 copy/paste 紧凑落位。
4. 右键菜单 + ⌘D 就地复制(可选)。
- **v2**:Web MIDI 硬件正式接入 + **录制**(量化录进 pattern,进 undo/落库)+ 单发 ingest(§19 desktop)+ 每 pad 独立 mixer strip + swing/velocity 层 + slice-to-tempo warp + 完整 piano roll + keygroup 多 zone。

## 24. Clip 尾淡出(Fade-out,两点曲线)—— ✅ 实现 · 2026-06-21

**形态**:在共享 `ClipEditor`(`WarpEditor.tsx` 的 `WarpCanvas`)波形上,fade 由**两个可拖点**定义,曲线是**隆起抛物线 `1-t²`**(先保持响、尾段陡降,鼓向上;不是 S 线):
- **顶点**(画布最上,gain=1)= 淡出起点;**底点**(画布最下,gain=0)= 淡出到零点。两点**无极拖动**(不吸网格 bar),都钉在 loop **后半**(任一都不得越过 loop 中点 → fade 区 ≤ loopLen/2;拖动时显 ½-trim 虚线上限)。
- 顶点拉到结束线 = `fadeOut=0` = 取消淡出(顶点恒显,作"拉出淡出"的入口);底点默认钉在结束线,往左拉 = loop 结束前就到静音(尾巴留空)。
- **可视化只用一块实心(非渐变)更深罩层**:下沿 = 抛物线,罩住的部分即被衰减(越靠尾越满 → 静音)。不画连接线 —— 抛物线即罩层的边。

**模型(sample 域,同 trim/warp,非乐器层)**:`Clip` 加 `fadeOutBars?`(顶点,距 loop 尾小节数)、`fadeSilenceBars?`(底点静音尾,距尾小节数;≤ fadeOutBars)。`SampleWarp` 同步 Pick 这两字段 → 落 `Sound.warp` JSON 并回流。

**音频**:在 `realLibrary.warpToBuffer` 里,纯 warp buffer(落盘缓存仍是纯 warp)出来后**后挂淡出**(`applyFade` 把尾巴乘隆起抛物线包络 `1-t²`,与编辑器同曲线,fadeEnd 后到尾=静音),faded 结果单独进内存 LRU。比例在 `regionFromClip/Sound` 换算成 buffer 占比(对 timeMul 拉长不变),引擎 `loop=true` 每圈循环自然淡尾(也顺手消循环接缝爆音)。预览/编排/库预调三条路都过 `warpToBuffer` → 所见即所听。

**undo / 持久化**:寄生在 `Clip`/`SampleWarp`,拖前照常 `pushHistory`(§16 warp 快照口径自动覆盖);Clip 表新增两列 + `sync.ts`(NClip/快照/CLIP_FIELDS)、ops `CLIP_COLS`、GET `clipFromDb` 全部带上(§15)。`Sound.warp` 那条只改 JSON 读写。⚠️ 加列后需重启 next 让 Prisma client 生效。

## 25. 示例项目(共享只读母版 / 写时复制 fork)—— 🚧 实现中 · 2026-06-21

**一句话**:上线要让**每个人的工作台里天生有示例项目**。示例 = super admin 标记的一份**全局共享、只读的"母版"**;谁去编辑都不动母版 —— **进入即在自己账户里生成一份独立副本**(eager fork-on-open),之后他编辑/保存/删的全是这份副本。母版本身只读,用户也能**把它从自己列表里移除**(per-user 隐藏,不碰母版)。本质 = Google Docs"查看→一编辑就自动建副本"。

**为什么是 fork-on-open(进入即 fork),不是只读编辑器**:§15 是**没有 Save、改即存** —— 编辑器一动就往 `/api/studio/ops`(按 `projectId+userId` 校验)写库。若让用户停在母版上编辑,ops 要么被 userId 校验拒掉(同步点永远报错)、要么放宽就**污染所有人共享的母版**。fork-on-open 把难题整个绕开:进入示例 → 服务端深克隆出"他自己拥有的副本" → 重定向到副本;此后编辑器面对的永远是自有项目,**§15 autosave / §16 undo / 库 scoping 一行不用改**。这是本节最关键的设计取舍。

**角色**:`User.role: USER | SUPER_ADMIN`(default USER)。`getCurrentUser` 带出 `role`;`isSuperAdmin(user)` 判定。**只有** super admin 能把项目标成示例(`PATCH /api/projects/:id { isExample }` 加 super-admin 网关;普通用户传 isExample → 403)。上线时手动把站长那条 User 提到 `SUPER_ADMIN`(一条 SQL / `scripts/promote-admin`)。

**数据模型增量**:
- `Project` 加 `isExample Boolean @default(false)`(母版标记)、`forkedFromExampleId String?`(副本回链母版,做去重 + 溯源)、`@@unique([userId, forkedFromExampleId])`(MySQL 下多 NULL 互不冲突,故只约束"每个用户对每个母版至多一份副本" —— 普通项目 forkedFromExampleId=NULL 不受影响,正是去重的底座)。
- 新表 `ExampleDismissal { userId, projectId, @@id([userId, projectId]) }`:"把示例从我的列表移除"= per-user 隐藏一行,**不删母版、不删任何人的副本**。

**列表并集**(`GET /api/projects`,原本硬锁 `where:{userId}`):
```
我的项目(userId=me, owned=true)
  ∪
母版示例(isExample=true AND userId≠me AND id ∉ 我的 dismissals, owned=false)
```
每行回 `{ ...project, isExample, owned }`。新用户没有自己的项目 → 列表里就是这些示例(满足"天生有示例")。示例排在前,带"Example · read-only"角标。super admin 自己的母版只走"我的项目"那支(owned=true,带可切换的 ★Example 开关),**不**在示例支重复。

**进入示例 = eager fork(去重 resume)** —— `forkExampleProject(exampleId, userId)`(`lib/forkProject.ts`,两个入口共用):
1. **去重/resume**:先查 `Project{ userId, forkedFromExampleId=exampleId }`,有就直接返回它(重复进入回到上次那份副本;副本删了再进 → 重新生成)。唯一约束兜并发(P2002 → 回查返回)。
2. **深克隆**(一个事务):建 Project 壳(拷标量,`userId=me, isExample=false, forkedFromExampleId=母版`)→ 克隆引用到的 Sound → 克隆 Session 树 → 克隆 PadClip。
3. 两个调用点:① Workbench 点示例 → `POST /api/projects/:id/fork` → 拿副本 id → `router.push` 副本;② 直接访问 `/projects/母版id`(书签/刷新),页面 server component 不属己时,若 isExample 则 fork + redirect 到副本(idempotent,靠 resume 安全)。super admin 点自己的母版 = owned,直接进母版编辑,不 fork。

**⚠️ 命门:Sound 是 per-user 的,fork 必须连库一起克隆**。§15 把 `Sound` 定为**用户级库**(`Sound.userId`),`Clip.soundId` 指它。`cloneInstrument`(§23)故意**共享 soundId**(同用户同项目内成立),但 **fork 跨用户**:副本若仍指母版的 soundId,则 ① 用户库视图(`where userId=me`)看不到这些声音;② 一旦 autosave,`/api/studio/ops` 把"非己 soundId"归 null → clip 丢声音链;③ §16 undo 口径②"各库声音 warp"靠用户自己的 `ctx.soundsById`,这些声音不在里面 → 改 warp/undo 全断。**所以 fork 不能复用 `cloneInstrument` 那把刀** —— 必须把工程引用到的 Sound(连 stem 的 parent 链)克隆进副本所有者的库(新 `Sound.id`、`userId=me`、`originProjectId=新项目`、`genId=null`),建 `母版soundId→新soundId` 映射,重写所有 Clip/PadClip 的 soundId。`Asset`(sha256)与 `WarpRender`(签名)是**全局共享 → 不复制**(`assetId/bakedAssetId` 直接沿用,collage 不必重 bake)。

**克隆范围**:Project 标量(name/bpm/key/quantize/beatsPerBar/genPrefs/gridPrefs/fx/loopSong)+ StudioSession 树(Session→Instrument→Clip,全列含 sends/extra/各 mixer 列,新 id)+ 引用到的 Sound(+parent 链)+ PadClip。**不带** Gen 生成历史(那是母版的生成日志,副本要干净;故克隆 Sound 的 `genId=null`)。

**与两部宪法的关系**(好消息:基本零侵入):
- §15:用户永远在自有副本上编辑 → autosave / outbox / 规范化落表**零改动**,只多一个 `forkExampleProject` 事务 + 列表并集。
- §16:副本是普通项目,进去后 undo 原样工作,**不扩 7 项口径**(同 §23 paste 的结论)。两个**列表层**动作不入项目内 undo 栈:"fork 出副本"(idempotent,删副本可重生)、"dismiss 示例"(`ExampleDismissal`,给个弱"恢复"入口即可,v1 可不做恢复 UI)。

**边界 case**:① super admin 开自己标的示例 → owned,直接编母版,不 fork(规则:viewer≠owner 才 fork)。② 重复进入 → resume 同一副本。③ 删副本 = 普通硬删(自己的项目)。④ super admin 取消标记 / 删母版 → 已有副本是独立快照,不受影响;母版从他人列表消失;遗留 dismissal 行可忽略。⑤ super admin 改母版 → 旧副本不跟变(快照语义);"重置到最新"= v2。

**v1 不做**:跨用户协作/共享编辑;副本"重置到母版最新";dismiss 的恢复 UI;示例分类/排序/封面。示例靠并集天然对所有人可见,无需注册时给每人复制实体(省存储、母版可中心化更新)。

**落地顺序**:① schema(role/isExample/forkedFromExampleId/ExampleDismissal)+ `db push` + 重启 next + 提站长为 admin。② `lib/forkProject.ts` 深克隆(连库)。③ 后端:列表并集 + `PATCH isExample`(admin 网关)+ `POST :id/fork` + `POST :id/dismiss` + 项目页 fork 兜底。④ 前端:Workbench 示例角标 + 点击 fork + dismiss + admin ★Example 开关;`api.ts` 加 fork/dismiss + ApiProject 加 isExample/owned。⑤ 测:新用户见示例→进入生成副本→编辑落库→母版不变→重进 resume→dismiss 消失→admin 标记/取消。

## 26. Song XY 自动化(比例时间轴 + 内联自动化 lane)—— 🚧 实现中 · 2026-06-21 ·（🔁 v2:per-effect 多条 + 单一仲裁接管 · 🔁 v3:去激活开关,激活=线非平自动判定 · 2026-06-22）

把 §21 XY 表演板的"录手势/自动化"v2 落地,**仅 Song 模式**:用户在每个 session block 下**画直线断点**自动化 XY 的效果;Song 播到该块时一只"幽灵手"按位置驱动 XY,**手抓真 pad 即接管、松手恢复**。

> **🔁 v2 改版(2026-06-22,用户拍板)**:v1 是「per-session **单** `xyAuto`(一个 program)」,导致**顶栏点别的效果=替换当前那条**(复用同一组点 → 把 filter 斜线当 slicer 重画的怪台阶,filter 丢失)。v2 改成**一段挂最多 4 条独立自动化(每效果一条),同时发声**;连带把「§21 单 insert 可切」升级成「§21.v2 4 效果常驻链」、把「双驱动幽灵手/手动板」收敛成「单一 coordinator 仲裁接管」。**与 §21.v2、手动接管一并做**(都是 XY 引擎层,一次理清)。下文 26.2–26.5 已是 v2 目标态;旧阶段 ①②③(契约/回放/视图)已发但要按 v2 改。

> **🔁 v3 微调(2026-06-22,用户拍板)**:去掉「激活/失效」开关——4 效果**永远存在**(默认中性平直线,压在 0 线/中线上),**激活 = 自动判定**:某效果的 X 或 Y 线一旦「**多出点**」或「**点离开 0 线**」(非平)就算激活 → 回放驱动 + 在 block 上亮标识;拉回「**只有首尾两点、且都在 0 线**」= 未激活(从 `xyAuto` 移除)。顶栏原 4 个 toggle 键改成**右侧「4 选 1」单选**(配 X/Y + zoom 一排),只切「**整个 song 当前显示/编辑哪条 lane**」(选中=该效果色、其余灰);**session 上的单字母方块改纯标识**(显示该块已激活了哪些效果,不可点)。`XYAutomation` 去 `on` 字段;`xyAuto` map **只存非平(激活)的效果**。下文 26.2/26.3/26.7 已按 v3 写。

### 26.1 先决:§20 Song 视图改成"按比例 arrange 时间轴"(用户拍板 2026-06-21)

现状 §20 的 sstrip 是"定宽 scard-in + N 个定宽 rcell",显示宽度 ≠ 真实时长 → 自动化无处画(格子太短、长度悬殊却同宽)。改造(纯**视图**层,引擎早已按绝对小节 `enterSongBlock(startBar,endBar=bars×reps)` 播,时序无需动):

- **全连续 + 按比例**:所有 block 首尾相接;`block 宽 = bars × reps × pxPerBar`。
- **一个 block 一整段**:不再画 N 张重复卡,块内用**竖刻度线**标每遍 loop 边界(`reps-1` 条)+ 可选每 bar 细线。repeat 增减 = 拖右缘 / ± 按钮(沿用现有)。
- **zoom(`pxPerBar`)+ 横滚**:解决长度悬殊(拉大编辑、拉小总览);极短段给最小宽兜底。播放头 `SessionPlayhead`(live.tsx)改用 `pxPerBar` 定位。
- **标签/工具**:名字块内截断;复制/删除/repeat 移到 hover 浮出 / 选中块工具条。拖拽重排几何按比例段适配。

### 26.2 数据模型 v2(§15:JSON 逃生口,挂 Session)—— per-effect 最多 4 条,互不耦合

`Session.xyAuto: XYAutoSet | null`(null=无任何激活的自动化,时间轴干净)。
```ts
type AutoPoint = { bar: number; v: number };               // bar=块内偏移 0..bars×reps(跨全部 reps);v∈0..1
interface XYAutomation { x: AutoPoint[]; y: AutoPoint[]; }  // §26.v3 去 on;program 由 map 键给,不存值里
type XYAutoSet = Partial<Record<XYProgram, XYAutomation>>;  // 每效果一条,最多 4(filter/slicer/delay/brake),各自独立
```
- **每效果一条独立 automation**(各自 x/y),**互不覆盖**——这正是修掉「点 slicer 替换 filter」的根:v1 单 `xyAuto` 共享一组点,v2 按 program 分键。
- **§26.v3 激活 = 自动判定,无 `on` 字段**:某效果「激活」⇔ 它的 X 或 Y 线**非平**(`isActiveAuto`:点数 ≠ 2、或任一点 v ≠ NEUTRAL)。`xyAuto` map **只存非平的效果**;一条线被拉回「首尾两点、都在 0 线」即从 map 移除(回未激活)。所以 `program in xyAuto` ⟺ 激活——回放驱动、block 标识、coordinator 都看 map presence(热路径不重算 isActiveAuto;`changeXyAuto`/`normalizeXyAuto` 这两个入口守「只进非平」)。
- **bar 锚定**(非归一 t):点按 bar 偏移,改 repeat 只延长/截断该段、**不拉伸**;**跟着 session 走**(重排/复制免疫)。直线插值 + 端点 hold。
- **离散参数台阶**:`slicer/delay` 的 X(rate 四档)零阶保持(step);`filter/brake` 的 X 与所有 Y 线性。纯逻辑 `studio/xyAutomation.ts` 的 `sampleAuto/sampleXY` **签名:program 作入参传入**(不读 `auto.program`)。
- **中性默认**:4 效果**永远存在**,默认 = 中性平直线(filter x=0.5 全开;X/Y 都压 0.5 中线;见 NEUTRAL),压在 bypass 参考线上、不改音色、不算激活(不入 map)。
- **迁移**:DB/内存里的老形状 `{program,on,x,y}` / `{[p]:{on,x,y}}` → load 归一成 `{[p]:{x,y}}`,并**丢弃平直线条目**(老 `on` 不再有意义:非平=激活、平=未激活)。`normalizeXyAuto` 守一道,脏点逐元素清洗。

### 26.3 插入/编辑交互 v3(画线即激活,顶栏 4 选 1 只切显示)

- **无激活开关**:不再点按钮激活/失效。4 效果永远在,默认中性平直线;**在 lane 上画(令其非平)即激活**(进 `xyAuto` map + 亮标识),**拉平(删到首尾两点、都回 0 线)即失效**(出 map + 标识消失)。
- **顶栏右侧「4 选 1」单选(配 X/Y + zoom 一排)**:`Filter/Slicer/Delay/Brake` 单选,只切「**整个 song 当前显示/编辑哪条效果的 lane**」(不带「显示」文案)。选中 = 该效果色填充,其余 = 灰(未选)。不负责激活。
- **lane 一次只显示一条**(顶栏选中的 program),选中块永远可画(没触碰过=中性平直线照样能编辑);X/Y 切轴只为编辑方便。
- **session 标题栏单字母方块 = 纯标识(不可点)**:该 block 已激活(线非平)的效果各显一个单字母色块,只表「这块挂了哪些效果」。选哪条编辑去顶栏 4 选 1。
- 画:**双击空白加断点**(X 吸拍线)、**拖动移点**、**双击节点删点**;离散参数(slicer/delay X)画台阶。
- 失效 = 把该条拉平(无独立删除键);`changeXyAuto` 检测到平直线即从 map 删该键,全空 → `xyAuto=null`。

### 26.4 回放 + 手动接管 v2 —— 单一仲裁 coordinator(同时吃 §21 手动 + §26 自动化 + 接管)

**问题根**(v1):回放 rAF 与手动板**各自直调引擎瞬态接口**(`xyMove/xyEngage`),抢同一 insert → 双驱动每帧喂不同值 → 一干一湿、手动接管不了。

**v2:全引擎驱动收敛到唯一一处**——一个 coordinator rAF 独占,**逐效果(per-effect)仲裁**:
- 手动板**退化成纯输入**:只把当前手势写进 ref `{down, program, x, y}`(不再直调引擎;它的 spring 只管圆点视觉)。
- coordinator 每帧,对**每个效果**算目标态:
  1. `manual.down && manual.program===该效果` → **手动**驱动(x/y + active);
  2. 否则 Song 播放中 && 该效果在当前块的 `xyAuto` map 里(`set[effect]` 存在=非平=激活,§26.v3) → **自动化**驱动(`sampleXY(effect, set[effect], 块内bar)`);
  3. 否则 → **旁路**(inactive)。
- **优先级 手动 > 自动化 > 旁路,且逐效果独立**:手动接管 filter 时,delay/slicer 的自动化**继续跑**(这是 4 效果同开的关键)。
- **交还滑行(合并 §21 spring 回中 + §26 自动化恢复 = 同一机制)**:手动松开某效果 → springMs 内把该效果值从手位**滑回它的「地面」**(有自动化→自动线当前值;无→NEUTRAL 然后旁路),滑完 settle。`latch`=粘住不滑。
- coordinator 把每效果的目标下达给引擎:`xy.setXY(effect, x, y)` + `xy.setActive(effect, on)`(15ms rampTo,帧粒度够)。
- pad 上 `AUTO/MANUAL` 角标按「当前选中效果」的来源显;没手按时圆点跟自动化(只读 ghost)。
- **状态边界**:停 Song / 切出 / 卸载 / undo → coordinator 令所有效果 release 回旁路 + `setFx` 还原(不变式同 §18 solo / §21 release,避免卡 wet)。

### 26.5 持久化(§15)/ undo(§16)—— 机制不变,值从单对象变 map

- `Session.xyAuto Json?` 列**已加(2026-06-22 单形状版已落地+真机验)**;v2 只是存的形状从 `XYAutomation` 变 `XYAutoSet`(map)。sync(`NSession.xyAuto`/`SESS_FIELDS`,`eq` 按 JSON 比→改即存)、`/api/studio` GET/ops(`sessData`,null 写 `Prisma.DbNull`)**已就位、无需再动**;load 加一道「老单形状→map」归一即可。
- **在 sessions 树里 → 天然进快照口径①**:画点/插入/移除/toggle 走 `pushHistory`+`patchSession`(不可变),自动可撤。**coordinator 实时驱动=瞬态**(直驱引擎),不进 undo/不落库。

### 26.6 落地顺序 v1(已发 ①②③⑤;④及单 program 模型被 v2 取代)

① 契约 + 纯模块 `xyAutomation.ts`(+单测)✅。② 回放幽灵手(rAF→xyMove/engage)✅。③ 比例时间轴视图(§26.1)+ 内联 lane 编辑器(§26.3)✅。⑤ 持久化(单形状)✅。④ 手动接管 ❌(从未做,直接进 v2)。同期还做了 session block 改版 + per-session 色 + 标题栏色点/automation chip + 键盘删复(见 [[song-xy-automation]] 记忆)。

### 26.7 落地顺序 v2(per-effect + coordinator + §21.v2 引擎链 —— 一并做,每步 typecheck)

① **契约**:`XYAutomation` 去 `program`、`Session.xyAuto: XYAutoSet`;`xyAutomation.ts` 的 `sampleAuto/sampleXY` 改 program 入参;单测更新。② **引擎 §21.v2**:`XYPad` 改 4 效果常驻链 + per-effect `active`/旁路 + `setXY(effect,x,y)`/`setActive(effect,on)`;去全局 WET。③ **coordinator**:一个 rAF 替换现回放 effect + 手动板退化成 `{down,program,x,y}` ref;per-effect 仲裁(手动>自动化>旁路)+ 交还滑行(合并 spring/恢复)。④ **UI**:顶栏/标题栏 chip 改 per-effect(点=新增/切到、不替换),lane 切到选中效果编辑,移除单条;`AUTO/MANUAL` 角标。⑤ **持久化**:存 `XYAutoSet` + load 老形状→map 归一(sync/api 已就位)。⑥ **测**:filter+delay 两条共存 → 播放两个都动 → 手抓 filter 接管(delay 继续跑)→ 松手 filter 交还滑回 → 改 repeat 截断 → 刷新 resume → undo。

### 26.8 落地顺序 v3(去激活开关 + 自动判定 + 4 选 1 显示器 —— 一并做,每步 typecheck)

①②③④⑤⑥(v2)已发 + 真机验。v3 在其上做减法:① **契约**:`XYAutomation` 去 `on`(`{x,y}`)。② **纯模块**:`defaultAutomation` 去 `on` 参;新增 `isActiveAuto(program,auto)`(非平判定);`normalizeXyAuto` 去 `on`、丢平直线条目;单测改。③ **顶栏**:删左侧 toggle 组 + `toggleXyProgram`/`insertXyAuto`;右侧加「4 选 1」单选(`setAutoProgram`,选中带色)与 X/Y、zoom 同排。④ **判定接线**:`changeXyAuto` 非平才入 map、平则删键(=激活/失效);coordinator + 起播 prime 看 map presence(去 `.on`);标题栏方块改纯标识(`<span>` 不可点、`PROG_ORDER.filter(p=>autoSet[p])`、字母实黑 uniform)。⑤ **测**:画线→标识亮+回放驱动;拉平→标识灭+旁路;切 4 选 1 换 lane;undo/刷新 resume。

### 26.9 时间轴导航 v4 —— 滚轮平移 / Alt 缩放 / 全局 bar 标尺(播放头延伸 + 引导线 + 喇叭跳播)· 🚧 设计 2026-06-22

**一句话**:给 §26.1 的比例时间轴补三件导航料 —— ① 滚轮左右平移、② Alt+滚轮以光标为支点缩放(`songZoom`)、③ block 排**上方加一条全局 bar 标尺**:标 bar 号、播放头**向上延伸穿过标尺**、hover 出**按 bar 吸附的引导线** + **喇叭光标**、**点哪个 bar 就从该 bar 所在的 repeat 起播**。①② 直接照搬 `CollageEditor` 已验证的滚轮/缩放;③ 复用 `enterSongBlock` + `setTransportPosition`,**不新增引擎 API**。

**布局重构(命门)**:现状 Song 轴 = `HScroll` 包 `.srail.song`(一排 `.sblock`);播放头 `SessionPlayhead` 在**每块内部**绝对定位,块 `overflow:hidden` 且标尺在块**上方** → 块内播放头**够不到标尺**。故把 song 模式的滚动容器换成 song 专用 wrapper(扩 `HScroll` 或新建 `SongTimeline`),scroll 内容里建一个 `position:relative`、`width=total×songZoom` 的列容器:
```
.lane-scroll (scrollRef, overflow-x:auto)
  .song-content (relative, width = totalBars*songZoom)
    .song-ruler   ← 全宽标尺(第一行,随内容横滚)
    .srail.song   ← 现有 block 排(原样作 children 塞入,flex order 拖拽不变)
    .song-ph      ← 列级单条播放头(绝对,整列高,穿标尺+块)
    .song-guide   ← hover 引导线(绝对,整列高)
```
`total = Σ sessionBars(i)×sessionRepeats(i)`;`cumBars[i] = Σ_{j<i}(...)`(数组序 = 视觉序,除拖拽预览的瞬间)。标尺/播放头/引导线全用 `cumBars` 算 → 与块内刻度对齐(`.sblock` 的 `margin-right:-1px` 边框折叠只是亚像素装饰,不参与 bar 定位)。

**26.9.1 滚轮平移 + Alt 缩放(照搬 `CollageEditor`)**:scroll 容器挂**非 passive** `wheel`:
- 无 Alt:`scrollLeft += |deltaX|>|deltaY| ? deltaX : deltaY`(竖滚轮也横移;触控板横扫本就原生可用)。
- Alt:`preventDefault` → `contentBar=(scrollLeft+cx)/songZoom` → `setSongZoom(clamp(songZoom*exp(-deltaY*0.0015), 10, 72))` → 用 `zoomApply` ref 在 `useEffect([songZoom])` 把 `scrollLeft` 回正到 `contentBar*songZoom - cx`(光标钉住那一 bar)。
- `songZoom` 仍 own 在 StudioApp(标尺/块/lane/播放头都读它),容器只收 `zoom`+`setZoom`+`zoomApply` 逻辑。顶栏 range 滑块保留、min/max 同步放宽到 10–72。

**26.9.2 全局 bar 标尺**:`.song-ruler` 宽 `total×songZoom`,内容:每 bar 细刻度(repeating-linear-gradient,同 collage lane)、每块边界 `cumBars[i]×songZoom` 处粗线、bar 号按缩放疏密显示(zoom 足够每 bar、否则每 2/4 bar;号 = 全局 1-based)。

**26.9.3 播放头延伸**:song 模式**废掉块内 `SessionPlayhead`**(live 模式保留),改列级单条自驱动 rAF 线(新 `SongPlayhead` 或扩 live.tsx):`left = (cumBars[playingIdx] + (songPosBars() − songBlockStart))×songZoom`,高度铺满标尺+块。减 `songBlockStart` 是为了 `loopSong` 循环后 `songPosBars` 无限增长仍定位正确(等价现块内 `rel=pos−startBar`,只是抬到列级)。块内「已播色块 fill」(`.ph`)song 模式默认去掉(单线即够;要保再说)。

**26.9.4 hover 引导线 + 喇叭光标**:`.song-ruler` `pointermove` → `bar=clamp(floor((scrollLeft+cx)/songZoom),0,total-1)` → `.song-guide` `left=bar×songZoom`(整列高、虚线、瞬态直改 DOM 不进 state);`pointerleave` 隐藏。标尺 `cursor: url("data:image/svg+xml,…喇叭…") hx hy, pointer`(喇叭 SVG 内联 data-URI 带热点;表「点此从这里放」)。

**26.9.5 点击跳播(从该 bar 所在 repeat 起)**:`.song-ruler` `click` → `B=floor((scrollLeft+cx)/songZoom)` → 映射 + 起播,**全复用现有机器**:
1. `bi` = 最后一个 `cumBars[i] ≤ B`(`B≥total` 夹到末块);`local=B−cumBars[bi]`;`rep=clamp(floor(local/bars_bi), 0, reps_bi−1)`;`repStart=cumBars[bi]+rep×bars_bi`。
2. 在播 → 先停(干净);`sessionIdx=playingIdx=bi`、`viewFollows=true`;`loadSession(块 bi)`;automation prime 在 `localBar=rep×bars_bi`(不是 0)。
3. `setTransportPosition('${repStart}:0:0')` → `startTransport()`(voice 当下相位 0 fire,干净)→ `enterSongBlock(块.id, cumBars[bi])`。末推进排在 `cumBars[bi]+reps×bars`(块**真正**末尾)→ 从第 rep 遍起、播完剩余遍再进下一块;播放头 `rel=songPos−songBlockStart=rep×bars` 正好落第 rep 遍。✅(决策:播放中点标尺 = 停+从该 repeat 重起,可预测;中途无缝跳块留后续。)

**26.9.5b 主 Play 按钮 = 从头(block 0)起播**:Song 模式下 `startPlayback` 永远从**第一个 block**(`startIdx=0`)起,不再从「当前选中/查看块」起——因为播放中视图跟随(`viewFollows`)会把 `sessionIdx` 带到停下时那块,否则「停→播」会从那块续播而非从头。起播时把 `sessionIdx`/`playingIdx` 一并归 0(视图也回头块)。「从某处起播」只走 26.9.5 的点标尺(`startPlayFromBar`)。Live 模式不变(从选中场景起)。

**26.9.6 §15/§16 合规**:`songZoom`/`scrollLeft`/hover 引导 = **纯瞬态**(不落库、不进 undo);跳播 = **播放态**(同起播,不进 undo)。引擎、contracts、持久化、undo 口径**全不动**。

**26.9.7 落地顺序(每步 typecheck)**:① `HScroll`→song 容器:`wheel` 平移/Alt 缩放 + `zoomApply` 回正 + `.song-content` 列 + `.song-ruler`。② 列级 `SongPlayhead`(替 song 模式块内 head),`cumBars[playingIdx]` 透传。③ `cumBars`/`total` helper + 标尺 bar 号/刻度/块边界。④ hover 引导线 + 喇叭 cursor。⑤ `startPlayFromBar(B)`:映射 + 复用 `loadSession`/`setTransportPosition`/`startTransport`/`enterSongBlock`(prime 在 `rep×bars`)。⑥ CSS:`.song-ruler/.song-guide/喇叭 cursor/列级 .sphead`。⑦ 测:滚轮平移、Alt 缩放光标钉住、标尺 bar 号对齐块刻度、播放头穿到标尺、hover 出引导线+喇叭、点 bar 从该 repeat 起播(含末块/循环/正在播时点)、改 zoom/repeat 后仍对齐。

### 26.10 automation UI 可见性 toggle + 模式/可见性持久化 · 2026-06-22

**toggle(Song 顶栏,zoom **左**侧,大小同 X/Y seg=20px 高)**:`showAutomation` 开关。控制「automation 相关 UI」整组显隐——开=全显,关=收起:① 顶栏 4 选 1 + X/Y(`{showAutomation && …}`);② 每个 block 的 `.sblock-auto` lane;③ block 标题的 F/S/D/B 单字母标识。block 因 lane 去留而自适应高度。toggle 本身、zoom、标尺、播放头、repeat、名字/色块**始终在**。

> ⚠ **纯 UI 层隐藏**:`xyAuto` 数据、coordinator、起播 prime、引擎**全不碰** → 隐藏时效果照常回放,只是看不见。仅在渲染处加 `showAutomation &&` 门。

**持久化(Project 列,仿 `loopSong`:乐观落库、**不进 undo**)**:
- `Project.playMode String @default("live")`(live | song)——`changePlayMode` 时 `api.projects.update(projectId,{playMode})`。
- `Project.showAutomation Boolean @default(true)`——toggle 时 `api.projects.update(projectId,{showAutomation})`。
- 接线:schema 加两列(`db push` 后**重启 next**,见 [[prisma-stale-client-restart]])→ `ApiProject` + PATCH 白名单加这两键 → `page.tsx` 透传给 `StudioApp`(`propPlayMode`/`propShowAutomation`)→ 两个 `useState` 用 prop 初始化。GET 整 project 直传,自动带上。Live 模式无 automation UI,toggle 只在 Song 顶栏出现。

### 26.11 block 激活乐器计数徽章(数字条左下 + hover 名单)· 🚧 设计 2026-06-23

**一句话**:Song 模式每个 `.sblock` 的数字条(`.sblk-nums`)左下角钉一枚**纯数字胶囊** = 该 session **激活(`enabled`)乐器数**;hover 出 portal 浮层,列出激活乐器名 + 各自色块。一眼看清「这块在响几件、哪几件」,不用进去逐 pad 数。

- **口径 = `enabled`,不是 solo**:激活 ⇔ `Instrument.enabled`(= pad 亮/在播判定,`st-playing`/`TransportIcon stop`)。徽章数 = `s.instruments.filter(i=>i.enabled).length`。**solo 不计**(瞬态、不落库、不进 undo,见 §18);徽章反映**编排态**而非当下隔离听感。helper `activeInstruments(s)` 给计数 + 名单共用(`contracts/instrument.ts`)。
- **只渲一次 = 落 repeat 1**:数字条整块只画一枚徽章,绝对定位 `left:4`(钉最左 = 天然落第一个 repeat 段),**不按段宽定位** → `songZoom` 拉到最窄(10px/bar)也不挤没。竖向落 `bottom:5`,叠在序号「1」(`top:4`)下方,与右侧选中态 +/− (18px)、repeat 序号、tick 线均不撞。
- **靠胶囊形区分序号**:纯数字 + 1px 边框胶囊(`color-mix(var(--c) …)` 暖色体系,同 `.sblk-achip`/`.sblk-bars`),与裸文字的 `.sblk-rn` repeat 序号一眼分开。不加图标(用户拍板:图标太重)。0 激活 = 胶囊变暗(`.zero{opacity:.5}`)不隐藏,栏位稳定。
- **hover 必走 portal**:`.sblk-nums`/`.sblock` 都 `overflow:hidden`,内联浮层会被裁 → 复用 `InstrumentColorDot` 那套 `createPortal`→body + 测锚点 rect 上/下自适应 + scroll/resize 跟随 + Esc 关(`zIndex:260`)。`onMouseEnter` ~120ms 开、`onMouseLeave` ~80ms 关(防抖)。内容:头 `Active · N / 总数`,每行 9px 色块(`instrument.color`)+ `label`;多于 ~8 件给 `max-height` 滚动;0 激活显「No active instruments」。`.sblk-rn` 是 `pointer-events:none`,徽章须显式 `pointer-events:auto` 才接 hover。a11y:徽章带 `aria-label`(激活名单)。点击不拦截,冒泡到块 `onClick→switchSession`(点块=选 session,无副作用)。
- **§15/§16 合规**:**纯只读派生视图** —— 无新列、无新状态(`toggleInst` 已 `mutate+setTick`,开关乐器徽章自动重算)、**不进 undo**、引擎/contracts/持久化全不动。仅 Song 模式;Live 的 `.scard` 维持现「N inst」(总数)不动。
- **落地顺序(每步 typecheck)**:① `activeInstruments` helper + 单测(可选)。② `SongInstrumentCount` 子组件(胶囊 + portal hover,复刻 color dot 定位)塞进 `.sblk-nums`。③ `.sblk-icount` CSS。④ 测:开关乐器数字变、hover 出名单且不被块裁、窄 zoom 不挤没、0 激活变暗、选中/未选中两态、不干扰拖拽换位与 +/−。

## 27. 本地样本上传(web ingest:wav/mp3 → 检测 → 入库)—— 🚧 设计 · 2026-06-21

**一句话**:库里除了 Suno 生成,允许用户**直接上传 wav/mp3**;上传成功后**先一次性检测速度(BPM)+ 调式(key)**,再落进同一个用户库,卡片样式与生成稍作区别(`⬆` 角标 + 文件名 + `Upload › Detect › Done` 文案;**全走系统暖色,不另起色相**)。这是 §19.3「统一 ingest」的 **web 上传臂**先落地(desktop 选夹臂复用同一管线,后置)。

### 27.0 复用现状(只补两块新料)
入库脊梁已就绪:`putAudioAsset`([`lib/storage.ts`](web/src/lib/storage.ts),sha256 去重、源无关)、`POST /api/sounds`(吃 `{sourceBpm,key,analysis,warp,…}` 建 Sound)、生成卡 UI([`LoopManager.tsx:166-209`](web/src/studio/ui/LoopManager.tsx),busy/failed/complete 三态全由 `Gen.status` 驱动)、管线形状 [`runGeneration`](web/src/studio/studioGens.ts) 本就是 `拿字节 → decodeAudioData → 分析 → api.sounds.create`。上传只在「字节从哪来」「靠什么填 BPM/调」两处不同。

### 27.1 ⚠️ 命门:`detectLoop` 需要 BPM 锚,上传没有
[`detectLoop`](web/src/audio/conditioning.ts) 的算法是**「输入 BPM 是母」** —— 锚定已知 BPM 定 N 小节,自相关只在 ±12% 窄窗里算**置信度**,**不从零估速**。生成时 BPM 是用户填的;**上传没有这个锚**。且**全仓没有任何调式检测**。所以上传必须新增一个**纯客户端检测模块**(决策:客户端 DSP,不上 sidecar —— 对齐 §19.3「解码/分析留客户端」、不引服务依赖;精度够用,错了有 ClipEditor 兜底改):

- **`web/src/audio/detect.ts`(纯函数,仿 conditioning.ts)**:
  - `estimateTempo(channels, sampleRate): { bpm, confidence }` —— 复用 `novelty()` 包络(从 conditioning.ts 导出),在 ~70–180 BPM 对应的 lag 区间做**宽域自相关**找峰 + 抛物线插值;**倍频消歧**(优先 80–160 主带,比对半速/倍速峰强)。这是上传唯一从零估速的地方。
  - `estimateKey(channels, sampleRate): { key: MusicalKey|null, confidence }` —— 12 维 **chroma**(Goertzel 逐音级 / FFT bin→音级累加)对 **Krumhansl–Schmuckler** 大/小调模板做 24 次旋转相关,取最优 → `MusicalKey`('C' / 'Am')。~80 行,**零新依赖**。
- **接力既有机制**:估出 `bpm` 后**喂回** `detectLoop(channels, sr, bpm)` 拿 bars/loop 区/onsets/confidence。**默认 warp 种子 = 整段**(`startSample…endSample` 全长、`bars=analysis.bars`)—— 落地即「包裹整段音乐」,用户进 ClipEditor 再裁,**不按生成/上传猜该截 2/4 小节**(生成 loop 本就短,整段≈短 loop;长素材才真整段,故同一条路统一处理)。即检测=「新估速估调 → 复用全部既有 conditioning」。
- **检测只看头部一个段落**(`ANALYZE_SECONDS=30`,从 conditioning 导出,单一来源):`estimateTempo`/`detectLoop` 的 novelty·自相关·瞬态、`estimateKey` 的 chroma 一律截到前 30s,长素材不全量扫(整段时长/小节数仍按全长算 —— 纯算术,不吃这刀)。

### 27.2 状态机:复用 `Gen` 当通用 ingest job(加一列 `source`)
一次上传 = 一条 `Gen` 行(`source:'upload'`、`prompt`=文件名、`bpm/musicalKey` 检测前留空)。状态流 `uploading → detecting → complete`(平行于生成的 `generating → streaming → complete`),失败 → `failed` 带重试/删除。**白拿**整套状态卡 UI、软删、undo 口径。库列表保持同质(gen 卡 + 其下变体)。

- **数据模型增量(§15.A:列)**:`Gen` 加 `source String @default("suno") // suno | upload`([schema.prisma:110](web/prisma/schema.prisma))。其余 Suno 专属列(`sunoClipIds/sunoBatchId/instrumental`)上传留 null。Sound 模型**不动**(`sourceBpm/musicalKey/analysis/warp/assetId` 全够用)。`db push` 后**重启 next**(否则 Prisma client 旧、ops 报 Unknown arg)。

### 27.3 传输:multipart `POST /api/uploads`(决策:不用 audioB64)
WAV 可达数十 MB,base64 over JSON 膨胀 ~33% 不划算 → 新端点收 `multipart/form-data`:`getCurrentUser` 鉴权 → 校验 mime(`audio/wav|audio/x-wav|audio/mpeg`)+ 体积上限(~50MB)→ `putAudioAsset(buf,{kind:'source',contentType})` → 回 `{ assetId, contentType, bytes }`。**「uploading」态 = 这趟字节传输**。配套:`POST /api/sounds` 增收 `assetId`(给了就跳过 `putAudioAsset`,直接引用),取代生成路径的 `audioB64`。

### 27.4 抽 `ingestAudio` + `uploadToLibrary`(§19.3 的收口)
抽客户端 `ingestAudio(bytes, meta)` = 解码 + 检测 + 落库(Suno/上传/desktop 三源共用,§19.3 早点名)。新增 [`studioGens.ts`] 旁的 `uploadToLibrary(projectId, file, h)`,镜像 `generateToLibrary`:
1. `api.gens.create({ source:'upload', mode, prompt:file.name, bpm:0, status:'uploading' })` → `h.appear` 立刻出卡(uploading)。
2. `file.arrayBuffer()` → 同一 buffer 双路:① multipart `POST /api/uploads` → `assetId`;② 本地 `decodeAudioData`(检测要)。
3. patch Gen `detecting` → `estimateTempo`+`estimateKey`+`detectLoop`+warp 种子。
4. `api.sounds.create({ assetId, genId, sourceBpm:估速, key:估调, analysis, warp, … })` → patch Gen `complete` → `reload`。
5. 任一步抛错 → Gen `failed` + `conciseError`;失败可重试(字节已在 Asset,重试 = 纯重跑检测,不必重传)。
- **mode 标签**:按时长自动给个卡片标签 —— 短(≲ 20s)→ `sound`、长 → `advanced` —— **仅作展示**,**不再据此截短 warp**(默认一律整段,见 27.1)。one-shot vs loop 的切片触发是 §22 采样器的活。

### 27.5 UI:和生成稍作区别
- **入口**:生成窗口(`gen-body`)底部加 `⬆ Upload` 按钮 + 拖放区(`<input type=file accept=".wav,.mp3,audio/*" multiple>` / drag-drop;多选 = 逐文件各起一条 upload job)。
- **卡片(⚠️ 不引入新色相 —— 全用既有暖色 token)**:`gc-prompt` 显示文件名 + `⬆` 角标(`--tx-2` 中性)区别生成;参数行检测前显 `Detecting…`,完成后回填 `BPM · Key`。busy 阶段条按 `source` 切文案:`Upload › Detect › Done`(对 `Generate › Render › Done`),**进度态沿用既有琥珀 `--queue`**(同生成 in-progress:`gdot.uploading/detecting`、阶段条高亮都走 `--queue`,不另起色);`GEN_PHASES`/`GEN_ORDER` 做 source 变体。上传按钮(Library 标题条右侧、`margin-left:auto`)走 `.gb-btn` 中性语汇(`--tx-2` + `--line-2`,hover `--acc`)。**早期试过冷蓝 `--up` 被否**(`#5b93c4` 与整套暖土陶/琥珀调系冲突)→ 区别只靠 ⬆ 角标 + 文件名 + 文案,不靠色相。细控件用私有类名(`up-*`),避开历史 `.led/.sel/.on` 撞名坑(见 §4.1)。

### 27.6 持久化(§15)/ undo(§16)合规
- §15:`source` 规范化落列;其余走生成同款乐观 appear + 后台 patch + `reload`,**零新机制**。
- §16:上传产物落在既有 gens/sounds **库存活集(口径⑦)**,软删可撤 —— **不扩 7 项口径**(同 §23/§25 结论)。瞬态 `uploading/detecting` **不入 history**(镜像生成,生成也不把中途态推栈)。

### 27.7 落地顺序(每步 typecheck)
① schema 加 `Gen.source` + `db push` + 重启 next;`/api/sounds` 增收 `assetId`;新建 `POST /api/uploads`(multipart)。② `audio/detect.ts`(estimateTempo/estimateKey + 单测几条已知 BPM/调的样本)+ 从 conditioning 导出 `novelty`。③ 抽 `ingestAudio` + `uploadToLibrary`(+ `api.ts` 加 `uploads` 客户端、`ApiGen` 加 `source`)。④ UI:Upload 按钮(Library 标题条右侧)+ 上传卡 ⬆ 角标(暖色系、不另起色相)+ 阶段条 source 变体 + 失败重试。⑤ 测:拖 wav/mp3 → 见 uploading→detecting→入库 → BPM/调合理 → ClipEditor 可改 → 软删/undo → 刷新 resume → 错类型/超大被挡。

## 28. Clip 波形「起播刻度 + 设起止」(ClipEditor 内)—— 🚧 设计 · 2026-06-21

**一句话**:在 [`WarpCanvas`](web/src/studio/ui/WarpEditor.tsx) 波形上加一条**跟手、吸网格的起播线**:鼠标在 trim 内移动 → 出一条对齐网格的竖线(指明"下次从哪起播");**点波形 = 从这条线起播**(不再从头);**trim 外无线、不可播**;**右键 = 设为开始 / 设为结束**。复用既有 trim 提交链路(落库 + undo),引擎只加一个起播偏移。

### 28.1 起播线(hover,网格吸附,仅 trim 内)
`onMove`(非拖动时)按 `snapGrid(ob)`(既有,原点=trimStart、粒度=当前网格)算吸附位,**仅当落在 [trimStart, trimEnd) 内**才显示一条 `.we-hover` 竖线(直接改 DOM `left`/`display`,瞬态、不进 React state、不落库);出 trim / `onPointerLeave` → 隐藏。与播放线 `.we-playhead` 并存(前者=将从哪起,后者=正放到哪)。

### 28.2 从线起播(引擎加 startSec 偏移)
- **引擎**:[`StudioEngine.audition`](web/src/audio/studioEngine.ts:514) 加尾参 `startSec=0` → `p.start(t, off)` + `auditionStart = t - off`(播放线相位天然带上初始偏移,自由/量化都对)。off 夹 `[0, dur-1e-3]` 防越界。**loop 区不变**(整段),线只是入点:从线放到尾,再回头循环整段(= entry-offset,非"只循环线→尾")。
- **透传**:`ClipPreview.toggle(startPhase?)` + `WarpCanvas.onPreviewToggle(region, startPhase?)`。**点波形身体** → `onUp` 带 `startPhase=(snapOb-trimStart)/loopLen` → host 从该相位**起播/重起**;**▶ 按钮**(无 startPhase)= 从头播 / 停 的开关。host:`auditionSound`/`previewCollagePiece` 把 `startPhase*buf.duration` 喂给 `audition`。
- **同线再点=停**(用户要求):`activeStartRef` 记当前预览从哪条起播线起(▶ 从头=null);点波形若 `previewing && |sp-activeStartRef|<1e-4` → 发**无 startPhase** 的 `onPreviewToggle(region)`(host 当 toggle 关),否则从 sp 重起;`previewing→false` 的 effect 清 `activeStartRef`。
- **菜单开着冻结起播线**(用户要求):scrim 上的 pointermove 仍冒泡到 stage,故 `onMove` 开头 `if(menu)return` → 起播线停在右键点(= set 起止的落点),不再跟手。
- **范围(三处 ClipEditor 全覆盖)**:库预调 `auditionSound`、**单 sample 乐器** `previewInst`→`previewInstrument`、**chop/collage 片** `previewCollagePiece` —— 三者都是 `audition`(`previewInstrument` 也是抓乐器 voice 的 buffer 走 audition,580 行),全部透传 `startPhase*buf.duration` 偏移。**前提**(既有设计):乐器 clip 预览**只在总走带停**时可用(`canPreview={!playing}`,走带一跑就禁预览)→ 走 audition 的非量化路,偏移天然生效。⚠ 早期版误把单 sample 当 live voice 排除,实为 audition,已补齐(2026-06-21 用户指出)。

### 28.3 trim 外:无线、不可播
`onDown` 的身体分支:仅当 `snapGrid(ob)∈[trimStart,trimEnd)` 才设 `clickCand{startPhase}`;否则 `clickCand=null` → `onUp` 不触发预览。波形拖出(drag→pad/轨)走原生 dragstart,与此无关、照常。

### 28.4 右键:设为开始 / 设为结束
`onContextMenu`(`preventDefault`)在光标处开一个 `.we-menu`(scrim 接外点关闭):
- **Set as start** → **整体平移**(起点=snapOb,终点跟过去 `snapOb + loopLen`、保 loop 长,**同拖起始线**);故**可越过原终点**(终点跟着走,不夹)。(2026-06-21 用户更正:不是独立移起点。)
- **Set as end** → `setTrimEndBar(max(trimStart+gridBars, min(snapOb, maxBars 上限)))` + 夹 fade(同既有 trimEnd 拖拽)—— **不能落在起点之前**(夹到 `start+gridBars`;与"设起点可越过终点"不对称,正是因为终点会跟起点走)。
- 两者只改 `trimStart/EndBar` state → 既有防抖 `useEffect`([:561](web/src/studio/ui/WarpEditor.tsx:561),deps 含 trimStart/EndBar)**自动 emit `onChange`** → host 落库 + 进 undo,**零新提交链路**。菜单文案随 app 用英文。

### 28.5 §15/§16 合规
起播线 / 起播偏移 = **纯瞬态**(直连 DOM/引擎,不落库、不进 undo)。设起止 = 走既有 `onChange`(库预调落 `Sound.warp`、乐器 clip 走 doc/undo),**口径不扩**(同拖 trim)。

### 28.6 落地顺序
① 引擎 `audition` 加 `startSec`(2 处:量化/即时)。② `WarpCanvas`:hover 线 + 网格吸附 + trim 内门控 + `clickCand.startPhase` + `onContextMenu` 菜单 + 设起止。③ `ClipPreview.toggle(startPhase?)` 透传 + 3 个 host adapter + `auditionSound`/`previewCollagePiece` 喂偏移。④ CSS:`.we-hover`/`.we-menu`。⑤ 测:trim 内出线吸格 → 点波形从线起播 → trim 外无线不播 → 右键设起止落库可 undo → ▶ 仍从头/停。

### 28.7 异步预览防陈旧(generation guard)—— 不变量 · 2026-06-23
**问题**:库预调 `auditionSound` / 片预览 `previewCollagePiece` 真正出声前要 `await en.resume()` + `await warpToBuffer(...)`(未命中缓存时是网络/CPU,几百 ms~数秒);而引擎的 `auditionId`/player 要等 `audition()` 真跑了才写。这个 await 窗口里引擎状态滞后,导致**任何"停止"指令(空格 [510](web/src/studio/StudioApp.tsx)、点别处 `stopAudition`、toggle)被迟到的 `audition()` 反悔 → 表现为"停不下来";连点两个 sample → 后解析者赢,UI 高亮(`libSel`)与实际出声 id 错位 → "两个都停不下来";窗口内按空格 `auditionId==null` 还会误启走带。**
**口径(不变量)**:异步预览**起播前(任何 await 之前)取一个单调令牌**,await 解析后**出声前校验令牌未被顶掉**,被顶则放弃 `audition()`(不出声)。
**实现(令牌放引擎,零散改)**:`StudioEngine` 加 `auditionGen`;`stopAudition()` 每次 `auditionGen++`(于是**所有**既有 stop 调用点——空格/选别处/落 pad/起走带/load——自动作废 in-flight 预览,无需逐一改)。新增 `nextAuditionToken()`(`++auditionGen` 返回,**不停当前预览** → 保「旧预览放到新的就绪」无缝手感;停旧由随后 `audition()` 内部的 `stopAudition` 完成)、`auditionStale(tok)`(`tok !== auditionGen`)。host 两入口(`auditionSound`/`previewCollagePiece`)在 await 前 `const tok = en.nextAuditionToken()`,`audition()` 前 `if (en.auditionStale(tok)) return`。`editCollageClip` 的 `auditionSwap` 已自带 `auditionId !== id` 兜底(stop 后置 null,不会复活),不需令牌。`previewInst`→`previewInstrument` 同步读已加载 voice buffer,无 await、不受影响。
**空格识别"加载中"预览(warm-up 窗口先停、不误启走带)**:仅 `auditionGen` 解决不了"冷样本 warm-up 窗口里 `auditionId==null`、按空格落到 `togglePlay()` → 误启走带"。再加 `auditionPendingTok`(`nextAuditionToken` 设为新 gen,`stopAudition` 清 0)+ `auditionPending()`(`!==0`)+ `clearAuditionPending(tok)`(**按令牌清**:`pendingTok===tok` 才清 → 扛并发 in-flight + host `finally` 清理不会误清后来者,杜绝抛错泄漏)。空格条件从 `auditioningId()!=null` 扩成 `auditioningId()!=null || auditionPending()` → **第一下空格停掉加载中的预览(不出声、不走带),第二下才走带**;host `finally` 调 `clearAuditionPending(tok)` 防泄漏。
**§15/§16 合规**:纯瞬态(令牌只在内存计数,不落库/不进 undo),口径不扩。

### 28.8 auditionSwap 孤儿(真·"停不下来" 根因)—— 修复 · 2026-06-23(Chrome 实测定位)
**现象**:库里点播 A→播 B→连按几下,声音停不下来(长音频尤甚)。§28.7 的令牌不是这个;Chrome 注入引擎实测抓到真因。
**根因链**(两环):
1. **触发**:库素材 ClipEditor 用 `key={'snd-'+libSel}`,换选即**重挂**;重挂 + `analysis` 异步到达的 reset 会漏出一次**回流 `onChange`** → `editSoundRegion` 在**没有任何真实编辑**时就跑了 `pushHistory()`(污染 undo)+ patch + (正在试听则)`auditionSwap`。连点 A/B 每次切选都触发。
2. **孤儿**:`auditionSwap` 为"编辑 region 不打断试听"会在**下一个 loop boundary** 交叉淡化——把 `this.auditionPlayer` **立刻**换成排到 boundary 才起播的 `np`,旧 player(`old`)排到 `old.stop(boundary)` 才停。**boundary 对长 loop 可能在很久之后**(114 bar loop ≈ 数十秒~分钟),且 `old` 只活在闭包里,`stopAudition` 够不着 → 按空格只灭了没出声的 `np`,真正在响的 `old` 漏播到远期 boundary = **停不下来 / 孤儿**。
**修法**(两处,实测确认):
- **核心(引擎,杀孤儿)**:加 `auditionFading: Set<Tone.Player>`;`auditionSwap` 把 `old` 登记进去(dispose 定时器到点再 `delete`);`stopAudition` 遍历 `auditionFading` 全部 `stop()+dispose()` 再 `clear()` → 任何淡出中的旧 player 都能被停止指令立即灭掉。**这是定性修复**:无论谁触发 swap、loop 多长,停止永远停得干净。
- **触发(host,免空转)**:`editSoundRegion` 开头比 `soundToClip(s)`,region 七字段(start/end/bars/timeMul/semitones/fadeOut/fadeSilence)全等 → **早退**,不 `pushHistory`/不 patch/不 `auditionSwap`。消掉"选中即写 undo + 触发 swap"的空转。
**实测验证(Chrome 注入)**:① 连点 A/B/A/B 不再出现 `SWAP`、无孤儿、单 player 干净切换;② 注入真 `auditionSwap` 后 `old` 进 `fading` 仍 `started`,`stopAudition` 后 `old` 变 `stopped`+`disposed`、`fading` 清空、无任何 player 残留 `started`;③ 空格停止后 `auditionId=null`、不误启走带。
**§15/§16 合规**:`auditionFading` 纯瞬态;`editSoundRegion` 早退反而**减少**了无意义的 undo 压栈/落库(更合规)。

### 28.9 ⌘/Ctrl 拖起始线 = 独立左裁剪(网格吸附,终点钉死)—— 🚧 设计 · 2026-06-24
**动机**:此前起始线(绿)拖动恒为**整窗滑动**(loop 长度不变、终点等距跟随,见 [`applyDrag` trimStart 分支](web/src/studio/ui/WarpEditor.tsx:463)),配合 §28.4「Set as start 也是整窗平移」(2026-06-21 用户更正)—— 于是**左边没有任何"裁剪"操作**:右边橙锚能 resize,左边只能滑。补一个 **⌘(Mac)/Ctrl(Win) + 拖绿起始线** 的镜像操作。
**语义**:按住修饰键拖起始线时——
- **终点钉死不动** → loop 长度**改变**(= 从左裁剪 / resize-from-left,与 `trimEnd` 右裁剪对称);无修饰键仍是整窗滑动(两套语义,修饰键切换)。
- **吸附网格**(默认绿线拖动是无极的,这是新增能力)。**吸附基准 = 固定的终点**:`newStart = trimEnd − round((trimEnd − ob)/gridBars)·gridBars`(不能复用 `snapGrid`,它原点 = 正在移动的起点,会自相矛盾)→ loop 长度恒为网格整数倍,与 trimEnd 同口径。`snap` 关时直接取 `ob`。
- **夹紧**(三条,镜像 trimEnd):`newStart ≤ trimEnd − gridBars`(至少留一格);`newStart ≥ max(0, trimEnd − maxBars)`(往左拉 = loop 变长,受 collage 空档 `maxBars` 约束 + outBar 不越 0);loop 变短后 `fadeOut/fadeSilence` 夹到 `(trimEnd − newStart)/2`(同 trimEnd)。
**实现(集中、低风险)**:`applyDrag(clientX)` 加尾参 `gridMod`,两处调用(`onDown`/`onMove`)传 `e.metaKey || e.ctrlKey`(**实时读** → 拖到一半按下修饰键即切语义,Ableton 风)。仅 `mode==='trimStart'` 时按 `gridMod` 分叉:真 = 左裁剪,假 = 既有整窗滑动。底部 hint 补一句修饰键说明。
**§15/§16 合规**:纯几何改动,emit 的 `region`(start/end/bars)本就能表达任意起止 → 走既有 200ms 防抖 `onChange`(落库 + 进 undo,§16 口径已含 clip trim/长度),**零新链路、口径不扩**。

### 28.10 pad 二次点 = 试听 + 走带停时预览自带节拍器 —— ✅ 实现 · 2026-06-24
**pad 二次点试听**:走带停时,普通点 playground 乐器 pad 第一下 = 选中(原状),**已选中再点 = `previewInst` 切换试听**(§28 audition,自带 toggle:再点停)。判定 `!playing && selId===id && !markedIds.size`,落在 [`clickInst`](web/src/studio/StudioApp.tsx:963) 一处;shift 多选 / 走带在跑均维持"只选中"。即第 4 个走 audition 的预览入口(并列 §28.2 三处),复用 `previewInstrument`,瞬态、不进 undo。
**预览节拍器(`metroClock`)**:节拍器原是 `Transport.scheduleRepeat('4n')`,Transport 冻结时不 fire → **走带停时的预览本来一声不响**。补一条**脱离 Transport 的 `Tone.Clock`**([`startAuditionMetro`](web/src/audio/studioEngine.ts:158)):频率 = master bpm 的拍频,锚回 `auditionStart` 的 phase-0(整小节 loop 下拍 = 重音 C6),带 `startPhase` 偏移时 `n=ceil(...)` 只打未来格点。响不响/重音由 `clickForBeat(beats)` 决定(与 Transport 节拍器 `onClick` 共用一份 interval/重音逻辑,免漂移)。
- **互斥门槛**:仅 `audition()` 立即起播分支且 `Transport.state!=='started'` 时 arm;走带在跑(含非量化预览)归 Transport 节拍器,**绝不双调度**。
- **生命周期**:`stopAudition()`(切/停预览·起走带·dispose 的中央口)统一 `stopAuditionMetro()`,不泄漏/不"停不下来";`setMetronome` 在预览中开关即时启停;`setBpm` 预览中改速按新速重锚。`auditionSwap` 换 buffer 不动 clock —— dur 恒整小节,相位天然连续。
- **取舍**:子小节/非整小节片预览**也响、走稳定 bpm 网格**(节拍器 = 绝对速度参考,不跟随短 loop 重启)。
- **范围**:覆盖所有 audition(库试听 `auditionSound` / 单 sample+整体乐器 `previewInstrument` / collage 片 `previewCollagePiece`)—— 全funnel `engine.audition()`,一处插入全覆盖。**零 UI/contract/undo/持久化改动,纯引擎加法。**

## 29. 鼓二段分离(Drum kit split / drumsep)—— 🚧 实现 · 2026-06-22
**一句话**:已分离出的 **drums stem 可以再拆一层** —— 用专训鼓模型(drumsep)把鼓轨分成 **kick / snare / toms / cymbals** 四件孙 Sound。**只有鼓能再拆**(bass/other/vocals/guitar/piano 不行);拆出来的孙轨与父鼓轨逐样本对齐 → 继续继承同一条 warp → 仍**天然锁相**,可单独拖 pad/轨。

> 实测(2026-06-22):inagoy/drumsep checkpoint 167MB,内部 sources 是西语 `['bombo','redoblante','platillos','toms']`,归一化为 `kick/snare/cymbals/toms`。真实两段链路验证:四件帧数与父鼓轨**完全相等**(逐样本对齐 ✓)、四件残差仅占鼓轨能量 **3.9%**(近乎完整覆盖)。

### 29.1 为什么二段式、为什么只鼓
- **二段式**:第一段 `htdemucs_6s` 已把全混分成 6 轨;drum kit 分离是把 drums 轨再喂给一个**专门训练在鼓上**的模型。这是成熟方向(drumsep / LarsNet),不是从全混直接出 kick。
- **drumsep = Demucs checkpoint**,能直接落进现有 sidecar(同一套 `apply_model`),集成成本最低 —— 选它做 v1。质量上限更高的 LarsNet(分 5 件带 cymbals、非 Demucs 框架)后置。
- **只鼓**:其它 stem 再拆没有现成专模型、价值低;鼓拆 kick/snare 干净、对 loop 机隔离单件价值最高(hihat/cymbal/tom 会糊,可接受)。门在后端硬控(见 29.4)。

### 29.2 数据模型(§15 合规)—— **零 schema 改动**
`Sound.parentSoundId` 是**自关联**(`SoundStems`,`onDelete: Cascade`),天然支持任意深度。drums 子 Sound 直接当 kick/snare 孙 Sound 的 `parent`;`stemKind`/`stemStatus` 两列对**任何 Sound** 通用,`Asset.kind='stem'` 复用。
- 孙 Sound:`parentSoundId=drums子.id`、`stemKind∈{kick,snare,toms,cymbals}`、`stemStatus=null`、`name='<父名> · kick'`(父名已是 `'loop · drums'` → 孙 = `'loop · drums · kick'`)。
- **继承**:孙轨复制**父鼓轨**的 `analysis/warp`(父鼓轨又继承自全混 → 同 BPM/小节/loop 区)→ 逐样本对齐 → 锁相。
- **多租户**:孙轨 `userId` 继承父鼓轨(= 全混的 userId);separate 路由仍校验 `findFirst({id,userId})`,鼓轨有 userId 故成立。
- **cascade**:relationMode 默认 foreignKeys → MySQL 级 `ON DELETE CASCADE`。删全混 → 删 drums 子 → 连带删 kick/snare 孙(`deleteMany({parentSoundId})` 重分时也连孙一起清,干净)。Asset(sha256 去重、全局)不删。
- **fork(§25)**:`loadSoundsWithParents` 沿 `parentSoundId` 向上爬 + 拓扑父在前,**已支持任意深度** → 孙轨被 clip 引用时,kick→drums→全混 整条链都会克隆进副本库。**无需改 forkProject。**

### 29.3 sidecar:双模型(stem-service/app.py)
- 启动加载**两个** Demucs 模型常驻:`MODEL`(全混 `htdemucs_6s`,现状)+ `DRUM`(鼓模型,`load_model(DRUM_CKPT)`,`demucs.states.load_model` 直读 `.th`)。`DRUM` **可选**:checkpoint 没装则 `DRUM=None` + 日志告警,**不影响现有全混分离**。
- `/separate` 入参加 `model: 'full' | 'drums'`(默认 `'full'` → 向后兼容)。`'drums'` 走 `DRUM`;`DRUM is None` 时回明确错误「drum 模型未安装,见 stem-service/README」。
- **源标签动态读** `model.sources`(同现状 `SOURCES=list(MODEL.sources)`)+ 一张**归一化映射**(英/西多语:bombo→kick、redoblante/caja→snare、platillos→cymbals、tom→toms…),DB 落归一化后的英文 `stemKind`;未知源 passthrough 小写。robust 到不管 checkpoint 内部标签是什么语言。
- **torch 2.6+ 坑**:drumsep 老 checkpoint 序列化了整个 HDemucs 对象,`torch.load` 默认 `weights_only=True` 会拒 → 用 `weights_only=False` 自读 package(可信本地文件)再喂 `load_model` 的 dict 分支。
- `/health` 同时报两模型 sources;近静音过滤(`peak<0.01`)沿用 → 没 tom 的鼓自动不建 tom 孙轨。

### 29.4 后端(web/src/lib/stems.ts)—— 开一道窄缝
- 现状第 28 行 `if (parent.parentSoundId) throw`(一刀切禁止 stem 再拆)→ 改为:
  - 顶层(`parentSoundId==null`)→ 允许,`model='full'`。
  - **drums 子轨**(`parentSoundId!=null && stemKind==='drums'`)→ 允许,`model='drums'`。
  - 其它 stem → 仍 throw「只有鼓轨能再拆」。
- `/separate` body 带上 `model`;其余流程(健康检查→标 separating→删旧子→建子 Sound 继承父 analysis/warp→跳近静音→标 done/failed)**完全复用**,父子两层走同一函数。
- GET 路由(`api/sounds`、`api/gens`)的 `stems` include **加第二层**(嵌孙),否则孙轨不出现在 API 响应。

### 29.5 前端 —— collect 改递归 + UI 多嵌一层
- **collect 递归**(三处只吃一层 → 改成收全部后代):`useLoopMachine.ts` flatten(`soundsRef`)、`realLibrary.ts` 全库 Map、`StudioApp.setStemStatus`/`markStem` 乐观标记(孙轨 id 嵌在 `s.stems[].stems[]`,要递归找)。`soundToLoop` 已递归、`ApiSound.stems` 已递归类型 —— 不动。
- **UI(LoopManager)**:配角分级 —— 全混=主角,stem=配角(暗底凹一层),**鼓件=配角的配角**(再凹一层、更小更暗,`srow-sub`)。drums 的 `srow` 加 hover 出的 **「Split kit」** chip(仅 `stemKind==='drums'` && 无孙 && 服务在跑);点 → 同一个 `onSeparate(drumsStemId)`。drums 轨 separating 出内联 mini spinner;done 展开 kick/snare/toms/cymbals 孙行(各 ▶ + 拖拽 + 选中);失败「Kit split failed · tap to retry」;有孙时给 ↻ 重拆。
- **STEM_LABEL / clipColor**:加 Kick/Snare/Toms/Cymbals 标签 + drums 同色相邻近色(暖橙族)。

### 29.6 §16 合规
分离(含二段拆)= **外部副作用、不进 undo**(§16 litmus 归"生成"类,与现状一致;重分对旧子轨是硬删,同现状)。孙轨作为 Sound 仍受**库存活集⑦**软删覆盖(用户主动 Del 删孙轨可撤)。**口径不扩。**

### 29.7 落地顺序
① 本节设计(doc-first)。② sidecar:`app.py` 双模型 + `model` 路由 + 归一化;README 写 drumsep 安装。③ 后端:`stems.ts` 开缝 + 传 `model`;两 GET 路由嵌第二层。④ 前端:三处 collect 递归 + LoopManager 鼓件渲染/「Split kit」+ STEM_LABEL/clipColor。⑤ typecheck。⑥ 实测:分全混→拖 drums 旁点 Split kit→出 4 鼓件孙轨→拖 kick 到 pad 锁相→重拆/失败态→删全混连带清孙。**坑**:改 `app.py` 重启 sidecar;装了 drumsep checkpoint 才有 drum 模型。

## 30. 示例项目跨环境打包/导入(export → import 母版)—— ✅ 实现 · 2026-06-22

**一句话**:上线前要把**本地做好的一个项目**变成**线上的示例母版**(§25 `isExample`)。难点不是「标记」——`isExample` 只是 `Project` 上一个布尔(super admin 在 UI ★Example 开关或 `PATCH /api/projects/:id { isExample }` 一翻即可)。难点是**跨环境搬数据**:本地和线上是**两个 MySQL + 两个 `web/storage/`**,要把这个项目依赖的整张子图(行)+ 它引用的**音频字节**一起搬过去,并把所有权改成线上站长。本质 = **跨库版的 [`forkProject`](web/src/lib/forkProject.ts) + 额外搬 `Asset` 字节**。

**为什么不能只导 `Project` 一行 / 为什么 fork 不够**:`forkProject`(§25)是**同库**深克隆,`Asset`(sha256 内容寻址)与音频字节**全局共享**,所以它直接沿用 `assetId/bakedAssetId` **不复制字节**(forkProject.ts:8/88)。**跨环境恰恰相反**:线上 DB 没有这些 `Asset` 行、线上磁盘没有这些 `.mp3`([`storage.ts`](web/src/lib/storage.ts) 是纯本地文件系统,`/storage/` 还在 .gitignore)。**fork 白嫖的那部分,正是跨环境必须手动搬的部分** —— 漏了就:行能导进去,但每个 clip 播放 404。这是本节第一坑。

### 30.1 依赖子图(= forkProject 的走法,权威清单)
搬什么由 [`forkProject.ts:33-44`](web/src/lib/forkProject.ts) 定死,照搬:
- `Project` 标量(name/masterBpm/masterKey/quantize/beatsPerBar/genPrefs/gridPrefs/fx/loopSong/playMode/showAutomation)。
- `StudioSession → StudioInstrument → Clip` 整棵树(全列含 sends/extra/各 mixer 列/xyAuto)。
- `PadClip`(老 pad 布局,若有)。
- 被引用的 `Sound` + **stem parent 链**(`loadSoundsWithParents` 向上爬 + 拓扑父在前;kick→drums→全混整条,§29 任意深度)。
- 每个 `Sound.assetId` / `Clip.assetId` / `PadClip.assetId` / collage `StudioInstrument.bakedAssetId` 指向的 `Asset` 行 **+ `web/storage/<asset.path>` 的真实文件**。
- **不带**:`Gen` 生成历史(母版要干净,同 fork 的 `genId=null`,forkProject.ts:76)、`WarpRender`(线上按需重渲)、`ExampleDismissal`、其它项目/用户。

### 30.2 Bundle 格式
一个目录(可 tar):`bundle.json`(子图所有行,原样;每个 Asset 带 `sha256/kind/contentType/bytes/path`)+ `audio/<sha256>.mp3`(引用到的全部 Asset 字节)。内容寻址 → 文件名即 sha256,天然去重、可重复导入幂等。

### 30.3 `scripts/export-example.mjs`(本地跑)
入参:本地项目 id。① 照 30.1 拉子图(复用 forkProject 的 include/`loadSoundsWithParents` 逻辑)。② 收齐全部引用 `assetId`(含 `bakedAssetId`、stem 的 asset)→ 查 `Asset` 行 → 从 `storageAbs(asset.path)` 读文件进 `audio/`。③ 落 `bundle.json`。**只读本地,不改任何东西。**

### 30.4 `scripts/import-example.mjs`(线上直连 DB+FS 跑)
入参:bundle 路径 + 目标 super-admin username。一个事务外先落文件、事务内写行(同 forkProject 的「读在外、写进事务」):
1. **Asset 按 sha256 去重落地**:每个 bundle Asset → 线上 `db.asset.findUnique({sha256})`,**有则复用**,无则把 `audio/<sha256>.mp3` 写进线上 `web/storage/audio/`(复用 [`putAudioAsset`](web/src/lib/storage.ts:17) 语义)+ 建 `Asset` 行。建 `sha256 → 线上 assetId` 映射。
2. **建 `Sound`**:新 id、`userId=线上 super admin`、`originProjectId=新项目`、`genId=null`、父→子顺序(接 `parentSoundId`),`assetId` 走 sha256 映射。建 `母版 soundId → 新 soundId` 映射。
3. **建 `Project`**:`userId=线上 super admin`、`isExample=true`、`forkedFromExampleId=null`。
4. **建 Session 树 + PadClip**:嵌套 create 自动新 id;`soundId` 走 sound 映射、`assetId`/`bakedAssetId` 走 sha256 映射。
5. 成品 = 一个**属于线上站长、已标 `isExample`** 的母版,所有人列表里天生可见(§25)。

### 30.5 三个不漏的坑
- **`Asset.id` 两库不同 → 必须靠 sha256 重映射,绝不能直接搬 id**(`assetId`/`bakedAssetId` 全过映射)。
- **`bakedAssetId`(collage 烘焙)和 stem 的 asset 是独立 `Asset` 行**,别只搬源音频 —— 否则 collage 上线要重 bake、stem 轨丢字节。
- **先把站长那条 `User` 提成 SUPER_ADMIN**(`node scripts/promote-admin.mjs <username>`)再导,否则导进去的母版没人 own、UI 也没 ★Example 开关。

### 30.6 §15/§16/§25 合规
导入是**一次性运维脚本**(非用户交互)→ 不进 undo、不走 §15 ops。产物落在既有规范化表 + 全局 `Asset`,**口径不扩**(同 §25 结论)。导入后线上对该母版的一切(用户 fork、编辑、dismiss)走 §25 既有链路,**forkProject/autosave/undo 一行不用改**。

### 30.7 落地顺序
① 本节设计(doc-first)。② `export-example.mjs`:子图 + 收 Asset 文件 → bundle。③ `import-example.mjs`:sha256 去重落字节 + 所有权重写 + `isExample=true`。④ 实测:本地导出 → 线上空库导入 → 站长列表见母版 → 别的用户进入 fork 出副本 → 音频不 404、collage 不重 bake、stem 锁相 → 重复导入幂等(sha256 复用、`@@unique([userId,forkedFromExampleId])` 不撞)。**坑**:线上 import 前先 promote 站长;线上 `web/storage/` 要是持久卷(别落进会被重建清掉的临时目录)。

**✅ 已实现(2026-06-22)**:`web/scripts/export-example.mjs`(`node scripts/export-example.mjs <projectId> [outDir]`)+ `web/scripts/import-example.mjs`(`node scripts/import-example.mjs <bundleDir> <站长username>`)。loadSoundsWithParents/嵌套 create 全对齐 forkProject;Asset 按内容 sha256 去重(等价 putAudioAsset)。**round-trip 已测**:导出真实项目 deephouse(15 sessions/35 instruments/34 clips/8 sounds 含 3 stem 子/8 assets)→ bundle 引用完整性+哈希+拓扑序校验过 → 导入 scratch 库 → 归属/isExample/originProjectId/genId=null/parent 链/asset&sound 映射全对(scratch 库测后即删)。脚本要在 `web/` 下跑(storage 根按脚本位置定位,不依赖 cwd)。

## 31. 音频输出设备选择(选哪个声卡/接口出声)—— 📐 设计 · 2026-06-22

**一句话**:顶栏右簇加一个 `Output` 按钮 + 浮层,让用户把整个引擎的声音**路由到指定输出设备**(内置扬声器 / 外置声卡 / 蓝牙耳机),而不是只能跟系统默认走。技术核心 = 对 **Tone 那唯一一个出声 context** 调一次 `setSinkId`;浮层照搬 §17 `FxRack` 的范式;设备偏好存 **localStorage(机器本地,不入库)**。**v1 = 输出选择**(播放路由);输入设备(录音)非本节范围。

### 31.0 复用现状(只有一处真出声 + 浮层范式现成)
- **全应用只有 Tone 一个 context 真正驱动扬声器**:主总线 `master → softClip → toDestination`([studioEngine.ts:89](web/src/audio/studioEngine.ts#L89))、所有乐器/试听/collage 片预览都 `.toDestination()` 或接 `Tone.getDestination()`(180+/549/591/622 行)、`fxBus` 三个 return 也接同一 destination([fxBus.ts:150](web/src/audio/fxBus.ts#L150))。⚠️ `realLibrary._ctx`([realLibrary.ts:10](web/src/studio/realLibrary.ts#L10))、`studioGens._gctx`([studioGens.ts:11](web/src/studio/studioGens.ts#L11))只做 `decodeAudioData`/`createBuffer`,`signalsmithWarp` 是 `OfflineAudioContext` —— **解码与离线渲染都不出声**,故**只切 Tone 的 context 即全局生效**,不必追这几个裸 ctx。
- **浮层范式现成**:`FxRack`/`Metronome` 已是「顶栏一个按钮 + 右对齐浮层 + 点外/Esc 关」([FxRack.tsx](web/src/studio/ui/FxRack.tsx)),`OutputDevice` 直接抄骨架。落位在顶栏右簇 master 音量/FX/XY 那一排([StudioApp.tsx:1442](web/src/studio/StudioApp.tsx#L1442))。

### 31.1 ⚠️ 命门:`setSinkId` 是 Chrome/Edge 专属 + 设备名要授权 + id 不跨机器稳定
三件事必须焊进设计,不能当 bug 留给以后:
- **`AudioContext.setSinkId` 仅 Chrome/Edge 110+**(Safari/Firefox 无)。`OutputDevice` 一进来 **feature-detect** `'setSinkId' in Tone.getContext().rawContext`;不支持 → 按钮可点但浮层列表灰掉,底部提示「你的浏览器只能走系统默认输出,换设备请用 Chrome/Edge」。产品本就是 Chrome + Suno 插件生态,可接受。
- **`enumerateDevices()` 没麦克风授权时 `label` 为空**(出于指纹防护)。**决策:不一进来就要权限** —— 未授权时设备行显示成 `Speakers 1/2…` 占位 + 一个「显示设备名称」按钮,点了才 `getUserMedia({audio:true})`(立刻 `getTracks().forEach(t=>t.stop())` 释放麦克风)拿一次授权,之后 `enumerateDevices()` 的 label 就有了。纯播放应用不该默认索麦。
- **`deviceId` 不跨机器/不跨浏览器档稳定**(per-origin 加盐)。故存的 id 在**加载时必须对当前 `enumerateDevices()` 列表校验存在性**,不在 → 静默回落 `'default'`,绝不报错。

### 31.2 引擎:`StudioEngine.setOutputDevice(deviceId)`(单点路由)
[studioEngine.ts](web/src/audio/studioEngine.ts) 加一个方法,只碰 Tone 的原生 context:
```ts
async setOutputDevice(deviceId: string) {
  const raw = Tone.getContext().rawContext as AudioContext & { setSinkId?: (id: string) => Promise<void> };
  if (typeof raw.setSinkId !== 'function') return;          // Safari/Firefox:静默不动(走系统默认)
  await raw.setSinkId(deviceId === 'default' ? '' : deviceId); // '' = 跟随系统默认输出
}
```
- `'default'` 哨兵 → 传 `''`,语义=**跟随系统默认**(用户在 macOS 换默认设备时应用自动跟随,无需回来重选)。
- Tone context 是急建的(`Tone.start()` 前 `rawContext` 已存在做 standby),故此方法在 `resume()`([studioEngine.ts:156](web/src/audio/studioEngine.ts#L156))之前调也安全;但**正常时序**是初始化后读 localStorage 偏好再调一次。`setSinkId` 在运行中的 context 上切换是合法的,不打断正在播的声。

### 31.3 设备列表 hook:`useAudioOutputs()`
新建 `web/src/studio/useAudioOutputs.ts`(纯前端,不碰后端):`navigator.mediaDevices.enumerateDevices()` → 过滤 `kind === 'audiooutput'` → `[{ deviceId, label }]`,列表头部恒插一项 `{ deviceId:'default', label:'System default' }`。监听 `navigator.mediaDevices.addEventListener('devicechange', …)`,**插拔声卡/耳机时自动刷新列表**(若当前选中的设备拔掉了 → 浏览器自身回退默认,hook 把高亮也移回 default)。返回 `{ devices, hasLabels, requestLabels }`(`requestLabels` = 31.1 那次 getUserMedia 授权)。

### 31.4 UI:顶栏 `Output` 按钮 + 单选浮层(见本回合 mockup)
- **按钮**:顶栏右簇 master/FX/XY 同排,喇叭图标 + `Output`;选中非默认设备时图标染陶土橙 `#c2724f` 提示「已改路由」。
- **浮层**(右对齐、点外/Esc 关,同 `FxRack`):一列**单选行**,当前设备打勾 + 陶土橙高亮行底(沿用既有暖色 token,不另起色相,同 §27 结论);`System default` 恒第一项并标注它当前指向谁(如 `→ Scarlett 2i2`)。
- **两个状态焊进 UI**:① 未授权 → 灰名占位 + 「显示设备名称」按钮(31.1);② 浏览器不支持 `setSinkId` → 列表灰 + 底部一行说明(31.1)。
- 选中回调:`eng.current?.setOutputDevice(id)` + 写 localStorage(31.5)。私有类名 `od-*`,避开历史 `.led/.sel/.on` 撞名坑(同 §4.1/§27.5)。

### 31.5 持久化(§15)/ undo(§16)合规
- **决策:存 localStorage,不存 Project 列、不入规范化表**。理由:输出设备是**「这台机器/这个浏览器」的环境偏好**,非创作内容 —— 同一项目在两台电脑想要不同设备;且 `deviceId` per-origin 加盐、跨机器无意义(31.1)。存 DB 既语义错位,又要 `db push` + 重启 next(踩 [[prisma-stale-client-restart]])。故 key=`sunogrid.outputDevice`,**零 schema 改动、不走 §15 ops/发件箱**。
- 加载时:读 localStorage → **校验仍在 `enumerateDevices()` 列表**(31.1)→ 在则 `setOutputDevice`,不在则回落 default。
- **§16:不进 undo**。播放路由是瞬态环境设置,和 `masterVol`/`metronome`/`quantize` 同档(§16 沿革:这些都不进 history)—— **口径不扩**。

### 31.6 落地顺序(每步 typecheck)
① `StudioEngine.setOutputDevice`(feature-detect + `''`=默认)。② `useAudioOutputs` hook(enumerate + devicechange + requestLabels 授权)。③ `OutputDevice.tsx`(照 `FxRack` 浮层骨架 + 单选列 + 两个降级态)+ 挂进顶栏右簇([StudioApp.tsx:1442](web/src/studio/StudioApp.tsx#L1442))。④ localStorage 读写 + 加载校验回落。⑤ CSS `od-*`。⑥ 测:Chrome 插外置声卡 → 列表出现 → 选中后声音转过去 → 拔掉自动回默认 → 刷新页面 resume 上次选择(设备还在)→ 换台机器/Safari 优雅降级(灰列 + 提示、声音照常走默认)。

**✅ 已实现(2026-06-22)**:[studioEngine.setOutputDevice](web/src/audio/studioEngine.ts) + [useAudioOutputs.ts](web/src/studio/useAudioOutputs.ts)(含 `applySavedOutput`/`outputSwitchSupported`)+ [OutputDevice.tsx](web/src/studio/ui/OutputDevice.tsx) + 顶栏接线 + globals.css `.out-*/.op-*`。Chrome 真机点验过:列表含 5 个真实输出设备、选中切声、System default 标注当前指向(剥 `Default-/默认-` 前缀)。**⚠️ 踩到 §4.1 的 `.sel` 撞名坑**:选中行用了裸 `sel` 类 → 继承全局 `.sel{max-width:170px}`(顶栏选择器)→ 选中行被截成 170px 不铺满(用户报「block 没包住」)。CSS 三处旧坑(`csel`/`ksel`/`sblk-sel`)早有先例。**修法 = 私有类名 `op-sel`**(契约 §31.4 本就写了「私有 od-*」,实现时漏了);DOM 实测选中行 170→238px、`max-width:none`。名字+注释改**竖排**(`op-text` flex column),长设备名不互相挤、选中底色整行铺满。教训:浮层/列表的状态修饰类**一律加前缀**,别用 `sel/on/led`。

## 32. 总混音导出(Bounce / Render to file —— 把整首歌渲成一个音频文件下载)—— 📐 设计 · 2026-06-23

**一句话**:顶栏右簇加一个 `Export` 按钮 + 浮层,把 **Song 模式整首歌**(所有 session 按 `index` 顺序、各 `repeats` 遍 × `sessionBars` 小节首尾相接 + per-session §26 XY 自动化 + §17 主总线 FX + §21 XY insert + 主音量 + 软削波天花板)**离线一次性渲成 WAV / MP3 下载**。技术核心 = **前端 `Tone.Offline` 复用现成信号链**(`FxBus`/`XYPad`/EQ 链/`softClipCurve` 同一套节点构造),配一条**确定性预排时间线**(不靠 rAF/setTimeout,所有 voice 起停 + XY 自动化采样点都 `transport.scheduleOnce` 预排),保证「导出 = 你听到的那一版」。**v1 = 整首歌、WAV+MP3、纯前端**;单 session 导出、stem 分轨导出、后端渲染都非本节范围。

### 32.0 决策:为什么前端 `Tone.Offline` 复用、而不是后端重写
- **整条出声链是 Tone.js + Web Audio**(§17 FxBus 的失真/延迟/混响 return、§21 XYPad 的 4 program insert、三段串联 EQ、master `WaveShaper` 软削波)。后端 Node 没有 Web Audio,要 1:1 复刻等于把这几百行 DSP 全重写一遍,且**几乎必然和实际播放音色对不上**。
- **`Tone.Offline(cb, dur)` 会把全局 context 临时换成 `OfflineAudioContext`** —— 回调里 `new FxBus()` / `new XYPad()` / `new Tone.Player()` 全部建在离线 context 上,`Tone.getTransport()` 返回离线 transport。故**导出器与 live 引擎共用同一份节点构造代码**,改一处两处一起对。这是「所见即所听」在导出上的延伸。
- **per-乐器 buffer 早已是离线产物**:`buildBuffer(inst, bpm, soundsById)`([realLibrary.ts:172](web/src/studio/realLibrary.ts#L172))把 sample 走 `warpToBuffer`、collage 走 `buildCollageBuffer` 渲成一条**整小节可循环 buffer**(还带 warp-render 落盘缓存)。导出**先把全曲所有乐器的 buffer 预渲好**,再喂进 `Tone.Offline` —— 与播放时引擎拿到的 buffer 完全同源。

### 32.1 ⚠️ 命门(三条焊进设计,不当 bug 留后面)
- **① MP3 必须引库**:浏览器原生无 MP3 编码(`MediaRecorder` 只能 webm/opus)。决策 = 加 **`@breezystack/lamejs`**(lamejs 维护分支,带 TS 类型),纯前端 JS 编码,不开后端。WAV 走现成 [wav.ts](web/src/audio/wav.ts)(16-bit PCM)零依赖。
- **② 离线 context 里 `Tone.Reverb` 的 IR 是异步生成**:`ReverbFx.set` 的 `rev.generate()` 在 live 里走 200ms 防抖 `setTimeout`([fxBus.ts:135](web/src/audio/fxBus.ts#L135))—— **离线渲染等不到这个 setTimeout**。导出路径必须在 `transport.start()` **之前 `await` 混响 IR 就绪**(直接 `await (rev as any).ready` 或显式 `await rev.generate()`),否则混响 send 出来是空的。这是导出与播放**唯一**需要分叉处理的节点。
- **③ XY brake(`PitchShift`,granular)+ slicer(`LFO` 自由相位)在离线渲染的保真度未经验证** —— 这俩是 §21 里最「玄」的节点。v1 照常渲,但**列为首发后必须真机 A/B 比对的风险点**;若离线产出与播放明显不符,降级方案 = 导出时 brake/slicer 用「采样自动化值后静态设参」而非实时 LFO(留 TODO,不阻塞 v1)。
- **headless 测不了音频**:本功能的音色正确性**只能在真浏览器里 A/B**(导出文件 vs 播放),CI/agent 环境验不了 —— 落地后必须人工点验(见 32.6)。

### 32.2 时间线 = §20 Song 回放的确定性复刻
完全照搬 `enterSongBlock`([StudioApp.tsx:578](web/src/studio/StudioApp.tsx#L578))的累计小节算法,只是把「rAF + scheduleAt 递归推进」拍平成一次性预排:
```
barSec   = beatsPerBar * 60 / bpm
acc = 0
for s of sessions (按 index):                    // §20 线性顺序
  len      = sessionRepeats(s) * sessionBars(s)  // 这块占的小节数(含 repeats)
  startBar = acc ; endBar = acc + len
  for inst of s.instruments where inst.enabled:  // §20:enabled 决定出声(solo 是瞬态,导出忽略)
    buf = preRendered.get(inst.id)               // 32.0:buildBuffer 预渲
    建 Player(loop) → EQ(low/mid/high) → panner → master   // 同 loadInstrument
    panner →(send 量)→ fxBus.dist/delay/reverbInput        // 同 §17 aux send
    player.sync().start(startBar*barSec).stop(endBar*barSec) // 块内连续循环,块末停
  // XY 自动化(§26):该块每个激活 program 预排采样点
  for program where s.xyAuto?.[program] 激活:
    在 [startBar,endBar) 按固定栅格(每 1/32 拍 ~一帧)预排:
      transport.scheduleOnce(t => xy.setValue(program, sampleXY(...localBar)), barToSec(b))
    块首 setActive(program,true)、块末 setActive(program,false)
  acc = endBar
totalSec = acc * barSec
```
- **块内连续循环 vs 块间重起**:同 live —— 每块的乐器在块起点从 loop 头起、连播到块末(含所有 repeats 间不重起),块边界 stop;下一块换新乐器 voice。`localBar = 全曲bar − startBar` ∈ [0,len),与 coordinator 的 `songPosBars()−songBlockStart` 同口径(§26.4)。
- **XY 导出 = 纯自动化**:live coordinator 那套「手动接管 / latch / spring 交还」([StudioApp.tsx:767](web/src/studio/StudioApp.tsx#L767))在导出里**全不适用**(无实时手势)—— 导出只跑「自动化 → setValue/setActive、否则旁路」这一条分支,逻辑反而比 live 简单。
- **`loopSong` 不影响导出**:导出永远渲**一遍**完整编排(不无限循环)。
- **节拍器不进导出**(监听辅助,§本节同 §17 口径:click 不进 FX,导出更不该有)。

### 32.3 信号链 = §17 + §21 原样(共用节点构造)
导出器的 master 段与 [studioEngine.init](web/src/audio/studioEngine.ts#L72) 逐节点对齐:
```
每件乐器 Player → EQ(三段串联 biquad,EQ_BANDS)→ panner → master(Tone.Volume = 主音量)
                                              └→ send×3 → FxBus(失真/延迟/混响 return)→ master
master → XYPad insert(filter→slicer→delay→brake)→ WaveShaper(softClipCurve(0.72,0.96),4×过采样)→ destination
```
- **共享代码焊点**:`softClipCurve` 当前是 [studioEngine.ts:36](web/src/audio/studioEngine.ts#L36) 的私有函数 → **抽到 `audio/masterChain.ts`(或 export 出来)**,导出器与引擎共用同一条软削波曲线;EQ 三段构造同理(频点已共用 `EQ_BANDS`)。绝不复制粘贴一份会漂移的副本。
- **muteGain(§18 solo 遮罩)导出不建**:solo 是瞬态、不落库、导出忽略 → 所有 `enabled` 乐器满音可听。
- **主音量进导出**:用户调好的 `masterVol`(顶栏推子)是 mix 的一部分,导出按它渲(软削波在其后兜底,+6dB 也不会硬削顶)。

### 32.4 编码 + 下载
- **WAV**:复用/扩 [wav.ts](web/src/audio/wav.ts) —— 现有 `encodeWavBase64` 给 warp 落盘用;导出加一个 `encodeWav(channels, sr): ArrayBuffer`(同 16-bit PCM 写头逻辑,直接给 Blob,不绕 base64)。
- **MP3**:新建 `audio/mp3.ts`,`@breezystack/lamejs` 的 `Mp3Encoder`(立体声、码率默认 256kbps、Float32→Int16 分块喂)→ `Uint8Array`。
- **下载**:`new Blob([bytes], {type})` → `URL.createObjectURL` → 临时 `<a download="<工程名>.wav/.mp3">` 点一下 → `revokeObjectURL`。文件名 = 工程名(`projName`)+ 扩展名。
- **采样率**:固定 **48000**(同 collage bake 的 `buildCollageBuffer` SR,[realLibrary.ts:154](web/src/studio/realLibrary.ts#L154))。

### 32.5 UI:顶栏 `Export` 按钮 + 浮层(照 `FxRack`/`OutputDevice` 范式)
- **按钮**:顶栏右簇,落在 §31 `OutputDevice` 之后、undo/redo 之前([StudioApp.tsx:1476](web/src/studio/StudioApp.tsx#L1476));下载图标 + `Export`,样式同 `fx-btn`。
- **浮层**(右对齐、点外/Esc 关,同 `FxRack`):格式单选(`WAV` / `MP3`)+ 一个「导出」主按钮 + **进度条**(渲染 + 编码可能数秒~数十秒)+ 全曲时长/小节数预览。导出中按钮转 spinner、禁重复点。
- **空工程防御**:全曲 0 个 enabled 乐器 / 0 session → 按钮禁用 + 提示「先往 session 里放点乐器」。
- **私有类名 `xp-*`**(踩过 §31/§4.1 的 `.sel/.on/.led` 撞名坑 → 状态类一律加前缀)。

### 32.6 §15 持久化 / §16 undo 合规 + 落地顺序
- **§15:零落库、零 schema 改动**。导出是**只读快照 → 算 → 下载**,不写任何表、不走 ops/发件箱。读的全是已在内存的 React state(`sessionsRef`/`fxRef`/`ctxRef.soundsById`/`masterBpm`/`masterVol`)。
- **§16:不进 undo**。导出不改任何创作状态,纯输出动作,和播放/选输出设备同档 —— **口径不扩**。
- **落地顺序(每步 typecheck)**:① `npm i @breezystack/lamejs`。② 抽 `softClipCurve`/EQ 构造到共享模块(引擎改用、零行为变化)。③ `wav.ts` 加 `encodeWav`(ArrayBuffer)。④ `audio/mp3.ts`(lamejs 编码)。⑤ `studio/exportSong.ts`(预渲 buffer → `Tone.Offline` 复刻时间线/信号链 → 返回 `AudioBuffer`;混响 IR `await ready`)。⑥ `studio/ui/ExportDialog.tsx`(浮层 + 格式 + 进度 + 下载)+ 挂顶栏。⑦ CSS `xp-*`。⑧ **真机点验**:渲一首含 FX/XY 自动化的歌 → WAV 与播放 A/B 一致(尤其混响尾巴、XY 扫滤波)→ MP3 同 → 工程名落文件名 → 空工程禁用。⚠️ 32.1 的混响 IR / XY granular 两个风险点重点听。

**🚧 已码待真机验(2026-06-23)**:`npm i @breezystack/lamejs` + [masterChain.ts](web/src/audio/masterChain.ts)(抽 `softClipCurve`/`makeShelfEq`,[studioEngine](web/src/audio/studioEngine.ts) 与导出共用)+ [wav.ts](web/src/audio/wav.ts) `encodeWav` + [mp3.ts](web/src/audio/mp3.ts) + [fxBus.ready()](web/src/audio/fxBus.ts)(await 混响 IR)+ [exportSong.ts](web/src/studio/exportSong.ts)(`planSong`/`renderSong`/`bufferChannels`,`Tone.Offline` 复刻 §20 时间线 + §17/§21 信号链 + §26 XY 自动化栅格预排)+ [ExportDialog.tsx](web/src/studio/ui/ExportDialog.tsx)(顶栏 `Export` 浮层:格式/时长预览/进度/下载)+ globals.css `xp-*`。`tsc --noEmit` 干净。**⚠️ headless 测不了音频,音色 A/B 全留真机**:重点听混响尾巴(`fxBus.ready` 是否真等到 IR)、XY 扫滤波/slicer/brake(`Tone.Offline` 里 LFO 自由相位 + PitchShift granular 的保真度,32.1#③)、`transport.scheduleOnce` 驱动 `xy.setValue(rampTo)` 在离线渲染的时序是否跟播放对齐。若 XY 离线明显失真,降级见 32.1#③(采样后静态设参)。

## 33. 长素材自动切块入库(Song chop:整首 → 整小节块,挂在歌下面)—— 📐 设计 · 2026-06-23

**一句话**:任何进库的音频(生成 / 上传)只要**长过一个 loop 该有的长度**,就在 ingest 末端自动**切成若干整小节、可无缝循环的块(block)**;块**挂在整首歌这条 Sound 下面**(复用 stem 的 `parentSoundId` 嵌套),块才是真正翻找、拖 pad、再分 stem 的单位,整首歌本身退成一个**折叠的容器**。切块是 §19.3「统一 ingest」管线的**最后一道工序**,生成/上传/(后置)desktop 三源共走;**全程在左栏 lib 有运行态**(`Chop` 阶段条 + 块流式入库),与现有生成/上传/分离的进度态**同族同色**。

> **为什么不是"每 30 秒硬切"**:本机是**小节锁定**引擎(`Clip.bars` 锁死、回放不二次 warp,§5/§6)。30s 在 120/90/140 BPM 下分别是 15/11.25/35 小节,**都不是干净小节** → 切口落乐句中间、不能循环、进不了网格。所以单位是**小节**,30s 只是体感目标值,换算成 bar 数(≈16 bar @140)。

### 33.0 复用现状(切块 ≈ 既有件的重新组合)
入库脊梁与嵌套范式都现成:
- **ingest 管线**:`ingestAudio` / `generateToLibrary` / `uploadToLibrary`(§27.4,[studioGens.ts](web/src/studio/studioGens.ts)),形状 `拿字节 → decode → 检测 → 落库`。切块插在「检测之后、落库之时」。
- **小节 + 瞬态**:[`detectLoop`](web/src/audio/conditioning.ts) 已返回 `bars / bpm / startSample / onsets[]`(BPM 当锚反推小节)。切块要的 onsets/网格全在。
- **任意深度父子**:`Sound.parentSoundId` 自关联(`SoundStems`,`onDelete:Cascade`,§29.2),块直接当歌的子、stem 的父。
- **嵌套 UI**:`gencard → vcard/.vrow → .stemblk/.srow`([LoopManager.tsx](web/src/studio/ui/LoopManager.tsx),§29.5 已嵌到三层),块这一层照搬 `.stemblk/.srow`。
- **单块精修**:[`ClipEditor`](web/src/studio/ui/WarpEditor.tsx)(§28)= 块的微调入口,零改。
- **运行态家族**:`Gen.status` 驱动的阶段条 + `gdot` + `gvar-row`(生成/上传),`vc-sepbusy`(分离),切块加一态即融入。
- **持久化/undo**:库存活集软删 + 乐观 appear + ops(§15/§16)。

**新写的只有三块**:① 切块 DSP([`audio/chop.ts`]:定 grid origin + 分块);② `chopping` 运行态(GenStatus + 阶段条变体);③ 切块总览组件(`ChopView`,进底部坞)。

### 33.1 ⚠️ 命门:难的不是"切",是定 grid origin(下拍相位)+ 收余数
BPM 不是问题(生成 = `sourceBpm` gospel;上传 = §27.1 `estimateTempo`,切块前已定),小节长度白来。两个真难点:
- **grid origin(下拍相位)**:整首从哪一帧算 bar 1。歌常有 intro / 弱起 / count-in,**origin 错半拍 → 每块都偏、整列不循环**。解:拿 `detectLoop` 的 `onsets[]` 对 BPM 网格做**互相关**,选让节拍线压在瞬态能量上的相位;再给一个**可拖的 origin 手柄**(总览里)兜底。这是 §33 的"BPM 锚"级命门(对应 §27.1)。
- **余数 / 尾块**:歌极少正好整除目标小节数。规则:块长吸到 `{4,8,16}`,**末块退到最近可整除的小节数**;不足下限(`< MIN_BLOCK_BARS`,默认 4)→ 并入前块尾;纯静音尾 → 丢。结构感知(33.5 v2)能天然避开丑余数。

### 33.2 触发闸门:按小节,不按秒
闸门 = `analysis.bars > MAX_LOOP_BARS`(默认 **32**),**不用裸秒** —— 这样自动吃掉同一个"30s"在不同速度下是 11~35 小节的差异。`≤` 阈值 = 现行为(整段当一条 loop 入库,§27.1「默认整段」);`>` 阈值 = 进切块。生成 `Song`(`advanced`)几乎必过;`Sound` / 短上传不过,零改动照走老路。两个常量(`MAX_LOOP_BARS` / `MIN_BLOCK_BARS`)集中放 `audio/chop.ts`,好调。

### 33.3 数据模型(§15.A 列,沿用 parentSoundId)—— 近零 schema
Sound **加两列**,其余白嫖:
- `sliceIndex Int?` —— 块在歌内的序(0..N-1),**= 块的身份判别**(非空 = 这是个 block)。
- `sectionLabel String?` —— `intro/verse/hook/bridge/outro…`;盲网格 v1 留 **null** → UI 显 `Block N`;结构感知 v2 回填。

**三层树 + 判别**:
- 歌(源):`parentSoundId=null`、`sliceIndex=null`、`stemKind=null`。
- 块:`parentSoundId=歌.id`、`sliceIndex!=null`、`stemKind=null`。
- stem:`parentSoundId=块.id`、`stemKind!=null`。
- 判别口诀:`sliceIndex!=null` ⇒ 块;`stemKind!=null` ⇒ stem;都空 ⇒ 顶层。(§29.5 的 collect 递归 / 分离门控按此分流,**别把块当 stem**。)

**块共享歌的 Asset(零新字节)**:`block.assetId = song.assetId`,块的 `analysis.{startSample,endSample,bars}` **在同一份 asset 里开窗** + 自己的 `warp` 种子。这和现有 warp/clip/render **零冲突** —— 生成的 loop 本就是"asset 内 `startSample…endSample` 开窗 + 边缘去静音"([studioGens.ts](web/src/studio/studioGens.ts) warp 种子),块只是同一份(更大的)asset 被多个兄弟开不同窗。`decodeAsset(assetId)` 按 assetId 缓存 → 解一次整首,N 个块预览共用。
**块的 stem**:照 §29 各自**新 Asset**(`kind='stem'`,Demucs 把块的 `[start,end]` 段切出来喂 sidecar),父 = 块,继承块的 `analysis/warp` → 逐样本锁相。
**cascade / fork**:删歌 → 级联删块 → 删块-stem(`parentSoundId` Cascade 现成)。`loadSoundsWithParents`(§25/§29.2)沿 `parentSoundId` 向上爬已支持任意深度 → 块被 clip 引用时,块→歌 整条链克隆进 fork 副本,**无需改 forkProject**。

### 33.4 ⭐ 运行态:在左栏 lib,和生成/上传/分离同族(用户点名)
切块是 **detect 之后的一个新 ingest 阶段**,必须像生成/上传那样在 lib 里有进度态:
- **GenStatus 加 `chopping`**([studioViews.ts](web/src/contracts/studioViews.ts):`'generating'|'streaming'|'uploading'|'detecting'|'chopping'|'complete'|'failed'`)。
- **阶段条(按 source + 是否过阈值出变体)**:
  - 生成 Song:`Generate › Render › Chop › Done`
  - 上传长素材:`Upload › Detect › Chop › Done`
  - 短素材(不过阈值):仍是原 3 段,**不显 Chop**。`GEN_PHASES/UPLOAD_PHASES/ORDER`([LoopManager.tsx](web/src/studio/ui/LoopManager.tsx))按 `source` + `willChop` 拼 4 段变体。
- **配色守暖色铁律(§27.5)**:`gdot.chopping` 走琥珀 `--queue`(同所有 in-progress),阶段条高亮 `--queue`,**不另起色相**。
- **块流式入库**:歌卡先 appear(`chopping`),块**逐条 appear** 在它下面 `BLOCKS` 组里;`gvar-row` 文案 `"k/N blocks in"`(镜像生成的 `"1/2 variants in"`)。切完 patch 歌 `complete` → `reload`。
- **失败**:整条 `Gen → failed` + 重试(字节已在 Asset → 重试 = **纯重跑切块**,不重传);**单块切坏不阻塞别块**。
- **per-块分离的处理态**:复用 §29 的 `vc-sepbusy`("Separating · local Demucs ≈2× realtime"),挂在**块行**下 —— "处理"态下沉到块级正是用户要的(对 16 小节块跑 Demucs 比整首快 6–10×,且分出来正好是那个 loop 的 stems)。

### 33.5 切块 DSP(audio/chop.ts,纯函数,可单测)
`chopSong(channels, sampleRate, bpm, onsets, beatsPerBar, opts) → { origin, blocks: { startSample, endSample, bars, sectionLabel? }[] }`:
1. **定 origin**:onsets × BPM 网格互相关(33.1)。
2. **选 barsPerBlock**:目标 ≈ `MAX_LOOP_BARS` 内、吸 `{4,8,16}`。
3. **v1 盲网格**:从 origin 起按 barsPerBlock 切,末块走 33.1 余数规则,`sectionLabel=null`。
4. **v2 结构感知(叠加层)**:chroma+MFCC 的 self-similarity / novelty 找段落边界 → **吸到最近小节** → 回填 `sectionLabel`;或直接读 **Suno feed 的对齐歌词/段落时间戳**(若 [suno-bridge](suno-bridge/api-map.md) 暴露)→ 段落近乎白送。v2 只**移动 v1 提议的边界**,永远还是整小节。
复用 conditioning 的 `novelty`/onset;切块要全长 onset(不吃 §27.1 的 30s 截断),离线一次性算,可接受。

### 33.6 切块总览 UI(底部编辑坞 ChopView)
- **不是新页面**:渲在 `footer.daw-editor`(ClipEditor 同坞)。从歌 `.vrow` 的 `Chop` 入口打开,或 `chopping` 完成自动开一次供 review。
- **内容**:整曲波形(`peaks` 复用 [StudioApp](web/src/studio/StudioApp.tsx) 懒解码)+ 段落带 + 块边界 `grip`(拖 = 改边界、吸小节)+ **origin 手柄** + `每块 8/16/32` + `结构吸附` toggle + `保留 N/总`。
- **双向选中**:总览块段 ↔ 左栏块行共享 `libSel`(**单一状态源,不另开 state**)。点波形段 = 选中对应块行,反之亦然。
- **单块** → 现有 `ClipEditor` 精修(§28,零改)。
- **非破坏**:总览改边界 = 重算块的 asset 内窗 + 元数据,**重切零成本**(块不是新字节)。

### 33.7 自动切 + 事后策展(强制工序但不卡流程)
切块是强制的,但不该每次入库都逼你坐着剪:`chopping` **自动把所有块入库**(挂歌下、歌默认折叠),总览**随时可重开**策展。垃圾块(intro 环境音、过渡、riser)在总览/块行**一键丢**(软删 → 库存活集,可 undo)。per-块 stem **默认手动**(块行 hover 出 `Separate`),避免入库即对每块跑 Demucs 把 sidecar 压满。

### 33.8 BPM 锚:生成信任,上传可纠(对齐 §27.1)
生成走 `sourceBpm` → 直切。上传走 `estimateTempo` 估速;**估错 = 网格错 = 块全错**,故总览顶部 BPM **可改 + ×2/÷2 + tap**,改完**重切**(零成本)。这是上传切块的成败位,和 §27.1 同一命门。

### 33.9 持久化(§15)/ undo(§16)合规
- **§15**:`sliceIndex/sectionLabel` 规范化落列;块 / 块-stem 走生成同款**乐观 appear + 后台 ops + reload**,零新机制。块**共享 assetId**(不新增字节,`putAudioAsset` sha256 去重本就支持)。`db push` 后**重启 next**(否则 Prisma client 旧、ops 报 Unknown arg)。
- **§16**:块 / 块-stem 落既有**库存活集(口径⑦)**,软删可撤 —— **不扩 7 项口径**(同 §23/§25/§29 结论)。`chopping` 瞬态**不入 history**(镜像生成中途态)。per-块分离 = 外部副作用、**不进 undo**(§29.6 同档);切坏重切对旧块是硬删(同 §29 重分)。

### 33.10 落地顺序(每步 typecheck)
① 本节设计(doc-first)。② schema 加 `Sound.sliceIndex/sectionLabel` + `db push` + 重启 next。③ `audio/chop.ts`(`chopSong` + 单测:已知 BPM 的整首切成整小节、origin 命中、余数规则、阈值边界)。④ ingest 接线:`ingestAudio` 在 detect 后按闸门(33.2)跑 `chopSong` → 建歌 Sound(`chopping`)+ **流式建块**(共享 `assetId`、`sliceIndex` 递增);`GenStatus` 加 `chopping` + 阶段条 4 段变体 + `gvar-row` 块计数。⑤ 前端:`LoopManager` 块层渲染(复用 `.stemblk/.srow`,collect 递归按 `sliceIndex/stemKind` 分流)+ `chopping` 运行态 + per-块 `Separate`;`ChopView` 总览进坞 + 双向选中(共享 `libSel`)。⑥ **测**:生成 Song → 见 `Render › Chop › Done` → 块挂歌下流式入库 → 总览拖边界/改 origin/丢块 → 单块进 ClipEditor → 块 `Separate` 出 stem 锁相 → 拖块/stem 到 pad → 软删/undo → 刷新 resume → 上传长素材同路 + BPM 可纠重切。**坑**:`db push` 重启 next;块**共享 assetId 别误删字节**(删块只删行,Asset 留);`decodeAsset` 解整首已按 assetId 缓存,N 块预览不重复解码。

## §34 粘贴入库(Splice ⌘C → 我们 ⌘V):一键进库 + 建单 sample 乐器

**目标**:用户在 Splice(或 Finder)复制一个音频文件,回到 studio 直接 ⌘V → ① 自动入库(走 §27 上传管线,`uploading→detecting` 运行态 + BPM/调式检测)② **同时**建一个单 sample 乐器落到第一个空 pad。把"找素材 → 拖进 DAW → 建乐器"压成一次粘贴。

### 34.1 可行性(2026-06-23 端到端实测过)
- Splice 的 Copy 往 macOS 剪贴板放的是**指向本地真文件的 file-url**(`public.file-url` + `NSFilenamesPboardType`,文件在 `~/Splice/sounds/...`)。⚠️**异步**:点 Copy 先清空剪贴板,~1-2s 后才写入(它先确保文件就绪)。
- 浏览器 `paste` 事件拿到**带完整字节的 `File`**(`clipboardData.files[0]`,`type:'audio/wav'`,size 与磁盘 `ls -la` 完全一致)。该 File 直接喂得进 §27 管线。
- 验证手段坑(记一笔):computer-use 对浏览器是 read tier(按键被拦)、Chrome 扩展 CDP 合成 `cmd+v` **不会**触发真实系统粘贴;可信粘贴必须真人按一次 ⌘V。读剪贴板用 `osascript -l JavaScript` 枚举 `NSPasteboard.generalPasteboard.types` 最权威(`clipboard info` 看不到 promised-file)。

### 34.2 文件名做检测种子(BPM/调式),DSP 兜底 —— 对齐 §27.1 命门
Splice 文件名编码了 BPM/调式(`NH_IAP_100_..._Dmaj`=100/D大、`SS_AXR2_111_..._D#m`=111/D#小),且剪贴板只带文件本体、**带不出 Splice UI 的 metadata 列** → 解析文件名是找回这俩值的唯一路。价值:正好绕掉 §27 **最不可靠的两步** —— `detectLoop` 是「BPM 是母」需锚(§27.1),文件名 BPM 当锚比 `estimateTempo` 从零估速准;`estimateKey`(chroma 近似)被精确标签取代。
- 策略 = **文件名种子 + DSP 兜底**:`bpm = parseNameMeta(name).bpm ?? estimateTempo()`、`key = parseNameMeta(name).key ?? estimateKey()`,`detectLoop` 不动只是锚更准。非 Splice / 改名 / one-shot 解析不出 → 落回 DSP,**零回归**。
- `parseNameMeta`([audio/detect.ts]):BPM = 按 `_/-/空格/.` 切 token 取**纯数字**且 40–220(纯数字才躲得开 `AXR2` 里粘连的 "2");Key = 匹配 `^([A-G][#b]?)(maj|min|m)$` 取**最靠后** token(调式在尾巴、要求大写根音+后缀以避开 "am"/"em" 英文词误判),降号归一到升号(`Db→C#`),输出对齐 `estimateKey` 格式(`'D'` / `'D#m'`)。

### 34.3 复用现成件,只新写两块
全链路:`paste 事件 → importPastedAudio(files) → uploadToLibrary(§27,自带运行态+检测) → addSampleFromSound(soundId, 空 slot)`。
- 入库 = `uploadToLibrary`/`runUpload`/`ingestSound`(studioGens.ts,§27.4/§33);建单 sample 乐器 = `addSampleFromSound`/`sampleInstFrom`;找空位 = `freeSlots`。
- **新写①**:document 级 `paste` 监听(StudioApp)。按 `f.type.startsWith('audio/')` 或音频扩展名过滤;**只有有音频文件才 `preventDefault` + 入库**,否则放行默认(不劫持文本/图片粘贴);焦点在 input/textarea/contenteditable 也零影响(只在有 file 时动手)。
- **新写②**:`ingestSound`/`runUpload`/`uploadToLibrary` 把新建的**主 soundId** 返回(非 chop=loop id、chop=歌 id;现在 `api.sounds.create` 返回没接住)。`reload` 已把新库同步写回 `ctxRef.soundsById`(StudioApp:`genHooks().reload`),故 `await` 完即可 `addSampleFromSound`,**无时序坑**。

### 34.4 行为细节
- **多文件**:Finder 可多选复制 → 依次入库,各落一个空 pad(`freeSlots(cur, n)` **一次性算好按 index 落位**,别边建边重算撞位)。pad 满则只入库 + 提示 `Imported to library (pads full)`。
- **粘贴 vs 上传按钮**:上传按钮(§27)只入库,行为**不变**;**只有粘贴**额外建乐器(避免惊扰既有上传)。
- **和既有 ⌘V 不冲突**:乐器/场景粘贴走 keydown + 内部 ref(§23/§26);文件粘贴走独立 `paste` 事件读 OS 剪贴板,互不干扰(用户没内部复制乐器时,keydown ⌘V 那两条 ref 为空自动 no-op)。

### 34.5 §15 持久化 / §16 undo 合规
- **§15**:乐器进 `sessions` 树,sync diff 自动 `inst.add + clip.add`,**零新端点**;Sound 复用 `source:'upload'` 列(§27),无新列。
- **§16**:`addSampleFromSound` 走 `mutate`(自带 `pushHistory`)→ 建乐器 = 一步可撤;**不扩 7 项口径**(乐器在口径①sessions 树)。入库本身镜像生成/上传(gen 行 + 软删口径⑦),无新机制。

### 34.6 落地顺序(每步 typecheck)
① 本节设计(doc-first)。② `audio/detect.ts` 加 `parseNameMeta`(单测:`NH_IAP_100_..._Dmaj`→{100,'D'}、`SS_AXR2_111_..._D#m`→{111,'D#m'}、`AXR2` 不误判、无 BPM/key 回 undefined)。③ `studioGens.ts`:`ingestSound`/`runUpload`/`uploadToLibrary` 回传主 soundId + runUpload 用 `parseNameMeta` 当种子。④ `StudioApp.tsx`:`isAudioFile`/`importPastedAudio` + document `paste` 监听。⑤ **测**:Splice ⌘C → studio ⌘V → 见 `uploading→detecting` 卡 → 入库(BPM/调式来自文件名)→ 单 sample 乐器落空 pad → 撤销一步去乐器 → 刷新 resume。**坑**:Splice copy 异步(~1-2s),files 空要宽容;多文件 slots 一次性算好按 index 落位。

**🚧 已码待真机验(2026-06-23)**:全链路落地 + `tsc` 干净 + `chop.test.ts` 16/16 过 + 重启 dev 编译干净。清单:
- ② [schema.prisma](web/prisma/schema.prisma) 加 `Sound.sliceIndex/sectionLabel` + `db push`(client 重生成,**dev 已重启**)。
- ③ [audio/chop.ts](web/src/audio/chop.ts)(`shouldChop`/`estimateOrigin`/`chopSong`,常量 `MAX_LOOP_BARS=32`/`DEFAULT_BLOCK_BARS=16`/`MIN_BLOCK_BARS=4`)+ [chop.test.ts](web/src/audio/chop.test.ts)。
- ④ [studioViews.ts](web/src/contracts/studioViews.ts) `GenStatus` 加 `chopping`;[studioGens.ts](web/src/studio/studioGens.ts) `ingestSound`(生成/上传共用,超阈值建歌+流式建块,共享 assetId)+ `rechopSong`;[sounds/route.ts](web/src/app/api/sounds/route.ts) 收 `parentSoundId/sliceIndex/sectionLabel`。
- ⑤ [LoopManager.tsx](web/src/studio/ui/LoopManager.tsx) 子 sound 拆块/stem 两类、块成 `BLOCKS` 组(`renderBlocks`/`renderStems`)、`Chop` 阶段条 + 琥珀 `gdot.chopping`;[ChopView.tsx](web/src/studio/ui/ChopView.tsx) + [globals.css](web/src/app/globals.css) `cv-*`;[StudioApp.tsx](web/src/studio/StudioApp.tsx) 坞分支 + `rechopBlocks`。
- **ChopView 交互实现取舍(v1)**:坞内**单视图**,故走「点歌(有块)→ 坞出总览;点波形段 = 进该块 ClipEditor(库块行同时 vsel 高亮);重开总览 = 再点歌行」。即设计 §33.6 的「双向高亮并存」降级为「段→编辑 + 行高亮」(单坞限制)。`每块 8/16/32` 实切(`rechopBlocks` → `rechopSong`),origin 标记**只读**(拖动重切待做)。
- **v1 限制(留 v2)**:盲网格无 section 标签(块名 `Block N`);origin 前 <1 小节弱起丢弃;块的 stem 再拆 kit 不出(GET 仅嵌两层);总览无内联试听(在 ClipEditor 预览);重切软删旧块 → 旧块-stem 成不可达孤儿(无害)。
- **真机实测(Chrome 注入,2026-06-23,真 Suno 数据)**:Song 自动切 **7 块**(6×16 + 1×18 余数并入)挂歌下 ✓;点歌 → 坞出 ChopView 7 段平铺、`每块=16` ✓。
  - **修 bug**:per-块分离被 §29 的 stem 门误杀(块 `stemKind=null` 但有 `parentSoundId` → 抛「Only the drums stem can be split further」502)→ [stems.ts](web/src/lib/stems.ts) 放行块(`sliceIndex!=null` → `model='full'`)。
  - **做优化(§33.3 本意)**:块共享整首 asset,原本分一块要对**整首**跑 Demucs(~1–2min)→ [app.py](stem-service/app.py) 收 `startSec/endSec` 只切块那段喂模型、块 stem 窗口重置 `[0, blockLen]`(stem asset 即那一段)。实测 30.8s 块分离 **6.0s**(提速 ~15×),4 stem(guitar/piano 近静音跳过)窗口全 `[0,1480482] bars=16` 锁相 ✓。**⚠️ 改 app.py 已重启 sidecar**(无 `--reload`)。
- **未实测**:拖块/stem 到 pad 播放、软删/undo、上传长素材路径(>32 小节走同一条 `ingestSound`)。
- **code-review 修复(2026-06-23,high effort)**:① [stems.ts](web/src/lib/stems.ts) 块分离窗口改 **warp 优先**(原 analysis 优先 → 块被 ClipEditor trim 后会分错段)。② [studioGens.ts](web/src/studio/studioGens.ts) `ingestSound` 切块前加 `stopped()` 闸 + 中途取消软删歌(免取消留孤儿歌)。③④ 重切改**硬删**旧块:[sounds/[id]/route.ts](web/src/app/api/sounds/[id]/route.ts) 加 `?hard=1`(`db.sound.delete` → 级联清块的 stem、clip SetNull),`rechopSong` 用之 → 修「undo 复活旧块成重复」+「重切泄漏 stem」。**实测**:`?hard=1` 删带 stem 的块 → 块 + 其 6 stem 级联清掉、无外键报错、其余不动 ✓。
- **缓修(非 bug,质量)**:跨设备/切声卡 SR 错位(既有 stem 机制老问题,同机已验对齐);阶段条给"不会切的 advanced 上传"也显示 Chop 段(纯视觉);`renderBlocks`/`renderStems` 与块创建 payload 的重复、`soundKind()` 统一判别、`ChopView.win`/`wavePath` 复用 —— 均留后续重构,避免一次动太多破坏在用功能。

## §35 AI 提示词助手(gen-ta 角落 ✨ → 自然语言 → Suno 提示词)—— ✅ 已码已验外部链路 · 2026-06-24

把"想要什么"用大白话写出来,LLM 翻成一行 Suno 风格提示词、写回生成框。**最小实现**,用最便宜的 qwen。

### 35.0 决策(为什么这么放)
- **位置 = app 的 `gen-ta`(左栏生成框),不是 suno.com 页面**:那才是你真正在写、再驱动 Suno 的提示词;React 原生,加按钮+浮层零成本;app 自带后端可安全托管 key。
- **LLM 走服务端路由 `POST /api/ai/prompt`**:`DASHSCOPE_API_KEY` 只在服务端读,**绝不下发前端/不进开源仓库**(对齐"自带插件不做服务端"——这里是 app 自己的后端,非 Suno 代理;Suno token 仍只在浏览器)。
- **隐私口径**:与 Suno token 不同,这里的自然语言 idea **会**经 app server → 阿里云百炼。**opt-in**:不配 key 则路由 503、前端报"未配置",生成功能照常。自托管者填自己的 key。
- **模型 = `qwen-flash`(最便宜档)**,OpenAI 兼容接口,base/model 都可 env 覆盖。
- **Sound vs Song 系统提示词分开**:Sound=单一乐器/音色的片段 loop(只描述那一个声音,~6–12 词);Song=一整首器乐曲(genre/mood/编配/能量/制作,可更丰满)。`systemFor(mode)` 切。
- **界面全英文**;且**铁律:不管用户用什么语言写 idea,输出到 Suno 的提示词一定是英文**(系统提示词强约束 + 已用中文输入实测)。

### 35.1 §15 持久化 / §16 undo 合规(零负担)
- **§15**:**无新表无新列**。idea + 结果都是瞬态组件态;唯一落点是用户点 "Use this" 时调既有 `onGenPrompt`(写 `genPrompt`,本就随 `genPrefs` 持久化)。
- **§16**:**不扩 7 项口径**。写回提示词等价于在生成框打字,不是独立可撤的交互(和 §34 同理,提示词不在 undo 范畴)。

### 35.2 实现(每步 typecheck ✓)
- **路由** [api/ai/prompt/route.ts](web/src/app/api/ai/prompt/route.ts):`getCurrentUser` 门 + `rateLimit`(用户+IP,30/min)+ key 缺失 503;两套 system prompt(`SYSTEM_SOUND`/`SYSTEM_SONG` + 共用 `COMMON_RULES`:一行逗号分隔 / 结尾 instrumental / 不写 BPM&Key / **永远英文**);去包裹引号/句末标点。
- **客户端** [api.ts](web/src/studio/api.ts) `api.ai.prompt`(单独解析 `{error}` 拿干净文案)。
- **浮层** [PromptAssist.tsx](web/src/studio/ui/PromptAssist.tsx):锚在 `.gen-ta-wrap` 下拉、backdrop 点外关、Esc 关、⌘↵ 生成;Generate → 结果模块(Use this / Redo);当前 mode·BPM·Key 当上下文带给模型(无标签、无脚注)。
- **接入** [LoopManager.tsx](web/src/studio/ui/LoopManager.tsx):`gen-ta`(高 150px)包 `.gen-ta-wrap`,右下角 `.gen-ai` 按钮装 `SparkleIcon`(glyphs.tsx 的 monochrome sparkle,吃 currentColor),`onApply = onGenPrompt`。
- **样式** [globals.css](web/src/app/globals.css):`.gen-ta{height:150px}` + `.gen-ai` **ghost**(照 `.ic`/`.proj-del`:中性 `--tx-3` rest、hover 才 `bg-2`+border、`.on` 才上 `--acc`;不再 rest 就暖色填充 → 修"太扎眼")+ `.pa-*`(照 `.fx-pop`/`.wb-ext-pop` 浮层范式)。
- **env**:[.env.local](web/.env.local)(本机,已填 key)+ [.env.example](web/.env.example)(文档化 `DASHSCOPE_API_KEY`/`QWEN_MODEL`/`DASHSCOPE_BASE_URL`)。

### 35.3 已验 / 未验(2026-06-24)
- ✅ `tsc` 干净;`POST /api/ai/prompt` 未登录 401(路由已编译+鉴权门生效);**DashScope 直连实测**:`qwen-flash` 对"dark trap…"回干净提示词、114 token(成本可忽略)、模型名/endpoint/key 全对。
- ✅ **中文输入实测**:"忧郁中国风古筝+lo-fi 嘶嘶声" → Sound 给单一古筝音色描述、Song 给整曲编配,**两者都纯英文**、都以 instrumental 收尾、未漏 BPM/Key。
- **未走真机登录 UI 流**(避免在你 DB 造测试用户/项目):✨ 按钮渲染 + 浮层开合 + Use this 写回 —— 标准 React/CSS,留你本机点一眼。

## §36 warp marker(可编辑分段 warp)—— 🚧 设计已定 · 2026-06-24

把 §6 的「单段恒速 warp」升级成 Ableton 式 **分段 warp**:在 clip 里钉若干 marker,把「源某采样」对齐到「输出某拍」,相邻 marker 之间各自线性变速 → 能把 Suno 那种「速度飘、瞬态不落格」的 loop 掰正到网格。**当前波形顶上那排橙色竖线只是检测瞬态(`analysis.onsets`,纯视觉参考,不可点);本节让它们变成可增删拖的真 marker。**

### 36.1 核心不变量
- **复杂度锁在一处**:架构是「离线渲一次 → 缓存成 WarpRender Asset → 引擎/导出/bake/stems 全只消费这条 buffer」。分段只改 `warpClip` 的渲染与「marker→渲染请求」的串联,**下游一律不动**。
- **退化即现状(零迁移)**:`warpPts` 空 = 只有「trim 起→beat0」「trim 止→beatN」两个隐式端点 = 一条恒速直线 = 今天的行为。老 clip 不动,加第一个中间 marker 才进入分段。
- **编辑边界(你定的)**:marker 增删拖**只在 ClipEditor 单 clip 预览态可用**;Song/总走带播放时 marker 层**只读**(可见、不可编辑)。避开「整首在播时热替换某 clip 分段 buffer」的竞态(复用 §31 `viewingSoundingBlock` 门的思路)。

### 36.2 数据模型
- `WarpPoint = { src: number; beat: number }`(`contracts/instrument.ts`)。
  - `src` = **绝对源采样**(与 `startSample/endSample` 同坐标系),须落在 `(startSample, endSample)` 开区间内。
  - `beat` = **距 loop 起点的输出拍**(0 = trim 起,`bars×beatsPerBar` = trim 止),须落在开区间内。
- `Clip.warpPts?: WarpPoint[]`(JSON 逃生口,与 `Sound.warp` 同款;`/api/pads` 旧读法不受影响)。`SampleWarp` 同步带上。**空/缺 = 单段**。
- 渲染用的完整控制点序列 = `[{src:startSample,beat:0}, ...warpPts(按 beat 升序)..., {src:endSample,beat:bars×bpb}]`。
- **铁律**:序列在 `src` 与 `beat` 上**严格单调递增**(不许交叉/时间倒流);每段 `beat` 跨度 ≥ 最小阈值(防除零/极端速率)。纯函数 `warpMap.ts` 负责 normalize / clamp / 插入 / 移动 / 删除,保证铁律恒成立。

### 36.3 渲染(`warpClip` 分段)
- signalsmith 的 `schedule({output, input, rate})` 是一条**输出时间线**:在 `output` 秒把播放头放到输入 `input` 秒、以 `rate` 继续(README 实测语义)。按控制点顺序排帧 → 段间相位连续地变速 = 分段 warp。
- 每个控制点排一帧:`input = srcSec_i`,`rate_i = (srcSec_{i+1}−srcSec_i)/(outSec_{i+1}−outSec_i)`(到下一点的段速);因 rate 算得自洽,下一帧 `input=srcSec_{i+1}` 是无跳变重定位。
- **loop 稳态 + 缝交叉淡化**(§6 既有技巧)保留:整条控制点序列按每圈 `targetDur` 重复排帧渲多圈,取稳态那圈,末段与 pre-roll 交叉淡化去缝。⚠ 这是本特性唯一真风险点 → 先做 spike(见 36.6 阶段 0),用真鼓 fill 排 2 段听有无段边缝/相位毛刺;不过则退回「每段单独渲 + 段边交叉淡化」兜底。

### 36.4 缓存 / 落库 / undo / stems / 导出
- **缓存键**:`realLibrary.pureSig` 末尾追加 `warpPts` 的紧凑哈希(改 marker → 自动 bust 重渲;`warp-render/route.ts` 签名同步)。
- **落库**:`Clip.warpPts` 走规范化列旁的 JSON 字段(同 `Sound.warp`),乐观更新/发件箱不变(§15)。
- **undo**:**不扩 7 项口径**——快照本就含 clips,`warpPts` 是 Clip 新字段,自动进快照(改前照常 `pushHistory`)。
- **stems**:6 条子 stem 用**同一份 `warpPts`** 渲染(src 在父子逐样本对齐 → 同映射 → 天然锁相,§沿用 stem 继承)。
- **导出/bake**:消费已渲 buffer,**不动**。

### 36.5 交互(ClipEditor 内)
- **加**:双击瞬态/波形 → 在该处建 marker(默认吸到最近 `onset`);初始与所在段共线 → 不改声,拖了才变。
- **拖**:拖 marker 横向改其 `beat` → 两侧段重拉伸;默认吸网格拍(把鼓掰到拍),**按住 Alt 吸最近瞬态**(和现有 Alt 滚轮缩放的修饰键习惯一致)。瞬时态直驱不落库,松手提交。
- **删**:双击 marker(或拖出顶栏)→ 删除,两侧段并回一段。
- 视觉:marker = 主强调色 `--acc` 菱形 pin + 1px 虚线(与 trim 的绿/橙全高实线、fade 的奶油圆点区分);拖动中升金色 `--solo` + 吸附线;段上浮 per-段速率读数(复用 `.we-box`)。trim 拖绿/橙、Shift 变速、滚轮缩放全部原样保留。
- **只读门**:Song/master 播放态 marker 层不响应指针(灰显/降透明)。

### 36.6 阶段(doc-first)—— ✅ 全部完成 · 2026-06-25
0. ✅ **spike**:真鼓 fill 手排 2 段,真机听。结论=signalsmith 单遍多关键帧 schedule 不可靠 → 采用兜底「每段单渲 + 环形 overlap-add 交叉淡化」(`/dev/warp-spike` 回归 harness)。
1. ✅ **契约 + 纯模块 + 测**:`WarpPoint`/`warpPts`、`warpMap.ts`(normalize/srcAtBeat/段速/增删移/clamp)+ `warpMap.test.ts`(退化单段逐样本一致)+ 缓存键串联。
2. ✅ **渲染**:`warpClip` 分段(`warpClipPiecewise`)+ `regionFromClip`/`WarpRequest` 串 `warpFracs`(分数控制点,timeMul 无关)。
3. ✅ **UI**:WarpEditor marker 双击增/拖钉到格/双击删 + 只读门(总走带播放中 marker 灰显不可编辑);编辑器 cps/emit/绘制/命中统一走 `normalizeWarpPts` → 所见==落库==渲染。
4. ✅ **stems + 导出**:无需新代码——stem 子 Sound 整体继承 `parent.warp`(含 `warpPts`,逐样本锁相);导出 `renderSong→buildBuffer` 与 collage `buildCollageBuffer` 都过 `warpToBuffer→warpClip(warpFracs)`,自动落地。code-review(/code-review high)修了 collage 片/fork 落库漏 `warpPts`、编辑器三套阈值不一致 + ghost pin。

## 37. Song 多轨 arranger — 主轨吸附 / Sub 轨锚定 link 模型 —— 📐 设计 · 2026-06-26

§26.1 把 Song 视图改成了「按比例 arrange 时间轴」,但只有**单条线性** lane(所有 session 首尾相接)。本节把它扩成**真多轨 arranger**:一条**主轨**(吸附线性) + 任意多条**Sub 轨**(自由摆放、寄生锚定到主 session),语义对标剪映 / Final Cut 的「主视频轨 + 副轨 linked clip」。

> ⚠ 起因:用户先自写过一版多轨(把多 lane 硬塞进 §26 的线性 block),交互/UI 双双不对——reorder 拖拽与 2D 定位互撞 → 退化成 `‹›˄˅` 微调按钮 + `+/−` 改 repeat;每块三条 tinted strip(name/nums/automation)~104px 太吵;lane 只是 scroll 内淡带、无 track header。本节是推倒重设计。

### 37.1 心智模型 — 两套时间坐标系

把「时间定位」拆成两套坐标,联动几乎全靠坐标系自动成立,**不靠监听器同步**:

- **主轨(Main lane,`songLane===0`)= 吸附序列**。只有顺序、没有自由位置。session 的 `songStartBar` 是**派生量**(=前面所有主轨 session 的 `bars×reps` 累加,按 `index` 序),无空白、无重叠。「移动」=改顺序;「变长」(repeat 或内部最长乐器变)=后面整体重排。
- **Sub 轨(`songLane>0`)= 寄生锚定**。不吸附、可放任意位。**双态定位**:
  - **锚定态**:`{ songAnchorId, songOffsetBar }` → `songStartBar = 锚 session.songStartBar + songOffsetBar`(实时派生)。主 session 一动,sub 的绝对位置跟着变——**因为它根本没有独立位置可以不同步**。
  - **孤儿态**:`songAnchorId===null` → `songStartBar` 就是它自己存的绝对小节,自由浮、不跟任何人。
- **Sub 不能 repeat**:sub session 的 `repeats` 恒 `=1`,长度 = `sessionBars`(单遍)。UI 上 sub clip **无右缘 repeat 手柄**。

一句话:**`songStartBar` 退化成「派生缓存」**——不再是用户直接编辑的自由量,而是每次 mutation 后由 `resnapSong()` 按上面的规则重算(主轨累加 / sub 锚点+偏移 / 孤儿保留)。回放与导出继续直接读 `songStartBar`(绝对小节),零改动。这正合 §15:第一公民结构关系(`songAnchorId`/`songOffsetBar`/lane)规范化落列,`songStartBar` 当反规范化缓存。

### 37.2 Track 实体 — 命名 arrangement track

lane 不是匿名层号,是**用户命名 + 上色**的 arrangement track。挂工程级(§15 JSON 逃生口,同 `fx`/`gridPrefs`):

```ts
interface SongLane { id: string; name: string; color: string | null }
// Project.songLanes: SongLane[] | null   —— 有序;index 0 = 主轨(始终存在,不可删空到 0)
// Session.songLane 仍是 lane 序号(0=主轨),= songLanes 的下标
```

左侧固定 **track gutter** 从 `Project.songLanes` 渲(**允许空 track**:命名了但还没 clip);不再 `max(songLane)+1` 推导 lane 数。表头 = 名字(双击改名) + 色点 + mute/solo(后续接 §18 路子)。

### 37.3 数据模型 delta(Session)

```ts
interface Session {
  // 现有:id,name,index,repeats,color,xyAuto,instruments,songLane
  songLane?: number;        // 0=主轨;>0=sub 轨(= songLanes 下标)
  songStartBar?: number;    // 🔁 语义变:派生缓存(resnapSong 重算),非自由量
  songAnchorId?: string | null;  // 🆕 sub 锚定的主 session id;主轨/孤儿 = null
  songOffsetBar?: number;        // 🆕 sub 锚定态:相对锚 session 起点的偏移(≥0)
}
```

主轨吸附顺序复用 `index`(场景列表序),不另立字段:`resnapSong` 取 `songLane===0` 的 session 按 `index` 排,累加得各自 `songStartBar`。

### 37.4 联动矩阵(已拍板)

设 sub `S` 锚到主 session `A`:

| 主轨对 A 的事件 | 锚定态 sub | 孤儿态 sub |
|---|---|---|
| 移动(改序)/ A 前块增删变长 / 改 repeat / 内部最长乐器变 bars | 相对 `offset` 不变 → 绝对位置**自动跟随**(`resnapSong` 重算 A.start 即可) | 不动 |
| **复制 A→A'** | link 到 A 的 sub **各跟一份**(克隆成独立 sub,锚 A'、`offset` 不变,**不按 repeat 铺**) | 不动 |
| **删除 A** | **脱锚变孤儿**:`songOffsetBar` 固化成绝对位置写进 `songStartBar`、`songAnchorId=null`,停原地 | — |
| 用户横向拖 S | 落点起点落在某主 session 区间 → **重锚**它(`offset=起点−该.start`);落在主轨范围外 → 变孤儿 | 同左,可重新获锚 |

**已拍板边界:**
1. **被动变化不重锚**:主 session 变长/短/移时,锚定 sub 只跟相对 `offset`,**不主动改锚**——即便 `offset` 超出 A 尾、视觉压到后面 B 上方,仍 link A。**只有用户主动拖 sub** 才按落点重锚。
2. **主轨 → sub**:默认**移动**(主轨塌缩补位);按住 **Alt** = **复制**(主轨原块留,sub 新增**独立**副本/全新 id 独立乐器)。两种都 `repeats` 清 1(repeat 信息丢失,破坏性 → 必 `pushHistory` 可 undo)。
3. **sub → 主轨**:插回吸附序列(按落点定 `index`),`repeats` 默认 1,清 `songAnchorId`/`songOffsetBar`。
4. **同 lane 禁叠放(全路径守恒)**:同一 sub lane 内两块不得相交(相交会一起出声)。**主动拖** = 落点(按夹后最终落点判定,不是裸 vbar)若与同 lane 他块相交 → 放置失败弹回 + 提示。**自动路径**(夹随 / 删主块 / 改 reps)不能弹回 → `resnapSong` 内夹后再**顺次往左堆**:同锚同 lane 子轨全被夹到末端时,最右块留夹后位、左侧块依次让到前块之前(bounded ≥0)。只动派生 `songStartBar`、不改存储 `songOffsetBar`(加长复原即回原位 → 可逆);孤儿不参与(手动放置、冻结原地)。

### 37.5 交互(DAW arrangement,直接操作取代按钮)

- **拖块身** = 2D 移动:横向吸 bar、纵向换 lane;松手按落点定主轨 `index` 或 sub 锚定/孤儿(见矩阵)。删除旧的 `‹›˄˅` 微调 + HTML5 reorder。
  - **主轨 reorder = 看鼠标、不看块左缘**:插入位由**鼠标所在小节**(`songBarAt(clientX)` → `cursorBar`)与邻块**中心**比较得出,不是被拖块投影起点 `vbar`(抓宽块右半边时左缘滞后 → 换位不跟手)。被拖块**浮在鼠标下跟手**(`vbar`,`.dragging` 浮起样式)、其余块靠 `.song-reflow` 过渡**让位开空**、`song-drop-ghost` 占位指示落点,松手落进空位(Trello/dnd-kit reorder 范式)。
  - **子轨拖拽**:被拖块渲染在**夹后落点**(受约束放置显落点能避免误跳,见 §37 #2),与浮动 reorder 分治。
- **拖右缘**(仅主轨块) = 增减 `repeats`(吸到 `bars` 整数倍)。删除 `+/−` 按钮。
- **点** = 选中(下方 pad grid 载它编辑);**双击名** = 改名;色点 = 换色。
- **Del/⌫** = 删(主轨块连带其 sub 脱锚)。
- 锚定关系画**虚线**:从 sub clip 起点连到锚 session 起点;孤儿 = 虚框 + `⚲` 标记、无连线。
- **顶部 ruler** = bar 号 + 点 bar 起播 + 单播放头穿全 lane(沿用 §26.9)。**Alt+滚轮**缩放、滚轮平移(沿用 §26.9 `RailScroll`)。
- **Automation** = clip 内 overlay 细曲线(`∿` toggle 时显;完整编辑仍在选中 clip 下方 pad 区的 `AutomationLane`),不再每块塞一条占高。

### 37.6 回放 / 导出(几乎零改)

`songActiveAt(bar)` 已是「`[start,end)` 含 bar 即发声」的纯几何判定,sub clip 只要 `resnapSong` 给了正确 `songStartBar` + `sessionBars`,**现有引擎(§37 `playingSongIds` 多块并发 + lookahead 预载)直接发声、无需改回放**。导出 `exportSong.planSong` 同理读 `songStartBar`,自动正确。改动只在「`songStartBar` 从存储值变成 resnap 产出」这一层,对下游透明。

### 37.7 持久化

- **Project 级**:`songLanes Json?` 列(prisma `Project`),走 `PATCH /api/projects/[id]` 白名单 + `ApiProject` + `Project` 契约 + page prop。
- **Session 级**:`songAnchorId String?` + `songOffsetBar Int @default(0)` 两列(prisma `StudioSession`),进 `sync.ts` `NSession`/`SESS_FIELDS`/`normalize` + `api/studio/route.ts` 读 + `api/studio/ops` `SESS_COLS`。`songStartBar` 列保留(派生缓存照常落库,导出/回放读它)。
- 迁移:加列(additive,默认安全);老数据 `songAnchorId=null` 全是主轨/孤儿,`resnapSong` 首跑把主轨重排成吸附(`songLayoutVersion` 再 +1 标记)。

### 37.8 Undo 口径

`pushHistory` 快照已含 sessions 全字段(`songLane`/`songStartBar`/新 `songAnchorId`/`songOffsetBar` 随快照走);需把 **`Project.songLanes`**(track 增删/改名/换色/重排)纳入快照口径(见 §16 + [[undo-constitution]])。破坏性操作(删主块级联脱锚、Alt 复制、主↔sub 转换、改 repeat)改前一律 `pushHistory`。

### 37.9 阶段(doc-first)

1. 📐 **文档**(本节)。
2. 🔜 **契约 + 纯 link 模块 + 测**:`Session` 加字段 + `SongLane` 类型 + `studio/songLayout.ts`(`resnapSong`/`mainOrder`/`reanchorAt`/`detachToOrphan`/`laneCount` 纯函数)+ `songLayout.test.ts`(联动矩阵逐条断言)。**不接 UI、不翻行为**。
3. 🔜 **持久化**:prisma 加列/迁移 + sync/api 三处 + project songLanes。
4. 🔜 **UI 重写 + 回放接通 + undo**:track gutter + ruler + pointer-drag(移动/重锚/resize/删/Alt 复制)+ automation overlay;接 `resnapSong` 让行为切换与新 UI 原子落地;扩 undo 口径。
5. 🔜 **review**:真机点测拖拽/重锚/孤儿/Alt 复制 + stems/导出回归。

## 37.10 Live 场景卡对齐 §37(顶栏 session 块重画)—— 📐 设计 · 2026-06-28

§37 把 Song 视图重做成主/Sub 多轨 arranger 后,Live 顶栏的场景卡(`.scard`)还停在 §20 老设计(三行:头条 + 乐器色块墙 + `N inst` 文字),且对主/Sub/孤儿模型完全无感——一个 Sub-overlay 在 Live 里和正经主场景长得一样、点一下就当整曲启动,语义错。本节把 Live 卡的**设计语言**对齐 §37 的 `.sblock`,但**不照搬其职能**。

> Live 和 Song 共用同一个 `sessions.map`(`StudioApp.tsx`),分叉出 `.scard`(Live)/`.sblock`(Song)两套 DOM;颜色身份(`sessionColor` 绑 id,见 [[session-color-identity]])早已统一,是本对齐的地基。

### 37.10.1 原则:对齐「身份」,不对齐「职能」

- **Live = 场景启动器**(Ableton Session view):一次启动**一个**场景,无时间轴/lane/并发;场景无限循环到切走为止。
- **Song = 编曲时间轴**(§37 arranger):2D 定位、时长、repeat、主/Sub 并发。

故 **repeat 微调 / 2D 摆放 / 锚定虚线**是 Song 职能,**Live 不要**(repeat 在 Live 无意义,保持不对齐是对的)。要对齐的是「同一个场景在两视图里读起来是同一个东西」——身份、信息集、交互词汇。

### 37.10.2 卡片解剖(对齐 `.sblock` 的「tinted 头条 + 内容带」二段)

**头条 = `.sblk-name` 逐字搬**:同 `color-mix(--c 50%, --bg-1)` 底 + `color-mix(--c 52%, --line)` 下边框,顺序 = 色点 · 名字(`color-mix(--c 30%, --tx)`)· **乐器数胶囊** · `Nb`。
- 乐器数胶囊**复用 `SongInstrumentCount`**(active/total + hover portal 弹乐器名单);样式同 `.sblk-icount`。
- **删掉**旧版第三行 `N inst` 文字(被胶囊取代)。

**内容带 = Live 专属富信息**(Song 此处是数字条,Live 无 repeat 语义):
- 乐器**色块预览**(沿用 `.sc-chips`,对应下方 pad 颜色)。
- 一行 meta:**automation chips**(`PROG_LABEL/PROG_COLOR`,同 `.sblk-achip` 的字母方块,标该场景挂了哪些效果——`xyAuto` 在 Live 同样为真,旧版白漏)+ Sub/孤儿标记。

### 37.10.3 主/Sub/孤儿在 Live 的呈现(**已拍板:全列 + 打标**)

Live **列出全部场景**(主轨 + Sub + 孤儿,不藏),保留每个场景可选中/可编辑;Sub/孤儿**降级显示**并带 §37 同款标记。点 Sub = 单独启动它(退化但无害,就是放它自己那几件乐器)。
> 否决「只列主轨、Sub 仅在 Song 出现」:那样 Live 下无法选中/编辑 Sub 场景的乐器(得回 Song),把场景藏起来代价更大。

- **Sub 卡**:略窄、name 条减淡(`color-mix(--c 38%, --bg-1)`)、meta 行带 `↳ Sub · {laneName}`(轨名取 `laneName(lane)`,与 §37 gutter 表头同名)。
- **孤儿卡**:虚线边 + `⚲`,镜像 `.sblk-orphan` 的 `border-style:dashed` + 减淡 name 条。

### 37.10.4 状态(对齐 §37 视觉语言)

| 态 | Live 卡 | 对齐点 |
|---|---|---|
| 选中 `.on` | **不改边框/不抬灰底**,内容带(`.sc-body`)翻成 `color-mix(--c 35%, #fff)` 高明度同色淡彩 + 压深其上浅色文字(`+N`/`↳轨名`)+ 乐器数胶囊微提 | 逐字镜像 `.sblock.sblk-sel`(Song 选中 = 数字条染白、不动边框);Live 内容带 ↔ Song 数字条 |
| 播放 `.playing` | **不变色**,只 `--play` 播放头竖线(`SessionPlayhead` 已在)+ 角落电平条 | §37「播放态只看播放头线」 |
| 排队 `.queued` | `--queue` 呼吸边(`clippulse`)+ `queued` 字样 | 两模式共用 `clippulse` |

> 旧版 Live 选中 = 白描边 + 抬灰底,与 §37 Song 选中(去白边、内容带染白)不一致;2026-06-28 改为镜像 `.sblk-sel`,两模式选中观感统一。

### 37.10.5 排序与 reorder

- Live 一排按 **Song 阅读序**渲染:主轨按 `index` 在前,锚定 Sub 紧跟其锚场景分组(不再按数组裸下标交错)——两视图讲同一个故事。
- Live 拖卡 reorder 改的就是 §37 主轨 `index` = **重排歌曲段落**(同一操作)。约束:reorder 限主轨内;拖 Sub 卡不在 Live 里悄悄插进主序列(改 lane 得回 Song)。
- 选配打磨:把 Live 的 HTML5 DnD 换成 §37 指针拖 reorder,手感统一(非必须)。

### 37.10.6 落地(数据零改,UI-only)

改动几乎全在共用 `sessions.map` 的 `playMode !== 'song'` 分支 + 一段 `.scard` CSS:
- JSX:头条换成 `.sblk-name` 同构(色点 · 名 · `SongInstrumentCount` · `Nb`);删 `N inst` 行;内容带加 automation chips + Sub/孤儿标记;排序对齐。
- CSS:`.scard` 头条 tint/边框对齐 `.sblk-name`;新增 `.scard.scard-sub`(减淡+窄)/`.scard.scard-orphan`(虚线);复用 `.sblk-achip`/`.sblk-icount` 视觉。
- **无 schema / 无 undo 口径变化**(纯渲染;`xyAuto`/`songLane`/`songAnchorId` 已在快照口径,见 [[undo-constitution]])。
- 高保真稿:见本次会话 mockup(Song block 参照 + Live 全状态卡 + before→after)。

## 38. 项目导入/导出(用户级 · 带音频字节的单文件 zip)—— 📐 设计 · 2026-06-28

**一句话**:让任意用户在「My projects」列表页把**自己的一个项目**导出成一个**自包含的 `.zip`**(工程子图 + 它引用到的全部音频字节),并能把这样一个 zip **导入覆盖掉某个自己的项目**——整个 sessions/乐器/clip/库全换成 zip 里的内容。本质 = **§30 那套已验证的打包/导入逻辑,从「运维 CLI + 示例母版」推广成「app 内 + 普通项目 + 当前用户所有权」**,外加把 bundle 目录压成单文件 zip + 一个覆盖警告 dialog。

### 38.1 与 §30 的关系(复用什么、改什么)
§30(`export-example.mjs`/`import-example.mjs`)已把**最难的算法**做完并 round-trip 测过:依赖子图收集(对齐 [`forkProject.ts`](web/src/lib/forkProject.ts))、`loadSoundsWithParents` 的 stem 父→子拓扑序、`Asset` 按 **sha256 内容寻址去重**、ID 重映射(sound/asset/§37 anchor 按 index)。`bundle.json` 的 schema **原样复用**(`formatVersion:1`)。本节只改三处口径:

| 维度 | §30(示例母版,运维) | §38(普通项目,用户) |
|---|---|---|
| 触发 | super-admin 跑 `node scripts/*` | 列表页卡片上点按钮(任意登录用户) |
| 所有权 | 导入归**线上站长** | 导入归**当前登录用户**(`getCurrentUser`) |
| `isExample` | 强制 `true`(母版) | 恒 `false`(普通项目) |
| 落地语义 | **新建**一个母版 | **覆盖选中的现有项目**(原地,project id 不变) |
| 打包物 | 一个目录(`bundle.json`+`audio/`) | 一个 **`.zip`**(同样两部分压进去) |

### 38.2 共享模块:`web/src/lib/projectBundle.ts`(TS,服务端)
把序列化/反序列化从 .mjs 抽成一个 TS 模块,供两个新 API 路由调用(.mjs 运维脚本暂保留不动——它们直连 prod DB+FS,是另一条跨环境链路;逻辑镜像,接受这一份小重复)。导出:
- `type ProjectBundle`(= §30 `bundle.json` 形状,`formatVersion:1`,`isExample` 字段不写——导入端忽略)。
- `collectBundle(projectId): Promise<ProjectBundle>`:照 §30 export 步骤拉子图(Project 标量 + Session→Inst→Clip 树 + PadClip + `loadSoundsWithParents` + 收齐 `assetId/bakedAssetId`→`Asset` 行)。**逐字对齐 forkProject 的 include/orderBy**,别新增/漏列。
- `readAssetBytes(asset)`:从 `storageAbs(asset.path)` 读字节;任一缺文件 → 抛错(中止导出,不产残包)。
- `overwriteProjectFromBundle(projectId, userId, bundle, audioBySha)`:见 38.4。

### 38.3 Bundle = zip(单文件)
- 用 **`fflate`**(极小、同步、零原生依赖;`npm i fflate`)。
- zip 内部布局沿用 §30:`bundle.json`(子图所有行,每个 asset 带 `sha256/kind/contentType/bytes`)+ `audio/<sha256>.mp3`(引用到的全部字节,内容寻址天然去重)。
- 导出在服务端 `zipSync({ 'bundle.json': …, 'audio/<sha>.mp3': … })` → 一个 `Uint8Array` 直接当响应体。
- 文件名:`<项目名 slug>.sgproj.zip`。

### 38.4 导入 = **覆盖**(命门:同库原地替换,不是新建)
§30 import 是**新建**;§38 是**原地覆盖一个已存在的、属于当前用户的项目**。`overwriteProjectFromBundle` 在一个事务里(读字节/落 Asset 在事务外,同 §30):
1. **Asset 去重落地**(事务外):每个 bundle asset → `db.asset.findUnique({sha256})`,有则复用,无则写 `storage/audio/<sha>.mp3` + 建 `Asset` 行(等价 `putAudioAsset`)。得 `老assetId→线上assetId` 映射。
2. **删旧子图**(事务内):删该 project 的 `StudioSession`(级联到 instrument/clip)+ `PadClip`。**`Project` 行本身保留**(同 id、同 `userId`、`updatedAt` 自动刷新),只 `update` 它的标量/JSON 列为 bundle 值。
3. **建新 Sounds**:bundle.sounds(父在前)→ 新 `Sound` 行,`userId=当前用户`、`originProjectId=本项目`、`genId=null`、`parentSoundId` 走 soundMap。得 `老soundId→新soundId`。
4. **重建 Session 树 + PadClip**:嵌套 create(自动新 id),`soundId` 走 soundMap、`assetId`/`bakedAssetId` 走 assetMap,§37 sub anchor 二遍按 `songAnchorIndex→新id` 重映射。
- **旧库 Sound 不删**:`Sound` 是用户级共享库,可能被该用户**其它项目**的 clip 引用(跨项目复用是合法的),覆盖一个项目不能殃及。代价:反复覆盖导入会在库里累积来源同为本项目的旧 Sound 行(字节因 sha256 去重不重复占盘)。v1 接受;若日后嫌乱,可加「软删 `originProjectId==本项目` 且无任何 clip 仍引用的旧 Sound」的清理(需跨项目引用校验,从严)。
- **校验**:bundle 缺 `formatVersion`/`project`/必需数组 → 400;`assetId` 不在 `bundle.assets` → 抛错回滚整个事务(覆盖是全有或全无,绝不留半张图)。

### 38.5 API 路由(都要 owner 鉴权)
- `GET /api/projects/[id]/export`:`getCurrentUser` → 查 project,**`project.userId !== user.id` → 403**(只能导自己的;别人的只读示例先 fork 再导)→ `collectBundle` → zip → `new Response(zip, { headers: { 'content-type':'application/zip', 'content-disposition': attachment; filename } })`。
- `POST /api/projects/[id]/import`:**分块**接收(见 38.5.1)。`getCurrentUser` → **owner 校验同上 403**(覆盖的必须是自己的项目)→ 每块追加到临时文件,final 块 `unzipSync` 整体解包 → 校验 → `overwriteProjectFromBundle`。返回 `{ id }`。

### 38.5.1 ⚠ 命门:大 body 上传必须分块(实测踩坑,2026-06-28)
Next 15 对 route handler 的 **raw body 在 10MiB 处硬截断**(`req.arrayBuffer()`/手动读 stream 都只拿到 10485760 字节,实测确认);改走 `req.formData()` 能读全 38MB,但触发 **undici「Failed to parse body as FormData」**解析 bug(Node/undici 版本相关)。两条内建路径在带音频的项目(动辄几十 MB)上都死。**结论 = 客户端分块**:`api.projects.importReplace` 把 zip 切成 **8MiB 块**,带 `uploadId`(client `crypto.randomUUID`)+ `final` 逐个 `await` POST(顺序到达保证拼接序);服务端把每块 `appendFile` 到 `storage/tmp/import-<uploadId>.part`(`uploadId` 正则 `^[A-Za-z0-9-]{8,64}$` 防穿越),`final` 时读全量临时文件解包覆盖,`finally` 删临时文件。导出方向无此问题(response body 不限 10MiB,38MB 下载实测正常)。**已知遗留**:中断的上传会在 `storage/tmp` 留 `.part` 残片(无定期清理);`zipSync`/`unzipSync` 同步 + 全量入内存(上限 500MB),超大项目会阻塞事件循环/吃内存(可改 fflate 异步 API)。

> **⚠ §36 warpPts**:§30 那两个脚本写于 §36(可编辑分段 warp)之前,clip 序列化**漏了 `warpPts`** —— 经 §30 发布的母版会丢分段 warp。§38 的 `projectBundle.ts` 已补上(导出/导入都带),比 §30 脚本更全;§30 的 `export-example.mjs`/`import-example.mjs` 同样该补(已挂 task)。

> **覆盖导入的孤儿 Sound**:实测确认覆盖导入**不删**旧 Sound(库级共享,见 38.4)→ 反复覆盖同一项目会在库里累积上一次导入的、来源同为本项目的未引用 Sound 行(clip 仍只引用本次的;字节因 sha256 去重不重复占盘)。对「恢复/回滚本项目」这一主用例,库浏览器会看到累积的废 Sound。**待定**:是否在覆盖时软删「originProjectId==本项目 且无任何 clip 引用」的旧 Sound(需跨项目引用校验)。

### 38.6 UI(列表页 `Workbench.tsx`)
- **入口收敛进 ⋯ 菜单**:目前只有 super-admin 自己的项目才有 ⋯ 菜单(发布/删除);普通 owned 项目只有一个删除按钮。改成**所有 owned 项目都给 ⋯ 菜单**,菜单项:`Export`(下载 zip)/ `Import (replace)…`(选 zip 覆盖)/ `Delete project`;`Publish as example` 仅 super-admin 保留。只读示例(`!owned`)维持单个「从列表移除」按钮,**不给导入/导出**。
- **Export**:点 → 直接 `<a download href="/api/projects/{id}/export">` 触发(GET 带 cookie 即鉴权);或 fetch→blob→ 复用 [`ExportDialog`](web/src/studio/ui/ExportDialog.tsx) 里的 `download()`。
- **Import (replace)**:点 → 隐藏 `<input type=file accept=".zip">` → 选文件 → **`askConfirm`(`danger`)弹我们的 `ConfirmDialog`**:`Replace "<name>" entirely?` / `Everything in this project — sessions, instruments, and its sounds — will be replaced by the imported file. This cannot be undone.` → 确认 → multipart POST → 成功 `reload()`。
- 文案全英文(对齐现有 UI)。

### 38.7 §15 / §16 / §25 合规
- **§15**:导入是**一次性批量服务端写**(非逐 op 乐观更新)→ 不走 `/api/studio/ops` 发件箱;产物落既有规范化表 + 全局 `Asset`,**口径不扩**。导出纯只读。
- **§16 undo**:导入覆盖**不可撤销**——它整体重建项目,且用户随后会重新进入/重载该项目,内存 undo 栈本就重置。**`ConfirmDialog` 警告即唯一安全闸**(同 §30 结论:运维/批量重建不进 undo)。
- **§25**:owner 鉴权确保只能导出/覆盖自己的项目;导入产物 `isExample=false`、归当前用户,与示例 fork 链路互不干扰,**forkProject/autosave 一行不用改**。
- **多租户 scoping**([[persistence-constitution]]):导入所有新行 `userId=当前用户`,`Sound` 落当前用户库,**绝不让导入项目指向别人的库**(正是 §23/forkProject 连库克隆的同一铁律)。

### 38.8 落地顺序(每步 typecheck)
① 本节(doc-first)。② `npm i fflate`。③ `projectBundle.ts`:`collectBundle`(镜像 export-example)+ `overwriteProjectFromBundle`(覆盖语义)+ zip 读写。④ 两个 API 路由(owner 403 鉴权)。⑤ `api.ts` 加 `projects.export/import` 客户端方法。⑥ `Workbench.tsx`:所有 owned 项目上 ⋯ 菜单 + Export/Import 项 + 覆盖 `askConfirm` + file input。⑦ CSS(复用现有 `proj-menu`/`mi`)。⑧ 测:导出真实项目 → zip 引用完整 → 覆盖导入回**同一项目**(子图全换、音频不 404、collage 不重 bake、stem 锁相)→ 覆盖导入到**另一个**自己的项目(原项目不动)→ 别人的只读示例无导入/导出入口 → 非 owner 调 API 得 403 → 反复导入幂等(asset sha256 复用)。

## 40. Session 内容链接(Figma 式 Component / instance,改一处全更新)—— 📐 设计 · 2026-06-29

**一句话**:让一个 session 成为另一个 session 的**活副本(linked instance)**——它不存自己的乐器,而是**实时引用一个 master session 的乐器**;编辑任一处(master 或任一 instance)=改 master,**所有 instance 一起变**(verse/chorus/verse/chorus:副歌摆三处、改一次三处全更新)。一条 **"Make unique"** 把某个 instance **脱链**成独立副本(从此各漂各的)。语义对标 Figma 的 Component / Instance / Detach、FL Studio 的 pattern + "Make unique"。

### 40.1 定位:复用模式的 2×2,本节补"项目内 · 链接"那一格

「母版→衍生」在本产品里是同一个模式的四格组合。已实现三格,本节补第四格(已拍板 **项目内复用**,不碰跨用户):

| | 项目内(同用户 · 共享 Sound 库) | 跨用户(必须连库克隆) |
|---|---|---|
| **复制**(独立快照,互不影响) | §23 copy/paste · §37 复制 A→A' —— `cloneInstrument` | §25 示例 fork-on-open —— `forkProject`(连库克隆) |
| **链接 / 原型**(改一处全更新) | **§40(本节)** —— 复用 `cloneInstrument` + §40.3 接缝 | (留白:"活示例" = §25 v2 "重置到最新",跨用户传播,与本节两码事) |

**为何不碰跨用户**:示例(§25)的命门是 `Sound` 用户级、fork 必须连库克隆;§40 的 master 与 instance **同项目同用户、共享同一 Sound 库**,故 detach 直接复用 §23 的 `cloneInstrument`(共享 `soundId`),**不需要** `forkProject` 那把刀。这是把复杂度锁在最小面的关键取舍。

### 40.2 心智模型 — instance = 纯占位,内容寄生 master

- 任何 session 都可能是 master(它只是恰好有别的 session 指着它的普通 session)。
- **instance** = `contentLinkId` 指向同项目某 master 的 session。**instance 自己不存乐器**(`instruments` 恒空数组,DB 里零 `StudioInstrument` 子行)。它的内容 = 运行时经 §40.3 从 master 解析。
- **共享的只有"乐器列表"这一项**。instance **自己拥有**的是**占位 / 身份 / 编排**:`name`、`color`、§37 的 `songLane/songStartBar/songAnchorId/songOffsetBar/repeats`、(开放:`xyAuto`,见 §40.10)。→ 同一段内容可在歌里多处出现、各有各的位置/名字/颜色,但乐器一改全改。这正是 Ableton「同 clip、不同 arrangement 位置」的味道。
- **只一层**:master 必须是非 instance(`contentLinkId==null`)。禁止 instance 链 instance、禁止自链(§40.7 完整性)。

### 40.3 解析接缝 —— 已铺好(`resolveInstruments`)

消费侧读乐器的唯一口子 `resolveInstruments(s, ctx?)` 已落地(2026-06-29,纯接缝零行为变化,见 [`contracts/instrument.ts`](web/src/contracts/instrument.ts) + 当时的回放/导出/算长度/波形 ~24 处消费点改造)。本节只需把它**接活**:

```ts
export const resolveInstruments = (s, ctx?) =>
  (s.contentLinkId && ctx?.bySessionId) ? resolveInstruments(ctx.bySessionId(s.contentLinkId)!, ctx) : s.instruments;
```

- `ctx = { bySessionId: (id) => sessionsById.get(id) }`,在消费边界由当前 sessions 数组建一个 `Map`(`useMemo`)传入。今天传 `undefined` 的那些点,届时补传 `ctx`。
- **编辑 / 写乐器、§395/§399 跨 session 反查归属**仍直接操作真 session,**不经** `resolveInstruments`(接缝注释已写明)。
- `sessionBars` / `activeInstruments` 内部已转调 `resolveInstruments`,故"instance 的长度 = master 的长度"、"instance 的激活乐器 = master 的激活乐器"自动成立。

### 40.4 编辑路由 —— "编辑 instance = 编辑 master"

instance 没有自己的乐器,所以 pad 网格对它的一切**内容编辑**(toggle enabled / 加删乐器 / 改 clip / mixer / sends / collage…)都必须落到 master:

- **选中一个 instance 进编辑器时,把"被编辑的 session"重定向到它的 master**(`editTargetId = s.contentLinkId ?? s.id`)。所有现有的 `mutate`/`updateSession`/copy/paste/move/patch 路径(§40.3 列的 (B)/(C) 直读站点)照旧操作那个真 session(=master),**一行不改、无感**。
- 网格显示的乐器走 `resolveInstruments`(= master 的),故"看到的"与"改到的"是同一份。
- **per-instance 的量**(name/color/position/repeats)仍写 instance 自己 —— 它们不是内容,不路由。
- 多个 instance + master 全部反映同一次编辑,**因为它们都解析到同一个 master**,无需广播/监听(同 §37「靠坐标系自动成立、不靠监听器」的哲学)。

### 40.5 建 instance · 脱链(detach / "Make unique")

- **建 instance**:在 session 复制入口(§37 复制 A→A' / §23 copy/paste)旁加一档选择 —— **"Duplicate"**(独立副本,现状)/ **"New instance / Duplicate as linked"**(新建一个 `contentLinkId = 源的 master(源本身是 instance 则取其 master,保证只一层)` 的空乐器 session,占位取不撞色/紧邻落位,同 §37)。
- **detach = "Make unique"**(instance 右键 / ⋯ 菜单):把 master 的乐器**逐件 `cloneInstrument`(全新 id)克隆进自己**、清 `contentLinkId` → 从此是独立"复制"(2×2 左上格)。**直接复用 §23 的 `cloneInstrument`**(同库共享 soundId,成立);**不碰** `forkProject`。
- 破坏性(detach 改内容归属 / 建链清空乐器)→ 改前一律 `pushHistory`。

### 40.6 删 master → instance 自动脱链(镜像 §37 删主块脱锚)

删一个被链接的 master:**先把它的每个 instance 就地 Make-unique**(克隆 master 乐器进各 instance、清 `contentLinkId`),**再**删 master。→ instance 全部存活成独立副本,内容冻在删除那刻。语义/手法与 §37「删主块 → 锚定 sub 脱锚变孤儿」一致。一次复合 mutation,`pushHistory` 一次可整体 undo。

### 40.7 ⚠ 命门:voice id 碰撞(同一 inst.id 不能在两个并发块同时出声)

§37 Song 多块并发(`playingSongIds`)成立的隐含前提是**乐器 id 跨块全局唯一**——每个 session 有自己的乐器,id 不撞,引擎按 `inst.id` 建 voice 即可。**content-link 打破这条**:master 与它的 instance(或两个 instance)引用**同一批 `inst.id`**;若它们在 Song 时间轴上**重叠出声**,引擎那张 `voices: Map<instId, …>` 无法让同一 id 在两个不同相位 offset 同时发声(导出端 `bufKey=sessionId|instId` 已天然分开,**只 live 引擎撞**)。

两条路:
1. **v1(推荐 · 小):禁止 master 与其 instance、及同 master 的 instance 之间在时间轴重叠**。理由:它们内容完全相同,重叠 = 相位叠加(梳状/加倍),音乐上本就几乎无意义。落点判定复用 §37 既有的「同 lane 禁叠放」机制,扩成「同内容族禁叠放」(跨 lane 也查)。主动拖重叠 → 弹回 + 提示;自动路径(改 reps/删块)→ 同 §37 顺次堆叠避让。**够用且简单**。
2. **v2(深 · 大):引擎 voice 改按 `sessionId|instId` keying**(对齐导出端),让同内容在两处各起一个 voice。需动 `studioEngine` 的 voice map / `setWantOn` / `swapVoicesAt` / `retainOnly` 全链 —— 一截大改,留作真有"同内容叠层"需求时再做。

**v1 接受重叠限制**,把它写进 arranger 放置校验。

### 40.8 undo / 持久化

- **持久化**:`StudioSession` 加 `contentLinkId String?`(additive 迁移,默认 null);进 `sync.ts` 的 `NSession`/`SESS_FIELDS`/`normalize` + `api/studio/ops` 的 `SESS_COLS`(同 §37 那三处加列的套路)。instance 落库 = `contentLinkId` 设值 + 零乐器子行。**改列后必重启 next**(见 [[prisma-stale-client-restart]])。
- **undo(§16)**:`contentLinkId` 随 sessions 快照走(口径不扩);detach = 克隆乐器 + 清链 = 普通 session update,既有快照天然覆盖;删 master 自动脱链 = 一次复合 mutation 前 `pushHistory`。**结论同 §23/§25:不扩 7 项口径**。
- **回放/导出(§40.3)**:消费边界补传 `ctx` 即正确,引擎/导出内部零改(除 §40.7 的 v1 放置校验)。

### 40.9 UI

- **instance 视觉**:Song 块 / Live 卡上给 instance 一个**链子标记**(⛓ / 实心角标)+ 一条**虚线连到 master 块起点**(复用 §37 锚定虚线那套渲染)。master 可加一个"有 N 个 instance"的弱提示。
- **菜单**:instance 上 `Make unique`(脱链)/ `Select master`(跳到 master);可链 session 的复制处给 `Duplicate` vs `New instance` 两档。
- **编辑器提示**:选中 instance 时编辑器顶部一行 "Editing shared content of «master name» — changes affect N instances",免用户误以为在改局部。

### 40.10 开放问题(留待落地前定)

- **`xyAuto` 归属**:算"内容"(跟 master 共享)还是"per-occurrence 表演"(留 instance 各自)?倾向**留 instance**(同一段乐器、副歌每次的 XY 扫法可不同 = 表演层),但需确认。**v1 先定:`contentLinkId` 只共享乐器列表,其余全 per-instance**。
- **悬挂链**(master 被非常规路径删掉、`contentLinkId` 指空):`resolveInstruments` 找不到 master → 回落自己的空数组 → instance 静音。§40.6 的自动脱链是正路,悬挂只是防御;`resnap`/加载时可顺手把悬挂链清成独立空 session。
- **跨内容族叠放**(§40.7 v1 禁的是"同 master 族";不同族正常并发,无碰撞)。

### 40.11 落地顺序(doc-first)

① 本节。② **接缝接活 + 纯逻辑 + 测**:`resolveInstruments` 加 `contentLinkId` 解析分支 + cycle/一层 guard;`Session` 加字段;detach/建链/删 master 自动脱链做成纯函数(`sessionDoc.ts`,复用 `cloneInstrument`)+ 单测(建链→instance 解析=master、改 master→instance 跟变、detach→断开各漂、删 master→全脱链存活、自链/二层链被拒)。**不接 UI、不接引擎**。③ **持久化**:prisma 加列/迁移 + sync/ops 两处 + 重启 next。④ **消费边界传 ctx**:§40.3 那些点建 `bySessionId` Map 传入;§40.7 v1 把"同族禁叠放"加进 arranger 放置校验。⑤ **编辑路由**:选中 instance → `editTargetId=master`,接通所有内容编辑落 master。⑥ **UI**:链子标记 + 虚线 + 菜单(Make unique / New instance / Select master)+ 编辑器提示 + undo 扩到 detach/删 master。⑦ **review**:真机点测——副歌摆三处改一次全变、detach 后独立、删 master 全脱链、同族拖叠被弹回、stems/导出回归。

## §41 Session 音量自动化(per-session 音量曲线,§26 的姊妹)—— 🚧 实现中 · 2026-06-29

**一句话**:给每个 session 加一条**独立的音量自动化曲线**(挂 `Session.volAuto`),Song 模式回放时按块内 bar 画断点直线、驱动**该块自己的输出增益**——做整块的渐入渐出 / 段落动态。**与 §26 XY 自动化平行、互不耦合**:XY 是音色效果(主总线 insert),volume 是增益(per-block gain),两套数据/引擎节点物理隔离。复用 §26 的**纯断点模块 + 内联 lane 编辑器**,只新写引擎落点。

### §41.1 为什么不塞进 §26 的 `xyAuto`

- **维度对不上**:`XYAutomation = {x,y}` 是两维(效果的两个参数);volume 是**一维**。塞进 `XYProgram`/`XYAutoSet` 会带一条永远中性的幻影轴。
- **引擎层根本不是一类**:§21 XYPad 的 4 个 slot 是串在 master *之前*的**音色效果**;volume 是 master/乐器层的**增益**。它不进效果链。
- **结论**:数据单开字段 `Session.volAuto: AutoPoint[] | null`(一维断点序列),**复用** §26 的 `sampleAuto`/`sortPoints`/`rescaleAuto`/`AutomationLane`,**不动** `xyAuto`。

### §41.2 数据模型

```ts
// contracts/instrument.ts
volAuto?: AutoPoint[] | null;   // §41 Song 音量自动化:一维断点(bar 偏移 0..bars×reps,v 0..1);null=无(隐含恒定满音量)
```
- **复用 §26 的 `AutoPoint{bar,v}`**(同度量:bar=session 内偏移,跨全部 reps;改 reps 按比例缩放点)。
- **中性 = 满音量(unity)**:与 §26 中性压中线 0.5 不同——音量的"无效果"在**顶端 v=1**(0 dB)。lane 默认平直线 + bypass 参考虚线都画在顶端;`v=1→0dB`,`v=0→静音`。
- **只存激活(非平)**:同 §26.v3「`volAuto` 存在 ⟺ 非平」。`isActiveVol(pts)` = 点数>2 或 任一点 `|v-1|≥1e-4`;拉平回 unity = 删字段(`= null`)。
- **v→增益 taper**:`volGain(v) = clamp01(v)²`(平方律,纯前端无 dB 常数:v=1→×1、v=0→×0、中线 v=0.5→×0.25≈-12dB)。够用、可预测、易改;放纯模块 `xyAutomation.ts`(框架无关,不 import Tone)。

### §41.3 引擎落点:新建 per-session 输出 gain(命门)

现状(调查确认):引擎里**没有 session 这一层**——每个 voice 各自 `Player→eq→muteGain→panner→master`,voice 只按 `inst.id` 管、不带 sessionId,同块乐器无共同汇总点。所以"音量自动化驱动哪个节点"两头都不合适(master 全局、乐器 gainDb 太细),**中间 per-session 这层是空的,必须新建**:

```
各 voice → panner ──┬─→ [sessionGain[sessionId]] → master → XY → softclip
                    └─→ sendDist/Delay/Reverb → FX 全局 return   (送量分叉点不变)
```
- `StudioEngine` 新增 `sessionGains: Map<sessionId, {node:Tone.Gain, last:number}>`,**惰性建**(首个该 session 的 voice load 时)、`Gain(1)` 接 master。
- `loadInstrument(id, buf, bars, mixer, sends, sessionId?)` 多收一个 `sessionId`,把**干声目的地**从 `master` 换成 `sessionGainFor(sessionId) ?? master`。**send 仍在 panner 分叉**(在 sessionGain *之前*)→ sessionGain **只缩干声**,FX 尾巴不随块音量(= 已拍板的**方案 A**;FX return 本就全局共享,某块的混响在 return 处也分不出来,妥协可接受;post-fader 正确的方案 B 留待真有需求)。
- `setSessionGain(sessionId, linear, immediate?)`:`immediate`→`gain.value=`(起播 prime),否则 `gain.rampTo(linear, 0.02)`(防 zipper);**EPS 去重**(同 §26 pushXY:稳态平线不刷 AudioParam 事件流)。
- **生命周期**:`clearInstrument` 只销 voice 节点、**留 sessionGain**(跨 warp/swap 稳定);`clearAll`/`dispose` 才销并清 map。`stopTransport` 把所有 sessionGain 复位 1.0(停 / Live 态 = unity,无自动化)。

### §41.4 回放(coordinator)— 逐出声块各驱动自己的 gain

- **与 §26 的关键区别**:§26 XYPad 是**单个** master insert,故 coordinator 只驱动**前景块**(`songForeground`)一条;volume 是 **per-block gain**,故必须**逐个出声块**(`playingSongIds` 全部)各按自己的 `volAuto` 驱动自己的 `sessionGain`——多轨同时发声各缩各的,这正是音量必须 per-block 的原因。
- 落在现有 XY rAF tick 里(同一帧、不另起 rAF):Song 播放中,遍历 `sessionsRef` 中在 `playingSongIds` 的块,各算自己的 `localBar = songPosBars − songLapBars − sessionSongStartBar(块)`(§39 扣圈;每块用**自己**的 start),`v = volAuto?.length ? sampleAuto(sortPoints(volAuto), localBar) : 1`,`setSessionGain(块id, volGain(v))`。无 `volAuto` 的块 = unity,no-op(去重命中)。
- **起播 prime**(`primeSongAutomation`):对每个 active 块 `setSessionGain(immediate=true)` 到起始值,免第一圈从 1.0 跳到自动值的台阶。
- **无手动接管 / latch / spring**:volume 没有 §21 那种实时演奏板,故 coordinator 这段是纯"采样→推值",比 §26 简单一截。

### §41.5 UI — 复用 §26 lane,Y 关掉

- 顶栏自动化选择器(§26 的 4 选 1 + X/Y)旁加一档 **"Vol"**;选中 Vol → 隐藏 X/Y seg(音量单轴),编辑/ghost lane 换成音量曲线。状态用独立 `autoVol: boolean`(**不污染** `autoProgram: XYProgram` 类型)。
- `AutomationLane` 加可选覆写 `color?` / `refV?` / `stepAxis?`(不传则照旧从 `program` 派生),音量传 `color=VOL_COLOR、refV=1、stepAxis=false`,数据塞 `{x: volAuto, y: []}` 走 `axis="x"`,`onChange` 回来取 `.x`。中线吸附 `snap` 改吸到 `refV`(音量→吸顶端 unity)。
- 块头 active 标识(§26 的字母方块)+ 收起态 ghost 曲线:`volAuto` 存在时加一个 "V" 方块 / 一条 ghost。
- `changeVolAuto(id, pts|null, history)`:镜像 `changeXyAuto`——`isActiveVol` 真→存、平→删(`=null`);`history=false` 实时不压栈(画线拖每帧),起拖 `onStart=pushHistory` 压一次。改 reps 时连同 `xyAuto` 一起 `rescaleAuto`(那条 handler 加一行)。

### §41.6 持久化 / undo / 导出

- **持久化**:`StudioSession` 加 `volAuto Json?`(additive,默认 null;可空 Json → `null` 写 `Prisma.DbNull`,同 `xyAuto`)。改 6 处加列套路(同 §37/§40):`schema.prisma`、`sync.ts`(`NSession`/snapshot/`SESS_FIELDS`)、`sessionDoc.ts`(`patchSession` Pick)、`api/studio/ops`(`SESS_COLS`+DbNull)、`api/studio/route`(load 映射)、`projectBundle.ts`(导出/导入两处)。**加列后必重启 next**([[prisma-stale-client-restart]])。
- **undo(§16)**:`volAuto` 在 `Session` 内,随 `sessions` 快照走、`histDataKey` 的 `JSON.stringify(h.sessions)` 自动覆盖 → **7 项口径不扩**;改前 `pushHistory`(changeVolAuto history / 起拖 onStart)。
- **导出(§32)**:`exportSong` 每块离线渲染时本就 `panner→master`,插一个 per-块 `Tone.Gain` 在 panner 与 master 间、按 `volAuto` 栅格 schedule 增益(send 仍在 panner 分叉=方案 A,与 live 一致)→ 导出所听=Song 所听。

### §41.7 落地顺序(doc-first / 每步 typecheck)

① 本节。② 纯模块 `xyAutomation.ts` 加 `VOL_NEUTRAL/VOL_COLOR/volGain/isActiveVol/normalizeVolAuto` + 测。③ `Session` 加 `volAuto` 字段;`AutomationLane` 加 `color/refV/stepAxis` 覆写。④ 引擎:`sessionGains` + `loadInstrument` 加 sessionId + `setSessionGain` + stop 复位 + clearAll/dispose 销毁。⑤ StudioApp:`loadInstrumentToEngine` 传 sessionId、coordinator 逐块驱动、`primeSongAutomation` prime、`changeVolAuto` + reps 缩放 + load `normalizeVolAuto`。⑥ UI:`autoVol` 态 + Vol chip + 隐 X/Y + 音量 lane(编辑/ghost/块头 V)。⑦ 持久化 6 处加列 + prisma db push + **重启 next**。⑧ 导出 per-块 gain。⑨ review:真机——画音量曲线整块渐入渐出、多轨各块各缩、改 reps 曲线跟着缩、停播回 unity、undo/redo、刷新后还在、导出听感一致。

## §42 Master Strip(总线母带链 / 缩混)—— 🚧 实现中 · 2026-06-29(v1 + v2 comp/limiter/预设 已码 2026-07-01,tsc 干净/真机未验;响度对齐+真 LUFS+路线B 待续)

把"成品感"从单条 loop 拉到整首歌:在主总线天花板**之前**插一段真正的母带处理链(EQ → 压缩 glue → 饱和 → 立体声宽度 →〔可选〕真峰 limiter + 响度目标),配一套响度对齐的缩混预设。是 §17(乐器 send/return)与 §21(XY 表演 insert)之后,主总线的**第三类、也是最终的处理段**。

### §42.0 第一原则:它必须是一个独立可插拔的"真效果器单元"

整段 master DSP 抽象成一个**黑盒效果器**,外部只认接口、不认实现:

```ts
interface MasterStrip {
  readonly input: ToneAudioNode;
  readonly output: ToneAudioNode;
  setConfig(cfg: MasterConfig): void;     // 全量推参(同 FxBus.setAll 范式)
  setBypass(b: boolean): void;            // §42.1a strip 级总旁路:内部 input 直连 output(真旁路,外部接线不动)
  setBpm(bpm: number): void;              // delay/lookahead 同步用(若 program 需要)
  getMeters(): MasterMeters;              // { gr: number; lufsST: number; lufsI: number; tpL: number; tpR: number }
  ready(): Promise<void>;                 // 离线导出:等 IR/worklet/wasm 就绪(同 FxBus.ready)
  dispose(): void;
}
```

- **实现可整体替换不动外部一行**:v1 可以是纯 JS AudioWorklet + 原生 Tone 节点拼的;将来换成单块 Faust/WASM 的 MasterDSP,只要还满足这个接口,`studioEngine` 和 `exportSong` 都不用改。
- **建在共用工厂**:`audio/masterChain.ts` 加 `makeMasterStrip(bpm): MasterStrip`,live(`studioEngine.init`)与离线(`exportSong`)调**同一个工厂**——这是 `masterChain.ts` 存在的全部理由(防音色漂移),母带链是它最该收的住户。
- **默认全旁路**:`DEFAULT_MASTER` 每块中性/off → 加进信号链零音色改变(对齐 `DEFAULT_FX` 哲学)。

### §42.1 信号链落点(改 §17 的链尾)

master strip 插在 `master(主音量)` 与 `XY insert` 之间——母带处理静态 mix,XY 是叠在成品上的演奏 wildcard,softClip 永远是不可侵犯的最终天花板:

```
…干声 + FX return 湿声 + 节拍器 → master(Tone.Volume 主音量)
   → [MasterStrip: EQ → Comp(glue) → Sat → Width(M/S) →〔TP Limiter〕]   ← §42 新增,可插拔黑盒
   → XY insert(§21) → softClip 天花板(WaveShaper, memoryless, §17) → Destination
        └→ Split → MeterL/R(峰值表抽头不变,仍在 master = strip 前)
```
- 电平表抽头**保持在 master**(strip 前)= 推子动作 + 母带前真实总线电平;strip 自己的 GR / LUFS / 真峰由 `getMeters()` 单独出。
- 节拍器 click 仍直挂 softClip,**不进 master strip**(监听辅助,不该被母带压/限/染,同它不进 §17 FxBus / §21 XY 的理由)。

### §42.1a Master bypass(strip 级总旁路,A/B 用)

整条 strip 一键 in/out 是母带工作流刚需。落点 = **strip 内部真旁路**:`MasterStrip` 内 `input → [处理链] → output`,`setBypass(true)` 断开处理链、`input` 直连 `output`——**外部接线(master→strip.input、strip.output→XY)一行不改,bypass 比特级一致 = 诚实 A/B**。
- 数据:`MasterConfig.on`(header ⏻ MASTER);`on=false` → strip 全旁路,**盖过每段各自的 `on`**。
- **softClip 不在 bypass 范围内**(它不是 strip 的一部分,是 §17 不可侵犯的最终天花板)→ bypass 后过载保护照旧。
- 电平表抽在 strip 前(`master`)→ bypass 与否读数不变(量的是"进母带前"的电平)。
- 〔v2〕**响度匹配 bypass**:按 `getMeters().lufsI` 自动 trim,避免"开了更响=更好"的响度欺骗;v1 先做普通 true bypass。

### §42.2 链路顺序与参数(母带惯例,已联网核对)

顺序 = 业界标准母带链(见文末参考):**EQ → 压缩 → 饱和 → 宽度 →〔limiter 永远最后〕**。M/S 对链序极敏感,宽度之后不得再有动立体声的东西(limiter 用做峰值控制、不该改像)。

| 段 | 算法 | 关键参数 | 母带级取值(预设种子) |
|---|---|---|---|
| **EQ**(校正) | 复用 `makeShelfEq`(low-shelf/peak/high-shelf,可扩 4 段) | 各段 gain/freq/Q,`on` | 宽 Q,±0.5~2dB(修低中频堆积/驯上中频毛刺);压缩前先把音色摆正 |
| **Comp**(glue) | 见 §42.3(抗抽吸专设计) | threshold/ratio/attack/release/knee/makeup/**scHpf**/**mix**/**autoRelease**/lookahead | 比率 1.5:1~2:1,慢攻 20~50ms,中释 100~300ms(或 auto),**仅 1~3dB GR** |
| **Sat** | WaveShaper(复用 `distCurve` 套路,4× 过采样) | drive/character/`mix` | 1~2dB 谐波增益,微到"是质感不是效果" |
| **Width** | M/S 增益 + **频率相关**(低频转 mono) | width(0=mono/1=原/2=宽)、`monoBelowHz`、side-high air | 高频 side 加一点空气;**<120Hz 转单声道**(kick/bass 聚焦,缩混招牌);**必过 mono 检查**,相位抵消即收 |
| **Limiter**(可选,最后) | 真峰 lookahead 限幅 | ceiling(dBTP)、target LUFS、release | 透明优先,真峰 ≤ −1dBTP,推响度到目标 LUFS |

### §42.3 压缩器:做"非常好用"且不重蹈 §17 抽吸覆辙

§17 工程掉的 bug 真因不是"压缩",是**快速 brickwall limiter 压满混音**:每个鼓点瞬态触发快攻快放 → 每圈 loop 接缝抽吸/咔。慢胶水压缩器是另一物种。七件套——每件既是"好用",也是抗抽吸武器:

| 控件 | 作用 | 为何不抽吸 |
|---|---|---|
| **Mix / 并行**(dry/wet) | 纽约式并行压缩 | **最强抗抽吸武器**:压缩声与干声并联,密度上来但整体动态不"喘";即便重压也不 pump |
| **Sidechain HPF**(60~150Hz) | 检测端高通 | kick 不再把整条 mix 往下踩 = 低频抽吸头号来源被切 |
| **Auto-release**(program-dependent) | 自适应释放 | 杜绝固定释放卡在 loop 周期上的规律 pumping |
| **慢攻**(10~30ms 起) | 放过瞬态 | 鼓 attack 穿过去保 punch,不对每个瞬态做增益跳变(=不咔) |
| **低比率 + 软膝** | 胶水非限幅 | 只做几个 dB 轻柔贴合 |
| **GR 表** | 看得见压多少 | "好用"的硬指标(`getMeters().gr`) |
| **Lookahead**(2~5ms) | 前瞻抓峰 | 控瞬态不靠快攻、避免失真 |

- **前提**:softClip 天花板(§17)原样保留做真峰安全网 → 压缩器永不需要当 limiter brickwall,这是它能温柔的根。
- **预设即安全机制**:每个带压缩的预设(§42.5)内置已调好的 mix/autoRelease/scHpf → 用户照套就不会自己踩回 §17 抽吸。

### §42.4 实现选型:可插拔接口下的分期路线(v1 → 厉害)

接口(§42.0)固定不变,DSP 内核分期升级:

- **路线 A(v1,快、零新工具链)**:EQ/宽度/饱和 = 原生 Tone 节点(EQ 白拿 `makeShelfEq`);压缩器 = **纯 JS AudioWorklet**(envelope follower + gain computer + SC 双二阶 + lookahead 环形缓冲 + GR 经 port 回传)。足以交付 §42.3 全部能力。离线:worklet 须在 `Tone.Offline` 的 OfflineAudioContext **也注册**(`addAudioWorkletModule`),否则导出建不出节点 = 漂移。
- **路线 B(厉害,目标态)**:整条 strip 做成**单块 Faust→WASM AudioWorklet**。Faust 标准库现成:`co.compressor_lad_*`(lookahead 压缩)、`co.limiter_1176_*` / N 通道 lookahead limiter、`fi.*` 滤波做 EQ、ITU-R BS.1770 响度。`faustwasm` 把 .dsp 一键编译成 wasm+js worklet,**同一份源**既出实时 worklet、又能离线渲染 → parity 最干净:bounce 时直接拿同一 wasm **对渲染好的 PCM 扫一遍**,母带段不再让 Tone 重建图,确定性 100%。许可宽松(Faust 生成码 + 标准库可商用)。代价:加 Faust 编译期工具链、包体增大、调试更难;**运行期依赖只是一个 wasm+js,很小**。
- **现成可选件(评估过,见文末)**:
  - **libsonare**(Apache-2.0)—— C++/WASM 同源,直接是一条母带链:ITU-R BS.1770-4 响度 + 真峰限幅、Linkwitz-Riley 多段、Vicanek matched-Z 双二阶、ADAA 抗混叠削波、12AX7 电子管模型、maximizer、reference matching。**特征集几乎正中需求**;风险:极早期(v1.4.1 / ~10 star),需 vendor + 自己扛维护。可作 B 的加速器或抄算法。
  - **libebur128**(MIT)—— LUFS / 真峰金标准,编 WASM 给响度表 + 预设响度对齐(§42.5)。
  - **Airwindows**(MIT C++)—— console/tape/comp 字符算法,要"染色"性格时可移植。
  - 原生 `DynamicsCompressorNode` —— 只配做应急基线(无外部 sidechain / 无 lookahead / 释放不可编程),达不到"非常好用"。
- **推荐**:接口先按 §42.0 钉死 → **A 落地可用** → 需要 limiter/LUFS/多段时把内核换 **B(Faust)**,外部零改动。

### §42.5 缩混预设(响度对齐是"厉害"与"玩具"的分界)

预设 = 一份完整 `MasterConfig` 字面量(EQ+comp+sat+width+limiter/响度目标),应用 = `setFx`(自动落库 + 进 undo,白拿)。预设是**起点不是模式**,套上后可继续手调。

- **响度对齐(命门)**:切预设时按 `getMeters().lufsI` 自动 trim 到同一 LUFS,A/B 只比音色不比音量(否则更响永远"更好听"= 响度欺骗)。没 LUFS 就只是玩具 → 依赖 §42.4 的响度测量(libebur128/Faust)。
- 内置清单(种子,可调):**Boom-Bap Glue**(2:1 慢攻 auto-rel + SC HPF 80 + 磁带饱和 + air shelf)· **Lofi Tape**(重饱和 + 高频滚降 + 略窄高端)· **Trap Loud**(更狠压 + 真峰 limiter 推响度 + 低端收紧 + hats 加宽)· **Clean/Transparent**(几乎不压,只真峰限到目标 LUFS + 一点 air)· **Club/Wide**(高频 side 加宽 + <120Hz mono + 有冲击压缩)· **Streaming −14 LUFS**(limiter + auto-gain 到 −14 integrated)。
- 数据:内置只读预设放 `studio/masterPresets.ts`(命名 `MasterConfig` 数组);用户自定义预设(挂 Project / per-user)留 v2。
- **stretch — Auto Master(一键智能母带)**:复用 DASHSCOPE([[§35]]),用 LUFS/频谱平衡/crest factor 实测喂 AI → 自动选预设或自动设 limiter 目标。最能打的"缩混"卖点。

### §42.6 数据模型(§15 合规,零 schema 改动)

`FxConfig` 加 `master: MasterConfig`(与 `xy` 并列,`contracts/models.ts`),走**已有的 `Project.fx` JSON 逃生口**——schema/sync/api 全程已带 `fx`,**不需要任何加列/迁移/重启**。

```ts
interface MasterConfig {
  on: boolean;                          // §42.1a strip 总电源(header ⏻ MASTER);false=全旁路,盖过各段 on
  eq:    { on: boolean; low: number; mid: number; high: number; /* freq/Q 可后扩 */ };
  comp:  { on: boolean; threshold: number; ratio: number; attack: number; release: number;
           autoRelease: boolean; knee: number; makeup: number; scHpf: number; mix: number; lookahead: number };
  sat:   { on: boolean; drive: number; character: 'tape'|'tube'|'soft'; mix: number };
  width: { on: boolean; width: number; monoBelowHz: number; air: number };
  limiter:{ on: boolean; ceilingDb: number; targetLufs: number|null; release: number };
}
export const DEFAULT_MASTER: MasterConfig = /* on:true(strip 在路径里)但每段 on:false / 中性 → 进链零音色变 */;
```

### §42.7 持久化 / undo / 导出 合规

- **持久化(§15.A)**:`Project.fx` JSON,改参即 `eng.setFx()` + 防抖乐观 PATCH(同 §17,**零新增落表工作**)。
- **undo(§16)**:`fx` 已显式在快照口径(§17)→ `master` 子块**自动可撤**,**7 项口径不扩**;旋钮拖动**开始**压一次 `pushHistory`(非每帧),套预设压一次。
- **导出(§32)**:`exportSong` 在 `master → XY` 之间插同一个 `makeMasterStrip()` 实例,`setConfig(fx.master)` 后 `await strip.ready()`(等 worklet/wasm/IR 就绪,同 `FxBus.ready`),再 `transport.start` → 导出所听 = 走带所听。**这是 §42.0 可插拔接口换来的 parity 红利**。

### §42.8 UI 落点 —— 独立 MasterStrip 浮层 + 模拟 VU 表

内容已超出 FxRack `OUT` 一段能装的量 → **独立 `studio/ui/MasterStrip.tsx` 浮层**(顶栏新触发键,沿用 `.fx-pop`/`.xy-pop` 范式 + 点外/Esc 关),不塞进 FxRack 三栏。

**视觉语言铁律:不做镀铬/玻璃/木纹皮肤(与扁平 metro 打架),只翻译模拟表的几何 + 调色板**:奶油表盘→`--bg-0`、黑刻度→`--tx`、红过载区→`--acc`/`#e5564b`、灯丝暖辉→极淡 `--acc-dim` 径向渐变、指针→单根 `--tx` 细线(非 3D 高光针)。

**双 VU 表(IEC 60268-17,缩混机的情感中心)**:
- 范围 −20…+3 VU,**线性于振幅** ⟹ 0VU 落右偏 ~69%(红区 0..+3 压进顶 ~30%,真表标志,别做成对称线性);浅弧 ~90°(−47°…+43°);枢轴在窗口下方,指针从底部穿出。
- **指针 ~300ms 弹道是灵魂**:L/R 双针近同步缓摆,`prefers-reduced-motion` 下静止。
- 色断点同现有电平表:红 ≥ −3、琥珀 ≥ −6、绿(`live.tsx` 的 `meterColor`,窗口 [−48,0])。
- ⚠ **复用 `engine.masterLevel()`,绝不第二次 per-frame 调用**(双推弹道衰减);新表与现有 `MasterMeter` 合并成一个每帧 tick 统一读、分发。

**其余表/读数**:右侧 GR 指针小表(停 0、压缩向左摆,读 `getMeters().gr`)+ mono 读数 LUFS-S / LUFS-I / True-Peak L·R / TARGET。

**控件全部复用现有画法**:旋钮(`viewBox 0 0 48 48`、−135..+135、陶土值弧、竖拖/双击复位)、`.fx-chip`、`.fx-pw`(ON/BYP)、`.fx-mod` 卡、mono 读数、面包屑信号链。

**布局**:header(⏻MASTER + 信号链面包屑 + OUTPUT trim)→ hero(双 VU + GR + 读数)→ memoryless 三件套行(EQ/饱和/宽度)→ opt-in 动态行(GLUE/LIMIT,灰显默认 BYP + 抗抽吸说明)→ footer 信号链。**Master bypass 视觉**:点 ⏻MASTER → 面板降透明度、各 stage 面包屑转灰,唯独 footer `softclip ceiling` 仍亮(提示"处理停了、天花板还在")。

**前端组件树**:
```
MasterStrip.tsx        // .fx-pop 浮层壳 + header + 预设 chip 行 + 点外/Esc 关
├─ VuMeter.tsx         // 单 VU 表 SVG;自驱动 rAF(共享 tick)读电平
├─ GrMeter.tsx         // GR 指针表;读 getMeters().gr
├─ MeterReadouts.tsx   // LUFS/真峰 mono 读数
├─ MasterModule.tsx    // 通用 .fx-mod 卡(EQ/Sat/Width/Glue/Limit 复用)
└─ Knob(复用 FxRack/MixerStrip 旋钮画法)
```
状态:`fx.master` 活在 StudioApp,改参 → `eng.setFx()` + 防抖乐观 PATCH;旋钮 onStart 压一次 `pushHistory`,套预设压一次(同 §17)。

### §42.9 落地顺序(doc-first / 每步 typecheck;分两批,v1 零 worklet 零风险)

**v1(memoryless 三件 + 双 VU + bypass,最快见效、零 worklet)**:
① 本节(含 §42.1a bypass、§42.8 VU UI)。② `contracts`:`MasterConfig`(含 `on`)+ `DEFAULT_MASTER` 进 `FxConfig`(默认进链零音色变,跑通持久化/undo)。③ `masterChain.ts`:`makeMasterStrip()`——EQ(复用 `makeShelfEq`)/饱和(WaveShaper)/宽度(M/S:side 高通 `monoBelowHz` + air shelf + width gain)= memoryless 原生节点;`setBypass` 内部真旁路;`getMeters` 先回 GR=0 + RMS 近似 LUFS + 真峰。④ `studioEngine.init` 接入(`master→strip→XY` 改一行)+ `setFx` 推 `master` + `getMeters` 暴露。⑤ `exportSong` 接同一工厂 + `ready()`。⑥ 前端:`MasterStrip.tsx` + VuMeter/GrMeter/读数 + 统一 meter tick + bypass。

**v2(opt-in 动态 + 预设 + 真 LUFS)**:⑦ ✅ 压缩器 AudioWorklet(路线 A,纯 JS):侧链 HPF/lookahead 环形缓冲/软膝/auto-release/GR 回传 + CompNode 外做并行(干声同步延迟对齐)+ 离线同 blob-URL 注册。⑧ ✅(部分)limiter(真峰 lookahead 砖墙 JS worklet,`brick-limiter` 与 glue-comp 同模块)+ 预设系统 `masterPresets.ts`(6 个,套预设=onFx 整块替换+一次 pushHistory);**⏳ 响度对齐 trim 未做**(targetLufs 已存未强制,需真 LUFS)。⑧.5 ⏳ 真 LUFS(BS.1770 K 加权+门限;现 getMeters 是 RMS 近似)。⑨〔路线 B〕Faust→WASM 换内核(用户 2026-07-01 决定先不上,保持路线 A)。
> v2 落地补注(2026-07-01):glue-comp worklet 经对抗审查修了 3 个 low(GR 少报→minG 实例字段跨块累积、关闭仍报 GR→worklet 加 c.on 旁路分支、关闭留 3ms 余延迟→dryDelay 关时置 0)。worklet 不内做并行(在 CompNode dry/wet);comp.on/limiter.on 各自结构式真旁路(关=零延迟直通)。

⑩ review 真机:套预设音色变响度不跳、压缩走带多圈不抽吸(对照 §17)、GR/LUFS 准、宽度过 mono 不塌、bypass A/B、停播无残留、undo/redo、刷新还在、导出听感一致。

### §42.10 参考(2026-06-29 联网核对)

- 母带链顺序与参数:[Mastering The Mix — Where Every Plugin Sits](https://www.masteringthemix.com/blogs/learn/where-every-mastering-plugin-sits-in-the-chain) · [SonicScoop — Correct Order for Mastering Chain](https://sonicscoop.com/the-correct-order-for-effects-in-your-mastering-chain-and-mix-bus/) · [iZotope — Ideal Mastering Signal Chain](https://www.izotope.com/en/learn/what-is-an-ideal-mastering-signal-chain.html)
- DSP→WASM/AudioWorklet 底座:[Faust](https://faust.grame.fr/) · [faustwasm](https://github.com/grame-cncm/faustwasm) · [Faust compressors.lib](https://faustlibraries.grame.fr/libs/compressors/)
- 现成母带引擎:[libsonare(Apache-2.0,C++/WASM 同源母带链)](https://github.com/libraz/libsonare)
- 响度/真峰:[libebur128(MIT,EBU R128)](https://github.com/jiixyj/libebur128) · [needles(浏览器 LUFS 表)](https://github.com/domchristie/needles)

## §43 音频采样率域宪法(全局 canonical 48 kHz)—— 🚧 实现中 · 2026-06-29

> ⚠ 做任何碰 `startSample/endSample/warpPts.src`、解码、warp 渲染、入库的功能前必看本节。这是一条**正确性宪法**,违反它的后果是"关掉重开所有 warp 跑拍"。

### §43.0 病根(2026-06-29 实测定位)

warp/trim/marker 的所有偏移量都是**整数采样下标**(`Clip.startSample/endSample`、`WarpPoint.src`、`Sound.warp`/`analysis`、`PadClip`)。一个采样下标只有配上"它是哪个采样率算出来的"才有意义。本仓过去**从没固定这个采样率**:

- **生产端(偏移量出身)**:gen/upload 走客户端 `gctx()`/`getCtx()` = `new AudioContext()` = **跟随输出设备的速率**;stem(Demucs)/chop 走服务端或原生文件速率(44.1k)。同一台机、同一刻它们一致,但跨设备/跨会话会变。
- **消费端(解码 + 切片)**:`decodeAsset` 用 `getCtx()`(同样跟随设备)`decodeAudioData` 把资产**重采样到设备速率**,再拿偏移量直接切。

于是不变量 **「偏移量域 == 解码域」** 被打破:只要资产原生 SR ≠ 当前 `AudioContext.sampleRate`,源区间就被错切 ×(设备SR/偏移量域SR)。实测一例:bass loop 偏移量在 44100 域,设备 48000 → 区间短 **8.12%**(= 1−44100/48000)→ 整条 loop 跑拍。`AudioContext` 的速率由**当前默认输出设备**决定,换设备/重启就变 → 这就是"关掉重开就坏、且像是随机发作"的根因。混了 44.1k/48k 素材时,任何单一设备速率下都不可能全部正确。

### §43.1 第一原则:像专业 DAW 一样,**单一 session 速率;源文件保持原样、解码时实时 SRC 到 session 速率**

没有任何专业 DAW(Pro Tools/Logic/Ableton/Cubase)允许一个工程里混采样率。专业做法有两种、都对:Pro Tools "导入时生成 conform 副本文件";**Logic/Ableton Live 保留原始源文件不动,播放时实时 SRC 到工程速率**。

本仓选 **Logic/Live 的实时 SRC 模型**,因为它既专业、又契合架构:① `decodeAsset` 用钉死 48k 的 context 解码 = 天然把任意原生 SR 资产实时重采样到 48k;② 源文件不重写 → 不撞 Next route handler 的 **10 MiB 上传上限**(见 [[large-upload-chunking]];一段 30s 立体声 48k 的 32-float WAV 已 ~11.5MB,整曲上百 MB,根本传不上去),也**绝不二次有损压缩**(Suno mp3 → 再 mp3 = 质量塌)。所以**不在入库时重写资产**。

- **canonical SR = `48000`**(`CANONICAL_SR`)。依据:48k 是影视/流媒体/现代音频接口的交付标准;现代硬件 Web Audio 原生跑 48k(输出零重采样);collage 渲染本就硬编码 48000。**全仓唯一合法处理采样率**。
- **源资产保持原样存**(原始字节、原生 SR 任意,不动)= Logic/Live 源文件不动。
- **解码域钉死**:所有 `AudioContext`/`OfflineAudioContext` 一律 `{ sampleRate: CANONICAL_SR }`,**永不跟随输出设备**。任意原生 SR 资产 `decodeAudioData` 即被实时 SRC 到 48k;输出到非 48k 设备由浏览器在最终输出层重采样(听不出、与正确性无关;已实测 `{sampleRate}` 被 Chrome/FF/Safari 完整尊重)。
- **偏移量域钉死**:入库分析(`gctx`)同样钉死 48k → 新算出的偏移量天生落 48k 域。存量偏移量一次性迁到 48k 域(§43.3)。

合起来让「偏移量域 == 解码域 == 48000」**永恒成立、与设备解耦、与资产原生 SR 无关**。偏移量仍是整数采样(契约形状不变),只是域被强约束。

> 为什么不"导入即重写成 48k 文件"(我最初的想法):被 10 MiB 上传上限 + 无损 float WAV 体积 + 拒绝二次压缩三者共同否决。实时 SRC 模型零这些代价,且同样是主流 DAW 的标准行为。

### §43.2 落点(代码)

**A. 常量**:`src/audio/sr.ts` 导出 `export const CANONICAL_SR = 48000;`,全仓引用(收编 collage 的硬编码 48000)。

**B. 钉死 context(承重)**:
- `realLibrary.ts` `getCtx` → `new AudioContext({ sampleRate: CANONICAL_SR })`
- `studioGens.ts` `gctx` → 同上
- `studioEngine.init` 首次 → `Tone.setContext(new Tone.Context({ sampleRate: CANONICAL_SR, latencyHint: 'interactive' }))`(导出走 `Tone.Offline` 继承此 SR)
- 所有 `new OfflineAudioContext(...)`(`signalsmithWarp` ×3、`realLibrary` collage、`exportSong`)传 `CANONICAL_SR`

**C. 入库(不重写资产)**:gen/upload/stem 仍存原始字节。偏移量的正确性已由 B(钉死 48k 分析+解码)保证,无需碰资产。`gctx` 钉死 48k 后,`detectLoop` 算出的 `analysis`/`warp` 偏移量天生落 48k 域;`ingestSound` 的 `meta.sampleRate` 也即 48000。

**D. CDN 诊断列(非守门、不重采样)**:
- `Asset` 加 `sampleRate Int?` 列;`putAudioAsset` 从 WAV 头读原生 SR 落值(读不到留空),仅作可见性/诊断 —— **不**强制 48k(源资产允许任意原生 SR,实时 SRC 负责对齐)。
- warp-render 缓存签名 `x1`→`x2`:钉死 48k 前在非 48k 设备上落盘的渲染,其解码域 ≠ 现在的 48k 而 sig 不含解码 SR → 旧渲染可能错;bump 版本位作废它们(当前 count=0,纯属防患)。

**E. 不动**:WarpEditor / 引擎调度 / sync / 契约形状 —— 偏移量仍整数采样,域被钉死即可。

### §43.3 存量迁移(一次性,幂等,带备份)

老数据的偏移量在各自旧域。迁移:对每个 `Clip`、`Sound`(`warp`+`analysis`)、`PadClip`:
1. 恢复旧域 SR:读资产 WAV 头原生 SR;读不到(mp3 等)则用 `域SR = (end−start)×sourceBpm/(bars×4×60)` 吸附到最近标准率({44100,48000,…})。
2. `新值 = round(旧值 × 48000 / 旧域SR)`,作用于 `startSample/endSample` + `warpPts[].src`(及 Sound.warp/analysis 同字段)。
3. 旧域已是 48000 → factor 1 跳过(幂等)。
脚本先把原值备份到文件再写库。**不**重转资产文件——§43.2.B 后旧 44.1k 资产会被实时 SRC 到 48k、配迁移后的偏移量即正确。

### §43.4 落地顺序(doc-first / 每步 typecheck)

① 本节。② 常量 + 钉死所有 context(§43.2.A/B;改完 dev 重启,真机确认任意一条 loop 仍出声不崩)。③〔取消〕入库重写——改为 §43.2.C 不动资产,正确性由 ② 兜底。④ `Asset.sampleRate?` 诊断列 + `putAudioAsset` 落值 + warp-render sig `x1→x2`(§43.2.D;`prisma db push` 后**重启 dev**,见 [[prisma-stale-client-restart]])。⑤ 迁移脚本(§43.3;先备份、dry-run 打印 factor、再写)。⑥ review + 真机回归:所有乐器编辑器读回**真实 sourceBpm**(不再是 ×1.088 的虚高值)、整 scene 不跑拍、播放/导出听感一致、刷新后仍对、换输出设备(若可)仍对。

### §43.5 实测验证档案(2026-06-29,改前)

- 运行时 `AudioContext.sampleRate=48000`;项目 `touch the leather` 资产混 44.1k(bass/jazz/LEX)/48k(OS fill)。
- 数值:44.1k 资产区间短 8.12%、48k 资产 0%;偏移量迁到 48k 域后**全部 0.000%** 误差(= 真实小节时长)。
- app 端到端:把该项目偏移量迁到 48k 域 + 刷新 → 编辑器 bass `98→90`、LEX `100→92`、jazz `95→88`,全读回真实 sourceBpm、跑拍消失(验证后已还原原值)。
- `new AudioContext({sampleRate})` 被浏览器完整尊重(44.1k/48k/96k 解码样本数各异、与设备无关)。
