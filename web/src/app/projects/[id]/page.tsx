import { redirect, notFound } from 'next/navigation';
import { getCurrentUser } from '@/lib/auth';
import { db } from '@/lib/db';
import { StudioApp } from '@/studio/StudioApp';
import type { GenPrefs, Quantize } from '@/contracts/models';

type P = { params: Promise<{ id: string }> };

export default async function ProjectStudioPage({ params }: P) {
  const { id } = await params;
  const user = await getCurrentUser();
  if (!user) redirect('/login');
  const project = await db.project.findFirst({ where: { id, userId: user.id } });
  if (!project) notFound();
  return (
    <StudioApp
      projectId={project.id}
      name={project.name}
      masterBpm={project.masterBpm}
      masterKey={project.masterKey}
      genPrefs={(project.genPrefs as unknown as GenPrefs | null) ?? null}
      quantize={project.quantize as Quantize}
      beatsPerBar={project.beatsPerBar}
    />
  );
}
