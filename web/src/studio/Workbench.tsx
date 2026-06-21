'use client';
// 项目工作台:列出当前用户项目 + 示例母版(§25)、新建、重命名、删除、打开 → /projects/[id]。
// §25:示例母版(别人标的,owned=false)只读 —— 点开 = 写时复制出我的副本再进;"删除"按钮变成"从我的列表隐藏"。
//      SUPER_ADMIN 在自己拥有的项目上多一个 ★ 开关,把项目标成/取消示例母版。
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { api, type ApiProject } from '@/studio/api';
import { ConfirmDialog, type ConfirmOpts } from '@/ui/ConfirmDialog';

export function Workbench({ username, isSuperAdmin = false }: { username: string; isSuperAdmin?: boolean }) {
  const router = useRouter();
  const [projects, setProjects] = useState<ApiProject[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmState, setConfirmState] = useState<(ConfirmOpts & { resolve: (v: boolean) => void }) | null>(null);
  // 通用确认弹窗:const ok = await askConfirm({...}); if (ok) ...
  const askConfirm = (opts: ConfirmOpts) => new Promise<boolean>((resolve) => setConfirmState({ ...opts, resolve }));

  const reload = async () => {
    try { setProjects(await api.projects.list()); } catch { setProjects([]); }
  };
  useEffect(() => { reload(); }, []);

  const create = async () => {
    if (busy) return;
    const name = (window.prompt('Project name', 'Untitled project') ?? '').trim();
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
            return (
              <div key={p.id} className="proj" onClick={() => open(p)} style={readOnlyExample ? { borderStyle: 'dashed' } : undefined}>
                <div className="pn">{p.name}</div>
                <div className="pm">{p.masterBpm} BPM · {p.quantize}</div>

                {/* 角标:只读示例 / 已发布母版(站长自己看) */}
                {readOnlyExample && (
                  <span style={badgeStyle} title="Read-only example — opening creates your own copy">Example · read-only</span>
                )}
                {isSuperAdmin && p.owned && p.isExample && (
                  <span style={{ ...badgeStyle, color: '#b8860b' }} title="Published as an example for everyone">★ Example</span>
                )}

                {/* 站长:在自己拥有的项目上切换示例母版 */}
                {isSuperAdmin && p.owned && (
                  <button
                    className="proj-star"
                    title={p.isExample ? 'Unpublish example' : 'Publish as example'}
                    aria-label={p.isExample ? `Unpublish ${p.name}` : `Publish ${p.name} as example`}
                    onClick={(e) => { e.stopPropagation(); toggleExample(p); }}
                    style={starStyle}
                  >
                    {p.isExample ? '★' : '☆'}
                  </button>
                )}

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
              </div>
            );
          })}
          {projects.length === 0 && <p className="muted" style={{ gridColumn: '1 / -1', marginTop: 4 }}>No projects yet. Click "＋ New project" to get started.</p>}
        </div>
      )}

      {confirmState && <ConfirmDialog {...confirmState} onConfirm={() => { confirmState.resolve(true); setConfirmState(null); }} onCancel={() => { confirmState.resolve(false); setConfirmState(null); }} />}
    </main>
  );
}

const badgeStyle: React.CSSProperties = {
  position: 'absolute', left: 10, bottom: 8, fontSize: 10, letterSpacing: 0.3,
  opacity: 0.7, textTransform: 'uppercase', pointerEvents: 'none',
};
const starStyle: React.CSSProperties = {
  position: 'absolute', top: 6, left: 8, background: 'none', border: 'none',
  cursor: 'pointer', fontSize: 15, lineHeight: 1, color: '#b8860b', padding: 2,
};
