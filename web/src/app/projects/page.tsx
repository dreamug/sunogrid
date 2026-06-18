import { redirect } from 'next/navigation';
import { getCurrentUser } from '@/lib/auth';
import { Workbench } from '@/studio/Workbench';

export default async function ProjectsPage() {
  const user = await getCurrentUser();
  if (!user) redirect('/login');
  return <Workbench username={user.username} />;
}
