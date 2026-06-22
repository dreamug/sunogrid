'use client';
// 项目工作台:列出当前用户项目 + 示例母版(§25)、新建、重命名、删除、打开 → /projects/[id]。
// §25:示例母版(别人标的,owned=false)只读 —— 点开 = 写时复制出我的副本再进;"删除"按钮变成"从我的列表隐藏"。
//      SUPER_ADMIN 在自己拥有的项目上多一个 ★ 开关,把项目标成/取消示例母版。
import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { api, type ApiProject } from '@/studio/api';
import { ConfirmDialog, type ConfirmOpts } from '@/ui/ConfirmDialog';
import { BridgeInstall } from '@/ui/BridgeInstall';
import { promptText } from '@/ui/promptText';

export function Workbench({ username, isSuperAdmin = false }: { username: string; isSuperAdmin?: boolean }) {
  const router = useRouter();
  const [projects, setProjects] = useState<ApiProject[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [menuFor, setMenuFor] = useState<string | null>(null); // 哪张卡片的 ⋯ 菜单展开(站长发布/删除)
  const [confirmState, setConfirmState] = useState<(ConfirmOpts & { resolve: (v: boolean) => void }) | null>(null);
  // 通用确认弹窗:const ok = await askConfirm({...}); if (ok) ...
  const askConfirm = (opts: ConfirmOpts) => new Promise<boolean>((resolve) => setConfirmState({ ...opts, resolve }));

  // 右上角"Get the bridge"弹层:点按钮开/关,点外面关。
  const [bridgeOpen, setBridgeOpen] = useState(false);
  const bridgeRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!bridgeOpen) return;
    const onDown = (e: MouseEvent) => {
      if (bridgeRef.current && !bridgeRef.current.contains(e.target as Node)) setBridgeOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [bridgeOpen]);

  const reload = async () => {
    try { setProjects(await api.projects.list()); } catch { setProjects([]); }
  };
  useEffect(() => { reload(); }, []);

  const create = async () => {
    if (busy) return;
    const name = ((await promptText('Project name', 'Untitled project')) ?? '').trim();
    if (name === '') return; // 取消
    setBusy(true);
    try {
      const p = await api.projects.create({ name });
      router.push(`/projects/${p.id}`);
    } catch { setBusy(false); }
  };

  // 打开项目。示例母版(只读)→ 先 fork 出我的副本,再进副本。
  const open = async (p: ApiProject) => {
    if (busy) return;
    const readOnlyExample = p.isExample && !p.owned;
    if (!readOnlyExample) { router.push(`/projects/${p.id}`); return; }
    setBusy(true);
    try {
      const { id } = await api.projects.fork(p.id);
      router.push(`/projects/${id}`);
    } catch { setBusy(false); }
  };

  // 删除 / 隐藏。示例母版(只读)= 从我的列表隐藏(不删母版);自己的项目 = 真删。
  const remove = async (p: ApiProject) => {
    if (p.isExample && !p.owned) {
      if (!(await askConfirm({ title: `Remove example "${p.name}"?`, message: 'It will be hidden from your list. This does not delete the example for others.', confirmLabel: 'Remove' }))) return;
      setProjects((ps) => ps?.filter((x) => x.id !== p.id) ?? ps);
      try { await api.projects.dismiss(p.id); } catch { reload(); }
      return;
    }
    if (!(await askConfirm({ title: `Delete "${p.name}"?`, message: 'Its sessions and generation history will be removed (your sound library is kept).', confirmLabel: 'Delete', danger: true }))) return;
    setProjects((ps) => ps?.filter((x) => x.id !== p.id) ?? ps);
    try { await fetch(`/api/projects/${p.id}`, { method: 'DELETE' }); } catch { reload(); }
  };

  // SUPER_ADMIN:把自己拥有的项目标成/取消示例母版。
  const toggleExample = async (p: ApiProject) => {
    const next = !p.isExample;
    setProjects((ps) => ps?.map((x) => (x.id === p.id ? { ...x, isExample: next } : x)) ?? ps);
    try { await api.projects.update(p.id, { isExample: next }); } catch { reload(); }
  };

  const logout = async () => {
    await fetch('/api/auth/logout', { method: 'POST' }).catch(() => {});
    router.replace('/login');
    router.refresh();
  };

  return (
    <main className="wb">
      <div className="wb-top">
        <h1>My projects</h1>
        <div className="who">
          <div className="wb-ext" ref={bridgeRef}>
            <button className="wb-get" onClick={() => setBridgeOpen((o) => !o)} aria-expanded={bridgeOpen}>
              <img src="/suno.png" alt="" width={16} height={16} />
              Get the bridge
              <span className="wb-get-cv">▾</span>
            </button>
            {bridgeOpen && <div className="wb-ext-pop"><BridgeInstall variant="popover" /></div>}
          </div>
          <span>{username}</span>
          <button className="btn" style={{ padding: '6px 14px' }} onClick={logout}>Log out</button>
        </div>
      </div>

      {projects === null ? (
        <p className="muted">Loading…</p>
      ) : (
        <div className="wb-grid">
          <button className="proj new" onClick={create} disabled={busy}>＋ New project</button>
          {projects.map((p) => {
            const readOnlyExample = p.isExample && !p.owned;
            const publishedMaster = isSuperAdmin && p.owned && p.isExample;
            const isExampleCard = readOnlyExample || publishedMaster;
            const adminOwned = isSuperAdmin && p.owned; // 站长在自己项目上有 ⋯ 菜单(发布/取消 + 删除)
            const menuOpen = menuFor === p.id;
            return (
              <div key={p.id} className={isExampleCard ? 'proj is-example' : 'proj'} onClick={() => open(p)}>
                <div className="pn">{p.name}</div>
                <div className="pm">{p.masterBpm} BPM · {p.quantize}</div>

                {/* 示例卡片底栏:左=状态行(站长看"对所有人可见" / 用户看"打开即建副本"),右=金色 Example 角标 */}
                {isExampleCard && (
                  <div className="proj-foot">
                    {publishedMaster ? (
                      <span className="proj-status" title="Published as an example for everyone">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                          <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z" /><circle cx="12" cy="12" r="3" />
                        </svg>
                        Visible to all
                      </span>
                    ) : (
                      <span className="proj-status fork" title="Opening creates your own editable copy">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                          <rect x="9" y="9" width="11" height="11" rx="2" /><path d="M5 15V5a2 2 0 0 1 2-2h10" />
                        </svg>
                        Opens a copy
                      </span>
                    )}
                    <span className="proj-badge">
                      <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                        <path d="M12 17.27L18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z" />
                      </svg>
                      Example
                    </span>
                  </div>
                )}

                {/* 控制:站长拥有的项目 → ⋯ 菜单(发布/取消 + 删除);其余 → 单按钮(删除 / 从列表移除) */}
                {adminOwned ? (
                  <div className="proj-menu-wrap" onClick={(e) => e.stopPropagation()}>
                    <button
                      className={menuOpen ? 'proj-act open' : 'proj-act'}
                      title="Actions"
                      aria-label={`Actions for ${p.name}`}
                      aria-haspopup="menu"
                      aria-expanded={menuOpen}
                      onClick={() => setMenuFor(menuOpen ? null : p.id)}
                    >
                      <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                        <circle cx="5" cy="12" r="1.7" /><circle cx="12" cy="12" r="1.7" /><circle cx="19" cy="12" r="1.7" />
                      </svg>
                    </button>
                    {menuOpen && (
                      <div className="proj-menu" role="menu">
                        <button role="menuitem" className="mi feat" onClick={() => { setMenuFor(null); toggleExample(p); }}>
                          <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                            <path d="M12 17.27L18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z" />
                          </svg>
                          {p.isExample ? 'Unpublish example' : 'Publish as example'}
                        </button>
                        <div className="mi-div" />
                        <button role="menuitem" className="mi danger" onClick={() => { setMenuFor(null); remove(p); }}>
                          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                            <path d="M3 6h18" /><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                            <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" /><path d="M10 11v6" /><path d="M14 11v6" />
                          </svg>
                          Delete project
                        </button>
                      </div>
                    )}
                  </div>
                ) : (
                  <button
                    className="proj-del"
                    title={readOnlyExample ? 'Remove from my list' : 'Delete project'}
                    aria-label={readOnlyExample ? `Remove ${p.name} from my list` : `Delete ${p.name}`}
                    onClick={(e) => { e.stopPropagation(); remove(p); }}
                  >
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <path d="M3 6h18" />
                      <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                      <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
                      <path d="M10 11v6" /><path d="M14 11v6" />
                    </svg>
                  </button>
                )}
              </div>
            );
          })}
          {projects.length === 0 && <p className="muted" style={{ gridColumn: '1 / -1', marginTop: 4 }}>No projects yet. Click "＋ New project" to get started.</p>}
        </div>
      )}

      {menuFor && <div className="proj-menu-backdrop" onClick={() => setMenuFor(null)} />}
      {confirmState && <ConfirmDialog {...confirmState} onConfirm={() => { confirmState.resolve(true); setConfirmState(null); }} onCancel={() => { confirmState.resolve(false); setConfirmState(null); }} />}
    </main>
  );
}
