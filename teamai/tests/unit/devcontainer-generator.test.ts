/**
 * Unit tests for devcontainer-generator.
 *
 * Covers:
 *   - analyzeProject: language detection (Node, Python, Go, Rust, Generic)
 *   - Template rendering: variable substitution, placeholder handling
 *   - Doc parsing: extracting install/build/test commands from README
 *   - Edge cases: missing files, invalid JSON, special characters in commands
 *   - Real template loading: generateDevcontainer against actual .json templates
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Hoisted mocks ──

const { mockReadFileSync, mockReaddirSync, mockExistsSync } = vi.hoisted(() => ({
  mockReadFileSync: vi.fn(),
  mockReaddirSync: vi.fn(),
  mockExistsSync: vi.fn(),
}));

vi.mock('fs', () => ({
  readFileSync: mockReadFileSync,
  readdirSync: mockReaddirSync,
  existsSync: mockExistsSync,
}));

// ── Imports ──

import { analyzeProject, generateDevcontainer, ProjectInfo } from '../../src/lib/devcontainer-generator';
import { join, dirname } from 'path';

// ── Helpers ──

function mockProject(files: string[], fileContents: Record<string, string> = {}) {
  mockReaddirSync.mockReturnValue(files);
  mockExistsSync.mockImplementation((path: string) => {
    const filename = path.replace(/\\/g, '/').split('/').pop() || '';
    if (path.includes('devcontainers')) return true; // template files exist
    return files.includes(filename) || (filename in fileContents);
  });
  mockReadFileSync.mockImplementation((path: string) => {
    const filename = path.replace(/\\/g, '/').split('/').pop() || '';
    if (filename in fileContents) return fileContents[filename];
    if (path.includes('.devcontainer.json')) {
      // Return a valid template for generateDevcontainer
      return '{"name":"Test","image":"node:{{NODE_VERSION}}","remoteUser":"{{REMOTE_USER}}"}';
    }
    return '{}';
  });
}

/** Resolve the defaults/devcontainers/ directory (mirrors the generator's DEFAULTS_DIR).
 *  The test file is at teamai/tests/unit/, so 2 dirname calls reach teamai/. */
const defaultsDir = join(dirname(dirname(__dirname)), 'defaults', 'devcontainers');

/** Helper to verify a generated devcontainer is valid and has key fields */
function assertValidDevcontainer(json: string, expectedImagePrefix: string, expectedRemoteUser: string) {
  // Parseable JSON
  const parsed = JSON.parse(json);

  // No leftover template placeholders
  expect(json).not.toContain('{{');
  expect(json).not.toContain('}}');

  // Core fields present
  expect(parsed.name).toBe('Dev Container');
  expect(parsed.image).toBeDefined();
  expect(parsed.image).toContain(expectedImagePrefix);
  expect(parsed.remoteUser).toBe(expectedRemoteUser);

  // Credential mounts present
  expect(parsed.mounts).toBeDefined();
  const mountStr = JSON.stringify(parsed.mounts);
  expect(mountStr).toContain('.claude');
  expect(mountStr).toContain('.gitconfig');
  expect(mountStr).toContain('.ssh');

  // Agent tooling in features or postCreateCommand
  const features = parsed.features || {};
  const featureKeys = Object.keys(features);
  const hasGhFeature = featureKeys.some((k: string) => k.includes('github-cli'));
  expect(hasGhFeature).toBe(true);

  // Claude CLI and git safe.directory in postCreateCommand
  expect(parsed.postCreateCommand).toBeDefined();
  expect(parsed.postCreateCommand).toContain('@anthropic-ai/claude-code');
  expect(parsed.postCreateCommand).toContain("safe.directory '*'");

  // Claude CLI refreshed on every container start so it can't go stale as new models ship
  expect(parsed.postStartCommand).toContain('@anthropic-ai/claude-code@latest');

  return parsed;
}

// ── Tests ──

describe('analyzeProject', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Node.js detection', () => {
    it('detects Node.js project from package.json', () => {
      mockProject(['package.json', 'tsconfig.json'], {
        'package.json': JSON.stringify({ name: 'test-project', scripts: { test: 'vitest' } }),
      });

      const info = analyzeProject('/test/project');
      expect(info.type).toBe('node');
      expect(info.hasTypeScript).toBe(true);
      expect(info.packageManager).toBe('npm');
    });

    it('detects pnpm from pnpm-lock.yaml', () => {
      mockProject(['package.json', 'pnpm-lock.yaml'], {
        'package.json': JSON.stringify({ name: 'test', scripts: {} }),
      });

      const info = analyzeProject('/test/project');
      expect(info.packageManager).toBe('pnpm');
      expect(info.installCommand).toBe('pnpm install');
    });

    it('detects yarn from yarn.lock', () => {
      mockProject(['package.json', 'yarn.lock'], {
        'package.json': JSON.stringify({ name: 'test', scripts: {} }),
      });

      const info = analyzeProject('/test/project');
      expect(info.packageManager).toBe('yarn');
    });

    it('parses node version from engines.node in package.json', () => {
      mockProject(['package.json'], {
        'package.json': JSON.stringify({
          name: 'test',
          engines: { node: '>=18.0.0' },
          scripts: {},
        }),
      });

      const info = analyzeProject('/test/project');
      expect(info.nodeVersion).toBe('18');
    });

    it('parses node version from .nvmrc', () => {
      mockProject(['package.json', '.nvmrc'], {
        'package.json': JSON.stringify({ name: 'test', scripts: {} }),
        '.nvmrc': 'v22.5.0\n',
      });

      const info = analyzeProject('/test/project');
      expect(info.nodeVersion).toBe('22');
    });

    it('uses discovered script commands from package.json', () => {
      mockProject(['package.json'], {
        'package.json': JSON.stringify({
          name: 'test',
          scripts: { build: 'tsc', test: 'vitest run' },
        }),
      });

      const info = analyzeProject('/test/project');
      expect(info.buildCommand).toBe('npm run build');
      expect(info.testCommand).toBe('npm run test');
    });

    it('falls back to defaults when package.json has no scripts', () => {
      mockProject(['package.json'], {
        'package.json': JSON.stringify({ name: 'test' }),
      });

      const info = analyzeProject('/test/project');
      expect(info.installCommand).toBe('npm install');
      expect(info.buildCommand).toBe('npm run build');
      expect(info.testCommand).toBe('npm test');
    });
  });

  describe('Python detection', () => {
    it('detects Python from requirements.txt', () => {
      mockProject(['requirements.txt']);

      const info = analyzeProject('/test/project');
      expect(info.type).toBe('python');
      expect(info.installCommand).toBe('pip install -r requirements.txt');
      expect(info.testCommand).toBe('python -m pytest');
    });

    it('detects Poetry from pyproject.toml', () => {
      mockProject(['pyproject.toml']);

      const info = analyzeProject('/test/project');
      expect(info.type).toBe('python');
      expect(info.installCommand).toBe('poetry install');
      expect(info.buildCommand).toBe('poetry build');
    });

    it('detects python version from .python-version file', () => {
      mockProject(['requirements.txt', '.python-version'], {
        '.python-version': '3.11.5\n',
      });

      const info = analyzeProject('/test/project');
      expect(info.pythonVersion).toBe('3.11');
    });

    it('detects python version from pyproject.toml requires-python', () => {
      mockProject(['pyproject.toml'], {
        'pyproject.toml': '[project]\nname = "test"\nrequires-python = ">=3.10"',
      });

      const info = analyzeProject('/test/project');
      expect(info.pythonVersion).toBe('3.10');
    });

    it('detects python version from Poetry dependencies', () => {
      mockProject(['pyproject.toml'], {
        'pyproject.toml': '[tool.poetry.dependencies]\npython = "^3.9"',
      });

      const info = analyzeProject('/test/project');
      expect(info.pythonVersion).toBe('3.9');
    });

    it('falls back to undefined python version when no version files', () => {
      mockProject(['requirements.txt']);

      const info = analyzeProject('/test/project');
      expect(info.pythonVersion).toBeUndefined();
    });
  });

  describe('Go detection', () => {
    it('detects Go from go.mod', () => {
      mockProject(['go.mod']);

      const info = analyzeProject('/test/project');
      expect(info.type).toBe('go');
      expect(info.installCommand).toBe('go mod download');
      expect(info.buildCommand).toBe('go build ./...');
      expect(info.testCommand).toBe('go test ./...');
    });

    it('detects go version from go.mod', () => {
      mockProject(['go.mod'], {
        'go.mod': 'module example.com/project\n\ngo 1.22\n\nrequire (\n) ',
      });

      const info = analyzeProject('/test/project');
      expect(info.goVersion).toBe('1.22');
    });

    it('falls back to undefined go version when go.mod has no version', () => {
      mockProject(['go.mod'], {
        'go.mod': 'module example.com/project',
      });

      const info = analyzeProject('/test/project');
      expect(info.goVersion).toBeUndefined();
    });
  });

  describe('Rust detection', () => {
    it('detects Rust from Cargo.toml', () => {
      mockProject(['Cargo.toml']);

      const info = analyzeProject('/test/project');
      expect(info.type).toBe('rust');
      expect(info.installCommand).toBe('cargo fetch');
      expect(info.buildCommand).toBe('cargo build');
      expect(info.testCommand).toBe('cargo test');
    });

    it('detects rust version from rust-toolchain.toml', () => {
      mockProject(['Cargo.toml', 'rust-toolchain.toml'], {
        'rust-toolchain.toml': '[toolchain]\nchannel = "1.80"',
      });

      const info = analyzeProject('/test/project');
      expect(info.rustVersion).toBe('1.80');
    });

    it('detects rust version from rust-toolchain file', () => {
      mockProject(['Cargo.toml', 'rust-toolchain'], {
        'rust-toolchain': '1.75.0\n',
      });

      const info = analyzeProject('/test/project');
      expect(info.rustVersion).toBe('1.75');
    });

    it('prefers rust-toolchain.toml over rust-toolchain', () => {
      mockProject(['Cargo.toml', 'rust-toolchain.toml', 'rust-toolchain'], {
        'rust-toolchain.toml': '[toolchain]\nchannel = "1.80"',
        'rust-toolchain': '1.75.0\n',
      });

      const info = analyzeProject('/test/project');
      expect(info.rustVersion).toBe('1.80');
    });

    it('falls back to undefined rust version when no toolchain files', () => {
      mockProject(['Cargo.toml']);

      const info = analyzeProject('/test/project');
      expect(info.rustVersion).toBeUndefined();
    });
  });

  describe('JVM detection', () => {
    it('detects Maven project from pom.xml', () => {
      mockProject(['pom.xml']);
      const info = analyzeProject('/test/project');
      expect(info.type).toBe('jvm');
      expect(info.jvmBuildTool).toBe('maven');
      expect(info.installCommand).toBe('mvn dependency:resolve');
      expect(info.buildCommand).toBe('mvn compile');
      expect(info.testCommand).toBe('mvn test');
    });

    it('detects Gradle project from build.gradle', () => {
      mockProject(['build.gradle']);
      const info = analyzeProject('/test/project');
      expect(info.type).toBe('jvm');
      expect(info.jvmBuildTool).toBe('gradle');
      expect(info.installCommand).toBe('./gradlew dependencies');
      expect(info.buildCommand).toBe('./gradlew build');
      expect(info.testCommand).toBe('./gradlew test');
    });

    it('detects Gradle Kotlin DSL from build.gradle.kts', () => {
      mockProject(['build.gradle.kts']);
      const info = analyzeProject('/test/project');
      expect(info.type).toBe('jvm');
      expect(info.jvmBuildTool).toBe('gradle');
    });

    it('detects SBT project from build.sbt', () => {
      mockProject(['build.sbt']);
      const info = analyzeProject('/test/project');
      expect(info.type).toBe('jvm');
      expect(info.jvmBuildTool).toBe('sbt');
      expect(info.installCommand).toBe('sbt update');
      expect(info.buildCommand).toBe('sbt compile');
      expect(info.testCommand).toBe('sbt test');
    });

    it('uses Maven wrapper when mvnw is present', () => {
      mockProject(['pom.xml', 'mvnw']);
      const info = analyzeProject('/test/project');
      expect(info.jvmBuildTool).toBe('maven');
      expect(info.installCommand).toBe('./mvnw dependency:resolve');
      expect(info.buildCommand).toBe('./mvnw compile');
      expect(info.testCommand).toBe('./mvnw test');
    });

    it('detects Java version from .java-version', () => {
      mockProject(['pom.xml', '.java-version'], { '.java-version': '17.0.2\n' });
      const info = analyzeProject('/test/project');
      expect(info.jvmVersion).toBe('17');
    });

    it('detects Java version from pom.xml java.version property', () => {
      mockProject(['pom.xml'], { 'pom.xml': '<project><properties><java.version>21</java.version></properties></project>' });
      const info = analyzeProject('/test/project');
      expect(info.jvmVersion).toBe('21');
    });

    it('detects Java version from build.gradle sourceCompatibility', () => {
      mockProject(['build.gradle'], { 'build.gradle': "sourceCompatibility = '17'" });
      const info = analyzeProject('/test/project');
      expect(info.jvmVersion).toBe('17');
    });

    it('detects Java version from build.gradle.kts javaVersion', () => {
      mockProject(['build.gradle.kts'], { 'build.gradle.kts': 'javaVersion = 21' });
      const info = analyzeProject('/test/project');
      expect(info.jvmVersion).toBe('21');
    });

    it('detects Java version from Gradle JavaVersion enum', () => {
      mockProject(['build.gradle'], { 'build.gradle': 'sourceCompatibility = JavaVersion.VERSION_11' });
      const info = analyzeProject('/test/project');
      expect(info.jvmVersion).toBe('11');
    });

    it('falls back to undefined jvmVersion when no version files', () => {
      mockProject(['pom.xml']);
      const info = analyzeProject('/test/project');
      expect(info.jvmVersion).toBeUndefined();
    });

    it('extracts Maven commands from README', () => {
      const readme = ['## Build', '', '```', 'mvn clean install', 'mvn test', '```'].join('\n');
      mockProject(['pom.xml', 'README.md'], { 'pom.xml': '<project></project>', 'README.md': readme });
      const info = analyzeProject('/test/project');
      expect(info.installCommand).toBe('mvn clean install');
      expect(info.testCommand).toBe('mvn test');
    });

    it('extracts Gradle commands from README', () => {
      const readme = ['## Setup', '', '```', './gradlew build', './gradlew test', '```'].join('\n');
      mockProject(['build.gradle', 'README.md'], { 'build.gradle': '', 'README.md': readme });
      const info = analyzeProject('/test/project');
      expect(info.buildCommand).toBe('./gradlew build');
      expect(info.testCommand).toBe('./gradlew test');
    });
  });

  describe('Generic fallback', () => {
    it('returns generic type when no known project files exist', () => {
      mockProject(['main.py', 'utils.py']);

      const info = analyzeProject('/test/project');
      expect(info.type).toBe('generic');
    });

    it('detects Makefile in generic project', () => {
      mockProject(['Makefile', 'src.c']);

      const info = analyzeProject('/test/project');
      expect(info.type).toBe('generic');
      expect(info.installCommand).toBe('make install');
      expect(info.buildCommand).toBe('make build');
      expect(info.testCommand).toBe('make test');
    });
  });

  describe('Doc parsing — install/build/test from README', () => {
    it('extracts install and test commands from README code blocks', () => {
      const readme = [
        '## Building',
        '',
        '```bash',
        'npm ci',
        'npm run build',
        'npm test',
        '```',
      ].join('\n');

      mockProject(['package.json', 'README.md'], {
        'package.json': JSON.stringify({ name: 'test', scripts: {} }),
        'README.md': readme,
      });

      const info = analyzeProject('/test/project');
      expect(info.installCommand).toBe('npm ci');
      expect(info.buildCommand).toBe('npm run build');
      expect(info.testCommand).toBe('npm test');
    });

    it('extracts pip install and pytest from Python README', () => {
      const readme = [
        '## Development Setup',
        '',
        '```',
        'pip install -r requirements.txt',
        'pytest tests/',
        '```',
      ].join('\n');

      mockProject(['requirements.txt', 'README.md'], {
        'README.md': readme,
      });

      const info = analyzeProject('/test/project');
      expect(info.installCommand).toBe('pip install -r requirements.txt');
      expect(info.testCommand).toBe('pytest tests/');
    });

    it('finds build commands in CONTRIBUTING.md', () => {
      const contributing = [
        '## Getting Started',
        '',
        'Run `npm install` then `npm run ci:test`.',
      ].join('\n');

      mockProject(['package.json', 'CONTRIBUTING.md'], {
        'package.json': JSON.stringify({ name: 'test', scripts: {} }),
        'CONTRIBUTING.md': contributing,
      });

      const info = analyzeProject('/test/project');
      expect(info.installCommand).toBe('npm install');
    });

    it('finds build commands in docs/DEVELOPMENT.md', () => {
      const devDoc = [
        '### Setup',
        '',
        '```sh',
        'pnpm install',
        'pnpm build',
        'pnpm test',
        '```',
      ].join('\n');

      // Need to mock readdirSync for the docs/ subdirectory
      mockReaddirSync.mockImplementation((dir: string) => {
        if (dir.includes('docs')) return ['DEVELOPMENT.md'];
        return ['package.json', 'docs'];
      });

      mockReadFileSync.mockImplementation((path: string) => {
        if (path.includes('DEVELOPMENT.md')) return devDoc;
        if (path.includes('package.json')) return JSON.stringify({ name: 'test' });
        return '{}';
      });

      mockExistsSync.mockReturnValue(true);

      const info = analyzeProject('/test/project');
      expect(info.installCommand).toBe('pnpm install');
      expect(info.buildCommand).toBe('pnpm build');
      expect(info.testCommand).toBe('pnpm test');
    });

    it('picks the alphabetically-first matching doc regardless of readdirSync order', () => {
      const buildingDoc = [
        '### Setup',
        '',
        '```sh',
        'make install',
        'make build',
        'make test',
        '```',
      ].join('\n');
      const developmentDoc = [
        '### Setup',
        '',
        '```sh',
        'pnpm install',
        'pnpm build',
        'pnpm test',
        '```',
      ].join('\n');

      // Return the docs in reverse-alphabetical order to prove .sort()
      // is applied — without it, DEVELOPMENT.md would win.
      mockReaddirSync.mockImplementation((dir: string) => {
        if (dir.includes('docs')) return ['DEVELOPMENT.md', 'BUILDING.md'];
        return ['package.json', 'docs'];
      });

      mockReadFileSync.mockImplementation((path: string) => {
        if (path.includes('BUILDING.md')) return buildingDoc;
        if (path.includes('DEVELOPMENT.md')) return developmentDoc;
        if (path.includes('package.json')) return JSON.stringify({ name: 'test' });
        return '{}';
      });

      mockExistsSync.mockReturnValue(true);

      const info = analyzeProject('/test/project');
      // BUILDING.md sorts before DEVELOPMENT.md, so its commands win.
      expect(info.installCommand).toBe('make install');
      expect(info.buildCommand).toBe('make build');
      expect(info.testCommand).toBe('make test');
    });

    it('falls back to heuristics when README has no commands', () => {
      const readme = [
        '# My Project',
        '',
        'This is a cool project.',
        '',
        '## License',
        '',
        'MIT',
      ].join('\n');

      mockProject(['package.json', 'README.md'], {
        'package.json': JSON.stringify({ name: 'test', scripts: {} }),
        'README.md': readme,
      });

      const info = analyzeProject('/test/project');
      expect(info.installCommand).toBe('npm install'); // heuristic fallback
    });
  });
});

describe('generateDevcontainer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('substitutes template variables correctly', () => {
    // The mocked readFileSync returns our test template with placeholders
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(
      '{"name":"Test","image":"mcr.microsoft.com/devcontainers/javascript-node:{{NODE_VERSION}}","remoteUser":"{{REMOTE_USER}}"}'
    );

    const info: ProjectInfo = {
      type: 'node',
      nodeVersion: '22',
      installCommand: 'npm ci',
      buildCommand: 'npm run build',
      testCommand: 'npm test',
    };

    const result = generateDevcontainer('/test/project', info);
    const parsed = JSON.parse(result);
    expect(parsed.image).toContain(':22');
    expect(parsed.image).not.toContain('{{NODE_VERSION}}');
    expect(parsed.remoteUser).toBe('node');
  });

  it('substitutes empty EXTRA_FEATURES and EXTRA_APT correctly', () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(
      '{"name":"Test","features":{"gh:cli":{}}\n    {{EXTRA_FEATURES}}\n  ,"postCreateCommand":"apt-get install gh{{EXTRA_APT}}"}'
    );

    const info: ProjectInfo = {
      type: 'node',
      installCommand: 'npm install',
      buildCommand: 'npm run build',
      testCommand: 'npm test',
    };

    const result = generateDevcontainer('/test/project', info);
    // Should be valid JSON even with empty placeholder substitution
    const parsed = JSON.parse(result);
    expect(parsed.features).toBeDefined();
    expect(parsed.postCreateCommand).toContain('apt-get install gh');
  });

  it('handles template values containing dollar signs', () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(
      '{"name":"Test","postCreateCommand":"{{INSTALL_COMMAND}}"}'
    );

    const info: ProjectInfo = {
      type: 'node',
      installCommand: 'echo $HOME && npm install',
      buildCommand: 'npm run build',
      testCommand: 'npm test',
    };

    const result = generateDevcontainer('/test/project', info);
    const parsed = JSON.parse(result);
    expect(parsed.postCreateCommand).toBe('echo $HOME && npm install');
  });

  it('substitutes python version template variable', () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(
      '{"name":"Test","image":"mcr.microsoft.com/devcontainers/python:{{PYTHON_VERSION}}"}'
    );

    const info: ProjectInfo = {
      type: 'python',
      pythonVersion: '3.11',
      installCommand: 'pip install -r requirements.txt',
      buildCommand: 'python setup.py build',
      testCommand: 'pytest',
    };

    const result = generateDevcontainer('/test/project', info);
    const parsed = JSON.parse(result);
    expect(parsed.image).toBe('mcr.microsoft.com/devcontainers/python:3.11');
  });

  it('substitutes go version template variable', () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(
      '{"name":"Test","image":"mcr.microsoft.com/devcontainers/go:{{GO_VERSION}}"}'
    );

    const info: ProjectInfo = {
      type: 'go',
      goVersion: '1.22',
      installCommand: 'go mod download',
      buildCommand: 'go build ./...',
      testCommand: 'go test ./...',
    };

    const result = generateDevcontainer('/test/project', info);
    const parsed = JSON.parse(result);
    expect(parsed.image).toBe('mcr.microsoft.com/devcontainers/go:1.22');
  });

  it('substitutes rust version template variable', () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(
      '{"name":"Test","image":"mcr.microsoft.com/devcontainers/rust:{{RUST_VERSION}}"}'
    );

    const info: ProjectInfo = {
      type: 'rust',
      rustVersion: '1.80',
      installCommand: 'cargo fetch',
      buildCommand: 'cargo build',
      testCommand: 'cargo test',
    };

    const result = generateDevcontainer('/test/project', info);
    const parsed = JSON.parse(result);
    expect(parsed.image).toBe('mcr.microsoft.com/devcontainers/rust:1.80');
  });

  it('uses default versions when none detected', () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(
      '{"name":"Test","image":"mcr.microsoft.com/devcontainers/python:{{PYTHON_VERSION}}"}'
    );

    const info: ProjectInfo = {
      type: 'python',
      installCommand: 'pip install',
      buildCommand: 'python setup.py build',
      testCommand: 'pytest',
    };

    const result = generateDevcontainer('/test/project', info);
    const parsed = JSON.parse(result);
    expect(parsed.image).toBe('mcr.microsoft.com/devcontainers/python:3.12');
  });
});

// ── Real-template tests ──────────────────────────────────────────────────

describe('generateDevcontainer with real templates', () => {
  beforeEach(async () => {
    vi.clearAllMocks();

    // Use vi.importActual to read actual template files from disk,
    // bypassing the vi.mock('fs', ...) that wraps readFileSync.
    const realFS = await vi.importActual<typeof import('fs')>('fs');
    const readTemplate = (name: string) =>
      realFS.readFileSync(join(defaultsDir, name), 'utf-8');

    const pythonTemplate = readTemplate('python.devcontainer.json');
    const goTemplate = readTemplate('go.devcontainer.json');
    const rustTemplate = readTemplate('rust.devcontainer.json');
    const nodeTemplate = readTemplate('node.devcontainer.json');
    const genericTemplate = readTemplate('generic.devcontainer.json');
    const jvmTemplate = readTemplate('jvm.devcontainer.json');

    mockExistsSync.mockImplementation((path: string) => {
      if (path.includes('devcontainers')) return true;
      return false;
    });

    mockReadFileSync.mockImplementation((path: string, _encoding?: string) => {
      const p = path.replace(/\\/g, '/');
      if (p.includes('python.devcontainer.json')) return pythonTemplate;
      if (p.includes('go.devcontainer.json')) return goTemplate;
      if (p.includes('rust.devcontainer.json')) return rustTemplate;
      if (p.includes('node.devcontainer.json')) return nodeTemplate;
      if (p.includes('generic.devcontainer.json')) return genericTemplate;
      if (p.includes('jvm.devcontainer.json')) return jvmTemplate;
      return '{}';
    });
  });

  describe('Python template', () => {
    it('generates valid devcontainer JSON with detected version', () => {
      const info: ProjectInfo = {
        type: 'python',
        pythonVersion: '3.11',
        installCommand: 'pip install -r requirements.txt',
        buildCommand: 'python setup.py build',
        testCommand: 'pytest',
      };

      const result = generateDevcontainer('/test/project', info);
      const parsed = assertValidDevcontainer(
        result,
        'mcr.microsoft.com/devcontainers/python:',
        'vscode'
      );

      expect(parsed.image).toBe('mcr.microsoft.com/devcontainers/python:3.11');
      expect(parsed.remoteEnv).toBeDefined();
      expect(parsed.remoteEnv.PYTHONUNBUFFERED).toBe('1');
    });

    it('uses default version 3.12 when no version detected', () => {
      const info: ProjectInfo = {
        type: 'python',
        installCommand: 'pip install',
        buildCommand: 'python setup.py build',
        testCommand: 'pytest',
      };

      const result = generateDevcontainer('/test/project', info);
      const parsed = assertValidDevcontainer(
        result,
        'mcr.microsoft.com/devcontainers/python:',
        'vscode'
      );

      expect(parsed.image).toBe('mcr.microsoft.com/devcontainers/python:3.12');
    });
  });

  describe('Go template', () => {
    it('generates valid devcontainer JSON with detected version', () => {
      const info: ProjectInfo = {
        type: 'go',
        goVersion: '1.22',
        installCommand: 'go mod download',
        buildCommand: 'go build ./...',
        testCommand: 'go test ./...',
      };

      const result = generateDevcontainer('/test/project', info);
      const parsed = assertValidDevcontainer(
        result,
        'mcr.microsoft.com/devcontainers/go:',
        'vscode'
      );

      expect(parsed.image).toBe('mcr.microsoft.com/devcontainers/go:1.22');
      expect(parsed.remoteEnv).toBeDefined();
      expect(parsed.remoteEnv.GO111MODULE).toBe('on');
    });

    it('uses default version 1 when no version detected', () => {
      const info: ProjectInfo = {
        type: 'go',
        installCommand: 'go mod download',
        buildCommand: 'go build ./...',
        testCommand: 'go test ./...',
      };

      const result = generateDevcontainer('/test/project', info);
      const parsed = assertValidDevcontainer(
        result,
        'mcr.microsoft.com/devcontainers/go:',
        'vscode'
      );

      expect(parsed.image).toBe('mcr.microsoft.com/devcontainers/go:1');
    });
  });

  describe('Rust template', () => {
    it('generates valid devcontainer JSON with detected version', () => {
      const info: ProjectInfo = {
        type: 'rust',
        rustVersion: '1.80',
        installCommand: 'cargo fetch',
        buildCommand: 'cargo build',
        testCommand: 'cargo test',
      };

      const result = generateDevcontainer('/test/project', info);
      const parsed = assertValidDevcontainer(
        result,
        'mcr.microsoft.com/devcontainers/rust:',
        'vscode'
      );

      expect(parsed.image).toBe('mcr.microsoft.com/devcontainers/rust:1.80');
      expect(parsed.remoteEnv).toBeDefined();
      expect(parsed.remoteEnv.CARGO_TERM_COLOR).toBe('always');
    });

    it('uses default version 1 when no version detected', () => {
      const info: ProjectInfo = {
        type: 'rust',
        installCommand: 'cargo fetch',
        buildCommand: 'cargo build',
        testCommand: 'cargo test',
      };

      const result = generateDevcontainer('/test/project', info);
      const parsed = assertValidDevcontainer(
        result,
        'mcr.microsoft.com/devcontainers/rust:',
        'vscode'
      );

      expect(parsed.image).toBe('mcr.microsoft.com/devcontainers/rust:1');
    });
  });

  describe('JVM template', () => {
    it('generates valid devcontainer JSON with detected version', () => {
      const info: ProjectInfo = {
        type: 'jvm',
        jvmVersion: '17',
        jvmBuildTool: 'maven',
        installCommand: 'mvn dependency:resolve',
        buildCommand: 'mvn compile',
        testCommand: 'mvn test',
      };

      const result = generateDevcontainer('/test/project', info);
      const parsed = assertValidDevcontainer(
        result,
        'mcr.microsoft.com/devcontainers/java:',
        'vscode'
      );

      expect(parsed.image).toBe('mcr.microsoft.com/devcontainers/java:17');
      expect(parsed.remoteEnv).toBeDefined();
      expect(parsed.remoteEnv.JAVA_HOME).toBe('/usr/local/sdkman/candidates/java/current');
    });

    it('uses default version 21 when no version detected', () => {
      const info: ProjectInfo = {
        type: 'jvm',
        jvmBuildTool: 'gradle',
        installCommand: './gradlew dependencies',
        buildCommand: './gradlew build',
        testCommand: './gradlew test',
      };

      const result = generateDevcontainer('/test/project', info);
      const parsed = assertValidDevcontainer(
        result,
        'mcr.microsoft.com/devcontainers/java:',
        'vscode'
      );

      expect(parsed.image).toBe('mcr.microsoft.com/devcontainers/java:21');
    });
  });

  describe('Cross-template safety', () => {
    it('cleans all placeholder syntax from generated JSON', () => {
      const info: ProjectInfo = {
        type: 'python',
        installCommand: 'pip install',
        buildCommand: 'python setup.py build',
        testCommand: 'pytest',
      };

      const result = generateDevcontainer('/test/project', info);
      // Verify absolutely no {{ or }} remain after substitution
      expect(result).not.toContain('{{');
      expect(result).not.toContain('}}');
    });

    it('generates parseable JSON for all templates', () => {
      const templates: { type: ProjectInfo['type']; info: Partial<ProjectInfo> }[] = [
        {
          type: 'python',
          info: { installCommand: 'pip install', buildCommand: 'python -m build', testCommand: 'pytest' },
        },
        {
          type: 'go',
          info: { installCommand: 'go mod download', buildCommand: 'go build ./...', testCommand: 'go test ./...' },
        },
        {
          type: 'rust',
          info: { installCommand: 'cargo fetch', buildCommand: 'cargo build', testCommand: 'cargo test' },
        },
        {
          type: 'jvm',
          info: { jvmBuildTool: 'maven', installCommand: 'mvn dependency:resolve', buildCommand: 'mvn compile', testCommand: 'mvn test' },
        },
      ];

      for (const t of templates) {
        const fullInfo: ProjectInfo = {
          type: t.type,
          installCommand: t.info.installCommand!,
          buildCommand: t.info.buildCommand!,
          testCommand: t.info.testCommand!,
        };
        const result = generateDevcontainer('/test/project', fullInfo);
        const parsed = JSON.parse(result);
        expect(parsed.name).toBe('Dev Container');
        expect(parsed.image).toBeTruthy();
        expect(parsed.remoteUser).toBeTruthy();
      }
    });
  });
});
