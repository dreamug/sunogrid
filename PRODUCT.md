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

**状态/持久化/undo**:solo 是**瞬态演奏态** —— **不落库、不进 undo**(§16:走带/播放=瞬态,同 play/stop)。authority 在 `StudioApp` 的 `soloRef`/`soloIds`(state),`toggleSolo` 改集合 + `eng.setSolo`;切 session(`switchSession`)、undo/redo(`applyEntry`)→ `clearSolo()`;删乐器(`removeInst`)→ 从集合剔除再 `setSolo`。引擎 `soloIds` 仅经 `setSolo` 改 + `clearAll` 清,两边保持同步。

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
  - **不在引擎**(Song 必走;Live 从 Song 钉住视图切回时也会遇到 —— 钉住查看只 `ensurePeaksForView` **不建 voice**)→ `await loadSession(当前场)`(`clearAll`+只装当前场,buffer 命中缓存故廉价)+ `clearSolo`(同步抹掉 `clearAll` 已清的引擎 soloIds)。⚠ 这条不能用 `retainOnly`,否则当前场没 voice 会被剔成空引擎 = **静音**(早期 Live 分支只 `retainOnly` 的真 bug)。
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

**XY insert 结构(干/湿交叉淡入,防爆音)**:
```
input ─┬─ dry(Gain) ───────────────┐
       └─ [当前 program] ─ wet(Gain) ─┴─► output
```
- `engage`(手按下)= `wet→e·mix`、`dry→1-e·mix`(15ms rampTo);`release`(松手)= 回 `dry=1,wet=0`。`mix` = WET 旋钮(engaged 时的湿量;mix=1 → 纯效果)。**没演奏且非锁定时恒为旁路(直通干声)**。
- 单板**同时只一个 program 激活**;切 program = dispose 旧、build 新、重连 input/wet(重的 `PitchShift` 只在 brake 选中才建)。

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

**v1 范围**:纯实时表演(不录进 loop);单 program;四效果全做(刹车近似)。v2:录手势/自动化、真 tape-stop、多 program 同开。

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
