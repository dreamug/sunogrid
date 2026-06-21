import { redirect, notFound } from 'next/navigation';
import { getCurrentUser } from '@/lib/auth';
import { db } from '@/lib/db';
import { forkExampleProject } from '@/lib/forkProject';
import { StudioApp } from '@/studio/StudioApp';
import type { FxConfig, GenPrefs, GridPrefs, Quantize } from '@/contracts/models';

type P = { params: Promise<{ id: string }> };

export default async function ProjectStudioPage({ params }: P) {
  const { id } = await params;
  const user = await getCurrentUser();
  if (!user) redirect('/login');
  const project = await db.project.findFirst({ where: { id, userId: user.id } });
  if (!project) {
    // §25:直接访问别人标的示例母版(书签/刷新)→ 写时复制出我的副本并重定向(幂等,靠 resume 安全)。
    const ex = await db.project.findUnique({ where: { id }, select: { id: true, isExample: true, userId: true } });
    if (ex?.isExample && ex.userId !== user.id) {
      const { id: copyId } = await forkExampleProject(ex.id, user.id);
      redirect(`/projects/${copyId}`);
    }
    notFound();
  }
  return (
    <StudioApp
      projectId={project.id}
      name={project.name}
      masterBpm={project.masterBpm}
      masterKey={project.masterKey}
      genPrefs={(project.genPrefs as unknown as GenPrefs | null) ?? null}
      gridPrefs={(project.gridPrefs as unknown as GridPrefs | null) ?? null}
      fx={(project.fx as unknown as FxConfig | null) ?? null}
      quantize={project.quantize as Quantize}
      beatsPerBar={project.beatsPerBar}
      loopSong={project.loopSong}
    />
  );
}
