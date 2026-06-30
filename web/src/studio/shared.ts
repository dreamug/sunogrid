// Studio 跨件共享小工具 + 调色板。从 StudioApp.tsx 抽出(零行为变化),供主壳 / 各 UI 子件统一引用,免散落复制多份。
import type { CSSProperties } from 'react';

// 客户端生成稳定 id(§15:落库与内存共用同一 id,支撑自动保存,刷新不变)。
export const nid = (p: string) => `${p}-${crypto.randomUUID()}`;
export const cvar = (c: string): CSSProperties => ({ ['--c']: c } as CSSProperties);

export const PX = 12;
export const FAINT = 'rgba(255,255,255,0.032)'; // 很浅的网格线

// collage 每片配色:按片序号轮一个调色板(相邻片必不同色,方便分辨);lane 与 pad 用同一序号 → 同片同色。
// CHIP_COLORS(乐器/session 换色浮层用)与 SLICE_COLORS 是同一组色值 —— 合并到一处,别再留两份。
const SLICE_COLORS = ['#c2724f', '#6a86a0', '#c2a24f', '#8a9b6a', '#a06f8a', '#9a7bc0', '#5a9b9b', '#b56a6a']; // 模块私有:外部走 CHIP_COLORS(别名)/sliceColorFor
export const CHIP_COLORS = SLICE_COLORS; // 别名:InstrumentChip 换色浮层沿用旧名
const sliceColor = (i: number) => SLICE_COLORS[((i % SLICE_COLORS.length) + SLICE_COLORS.length) % SLICE_COLORS.length]; // 模块私有:仅 sliceColorFor 用
// 按片 id 哈希取色 —— 稳定:排序/拖移/重排都不变色(别用数组下标,下标会随 sortItems 漂)。
export const sliceColorFor = (id: string) => { let h = 0; for (let k = 0; k < id.length; k++) h = (Math.imul(h, 31) + id.charCodeAt(k)) | 0; return sliceColor(h); };

// §37 Song zoom(px/bar)上下限 + 默认。StudioApp 主体与 SongZoomScope 共用,故落 shared。
export const SONG_ZOOM_DEFAULT = 40; // §37 Song zoom 默认 px/bar = 滑块正中(范围 20..60);双击 slider 回到这里
// perf:song zoom 全局上下限 —— 所有入口(滑块/Alt 滚轮/触控板 pinch)统一钳在这区间,
//   防极端 zoom 把 song-content 撑到上万 px(宽渐变 + 元素重排重绘炸主线程)。原来 Alt 滚轮越界到 16..220 是卡顿源。
const SONG_ZOOM_MIN = 20, SONG_ZOOM_MAX = 60; // 模块私有:外部走 clampZoom(钳的入口)/SONG_ZOOM_DEFAULT
export const clampZoom = (z: number) => (z < SONG_ZOOM_MIN ? SONG_ZOOM_MIN : z > SONG_ZOOM_MAX ? SONG_ZOOM_MAX : z);
