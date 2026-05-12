import { TaskStore } from '../src/lib/task-store';

const projectPath = process.argv[2] || process.cwd();
const taskId = process.argv[3];
const phase = process.argv[4];

if (!taskId || !phase) {
  console.error('Usage: npx tsx scripts/update-phase.ts <projectPath> <taskId> <phase>');
  process.exit(1);
}

const store = new TaskStore(projectPath);
store.updatePhase(taskId, phase);
console.log(`Updated ${taskId} → ${phase}`);
