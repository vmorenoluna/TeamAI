import { readFileSync, writeFileSync, mkdirSync, existsSync, cpSync, readdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const CONFIG_DIR = join(homedir(), '.teamai');
const PROJECTS_FILE = join(CONFIG_DIR, 'projects.json');
// process.cwd() is the project root (teamai/) at runtime
const DEFAULTS_DIR = join(process.cwd(), 'defaults');

export interface Project {
  name: string;
  path: string;
  addedAt: string;
}

export class ProjectStore {
  constructor() {
    mkdirSync(CONFIG_DIR, { recursive: true });
    if (!existsSync(PROJECTS_FILE)) {
      writeFileSync(PROJECTS_FILE, '[]');
    }
  }

  getAll(): Project[] {
    return JSON.parse(readFileSync(PROJECTS_FILE, 'utf-8'));
  }

  getByPath(projectPath: string): Project | null {
    return this.getAll().find(p => p.path === projectPath) || null;
  }

  /**
   * Register a new project. Scaffolds .claude/roles/, .claude/commands/,
   * .teamai/, and CLAUDE.md with defaults if they don't already exist.
   */
  add(projectPath: string, name?: string): Project {
    const projects = this.getAll();
    const existing = projects.find(p => p.path === projectPath);

    if (existing) throw new Error('already_registered');

    this.scaffold(projectPath);

    const project: Project = {
      name: name || projectPath.split(/[\\/]/).pop() || projectPath,
      path: projectPath,
      addedAt: new Date().toISOString(),
    };

    projects.push(project);
    writeFileSync(PROJECTS_FILE, JSON.stringify(projects, null, 2));
    return project;
  }

  remove(projectPath: string): void {
    const projects = this.getAll().filter(p => p.path !== projectPath);
    writeFileSync(PROJECTS_FILE, JSON.stringify(projects, null, 2));
    // Does NOT delete any files from the project directory
  }

  /**
   * Copy default roles and commands into the target project
   * if they don't already exist. Never overwrites existing files.
   */
  private scaffold(projectPath: string): void {
    const targets = [
      { src: join(DEFAULTS_DIR, 'roles'), dest: join(projectPath, '.claude', 'roles') },
      { src: join(DEFAULTS_DIR, 'commands'), dest: join(projectPath, '.claude', 'commands') },
    ];

    for (const { src, dest } of targets) {
      mkdirSync(dest, { recursive: true });
      for (const file of readdirSync(src)) {
        const destFile = join(dest, file);
        if (!existsSync(destFile)) {
          cpSync(join(src, file), destFile);
        }
      }
    }

    mkdirSync(join(projectPath, '.teamai'), { recursive: true });

    // Scaffold pipeline.json if not present
    const pipelineDest = join(projectPath, '.teamai', 'pipeline.json');
    if (!existsSync(pipelineDest)) {
      cpSync(join(DEFAULTS_DIR, 'pipeline.json'), pipelineDest);
    }

    // Copy teamai-workflow.md into .claude/ if not already there
    const workflowDest = join(projectPath, '.claude', 'teamai-workflow.md');
    if (!existsSync(workflowDest)) {
      cpSync(join(DEFAULTS_DIR, 'teamai-workflow.md'), workflowDest);
    }

    // Ensure root CLAUDE.md references the workflow file
    const IMPORT_LINE = '@.claude/teamai-workflow.md';
    const claudeMdPath = join(projectPath, 'CLAUDE.md');
    if (!existsSync(claudeMdPath)) {
      writeFileSync(claudeMdPath, IMPORT_LINE + '\n');
    } else {
      const content = readFileSync(claudeMdPath, 'utf-8');
      if (!content.includes(IMPORT_LINE)) {
        writeFileSync(claudeMdPath, IMPORT_LINE + '\n' + content);
      }
    }
  }
}

export const projectStore = new ProjectStore();
