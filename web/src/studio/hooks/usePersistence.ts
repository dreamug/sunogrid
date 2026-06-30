'use client';
// §15.C 自动保存发件箱:没有 Save —— 改即存,字段级细粒度 op。当前树 vs synced 快照 diff → 最小 op 列表
//   → POST /api/studio/ops;成功后 synced=target。保存锁串行化;保存期间又有改动则存完再存一次;失败退避重试 + 卸载守卫。
// 从 StudioApp.tsx 抽出(零行为变化)。⚠ loaded/synced ref 由 StudioApp 拥有并传入:load 完成时写入基准,本 hook 只读 loaded、读写 synced。
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Session } from '@/contracts';
import { normalize, diff, type Snapshot } from '@/studio/sync';

export function usePersistence({ projectId, sessions, sessionsRef, loaded, synced }: {
  projectId: string;
  sessions: Session[];
  sessionsRef: React.MutableRefObject<Session[]>;
  loaded: React.MutableRefObject<boolean>;
  synced: React.MutableRefObject<Snapshot>;
}) {
  const [sync, setSync] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle'); // 自动保存状态(替代 Save 按钮)
  const [saveErr, setSaveErr] = useState<string | null>(null); // 保存失败的真实原因(后端 500 body / 网络)——显式暴露,绝不再静默重试丢数据
  const saving = useRef(false); // 保存锁:避免并发 flush
  const pendingSave = useRef(false); // 保存期间又有改动 → 存完再存一次
  const retryTimer = useRef<ReturnType<typeof setTimeout> | null>(null); // 失败退避重试
  const retryCount = useRef(0); // 连续重试次数:可重试错误(网络/5xx/skipped)退避递增并设上限,挡无限 retry storm

  const flushOps = useCallback(async (fromRetry = false) => {
    if (saving.current) { pendingSave.current = true; return; }
    if (!fromRetry) retryCount.current = 0; // 新的(非重试)flush = 用户又改了 → 重置退避计数,outage 恢复后能重新自动重试
    saving.current = true;
    do {
      pendingSave.current = false;
      const target = normalize(sessionsRef.current);
      const ops = diff(synced.current, target);
      if (ops.length === 0) break; // 无实质变化
      setSync('saving');
      try {
        const r = await fetch('/api/studio/ops', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ projectId, ops }) });
        if (!r.ok) {
          const body = await r.text().catch(() => '');
          // 错误是否值得重试:网络层(下面 catch 里没 status 的)、429、5xx = 瞬态可重试;其余 4xx(400 坏 op/403/404)= 永久,重试也是同样的毒 op,只会 storm。
          const retryable = r.status === 429 || r.status >= 500;
          const e = new Error(`HTTP ${r.status}${body ? ` · ${body.slice(0, 300)}` : ''}`) as Error & { retryable?: boolean };
          e.retryable = retryable;
          throw e;
        }
        const res = await r.json().catch(() => null);
        // 后端据实回报丢弃数:若 skipped>0,说明有 op 的父 session/instrument 不在库(基准失配)——
        // 绝不能当成功推进基准,否则又变回"显示 Saved 实则没存"。当失败处理,基准不动、下次带 sess.add 重发(可重试)。
        if (res && res.skipped) { const e = new Error(`后端丢弃了 ${res.skipped} 条改动(父 session/instrument 不在库)`) as Error & { retryable?: boolean }; e.retryable = true; throw e; }
        synced.current = target; // 这批已落库,推进基准
        retryCount.current = 0;
        if (retryTimer.current) { clearTimeout(retryTimer.current); retryTimer.current = null; }
        setSync('saved'); setSaveErr(null);
      } catch (err) {
        // 关键:别再静默吞掉失败。真实原因打到 console,并经 saveErr 弹横幅。
        // ⚠ 但绝不能无脑每 3s 重试同一批:永久错误(400 坏 op / Prisma Unknown arg 这类 schema 失配)重试一万次还是同样的毒 op ——
        //   只会无限 storm。故区分可重试(网络/429/5xx/skipped,带退避 + 次数上限)与永久(其余 4xx,直接停手只留横幅)。
        const e = err as Error & { retryable?: boolean };
        const isNetwork = !(err instanceof Error) || e.retryable === undefined; // fetch reject(断网/CORS)= 无 status,按瞬态处理
        const retryable = isNetwork || e.retryable === true;
        const msg = e instanceof Error ? e.message : String(err);
        setSync('error'); setSaveErr(msg);
        saving.current = false;
        const MAX_RETRY = 8;
        if (retryable && retryCount.current < MAX_RETRY) {
          retryCount.current += 1;
          const delay = Math.min(30_000, 3000 * retryCount.current); // 线性退避封顶 30s
          console.error(`[studio] 保存失败(可重试 ${retryCount.current}/${MAX_RETRY},${delay}ms 后重试):`, msg, ops);
          if (!retryTimer.current) retryTimer.current = setTimeout(() => { retryTimer.current = null; flushOps(true); }, delay);
        } else {
          // 永久错误,或重试次数耗尽:停手。基准不前进(改动仍在内存),横幅长亮提示用户——别再 storm。
          console.error(`[studio] 保存失败,已停止重试(${retryable ? '次数耗尽' : '永久错误'}),改动仍只在内存里:`, msg, ops);
        }
        return;
      }
    } while (pendingSave.current);
    saving.current = false;
  }, [projectId]);

  // 防抖:sessions 有实质变化 → 350ms 后落库(加载完成前不触发)。diff 天然合并连续改动。
  useEffect(() => {
    if (!loaded.current) return;
    if (diff(synced.current, normalize(sessionsRef.current)).length === 0) return;
    const t = setTimeout(() => { flushOps(); }, 350);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessions, flushOps]);
  useEffect(() => () => { if (retryTimer.current) clearTimeout(retryTimer.current); }, []); // 卸载清掉待跑的退避重试定时器
  // 离开/刷新守卫:仍有改动没落库(正在保存,或 diff 非空=被卡住的重试)→ 拦一下浏览器卸载,
  // 避免重演"退出即丢全部 pad"。注:只挡整页刷新/关标签;App Router 客户端路由跳转挡不住(那条另说)。
  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (!loaded.current) return;
      const dirty = saving.current || diff(synced.current, normalize(sessionsRef.current)).length > 0;
      if (dirty) { e.preventDefault(); e.returnValue = ''; }
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, []);

  return { sync, saveErr };
}
