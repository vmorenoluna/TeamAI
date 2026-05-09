import { getActiveProject } from '@/app/actions/projects';
import { RoadmapView } from '@/components/roadmap-view';

export default async function RoadmapPage() {
  const activeProject = await getActiveProject();

  return <RoadmapView noProject={!activeProject} />;
}
