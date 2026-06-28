// §37 Song 多轨布局 —— 纯逻辑(无 DOM/引擎/DB 依赖,`npx tsx songLayout.test.ts` 可跑)。
//
// 两套时间坐标系(见 PRODUCT §37.1):
//   · 主轨(songLane 0)= 吸附序列,songStartBar 派生(按 index 序累加 bars×reps)。
//   · Sub 轨(songLane>0)= 寄生锚定:锚定态 start=锚.start+offset;孤儿态(锚失效/为空)保留自存绝对值。
// 全部联动靠「songStartBar 是派生量」自动成立,不靠监听器。resnapSong = 唯一重算入口。
import type { Session, XYAutoSet, XYProgram } from '@/contracts';
import { sessionBars, sessionRepeats, sessionSongLane, sessionSongStartBar, sessionSongEndBar, sessionSongAnchor, sessionSongOffset, isMainLane } from '@/contracts';
import { rescaleAuto } from './xyAutomation';

// §37 子轨 automation 贴合 T:子轨 reps 恒 1、T=bars 固定;主→子转换或历史遗留可能留下「超 T」的点(原是更长主轨的点 → 显 +N beyond、后抓点跑出视野)。
//   按 T/maxBar 缩放回 [0,T](对默认数据 ratio=T/(bars×oldReps)=1/oldReps,等价 setSessionRepeats 的缩放);max≤T 原样返回 → idempotent、不动正常子轨。
function fitSubAuto(s: Session): Session {
  const auto = s.xyAuto; if (!auto) return s;
  const T = sessionBars(s); let max = 0;
  for (const k of Object.keys(auto) as XYProgram[]) { const a = auto[k]; if (!a) continue; for (const p of a.x) if (p.bar > max) max = p.bar; for (const p of a.y) if (p.bar > max) max = p.bar; }
  if (max <= T + 1e-6) return s;
  const ratio = T / max, next: XYAutoSet = {};
  for (const k of Object.keys(auto) as XYProgram[]) { const a = auto[k]; if (a) next[k] = rescaleAuto(a, ratio); }
  return { ...s, xyAuto: next };
}

/** 主轨 session,按 index 升序(= 吸附播放顺序)。 */
export function mainSessions(sessions: Session[]): Session[] {
  return sessions.filter(isMainLane).sort((a, b) => a.index - b.index);
}

export interface MainLayout {
  /** 主 session id → 起始 bar。 */
  start: Record<string, number>;
  /** 主 session id → 长度 bar(bars×reps);子轨夹范围用。 */
  len: Record<string, number>;
  /** 主轨总长(bar)。 */
  total: number;
  /** 主 session id 顺序。 */
  order: string[];
}

/** 主轨吸附布局:各主 session 起始 bar(前面累加)+ 各自长度。 */
export function mainLayout(sessions: Session[]): MainLayout {
  const start: Record<string, number> = {};
  const len: Record<string, number> = {};
  const order: string[] = [];
  let acc = 0;
  for (const s of mainSessions(sessions)) {
    const l = sessionBars(s) * sessionRepeats(s);
    start[s.id] = acc;
    len[s.id] = l;
    order.push(s.id);
    acc += l;
  }
  return { start, len, total: acc, order };
}

/** 落在绝对 bar 处的主 session(`[start,end)` 含 bar);无则 null。 */
export function mainAtBar(sessions: Session[], bar: number): Session | null {
  const { start } = mainLayout(sessions);
  for (const s of mainSessions(sessions)) {
    const st = start[s.id];
    const len = sessionBars(s) * sessionRepeats(s);
    if (bar >= st && bar < st + len) return s;
  }
  return null;
}

/**
 * 唯一重算入口:把每个 session 的 songStartBar 重排到目标态。
 *  · 主轨:start=累加,清 anchor/offset。
 *  · sub 锚定(anchor 存在且指向现存主块):start=锚.start+offset,repeats 锁 1。
 *  · sub 孤儿(无锚 / 锚已失效):保留自存 songStartBar(= 上次 resnap 的绝对位置 → 删主块即「冻结原地」),清 anchor,repeats 锁 1。
 * 只在值真变时换新对象(减少 React/sync churn)。
 */
export function resnapSong(sessions: Session[], ignorePackId?: string): Session[] {
  const { start, len } = mainLayout(sessions);
  // §37 #1 禁叠放守恒:拖放只在 commitSongDrag 拦叠放,但夹随/删主块/改 reps 这些自动路径也会造重叠
  //   ——多个子轨锚同一主块、同 lane,主块缩短时全被夹到「末端−子长」同一位置 = 确定性互叠、会一起出声。
  //   解法:夹后再按位从右往左顺次堆放——最右块留夹后位,左侧块依次让到前块之前(bounded ≥0)。
  //   只动派生 start、不改存储 offset(加长复原即回原位 → 可逆);孤儿不参与(手动放置、冻结原地)。
  const packed = new Map<string, number>();
  const byLane = new Map<number, Session[]>();
  for (const s of sessions) {
    if (isMainLane(s)) continue;
    if (s.id === ignorePackId) continue; // 拖动中的块不参与让位:其预览落点 = 真实夹后落点(与 commitSongDrag 的 strict 叠放判定一致)、其他块也不围着未落定的块重排
    const anchorId = sessionSongAnchor(s);
    if (anchorId == null || start[anchorId] == null) continue;
    const lane = sessionSongLane(s);
    const arr = byLane.get(lane) ?? []; arr.push(s); byLane.set(lane, arr);
  }
  for (const arr of byLane.values()) {
    const placed = arr.map((s) => {
      const a = sessionSongAnchor(s)!;
      const maxOff = Math.max(0, len[a] - sessionBars(s));
      return { s, ns: start[a] + Math.max(0, Math.min(sessionSongOffset(s), maxOff)), bars: sessionBars(s) };
    }).sort((a, b) => b.ns - a.ns || sessionSongOffset(b.s) - sessionSongOffset(a.s) || (a.s.id < b.s.id ? 1 : -1));
    let rightLimit = Infinity;
    for (const p of placed) { const ns = Math.max(0, Math.min(p.ns, rightLimit - p.bars)); packed.set(p.s.id, ns); rightLimit = ns; }
  }
  return sessions.map((s) => {
    if (isMainLane(s)) {
      const ns = start[s.id] ?? 0;
      if (s.songStartBar === ns && !sessionSongAnchor(s) && (s.songOffsetBar ?? 0) === 0) return s;
      return { ...s, songStartBar: ns, songAnchorId: null, songOffsetBar: 0 };
    }
    const f = fitSubAuto(s); // §37 子轨 automation 贴合 T(超 T 点缩放回来,后抓点回到边缘);无超 T 则 f===s
    const anchorId = sessionSongAnchor(s);
    if (anchorId != null && start[anchorId] != null) {
      // §37 子轨夹进锚主块范围:offset 夹到 [0, 锚长度−子长度]。锚主块自身缩短/子轨变长(case #5/#7/#8)→ 子轨骑住末端跟着左移;
      //   加长复原 → 回到原 offset。⚠ 只夹「派生出的 start」、不动存储的 songOffsetBar → 非破坏、可逆。
      const maxOff = Math.max(0, len[anchorId] - sessionBars(s));
      const ns = packed.get(s.id) ?? (start[anchorId] + Math.max(0, Math.min(sessionSongOffset(s), maxOff))); // #1 含同 lane 让位后的最终落点
      if (f === s && s.songStartBar === ns && s.repeats === 1 && s.songAnchorId === anchorId) return s;
      return { ...f, songStartBar: ns, songAnchorId: anchorId, repeats: 1 };
    }
    // 孤儿:保留绝对位置,清锚
    const ns = sessionSongStartBar(s);
    if (f === s && s.songStartBar === ns && s.repeats === 1 && (s.songAnchorId ?? null) === null && (s.songOffsetBar ?? 0) === 0) return s;
    return { ...f, songStartBar: ns, songAnchorId: null, songOffsetBar: 0, repeats: 1 };
  });
}

/** Song 总长(bar)= 所有块末缘最大值。须在 resnapSong 之后调(读派生好的 songStartBar)。 */
export function songTotalBars(sessions: Session[]): number {
  return sessions.reduce((m, s) => Math.max(m, sessionSongStartBar(s) + sessionBars(s) * sessionRepeats(s)), 0);
}

/** lane 数量兜底(无 Project.songLanes 时由 max(songLane)+1 推;UI 优先用命名 track 列表)。 */
export function deriveLaneCount(sessions: Session[]): number {
  return sessions.reduce((m, s) => Math.max(m, sessionSongLane(s) + 1), 1);
}

/**
 * §37 子轨复制落点:同 lane,从 afterBar 起向右找第一个能放下 width 的空档,紧贴前一块。
 * [cursor, cursor+width) 与同 lane 任一块(按当前 resolved 位置)相交 → cursor 跳到该块末再试,直到放得下。
 * 用于 ⌘D/⧉ 复制子轨:紧贴原块之后;空隙不够则顺次贴到下一块之后,直到够。纯函数,可单测。
 */
export function nextFreeSubStart(sessions: Session[], lane: number, afterBar: number, width: number): number {
  const blocks = sessions
    .filter((s) => sessionSongLane(s) === lane)
    .map((s) => ({ start: sessionSongStartBar(s), end: sessionSongEndBar(s) }))
    .sort((a, b) => a.start - b.start);
  let cursor = Math.max(0, afterBar);
  for (let guard = 0; guard <= blocks.length; guard++) {
    const hit = blocks.find((b) => cursor < b.end && cursor + width > b.start);
    if (!hit) break;
    cursor = hit.end; // 空隙不够 → 紧贴这块之后再试
  }
  return cursor;
}

/**
 * §37 把一个 sub 落到绝对 startBar + lane → 算锚定 patch(用户主动拖才调)。
 * 起点落在某主 session 区间内 → 锚它(offset=起点−锚.start);否则孤儿(存绝对 start)。
 */
export function anchorPatchAt(sessions: Session[], startBar: number, lane: number): Partial<Session> {
  const sb = Math.max(0, Math.round(startBar));
  const host = mainAtBar(sessions, sb);
  if (host) {
    const { start } = mainLayout(sessions);
    return { songLane: lane, songAnchorId: host.id, songOffsetBar: Math.max(0, sb - start[host.id]), repeats: 1, songStartBar: sb };
  }
  return { songLane: lane, songAnchorId: null, songOffsetBar: 0, repeats: 1, songStartBar: sb };
}

/**
 * §37 子轨落子最终态(纯函数,可单测;commitSongDrag 与之共用,避免 React 层手算落点和真实落点错位)。
 * 把 workId 锚定到 (vbar, vlane) 后跑 resnap(workId 不参与 #1 让位 → 它的 startBar = 真实落点),
 * 返回最终 startBar + 是否与同 lane 他块叠放。
 * ⚠ 关键边角:主轨块拖到子轨 → 它锚到自己、转 sub 后锚失效 → 降级孤儿落在裸 vbar(不夹);此函数走 resnap 故坐标恒准。
 */
export function subDropLanding(sessions: Session[], workId: string, vbar: number, vlane: number): { startBar: number; overlap: boolean } {
  const patch = anchorPatchAt(sessions, vbar, vlane);
  const next = sessions.map((s) => (s.id === workId ? ({ ...s, ...patch } as Session) : s));
  const probe = resnapSong(next, workId);
  const me = probe.find((s) => s.id === workId);
  if (!me) return { startBar: Math.max(0, Math.round(vbar)), overlap: false };
  const sb = sessionSongStartBar(me), bars = sessionBars(me);
  const overlap = probe.some((o) => o.id !== workId && sessionSongLane(o) === vlane && sb < sessionSongEndBar(o) && sb + bars > sessionSongStartBar(o));
  return { startBar: sb, overlap };
}

/** §37 主块落点 dropBar → 应插入的主轨第几位(按现有主块中心比较;excludeId=被拖块自己)。 */
export function mainInsertIndex(sessions: Session[], dropBar: number, excludeId?: string): number {
  const { start } = mainLayout(sessions);
  let idx = 0;
  for (const s of mainSessions(sessions)) {
    if (s.id === excludeId) continue;
    const center = start[s.id] + (sessionBars(s) * sessionRepeats(s)) / 2;
    if (center < dropBar) idx++;
  }
  return idx;
}

/**
 * §37 把主块 id 移到主轨第 toMainIdx 位:只在主块占用的那批 index 槽位内做排列,
 * sub 的 index 不动(避免扰动 Live rail 场景列表序)。返回新 sessions(仅 index 变的换对象)。
 */
export function moveMainTo(sessions: Session[], id: string, toMainIdx: number): Session[] {
  const mains = mainSessions(sessions);
  const moving = mains.find((s) => s.id === id);
  if (!moving) return sessions;
  const slots = mains.map((s) => s.index).slice().sort((a, b) => a - b); // 主块占用的 index 值集合
  const ordered = mains.filter((s) => s.id !== id);
  const at = Math.max(0, Math.min(ordered.length, Math.round(toMainIdx)));
  ordered.splice(at, 0, moving);
  const newIndex: Record<string, number> = {};
  ordered.forEach((s, i) => { newIndex[s.id] = slots[i]; });
  return sessions.map((s) => (s.id in newIndex && newIndex[s.id] !== s.index ? { ...s, index: newIndex[s.id] } : s));
}
