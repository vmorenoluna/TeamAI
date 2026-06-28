import { readFileSync, readdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';

export interface ProjectInfo {
  type: 'node' | 'python' | 'go' | 'rust' | 'generic';
  nodeVersion?: string;
  pythonVersion?: string;
  goVersion?: string;
  rustVersion?: string;
  packageManager?: 'npm' | 'yarn' | 'pnpm' | 'bun';
  hasTypeScript?: boolean;
  /** Discovered from README/docs, or heuristic fallback */
  installCommand: string;
  /** Discovered from README/docs, or heuristic fallback */
  buildCommand: string;
  /** Discovered from README/docs, or heuristic fallback */
  testCommand: string;
}

interface DocCommands {
  install?: string;
  build?: string;
  test?: string;
}

/**
 * Analyze a project directory to determine its tech stack and build commands.
 *
 * Priority for build commands:
 *   1. README.md / README / BUILDING.md / CONTRIBUTING.md  ← project-authoritative
 *   2. package.json scripts / Makefile targets              ← structured config
 *   3. Language-specific heuristics                         ← sensible defaults
 */
export function analyzeProject(projectRoot: string): ProjectInfo {
  const files = readdirSync(projectRoot);

  // ── Detect project type ────────────────────────────────────────────────
  if (files.includes('package.json')) {
    return analyzeNodeProject(projectRoot, files);
  }
  if (files.includes('pyproject.toml') || files.includes('requirements.txt') || files.includes('setup.py')) {
    return analyzePythonProject(projectRoot, files);
  }
  if (files.includes('go.mod')) {
    return analyzeGoProject(projectRoot, files);
  }
  if (files.includes('Cargo.toml')) {
    return analyzeRustProject(projectRoot, files);
  }

  return analyzeGenericProject(projectRoot, files);
}

// ── Per-language analyzers ────────────────────────────────────────────────

function analyzeNodeProject(projectRoot: string, files: string[]): ProjectInfo {
  let nodeVersion = '20';
  let hasTypeScript = false;
  const pkg = safeReadJson(join(projectRoot, 'package.json'));

  if (pkg) {
    // Parse engines.node or .nvmrc
    const engines = (pkg.engines as Record<string, unknown> | undefined);
    if (engines?.node) {
      const m = String(engines.node).match(/(\d+)/);
      if (m) nodeVersion = m[1];
    }
  }
  const nvmrc = safeReadText(join(projectRoot, '.nvmrc'));
  if (nvmrc) {
    const m = nvmrc.trim().match(/v?(\d+)/);
    if (m) nodeVersion = m[1];
  }

  hasTypeScript = files.includes('tsconfig.json');

  const packageManager = detectPackageManager(files);
  const docCommands = parseDocs(projectRoot, files);

  const pm = packageManager;

  return {
    type: 'node',
    nodeVersion,
    packageManager,
    hasTypeScript,
    installCommand: docCommands.install || `${pm} install`,
    buildCommand: docCommands.build || discoverScriptCommand(pkg, ['build', 'compile']) || 'npm run build',
    testCommand: docCommands.test || discoverScriptCommand(pkg, ['test', 'spec', 'e2e', 'ci']) || 'npm test',
  };
}

function analyzePythonProject(projectRoot: string, files: string[]): ProjectInfo {
  const hasPoetry = files.includes('pyproject.toml');
  const docCommands = parseDocs(projectRoot, files);
  const pythonVersion = detectPythonVersion(projectRoot, files);

  return {
    type: 'python',
    pythonVersion,
    installCommand: docCommands.install || (hasPoetry ? 'poetry install' : 'pip install -r requirements.txt'),
    buildCommand: docCommands.build || (hasPoetry ? 'poetry build' : 'python setup.py build'),
    testCommand: docCommands.test || 'python -m pytest',
  };
}

function analyzeGoProject(projectRoot: string, files: string[]): ProjectInfo {
  const docCommands = parseDocs(projectRoot, files);
  const goVersion = detectGoVersion(projectRoot);
  return {
    type: 'go',
    goVersion,
    installCommand: docCommands.install || 'go mod download',
    buildCommand: docCommands.build || 'go build ./...',
    testCommand: docCommands.test || 'go test ./...',
  };
}

function analyzeRustProject(projectRoot: string, files: string[]): ProjectInfo {
  const docCommands = parseDocs(projectRoot, files);
  const rustVersion = detectRustVersion(projectRoot);
  return {
    type: 'rust',
    rustVersion,
    installCommand: docCommands.install || 'cargo fetch',
    buildCommand: docCommands.build || 'cargo build',
    testCommand: docCommands.test || 'cargo test',
  };
}

function analyzeGenericProject(projectRoot: string, files: string[]): ProjectInfo {
  const docCommands = parseDocs(projectRoot, files);
  const hasMakefile = files.includes('Makefile');
  return {
    type: 'generic',
    installCommand: docCommands.install || (hasMakefile ? 'make install' : 'echo "No install step configured"'),
    buildCommand: docCommands.build || (hasMakefile ? 'make build' : 'echo "No build step configured"'),
    testCommand: docCommands.test || (hasMakefile ? 'make test' : 'echo "No test step configured"'),
  };
}

// ── Doc parsing ────────────────────────────────────────────────────────────

/**
 * Search for build/test instructions in project documentation.
 * Looks at README.md, README, BUILDING.md, CONTRIBUTING.md in priority order.
 */
function parseDocs(projectRoot: string, files: string[]): DocCommands {
  const docNames = ['README.md', 'README', 'readme.md', 'CONTRIBUTING.md', 'BUILDING.md'];
  for (const name of docNames) {
    if (files.includes(name)) {
      const content = safeReadText(join(projectRoot, name));
      if (content) {
        const cmds = extractCommandsFromDoc(content);
        if (cmds.install || cmds.build || cmds.test) return cmds;
      }
    }
  }
  // Check docs/ subdirectory
  if (files.includes('docs')) {
    try {
      const docsDir = join(projectRoot, 'docs');
      const docFiles = readdirSync(docsDir);
      for (const doc of docFiles) {
        if (/development|building|setup|contributing/i.test(doc)) {
          const content = safeReadText(join(docsDir, doc));
          if (content) {
            const cmds = extractCommandsFromDoc(content);
            if (cmds.install || cmds.build || cmds.test) return cmds;
          }
        }
      }
    } catch { /* ignore */ }
  }
  return {};
}

/** Stub for file-less context (no longer used — all analyzers now pass projectRoot) */

/**
 * Extract install, build, and test commands from documentation text.
 * Looks for common patterns:
 *   ### Building / ## Development Setup / ## Installation / ## Running Tests
 *   ```
 *   npm install
 *   npm run build
 *   npm test
 *   ```
 */
function extractCommandsFromDoc(text: string): DocCommands {
  const result: DocCommands = {};

  // Find sections likely to contain commands
  const sections = findRelevantSections(text);
  for (const section of sections) {
    // Extract code blocks or inline code commands
    const codeBlocks = section.match(/```(?:bash|sh|shell)?\s*\n([\s\S]*?)```/g);
    if (codeBlocks) {
      for (const block of codeBlocks) {
        const cmds = block.replace(/```(?:bash|sh|shell)?\s*\n?/g, '').replace(/```/g, '');
        const lines = cmds.split('\n').filter(l => l.trim() && !l.trim().startsWith('#'));
        for (const line of lines) {
          const trimmed = line.trim();
          if (!result.install && isInstallCommand(trimmed)) result.install = sanitizeCommand(trimmed);
          if (!result.build && isBuildCommand(trimmed)) result.build = sanitizeCommand(trimmed);
          if (!result.test && isTestCommand(trimmed)) result.test = sanitizeCommand(trimmed);
        }
      }
    }
    // Also check inline `command` patterns
    const inlineCmds = section.match(/`([^`]+(?:install|build|test)[^`]*)`/gi);
    if (inlineCmds) {
      for (const cmd of inlineCmds) {
        const clean = cmd.replace(/`/g, '').trim();
        if (!result.install && isInstallCommand(clean)) result.install = sanitizeCommand(clean);
        if (!result.build && isBuildCommand(clean)) result.build = sanitizeCommand(clean);
        if (!result.test && isTestCommand(clean)) result.test = sanitizeCommand(clean);
      }
    }
  }

  return result;
}

/** Find markdown sections likely to contain build instructions */
function findRelevantSections(text: string): string[] {
  const sections: string[] = [];
  const headingRegex = /^#{1,3}\s+(.+)$/gm;
  let match: RegExpExecArray | null;
  const headings: { title: string; start: number; end: number }[] = [];

  while ((match = headingRegex.exec(text)) !== null) {
    // Find the end of the heading line
    const lineEnd = text.indexOf('\n', match.index);
    const endOfHeading = lineEnd >= 0 ? lineEnd + 1 : text.length;
    headings.push({ title: match[1].toLowerCase(), start: match.index, end: endOfHeading });
  }

  for (let i = 0; i < headings.length; i++) {
    const h = headings[i];
    const endPos = i + 1 < headings.length ? headings[i + 1].start : text.length;
    const title = h.title;
    if (
      /build|install|setup|develop|getting.?started|dev.?setup|prerequisite|running|test|contribut/i.test(title)
    ) {
      sections.push(text.slice(h.end, endPos));
    }
  }
  return sections;
}

function isInstallCommand(cmd: string): boolean {
  return /\b(npm\s+(install|ci)|yarn\s+install|pnpm\s+install|bun\s+install|pip\s+install|poetry\s+install|go\s+mod\s+download|cargo\s+(fetch|build)|make\s+install|bundle\s+install)\b/.test(cmd);
}

function isBuildCommand(cmd: string): boolean {
  return /\b(npm\s+run\s+build|yarn\s+build|pnpm\s+(run\s+)?build|bun\s+run\s+build|npm\s+run\s+compile|make\s+build|cargo\s+build|go\s+build|poetry\s+build|tsc\b|meson|cmake)\b/.test(cmd);
}

function isTestCommand(cmd: string): boolean {
  return /\b(npm\s+(run\s+)?test|yarn\s+test|pnpm\s+(run\s+)?test|bun\s+test|npm\s+run\s+(spec|e2e|ci)|make\s+test|cargo\s+test|go\s+test|pytest|python\s+-m\s+pytest|jest|vitest|mocha|rspec)\b/.test(cmd);
}

/** Remove trailing comments, backslashes, and other noise */
function sanitizeCommand(cmd: string): string {
  return cmd.replace(/\s*#.*$/, '').replace(/\\\s*$/, '').trim();
}

// ── Version detection ─────────────────────────────────────────────────────

/**
 * Detect Python version from pyproject.toml or .python-version file.
 * Returns the major.minor version string (e.g., "3.12"), or undefined.
 */
function detectPythonVersion(projectRoot: string, files: string[]): string | undefined {
  // Check .python-version file (pyenv format)
  if (files.includes('.python-version')) {
    const raw = safeReadText(join(projectRoot, '.python-version'));
    if (raw) {
      const m = raw.trim().match(/^(\d+\.\d+)/);
      if (m) return m[1];
    }
  }

  // Check pyproject.toml: [project] requires-python or [tool.poetry.dependencies] python
  if (files.includes('pyproject.toml')) {
    const content = safeReadText(join(projectRoot, 'pyproject.toml'));
    if (content) {
      // TOML requires-python = ">=3.10" or requires-python = '>=3.10'
      let m = content.match(/requires-python\s*=\s*["'][^"']*(\d+\.\d+)/);
      if (m) return m[1];
      // Poetry: python = "^3.10" or python = '^3.10'
      m = content.match(/\[tool\.poetry\.dependencies\][\s\S]*?python\s*=\s*["'][^"']*(\d+\.\d+)/);
      if (m) return m[1];
    }
  }

  return undefined;
}

/**
 * Detect Go version from go.mod.
 * Returns the version string (e.g., "1.22"), or undefined.
 */
function detectGoVersion(projectRoot: string): string | undefined {
  const content = safeReadText(join(projectRoot, 'go.mod'));
  if (content) {
    const m = content.match(/^go\s+(\d+\.\d+)/m);
    if (m) return m[1];
  }
  return undefined;
}

/**
 * Detect Rust version from rust-toolchain.toml or rust-toolchain file.
 * Returns the version string (e.g., "1.80"), or undefined.
 */
function detectRustVersion(projectRoot: string): string | undefined {
  // Check rust-toolchain.toml: [toolchain] channel = "1.80" or channel = '1.80'
  const tomlPath = join(projectRoot, 'rust-toolchain.toml');
  if (existsSync(tomlPath)) {
    const content = safeReadText(tomlPath);
    if (content) {
      const m = content.match(/channel\s*=\s*["'](\d+\.\d+)/);
      if (m) return m[1];
    }
  }

  // Check rust-toolchain file (plain text, just the version)
  if (existsSync(join(projectRoot, 'rust-toolchain'))) {
    const content = safeReadText(join(projectRoot, 'rust-toolchain'));
    if (content) {
      const m = content.trim().match(/^(\d+\.\d+)/);
      if (m) return m[1];
    }
  }

  return undefined;
}

// ── Helpers ────────────────────────────────────────────────────────────────

function detectPackageManager(files: string[]): ProjectInfo['packageManager'] {
  if (files.includes('pnpm-lock.yaml') || files.includes('pnpm-workspace.yaml')) return 'pnpm';
  if (files.includes('yarn.lock') || files.includes('.yarnrc.yml')) return 'yarn';
  if (files.includes('bun.lockb') || files.includes('bun.lock')) return 'bun';
  return 'npm';
}

function discoverScriptCommand(pkg: Record<string, unknown> | null, names: string[]): string | undefined {
  if (!pkg?.scripts) return undefined;
  const scripts = pkg.scripts as Record<string, string>;
  for (const name of names) {
    if (scripts[name]) return `npm run ${name}`;
  }
  return undefined;
}

function safeReadJson(path: string): Record<string, unknown> | null {
  try {
    if (existsSync(path)) return JSON.parse(readFileSync(path, 'utf-8'));
  } catch { /* ignore */ }
  return null;
}

function safeReadText(path: string): string | null {
  try {
    if (existsSync(path)) return readFileSync(path, 'utf-8');
  } catch { /* ignore */ }
  return null;
}

// ── Template rendering ─────────────────────────────────────────────────────

const DEFAULTS_DIR = join(dirname(dirname(__dirname)), 'defaults', 'devcontainers');

interface TemplateVars {
  REMOTE_USER: string;
  REMOTE_HOME: string;
  NODE_VERSION: string;
  PYTHON_VERSION: string;
  GO_VERSION: string;
  RUST_VERSION: string;
  INSTALL_COMMAND: string;
  BUILD_COMMAND: string;
  TEST_COMMAND: string;
  EXTRA_FEATURES: string;
  EXTRA_APT: string;
}

/**
 * Generate a complete devcontainer.json for the given project.
 * Uses templates from defaults/devcontainers/ with variable substitution.
 */
export function generateDevcontainer(_projectRoot: string, info: ProjectInfo): string {
  const templateName = `${info.type}.devcontainer.json`;
  const templatePath = join(DEFAULTS_DIR, templateName);
  let template: string;

  if (existsSync(templatePath)) {
    template = readFileSync(templatePath, 'utf-8');
  } else {
    // Fallback to generic template if language-specific one doesn't exist
    const genericPath = join(DEFAULTS_DIR, 'generic.devcontainer.json');
    if (existsSync(genericPath)) {
      template = readFileSync(genericPath, 'utf-8');
    } else {
      // Hardcoded minimal fallback if no template file exists at all
      template = getBuiltInGenericTemplate();
    }
  }

  const vars = buildTemplateVars(info);
  return substituteTemplateVars(template, vars);
}

function buildTemplateVars(info: ProjectInfo): TemplateVars {
  let remoteUser = 'node';
  let remoteHome = '/home/node';

  switch (info.type) {
    case 'node':
      remoteUser = 'node';
      remoteHome = '/home/node';
      break;
    case 'python':
      remoteUser = 'vscode';
      remoteHome = '/home/vscode';
      break;
    case 'go':
      remoteUser = 'vscode';
      remoteHome = '/home/vscode';
      break;
    case 'rust':
      remoteUser = 'vscode';
      remoteHome = '/home/vscode';
      break;
    default:
      remoteUser = 'vscode';
      remoteHome = '/home/vscode';
  }

  return {
    REMOTE_USER: remoteUser,
    REMOTE_HOME: remoteHome,
    NODE_VERSION: info.nodeVersion || '20',
    PYTHON_VERSION: info.pythonVersion || '3.12',
    GO_VERSION: info.goVersion || '1',
    RUST_VERSION: info.rustVersion || '1',
    INSTALL_COMMAND: info.installCommand,
    BUILD_COMMAND: info.buildCommand,
    TEST_COMMAND: info.testCommand,
    EXTRA_FEATURES: '',
    EXTRA_APT: '',
  };
}

function substituteTemplateVars(template: string, vars: TemplateVars): string {
  let result = template;
  for (const [key, value] of Object.entries(vars)) {
    result = result.replaceAll(`{{${key}}}`, value);
  }
  return result;
}

/** Absolute minimal devcontainer as a built-in safety net */
function getBuiltInGenericTemplate(): string {
  return JSON.stringify({
    name: 'Dev Container',
    image: 'mcr.microsoft.com/devcontainers/base:ubuntu',
    remoteUser: 'vscode',
    mounts: [
      'source=${localEnv:USERPROFILE}\\.claude,target=/home/vscode/.claude,type=bind',
      'source=${localEnv:USERPROFILE}\\.gitconfig,target=/home/vscode/.gitconfig,type=bind',
      'source=${localEnv:USERPROFILE}\\.ssh,target=/home/vscode/.ssh,type=bind,readonly',
    ],
    features: {
      'ghcr.io/devcontainers/features/github-cli:1': {},
    },
    postCreateCommand: 'npm install -g @anthropic-ai/claude-code && sudo apt-get update -q && sudo apt-get install -y -q gh && sudo git config --system --add safe.directory \'*\'',
  }, null, 2);
}
