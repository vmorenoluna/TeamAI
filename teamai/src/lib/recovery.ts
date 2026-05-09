import { readFileSync, readdirSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const IN_PROGRESS_PHASES = new Set([
  'spec', 'plan', 'implement', 'qa-review', 'qa-fix', 'merge', 'create-pr',
]);

export interface InterruptedTask {
  taskId: string;
  title: string;
  phase: string;
  projectPath: string;
  projectName: string;
}

/**
 * Scan all registered projects for tasks that were interrupted mid-pipeline.
 * Called once on server startup.
 */
export function findInterruptedTasks(): InterruptedTask[] {
  const projectsFile = join(homedir(), '.teamai', 'projects.json');
  if (!existsSync(projectsFile)) return [];

  let projects: { name: string; path: string }[] = [];
  try {
    projects = JSON.parse(readFileSync(projectsFile, 'utf-8'));
  } catch {
    return [];
  }

  const interrupted: InterruptedTask[] = [];

  for (const project of projects) {
    const teamaiDir = join(project.path, '.teamai');
    if (!existsSync(teamaiDir)) continue;

    let entries: string[] = [];
    try {
      entries = readdirSync(teamaiDir);
    } catch {
      continue;
    }

    for (const entry of entries) {
      const taskFile = join(teamaiDir, entry, 'task.json');
      if (!existsSync(taskFile)) continue;
      try {
        const task = JSON.parse(readFileSync(taskFile, 'utf-8'));
        if (IN_PROGRESS_PHASES.has(task.phase)) {
          interrupted.push({
            taskId: task.id,
            title: task.title,
            phase: task.phase,
            projectPath: project.path,
            projectName: project.name,
          });
        }
      } catch {
        // skip malformed task.json
      }
    }
  }

  return interrupted;
}
