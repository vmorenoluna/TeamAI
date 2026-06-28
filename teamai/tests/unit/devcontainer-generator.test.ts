/**
 * Unit tests for devcontainer-generator.
 *
 * Covers:
 *   - analyzeProject: language detection (Node, Python, Go, Rust, Generic)
 *   - Template rendering: variable substitution, placeholder handling
 *   - Doc parsing: extracting install/build/test commands from README
 *   - Edge cases: missing files, invalid JSON, special characters in commands
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
});
