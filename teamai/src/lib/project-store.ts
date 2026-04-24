import { readFileSync, writeFileSync, mkdirSync, existsSync, cpSync } from 'fs';
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
    if (projects.some(p => p.path === projectPath)) {
      throw new Error(`Project already registered: ${projectPath}`);
    }

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
      if (!existsSync(dest)) {
        mkdirSync(dest, { recursive: true });
        cpSync(src, dest, { recursive: true });
      }
    }

    mkdirSync(join(projectPath, '.teamai'), { recursive: true });

    const claudeMdPath = join(projectPath, 'CLAUDE.md');
    if (!existsSync(claudeMdPath)) {
      cpSync(join(DEFAULTS_DIR, 'CLAUDE.md'), claudeMdPath);
    }
  }
}

export const projectStore = new ProjectStore();
