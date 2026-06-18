import { redirect, notFound } from 'next/navigation';
import { getCurrentUser } from '@/lib/auth';
import { db } from '@/lib/db';
import { StudioApp } from '@/studio/StudioApp';

type P = { params: Promise<{ id: string }> };

export default async function ProjectStudioPage({ params }: P) {
  const { id } = await params;
  const user = await getCurrentUser();
  if (!user) redirect('/login');
  const project = await db.project.findFirst({ where: { id, userId: user.id } });
  if (!project) notFound();
  return <StudioApp projectId={project.id} masterBpm={project.masterBpm} beatsPerBar={project.beatsPerBar} />;
}
