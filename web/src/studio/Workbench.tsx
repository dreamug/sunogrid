'use client';
// 项目工作台:列出当前用户项目、新建、重命名、删除、打开 → /projects/[id]。
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { api, type ApiProject } from '@/studio/api';

export function Workbench({ username }: { username: string }) {
  const router = useRouter();
  const [projects, setProjects] = useState<ApiProject[] | null>(null);
  const [busy, setBusy] = useState(false);

  const reload = async () => {
    try { setProjects(await api.projects.list()); } catch { setProjects([]); }
  };
  useEffect(() => { reload(); }, []);

  const create = async () => {
    if (busy) return;
    const name = (window.prompt('项目名称', '未命名项目') ?? '').trim();
    if (name === '') return; // 取消
    setBusy(true);
    try {
      const p = await api.projects.create({ name });
      router.push(`/projects/${p.id}`);
    } catch { setBusy(false); }
  };

  const rename = async (p: ApiProject) => {
    const name = (window.prompt('重命名项目', p.name) ?? '').trim();
    if (name === '' || name === p.name) return;
    setProjects((ps) => ps?.map((x) => (x.id === p.id ? { ...x, name } : x)) ?? ps);
    try { await api.projects.update(p.id, { name }); } catch { reload(); }
  };

  const remove = async (p: ApiProject) => {
    if (!window.confirm(`删除项目「${p.name}」?其操场与生成记录都会删除(素材库保留)。`)) return;
    setProjects((ps) => ps?.filter((x) => x.id !== p.id) ?? ps);
    try { await fetch(`/api/projects/${p.id}`, { method: 'DELETE' }); } catch { reload(); }
  };

  const logout = async () => {
    await fetch('/api/auth/logout', { method: 'POST' }).catch(() => {});
    router.replace('/login');
    router.refresh();
  };

  return (
    <main className="wb">
      <div className="wb-top">
        <h1>我的项目</h1>
        <div className="who">
          <span>{username}</span>
          <button className="btn" style={{ padding: '6px 14px' }} onClick={logout}>退出</button>
        </div>
      </div>

      {projects === null ? (
        <p className="muted">加载中…</p>
      ) : (
        <div className="wb-grid">
          <button className="proj new" onClick={create} disabled={busy}>＋ 新建项目</button>
          {projects.map((p) => (
            <div key={p.id} className="proj" onClick={() => router.push(`/projects/${p.id}`)}>
              <div className="pn">{p.name}</div>
              <div className="pm">{p.masterBpm} BPM · {p.quantize}</div>
              <div className="pr" onClick={(e) => e.stopPropagation()}>
                <button onClick={() => rename(p)}>重命名</button>
                <button className="del" onClick={() => remove(p)}>删除</button>
              </div>
            </div>
          ))}
          {projects.length === 0 && <p className="muted" style={{ gridColumn: '1 / -1', marginTop: 4 }}>还没有项目,点「＋ 新建项目」开始。</p>}
        </div>
      )}
    </main>
  );
}
