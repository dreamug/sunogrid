// Song 模式纯查询 + 空工程兜底。从 StudioApp.tsx 抽出(零行为变化):只读派生,无副作用、无状态。
import type { Session } from '@/contracts';
import { activeInstruments, resolveInstruments, isMainLane, sessionSongEndBar, sessionSongLane, sessionSongStartBar, SESSION_COLORS } from '@/contracts';
import { resnapSong } from '@/studio/songLayout';
import { nid } from '@/studio/shared';

// 空工程兜底:1 个默认会话(与服务端 /api/studio 一致;真正落库由首次保存的 sess.add 完成)
export const emptySessions = (): Session[] => [
  { id: nid('sess'), name: 'Scene 1', index: 0, songLane: 0, songStartBar: 0, repeats: 1, color: SESSION_COLORS[0], instruments: [] }, // §37 默认场景即带色(非 null)→ 新工程不触发加载补色的早期 sess.add
];

export function normalizeSongLayout(sessions: Session[]): Session[] {
  return resnapSong(sessions); // §37 加载即派生:主轨吸附 / sub 锚定跟随 / 失效锚降级孤儿
}

export function songTotalBars(sessions: Session[]): number {
  return sessions.reduce((m, s) => Math.max(m, sessionSongEndBar(s)), 0);
}

export const SONG_TRACK_COUNT = 10; // §37 Song 固定 track 数(Main + Sub 1..9);不增删,空轨常驻,arranger 纵向 scroll。
export function songLaneCount(sessions: Session[]): number {
  return sessions.reduce((m, s) => Math.max(m, sessionSongLane(s) + 1), 1);
}

export function songActiveAt(sessions: Session[], bar: number): Session[] {
  return sessions.filter((s) => {
    const start = sessionSongStartBar(s), end = sessionSongEndBar(s);
    return bar >= start && bar < end;
  });
}

/** §37 多轨「前景块」= 驱动播放头跟随 / 视图 / XY automation 的那一块。统一口径:主轨块(lane 0)优先(歌的主干),否则当前重叠中最晚开始的 active 块。prime 与稳态 coordinator 必须用同一个,免 XY automation 来源在起播瞬间和稳态打架。 */
export function songForeground(active: Session[]): Session | undefined {
  if (!active.length) return undefined;
  return active.find(isMainLane) ?? [...active].sort((a, b) => sessionSongStartBar(b) - sessionSongStartBar(a))[0];
}

export function songNextBoundaryAfter(sessions: Session[], bar: number): number | null {
  let next: number | null = null;
  for (const s of sessions) {
    for (const b of [sessionSongStartBar(s), sessionSongEndBar(s)]) {
      if (b > bar + 1e-6 && (next == null || b < next)) next = b;
    }
  }
  return next;
}

export const sessionInstIds = (sessions: Session[]): string[] => sessions.flatMap((s) => resolveInstruments(s).map((i) => i.id));
// §37 只起「激活(enabled)」乐器的 voice:Song 播放起声路径用它(停声仍用全部 sessionInstIds),否则禁用乐器也会随块进 active 被点响。
export const enabledInstIds = (sessions: Session[]): string[] => sessions.flatMap((s) => activeInstruments(s).map((i) => i.id));
