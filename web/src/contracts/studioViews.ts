// Studio 库/生成视图模型 —— 纯展示类型,从 API Sound/Gen 投影到 studio UI。
// (原住在已删除的 studio/useLoopMachine.ts;旧 pad 机退场后抽到契约层共享。)
// 注:GenStatus 与 contracts/bridge.ts 的 GenStatus 同名但语义不同(那是 Suno 桥接协议态),
//     故本文件不并入 '@/contracts' 桶导出 —— 消费方按路径 '@/contracts/studioViews' 直接引入,避免桶内重名。

/** 库卡/loop 单条的展示态。 */
export type LoopStatus = 'auto' | 'pending' | 'manual';
export interface LoopView {
  id: string; label: string; status: LoopStatus; srcBpm: number; bars: number; color: string;
  durationSec: number; musicalKey?: string | null; // 库卡展示用:秒数 + 调
  stemKind?: string; stemStatus?: string | null; stems?: LoopView[]; // 乐器分离
}

// 生成块:点生成就有,状态都在块上;完成后带两个变体(像 Suno)。
export type GenStatus = 'generating' | 'streaming' | 'uploading' | 'detecting' | 'complete' | 'failed';
export interface GenView { id: string; prompt: string; mode: string; status: GenStatus; error?: string; sounds: LoopView[]; bpm?: number; musicalKey?: string; loop?: boolean; source?: 'suno' | 'upload' }
