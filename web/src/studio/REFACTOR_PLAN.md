# StudioApp.tsx 拆分方案

> 关联记忆:`studio-render-perf`(全树重渲根因)、`undo-constitution`(口径不能漏 pushHistory)、`doc-first-workflow`、`session-index-vs-array-order`。

## 进度

- **✅ 阶段 0 已完成(2026-06-30)** —— StudioApp.tsx **3191 → 2435 行**。抽出 16 个新模块,全程 `tsc --noEmit` 绿、无未用 import、无循环依赖、git diff 纯迁移(73 增 / 752 删,零新增逻辑行)。所有组件抽取逐字一致(workflow 对抗式验证 + tsc 双保险)。
  - 纯模块:`shared.ts`(nid/cvar/PX/FAINT/色板/zoom 常量)、`peaks.ts`、`songQuery.ts`
  - `ui/` 叶子组件 13 个:CollagePadBody / SongZoomScope / SessionColorDot / InstrumentChip / SongInstrumentCount / InstrumentName / Metronome / ProjectNameInput / TempoInput / CollageEditor / SongTimeline(含 RailScroll/HScroll/SongTimelineProps)/ ArrangePopover / EmptyEditor
  - 留在 StudioApp:`COLLAGE_GRID`(主体 footer 用)、`interface Ctx`、`Knob`(**死代码**,无任何调用点,待单独清理)、`BEAT_PROMPTS`/`pickBeatPrompt`/`setDragImage`(gen box 专用,暂留)
  - ⚠ 真机已验:tsc 全绿;**未验**:登录态浏览器渲染(auth-gated,在用户 live :3007 上未绕过)——重载已开的 studio 标签即可由 HMR 确认。
- **🟡 阶段 1 部分(2026-06-30)** —— 抽了 **`usePersistence`**(hooks/usePersistence.ts,~95 行:flushOps 发件箱 + 防抖落库 + 退避重试 + beforeunload 守卫)。StudioApp 2426 → 2351 行,tsc 绿、无未用 import、纯迁移。⚠ loaded/synced ref 仍由 StudioApp 拥有传入(load 写基准),hook 只读 loaded、读写 synced。**真机未验**(auth-gated):自动保存是高危链路,逐字搬入 + 同 ref 身份 + effect 有 loaded 守卫所以行为应等价,但落地后请实测「改 pad → Saved」。
  - **关键发现**:原本以为低风险的三个 hook 里,**只有 usePersistence 真干净**。`useAutomation` 含常驻 rAF coordinator(读 playingRef/playModeRef/playingIdxRef/songLapBars/songBlockStart/playingSongIdsRef 等 ~7 个 playback ref,是实时引擎驱动器)→ 耦合核心、非低风险。`useLibrary` 的 handler 伸进 engine(audition)/选区(onSelect/focusSound)/session-doc(addSampleFromSound)/pushHistory → 15–25 参宽接口、非自包含。
  - **故低风险增量式只此一个干净 win**。要继续抽 library/automation/playback,得先做 **useStudioCore + useHistory** 这层共享底座(见 §4.1),那是更大、更高风险的改动,不再是"低风险增量"。建议:要么就停在此(2351 行已可辩护),要么单独立项做 core-first 重构。

---

---

## 1. 现状

`StudioApp.tsx` = **3191 行 / 264KB**(大到 Read 工具一次读不下)。三段:

| 区段 | 行号 | 内容 |
|---|---|---|
| 顶部常量 + 纯函数 + 两个内联子件 | 1–246 | `computePeaks`/`peaksFromRegion`、song 查询 helpers、`CollagePadBody`、`SongZoomScope`、色/网格常量、`nid`/`cvar` 等小工具 |
| **`StudioApp` 巨型组件** | **248–1976**(本体)+ **1978–2570**(JSX return) | ~120 个 `useState`/`useRef`、**~80 个闭包函数**、~600 行 JSX |
| 尾部独立子组件 | 2572–3191 | 13 个 props-in 展示组件 |

真正的怪兽是中间 ~2300 行的组件本体。

### 为什么不能"按文件直接剪切"

那 80 个函数几乎全部闭包捕获同一批 `useState` setter 和 ref(`sessionsRef`、`eng`、`ctxRef`、`pushHistory`、`updateSession`…)。这正是 `studio-render-perf` 记的"任何 setState 全树重渲"的同一个根:**单体共享态**。

因此拆分分两个难度档:
- **纯展示组件 / 纯函数** —— 零风险,直接搬,行为不变。
- **核心逻辑(80 个闭包)** —— 必须先抽成 custom hooks 才能搬,属于真重构,有回归风险。

---

## 2. 目标文件结构

```
studio/
├─ StudioApp.tsx              ← 只剩 <main> 编排 + hook 装配(目标 ~500 行)
├─ peaks.ts                   ← 波形峰值(纯)
├─ songQuery.ts               ← Song 纯查询函数(纯)
├─ ui/
│  ├─ shared.ts               ← nid / cvar / PX / FAINT 等跨件小工具
│  ├─ toolbar/
│  │  ├─ Metronome.tsx
│  │  ├─ ProjectNameInput.tsx
│  │  └─ TempoInput.tsx
│  ├─ InstrumentName.tsx
│  ├─ InstrumentChip.tsx
│  ├─ SessionColorDot.tsx
│  ├─ SongInstrumentCount.tsx
│  ├─ CollageEditor.tsx
│  ├─ SongTimeline.tsx        ← 含 RailScroll / HScroll
│  ├─ ArrangePopover.tsx
│  ├─ EmptyEditor.tsx
│  ├─ CollagePadBody.tsx
│  └─ SongZoomScope.tsx
└─ hooks/                     ← 阶段 1:9 个 custom hooks
   ├─ useStudioCore.ts
   ├─ useHistory.ts
   ├─ useEngineLoader.ts
   ├─ useSongPlayback.ts
   ├─ useSessionDoc.ts
   ├─ useInstrumentOps.ts
   ├─ useCollageOps.ts
   ├─ useLibrary.ts
   └─ usePersistence.ts
```

---

## 3. 阶段 0 — 零风险搬运(主文件 3191 → ~2300)

全是 props-in 纯件 / 纯函数,搬出去行为不变。可随时放心做,单独提交。

### 精确迁移表(按当前行号)

| 目标文件 | 现行号 | 符号 |
|---|---|---|
| `peaks.ts` | 132–166 | `WAVE_N` `computePeaks` `peaksFromRegion` `lanePeaksCache` `pieceKey` |
| `songQuery.ts` | 204–246 | `emptySessions` `normalizeSongLayout` `songTotalBars` `songLaneCount` `songActiveAt` `songForeground` `songNextBoundaryAfter` `sessionInstIds` `enabledInstIds` |
| `ui/CollagePadBody.tsx` | 168–199 | `SLICE_COLORS` `sliceColor` `sliceColorFor` `CollagePadBody` |
| `ui/SongZoomScope.tsx` | 87–130 | zoom 常量(`SONG_ZOOM_*` `clampZoom`)+ `SongZoomScope` |
| `ui/SessionColorDot.tsx` | 2572–2603 | `CHIP_COLORS` `SessionColorDot` |
| `ui/InstrumentChip.tsx` | 2604–2652 | `InstrumentChip` |
| `ui/SongInstrumentCount.tsx` | 2653–2708 | `SongInstrumentCount` |
| `ui/InstrumentName.tsx` | 2709–2724 | `InstrumentName` |
| `ui/toolbar/Metronome.tsx` | 2725–2751 | `MetroIv` `Metronome` |
| `ui/toolbar/ProjectNameInput.tsx` | 2752–2778 | `ProjectNameInput` |
| `ui/toolbar/TempoInput.tsx` | 2779–2797 | `TempoInput` |
| `ui/CollageEditor.tsx` | 2798–2988 | `COLLAGE_GRID` `CollageEditor`(~190 行,最大块) |
| `ui/SongTimeline.tsx` | 2989–3122 | `SongTimelineProps` `SongTimeline` `RailScroll` `HScroll` |
| `ui/ArrangePopover.tsx` | 3123–3156 | `ArrangePopover` |
| `ui/EmptyEditor.tsx` | 3157–3191 | `EmptyEditor` |

### 注意

- **共享小工具**:`nid`(L38)、`cvar`(L39)、`PX`/`FAINT`(L87–88)被多处引用。抽到 `ui/shared.ts` 统一导出,**不要复制成多份**。
- **常量去重**:`CHIP_COLORS`(L2572)与 `SLICE_COLORS`(L168)是同一组色值,搬动时合并到一处(放 `ui/shared.ts` 或 `CollagePadBody.tsx`),别留两份。
- 每搬一个文件就 `tsc` 一次,逐步缩小爆炸半径。

### 验收

`tsc --noEmit` 干净 + dev 起来(`web` 固定 `:3007`,见记忆 `dev-port`)肉眼过三段布局。无逻辑改动,回归面极小。

---

## 4. 阶段 1 — 抽 custom hooks(真重构,有回归风险)

核心难点:80 个函数共享同一批 ref/setter。设计上先建一个**共享 core**,再让各 hook 依赖它向下传。

### 4.1 依赖图

```
useStudioCore()
   │  持有所有底层 refs + 基础 setter:
   │  sessionsRef, sessionIdx/Ref, playingIdx/Ref, eng, ctxRef,
   │  setSessions, setTick, starting, swapGen, viewFollows, ...
   ▼
useHistory(core)            snapshot/pushHistory/applyEntry/undo/redo/mutate/updateSession   (L599–680)
   ▼
useEngineLoader(core)       loadInstrumentToEngine/loadSession/loadSessionAdditive/reconcile  (L426–520)
   ▼
useSongPlayback(core, history, loader)
        armSwap/scheduleNextSongBoundary/songPlayFrom/startPlayback/switchSession/
        changePlayMode/primeSongAutomation/applySongActiveSet/togglePlay/stopAllAudio  (L775–1150 散落)
useSessionDoc(core, history)
        add/remove/duplicate/copy/paste session + Song 拖拽(sessDrag*/songBlock*/songResize*/commitSongDrag)
useInstrumentOps(core, history)
        toggleInst/clickInst/copySelection/pasteClipboard/changeMixer/changeSends/
        patchInst/removeInst/moveInstrument/applySolo/toggleSolo/clearSolo
useCollageOps(core, history, loader)
        addPieceToCollage/writeCollageClip/moveCollagePiece/dropOnCollageLane/
        removeCollagePiece/duplicateCollagePiece/...(~15 个)
useLibrary(core)
        refreshGens/reloadLibrary/onGenerate/onUpload/onRetryGen/onDeleteGen/
        separateSound/auditionSound/importPastedAudio
useAutomation(core, history) changeXyAuto/changeVolAuto + rAF effect  (L1158–1233)
usePersistence(core)        flushOps + beforeunload/防抖 effects  (L1824–1895)
```

依赖几乎全指向 `useHistory`(`pushHistory`+`mutate`)和 `core.sessionsRef`,所以 **core 必须先抽、接口先稳定**。

### 4.2 命门 / 风险点

- **ref 一致性**:大量 `xxxRef.current = xxx` 的同步赋值散在 render body(如 `sessionIdxRef`、`playingRef`、`loopSongRef`)。抽 hook 时这套必须整簇搬,**漏一个就读到旧值**,会复现历史上的串场 bug。
- **起播重入锁** `starting`/`swapGen`/`viewFollows`(组件内,起播窗口锁)跨 `useSongPlayback` 与 `useEngineLoader` 两簇,归属要先定:建议放 `useStudioCore` 当共享 ref。
- **undo 口径**(`undo-constitution`):搬动绝不能漏掉任何一处 `pushHistory`。逐函数对照口径 7 项核验。
- **Song 顺序真源**(`session-index-vs-array-order`):`Session.index` 是主轨序唯一真源,结构编辑别用 reindex 抹回数组序——抽 `useSessionDoc` 时保持现有 `resnapSong`/`moveMainTo` 调用不变。
- **性能红利**:借这次把高频 setState(`playing`/`setTick`/song scroll)隔进各自 hook + memo 边界,顺带解掉 `studio-render-perf` 的全树重渲。但**别在同一个 PR 里既搬结构又改渲染语义**——先纯搬(行为等价),性能优化单独一步。
- **真机验证**:播放 / 换场 / 音频 headless 难测,必须真机耳验 + 点测拖拽。

### 4.3 落地顺序(每步独立可提交、可回滚)

1. `useStudioCore` —— 只搬 refs/state 声明,组件内用解构接回,行为零变化。
2. `useHistory` —— 最多人依赖,先稳。
3. `useEngineLoader`。
4. `usePersistence` + `useAutomation`(相对独立,低风险)。
5. `useLibrary`。
6. `useInstrumentOps`。
7. `useCollageOps`。
8. `useSessionDoc`。
9. `useSongPlayback`(依赖最重,最后)。

每步后:`tsc` + dev 真机过一遍对应功能。

---

## 5. 执行约束

- ⚠ **共享树**:仓库常处共享树(用户并行编辑)。每次开工前 `git status`,小步提交,别攒大 diff。
- 按 `doc-first-workflow`:阶段 1 动核心前,把 `useStudioCore` 的接口(暴露哪些 ref/setter)和 9 个 hook 的契约定稿(可并入本文件或 PRODUCT.md)再码。
- 阶段 0 与阶段 1 不混提交:阶段 0 是机械搬运(可快速 review),阶段 1 每个 hook 一个独立 PR。
