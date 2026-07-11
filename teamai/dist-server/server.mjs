var __defProp = Object.defineProperty;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __esm = (fn, res) => function __init() {
  return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
};
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};

// src/lib/logger.ts
function format(module, message) {
  return `[${module}] ${message}`;
}
function log(module, message, ...details) {
  if (!isDev) return;
  if (details.length > 0) {
    console.log(format(module, message), ...details);
  } else {
    console.log(format(module, message));
  }
}
function warn(module, message, ...details) {
  if (!isDev) return;
  if (details.length > 0) {
    console.warn(format(module, message), ...details);
  } else {
    console.warn(format(module, message));
  }
}
function error(module, message, err) {
  const detail = err instanceof Error ? `${err.message}${err.stack ? "\n" + err.stack : ""}` : err !== void 0 ? String(err) : "";
  if (detail) {
    console.error(format(module, message), detail);
  } else {
    console.error(format(module, message));
  }
}
var isDev;
var init_logger = __esm({
  "src/lib/logger.ts"() {
    "use strict";
    isDev = process.env.NODE_ENV !== "production";
  }
});

// src/lib/devcontainer-generator.ts
var devcontainer_generator_exports = {};
__export(devcontainer_generator_exports, {
  analyzeProject: () => analyzeProject,
  generateDevcontainer: () => generateDevcontainer
});
import { readFileSync, readdirSync, existsSync } from "fs";
import { join, dirname } from "path";
function analyzeProject(projectRoot) {
  const files = readdirSync(projectRoot);
  if (files.includes("package.json")) {
    return analyzeNodeProject(projectRoot, files);
  }
  if (files.includes("pyproject.toml") || files.includes("requirements.txt") || files.includes("setup.py")) {
    return analyzePythonProject(projectRoot, files);
  }
  if (files.includes("go.mod")) {
    return analyzeGoProject(projectRoot, files);
  }
  if (files.includes("Cargo.toml")) {
    return analyzeRustProject(projectRoot, files);
  }
  return analyzeGenericProject(projectRoot, files);
}
function analyzeNodeProject(projectRoot, files) {
  let nodeVersion = "20";
  let hasTypeScript = false;
  const pkg = safeReadJson(join(projectRoot, "package.json"));
  if (pkg) {
    const engines = pkg.engines;
    if (engines?.node) {
      const m = String(engines.node).match(/(\d+)/);
      if (m) nodeVersion = m[1];
    }
  }
  const nvmrc = safeReadText(join(projectRoot, ".nvmrc"));
  if (nvmrc) {
    const m = nvmrc.trim().match(/v?(\d+)/);
    if (m) nodeVersion = m[1];
  }
  hasTypeScript = files.includes("tsconfig.json");
  const packageManager = detectPackageManager(files);
  const docCommands = parseDocs(projectRoot, files);
  const pm = packageManager;
  return {
    type: "node",
    nodeVersion,
    packageManager,
    hasTypeScript,
    installCommand: docCommands.install || `${pm} install`,
    buildCommand: docCommands.build || discoverScriptCommand(pkg, ["build", "compile"]) || "npm run build",
    testCommand: docCommands.test || discoverScriptCommand(pkg, ["test", "spec", "e2e", "ci"]) || "npm test"
  };
}
function analyzePythonProject(projectRoot, files) {
  const hasPoetry = files.includes("pyproject.toml");
  const docCommands = parseDocs(projectRoot, files);
  const pythonVersion = detectPythonVersion(projectRoot, files);
  return {
    type: "python",
    pythonVersion,
    installCommand: docCommands.install || (hasPoetry ? "poetry install" : "pip install -r requirements.txt"),
    buildCommand: docCommands.build || (hasPoetry ? "poetry build" : "python setup.py build"),
    testCommand: docCommands.test || "python -m pytest"
  };
}
function analyzeGoProject(projectRoot, files) {
  const docCommands = parseDocs(projectRoot, files);
  const goVersion = detectGoVersion(projectRoot);
  return {
    type: "go",
    goVersion,
    installCommand: docCommands.install || "go mod download",
    buildCommand: docCommands.build || "go build ./...",
    testCommand: docCommands.test || "go test ./..."
  };
}
function analyzeRustProject(projectRoot, files) {
  const docCommands = parseDocs(projectRoot, files);
  const rustVersion = detectRustVersion(projectRoot);
  return {
    type: "rust",
    rustVersion,
    installCommand: docCommands.install || "cargo fetch",
    buildCommand: docCommands.build || "cargo build",
    testCommand: docCommands.test || "cargo test"
  };
}
function analyzeGenericProject(projectRoot, files) {
  const docCommands = parseDocs(projectRoot, files);
  const hasMakefile = files.includes("Makefile");
  return {
    type: "generic",
    installCommand: docCommands.install || (hasMakefile ? "make install" : 'echo "No install step configured"'),
    buildCommand: docCommands.build || (hasMakefile ? "make build" : 'echo "No build step configured"'),
    testCommand: docCommands.test || (hasMakefile ? "make test" : 'echo "No test step configured"')
  };
}
function parseDocs(projectRoot, files) {
  const docNames = ["README.md", "README", "readme.md", "CONTRIBUTING.md", "BUILDING.md"];
  for (const name of docNames) {
    if (files.includes(name)) {
      const content = safeReadText(join(projectRoot, name));
      if (content) {
        const cmds = extractCommandsFromDoc(content);
        if (cmds.install || cmds.build || cmds.test) return cmds;
      }
    }
  }
  if (files.includes("docs")) {
    try {
      const docsDir = join(projectRoot, "docs");
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
    } catch {
    }
  }
  return {};
}
function extractCommandsFromDoc(text) {
  const result = {};
  const sections = findRelevantSections(text);
  for (const section of sections) {
    const codeBlocks = section.match(/```(?:bash|sh|shell)?\s*\n([\s\S]*?)```/g);
    if (codeBlocks) {
      for (const block of codeBlocks) {
        const cmds = block.replace(/```(?:bash|sh|shell)?\s*\n?/g, "").replace(/```/g, "");
        const lines = cmds.split("\n").filter((l) => l.trim() && !l.trim().startsWith("#"));
        for (const line of lines) {
          const trimmed = line.trim();
          if (!result.install && isInstallCommand(trimmed)) result.install = sanitizeCommand(trimmed);
          if (!result.build && isBuildCommand(trimmed)) result.build = sanitizeCommand(trimmed);
          if (!result.test && isTestCommand(trimmed)) result.test = sanitizeCommand(trimmed);
        }
      }
    }
    const inlineCmds = section.match(/`([^`]+(?:install|build|test)[^`]*)`/gi);
    if (inlineCmds) {
      for (const cmd of inlineCmds) {
        const clean = cmd.replace(/`/g, "").trim();
        if (!result.install && isInstallCommand(clean)) result.install = sanitizeCommand(clean);
        if (!result.build && isBuildCommand(clean)) result.build = sanitizeCommand(clean);
        if (!result.test && isTestCommand(clean)) result.test = sanitizeCommand(clean);
      }
    }
  }
  return result;
}
function findRelevantSections(text) {
  const sections = [];
  const headingRegex = /^#{1,3}\s+(.+)$/gm;
  let match;
  const headings = [];
  while ((match = headingRegex.exec(text)) !== null) {
    const lineEnd = text.indexOf("\n", match.index);
    const endOfHeading = lineEnd >= 0 ? lineEnd + 1 : text.length;
    headings.push({ title: match[1].toLowerCase(), start: match.index, end: endOfHeading });
  }
  for (let i = 0; i < headings.length; i++) {
    const h = headings[i];
    const endPos = i + 1 < headings.length ? headings[i + 1].start : text.length;
    const title = h.title;
    if (/build|install|setup|develop|getting.?started|dev.?setup|prerequisite|running|test|contribut/i.test(title)) {
      sections.push(text.slice(h.end, endPos));
    }
  }
  return sections;
}
function isInstallCommand(cmd) {
  return /\b(npm\s+(install|ci)|yarn\s+install|pnpm\s+install|bun\s+install|pip\s+install|poetry\s+install|go\s+mod\s+download|cargo\s+(fetch|build)|make\s+install|bundle\s+install)\b/.test(cmd);
}
function isBuildCommand(cmd) {
  return /\b(npm\s+run\s+build|yarn\s+build|pnpm\s+(run\s+)?build|bun\s+run\s+build|npm\s+run\s+compile|make\s+build|cargo\s+build|go\s+build|poetry\s+build|tsc\b|meson|cmake)\b/.test(cmd);
}
function isTestCommand(cmd) {
  return /\b(npm\s+(run\s+)?test|yarn\s+test|pnpm\s+(run\s+)?test|bun\s+test|npm\s+run\s+(spec|e2e|ci)|make\s+test|cargo\s+test|go\s+test|pytest|python\s+-m\s+pytest|jest|vitest|mocha|rspec)\b/.test(cmd);
}
function sanitizeCommand(cmd) {
  return cmd.replace(/\s*#.*$/, "").replace(/\\\s*$/, "").trim();
}
function detectPythonVersion(projectRoot, files) {
  if (files.includes(".python-version")) {
    const raw = safeReadText(join(projectRoot, ".python-version"));
    if (raw) {
      const m = raw.trim().match(/^(\d+\.\d+)/);
      if (m) return m[1];
    }
  }
  if (files.includes("pyproject.toml")) {
    const content = safeReadText(join(projectRoot, "pyproject.toml"));
    if (content) {
      let m = content.match(/requires-python\s*=\s*["'][^"']*(\d+\.\d+)/);
      if (m) return m[1];
      m = content.match(/\[tool\.poetry\.dependencies\][\s\S]*?python\s*=\s*["'][^"']*(\d+\.\d+)/);
      if (m) return m[1];
    }
  }
  return void 0;
}
function detectGoVersion(projectRoot) {
  const content = safeReadText(join(projectRoot, "go.mod"));
  if (content) {
    const m = content.match(/^go\s+(\d+\.\d+)/m);
    if (m) return m[1];
  }
  return void 0;
}
function detectRustVersion(projectRoot) {
  const tomlPath = join(projectRoot, "rust-toolchain.toml");
  if (existsSync(tomlPath)) {
    const content = safeReadText(tomlPath);
    if (content) {
      const m = content.match(/channel\s*=\s*["'](\d+\.\d+)/);
      if (m) return m[1];
    }
  }
  if (existsSync(join(projectRoot, "rust-toolchain"))) {
    const content = safeReadText(join(projectRoot, "rust-toolchain"));
    if (content) {
      const m = content.trim().match(/^(\d+\.\d+)/);
      if (m) return m[1];
    }
  }
  return void 0;
}
function detectPackageManager(files) {
  if (files.includes("pnpm-lock.yaml") || files.includes("pnpm-workspace.yaml")) return "pnpm";
  if (files.includes("yarn.lock") || files.includes(".yarnrc.yml")) return "yarn";
  if (files.includes("bun.lockb") || files.includes("bun.lock")) return "bun";
  return "npm";
}
function discoverScriptCommand(pkg, names) {
  if (!pkg?.scripts) return void 0;
  const scripts = pkg.scripts;
  for (const name of names) {
    if (scripts[name]) return `npm run ${name}`;
  }
  return void 0;
}
function safeReadJson(path15) {
  try {
    if (existsSync(path15)) return JSON.parse(readFileSync(path15, "utf-8"));
  } catch {
  }
  return null;
}
function safeReadText(path15) {
  try {
    if (existsSync(path15)) return readFileSync(path15, "utf-8");
  } catch {
  }
  return null;
}
function generateDevcontainer(_projectRoot, info) {
  const templateName = `${info.type}.devcontainer.json`;
  const templatePath = join(DEFAULTS_DIR, templateName);
  let template;
  if (existsSync(templatePath)) {
    template = readFileSync(templatePath, "utf-8");
  } else {
    const genericPath = join(DEFAULTS_DIR, "generic.devcontainer.json");
    if (existsSync(genericPath)) {
      template = readFileSync(genericPath, "utf-8");
    } else {
      template = getBuiltInGenericTemplate();
    }
  }
  const vars = buildTemplateVars(info);
  return substituteTemplateVars(template, vars);
}
function buildTemplateVars(info) {
  let remoteUser = "node";
  let remoteHome = "/home/node";
  switch (info.type) {
    case "node":
      remoteUser = "node";
      remoteHome = "/home/node";
      break;
    case "python":
      remoteUser = "vscode";
      remoteHome = "/home/vscode";
      break;
    case "go":
      remoteUser = "vscode";
      remoteHome = "/home/vscode";
      break;
    case "rust":
      remoteUser = "vscode";
      remoteHome = "/home/vscode";
      break;
    default:
      remoteUser = "vscode";
      remoteHome = "/home/vscode";
  }
  return {
    REMOTE_USER: remoteUser,
    REMOTE_HOME: remoteHome,
    NODE_VERSION: info.nodeVersion || "20",
    PYTHON_VERSION: info.pythonVersion || "3.12",
    GO_VERSION: info.goVersion || "1",
    RUST_VERSION: info.rustVersion || "1",
    INSTALL_COMMAND: info.installCommand,
    BUILD_COMMAND: info.buildCommand,
    TEST_COMMAND: info.testCommand,
    EXTRA_FEATURES: "",
    EXTRA_APT: ""
  };
}
function substituteTemplateVars(template, vars) {
  let result = template;
  for (const [key, value] of Object.entries(vars)) {
    result = result.replaceAll(`{{${key}}}`, value);
  }
  return result;
}
function getBuiltInGenericTemplate() {
  return JSON.stringify({
    name: "Dev Container",
    image: "mcr.microsoft.com/devcontainers/base:ubuntu",
    remoteUser: "vscode",
    mounts: [
      "source=${localEnv:USERPROFILE}\\.claude,target=/home/vscode/.claude,type=bind",
      "source=${localEnv:USERPROFILE}\\.gitconfig,target=/home/vscode/.gitconfig,type=bind",
      "source=${localEnv:USERPROFILE}\\.ssh,target=/home/vscode/.ssh,type=bind,readonly"
    ],
    features: {
      "ghcr.io/devcontainers/features/github-cli:1": {}
    },
    postCreateCommand: "npm install -g @anthropic-ai/claude-code && sudo apt-get update -q && sudo apt-get install -y -q gh && sudo git config --system --add safe.directory '*'"
  }, null, 2);
}
var DEFAULTS_DIR;
var init_devcontainer_generator = __esm({
  "src/lib/devcontainer-generator.ts"() {
    "use strict";
    DEFAULTS_DIR = join(dirname(dirname(__dirname)), "defaults", "devcontainers");
  }
});

// src/lib/container-manager.ts
import { spawn, execFileSync } from "child_process";
import { existsSync as existsSync2, readFileSync as readFileSync2, appendFileSync, writeFileSync, mkdirSync } from "fs";
import { EventEmitter } from "events";
import path from "path";
function devcontainerBin() {
  const ext = process.platform === "win32" ? ".cmd" : "";
  const local = path.join(process.cwd(), "node_modules", ".bin", `devcontainer${ext}`);
  return existsSync2(local) ? local : `devcontainer${ext}`;
}
function _resetDockerAvailableCache() {
  _dockerAvailable = null;
}
function dockerAvailable() {
  if (_dockerAvailable !== null) return _dockerAvailable;
  try {
    execFileSync("docker", ["info"], { stdio: "ignore", timeout: 2e3 });
    _dockerAvailable = true;
  } catch (err) {
    _dockerAvailable = false;
    warn("container", "docker info check failed", err);
  }
  return _dockerAvailable;
}
function readContainerConfig(projectRoot) {
  const cfgPath = path.join(projectRoot, ".teamai", "container.json");
  if (existsSync2(cfgPath)) {
    try {
      return { ...JSON.parse(readFileSync2(cfgPath, "utf-8")), explicit: true };
    } catch (err) {
      warn("container", "Failed to parse container config, using defaults", err);
    }
  }
  return { enabled: dockerAvailable(), explicit: false };
}
function readContainerRemoteUser(projectRoot) {
  const devCfgPath = path.join(projectRoot, ".devcontainer", "devcontainer.json");
  if (existsSync2(devCfgPath)) {
    try {
      const cfg = JSON.parse(readFileSync2(devCfgPath, "utf-8"));
      if (cfg.remoteUser) return cfg.remoteUser;
    } catch (err) {
      warn("container", "Failed to parse devcontainer.json", err);
    }
  }
  return "node";
}
function hostToContainerPath(hostPath, hostProjectRoot, containerWorkspace) {
  const normalize = (p) => p.replace(/\\/g, "/").replace(/^[A-Za-z]:/, "");
  const rel = path.posix.relative(normalize(hostProjectRoot), normalize(hostPath));
  return `${containerWorkspace}/${rel}`;
}
var _dockerAvailable, ContainerManager, containerManager;
var init_container_manager = __esm({
  "src/lib/container-manager.ts"() {
    "use strict";
    init_logger();
    _dockerAvailable = null;
    ContainerManager = class extends EventEmitter {
      constructor() {
        super(...arguments);
        this.records = /* @__PURE__ */ new Map();
      }
      _newRecord(projectRoot, state) {
        return {
          projectRoot,
          state,
          containerId: null,
          remoteWorkspaceFolder: null,
          startPromise: null,
          eventWatcher: null,
          validationSteps: [],
          validationPromise: null
        };
      }
      async ensureContainer(projectRoot, logFile) {
        let record = this.records.get(projectRoot);
        if (!record || record.state === "stopped") {
          const existing = this._findRunningContainerSync(projectRoot);
          if (existing) {
            record = this._newRecord(projectRoot, "running");
            record.containerId = existing.containerId;
            record.remoteWorkspaceFolder = existing.remoteWorkspaceFolder;
            this.records.set(projectRoot, record);
            this._watchEvents(record);
            return existing;
          }
          record = this._newRecord(projectRoot, "starting");
          this.records.set(projectRoot, record);
          this._emit(record, "starting");
          record.startPromise = this._doStart(record, logFile);
        }
        if (record.state === "starting" || record.state === "restarting") {
          await record.startPromise;
        }
        if (record.state !== "running" || !record.containerId || !record.remoteWorkspaceFolder) {
          throw new Error(`Container for ${projectRoot} is not available (state: ${record.state})`);
        }
        return { containerId: record.containerId, remoteWorkspaceFolder: record.remoteWorkspaceFolder };
      }
      getState(projectRoot) {
        const existing = this.records.get(projectRoot);
        if (existing) return existing.state;
        try {
          const normalized = projectRoot.replace(/^([A-Z]):/, (_, d) => `${d.toLowerCase()}:`);
          const label = `devcontainer.local_folder=${normalized}`;
          const out = execFileSync("docker", [
            "ps",
            "-a",
            "--filter",
            `label=${label}`,
            "--format",
            "{{.Status}}"
          ], { encoding: "utf-8", timeout: 1e4 }).trim();
          if (out.includes("Up")) return "running";
          if (out) return "stopped";
        } catch (err) {
          warn("container", "Docker status check failed", err);
        }
        return "stopped";
      }
      // Synchronously find a running devcontainer via Docker labels — used as fallback
      // when the in-memory record was lost (e.g. after a server restart).
      _findRunningContainerSync(projectRoot) {
        try {
          const normalized = projectRoot.replace(/^([A-Z]):/, (_, d) => `${d.toLowerCase()}:`);
          const label = `devcontainer.local_folder=${normalized}`;
          const containerId = execFileSync("docker", [
            "ps",
            "--filter",
            `label=${label}`,
            "--format",
            "{{.ID}}"
          ], { encoding: "utf-8", timeout: 5e3 }).trim();
          if (!containerId) return null;
          const mountsJson = execFileSync("docker", [
            "inspect",
            containerId,
            "--format",
            "{{json .Mounts}}"
          ], { encoding: "utf-8", timeout: 5e3 }).trim();
          const mounts = JSON.parse(mountsJson);
          const normalizedRoot = projectRoot.replace(/\\/g, "/").toLowerCase();
          const workspaceMount = mounts.find(
            (m) => m.Source.replace(/\\/g, "/").toLowerCase() === normalizedRoot
          );
          if (!workspaceMount) return null;
          return { containerId, remoteWorkspaceFolder: workspaceMount.Destination };
        } catch {
          return null;
        }
      }
      // Returns the running container info synchronously — for use in orchestrator git commands.
      // Falls back to a Docker label scan when the in-memory record is absent (e.g. server restart).
      getRunningContainer(projectRoot) {
        const r = this.records.get(projectRoot);
        if (r?.state === "running" && r.containerId && r.remoteWorkspaceFolder) {
          return { containerId: r.containerId, remoteWorkspaceFolder: r.remoteWorkspaceFolder };
        }
        const info = this._findRunningContainerSync(projectRoot);
        if (info) {
          const record = this._newRecord(projectRoot, "running");
          record.containerId = info.containerId;
          record.remoteWorkspaceFolder = info.remoteWorkspaceFolder;
          this.records.set(projectRoot, record);
        }
        return info;
      }
      async _doStart(record, logFile) {
        const args = [
          "up",
          "--workspace-folder",
          record.projectRoot,
          "--log-format",
          "json"
        ];
        try {
          const { containerId, remoteWorkspaceFolder } = await this._spawnDevcontainerUp(args, record.projectRoot, logFile);
          record.containerId = containerId;
          record.remoteWorkspaceFolder = remoteWorkspaceFolder;
          record.state = "running";
          record.startPromise = null;
          console.log(`[container] Started \u2014 id=${containerId} workspace=${remoteWorkspaceFolder}`);
          this._emit(record, "running");
          this._watchEvents(record);
        } catch (err) {
          record.state = "stopped";
          record.containerId = null;
          record.remoteWorkspaceFolder = null;
          record.startPromise = null;
          this._emit(record, "stopped");
          throw err;
        }
      }
      _spawnDevcontainerUp(args, projectRoot, logFile) {
        return new Promise((resolve, reject) => {
          const proc = spawn(devcontainerBin(), args, { stdio: ["ignore", "pipe", "pipe"] });
          let stdout = "";
          let stderr = "";
          const writeToLog = (msg) => {
            if (!logFile) return;
            try {
              appendFileSync(logFile, msg);
            } catch {
            }
          };
          proc.stdout?.on("data", (d) => {
            const chunk = d.toString();
            stdout += chunk;
            for (const line of chunk.split("\n").filter(Boolean)) {
              try {
                const entry = JSON.parse(line);
                if (entry.message) {
                  const formatted = `\u25C6 ${entry.message}
`.replace(/\n/g, "\r\n");
                  writeToLog(formatted);
                  this.emit("container-log", { projectRoot, message: entry.message });
                }
              } catch {
              }
            }
          });
          proc.stderr?.on("data", (d) => {
            const chunk = d.toString();
            stderr += chunk;
            for (const line of chunk.split("\n").filter(Boolean)) {
              const message = line.replace(/\r/g, "").trim();
              if (message) {
                const formatted = `  ${message}
`.replace(/\n/g, "\r\n");
                writeToLog(formatted);
                this.emit("container-log", { projectRoot, message });
              }
            }
          });
          proc.on("error", (err) => reject(new Error(`devcontainer not found: ${err.message}`)));
          proc.on("exit", (code) => {
            if (code !== 0) return reject(new Error(`devcontainer up failed (exit ${code}):
${stderr}`));
            const resultLine = stdout.trim().split("\n").map((l) => {
              try {
                return JSON.parse(l);
              } catch {
                return null;
              }
            }).find((o) => o && "outcome" in o);
            if (!resultLine) return reject(new Error(`No result JSON in devcontainer output:
${stdout}`));
            if (resultLine.outcome !== "success") {
              return reject(new Error(`devcontainer up outcome: ${resultLine.outcome}
${stderr}`));
            }
            writeToLog("\u2713 Devcontainer ready\r\n");
            this.emit("container-log", { projectRoot, message: "Devcontainer ready" });
            resolve({ containerId: resultLine.containerId, remoteWorkspaceFolder: resultLine.remoteWorkspaceFolder });
          });
        });
      }
      _watchEvents(record) {
        const watcher = spawn("docker", [
          "events",
          "--filter",
          `container=${record.containerId}`,
          "--filter",
          "event=die",
          "--format",
          "{{.Action}}"
        ]);
        record.eventWatcher = watcher;
        watcher.stdout?.on("data", () => this._onContainerDied(record));
        watcher.on("exit", () => {
          if (record.state === "running") this._onContainerDied(record);
        });
        watcher.on("error", () => {
          if (record.state === "running") this._onContainerDied(record);
        });
      }
      _onContainerDied(record) {
        if (record.state !== "running") return;
        console.log(`[container] Container for ${record.projectRoot} died \u2014 attempting one restart`);
        record.state = "restarting";
        record.containerId = null;
        record.remoteWorkspaceFolder = null;
        record.eventWatcher?.kill();
        record.eventWatcher = null;
        this._emit(record, "restarting");
        record.startPromise = this._doStart(record).catch(() => {
        });
      }
      // ── Bootstrap & Validation ─────────────────────────────────────────────────
      /**
       * Bootstrap a container for a project: generate devcontainer.json if missing,
       * start the container, and validate it by building + testing the project inside.
       * Called asynchronously from saveContainerConfig when the user enables containers.
       */
      async bootstrapContainer(projectRoot) {
        const { analyzeProject: analyzeProject2, generateDevcontainer: generateDevcontainer2 } = await Promise.resolve().then(() => (init_devcontainer_generator(), devcontainer_generator_exports));
        const devCfgPath = path.join(projectRoot, ".devcontainer", "devcontainer.json");
        if (!existsSync2(devCfgPath)) {
          this.emit("container-state", { projectRoot, state: "generating" });
          try {
            const info = analyzeProject2(projectRoot);
            this._emitLog(projectRoot, `Detected project type: ${info.type}${info.packageManager ? ` (${info.packageManager})` : ""}`);
            this._emitLog(projectRoot, `Build commands from docs: install="${info.installCommand}" build="${info.buildCommand}" test="${info.testCommand}"`);
            const devCfgDir = path.join(projectRoot, ".devcontainer");
            if (!existsSync2(devCfgDir)) mkdirSync(devCfgDir, { recursive: true });
            writeFileSync(devCfgPath, generateDevcontainer2(projectRoot, info));
            log("container", `Generated devcontainer.json for ${projectRoot} (type=${info.type})`);
            this._emitLog(projectRoot, `Generated .devcontainer/devcontainer.json for ${info.type} project`);
          } catch (err) {
            warn("container", "Failed to generate devcontainer.json", err);
            this.emit("container-state", { projectRoot, state: "stopped" });
            return;
          }
        }
        try {
          await this.ensureContainer(projectRoot);
        } catch (err) {
          warn("container", "Container startup failed during bootstrap", err);
          return;
        }
        await this.validateContainer(projectRoot);
      }
      /**
       * Validate a running container by executing install, build, and test
       * commands inside it via docker exec. Progress streams via container-log
       * events. If validation fails, the UI can retry with an agent.
       */
      async validateContainer(projectRoot) {
        const record = this.records.get(projectRoot);
        if (!record || !record.containerId) {
          warn("container", "Cannot validate \u2014 container not running");
          return false;
        }
        record.state = "validating";
        this._emit(record, "validating");
        this._emitLog(projectRoot, "Validating container \u2014 running build and tests\u2026");
        const info = await this._getValidationCommands(projectRoot);
        const steps = [
          { name: "Agent tooling", command: "claude --version && gh --version && git --version", status: "pending" },
          { name: "Install dependencies", command: info.installCommand, status: "pending" },
          { name: "Build", command: info.buildCommand, status: "pending" },
          { name: "Tests", command: info.testCommand, status: "pending" }
        ];
        record.validationSteps = steps;
        let allPassed = true;
        for (const step of steps) {
          step.status = "running";
          this._emitValidation(projectRoot, step);
          this._emitLog(projectRoot, `  \u25B6 ${step.name}\u2026`);
          try {
            const output = execFileSync("docker", [
              "exec",
              "-i",
              "-w",
              record.remoteWorkspaceFolder,
              record.containerId,
              "sh",
              "-c",
              step.command
            ], { encoding: "utf-8", timeout: 3e5, maxBuffer: 10 * 1024 * 1024 });
            step.status = "passed";
            step.output = output.slice(-2e3);
            this._emitValidation(projectRoot, step);
            this._emitLog(projectRoot, `  \u2713 ${step.name} passed`);
          } catch (err) {
            const execErr = err;
            step.status = "failed";
            step.error = execErr.stderr || execErr.stdout || execErr.message || String(err);
            step.output = execErr.stdout?.slice(-2e3) || "";
            this._emitValidation(projectRoot, step);
            this._emitLog(projectRoot, `  \u2717 ${step.name} FAILED`);
            allPassed = false;
            break;
          }
        }
        if (allPassed) {
          record.state = "running";
          this._emit(record, "running");
          this._emitLog(projectRoot, "\u2713 Container validation complete \u2014 all steps passed");
        } else {
          record.state = "running";
          this._emit(record, "running");
          this._emitLog(projectRoot, "\u2717 Container validation failed \u2014 check the logs above for details. The container is running and can be used, but you may need to adjust .devcontainer/devcontainer.json.");
        }
        return allPassed;
      }
      /** Get validation state for the UI to display */
      getValidationSteps(projectRoot) {
        return this.records.get(projectRoot)?.validationSteps ?? [];
      }
      async _getValidationCommands(projectRoot) {
        try {
          const { analyzeProject: analyzeProject2 } = await Promise.resolve().then(() => (init_devcontainer_generator(), devcontainer_generator_exports));
          const info = analyzeProject2(projectRoot);
          return {
            installCommand: info.installCommand,
            buildCommand: info.buildCommand,
            testCommand: info.testCommand
          };
        } catch {
          return {
            installCommand: "npm install",
            buildCommand: "npm run build",
            testCommand: "npm test"
          };
        }
      }
      /** Emit a log line to the container-log channel */
      _emitLog(projectRoot, message) {
        this.emit("container-log", { projectRoot, message });
      }
      /** Emit a validation step update */
      _emitValidation(projectRoot, step) {
        this.emit("container-validation", { projectRoot, step });
      }
      _emit(record, state) {
        this.emit("container-state", { projectRoot: record.projectRoot, state });
      }
    };
    containerManager = global.__containerManager ?? (global.__containerManager = new ContainerManager());
  }
});

// src/lib/process-manager.ts
var process_manager_exports = {};
__export(process_manager_exports, {
  ProcessManager: () => ProcessManager,
  containerSessionOpts: () => containerSessionOpts,
  processManager: () => processManager
});
import { spawn as spawn2, execFileSync as execFileSync2 } from "child_process";
import { EventEmitter as EventEmitter2 } from "events";
import { randomUUID } from "crypto";
import { join as join2 } from "path";
import * as pty from "node-pty";
import { readFileSync as readFileSync3, existsSync as existsSync3, appendFileSync as appendFileSync2 } from "fs";
function findExecutable(name) {
  try {
    if (process.platform === "win32") {
      return execFileSync2("where", [name], { encoding: "utf-8" }).trim().split(/\r?\n/)[0].trim();
    }
    return execFileSync2("which", [name], { encoding: "utf-8" }).trim();
  } catch {
    return name;
  }
}
function containerSessionOpts(projectRoot) {
  return { projectRoot, permissionMode: "bypassPermissions" };
}
var ProcessManager, processManager;
var init_process_manager = __esm({
  "src/lib/process-manager.ts"() {
    "use strict";
    init_container_manager();
    ProcessManager = class extends EventEmitter2 {
      constructor() {
        super(...arguments);
        this.sessions = /* @__PURE__ */ new Map();
        this.terminalSessions = /* @__PURE__ */ new Map();
      }
      /**
       * Spawn a new Claude CLI subprocess for an agent session.
       * When projectRoot is provided and container mode is enabled, the session
       * runs via `docker exec` inside the project's devcontainer.
       */
      async createSession(opts) {
        const id = randomUUID();
        const claudeArgs = [
          "-p",
          "--input-format",
          "stream-json",
          "--output-format",
          "stream-json",
          "--verbose"
        ];
        if (opts.model) claudeArgs.push("--model", opts.model);
        let proc;
        if (opts.projectRoot && readContainerConfig(opts.projectRoot).enabled) {
          const { containerId, remoteWorkspaceFolder } = await containerManager.ensureContainer(opts.projectRoot, opts.logFile);
          const containerCwd = hostToContainerPath(opts.cwd, opts.projectRoot, remoteWorkspaceFolder);
          const envFlags = Object.entries(opts.env ?? {}).flatMap(([k, v]) => ["-e", `${k}=${v}`]);
          claudeArgs.push("--dangerously-skip-permissions");
          const remoteUser = readContainerRemoteUser(opts.projectRoot);
          proc = spawn2("docker", [
            "exec",
            "-i",
            "-u",
            remoteUser,
            // use the devcontainer's remoteUser from devcontainer.json
            "-w",
            containerCwd,
            ...envFlags,
            containerId,
            "claude",
            ...claudeArgs
          ], { stdio: ["pipe", "pipe", "pipe"] });
        } else {
          if (opts.permissionMode) claudeArgs.push("--permission-mode", opts.permissionMode);
          proc = spawn2("claude", claudeArgs, {
            stdio: ["pipe", "pipe", "pipe"],
            env: { ...process.env, ...opts.env ?? {} },
            cwd: opts.cwd
          });
        }
        const { logFile } = opts;
        let buffer = "";
        const now = Date.now();
        proc.stdout.on("data", (chunk) => {
          buffer += chunk.toString();
          const lines = buffer.split("\n");
          buffer = lines.pop() || "";
          for (const line of lines) {
            if (line.trim()) {
              try {
                const event = JSON.parse(line);
                this.emit("event", { sessionId: id, event });
                if (logFile) this._appendToLog(logFile, event);
              } catch {
                this.emit("raw", { sessionId: id, data: line });
              }
            }
          }
          const session = this.sessions.get(id);
          if (session) session.lastOutputAt = Date.now();
        });
        proc.stderr.on("data", (chunk) => {
          const text = chunk.toString();
          if (logFile) appendFileSync2(logFile, `[STDERR] ${text}`);
          this.emit("error", { sessionId: id, error: text });
        });
        proc.on("exit", (code) => {
          if (buffer.trim()) {
            try {
              const event = JSON.parse(buffer);
              this.emit("event", { sessionId: id, event });
            } catch {
              this.emit("raw", { sessionId: id, data: buffer });
            }
          }
          const session = this.sessions.get(id);
          if (session) session.status = code === 0 ? "done" : "error";
          this.emit("exit", { sessionId: id, code });
        });
        this.sessions.set(id, {
          id,
          process: proc,
          taskId: opts.taskId,
          role: opts.role,
          cwd: opts.cwd,
          status: "running",
          lastOutputAt: now
        });
        return id;
      }
      _appendToLog(logFile, event) {
        try {
          let text = "";
          if (event.type === "system" && event.subtype === "init") {
            text = `\u25C6 Session started \u2014 ${event.model}
`;
          } else if (event.type === "assistant") {
            const blocks = event.message?.content ?? [];
            for (const b of blocks) {
              if (b.type === "text" && b.text) text += b.text;
              else if (b.type === "tool_use") text += `\u25B6 ${b.name}
`;
            }
          } else if (event.type === "result") {
            const cost = typeof event.total_cost_usd === "number" ? ` \u2014 $${event.total_cost_usd.toFixed(4)}` : "";
            text = event.subtype === "success" ? `
\u2713 Done${cost} (${event.duration_ms}ms)
` : `
\u2717 Failed: ${event.result ?? "unknown error"}
`;
          } else if (event.type === "error") {
            text = `
\u26A0 ${event.error}
`;
          }
          if (text) appendFileSync2(logFile, text);
        } catch {
        }
      }
      /**
       * Send a message to an existing session.
       */
      sendMessage(sessionId, content) {
        const session = this.sessions.get(sessionId);
        if (!session || !session.process.stdin?.writable) {
          throw new Error(`Session ${sessionId} not available`);
        }
        const msg = { type: "user", message: { role: "user", content } };
        session.process.stdin.write(JSON.stringify(msg) + "\n");
      }
      /**
       * Kill a session's subprocess.
       */
      killSession(sessionId) {
        const session = this.sessions.get(sessionId);
        if (session) {
          session.process.kill("SIGTERM");
          setTimeout(() => {
            const s = this.sessions.get(sessionId);
            if (s && s.process.exitCode === null) {
              s.process.kill("SIGKILL");
            }
          }, 5e3);
          session.status = "done";
        }
      }
      getSession(id) {
        return this.sessions.get(id);
      }
      getAllSessions() {
        return Array.from(this.sessions.values());
      }
      /**
       * Return sessions whose child process has exited (exitCode !== null) or was
       * killed (process.killed === true).  These represent stale references left
       * after a server crash or unexpected shutdown.
       */
      getStaleSessions() {
        const stale = [];
        for (const session of this.sessions.values()) {
          if (session.process.exitCode !== null || session.process.killed) {
            stale.push(session);
          }
        }
        return stale;
      }
      /**
       * Remove a stale session from the in-memory map.  Does not attempt to kill
       * the child process (assumed already dead).
       */
      removeStaleSession(sessionId) {
        this.sessions.delete(sessionId);
      }
      /**
       * Return sessions that have produced no output for longer than `timeoutMs`.
       * These sessions may be stalled/hung and need intervention (#8).
       */
      getStalledSessions(timeoutMs = 12e4) {
        const now = Date.now();
        const stalled = [];
        for (const session of this.sessions.values()) {
          if (session.status !== "running") continue;
          if (now - session.lastOutputAt > timeoutMs) {
            stalled.push(session);
          }
        }
        return stalled;
      }
      // ── PTY terminal sessions ──────────────────────────────────────────────────
      createTerminalSession(opts) {
        const id = randomUUID();
        const roleFile = join2(opts.projectPath, ".claude", "roles", opts.role);
        const roleContent = existsSync3(roleFile) ? readFileSync3(roleFile, "utf-8") : "";
        if (roleContent) {
          console.log(`[terminal ${id}] Role persona loaded from ${roleFile} (${roleContent.length} chars)`);
        } else {
          console.warn(`[terminal ${id}] Role file not found or empty: ${roleFile} \u2014 starting without role persona`);
        }
        const args = roleContent ? ["--append-system-prompt", roleContent] : [];
        if (opts.model) args.push("--model", opts.model);
        const claudeBin = findExecutable("claude");
        const ptyProcess = pty.spawn(claudeBin, args, {
          name: "xterm-color",
          cols: 120,
          rows: 40,
          cwd: opts.projectPath,
          env: process.env
        });
        ptyProcess.onData((data) => {
          this.emit("terminal-data", { sessionId: id, data });
        });
        ptyProcess.onExit(() => {
          this.terminalSessions.delete(id);
          this.emit("terminal-exit", { sessionId: id });
        });
        this.terminalSessions.set(id, { id, ptyProcess, role: opts.role, projectPath: opts.projectPath });
        return id;
      }
      writeToTerminal(sessionId, data) {
        this.terminalSessions.get(sessionId)?.ptyProcess.write(data);
      }
      resizeTerminal(sessionId, cols, rows) {
        this.terminalSessions.get(sessionId)?.ptyProcess.resize(cols, rows);
      }
      killTerminalSession(sessionId) {
        const s = this.terminalSessions.get(sessionId);
        if (s) {
          s.ptyProcess.kill();
          this.terminalSessions.delete(sessionId);
        }
      }
      getTerminalSessions() {
        return Array.from(this.terminalSessions.values());
      }
    };
    processManager = global.__processManager ?? (global.__processManager = new ProcessManager());
  }
});

// src/lib/utils.ts
function slugify(text) {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 40);
}
var init_utils = __esm({
  "src/lib/utils.ts"() {
    "use strict";
  }
});

// src/lib/task-store.ts
import { readFileSync as readFileSync4, writeFileSync as writeFileSync2, mkdirSync as mkdirSync2, readdirSync as readdirSync2, existsSync as existsSync4, appendFileSync as appendFileSync3, rmSync, unlinkSync, renameSync } from "fs";
import { join as join3 } from "path";
function isRetryableError(err) {
  return typeof err === "object" && err !== null && "code" in err && err.code === "EPERM" || err.code === "EBUSY";
}
function atomicWriteJson(filePath, data, retries = 3) {
  const tmpPath = filePath + ".tmp";
  writeFileSync2(tmpPath, JSON.stringify(data, null, 2));
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      renameSync(tmpPath, filePath);
      return;
    } catch (err) {
      if (attempt === retries - 1 || !isRetryableError(err)) throw err;
      const waitUntil = Date.now() + 10 * 2 ** attempt;
      while (Date.now() < waitUntil) {
      }
    }
  }
}
var TaskStore;
var init_task_store = __esm({
  "src/lib/task-store.ts"() {
    "use strict";
    init_utils();
    TaskStore = class {
      constructor(projectPath) {
        this.specsDir = join3(projectPath, ".teamai");
        mkdirSync2(this.specsDir, { recursive: true });
      }
      create(id, title, description, source, competitiveContext) {
        const slug = slugify(title);
        const dir = join3(this.specsDir, slug);
        mkdirSync2(dir, { recursive: true });
        const task = {
          id,
          title,
          description,
          phase: "backlog",
          source,
          competitiveContext,
          createdAt: (/* @__PURE__ */ new Date()).toISOString(),
          updatedAt: (/* @__PURE__ */ new Date()).toISOString()
        };
        atomicWriteJson(join3(dir, "task.json"), task);
        return task;
      }
      update(id, fields) {
        const task = this.getById(id);
        if (!task) throw new Error(`Task ${id} not found`);
        const updated = { ...task, ...fields, updatedAt: (/* @__PURE__ */ new Date()).toISOString() };
        const dir = this.getDirById(id);
        atomicWriteJson(join3(dir, "task.json"), updated);
      }
      updatePhase(id, phase) {
        const task = this.getById(id);
        if (!task) throw new Error(`Task ${id} not found`);
        task.phase = phase;
        task.updatedAt = (/* @__PURE__ */ new Date()).toISOString();
        const dir = this.getDirById(id);
        atomicWriteJson(join3(dir, "task.json"), task);
        const event = { phase, timestamp: (/* @__PURE__ */ new Date()).toISOString() };
        appendFileSync3(join3(dir, "events.jsonl"), JSON.stringify(event) + "\n");
      }
      getAll() {
        if (!existsSync4(this.specsDir)) return [];
        return readdirSync2(this.specsDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => {
          const taskPath = join3(this.specsDir, d.name, "task.json");
          if (!existsSync4(taskPath)) return null;
          return JSON.parse(readFileSync4(taskPath, "utf-8"));
        }).filter((t) => t !== null).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      }
      getById(id) {
        return this.getAll().find((t) => t.id === id) || null;
      }
      getDirById(id) {
        const dirs = readdirSync2(this.specsDir, { withFileTypes: true }).filter((d) => d.isDirectory());
        for (const d of dirs) {
          const taskPath = join3(this.specsDir, d.name, "task.json");
          if (existsSync4(taskPath)) {
            const task = JSON.parse(readFileSync4(taskPath, "utf-8"));
            if (task.id === id) return join3(this.specsDir, d.name);
          }
        }
        throw new Error(`Task directory not found for id ${id}`);
      }
      delete(id) {
        const dir = this.getDirById(id);
        try {
          const tmpPath = join3(dir, "task.json.tmp");
          if (existsSync4(tmpPath)) unlinkSync(tmpPath);
        } catch {
        }
        rmSync(dir, { recursive: true, force: true });
      }
      // Remove pipeline artifacts at or after a given level so the pipeline can re-run from there.
      // level: 'spec' | 'plan' | 'qa'
      clearArtifacts(id, level) {
        const dir = this.getDirById(id);
        const files = {
          spec: ["spec.md", "plan.json", "qa_report.json", "spec_revision_feedback.md", "spec_v1.md", "spec_v2.md", "spec_v3.md"],
          plan: ["plan.json", "qa_report.json"],
          qa: ["qa_report.json", "qa_feedback.md", "completion_summary.md", "qa_report_before_bounce.json"]
        };
        for (const f of files[level]) {
          const p = join3(dir, f);
          if (existsSync4(p)) unlinkSync(p);
        }
      }
      getDirBySlug(slug) {
        return join3(this.specsDir, slug);
      }
      /**
       * Read the raw task.json file for the given task without parsing.
       * Returns the raw file content or null if not found. Used for
       * atomic writes that need to read-back before modifying.
       */
      readRawTaskJson(id) {
        try {
          const dir = this.getDirById(id);
          const path15 = join3(dir, "task.json");
          if (!existsSync4(path15)) return null;
          return readFileSync4(path15, "utf-8");
        } catch {
          return null;
        }
      }
      getEvents(taskId) {
        const dir = this.getDirById(taskId);
        const eventsPath = join3(dir, "events.jsonl");
        if (!existsSync4(eventsPath)) return [];
        return readFileSync4(eventsPath, "utf-8").split("\n").filter((line) => line.trim()).map((line) => JSON.parse(line));
      }
    };
  }
});

// src/lib/orchestrator/worktree-utils.ts
import { execFileSync as execFileSync3 } from "child_process";
import { existsSync as existsSync5, readFileSync as readFileSync5, writeFileSync as writeFileSync3, unlinkSync as unlinkSync2, renameSync as renameSync2 } from "fs";
import path2 from "path";
function isWorktreeHealthy(worktreePath, projectRoot) {
  try {
    const gitFile = path2.join(worktreePath, ".git");
    if (!existsSync5(gitFile)) return false;
    const content = readFileSync5(gitFile, "utf-8").trim();
    if (!content.startsWith("gitdir:")) return false;
    const gitdir = content.slice("gitdir:".length).trim();
    if (existsSync5(gitdir)) return true;
    if (readContainerConfig(projectRoot).enabled) {
      const m = gitdir.replace(/\\/g, "/").match(/\/worktrees\/([^/]+)$/);
      if (m) {
        const hostGitdir = path2.join(projectRoot, ".git", "worktrees", m[1]);
        if (existsSync5(hostGitdir)) return true;
      }
    }
    return false;
  } catch {
    return false;
  }
}
function writeFileEnsuringWritable(filePath, content) {
  try {
    writeFileSync3(filePath, content);
  } catch (e) {
    if (e?.code !== "EPERM") throw e;
    const tmpPath = filePath + ".tmp";
    writeFileSync3(tmpPath, content);
    try {
      renameSync2(tmpPath, filePath);
    } catch (renameErr) {
      try {
        unlinkSync2(tmpPath);
      } catch {
      }
      throw renameErr;
    }
  }
}
function patchCommondirToRelative(worktreeName, projectRoot) {
  const commondirFile = path2.join(projectRoot, ".git", "worktrees", worktreeName, "commondir");
  if (existsSync5(commondirFile)) {
    const current = readFileSync5(commondirFile, "utf-8").trim().replace(/\\/g, "/");
    if (current !== "../..") {
      writeFileEnsuringWritable(commondirFile, "../..\n");
    }
  }
}
function restoreWorktreeGitFileToHostPaths(hostWorktreePath, projectRoot) {
  const gitFile = path2.join(hostWorktreePath, ".git");
  if (!existsSync5(gitFile)) return;
  try {
    const content = readFileSync5(gitFile, "utf-8").trim();
    if (!content.startsWith("gitdir:")) return;
    const currentGitdir = content.slice("gitdir:".length).trim().replace(/\\/g, "/");
    const m = currentGitdir.match(/\/worktrees\/([^/]+)$/);
    if (!m) return;
    const worktreeName = m[1];
    const hostRoot = projectRoot.replace(/\\/g, "/");
    const hostGitdir = `${hostRoot}/.git/worktrees/${worktreeName}`;
    if (currentGitdir === hostGitdir) return;
    writeFileEnsuringWritable(gitFile, `gitdir: ${hostGitdir}
`);
    const backRefFile = path2.join(projectRoot, ".git", "worktrees", worktreeName, "gitdir");
    if (existsSync5(backRefFile)) {
      const hostWorktreeGitFile = `${hostWorktreePath.replace(/\\/g, "/")}/.git`;
      writeFileEnsuringWritable(backRefFile, `${hostWorktreeGitFile}
`);
    }
    patchCommondirToRelative(worktreeName, projectRoot);
  } catch {
  }
}
function patchWorktreeGitFile(hostWorktreePath, containerWorkspace, projectRoot) {
  const gitFile = path2.join(hostWorktreePath, ".git");
  if (!existsSync5(gitFile)) return;
  try {
    const content = readFileSync5(gitFile, "utf-8").trim();
    if (!content.startsWith("gitdir:")) return;
    const currentGitdir = content.slice("gitdir:".length).trim();
    const m = currentGitdir.replace(/\\/g, "/").match(/\/worktrees\/([^/]+)$/);
    if (!m) return;
    const worktreeName = m[1];
    const correctGitdir = `${containerWorkspace}/.git/worktrees/${worktreeName}`;
    if (currentGitdir.replace(/\\/g, "/") === correctGitdir) return;
    writeFileEnsuringWritable(gitFile, `gitdir: ${correctGitdir}
`);
    const backRefFile = path2.join(projectRoot, ".git", "worktrees", worktreeName, "gitdir");
    if (existsSync5(backRefFile)) {
      const containerWorktreePath = hostToContainerPath(hostWorktreePath, projectRoot, containerWorkspace);
      writeFileEnsuringWritable(backRefFile, `${containerWorktreePath}/.git
`);
    }
    patchCommondirToRelative(worktreeName, projectRoot);
  } catch {
  }
}
function worktreeGitEnv(hostCwd, projectRoot, containerWs) {
  const worktreeName = path2.basename(hostCwd);
  const hostGitDir = path2.join(projectRoot, ".git", "worktrees", worktreeName);
  if (!existsSync5(hostGitDir)) return {};
  if (containerWs) {
    return {
      GIT_DIR: `${containerWs}/.git/worktrees/${worktreeName}`,
      GIT_WORK_TREE: hostToContainerPath(hostCwd, projectRoot, containerWs)
    };
  }
  return {
    GIT_DIR: hostGitDir.replace(/\\/g, "/"),
    GIT_WORK_TREE: hostCwd.replace(/\\/g, "/")
  };
}
function execGit(args, hostCwd, projectRoot) {
  if (readContainerConfig(projectRoot).enabled && args[0] !== "worktree") {
    const info = containerManager.getRunningContainer(projectRoot);
    if (info) {
      const containerCwd = hostToContainerPath(hostCwd, projectRoot, info.remoteWorkspaceFolder);
      const mappedArgs = args.map(
        (a) => path2.isAbsolute(a) && a.startsWith(projectRoot) ? hostToContainerPath(a, projectRoot, info.remoteWorkspaceFolder) : a
      );
      const remoteUser = readContainerRemoteUser(projectRoot);
      const gitEnv2 = worktreeGitEnv(hostCwd, projectRoot, info.remoteWorkspaceFolder);
      const envFlags = Object.entries(gitEnv2).flatMap(([k, v]) => ["-e", `${k}=${v}`]);
      execFileSync3("docker", ["exec", "-u", remoteUser, ...envFlags, "-w", containerCwd, info.containerId, "git", ...mappedArgs]);
      return;
    }
  }
  const gitEnv = args[0] !== "worktree" ? worktreeGitEnv(hostCwd, projectRoot) : {};
  execFileSync3("git", args, { cwd: hostCwd, ...Object.keys(gitEnv).length ? { env: { ...process.env, ...gitEnv } } : {} });
}
var init_worktree_utils = __esm({
  "src/lib/orchestrator/worktree-utils.ts"() {
    "use strict";
    init_container_manager();
  }
});

// src/lib/orchestrator/pipeline-state.ts
import { existsSync as existsSync6, readFileSync as readFileSync6, writeFileSync as writeFileSync4, unlinkSync as unlinkSync3, renameSync as renameSync3, statSync, appendFileSync as appendFileSync4 } from "fs";
import path3 from "path";
function rotateOutputLog(logFile) {
  try {
    if (!existsSync6(logFile)) return;
    const MAX_SIZE = 1e5;
    const KEEP_SIZE = 5e4;
    const stat = statSync(logFile);
    if (stat.size > MAX_SIZE) {
      const content = readFileSync6(logFile, "utf-8");
      const truncated = content.slice(-KEEP_SIZE);
      writeFileSync4(logFile, truncated);
      appendFileSync4(logFile, `
\u2500\u2500 LOG TRUNCATED (${stat.size} \u2192 ${KEEP_SIZE} bytes) \u2500\u2500
`);
    }
  } catch {
  }
}
function persistAndEmitPhase(pipeline, taskStore, projectRoot) {
  taskStore.updatePhase(pipeline.taskId, pipeline.phase);
  processManager.emit("phase-change", { taskId: pipeline.taskId, phase: pipeline.phase, projectRoot });
}
function savePipelineState(pipeline) {
  try {
    const statePath = path3.join(pipeline.specPath, ".pipeline_state.json");
    const state = {
      taskId: pipeline.taskId,
      phase: pipeline.phase,
      sessionId: pipeline.sessionId,
      mergeStrategy: pipeline.mergeStrategy,
      qaAttempt: pipeline.qaAttempt,
      deliverableFailCounts: pipeline.deliverableFailCounts,
      wakeupUntil: pipeline.wakeupUntil,
      wakeupSubtaskId: pipeline.wakeupSubtaskId,
      wakeupCommand: pipeline.wakeupCommand,
      wakeupArtifact: pipeline.wakeupArtifact,
      wakeupAttemptCount: pipeline.wakeupAttemptCount,
      persistedCriterionFailCounts: pipeline.persistedCriterionFailCounts,
      branch: pipeline.branch,
      worktreePath: pipeline.worktreePath,
      updatedAt: (/* @__PURE__ */ new Date()).toISOString()
    };
    const tmpPath = statePath + ".tmp";
    writeFileSync4(tmpPath, JSON.stringify(state, null, 2));
    renameSync3(tmpPath, statePath);
  } catch {
  }
}
function restorePipelineState(_taskId, specPath) {
  try {
    const statePath = path3.join(specPath, ".pipeline_state.json");
    if (!existsSync6(statePath)) return null;
    const state = JSON.parse(readFileSync6(statePath, "utf-8"));
    unlinkSync3(statePath);
    return state;
  } catch {
    return null;
  }
}
function pipelineAdvancePhase(pipeline, phase, taskStore, projectRoot, eventExtra) {
  pipeline.phase = phase;
  taskStore.updatePhase(pipeline.taskId, phase);
  processManager.emit("phase-change", { taskId: pipeline.taskId, phase, projectRoot, ...eventExtra });
}
var init_pipeline_state = __esm({
  "src/lib/orchestrator/pipeline-state.ts"() {
    "use strict";
    init_process_manager();
  }
});

// src/lib/orchestrator/qa-feedback.ts
import { existsSync as existsSync7, readFileSync as readFileSync7, writeFileSync as writeFileSync5 } from "fs";
import path4 from "path";
function writeQaFeedback(specPath, report, persistedCriterionFailCounts) {
  const feedbackPath = path4.join(specPath, "qa_feedback.md");
  let content = `# QA Feedback

`;
  if (persistedCriterionFailCounts) {
    const escalated = Object.entries(persistedCriterionFailCounts).filter(([, count]) => count >= 2).map(([name, count]) => ({ name, count }));
    if (escalated.length > 0) {
      content += `## \u26A0\uFE0F PERSISTED FAILURES \u2014 RESOLVE THESE FIRST \u26A0\uFE0F

`;
      content += `The following criteria have failed **identically** across multiple consecutive QA cycles. `;
      content += `They MUST be resolved before addressing anything else below. `;
      content += `Do NOT deprioritize a persisted failure in favor of another issue.

`;
      for (const { name, count } of escalated) {
        content += `> **"${name}"** \u2014 this exact criterion has failed **${count} times in a row**.
`;
        content += `> Before considering it resolved, enumerate every case, verify each assertion direction (not comments/labels), and confirm the count meets the requirement.

`;
      }
      content += `---

`;
    }
  }
  content += `## \u26A0\uFE0F IMPORTANT: QA Feedback OVERRIDES the plan

`;
  content += `The issues listed below represent the latest requirements. `;
  content += `Where QA feedback and the plan's acceptance criteria conflict, **follow the QA feedback**. `;
  content += `The plan may be outdated \u2014 QA findings are the ground truth.

`;
  content += `## Overall: ${report.overall}

`;
  if (report.fail_type) {
    content += `**fail_type**: ${report.fail_type}

`;
  }
  if (report.criteria) {
    content += `## Failed Criteria

`;
    for (const c of report.criteria) {
      if (c.status === "FAIL") {
        const name = c.criterion || c.name || "Unknown criterion";
        const fix = c.fix_needed ? ` \u2192 Fix: ${c.fix_needed}` : "";
        content += `- **${name}**: ${c.notes || c.evidence || "No details provided"}${fix}
`;
      }
    }
  }
  if (report.additional_issues || report.issues) {
    const issues = report.additional_issues ?? report.issues;
    content += `
## Additional Issues

`;
    for (const issue of issues) {
      const desc = issue.description || issue.message || JSON.stringify(issue);
      const file = issue.file ? ` (${issue.file})` : "";
      const fix = issue.fix_needed ? ` \u2192 Fix: ${issue.fix_needed}` : "";
      content += `- ${desc}${file}${fix}
`;
    }
  }
  writeFileSync5(feedbackPath, content);
  const planPath = path4.join(specPath, "plan.json");
  if (existsSync7(planPath)) {
    try {
      const plan = JSON.parse(readFileSync7(planPath, "utf-8"));
      if (plan.subtasks) {
        let modified = false;
        if (report.criteria) {
          for (const c of report.criteria) {
            if (c.status === "FAIL" && c.fix_needed) {
              const criterionName = c.criterion || c.name || "";
              for (const subtask of plan.subtasks) {
                if (!subtask.acceptance_criteria) continue;
                const idx = subtask.acceptance_criteria.findIndex(
                  (ac) => {
                    const acLower = ac.toLowerCase();
                    const critLower = criterionName.toLowerCase();
                    return acLower.includes(critLower) || acLower.split(/\s+/).some((w) => critLower.split(/\s+/).every((cw) => w.includes(cw)));
                  }
                );
                if (idx >= 0) {
                  subtask.acceptance_criteria[idx] += ` [QA CORRECTION: ${c.fix_needed}]`;
                  subtask.qa_flagged = true;
                  modified = true;
                }
              }
            }
          }
        }
        const issues = report.additional_issues || report.issues;
        if (issues) {
          for (const issue of issues) {
            const desc = issue.description || issue.message || "";
            const fix = issue.fix_needed || "";
            if (!desc && !fix) continue;
            for (const subtask of plan.subtasks) {
              if (!subtask.files || !Array.isArray(subtask.files)) continue;
              if (issue.file && subtask.files.some((f) => {
                const issueBase = issue.file.replace(/^.*[\\/]/, "");
                const fileBase = f.replace(/^.*[\\/]/, "");
                return fileBase === issueBase || f.endsWith(issue.file) || issue.file.endsWith(f);
              })) {
                if (!subtask.acceptance_criteria) subtask.acceptance_criteria = [];
                subtask.acceptance_criteria.push(`[QA ISSUE: ${desc}${fix ? ` \u2192 Fix: ${fix}` : ""}]`);
                subtask.qa_flagged = true;
                modified = true;
              }
            }
          }
        }
        if (modified) {
          writeFileSync5(planPath, JSON.stringify(plan, null, 2));
        }
      }
    } catch {
    }
  }
}
function writeCompletionSummary(specPath, qaAttempt, taskId, taskStore) {
  const summaryPath = path4.join(specPath, "completion_summary.md");
  let content = `# Completion Summary

`;
  content += `Task failed after ${qaAttempt} QA attempts.

`;
  const planPath = path4.join(specPath, "plan.json");
  if (existsSync7(planPath)) {
    try {
      const plan = JSON.parse(readFileSync7(planPath, "utf-8"));
      if (plan.subtasks) {
        content += `## Plan Subtasks

`;
        for (const s of plan.subtasks) {
          const done = s.completed ? "COMPLETED" : "NOT COMPLETED";
          content += `- [${s.completed ? "x" : " "}] **${s.title}** \u2014 ${done}
`;
        }
      }
    } catch {
    }
  }
  const reportPath = path4.join(specPath, "qa_report.json");
  if (existsSync7(reportPath)) {
    try {
      const report = JSON.parse(readFileSync7(reportPath, "utf-8"));
      content += `
## Last QA Report

`;
      content += `Overall: **${report.overall}**

`;
      if (report.criteria) {
        content += `| Criterion | Status | Notes |
`;
        content += `|-----------|--------|-------|
`;
        for (const c of report.criteria) {
          const name = c.criterion || c.name || "-";
          content += `| ${name} | ${c.status} | ${c.notes || c.evidence || "-"} |
`;
        }
      }
      if (report.additional_issues || report.issues) {
        const issues = report.additional_issues || report.issues;
        content += `
### Issues

`;
        for (const issue of issues) {
          const desc = issue.description || issue.message || JSON.stringify(issue);
          content += `- ${desc}
`;
        }
      }
    } catch {
    }
  }
  content += `
---
*Generated automatically on ${(/* @__PURE__ */ new Date()).toISOString()}*
`;
  writeFileSync5(summaryPath, content);
  taskStore.update(taskId, { completionSummary: content });
}
var init_qa_feedback = __esm({
  "src/lib/orchestrator/qa-feedback.ts"() {
    "use strict";
  }
});

// src/lib/git-platform.ts
import { execFileSync as execFileSync4 } from "child_process";
import { appendFileSync as appendFileSync5 } from "fs";
function detectGitPlatform(projectRoot) {
  try {
    const url = execFileSync4("git", ["remote", "get-url", "origin"], {
      cwd: projectRoot,
      encoding: "utf-8",
      timeout: 5e3
    }).trim().toLowerCase();
    if (url.includes("github.com") || url.includes("github.")) return "github";
    if (url.includes("gitlab.com") || url.includes("gitlab.")) return "gitlab";
    if (url.includes("bitbucket.org") || url.includes("bitbucket.")) return "bitbucket";
  } catch (err) {
    warn("orchestrator", "Failed to detect git remote platform", err);
  }
  return "unknown";
}
function detectDefaultBranch(projectRoot) {
  try {
    const ref = execFileSync4("git", ["symbolic-ref", "refs/remotes/origin/HEAD"], {
      cwd: projectRoot,
      encoding: "utf-8",
      timeout: 3e3
    }).trim();
    const parts = ref.split("/");
    return parts[parts.length - 1] || "main";
  } catch (err) {
    warn("orchestrator", "Failed to detect default branch, falling back to main", err);
    return "main";
  }
}
function buildPRBody(description, specContent) {
  return [
    "## Summary",
    "",
    description,
    "",
    "## Testing",
    "",
    "QA review passed.",
    "",
    "---",
    "",
    "## Specification",
    "",
    specContent
  ].join("\n");
}
function checkExistingPRViaCLI(platform, branch, projectRoot) {
  if (platform === "github") {
    try {
      const result = execFileSync4("gh", [
        "pr",
        "list",
        "--head",
        branch,
        "--state",
        "open",
        "--json",
        "url",
        "--jq",
        ".[0].url"
      ], { cwd: projectRoot, encoding: "utf-8", stdio: "pipe", timeout: 1e4 });
      const url = result.trim();
      return url || null;
    } catch (err) {
      warn("git-platform", "Failed to check existing PR via gh CLI", err);
      return null;
    }
  }
  if (platform === "gitlab") {
    try {
      const result = execFileSync4("glab", [
        "mr",
        "list",
        "--source-branch",
        branch,
        "--state",
        "opened",
        "--json",
        "web_url",
        "--jq",
        ".[0].web_url"
      ], { cwd: projectRoot, encoding: "utf-8", stdio: "pipe", timeout: 1e4 });
      const url = result.trim();
      return url || null;
    } catch (err) {
      warn("git-platform", "Failed to check existing MR via glab CLI", err);
      return null;
    }
  }
  return null;
}
function createPRViaCLI(platform, branch, title, body, projectRoot, logFile) {
  const defaultBranch = detectDefaultBranch(projectRoot);
  if (platform === "github") {
    appendFileSync5(logFile, `[PR] Creating GitHub PR via gh CLI: ${branch} \u2192 ${defaultBranch}
`);
    const result = execFileSync4("gh", [
      "pr",
      "create",
      "--title",
      title,
      "--body",
      body,
      "--base",
      defaultBranch,
      "--head",
      branch
    ], { cwd: projectRoot, encoding: "utf-8", stdio: "pipe", timeout: 3e4 });
    const url = result.trim();
    appendFileSync5(logFile, `[PR] Created: ${url}
`);
    return url;
  }
  if (platform === "gitlab") {
    appendFileSync5(logFile, `[PR] Creating GitLab MR via glab CLI: ${branch} \u2192 ${defaultBranch}
`);
    const result = execFileSync4("glab", [
      "mr",
      "create",
      "--title",
      title,
      "--description",
      body,
      "--target-branch",
      defaultBranch,
      "--source-branch",
      branch,
      "--yes"
    ], { cwd: projectRoot, encoding: "utf-8", stdio: "pipe", timeout: 3e4 });
    const url = result.trim();
    appendFileSync5(logFile, `[PR] Created: ${url}
`);
    return url;
  }
  appendFileSync5(logFile, `[PR] Platform "${platform}" has no standard CLI \u2014 cannot auto-create PR
`);
  return null;
}
function buildPlatformPrompt(platform, branch, description, specContent, projectRoot) {
  const defaultBranch = detectDefaultBranch(projectRoot);
  const base = `Create a Pull Request for branch "${branch}" targeting the ${defaultBranch} branch.

IMPORTANT: First check whether an open PR already exists for branch "${branch}".
- If an open PR exists: report its URL and stop \u2014 do not create a duplicate.
- If a previously merged PR exists for this branch: ignore it and CREATE A NEW PR now.
  A merged PR does not mean the current branch commits have been reviewed.
  The branch has been re-pushed with new commits that need a fresh PR.

`;
  const meta = `Title: ${description}

Body: Generate a clear PR description from this spec:

${specContent}

Include a summary of changes, testing done (QA passed), and any notes for reviewers.`;
  switch (platform) {
    case "github":
      return base + `Use the GitHub MCP server's create_pull_request tool.

` + meta;
    case "gitlab":
      return base + `Platform: GitLab. Create a Merge Request (not a PR).
If the "glab" CLI is available, run: glab mr create --title "..." --description "..." --target-branch ${defaultBranch} --source-branch ${branch}
Otherwise, use the GitLab API (project is from remote origin URL).

` + meta;
    case "bitbucket":
      return base + `Platform: Bitbucket Cloud. Create a Pull Request.
Use the Bitbucket REST API v2 (https://api.bitbucket.org/2.0) if credentials are available.
The repository slug can be parsed from the remote origin URL.

` + meta;
    default:
      return base + `Platform: Unknown. Create a PR/MR manually using whatever tools are available.
Push the branch first: git push -u origin ${branch}
Then open the PR/MR URL in the browser.

` + meta;
  }
}
var init_git_platform = __esm({
  "src/lib/git-platform.ts"() {
    "use strict";
    init_logger();
  }
});

// src/lib/sensors.ts
import { execFile } from "child_process";
import { promisify } from "util";
import { existsSync as existsSync8, mkdirSync as mkdirSync3, writeFileSync as writeFileSync6, appendFileSync as appendFileSync6 } from "fs";
import path5 from "path";
async function runSensors(sensors, hook, params) {
  if (!sensors || sensors.length === 0) {
    return { hook, reports: [], allPassed: true };
  }
  const reports = [];
  for (const sensor of sensors) {
    const label = sensor.label || sensor.command.split(" ")[0];
    const timeout = sensor.timeout || DEFAULT_TIMEOUT_MS;
    const sensorsDir = path5.join(params.specPath, "sensors");
    if (!existsSync8(sensorsDir)) {
      try {
        mkdirSync3(sensorsDir, { recursive: true });
      } catch {
      }
    }
    const subtaskSuffix = params.subtaskId !== void 0 ? `-st${params.subtaskId}` : "";
    const sensorSlug = label.replace(/[^a-zA-Z0-9_-]/g, "-").toLowerCase();
    const outputPath = path5.join(sensorsDir, `${hook}-${sensorSlug}${subtaskSuffix}.json`);
    const filesList = params.files.length > 0 ? params.files.join(" ") : "";
    const report = {
      sensor: label,
      command: sensor.command,
      exitCode: null,
      stdout: "",
      stderr: "",
      passed: false
    };
    try {
      const { stdout, stderr } = await execFileAsync(
        process.env.SHELL || (process.platform === "win32" ? "cmd.exe" : "/bin/sh"),
        [process.platform === "win32" ? "/c" : "-c", sensor.command],
        {
          cwd: params.cwd,
          timeout,
          env: {
            ...process.env,
            SENSOR_FILES: filesList,
            SENSOR_OUTPUT: outputPath,
            SENSOR_CWD: params.cwd
          },
          maxBuffer: 1024 * 1024
          // 1 MB
        }
      );
      report.exitCode = 0;
      report.stdout = stdout.slice(0, MAX_OUTPUT_CHARS);
      report.stderr = stderr.slice(0, MAX_OUTPUT_CHARS);
      report.passed = true;
    } catch (err) {
      const execErr = err;
      if (execErr.killed) {
        report.error = `Sensor timed out after ${timeout}ms`;
        report.exitCode = null;
      } else if (execErr.code === "ENOENT") {
        report.error = `Command not found: ${sensor.command}`;
        report.exitCode = null;
      } else {
        const exitCode = execErr.code;
        report.exitCode = typeof exitCode === "number" ? exitCode : 1;
        report.stdout = (execErr.stdout || "").slice(0, MAX_OUTPUT_CHARS);
        report.stderr = (execErr.stderr || "").slice(0, MAX_OUTPUT_CHARS);
        report.passed = false;
        report.error = execErr.message?.slice(0, MAX_OUTPUT_CHARS);
      }
    }
    try {
      writeFileSync6(outputPath, JSON.stringify(report, null, 2));
    } catch {
    }
    if (params.logFile) {
      try {
        const status = report.passed ? "PASS" : report.error ? "ERROR" : "FAIL";
        appendFileSync6(
          params.logFile,
          `
[SENSOR:${hook}] ${label} \u2014 ${status} (exit ${report.exitCode ?? "null"})
` + (report.error ? `  Error: ${report.error}
` : "") + (report.stderr ? `  stderr: ${report.stderr.slice(0, 200)}
` : "")
        );
      } catch {
      }
    }
    reports.push(report);
  }
  return {
    hook,
    reports,
    allPassed: reports.every((r) => r.passed)
  };
}
function sensorRunSummary(result) {
  if (result.reports.length === 0) return "";
  const lines = result.reports.map((r) => {
    const status = r.passed ? "PASS" : r.error ? "ERROR" : "FAIL";
    return `  [${status}] ${r.sensor} (exit ${r.exitCode ?? "null"})` + (r.error ? ` \u2014 ${r.error}` : "");
  });
  return `
Sensor results for ${result.hook}:
${lines.join("\n")}
`;
}
function readPipelineSensors(pipelineConfig) {
  if (!pipelineConfig.sensors || typeof pipelineConfig.sensors !== "object") {
    return void 0;
  }
  const raw = pipelineConfig.sensors;
  const result = {};
  for (const hook of ["pre_subtask", "post_subtask", "pre_merge", "on_failure"]) {
    const arr = raw[hook];
    if (Array.isArray(arr)) {
      const sensors = [];
      for (const item of arr) {
        if (typeof item === "string") {
          sensors.push({ command: item });
        } else if (typeof item === "object" && item !== null && typeof item.command === "string") {
          sensors.push(item);
        }
      }
      if (sensors.length > 0) result[hook] = sensors;
    }
  }
  return Object.keys(result).length > 0 ? result : void 0;
}
var execFileAsync, DEFAULT_TIMEOUT_MS, MAX_OUTPUT_CHARS;
var init_sensors = __esm({
  "src/lib/sensors.ts"() {
    "use strict";
    execFileAsync = promisify(execFile);
    DEFAULT_TIMEOUT_MS = 12e4;
    MAX_OUTPUT_CHARS = 4096;
  }
});

// src/lib/orchestrator/phase-runners.ts
import { execFileSync as execFileSync5 } from "child_process";
import { existsSync as existsSync9, readFileSync as readFileSync8, unlinkSync as unlinkSync4, appendFileSync as appendFileSync7, rmSync as rmSync2, writeFileSync as writeFileSync7 } from "fs";
import path6 from "path";
async function rebaseOntoLatestMaster(worktreePath, taskId, logFile, deps) {
  try {
    execFileSync5("git", ["fetch", "origin", "master"], { cwd: deps.projectRoot, stdio: "pipe" });
    deps.execGit(["rebase", "origin/master"], worktreePath);
    appendFileSync7(logFile, "\n[INFO] Feature branch rebased onto latest master\n");
    return true;
  } catch {
    try {
      deps.execGit(["rebase", "--abort"], worktreePath);
    } catch {
    }
    appendFileSync7(logFile, "\n[INFO] Rebase had conflicts \u2014 spawning merger to resolve via git merge\n");
    try {
      const mergeLogFile = path6.join(path6.dirname(logFile), "output-merge.log");
      const mergeSessionId = await processManager.createSession(
        deps.sessionOpts("merger", worktreePath, taskId, mergeLogFile)
      );
      try {
        const sessionMapPath = path6.join(path6.dirname(logFile), "session_map.json");
        const map = existsSync9(sessionMapPath) ? JSON.parse(readFileSync8(sessionMapPath, "utf-8")) : {};
        map["merge"] = mergeSessionId;
        writeFileSync7(sessionMapPath, JSON.stringify(map, null, 2));
      } catch {
      }
      processManager.sendMessage(mergeSessionId, "/merge origin/master");
      await deps.waitForCompletion(mergeSessionId);
      processManager.killSession(mergeSessionId);
      appendFileSync7(logFile, "\n[INFO] Merger resolved rebase conflicts\n");
      return true;
    } catch (mergeErr) {
      const mergeMsg = mergeErr instanceof Error ? mergeErr.message : String(mergeErr);
      appendFileSync7(logFile, `
[WARN] Merger could not resolve rebase conflicts: ${mergeMsg}
`);
      return false;
    }
  }
}
async function runSpecPhase(pipeline, deps) {
  const logFile = path6.join(pipeline.specPath, "output.log");
  const specLogFile = path6.join(pipeline.specPath, "output-spec.log");
  deps.rotateOutputLog(logFile);
  deps.phaseHeader(logFile, "spec");
  deps.persistAndEmitPhase(pipeline);
  const sessionId = await processManager.createSession(
    deps.sessionOpts("analyst", deps.projectRoot, pipeline.taskId, specLogFile)
  );
  pipeline.sessionId = sessionId;
  deps.savePipelineState(pipeline);
  try {
    const sessionMapPath = path6.join(pipeline.specPath, "session_map.json");
    const map = existsSync9(sessionMapPath) ? JSON.parse(readFileSync8(sessionMapPath, "utf-8")) : {};
    map["spec"] = sessionId;
    writeFileSync7(sessionMapPath, JSON.stringify(map, null, 2));
  } catch {
  }
  const agentSpecPath = deps.toAgentPath(pipeline.specPath);
  const revisionFeedbackPath = path6.join(pipeline.specPath, "spec_revision_feedback.md");
  const isRevision = existsSync9(revisionFeedbackPath);
  if (isRevision) {
    processManager.sendMessage(
      sessionId,
      `REVISION: ${pipeline.description}

Read the existing spec at: \`${agentSpecPath}/spec.md\`
Read the spec revision feedback at: \`${agentSpecPath}/spec_revision_feedback.md\`
Revise the spec to address ALL concerns in the feedback.
Preserve parts of the spec that are still valid \u2014 only change what the feedback asks for.
IMPORTANT: Write the revised spec to \`${agentSpecPath}/spec.md\` (overwrite the existing file).`
    );
  } else {
    processManager.sendMessage(
      sessionId,
      `/spec ${pipeline.description}

IMPORTANT: Write the spec file to \`${agentSpecPath}/spec.md\` (use this exact path, not a new subdirectory).`
    );
  }
  await deps.waitForCompletion(sessionId);
  processManager.killSession(sessionId);
  if (isRevision && existsSync9(revisionFeedbackPath)) {
    unlinkSync4(revisionFeedbackPath);
  }
  deps.advancePhase(pipeline, "plan");
  await deps.executePhase(pipeline);
}
async function runPlanPhase(pipeline, deps) {
  const logFile = path6.join(pipeline.specPath, "output.log");
  const planLogFile = path6.join(pipeline.specPath, "output-plan.log");
  deps.rotateOutputLog(logFile);
  deps.phaseHeader(logFile, "plan");
  deps.persistAndEmitPhase(pipeline);
  const sessionId = await processManager.createSession(
    deps.sessionOpts("planner", deps.projectRoot, pipeline.taskId, planLogFile)
  );
  pipeline.sessionId = sessionId;
  deps.savePipelineState(pipeline);
  try {
    const sessionMapPath = path6.join(pipeline.specPath, "session_map.json");
    const map = existsSync9(sessionMapPath) ? JSON.parse(readFileSync8(sessionMapPath, "utf-8")) : {};
    map["plan"] = sessionId;
    writeFileSync7(sessionMapPath, JSON.stringify(map, null, 2));
  } catch {
  }
  processManager.sendMessage(sessionId, `/plan ${deps.toAgentPath(pipeline.specPath)}/spec.md`);
  await deps.waitForCompletion(sessionId);
  processManager.killSession(sessionId);
  try {
    deps.gitPush(["pull", "--ff-only", "origin", "master"], path6.join(pipeline.specPath, "output.log"));
  } catch {
  }
  if (!existsSync9(pipeline.worktreePath)) {
    if (path6.resolve(pipeline.worktreePath) === path6.resolve(deps.projectRoot)) {
      throw new Error("Refusing to create worktree at project root \u2014 this would destroy the repository");
    }
    try {
      deps.execGit(["worktree", "add", pipeline.worktreePath, "-b", pipeline.branch], deps.projectRoot);
    } catch {
      if (existsSync9(pipeline.worktreePath)) {
        try {
          rmSync2(pipeline.worktreePath, { recursive: true, force: true });
        } catch {
        }
        try {
          execFileSync5("git", ["worktree", "prune"], { cwd: deps.projectRoot, stdio: "pipe" });
        } catch {
        }
      }
      deps.execGit(["worktree", "add", pipeline.worktreePath, pipeline.branch], deps.projectRoot);
    }
  }
  deps.advancePhase(pipeline, "implement");
  await deps.executePhase(pipeline);
}
async function runMergePhase(pipeline, deps) {
  deps.persistAndEmitPhase(pipeline);
  const logFile = path6.join(pipeline.specPath, "output.log");
  deps.phaseHeader(logFile, "merge");
  const rebaseOk = await rebaseOntoLatestMaster(
    pipeline.worktreePath,
    pipeline.taskId,
    logFile,
    { projectRoot: deps.projectRoot, execGit: deps.execGit, sessionOpts: deps.sessionOpts, waitForCompletion: deps.waitForCompletion }
  );
  if (!rebaseOk) {
    throw new Error(
      "Rebase onto latest master failed with conflicts that could not be resolved. The target branch has likely diverged too far from master. Consider stopping and restarting the task to recreate the worktree from the latest master."
    );
  }
  deps.commitArtifactsToWorktree(pipeline);
  const pipelineConfig = deps.getPipelineConfig();
  if (pipelineConfig.sensors?.pre_merge?.length) {
    const planPath = path6.join(pipeline.specPath, "plan.json");
    let allFiles = [];
    if (existsSync9(planPath)) {
      try {
        const plan = JSON.parse(readFileSync8(planPath, "utf-8"));
        allFiles = (plan.subtasks || []).flatMap((s) => s.files || []);
      } catch {
      }
    }
    const mergeResult = await runSensors(pipelineConfig.sensors.pre_merge, "pre_merge", {
      cwd: pipeline.worktreePath,
      specPath: pipeline.specPath,
      files: allFiles,
      logFile
    });
    appendFileSync7(logFile, sensorRunSummary(mergeResult));
    if (!mergeResult.allPassed) {
      const failMsg = mergeResult.reports.filter((r) => !r.passed).map((r) => r.sensor + ": " + (r.error || "exit " + r.exitCode)).join("; ");
      throw new Error("Pre-merge sensors failed: " + failMsg);
    }
  }
  let mergeSucceeded = false;
  try {
    appendFileSync7(logFile, `[MERGE] Attempting direct merge of ${pipeline.branch} into master
`);
    deps.execGit(["merge", pipeline.branch, "--no-edit"], deps.projectRoot);
    mergeSucceeded = true;
    appendFileSync7(logFile, `[MERGE] Direct merge succeeded \u2014 no conflicts
`);
  } catch {
    try {
      deps.execGit(["merge", "--abort"], deps.projectRoot);
    } catch {
    }
    appendFileSync7(logFile, `[MERGE] Merge had conflicts \u2014 spawning merger agent
`);
  }
  if (!mergeSucceeded) {
    const mergeLogFile = path6.join(pipeline.specPath, "output-merge.log");
    const sessionId = await processManager.createSession(
      deps.sessionOpts("merger", deps.projectRoot, pipeline.taskId, mergeLogFile)
    );
    pipeline.sessionId = sessionId;
    try {
      const sessionMapPath = path6.join(pipeline.specPath, "session_map.json");
      const map = existsSync9(sessionMapPath) ? JSON.parse(readFileSync8(sessionMapPath, "utf-8")) : {};
      map["merge"] = sessionId;
      writeFileSync7(sessionMapPath, JSON.stringify(map, null, 2));
    } catch {
    }
    processManager.sendMessage(sessionId, `/merge ${pipeline.branch}`);
    await deps.waitForCompletion(sessionId);
    processManager.killSession(sessionId);
  }
  deps.removeWorktree(pipeline.taskId);
  deps.advancePhase(pipeline, "done");
}
async function runCreatePRPhase(pipeline, deps) {
  deps.persistAndEmitPhase(pipeline);
  const logFile = path6.join(pipeline.specPath, "output.log");
  const rebaseOk = await rebaseOntoLatestMaster(
    pipeline.worktreePath,
    pipeline.taskId,
    logFile,
    { projectRoot: deps.projectRoot, execGit: deps.execGit, sessionOpts: deps.sessionOpts, waitForCompletion: deps.waitForCompletion }
  );
  if (rebaseOk) {
    appendFileSync7(logFile, "\n[INFO] PR will be conflict-free\n");
  } else {
    appendFileSync7(logFile, "\n[WARN] PR may require manual conflict resolution\n");
  }
  deps.commitArtifactsToWorktree(pipeline);
  deps.gitPush(["push", "-u", "--force", "origin", pipeline.branch], logFile);
  const specContent = readFileSync8(path6.join(pipeline.specPath, "spec.md"), "utf-8");
  const platform = detectGitPlatform(deps.projectRoot);
  let prUrl = checkExistingPRViaCLI(platform, pipeline.branch, deps.projectRoot);
  if (prUrl) {
    appendFileSync7(logFile, `[PR] Open PR already exists for branch ${pipeline.branch}: ${prUrl}
`);
  } else {
    const body = buildPRBody(pipeline.description, specContent);
    prUrl = createPRViaCLI(platform, pipeline.branch, pipeline.description, body, deps.projectRoot, logFile);
    if (!prUrl) {
      prUrl = deps.extractPrUrl(logFile);
    }
  }
  deps.taskStore.update(pipeline.taskId, {
    platform: platform !== "unknown" ? platform : void 0,
    ...prUrl ? { prUrl } : {}
  });
  deps.advancePhase(pipeline, "pr-open", {
    ...prUrl ? { prUrl } : {},
    ...platform !== "unknown" ? { platform } : {}
  });
}
var init_phase_runners = __esm({
  "src/lib/orchestrator/phase-runners.ts"() {
    "use strict";
    init_process_manager();
    init_git_platform();
    init_sensors();
  }
});

// src/lib/providers.ts
import { readFileSync as readFileSync9, existsSync as existsSync10 } from "fs";
import { join as join4 } from "path";
function readDefaultProviders() {
  try {
    const defaultsPath = join4(DEFAULTS_DIR2, "providers.json");
    if (!existsSync10(defaultsPath)) return null;
    return JSON.parse(readFileSync9(defaultsPath, "utf-8"));
  } catch {
    return null;
  }
}
function resolveProvider(projectRoot, role) {
  const cfgPath = join4(projectRoot, ".teamai", "providers.json");
  if (!existsSync10(cfgPath)) {
    const defaults = readDefaultProviders();
    if (defaults) {
      const roleOverride = defaults.roles?.[role] ?? {};
      return { ...defaults.default ?? {}, ...roleOverride };
    }
    return {};
  }
  try {
    const cfg = JSON.parse(readFileSync9(cfgPath, "utf-8"));
    const roleOverride = cfg.roles?.[role] ?? {};
    return { ...cfg.default, ...roleOverride };
  } catch {
    return {};
  }
}
function providerToSessionOpts(cfg) {
  const env = { ...cfg.env ?? {} };
  if (cfg.provider === "bedrock") env["CLAUDE_CODE_USE_BEDROCK"] = "1";
  if (cfg.provider === "vertex") env["CLAUDE_CODE_USE_VERTEX"] = "1";
  if (cfg.provider === "openai") env["OPENAI_API_KEY"] = env["OPENAI_API_KEY"] ?? "";
  if (cfg.provider === "gemini") env["GOOGLE_API_KEY"] = env["GOOGLE_API_KEY"] ?? "";
  if (cfg.provider === "ollama") env["ANTHROPIC_BASE_URL"] = env["ANTHROPIC_BASE_URL"] ?? "http://localhost:11434";
  return {
    model: cfg.model,
    env: Object.keys(env).length ? env : void 0
  };
}
var DEFAULTS_DIR2;
var init_providers = __esm({
  "src/lib/providers.ts"() {
    "use strict";
    DEFAULTS_DIR2 = join4(process.cwd(), "defaults");
  }
});

// src/lib/orchestrator/helpers.ts
import { existsSync as existsSync11, readFileSync as readFileSync10, writeFileSync as writeFileSync8, appendFileSync as appendFileSync8 } from "fs";
import path7 from "path";
function parseSessionLimitReset(line) {
  const m = line.match(/resets\s+(\d+):(\d+)\s*(am|pm)\s*(?:\(UTC\))?/i);
  if (!m) return null;
  let hours = parseInt(m[1], 10);
  const minutes = parseInt(m[2], 10);
  const ampm = m[3].toLowerCase();
  if (ampm === "pm" && hours !== 12) hours += 12;
  if (ampm === "am" && hours === 12) hours = 0;
  const now = /* @__PURE__ */ new Date();
  const reset = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hours, minutes, 0));
  if (reset.getTime() <= Date.now()) reset.setUTCDate(reset.getUTCDate() + 1);
  return Math.floor(reset.getTime() / 1e3);
}
function extractPrUrl(logFile) {
  try {
    if (!existsSync11(logFile)) return null;
    const content = readFileSync10(logFile, "utf-8");
    const patterns = [
      /https?:\/\/github\.com\/[^\s<>"')\]]+\/pull\/\d+/gi,
      /https?:\/\/gitlab\.com\/[^\s<>"')\]]+\/-\/merge_requests\/\d+/gi,
      /https?:\/\/bitbucket\.org\/[^\s<>"')\]]+\/pull-requests\/\d+/gi
    ];
    for (const pattern of patterns) {
      const match = content.match(pattern);
      if (match) return match[0];
    }
  } catch {
  }
  return null;
}
function phaseHeader(logFile, phase) {
  try {
    appendFileSync8(logFile, `
${"\u2500".repeat(40)}
\u25B6 ${phase.toUpperCase()}
${"\u2500".repeat(40)}
`);
  } catch (err) {
    warn("orchestrator", "Failed to write phase header to log file", err);
  }
}
function restoreQaReportFromSnapshot(specPath) {
  const reportPath = path7.join(specPath, "qa_report.json");
  if (existsSync11(reportPath)) return;
  for (const snapName of ["qa_report_before_failed.json", "qa_report_before_bounce.json"]) {
    const snapshotPath = path7.join(specPath, snapName);
    if (existsSync11(snapshotPath)) {
      try {
        const snapshot = readFileSync10(snapshotPath, "utf-8");
        writeFileSync8(reportPath, snapshot);
        const logFile = path7.join(specPath, "output.log");
        appendFileSync8(logFile, `
[GUARD] Restored qa_report.json from ${snapName} \u2014 file was deleted
`);
        break;
      } catch {
      }
    }
  }
}
function restoreHumanFeedbackFromSnapshot(specPath) {
  const feedbackPath = path7.join(specPath, "human_feedback.md");
  if (existsSync11(feedbackPath)) return;
  const snapshotPath = path7.join(specPath, "human_feedback_before_bounce.md");
  if (existsSync11(snapshotPath)) {
    try {
      const snapshot = readFileSync10(snapshotPath, "utf-8");
      writeFileSync8(feedbackPath, snapshot);
      const logFile = path7.join(specPath, "output.log");
      appendFileSync8(logFile, `
[GUARD] Restored human_feedback.md from human_feedback_before_bounce.md \u2014 file was deleted
`);
    } catch {
    }
  }
}
function getWorktreeBase(projectRoot) {
  return readContainerConfig(projectRoot).enabled ? path7.join(projectRoot, ".worktrees") : path7.join(projectRoot, "..", "worktrees");
}
function computePipelineConfig(projectRoot) {
  const cfgPath = path7.join(projectRoot, ".teamai", "pipeline.json");
  if (existsSync11(cfgPath)) {
    try {
      const raw = JSON.parse(readFileSync10(cfgPath, "utf-8"));
      const sensors = readPipelineSensors(raw);
      return {
        maxQaAttempts: typeof raw.maxQaAttempts === "number" ? raw.maxQaAttempts : 3,
        parallelSubtasks: typeof raw.parallelSubtasks === "boolean" ? raw.parallelSubtasks : true,
        maxDeliverableFails: typeof raw.maxDeliverableFails === "number" ? raw.maxDeliverableFails : 3,
        maxWakeupAttempts: typeof raw.maxWakeupAttempts === "number" ? raw.maxWakeupAttempts : 3,
        demo: typeof raw.demo === "boolean" ? raw.demo : void 0,
        ...sensors ? { sensors } : {}
      };
    } catch (err) {
      warn("orchestrator", "Failed to parse pipeline config, using defaults", err);
    }
  }
  return { maxQaAttempts: 3, parallelSubtasks: true, maxDeliverableFails: 3, maxWakeupAttempts: 3 };
}
function buildSessionOpts(projectRoot, role, cwd, taskId, logFile) {
  const providerCfg = resolveProvider(projectRoot, role);
  const providerOpts = providerToSessionOpts(providerCfg);
  return { taskId, role, cwd, ...containerSessionOpts(projectRoot), logFile, ...providerOpts };
}
var init_helpers = __esm({
  "src/lib/orchestrator/helpers.ts"() {
    "use strict";
    init_logger();
    init_container_manager();
    init_providers();
    init_process_manager();
    init_sensors();
  }
});

// src/lib/orchestrator/worktree-ops.ts
import { execFileSync as execFileSync6 } from "child_process";
import { existsSync as existsSync12, readdirSync as readdirSync3, rmSync as rmSync3 } from "fs";
import path8 from "path";
function getWorktreePath(taskId, taskStore, worktreeBase) {
  const task = taskStore.getById(taskId);
  if (!task || !task.branch) return null;
  const slug = slugify(task.description);
  return path8.join(worktreeBase, slug);
}
function cleanStaleSubtaskWorktrees(pipeline, deps) {
  const slug = path8.basename(pipeline.worktreePath);
  const prefix = slug + "-st";
  const worktreeBase = getWorktreeBase(deps.projectRoot);
  if (!existsSync12(worktreeBase)) return;
  let entries;
  try {
    entries = readdirSync3(worktreeBase, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.name.startsWith(prefix)) continue;
    if (!entry.name.slice(prefix.length).match(/^\d+$/)) continue;
    const stPath = path8.join(worktreeBase, entry.name);
    const stBranch = pipeline.branch + entry.name.slice(slug.length);
    try {
      deps.execGit(["worktree", "remove", "--force", stPath], deps.projectRoot);
    } catch {
      try {
        rmSync3(stPath, { recursive: true, force: true });
      } catch {
      }
      try {
        execFileSync6("git", ["worktree", "prune"], { cwd: deps.projectRoot, stdio: "pipe" });
      } catch {
      }
    }
    try {
      execFileSync6("git", ["branch", "-D", stBranch], { cwd: deps.projectRoot, stdio: "pipe" });
    } catch {
    }
  }
}
function removeWorktree(taskId, deps) {
  const worktreeBase = getWorktreeBase(deps.projectRoot);
  const wtPath = getWorktreePath(taskId, deps.taskStore, worktreeBase);
  if (!wtPath || !existsSync12(wtPath)) return;
  try {
    deps.execGit(["worktree", "remove", wtPath], deps.projectRoot);
  } catch {
    try {
      deps.execGit(["worktree", "remove", "--force", wtPath], deps.projectRoot);
    } catch {
      try {
        rmSync3(wtPath, { recursive: true, force: true });
      } catch {
      }
      try {
        execFileSync6("git", ["worktree", "prune"], { cwd: deps.projectRoot, stdio: "pipe" });
      } catch {
      }
    }
  }
  const task = deps.taskStore.getById(taskId);
  if (task?.branch) {
    try {
      execFileSync6("git", ["branch", "-D", task.branch], { cwd: deps.projectRoot, stdio: "pipe" });
    } catch {
    }
  }
  deps.taskStore.update(taskId, { branch: void 0 });
}
function cleanWorktree(taskId, deps) {
  const worktreeBase = getWorktreeBase(deps.projectRoot);
  const wtPath = getWorktreePath(taskId, deps.taskStore, worktreeBase);
  if (!wtPath || !existsSync12(wtPath)) return;
  try {
    deps.execGit(["checkout", "HEAD", "--", "."], wtPath);
  } catch {
  }
}
var init_worktree_ops = __esm({
  "src/lib/orchestrator/worktree-ops.ts"() {
    "use strict";
    init_utils();
    init_helpers();
  }
});

// src/lib/orchestrator/artifact-commit.ts
import { execFileSync as execFileSync7 } from "child_process";
import { existsSync as existsSync13, readFileSync as readFileSync11, writeFileSync as writeFileSync9, appendFileSync as appendFileSync9, mkdirSync as mkdirSync4, copyFileSync, readdirSync as readdirSync4 } from "fs";
import path9 from "path";
function copyArtifactsRecursive(sourceDir, destDir, logFile) {
  let count = 0;
  const entries = readdirSync4(sourceDir, { withFileTypes: true });
  for (const entry of entries) {
    if (ARTIFACT_EXCLUDE.has(entry.name)) continue;
    const srcPath = path9.join(sourceDir, entry.name);
    const destPath = path9.join(destDir, entry.name);
    if (entry.isDirectory()) {
      mkdirSync4(destPath, { recursive: true });
      const subCount = copyArtifactsRecursive(srcPath, destPath, logFile);
      if (subCount > 0) {
        appendFileSync9(logFile, `[ARTIFACTS] Copied directory ${entry.name}/ (${subCount} file(s))
`);
        count += subCount;
      }
    } else if (entry.isFile()) {
      copyFileSync(srcPath, destPath);
      count++;
    }
  }
  return count;
}
function commitArtifactsToWorktree(pipeline, deps) {
  const logFile = path9.join(pipeline.specPath, "output.log");
  phaseHeader(logFile, "artifacts \u2014 commit to worktree");
  const slug = path9.basename(pipeline.specPath);
  const targetDir = path9.join(pipeline.worktreePath, ".teamai", slug);
  if (!existsSync13(targetDir)) {
    mkdirSync4(targetDir, { recursive: true });
  }
  const sourceDir = pipeline.specPath;
  let copied = 0;
  if (existsSync13(sourceDir)) {
    copied = copyArtifactsRecursive(sourceDir, targetDir, logFile);
  }
  const committedTaskJson = path9.join(targetDir, "task.json");
  if (existsSync13(committedTaskJson)) {
    try {
      const t = JSON.parse(readFileSync11(committedTaskJson, "utf-8"));
      t.phase = "done";
      t.updatedAt = (/* @__PURE__ */ new Date()).toISOString();
      writeFileSync9(committedTaskJson, JSON.stringify(t, null, 2));
    } catch {
    }
  }
  if (copied === 0) {
    appendFileSync9(logFile, "[ARTIFACTS] No artifacts to commit\n");
    return;
  }
  deps.restoreWorktreeGitFileToHostPaths(pipeline.worktreePath);
  const gitEnv = deps.worktreeGitEnv(pipeline.worktreePath);
  const gitOpts = Object.keys(gitEnv).length ? { cwd: pipeline.worktreePath, env: { ...process.env, ...gitEnv } } : { cwd: pipeline.worktreePath };
  execFileSync7("git", ["add", "-f", `.teamai/${slug}`], gitOpts);
  try {
    execFileSync7("git", ["commit", "-m", `Add TeamAI pipeline artifacts for "${pipeline.description}"`], gitOpts);
  } catch (gitErr) {
    const msg = gitErr instanceof Error ? gitErr.message : String(gitErr);
    if (/nothing\s+to\s+commit.*working\s+tree\s+clean/i.test(msg)) {
      appendFileSync9(logFile, "[ARTIFACTS] Already committed \u2014 no new changes\n");
      return;
    }
    if (/nothing\s+added\s+to\s+commit/i.test(msg)) {
      appendFileSync9(logFile, "[ARTIFACTS] Warning: .teamai/ appears to be gitignored \u2014 skipping artifact commit\n");
      return;
    }
    throw gitErr;
  }
  appendFileSync9(logFile, `[ARTIFACTS] Committed ${copied} artifact file(s) to worktree
`);
}
var ARTIFACT_EXCLUDE;
var init_artifact_commit = __esm({
  "src/lib/orchestrator/artifact-commit.ts"() {
    "use strict";
    init_helpers();
    ARTIFACT_EXCLUDE = /* @__PURE__ */ new Set([
      "output.log",
      ".pipeline_state.json"
    ]);
  }
});

// src/lib/orchestrator/git-push.ts
import { execFileSync as execFileSync8 } from "child_process";
import { appendFileSync as appendFileSync10 } from "fs";
function gitPush(projectRoot, pushArgs, logFile) {
  const noPromptEnv = { ...process.env, GIT_TERMINAL_PROMPT: "0" };
  const _getToken = () => {
    try {
      return execFileSync8("gh", ["auth", "token"], { encoding: "utf-8", stdio: "pipe" }).trim();
    } catch {
      return "";
    }
  };
  const token = _getToken();
  let _remoteUrl = null;
  let _remoteIdx = -1;
  if (token) {
    try {
      for (let i = 1; i < pushArgs.length; i++) {
        if (!pushArgs[i].startsWith("-")) {
          _remoteIdx = i;
          _remoteUrl = execFileSync8("git", ["remote", "get-url", pushArgs[i]], {
            encoding: "utf-8",
            stdio: "pipe",
            cwd: projectRoot
          }).trim();
          break;
        }
      }
    } catch {
    }
  }
  const _buildInjectedArgs = (t) => {
    if (!t || _remoteIdx < 0 || !_remoteUrl?.startsWith("https://")) return null;
    const encoded = Buffer.from(`x-access-token:${t}`).toString("base64");
    return ["-c", `http.extraheader=Authorization: Basic ${encoded}`, ...pushArgs];
  };
  const AUTH_RE = /invalid username or token|authentication failed|http basic: access denied|returned error: 401\b/i;
  const _exec = (t, attempt) => {
    const args = _buildInjectedArgs(t) ?? pushArgs;
    try {
      execFileSync8("git", args, { cwd: projectRoot, stdio: "pipe", env: noPromptEnv });
    } catch (err) {
      const raw = err instanceof Error ? err.message : String(err);
      const safe = t ? raw.replaceAll(t, "[REDACTED]") : raw;
      if (attempt === 0 && t && AUTH_RE.test(raw)) {
        appendFileSync10(
          logFile,
          "[GIT] gh token rejected by remote \u2014 attempting gh auth refresh\n"
        );
        let freshToken = null;
        try {
          const hostname = _remoteUrl ? new URL(_remoteUrl).hostname : "github.com";
          execFileSync8("gh", ["auth", "refresh", "-s", "repo", "--hostname", hostname], {
            encoding: "utf-8",
            stdio: "pipe",
            timeout: 3e4
          });
          freshToken = _getToken();
        } catch (refreshErr) {
          const refreshMsg = refreshErr instanceof Error ? refreshErr.message : String(refreshErr);
          appendFileSync10(logFile, `[GIT] gh auth refresh failed: ${refreshMsg}
`);
        }
        if (freshToken) {
          appendFileSync10(logFile, "[GIT] Token refreshed \u2014 retrying\n");
          _exec(freshToken, 1);
          return;
        }
      }
      if (attempt <= 1 && t && AUTH_RE.test(raw)) {
        appendFileSync10(
          logFile,
          "[GIT] gh token rejected \u2014 falling back to system credential helper\n"
        );
        _exec("", 2);
        return;
      }
      throw new Error(safe);
    }
  };
  if (token) {
    appendFileSync10(logFile, "[GIT] Using gh OAuth token via http.extraheader\n");
  } else {
    appendFileSync10(
      logFile,
      "[GIT] gh token not available \u2014 falling back to default credential helper\n"
    );
  }
  _exec(token, 0);
}
var init_git_push = __esm({
  "src/lib/orchestrator/git-push.ts"() {
    "use strict";
  }
});

// src/lib/orchestrator/rate-limit.ts
import { appendFileSync as appendFileSync11 } from "fs";
import path10 from "path";
function waitForCompletion(sessionId, deps) {
  return new Promise((resolve, reject) => {
    let rateLimitResetsAt = null;
    let sessionLimitResetsAt = null;
    const cleanup = () => {
      processManager.off("event", onEvent);
      processManager.off("exit", onExit);
      processManager.off("raw", onRaw);
    };
    const onRaw = ({ sessionId: sid, data }) => {
      if (sid !== sessionId) return;
      if (/session.?limit/i.test(data)) {
        sessionLimitResetsAt = deps.parseSessionLimitReset(data) ?? Math.floor(Date.now() / 1e3) + 3600;
      }
    };
    const onEvent = ({ sessionId: sid, event }) => {
      if (sid !== sessionId) return;
      if (event.type === "rate_limit_event" && event.rate_limit_info) {
        const info = event.rate_limit_info;
        if (info.status !== "allowed" && info.resetsAt) {
          rateLimitResetsAt = info.resetsAt;
        }
      }
      if (event.type === "result") {
        cleanup();
        if (sessionLimitResetsAt) {
          reject(new RateLimitError(sessionLimitResetsAt));
        } else if (event.is_error && rateLimitResetsAt) {
          reject(new RateLimitError(rateLimitResetsAt));
        } else {
          resolve();
        }
      }
    };
    const onExit = ({ sessionId: sid, code }) => {
      if (sid !== sessionId) return;
      cleanup();
      if (sessionLimitResetsAt) reject(new RateLimitError(sessionLimitResetsAt));
      else if (code === 0 || code === null) resolve();
      else if (rateLimitResetsAt) reject(new RateLimitError(rateLimitResetsAt));
      else reject(new Error(`Session exited with code ${code}`));
    };
    processManager.on("event", onEvent);
    processManager.on("exit", onExit);
    processManager.on("raw", onRaw);
  });
}
function handleRateLimit(pipeline, resetsAt, deps) {
  const resetsAtMs = resetsAt * 1e3;
  const MAX_DELAY_MS = 2147483647;
  const rawWaitMs = Math.max(resetsAtMs - Date.now(), 0);
  const waitMs = Math.min(rawWaitMs, MAX_DELAY_MS);
  const resetsAtISO = new Date(resetsAtMs).toISOString();
  deps.taskStore.update(pipeline.taskId, { rateLimitedUntil: resetsAtISO });
  deps.activeTasks.add(pipeline.taskId);
  deps.pipelines.set(pipeline.taskId, pipeline);
  processManager.emit("phase-change", {
    taskId: pipeline.taskId,
    phase: pipeline.phase,
    projectRoot: deps.projectRoot,
    rateLimitedUntil: resetsAtISO
  });
  const mins = Math.ceil(waitMs / 6e4);
  console.log(`[rate-limit] Task ${pipeline.taskId} paused for ~${mins}min. Resuming at ${resetsAtISO}`);
  setTimeout(async () => {
    const task = deps.taskStore.getById(pipeline.taskId);
    if (!task || NO_RESUME_PHASES.has(task.phase)) {
      console.log(`[rate-limit] Task ${pipeline.taskId} is in terminal phase "${task?.phase}" \u2014 skipping resume`);
      deps.taskStore.update(pipeline.taskId, { rateLimitedUntil: void 0 });
      deps.pipelines.delete(pipeline.taskId);
      deps.activeTasks.delete(pipeline.taskId);
      return;
    }
    const currentPipeline = deps.pipelines.get(pipeline.taskId);
    if (currentPipeline !== pipeline) {
      console.log(`[rate-limit] Task ${pipeline.taskId} pipeline was replaced \u2014 skipping stale resume`);
      deps.taskStore.update(pipeline.taskId, { rateLimitedUntil: void 0 });
      return;
    }
    console.log(`[rate-limit] Resuming task ${pipeline.taskId}`);
    deps.taskStore.update(pipeline.taskId, { rateLimitedUntil: void 0 });
    let wasRateLimited = false;
    try {
      await deps.executePhase(pipeline);
    } catch (e) {
      if (e instanceof RateLimitError) {
        wasRateLimited = true;
        deps.handleRateLimit(pipeline, e.resetsAt);
      } else {
        const errMsg = e instanceof Error ? `${e.message}
${e.stack ?? ""}` : String(e);
        appendFileSync11(
          path10.join(pipeline.specPath, "output.log"),
          `
[ERROR] Task failed after rate-limit retry: ${errMsg}
`
        );
        console.error(`[orchestrator] Task ${pipeline.taskId} failed after rate-limit retry:`, e);
        deps.advancePhase(pipeline, "failed");
      }
    } finally {
      if (!wasRateLimited) {
        deps.pipelines.delete(pipeline.taskId);
        deps.activeTasks.delete(pipeline.taskId);
      }
    }
  }, waitMs);
}
var RateLimitError, NO_RESUME_PHASES;
var init_rate_limit = __esm({
  "src/lib/orchestrator/rate-limit.ts"() {
    "use strict";
    init_process_manager();
    RateLimitError = class extends Error {
      constructor(resetsAt) {
        super(`Rate limited until ${new Date(resetsAt * 1e3).toISOString()}`);
        this.resetsAt = resetsAt;
      }
    };
    NO_RESUME_PHASES = /* @__PURE__ */ new Set(["backlog", "done", "failed", "awaiting-review", "pr-open"]);
  }
});

// src/lib/orchestrator/implement.ts
import { execFileSync as execFileSync9 } from "child_process";
import { readFileSync as readFileSync12, writeFileSync as writeFileSync10, existsSync as existsSync14, appendFileSync as appendFileSync12, unlinkSync as unlinkSync5, renameSync as renameSync4, rmSync as rmSync4 } from "fs";
import path11 from "path";
async function runImplement(pipeline, deps) {
  deps.persistAndEmitPhase(pipeline);
  const containerCfg = readContainerConfig(deps.projectRoot);
  if (containerCfg.enabled && !containerCfg.explicit) {
    _resetDockerAvailableCache();
    if (!dockerAvailable()) {
      throw new Error("Docker is not running. Start Docker Desktop and move the task back to In Progress to retry.");
    }
  }
  deps.restoreQaReportFromSnapshot(pipeline.specPath);
  deps.restoreHumanFeedbackFromSnapshot(pipeline.specPath);
  try {
    deps.gitPush(["pull", "--ff-only", "origin", "master"], path11.join(pipeline.specPath, "output.log"));
  } catch {
  }
  if (!existsSync14(pipeline.worktreePath) || !deps.isWorktreeHealthy(pipeline.worktreePath)) {
    if (existsSync14(pipeline.worktreePath)) {
      if (path11.resolve(pipeline.worktreePath) === path11.resolve(deps.projectRoot)) {
        throw new Error("Refusing to remove worktree at project root \u2014 this would destroy the repository");
      }
      try {
        deps.execGit(["worktree", "remove", "--force", pipeline.worktreePath], deps.projectRoot);
      } catch {
      }
      if (existsSync14(pipeline.worktreePath)) {
        try {
          rmSync4(pipeline.worktreePath, { recursive: true, force: true });
        } catch {
        }
        try {
          execFileSync9("git", ["worktree", "prune"], { cwd: deps.projectRoot, stdio: "pipe" });
        } catch {
        }
      }
    }
    try {
      deps.execGit(["worktree", "add", pipeline.worktreePath, "-b", pipeline.branch], deps.projectRoot);
    } catch {
      deps.execGit(["worktree", "add", pipeline.worktreePath, pipeline.branch], deps.projectRoot);
    }
  }
  if (readContainerConfig(deps.projectRoot).enabled) {
    const earlyLog = path11.join(pipeline.specPath, "output.log");
    const containerInfo = await containerManager.ensureContainer(deps.projectRoot, earlyLog);
    deps.patchWorktreeGitFile(pipeline.worktreePath, containerInfo.remoteWorkspaceFolder);
  }
  const implementLog = path11.join(pipeline.specPath, "output.log");
  await rebaseOntoLatestMaster(
    pipeline.worktreePath,
    pipeline.taskId,
    implementLog,
    {
      projectRoot: deps.projectRoot,
      execGit: deps.execGit,
      sessionOpts: deps.sessionOpts,
      waitForCompletion: deps.waitForCompletion
    }
  );
  deps.cleanStaleSubtaskWorktrees(pipeline);
  const planPath = path11.join(pipeline.specPath, "plan.json");
  const plan = JSON.parse(readFileSync12(planPath, "utf-8"));
  const coderRole = "coder";
  const qaFeedbackPath = path11.join(pipeline.specPath, "qa_feedback.md");
  const humanFeedbackPath = path11.join(pipeline.specPath, "human_feedback.md");
  const hasQaFeedback = existsSync14(qaFeedbackPath);
  const hasHumanFeedback = existsSync14(humanFeedbackPath);
  if (hasHumanFeedback) {
    const snapshotPath = path11.join(pipeline.specPath, "human_feedback_before_bounce.md");
    if (!existsSync14(snapshotPath)) {
      try {
        writeFileSync10(snapshotPath, readFileSync12(humanFeedbackPath, "utf-8"));
      } catch {
      }
    }
  }
  const subtasksToRun = hasQaFeedback ? plan.subtasks.filter((s) => s.qa_flagged) : plan.subtasks.filter((s) => !s.completed);
  let effectiveSubtasks;
  if (hasQaFeedback && subtasksToRun.length === 0) {
    const allFiles = [...new Set(
      plan.subtasks.flatMap((s) => s.files ?? [])
    )];
    let qaContent = "";
    try {
      qaContent = readFileSync12(qaFeedbackPath, "utf-8");
    } catch {
    }
    const logFile2 = path11.join(pipeline.specPath, "output.log");
    appendFileSync12(logFile2, "\n[QA-FALLBACK] Criterion matching flagged no subtasks \u2014 synthesising targeted rework subtask from qa_feedback.md\n");
    effectiveSubtasks = [{
      id: 9999,
      title: "QA Rework: fix failing criteria (criterion matching found no flagged subtasks)",
      description: buildSyntheticReworkDescription(qaContent),
      files: allFiles,
      depends_on: [],
      acceptance_criteria: ["All criteria listed in the QA feedback above are satisfied"],
      parallel_group: "QA-REWORK",
      qa_flagged: true,
      completed: false
    }];
  } else {
    effectiveSubtasks = subtasksToRun;
  }
  if (pipeline.wakeupSubtaskId != null) {
    effectiveSubtasks = effectiveSubtasks.filter((s) => s.id === pipeline.wakeupSubtaskId);
  }
  if (!hasQaFeedback && effectiveSubtasks.length === 0 && plan.subtasks.length > 0) {
    const logFile2 = path11.join(pipeline.specPath, "output.log");
    appendFileSync12(logFile2, "\n[SKIP] All subtasks already completed \u2014 skipping implement, advancing to QA review\n");
    deps.advancePhase(pipeline, "qa-review");
    await deps.executePhase(pipeline);
    return;
  }
  if (hasQaFeedback) {
    for (const s of effectiveSubtasks) s.completed = false;
  }
  const groups = /* @__PURE__ */ new Map();
  for (const subtask of effectiveSubtasks) {
    const group = subtask.parallel_group || String(subtask.id);
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group).push(subtask);
  }
  const logFile = path11.join(pipeline.specPath, "output.log");
  const sessionMapPath = path11.join(pipeline.specPath, "session_map.json");
  for (const [, subtasks] of groups) {
    const completedIds = [];
    const isMultiGroup = subtasks.length >= 2;
    const subtaskWorktrees = /* @__PURE__ */ new Map();
    let containerWorkspace;
    if (isMultiGroup) {
      if (readContainerConfig(deps.projectRoot).enabled) {
        const info = containerManager.getRunningContainer(deps.projectRoot);
        containerWorkspace = info?.remoteWorkspaceFolder || void 0;
      }
      for (const subtask of subtasks) {
        const stWorktreePath = pipeline.worktreePath + "-st" + subtask.id;
        const stBranch = pipeline.branch + "-st" + subtask.id;
        try {
          deps.execGit(["worktree", "remove", "--force", stWorktreePath], deps.projectRoot);
        } catch {
        }
        if (existsSync14(stWorktreePath)) {
          try {
            rmSync4(stWorktreePath, { recursive: true, force: true });
          } catch {
          }
          try {
            execFileSync9("git", ["worktree", "prune"], { cwd: deps.projectRoot, stdio: "pipe" });
          } catch {
          }
        }
        try {
          execFileSync9("git", ["branch", "-D", stBranch], { cwd: deps.projectRoot, stdio: "pipe" });
        } catch {
        }
        deps.execGit(["worktree", "add", stWorktreePath, "-b", stBranch, pipeline.branch], deps.projectRoot);
        if (containerWorkspace) {
          deps.patchWorktreeGitFile(stWorktreePath, containerWorkspace);
        }
        subtaskWorktrees.set(subtask.id, stWorktreePath);
        appendFileSync12(logFile, "\n[WORKTREE] Created isolated worktree for subtask " + subtask.id + " at " + stWorktreePath + "\n");
      }
    }
    let retainWorktrees = false;
    const scopeViolations = /* @__PURE__ */ new Set();
    const sessionMapLock = { current: Promise.resolve() };
    try {
      const results = await Promise.allSettled(
        subtasks.map(async (subtask) => {
          deps.phaseHeader(logFile, "implement \u2014 subtask " + subtask.id + ": " + subtask.title);
          const cwd = isMultiGroup ? subtaskWorktrees.get(subtask.id) : pipeline.worktreePath;
          try {
            const pipelineConfig = deps.getPipelineConfig();
            if (pipelineConfig.sensors?.pre_subtask?.length) {
              const preResult = await runSensors(pipelineConfig.sensors.pre_subtask, "pre_subtask", {
                cwd,
                specPath: pipeline.specPath,
                files: subtask.files || [],
                subtaskId: subtask.id,
                logFile
              });
              if (!preResult.allPassed) appendFileSync12(logFile, sensorRunSummary(preResult));
            }
          } catch (preSensorErr) {
            const msg = preSensorErr instanceof Error ? preSensorErr.message : String(preSensorErr);
            appendFileSync12(logFile, "\n[SENSOR:pre_subtask] pre-subtask sensors failed (non-blocking): " + msg + "\n");
          }
          const subtaskLogFile = path11.join(pipeline.specPath, `output-st${subtask.id}.log`);
          let sessionId;
          try {
            sessionId = await processManager.createSession(deps.sessionOpts(coderRole, cwd, pipeline.taskId, subtaskLogFile));
            sessionMapLock.current = sessionMapLock.current.then(() => {
              try {
                const map = existsSync14(sessionMapPath) ? JSON.parse(readFileSync12(sessionMapPath, "utf-8")) : {};
                map[String(subtask.id)] = sessionId;
                writeFileSync10(sessionMapPath, JSON.stringify(map, null, 2));
              } catch {
              }
            });
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            appendFileSync12(logFile, "\n[ERROR] Session creation failed for subtask " + subtask.id + ": " + msg + "\n");
            throw err;
          }
          const qaOnlyCriteria = hasQaFeedback ? subtask.acceptance_criteria.filter((ac) => ac.includes("[QA CORRECTION") || ac.includes("[QA ISSUE")) : subtask.acceptance_criteria;
          const criteriaLine = hasQaFeedback ? qaOnlyCriteria.length > 0 ? "QA issues to fix: " + qaOnlyCriteria.join("; ") : "No specific QA criteria for this subtask \u2014 see the QA feedback above for issues to address." : "Acceptance criteria: " + subtask.acceptance_criteria.join("; ");
          const subtaskFeedback = buildSubtaskFeedback(hasQaFeedback, qaOnlyCriteria, subtask, pipeline.specPath, humanFeedbackPath, hasHumanFeedback);
          const wasWakeupReentry = pipeline.wakeupSubtaskId === subtask.id;
          let wakeupHeader = "";
          if (!hasQaFeedback && pipeline.wakeupSubtaskId === subtask.id) {
            wakeupHeader = "\u26A0\uFE0F WAKEUP RE-ENTRY\n\nYour previous session was paused to wait for a background process.\nBackground command: " + (pipeline.wakeupCommand || "unknown") + "\nExpected artifact to verify: " + (pipeline.wakeupArtifact || "unknown") + "\n\nCheck if the artifact exists and is complete. If it is: verify it, git add, commit,\nand mark the subtask done. If it's missing or incomplete, first check whether the\nbackground process is still running:\n- If the process is still running: estimate remaining time, write an updated\n  subtask_wakeup.json with a new wakeup_at, and end.\n- If the process has crashed or exited with an error: do NOT write another wakeup\n  file. Report the failure immediately so the task can advance to failed without\n  wasting the remaining wakeup attempts.\n\n";
          }
          let deliverableHeader = "";
          if (!hasQaFeedback && !wakeupHeader && pipeline.deliverableFailCounts?.[subtask.id]) {
            const attemptCount = pipeline.deliverableFailCounts[subtask.id];
            const maxFails = deps.getPipelineConfig().maxDeliverableFails;
            deliverableHeader = "\u26A0\uFE0F DELIVERABLE RE-VERIFICATION (attempt " + attemptCount + "/" + maxFails + ")\n\nYour previous session for this subtask ended but the following required\ndeliverable files were NOT created:\n\n" + (subtask.files_to_create?.map((f) => "  - " + f).join("\n") || "") + "\n\nYou MUST create these files before ending your session. If you cannot\ncreate them (e.g., the task is impossible with the current spec), explain\nwhy and the orchestrator will advance the task to failed.\n\n";
          }
          const promptHeader = wakeupHeader || deliverableHeader;
          const prompt = promptHeader + (subtaskFeedback ? subtaskFeedback + "\n---\n" : "") + "/implement Subtask " + subtask.id + ": " + subtask.title + "\n\n" + subtask.description + "\n\nFiles: " + subtask.files.join(", ") + "\n\n" + criteriaLine + "\nPROJECT_ROOT=" + deps.projectRoot + "\n\n" + (hasQaFeedback ? "\u26A0\uFE0F Only fix the QA issues listed above. Do NOT re-validate criteria that QA already passed.\nAfter fixing all issues, run the FULL test suite to verify no regressions.\n" : "");
          let preSessionHead = "";
          try {
            preSessionHead = execFileSync9("git", ["rev-parse", "HEAD"], {
              cwd,
              encoding: "utf-8",
              stdio: "pipe"
            }).trim();
          } catch {
          }
          processManager.sendMessage(sessionId, prompt);
          await deps.waitForCompletion(sessionId);
          processManager.killSession(sessionId);
          if (preSessionHead) {
            try {
              const changedFiles = execFileSync9("git", ["diff", "--name-only", preSessionHead + "..HEAD"], {
                cwd,
                encoding: "utf-8",
                stdio: "pipe"
              }).trim().split("\n").filter(Boolean);
              const assignedFiles = new Set(subtask.files || []);
              const violations = changedFiles.filter((f) => !assignedFiles.has(f));
              if (violations.length > 0) {
                scopeViolations.add(subtask.id);
                appendFileSync12(
                  logFile,
                  "\n[SCOPE] Subtask " + subtask.id + " modified files outside its assigned scope:\n" + violations.map((f) => "  - " + f).join("\n") + "\n[SCOPE] Assigned files: " + ((subtask.files || []).join(", ") || "(none)") + "\n"
                );
              }
            } catch (scopeErr) {
              const scopeMsg = scopeErr instanceof Error ? scopeErr.message : String(scopeErr);
              appendFileSync12(logFile, "\n[SCOPE] Could not verify file scope (git diff failed: " + scopeMsg + ")\n");
            }
          }
          let wakeupDetected = false;
          if (!hasQaFeedback) {
            const wakeupPath = path11.join(pipeline.specPath, "subtask_wakeup.json");
            if (existsSync14(wakeupPath)) {
              try {
                const wd = JSON.parse(readFileSync12(wakeupPath, "utf-8"));
                if (wd.subtask_id != null && wd.wakeup_at) {
                  pipeline.wakeupSubtaskId = wd.subtask_id;
                  pipeline.wakeupUntil = wd.wakeup_at;
                  pipeline.wakeupCommand = wd.background_command;
                  pipeline.wakeupArtifact = wd.expected_artifact;
                  pipeline.wakeupAttemptCount = (pipeline.wakeupAttemptCount || 0) + 1;
                  wakeupDetected = true;
                  appendFileSync12(logFile, "[WAKEUP] Subtask " + wd.subtask_id + " wakeup scheduled for " + wd.wakeup_at + " (attempt " + pipeline.wakeupAttemptCount + ") \u2014 background process: " + (wd.background_command || "unknown") + "\n");
                }
              } catch {
                appendFileSync12(logFile, "[WAKEUP] Malformed subtask_wakeup.json \u2014 treating as missing\n");
              }
              try {
                unlinkSync5(wakeupPath);
              } catch {
              }
            }
          }
          let skipCompletion = false;
          const hasWakeup = pipeline.wakeupSubtaskId != null;
          if (!hasWakeup && subtask.files_to_create?.length) {
            for (const file of subtask.files_to_create) {
              if (!existsSync14(path11.join(cwd, file))) {
                skipCompletion = true;
                appendFileSync12(logFile, "\n[VERIFY] Subtask " + subtask.id + ": expected file/directory missing \u2014 " + file + "\n");
              }
            }
            if (skipCompletion) {
              if (!pipeline.deliverableFailCounts) pipeline.deliverableFailCounts = {};
              const maxFails = deps.getPipelineConfig().maxDeliverableFails;
              const count = (pipeline.deliverableFailCounts[subtask.id] || 0) + 1;
              pipeline.deliverableFailCounts[subtask.id] = count;
              const missingFiles = subtask.files_to_create.filter((f) => !existsSync14(path11.join(cwd, f))).join(", ");
              appendFileSync12(logFile, "[VERIFY] Subtask " + subtask.id + " failed deliverable verification (attempt " + count + "/" + maxFails + ") \u2014 missing: " + missingFiles + "\n");
              if (count >= maxFails) {
                const reportPath = path11.join(pipeline.specPath, "qa_report.json");
                writeFileSync10(reportPath, JSON.stringify({
                  overall: "FAIL",
                  criteria: [{
                    criterion: "Deliverable verification \u2014 missing files",
                    name: "Deliverable verification",
                    status: "FAIL",
                    notes: "Subtask " + subtask.id + " failed deliverable verification " + maxFails + " times. Missing files: " + missingFiles
                  }]
                }, null, 2));
                appendFileSync12(logFile, "[VERIFY] Subtask " + subtask.id + " exceeded deliverable verification cap (" + maxFails + ") \u2014 advancing to failed\n");
                deps.advancePhase(pipeline, "failed");
                return;
              }
            }
          }
          if (wakeupDetected) {
            skipCompletion = true;
          }
          if (!skipCompletion) {
            if (scopeViolations.has(subtask.id)) {
              skipCompletion = true;
              appendFileSync12(logFile, "[SCOPE] Subtask " + subtask.id + " rejected \u2014 will re-run with scope enforcement\n");
            } else {
              if (pipeline.deliverableFailCounts?.[subtask.id] !== void 0) {
                delete pipeline.deliverableFailCounts[subtask.id];
              }
              completedIds.push(subtask.id);
            }
          }
          if (wasWakeupReentry && !wakeupDetected && !skipCompletion) {
            pipeline.wakeupUntil = void 0;
            pipeline.wakeupSubtaskId = void 0;
            pipeline.wakeupCommand = void 0;
            pipeline.wakeupArtifact = void 0;
            pipeline.wakeupAttemptCount = 0;
            pipeline._wakeupJustCompleted = true;
            appendFileSync12(logFile, "[WAKEUP] Subtask " + subtask.id + " completed after wakeup \u2014 clearing wakeup state\n");
            return;
          }
          try {
            const pipelineConfig = deps.getPipelineConfig();
            if (pipelineConfig.sensors?.post_subtask?.length) {
              const postResult = await runSensors(pipelineConfig.sensors.post_subtask, "post_subtask", {
                cwd,
                specPath: pipeline.specPath,
                files: subtask.files || [],
                subtaskId: subtask.id,
                logFile
              });
              appendFileSync12(logFile, sensorRunSummary(postResult));
              if (!postResult.allPassed) {
                const sensorReportPath = path11.join(pipeline.specPath, "sensor_report-st" + subtask.id + ".json");
                const failMsg = postResult.reports.filter((r) => !r.passed).map((r) => r.sensor + ": " + (r.error || "exit " + r.exitCode)).join("; ");
                const failures = postResult.reports.filter((r) => !r.passed).map((r) => ({
                  subtask: subtask.title,
                  sensor: r.sensor,
                  error: r.error || "exit code " + r.exitCode,
                  fix_needed: "Fix sensor failures: " + failMsg + ". Run the sensor locally to reproduce."
                }));
                writeFileSync10(sensorReportPath, JSON.stringify({ failures, overall: "FAIL" }, null, 2));
              }
            }
          } catch (postSensorErr) {
            const msg = postSensorErr instanceof Error ? postSensorErr.message : String(postSensorErr);
            appendFileSync12(logFile, "\n[SENSOR:post_subtask] post-subtask sensors error: " + msg + "\n");
          }
          deps.planWriteLock.current = deps.planWriteLock.current.then(() => {
            try {
              const cpPlanPath = path11.join(pipeline.specPath, "plan.json");
              if (!existsSync14(cpPlanPath)) return;
              const cpPlan = JSON.parse(readFileSync12(cpPlanPath, "utf-8"));
              if (cpPlan.subtasks) {
                for (const s of cpPlan.subtasks) {
                  if (completedIds.includes(s.id)) s.completed = true;
                }
              }
              const tmpPath = cpPlanPath + ".tmp";
              writeFileSync10(tmpPath, JSON.stringify(cpPlan, null, 2));
              renameSync4(tmpPath, cpPlanPath);
            } catch {
            }
          });
        })
      );
      if (results.every((r) => r.status === "rejected")) {
        const firstReason = results[0].reason;
        throw firstReason instanceof Error ? firstReason : new Error(String(firstReason));
      }
      if (isMultiGroup) {
        try {
          const statusOut = execFileSync9("git", ["status", "--porcelain"], {
            cwd: pipeline.worktreePath,
            encoding: "utf-8",
            stdio: "pipe"
          }).trim();
          if (statusOut) {
            appendFileSync12(logFile, "\n[WORKTREE] Main worktree has uncommitted changes \u2014 auto-committing before cherry-pick:\n" + statusOut + "\n");
            execFileSync9("git", ["add", "-A", "--", ".", ":!.teamai"], { cwd: pipeline.worktreePath, stdio: "pipe" });
            execFileSync9("git", ["commit", "-m", "chore: auto-save worktree state before cherry-pick"], {
              cwd: pipeline.worktreePath,
              stdio: "pipe"
            });
            appendFileSync12(logFile, "[WORKTREE] Auto-committed uncommitted changes\n");
          }
        } catch (statusErr) {
          const errMsg = statusErr instanceof Error ? statusErr.message : String(statusErr);
          appendFileSync12(logFile, "\n[WORKTREE] Could not check/commit worktree status (git failed: " + errMsg + "), proceeding with cherry-pick\n");
        }
        for (let i = 0; i < results.length; i++) {
          if (results[i].status !== "fulfilled") continue;
          if (scopeViolations.has(subtasks[i].id)) {
            appendFileSync12(logFile, "\n[WORKTREE] Skipping cherry-pick for subtask " + subtasks[i].id + " (scope violation)\n");
            continue;
          }
          const stBranch = pipeline.branch + "-st" + subtasks[i].id;
          const cherrySuccess = await tryCherryPickWithRecovery(
            pipeline,
            deps,
            logFile,
            stBranch,
            subtasks[i].id
          );
          if (!cherrySuccess) {
            retainWorktrees = true;
            throw new Error(
              "Cherry-pick recovery exhausted for subtask " + subtasks[i].id + " \u2014 per-subtask branches have been preserved for manual recovery."
            );
          }
        }
      }
      if (completedIds.length > 0) {
        deps.planWriteLock.current = deps.planWriteLock.current.then(() => {
          const planPath2 = path11.join(pipeline.specPath, "plan.json");
          try {
            const p = JSON.parse(readFileSync12(planPath2, "utf-8"));
            if (p.subtasks) {
              for (const s of p.subtasks) {
                if (completedIds.includes(s.id)) s.completed = true;
              }
            }
            writeFileSync10(planPath2, JSON.stringify(p, null, 2));
          } catch {
          }
        });
      }
    } finally {
      if (isMultiGroup) {
        if (retainWorktrees) {
          appendFileSync12(logFile, "\n[WORKTREE] Retained " + subtaskWorktrees.size + " per-subtask worktree(s) and branches for manual recovery (auto-recovery exhausted).\n");
          appendFileSync12(logFile, "[WORKTREE] Branches preserved: " + subtasks.map((s) => pipeline.branch + "-st" + s.id).join(", ") + "\n");
        } else {
          for (const stWorktreePath of subtaskWorktrees.values()) {
            try {
              deps.execGit(["worktree", "remove", "--force", stWorktreePath], deps.projectRoot);
            } catch {
              try {
                rmSync4(stWorktreePath, { recursive: true, force: true });
              } catch {
              }
              try {
                execFileSync9("git", ["worktree", "prune"], { cwd: deps.projectRoot, stdio: "pipe" });
              } catch {
              }
            }
          }
          for (const subtask of subtasks) {
            try {
              execFileSync9("git", ["branch", "-D", pipeline.branch + "-st" + subtask.id], { cwd: deps.projectRoot, stdio: "pipe" });
            } catch {
            }
          }
          appendFileSync12(logFile, "\n[WORKTREE] Cleaned up " + subtaskWorktrees.size + " per-subtask worktree(s)\n");
        }
      }
    }
  }
  if (pipeline.phase === "failed") return;
  if (pipeline._wakeupJustCompleted) {
    delete pipeline._wakeupJustCompleted;
    deps.savePipelineState(pipeline);
    deps.advancePhase(pipeline, "implement");
    await deps.executePhase(pipeline);
    return;
  }
  if (pipeline.wakeupUntil) {
    if ((pipeline.wakeupAttemptCount || 0) >= deps.getPipelineConfig().maxWakeupAttempts) {
      appendFileSync12(logFile, "[WAKEUP] Subtask " + pipeline.wakeupSubtaskId + " exceeded wakeup attempt cap (" + deps.getPipelineConfig().maxWakeupAttempts + ") \u2014 advancing to failed\n");
      const reportPath = path11.join(pipeline.specPath, "qa_report.json");
      writeFileSync10(reportPath, JSON.stringify({
        overall: "FAIL",
        criteria: [{
          criterion: "Wakeup attempt limit exceeded",
          name: "Wakeup attempt limit exceeded",
          status: "FAIL",
          notes: "Subtask " + pipeline.wakeupSubtaskId + " failed to produce artifact after " + deps.getPipelineConfig().maxWakeupAttempts + " wakeup attempts. Expected artifact: " + (pipeline.wakeupArtifact || "unknown")
        }]
      }, null, 2));
      deps.advancePhase(pipeline, "failed");
      return;
    }
    deps.savePipelineState(pipeline);
    deps.scheduleWakeup(pipeline);
    return;
  }
  if (hasQaFeedback && existsSync14(qaFeedbackPath)) unlinkSync5(qaFeedbackPath);
  if (hasHumanFeedback && existsSync14(humanFeedbackPath)) unlinkSync5(humanFeedbackPath);
  if (hasQaFeedback) {
    try {
      const planAfter = JSON.parse(readFileSync12(planPath, "utf-8"));
      let cleaned = false;
      if (planAfter.subtasks) {
        for (const s of planAfter.subtasks) {
          if (s.qa_flagged) {
            delete s.qa_flagged;
            cleaned = true;
          }
        }
      }
      if (cleaned) writeFileSync10(planPath, JSON.stringify(planAfter, null, 2));
    } catch {
    }
  }
  deps.phaseHeader(logFile, "implement \u2014 push to remote");
  try {
    deps.gitPush(["push", "-u", "--force", "origin", pipeline.branch], logFile);
    appendFileSync12(logFile, "[PUSH] Successfully pushed " + pipeline.branch + " to origin\n");
    try {
      const localHead = execFileSync9("git", ["rev-parse", pipeline.branch], {
        cwd: deps.projectRoot,
        encoding: "utf-8",
        stdio: "pipe"
      }).trim();
      const remoteHead = execFileSync9("git", ["rev-parse", "origin/" + pipeline.branch], {
        cwd: deps.projectRoot,
        encoding: "utf-8",
        stdio: "pipe"
      }).trim();
      if (localHead !== remoteHead) {
        throw new Error("Push succeeded but HEADs differ \u2014 local=" + localHead + " remote=" + remoteHead);
      }
      appendFileSync12(logFile, "[PUSH] Verified remote HEAD matches local HEAD\n");
    } catch (verifyErr) {
      const verifyMsg = verifyErr instanceof Error ? verifyErr.message : String(verifyErr);
      appendFileSync12(logFile, "[PUSH] Remote verification failed: " + verifyMsg + "\n");
      throw verifyErr;
    }
  } catch (pushErr) {
    const pushMsg = pushErr instanceof Error ? pushErr.message : String(pushErr);
    appendFileSync12(logFile, "[PUSH] Push failed: " + pushMsg + "\n");
    let prExists = false;
    try {
      const prCheck = execFileSync9("gh", ["pr", "list", "--head", pipeline.branch, "--json", "url", "--jq", ".[0].url"], {
        cwd: deps.projectRoot,
        encoding: "utf-8",
        stdio: "pipe",
        timeout: 1e4
      }).trim();
      if (prCheck) {
        prExists = true;
        appendFileSync12(logFile, "[PUSH] PR already exists for branch " + pipeline.branch + ": " + prCheck + " \u2014 push failure is non-fatal\n");
        appendFileSync12(logFile, "[PUSH] Code is already in the PR \u2014 advancing to QA review\n");
      }
    } catch {
    }
    if (prExists) {
    } else {
      appendFileSync12(logFile, "[PUSH] Task cannot advance \u2014 engineer must be able to push before QA can verify\n");
      const reportPath = path11.join(pipeline.specPath, "qa_report.json");
      writeFileSync10(reportPath, JSON.stringify({
        overall: "FAIL",
        criteria: [{
          criterion: "Git push verification",
          name: "Git push verification",
          status: "FAIL",
          notes: "Git push failed: " + pushMsg + ". The engineer must be able to push commits before QA can verify."
        }]
      }, null, 2));
      deps.advancePhase(pipeline, "failed");
      return;
    }
  }
  const allSensorFailures = [];
  if (existsSync14(planPath)) {
    try {
      const planFinal = JSON.parse(readFileSync12(planPath, "utf-8"));
      for (const s of planFinal.subtasks || []) {
        const srPath = path11.join(pipeline.specPath, "sensor_report-st" + s.id + ".json");
        if (existsSync14(srPath)) {
          try {
            const report = JSON.parse(readFileSync12(srPath, "utf-8"));
            if (report.failures) allSensorFailures.push(...report.failures);
          } catch {
          }
          try {
            unlinkSync5(srPath);
          } catch {
          }
        }
      }
    } catch {
    }
  }
  if (allSensorFailures.length > 0) {
    appendFileSync12(logFile, "\n[SENSOR-GATE] post_subtask sensors failed (" + allSensorFailures.length + " failure(s)) \u2014 bouncing to implement for sensor fixes\n");
    deps.writeQaFeedback(pipeline, {
      overall: "FAIL",
      fail_type: "cleanup",
      criteria: allSensorFailures.map((f) => ({
        name: "Sensor: " + f.subtask + " \u2014 " + f.sensor,
        criterion: "Sensor: " + f.subtask + " \u2014 " + f.sensor,
        status: "FAIL",
        notes: f.error,
        fix_needed: f.fix_needed
      }))
    });
    deps.advancePhase(pipeline, "implement");
    deps.savePipelineState(pipeline);
    await deps.executePhase(pipeline);
    return;
  }
  deps.advancePhase(pipeline, "qa-review");
  await deps.executePhase(pipeline);
}
function checkCherryPickInProgress(worktreePath) {
  try {
    execFileSync9("git", ["rev-parse", "--verify", "CHERRY_PICK_HEAD"], {
      cwd: worktreePath,
      encoding: "utf-8",
      stdio: "pipe"
    });
    return true;
  } catch {
    return false;
  }
}
async function tryCherryPickWithRecovery(pipeline, deps, logFile, stBranch, subtaskId) {
  try {
    appendFileSync12(logFile, "\n[WORKTREE] Cherry-picking commits from " + stBranch + " onto " + pipeline.branch + "\n");
    deps.execGit(["cherry-pick", pipeline.branch + ".." + stBranch], pipeline.worktreePath);
    appendFileSync12(logFile, "[WORKTREE] Cherry-pick succeeded for subtask " + subtaskId + "\n");
    return true;
  } catch (firstErr) {
    const firstMsg = firstErr instanceof Error ? firstErr.message : String(firstErr);
    appendFileSync12(logFile, "[WORKTREE] Cherry-pick failed for subtask " + subtaskId + ": " + firstMsg + "\n");
  }
  if (!checkCherryPickInProgress(pipeline.worktreePath)) {
    try {
      deps.execGit(["cherry-pick", "--abort"], pipeline.worktreePath);
    } catch {
    }
    appendFileSync12(logFile, "[WORKTREE] Cherry-pick hard-failed (not a conflict) \u2014 cannot auto-recover subtask " + subtaskId + "\n");
    return false;
  }
  try {
    const conflictedFiles = execFileSync9("git", ["diff", "--name-only", "--diff-filter=U"], {
      cwd: pipeline.worktreePath,
      encoding: "utf-8",
      stdio: "pipe"
    }).trim();
    appendFileSync12(logFile, "[WORKTREE] Conflicted files: " + (conflictedFiles || "(none listed)") + "\n");
  } catch {
  }
  appendFileSync12(logFile, "[WORKTREE] Cherry-pick has conflicts \u2014 spawning merger agent for subtask " + subtaskId + "\n");
  try {
    const mergeLogFile = path11.join(pipeline.specPath, "output-merge.log");
    const mergeSessionId = await processManager.createSession(
      deps.sessionOpts("merger", pipeline.worktreePath, pipeline.taskId, mergeLogFile)
    );
    const sessionMapPath = path11.join(pipeline.specPath, "session_map.json");
    try {
      const map = existsSync14(sessionMapPath) ? JSON.parse(readFileSync12(sessionMapPath, "utf-8")) : {};
      map["merge"] = mergeSessionId;
      writeFileSync10(sessionMapPath, JSON.stringify(map, null, 2));
    } catch {
    }
    processManager.sendMessage(
      mergeSessionId,
      "Resolve cherry-pick conflicts\n\nA `git cherry-pick` from branch `" + stBranch + "` was attempted onto `" + pipeline.branch + "`\nbut encountered merge conflicts. The conflict markers are already in the files.\n\nYour job:\n1. Read each conflicted file and understand the intent of both sides of each conflict\n2. Resolve all conflicts semantically \u2014 preserve the intent of BOTH sets of changes\n3. `git add` the resolved files\n4. Run `git cherry-pick --continue` to complete the cherry-pick\n5. Run the test suite to verify correctness (one attempt, wait for completion)\n6. Print a summary of conflicts resolved and test results"
    );
    await deps.waitForCompletion(mergeSessionId);
    processManager.killSession(mergeSessionId);
    if (checkCherryPickInProgress(pipeline.worktreePath)) {
      appendFileSync12(logFile, "[WORKTREE] Merger finished but cherry-pick still in progress for subtask " + subtaskId + " \u2014 aborting\n");
      try {
        deps.execGit(["cherry-pick", "--abort"], pipeline.worktreePath);
      } catch {
      }
      return false;
    }
    appendFileSync12(logFile, "[WORKTREE] Merger agent resolved cherry-pick conflicts for subtask " + subtaskId + "\n");
    return true;
  } catch (mergeErr) {
    const mergeMsg = mergeErr instanceof Error ? mergeErr.message : String(mergeErr);
    appendFileSync12(logFile, "[WORKTREE] Merger agent failed for subtask " + subtaskId + ": " + mergeMsg + "\n");
    try {
      deps.execGit(["cherry-pick", "--abort"], pipeline.worktreePath);
    } catch {
    }
    return false;
  }
}
function buildSyntheticReworkDescription(qaContent) {
  return "\u26A0\uFE0F ALL PLAN SUBTASKS ARE DONE \u2014 THIS IS TARGETED REWORK, NOT FRESH IMPLEMENTATION.\n\nQA found failures that could not be automatically mapped to specific plan subtasks. The original plan subtasks are already implemented \u2014 do NOT re-read or re-implement them. Do NOT re-read the spec. Your ONLY job is to fix the QA issues listed below.\n\n**QA feedback (source of truth):**\n\n" + qaContent;
}
function buildSubtaskFeedback(hasQaFeedback, qaOnlyCriteria, subtask, specPath, humanFeedbackPath, hasHumanFeedback) {
  if (!hasQaFeedback) return "";
  const lines = [];
  lines.push("## \u26A0\uFE0F QA FEEDBACK \u2014 FIX THESE FIRST \u26A0\uFE0F");
  lines.push("");
  try {
    const reportPath = path11.join(specPath, "qa_report.json");
    if (existsSync14(reportPath)) {
      const report = JSON.parse(readFileSync12(reportPath, "utf-8"));
      if (report.overall) lines.push("Overall: **" + report.overall + "**");
    }
  } catch {
  }
  if (qaOnlyCriteria.length > 0) {
    lines.push("");
    lines.push("Issues in subtask " + subtask.id + " **" + subtask.title + "**:");
    for (const c of qaOnlyCriteria) {
      const cleaned = c.replace(/\s*\[QA CORRECTION:\s*/g, "[BLOCKER] ").replace(/\s*\[QA ISSUE\s*(?:\((?:\w*)\))?:\s*/g, "").replace(/\]$/, "");
      lines.push("- " + cleaned);
    }
  }
  if (hasHumanFeedback) {
    try {
      const hf = readFileSync12(humanFeedbackPath, "utf-8");
      lines.push("");
      lines.push("---");
      lines.push("");
      lines.push(hf);
    } catch {
    }
  }
  lines.push("");
  return lines.join("\n");
}
var init_implement = __esm({
  "src/lib/orchestrator/implement.ts"() {
    "use strict";
    init_process_manager();
    init_container_manager();
    init_sensors();
    init_phase_runners();
  }
});

// src/lib/orchestrator/qa-review.ts
import { execFileSync as execFileSync10 } from "child_process";
import { readFileSync as readFileSync13, writeFileSync as writeFileSync11, existsSync as existsSync15, appendFileSync as appendFileSync13 } from "fs";
import path12 from "path";
async function runQaReview(pipeline, deps) {
  deps.persistAndEmitPhase(pipeline);
  pipeline.qaAttempt++;
  deps.savePipelineState(pipeline);
  const logFile = path12.join(pipeline.specPath, "output.log");
  const qaLogFile = path12.join(pipeline.specPath, "output-qa.log");
  deps.phaseHeader(logFile, `qa-review (attempt ${pipeline.qaAttempt})`);
  const reportPath = path12.join(pipeline.specPath, "qa_report.json");
  if (existsSync15(reportPath)) {
    try {
      const existingReport = JSON.parse(readFileSync13(reportPath, "utf-8"));
      if (existingReport.locked === true) {
        appendFileSync13(logFile, "\n[INFO] qa_report.json is locked \u2014 skipping QA review\n");
        deps.advancePhase(pipeline, "awaiting-review");
        return;
      }
      if (existingReport.reviewedBy && typeof existingReport.reviewedBy === "string" && existingReport.reviewedBy.toLowerCase().includes("manual override")) {
        appendFileSync13(logFile, "\n[INFO] qa_report.json has manual override \u2014 skipping QA review\n");
        deps.advancePhase(pipeline, "awaiting-review");
        return;
      }
    } catch {
    }
  }
  try {
    execFileSync10("git", ["fetch", "origin", pipeline.branch], { cwd: deps.projectRoot, stdio: "pipe" });
  } catch {
  }
  let hasUnpushed = false;
  try {
    const unpushed = execFileSync10("git", ["log", `origin/${pipeline.branch}..${pipeline.branch}`, "--oneline"], {
      cwd: deps.projectRoot,
      encoding: "utf-8",
      stdio: "pipe"
    }).trim();
    hasUnpushed = unpushed.length > 0;
    if (hasUnpushed) {
      appendFileSync13(logFile, `
[QA-PRECHECK] Unpushed commits detected on ${pipeline.branch}:
${unpushed}
`);
      try {
        deps.gitPush(["push", "origin", pipeline.branch], logFile);
        appendFileSync13(logFile, "[QA-PRECHECK] Pushed unpushed commits successfully \u2014 remote matches worktree\n");
        hasUnpushed = false;
      } catch (pushErr) {
        const pushMsg = pushErr instanceof Error ? pushErr.message : String(pushErr);
        appendFileSync13(logFile, `[QA-PRECHECK] Auto-push failed: ${pushMsg}
`);
      }
    }
  } catch {
  }
  if (hasUnpushed) {
    const failReport = {
      overall: "FAIL",
      criteria: [{
        criterion: "Unpushed commits",
        name: "Unpushed commits",
        status: "FAIL",
        notes: "Unpushed commits detected \u2014 engineer must push before QA can verify. The worktree has local commits not present on the remote branch, so QA cannot verify the same code that reviewers will see."
      }]
    };
    writeFileSync11(reportPath, JSON.stringify(failReport, null, 2));
    appendFileSync13(logFile, "[QA-PRECHECK] FAIL \u2014 unpushed commits detected, engineer must push first\n");
    if (pipeline.qaAttempt >= pipeline.maxQaAttempts) {
      deps.writeCompletionSummary(pipeline);
      deps.advancePhase(pipeline, "failed");
    } else {
      if (existsSync15(reportPath)) {
        try {
          const bounceSnapshot = path12.join(pipeline.specPath, "qa_report_before_bounce.json");
          writeFileSync11(bounceSnapshot, readFileSync13(reportPath, "utf-8"));
        } catch {
        }
      }
      deps.writeQaFeedback(pipeline, failReport);
      deps.advancePhase(pipeline, "implement");
      deps.savePipelineState(pipeline);
      await deps.executePhase(pipeline);
    }
    return;
  }
  try {
    execFileSync10("git", ["fetch", "origin", "master"], { cwd: deps.projectRoot, stdio: "pipe" });
  } catch {
  }
  const sessionId = await processManager.createSession(
    deps.sessionOpts("qa-reviewer", pipeline.worktreePath, pipeline.taskId, qaLogFile)
  );
  pipeline.sessionId = sessionId;
  try {
    const sessionMapPath = path12.join(pipeline.specPath, "session_map.json");
    const map = existsSync15(sessionMapPath) ? JSON.parse(readFileSync13(sessionMapPath, "utf-8")) : {};
    map["qa"] = sessionId;
    writeFileSync11(sessionMapPath, JSON.stringify(map, null, 2));
  } catch {
  }
  const agentSpecPath = deps.toAgentPath(pipeline.specPath);
  processManager.sendMessage(
    sessionId,
    `/qa-review ${agentSpecPath}/spec.md

IMPORTANT: Write the QA report to \`${agentSpecPath}/qa_report.json\` (use this exact absolute path, not a relative path).
The working directory is a git worktree \u2014 do NOT write to a .teamai/ subdirectory relative to the current directory.`
  );
  try {
    await deps.waitForCompletion(sessionId);
  } catch (err) {
    if (err instanceof RateLimitError) {
      pipeline.qaAttempt--;
    }
    throw err;
  }
  processManager.killSession(sessionId);
  const report = JSON.parse(readFileSync13(reportPath, "utf-8"));
  try {
    const headSha = execFileSync10("git", ["rev-parse", "HEAD"], {
      cwd: pipeline.worktreePath,
      encoding: "utf-8",
      stdio: "pipe"
    }).trim();
    report.head_at_review = headSha;
    writeFileSync11(reportPath, JSON.stringify(report, null, 2));
  } catch {
  }
  const hasSpecConcerns = report.spec_concerns && Array.isArray(report.spec_concerns) && report.spec_concerns.length > 0;
  if (hasSpecConcerns) {
    await deps.autoReviseSpec(pipeline);
    return;
  } else if (report.overall === "PASS") {
    deps.advancePhase(pipeline, "awaiting-review");
  } else if (pipeline.qaAttempt >= pipeline.maxQaAttempts) {
    deps.writeCompletionSummary(pipeline);
    deps.advancePhase(pipeline, "failed");
  } else {
    const prevSnapshotPath = path12.join(pipeline.specPath, "qa_report_before_bounce.json");
    const currentFailNames = new Set(
      (report.criteria || []).filter((c) => c.status === "FAIL").map((c) => (c.criterion || c.name || "").trim())
    );
    let prevFailNames = /* @__PURE__ */ new Set();
    if (existsSync15(prevSnapshotPath) && currentFailNames.size > 0) {
      try {
        const prevReport = JSON.parse(readFileSync13(prevSnapshotPath, "utf-8"));
        prevFailNames = new Set(
          (prevReport.criteria || []).filter((c) => c.status === "FAIL").map((c) => (c.criterion || c.name || "").trim())
        );
      } catch {
      }
    }
    try {
      const bounceSnapshot = path12.join(pipeline.specPath, "qa_report_before_bounce.json");
      writeFileSync11(bounceSnapshot, readFileSync13(reportPath, "utf-8"));
    } catch {
    }
    if (currentFailNames.size > 0 && prevFailNames.size > 0) {
      if (!pipeline.persistedCriterionFailCounts) pipeline.persistedCriterionFailCounts = {};
      for (const name of currentFailNames) {
        if (prevFailNames.has(name)) {
          const prevTotal = pipeline.persistedCriterionFailCounts[name] || 1;
          pipeline.persistedCriterionFailCounts[name] = prevTotal + 1;
          appendFileSync13(logFile, `
[QA-ESCALATE] Persisted FAIL criterion detected: "${name}" has failed ${pipeline.persistedCriterionFailCounts[name]} times in a row
`);
        }
      }
      for (const name of Object.keys(pipeline.persistedCriterionFailCounts)) {
        if (!currentFailNames.has(name)) {
          delete pipeline.persistedCriterionFailCounts[name];
          appendFileSync13(logFile, `
[QA-ESCALATE] Criterion "${name}" resolved \u2014 removed from persisted failures tracking
`);
        }
      }
    }
    if (report.fail_type === "cleanup") {
      appendFileSync13(logFile, "\n[QA-ROUTER] fail_type=cleanup \u2014 routing to implement for automated mechanical fix\n");
      const failCriteria = report.criteria?.filter((c) => c.status === "FAIL") || [];
      for (const c of failCriteria) {
        appendFileSync13(logFile, `[QA-ROUTER] Cleanup required: ${c.fix_needed || c.notes || c.criterion}
`);
      }
      appendFileSync13(logFile, "[QA-ROUTER] Cleanup fix is automated \u2014 executing via implement cleanup-only rework mode\n");
    }
    deps.writeQaFeedback(pipeline, report);
    deps.advancePhase(pipeline, "implement");
    deps.savePipelineState(pipeline);
    await deps.executePhase(pipeline);
  }
}
var init_qa_review = __esm({
  "src/lib/orchestrator/qa-review.ts"() {
    "use strict";
    init_process_manager();
    init_rate_limit();
  }
});

// src/lib/orchestrator/review-actions.ts
import { readFileSync as readFileSync14, writeFileSync as writeFileSync12, existsSync as existsSync16, appendFileSync as appendFileSync14, unlinkSync as unlinkSync6 } from "fs";
import path13 from "path";
function resetAllCounters(pipeline) {
  pipeline.qaAttempt = 0;
  pipeline.deliverableFailCounts = {};
  pipeline.persistedCriterionFailCounts = {};
  pipeline.wakeupAttemptCount = 0;
  pipeline.wakeupUntil = void 0;
  pipeline.wakeupSubtaskId = void 0;
  pipeline.wakeupCommand = void 0;
  pipeline.wakeupArtifact = void 0;
}
async function approveTask(taskId, strategy, deps) {
  const task = deps.taskStore.getById(taskId);
  if (!task) throw new Error(`Task ${taskId} not found`);
  const phase = task.phase;
  if (phase !== "awaiting-review") {
    throw new Error(`cannot approve a task in ${phase} \u2014 must be awaiting-review`);
  }
  const pipeline = deps.pipelines.get(taskId) ?? deps.restorePipeline(taskId, "awaiting-review");
  pipeline.mergeStrategy = strategy;
  deps.taskStore.update(taskId, { mergeStrategy: strategy });
  const next2 = strategy === "local-merge" ? "merge" : "create-pr";
  deps.advancePhase(pipeline, next2);
  try {
    await deps.executePhase(pipeline);
  } catch (err) {
    deps.advancePhase(pipeline, "awaiting-review");
    throw err;
  }
}
async function rejectTask(taskId, feedback, deps) {
  const task = deps.taskStore.getById(taskId);
  if (!task) throw new Error(`Task ${taskId} not found`);
  const phase = task.phase;
  if (phase !== "awaiting-review" && phase !== "pr-open") {
    throw new Error(`cannot reject a task in ${phase} \u2014 must be awaiting-review or pr-open`);
  }
  const pipeline = deps.pipelines.get(taskId) ?? deps.restorePipeline(taskId, phase);
  const feedbackPath = path13.join(pipeline.specPath, "human_feedback.md");
  writeFileSync12(feedbackPath, `# Human Review Feedback

${feedback}
`);
  try {
    const snapshotPath = path13.join(pipeline.specPath, "human_feedback_before_bounce.md");
    writeFileSync12(snapshotPath, readFileSync14(feedbackPath, "utf-8"));
  } catch {
  }
  const reportPath = path13.join(pipeline.specPath, "qa_report.json");
  if (existsSync16(reportPath)) {
    try {
      const report = JSON.parse(readFileSync14(reportPath, "utf-8"));
      if (!report.criteria) report.criteria = [];
      report.overall = "FAIL";
      report.criteria.push({
        name: "Change Request",
        status: "FAIL",
        notes: feedback
      });
      writeFileSync12(reportPath, JSON.stringify(report, null, 2));
    } catch {
    }
  }
  resetAllCounters(pipeline);
  deps.advancePhase(pipeline, "implement");
  await deps.executePhase(pipeline);
}
async function autoReviseSpec(pipeline, deps) {
  const specPath = pipeline.specPath;
  const logFile = path13.join(specPath, "output.log");
  pipeline.specRevision++;
  if (pipeline.specRevision > 3) {
    try {
      appendFileSync14(logFile, `
[REFINE] Max spec revisions (3) reached \u2014 pausing for human review
`);
    } catch {
    }
    deps.advancePhase(pipeline, "awaiting-review");
    return;
  }
  const reportPath = path13.join(specPath, "qa_report.json");
  let feedbackContent = "# Spec Revision Feedback\n\n";
  feedbackContent += "The QA reviewer identified issues with the specification itself ";
  feedbackContent += "(not the implementation). The spec needs to be revised to address these concerns.\n\n";
  if (existsSync16(reportPath)) {
    try {
      const report = JSON.parse(readFileSync14(reportPath, "utf-8"));
      if (report.spec_concerns && report.spec_concerns.length > 0) {
        for (const sc of report.spec_concerns) {
          feedbackContent += `## ${sc.issue}

`;
          feedbackContent += `**Reasoning:** ${sc.reasoning}

`;
          if (sc.suggested_fix) {
            feedbackContent += `**Suggested fix:** ${sc.suggested_fix}

`;
          }
        }
      }
    } catch {
    }
  }
  writeFileSync12(path13.join(specPath, "spec_revision_feedback.md"), feedbackContent);
  const specMdPath = path13.join(specPath, "spec.md");
  if (existsSync16(specMdPath)) {
    try {
      writeFileSync12(path13.join(specPath, `spec_v${pipeline.specRevision}.md`), readFileSync14(specMdPath, "utf-8"));
    } catch {
    }
  }
  deps.taskStore.clearArtifacts(pipeline.taskId, "plan");
  const extraFiles = ["qa_feedback.md", "completion_summary.md", "human_feedback.md", "human_feedback_before_bounce.md", "qa_report_before_bounce.json"];
  for (const f of extraFiles) {
    try {
      const p = path13.join(specPath, f);
      if (existsSync16(p)) unlinkSync6(p);
    } catch {
    }
  }
  resetAllCounters(pipeline);
  deps.savePipelineState(pipeline);
  try {
    appendFileSync14(logFile, `
[REFINE] Spec concerns detected \u2014 auto-revising spec with analyst (revision ${pipeline.specRevision}/3)
`);
  } catch {
  }
  deps.advancePhase(pipeline, "spec");
  await deps.executePhase(pipeline);
}
var init_review_actions = __esm({
  "src/lib/orchestrator/review-actions.ts"() {
    "use strict";
  }
});

// src/lib/orchestrator.ts
var orchestrator_exports = {};
__export(orchestrator_exports, {
  Orchestrator: () => Orchestrator,
  buildPRBody: () => buildPRBody,
  buildPlatformPrompt: () => buildPlatformPrompt,
  checkExistingPRViaCLI: () => checkExistingPRViaCLI,
  createPRViaCLI: () => createPRViaCLI,
  detectDefaultBranch: () => detectDefaultBranch,
  detectGitPlatform: () => detectGitPlatform,
  getOrchestrator: () => getOrchestrator
});
import { readFileSync as readFileSync15, writeFileSync as writeFileSync13, existsSync as existsSync17, appendFileSync as appendFileSync15, unlinkSync as unlinkSync7, rmSync as rmSync5, mkdirSync as mkdirSync5 } from "fs";
import path14 from "path";
import { execFileSync as execFileSync11 } from "child_process";
function getOrchestrator(projectPath) {
  if (!orchestrators.has(projectPath)) {
    orchestrators.set(projectPath, new Orchestrator(projectPath));
  }
  return orchestrators.get(projectPath);
}
var Orchestrator, g, orchestrators;
var init_orchestrator = __esm({
  "src/lib/orchestrator.ts"() {
    "use strict";
    init_process_manager();
    init_container_manager();
    init_task_store();
    init_utils();
    init_worktree_utils();
    init_pipeline_state();
    init_qa_feedback();
    init_phase_runners();
    init_helpers();
    init_worktree_ops();
    init_artifact_commit();
    init_git_push();
    init_rate_limit();
    init_implement();
    init_qa_review();
    init_review_actions();
    init_git_platform();
    Orchestrator = class {
      constructor(projectRoot) {
        this.projectRoot = projectRoot;
        this.pipelines = /* @__PURE__ */ new Map();
        this.activeTasks = /* @__PURE__ */ new Set();
        this._pipelineConfigCache = null;
        // Serializes writes to plan.json to prevent race conditions during
        // per-subtask checkpointing in runImplement (#2). Wrapped in an object
        // so the extracted runImplement can mutate the current promise through
        // its deps reference without aliasing `this`.
        this._planWriteLockRef = { current: Promise.resolve() };
        this.taskStore = new TaskStore(projectRoot);
      }
      /** Whether a pipeline is currently executing for the given task. */
      isTaskActive(taskId) {
        return this.activeTasks.has(taskId);
      }
      getPipelineConfig() {
        if (!this._pipelineConfigCache) {
          this._pipelineConfigCache = computePipelineConfig(this.projectRoot);
        }
        return this._pipelineConfigCache;
      }
      // Cancel a running pipeline for a task — kills the active session and removes
      // the in-memory pipeline so a new one can start cleanly.
      cancelPipeline(taskId) {
        const pipeline = this.pipelines.get(taskId);
        if (pipeline?.sessionId) {
          processManager.killSession(pipeline.sessionId);
        }
        this.pipelines.delete(taskId);
        this.activeTasks.delete(taskId);
      }
      // Move a task to a target phase, smart-detecting which earlier phase to start from
      // based on which artifacts already exist, then run the pipeline from there.
      async moveTaskToPhase(taskId, targetPhase) {
        this.cancelPipeline(taskId);
        const task = this.taskStore.getById(taskId);
        if (!task) throw new Error(`Task ${taskId} not found`);
        const dir = this.taskStore.getDirById(taskId);
        if (NO_RESUME_PHASES.has(targetPhase)) {
          if (targetPhase === "done" || targetPhase === "backlog" || targetPhase === "failed") {
            this.removeWorktree(taskId);
          }
          this.taskStore.updatePhase(taskId, targetPhase);
          processManager.emit("phase-change", { taskId, phase: targetPhase, projectRoot: this.projectRoot });
          return;
        }
        const hasSpec = existsSync17(path14.join(dir, "spec.md"));
        const hasPlan = existsSync17(path14.join(dir, "plan.json"));
        let startPhase = "spec";
        if (targetPhase === "spec") {
          this.taskStore.clearArtifacts(taskId, "spec");
          startPhase = "spec";
        } else if (targetPhase === "plan") {
          this.taskStore.clearArtifacts(taskId, "plan");
          startPhase = hasSpec ? "plan" : "spec";
        } else if (targetPhase === "implement") {
          this.taskStore.clearArtifacts(taskId, "qa");
          if (hasPlan) startPhase = "implement";
          else if (hasSpec) startPhase = "plan";
          else startPhase = "spec";
        } else if (targetPhase === "qa-review") {
          this.taskStore.clearArtifacts(taskId, "qa");
          if (hasPlan) startPhase = "implement";
          else if (hasSpec) startPhase = "plan";
          else startPhase = "spec";
        } else if (targetPhase === "merge" || targetPhase === "create-pr") {
          const worktreeBase = this.getWorktreeBase();
          const worktreePath = path14.join(worktreeBase, slugify(task.description));
          const worktreeExists = existsSync17(worktreePath);
          const branchExists = !!task.branch;
          if (hasPlan && worktreeExists && branchExists) {
            startPhase = targetPhase;
          } else if (hasPlan) {
            startPhase = "implement";
          } else if (hasSpec) {
            startPhase = "plan";
          } else {
            startPhase = "spec";
          }
        } else {
          startPhase = targetPhase;
        }
        await this.runTask(taskId, task.description, startPhase);
      }
      async runTask(taskId, description, startPhase) {
        this._pipelineConfigCache = null;
        if (this.getPipelineConfig().demo) return;
        if (this.activeTasks.has(taskId)) {
          throw new Error(`Task ${taskId} is already running \u2014 wait for the current pipeline to finish.`);
        }
        this.cancelPipeline(taskId);
        this.activeTasks.add(taskId);
        const config = this.getPipelineConfig();
        const slug = slugify(description);
        const branch = `feat/${slug}`;
        const worktreePath = path14.join(this.getWorktreeBase(), slug);
        const specPath = this.taskStore.getDirById(taskId);
        const pipeline = {
          taskId,
          description,
          phase: "spec",
          specPath,
          worktreePath,
          branch,
          qaAttempt: 0,
          maxQaAttempts: config.maxQaAttempts,
          specRevision: 0
        };
        const firstPhase = startPhase ?? "spec";
        pipeline.phase = firstPhase;
        this.pipelines.set(taskId, pipeline);
        this.taskStore.update(taskId, { branch });
        const savedState = this._restorePipelineState(taskId, specPath);
        if (savedState) {
          if (savedState.mergeStrategy) pipeline.mergeStrategy = savedState.mergeStrategy;
          if (savedState.qaAttempt !== void 0) pipeline.qaAttempt = savedState.qaAttempt;
          if (savedState.deliverableFailCounts !== void 0) pipeline.deliverableFailCounts = savedState.deliverableFailCounts;
          if (savedState.wakeupUntil !== void 0) pipeline.wakeupUntil = savedState.wakeupUntil;
          if (savedState.wakeupSubtaskId !== void 0) pipeline.wakeupSubtaskId = savedState.wakeupSubtaskId;
          if (savedState.wakeupCommand !== void 0) pipeline.wakeupCommand = savedState.wakeupCommand;
          if (savedState.wakeupArtifact !== void 0) pipeline.wakeupArtifact = savedState.wakeupArtifact;
          if (savedState.wakeupAttemptCount !== void 0) pipeline.wakeupAttemptCount = savedState.wakeupAttemptCount;
          if (savedState.persistedCriterionFailCounts !== void 0) pipeline.persistedCriterionFailCounts = savedState.persistedCriterionFailCounts;
          if (savedState.sessionId) pipeline.sessionId = savedState.sessionId;
        }
        this._savePipelineState(pipeline);
        let rateLimited = false;
        try {
          await this.executePhase(pipeline);
        } catch (e) {
          if (e instanceof RateLimitError) {
            rateLimited = true;
            this.handleRateLimit(pipeline, e.resetsAt);
          } else {
            const errMsg = e instanceof Error ? `${e.message}
${e.stack ?? ""}` : String(e);
            const logFile = path14.join(pipeline.specPath, "output.log");
            appendFileSync15(logFile, `
[ERROR] Task failed: ${errMsg}
`);
            console.error(`[orchestrator] Task ${taskId} failed:`, e);
            this.advancePhase(pipeline, "failed");
          }
        } finally {
          if (!rateLimited && !pipeline.wakeupUntil) {
            this.pipelines.delete(taskId);
            this.activeTasks.delete(taskId);
          }
        }
      }
      async approveTask(taskId, strategy) {
        await approveTask(taskId, strategy, {
          taskStore: this.taskStore,
          pipelines: this.pipelines,
          restorePipeline: (id, phase) => this.restorePipeline(id, phase),
          advancePhase: (p, phase, eventExtra) => this.advancePhase(p, phase, eventExtra),
          executePhase: (p) => this.executePhase(p),
          savePipelineState: (p) => this._savePipelineState(p)
        });
      }
      async rejectTask(taskId, feedback) {
        await rejectTask(taskId, feedback, {
          taskStore: this.taskStore,
          pipelines: this.pipelines,
          restorePipeline: (id, phase) => this.restorePipeline(id, phase),
          advancePhase: (p, phase, eventExtra) => this.advancePhase(p, phase, eventExtra),
          executePhase: (p) => this.executePhase(p),
          savePipelineState: (p) => this._savePipelineState(p)
        });
      }
      async reviseSpec(taskId) {
        const task = this.taskStore.getById(taskId);
        if (!task) throw new Error(`Task ${taskId} not found`);
        const phase = task.phase;
        if (phase !== "awaiting-review") {
          throw new Error(`cannot revise spec for a task in ${phase} \u2014 must be awaiting-review`);
        }
        const pipeline = this.pipelines.get(taskId) ?? this.restorePipeline(taskId, "awaiting-review");
        await this._autoReviseSpec(pipeline);
      }
      // Delegates to review-actions.autoReviseSpec
      async _autoReviseSpec(pipeline) {
        await autoReviseSpec(pipeline, {
          taskStore: this.taskStore,
          pipelines: this.pipelines,
          restorePipeline: (id, phase) => this.restorePipeline(id, phase),
          advancePhase: (p, phase, eventExtra) => this.advancePhase(p, phase, eventExtra),
          executePhase: (p) => this.executePhase(p),
          savePipelineState: (p) => this._savePipelineState(p)
        });
      }
      async executePhase(pipeline) {
        switch (pipeline.phase) {
          case "spec":
            return this.runSpec(pipeline);
          case "plan":
            return this.runPlan(pipeline);
          case "implement":
            return this.runImplement(pipeline);
          case "qa-review":
            return this.runQaReview(pipeline);
          case "awaiting-review":
            return;
          // Paused — waiting for human
          case "pr-open":
            return;
          // Paused — PR created, waiting for human to merge + mark done
          case "merge":
            return this.runMerge(pipeline);
          case "create-pr":
            return this.runCreatePR(pipeline);
        }
      }
      async runSpec(pipeline) {
        await runSpecPhase(pipeline, {
          projectRoot: this.projectRoot,
          rotateOutputLog: (logFile) => this._rotateOutputLog(logFile),
          phaseHeader: (logFile, phase) => this._phaseHeader(logFile, phase),
          persistAndEmitPhase: (p) => this._persistAndEmitPhase(p),
          savePipelineState: (p) => this._savePipelineState(p),
          sessionOpts: (role, cwd, taskId, logFile) => this.sessionOpts(role, cwd, taskId, logFile),
          toAgentPath: (hostPath) => this._toAgentPath(hostPath),
          waitForCompletion: (sessionId) => this.waitForCompletion(sessionId),
          advancePhase: (p, phase, eventExtra) => this.advancePhase(p, phase, eventExtra),
          executePhase: (p) => this.executePhase(p)
        });
      }
      async runPlan(pipeline) {
        await runPlanPhase(pipeline, {
          projectRoot: this.projectRoot,
          rotateOutputLog: (logFile) => this._rotateOutputLog(logFile),
          phaseHeader: (logFile, phase) => this._phaseHeader(logFile, phase),
          persistAndEmitPhase: (p) => this._persistAndEmitPhase(p),
          savePipelineState: (p) => this._savePipelineState(p),
          sessionOpts: (role, cwd, taskId, logFile) => this.sessionOpts(role, cwd, taskId, logFile),
          toAgentPath: (hostPath) => this._toAgentPath(hostPath),
          waitForCompletion: (sessionId) => this.waitForCompletion(sessionId),
          advancePhase: (p, phase, eventExtra) => this.advancePhase(p, phase, eventExtra),
          executePhase: (p) => this.executePhase(p),
          gitPush: (pushArgs, logFile) => this._gitPush(pushArgs, logFile),
          execGit: (args, hostCwd) => this._execGit(args, hostCwd)
        });
      }
      async runImplement(pipeline) {
        await runImplement(pipeline, {
          projectRoot: this.projectRoot,
          persistAndEmitPhase: (p) => this._persistAndEmitPhase(p),
          advancePhase: (p, phase, eventExtra) => this.advancePhase(p, phase, eventExtra),
          savePipelineState: (p) => this._savePipelineState(p),
          executePhase: (p) => this.executePhase(p),
          sessionOpts: (role, cwd, taskId, logFile) => this.sessionOpts(role, cwd, taskId, logFile),
          waitForCompletion: (sessionId) => this.waitForCompletion(sessionId),
          execGit: (args, hostCwd) => this._execGit(args, hostCwd),
          gitPush: (pushArgs, logFile) => this._gitPush(pushArgs, logFile),
          patchWorktreeGitFile: (hostWorktreePath, containerWorkspace) => this._patchWorktreeGitFile(hostWorktreePath, containerWorkspace),
          isWorktreeHealthy: (worktreePath) => this._isWorktreeHealthy(worktreePath),
          cleanStaleSubtaskWorktrees: (p) => this._cleanStaleSubtaskWorktrees(p),
          restoreQaReportFromSnapshot: (specPath) => this._restoreQaReportFromSnapshot(specPath),
          restoreHumanFeedbackFromSnapshot: (specPath) => this._restoreHumanFeedbackFromSnapshot(specPath),
          writeQaFeedback: (p, report) => this._writeQaFeedback(p, report),
          getPipelineConfig: () => this.getPipelineConfig(),
          phaseHeader: (logFile, phase) => this._phaseHeader(logFile, phase),
          planWriteLock: this._planWriteLockRef,
          scheduleWakeup: (pipeline2) => this._scheduleWakeup(pipeline2)
        });
      }
      async runQaReview(pipeline) {
        await runQaReview(pipeline, {
          projectRoot: this.projectRoot,
          persistAndEmitPhase: (p) => this._persistAndEmitPhase(p),
          advancePhase: (p, phase, eventExtra) => this.advancePhase(p, phase, eventExtra),
          savePipelineState: (p) => this._savePipelineState(p),
          executePhase: (p) => this.executePhase(p),
          sessionOpts: (role, cwd, taskId, logFile) => this.sessionOpts(role, cwd, taskId, logFile),
          waitForCompletion: (sessionId) => this.waitForCompletion(sessionId),
          gitPush: (pushArgs, logFile) => this._gitPush(pushArgs, logFile),
          writeQaFeedback: (p, report) => this._writeQaFeedback(p, report),
          writeCompletionSummary: (p) => this._writeCompletionSummary(p),
          phaseHeader: (logFile, phase) => this._phaseHeader(logFile, phase),
          toAgentPath: (hostPath) => this._toAgentPath(hostPath),
          autoReviseSpec: (p) => this._autoReviseSpec(p)
        });
      }
      async runMerge(pipeline) {
        await runMergePhase(pipeline, {
          projectRoot: this.projectRoot,
          phaseHeader: (logFile, phase) => this._phaseHeader(logFile, phase),
          persistAndEmitPhase: (p) => this._persistAndEmitPhase(p),
          sessionOpts: (role, cwd, taskId, logFile) => this.sessionOpts(role, cwd, taskId, logFile),
          waitForCompletion: (sessionId) => this.waitForCompletion(sessionId),
          advancePhase: (p, phase, eventExtra) => this.advancePhase(p, phase, eventExtra),
          execGit: (args, hostCwd) => this._execGit(args, hostCwd),
          commitArtifactsToWorktree: (p) => this._commitArtifactsToWorktree(p),
          getPipelineConfig: () => this.getPipelineConfig(),
          removeWorktree: (taskId) => this.removeWorktree(taskId)
        });
      }
      async runCreatePR(pipeline) {
        await runCreatePRPhase(pipeline, {
          projectRoot: this.projectRoot,
          taskStore: this.taskStore,
          persistAndEmitPhase: (p) => this._persistAndEmitPhase(p),
          sessionOpts: (role, cwd, taskId, logFile) => this.sessionOpts(role, cwd, taskId, logFile),
          waitForCompletion: (sessionId) => this.waitForCompletion(sessionId),
          advancePhase: (p, phase, eventExtra) => this.advancePhase(p, phase, eventExtra),
          execGit: (args, hostCwd) => this._execGit(args, hostCwd),
          commitArtifactsToWorktree: (p) => this._commitArtifactsToWorktree(p),
          gitPush: (pushArgs, logFile) => this._gitPush(pushArgs, logFile),
          extractPrUrl: (logFile) => this._extractPrUrl(logFile)
        });
      }
      async markTaskDone(taskId) {
        const task = this.taskStore.getById(taskId);
        if (!task) throw new Error(`Task ${taskId} not found`);
        this.removeWorktree(taskId);
        const dir = this.taskStore.getDirById(taskId);
        rmSync5(dir, { recursive: true, force: true });
        let pulled = false;
        try {
          execFileSync11("git", ["pull", "--ff-only", "origin", "master"], {
            cwd: this.projectRoot,
            stdio: "pipe",
            env: { ...process.env, GIT_TERMINAL_PROMPT: "0" }
          });
          pulled = true;
        } catch {
        }
        let settled = false;
        const pulledTaskJson = path14.join(dir, "task.json");
        if (pulled && existsSync17(pulledTaskJson)) {
          try {
            settled = JSON.parse(readFileSync15(pulledTaskJson, "utf-8")).phase === "done";
          } catch {
          }
          if (!settled) {
            this.taskStore.updatePhase(taskId, "done");
            settled = true;
          }
        }
        if (!settled) {
          mkdirSync5(dir, { recursive: true });
          writeFileSync13(path14.join(dir, "task.json"), JSON.stringify({
            ...task,
            phase: "done",
            updatedAt: (/* @__PURE__ */ new Date()).toISOString()
          }, null, 2));
          const event = { phase: "done", timestamp: (/* @__PURE__ */ new Date()).toISOString() };
          appendFileSync15(path14.join(dir, "events.jsonl"), JSON.stringify(event) + "\n");
        }
        processManager.emit("phase-change", { taskId, phase: "done", projectRoot: this.projectRoot });
      }
      /** Scan the output log for a PR/MR URL created by the agent. */
      _extractPrUrl(logFile) {
        return extractPrUrl(logFile);
      }
      _rotateOutputLog(logFile) {
        rotateOutputLog(logFile);
      }
      _persistAndEmitPhase(pipeline) {
        persistAndEmitPhase(pipeline, this.taskStore, this.projectRoot);
      }
      _savePipelineState(pipeline) {
        savePipelineState(pipeline);
      }
      _restorePipelineState(_taskId, specPath) {
        return restorePipelineState(_taskId, specPath);
      }
      // Delegates to worktree-utils.isWorktreeHealthy
      _isWorktreeHealthy(worktreePath) {
        return isWorktreeHealthy(worktreePath, this.projectRoot);
      }
      // Delegates to helpers.restoreQaReportFromSnapshot
      _restoreQaReportFromSnapshot(specPath) {
        restoreQaReportFromSnapshot(specPath);
      }
      // Delegates to helpers.restoreHumanFeedbackFromSnapshot
      _restoreHumanFeedbackFromSnapshot(specPath) {
        restoreHumanFeedbackFromSnapshot(specPath);
      }
      advancePhase(pipeline, phase, eventExtra) {
        pipelineAdvancePhase(pipeline, phase, this.taskStore, this.projectRoot, eventExtra);
      }
      waitForCompletion(sessionId) {
        return waitForCompletion(sessionId, { parseSessionLimitReset });
      }
      handleRateLimit(pipeline, resetsAt) {
        handleRateLimit(pipeline, resetsAt, {
          taskStore: this.taskStore,
          projectRoot: this.projectRoot,
          activeTasks: this.activeTasks,
          pipelines: this.pipelines,
          executePhase: (p) => this.executePhase(p),
          advancePhase: (p, phase) => this.advancePhase(p, phase),
          handleRateLimit: (p, r) => this.handleRateLimit(p, r)
        });
      }
      // Translate a host absolute path to the container-relative equivalent when
      // container mode is enabled. Used so message content sent to agents inside
      // the container references paths that actually exist there.
      _toAgentPath(hostPath) {
        if (readContainerConfig(this.projectRoot).enabled) {
          const info = containerManager.getRunningContainer(this.projectRoot);
          if (info) return hostToContainerPath(hostPath, this.projectRoot, info.remoteWorkspaceFolder);
        }
        return hostPath;
      }
      _execGit(args, hostCwd) {
        execGit(args, hostCwd, this.projectRoot);
      }
      // Delegates to worktree-utils.worktreeGitEnv
      _worktreeGitEnv(hostCwd, containerWs) {
        return worktreeGitEnv(hostCwd, this.projectRoot, containerWs);
      }
      // Delegates to worktree-utils.patchWorktreeGitFile
      _patchWorktreeGitFile(hostWorktreePath, containerWorkspace) {
        patchWorktreeGitFile(hostWorktreePath, containerWorkspace, this.projectRoot);
      }
      _restoreWorktreeGitFileToHostPaths(hostWorktreePath) {
        restoreWorktreeGitFileToHostPaths(hostWorktreePath, this.projectRoot);
      }
      restorePipeline(taskId, requiredPhase) {
        const task = this.taskStore.getById(taskId);
        if (!task || task.phase !== requiredPhase) {
          throw new Error(`Task ${taskId} is not ${requiredPhase}`);
        }
        const branch = task.branch ?? `feat/${slugify(task.description)}`;
        const slug = branch.replace(/^feat\//, "");
        const pipeline = {
          taskId,
          description: task.description,
          phase: requiredPhase,
          specPath: this.taskStore.getDirById(taskId),
          worktreePath: path14.join(this.getWorktreeBase(), slug),
          branch,
          qaAttempt: 0,
          maxQaAttempts: this.getPipelineConfig().maxQaAttempts,
          specRevision: 0
        };
        this.pipelines.set(taskId, pipeline);
        return pipeline;
      }
      getWorktreeBase() {
        return getWorktreeBase(this.projectRoot);
      }
      /**
       * Clean up artifacts from the given phase and beyond (inclusive).
       * Artifacts from phases BEFORE the given phase are kept as-is.
       * Called by stopTask before moving the task to backlog.
       */
      cleanupTaskArtifacts(taskId, currentPhase) {
        const dir = this.taskStore.getDirById(taskId);
        const pipelineOrder = ["spec", "plan", "implement", "qa-review", "merge"];
        const startIndex = pipelineOrder.indexOf(currentPhase);
        if (startIndex < 0) return;
        const outputPath = path14.join(dir, "output.log");
        try {
          if (existsSync17(outputPath)) unlinkSync7(outputPath);
        } catch {
        }
        const phaseFiles = {
          spec: ["spec.md", "plan.json"],
          plan: ["plan.json"],
          implement: [],
          "qa-review": ["qa_report.json", "qa_feedback.md", "completion_summary.md", "qa_report_before_bounce.json"],
          merge: []
        };
        for (let i = startIndex; i < pipelineOrder.length; i++) {
          const files = phaseFiles[pipelineOrder[i]];
          if (files) {
            for (const f of files) {
              const p = path14.join(dir, f);
              try {
                if (existsSync17(p)) unlinkSync7(p);
              } catch {
              }
            }
          }
        }
        if (startIndex >= pipelineOrder.indexOf("implement")) {
          const planPath = path14.join(dir, "plan.json");
          if (existsSync17(planPath)) {
            try {
              const plan = JSON.parse(readFileSync15(planPath, "utf-8"));
              if (plan.subtasks) {
                for (const s of plan.subtasks) s.completed = false;
              }
              writeFileSync13(planPath, JSON.stringify(plan, null, 2));
            } catch {
            }
          }
        }
        if (currentPhase === "plan") {
          this._removeWorktreeForce(taskId);
        } else if (currentPhase === "implement") {
          this._cleanWorktree(taskId);
        }
      }
      /**
       * Resume a stopped/backlog task — detect which phases have completed artifacts
       * and start from the next unfinished phase. Does NOT clear artifacts so completed
       * phases are fast-forwarded automatically.
       */
      async resumeTask(taskId) {
        const task = this.taskStore.getById(taskId);
        if (!task) throw new Error(`Task ${taskId} not found`);
        const dir = this.taskStore.getDirById(taskId);
        let startPhase;
        if (!NO_RESUME_PHASES.has(task.phase)) {
          startPhase = task.phase;
        } else if (task.phase === "awaiting-review" || task.phase === "pr-open") {
          throw new Error(
            `Task ${taskId} is in paused phase "${task.phase}" \u2014 use approve/reject instead of resume. If called from auto-mode, the adoption flow (_adoptStalledTasks) should have handled this task, not the tick loop.`
          );
        } else {
          const hasSpec = existsSync17(path14.join(dir, "spec.md"));
          const hasPlan = existsSync17(path14.join(dir, "plan.json"));
          if (hasPlan) {
            startPhase = "implement";
          } else if (hasSpec) {
            startPhase = "plan";
          } else {
            startPhase = "spec";
          }
        }
        const outputPath = path14.join(dir, "output.log");
        try {
          if (existsSync17(outputPath)) unlinkSync7(outputPath);
        } catch {
        }
        this._restoreQaReportFromSnapshot(dir);
        await this.runTask(taskId, task.description, startPhase);
      }
      /**
       * Clean up stale per-subtask worktrees from a previous crashed run (AC9).
       * Scans for directories matching <worktree-base>/<task-slug>-st* and removes them
       * along with their branches and git worktree metadata.
       */
      _cleanStaleSubtaskWorktrees(pipeline) {
        cleanStaleSubtaskWorktrees(pipeline, {
          execGit: (args, hostCwd) => this._execGit(args, hostCwd),
          projectRoot: this.projectRoot
        });
      }
      /** Get the filesystem path to this task's git worktree, or null if the task has no branch. */
      getWorktreePath(taskId) {
        return getWorktreePath(taskId, this.taskStore, getWorktreeBase(this.projectRoot));
      }
      /**
       * Remove the git worktree for this task if it exists on disk.
       * Tries a normal remove first; falls back to --force if there are uncommitted changes.
       * Always cleans up the branch and updates the task record so no stale state lingers.
       */
      removeWorktree(taskId) {
        removeWorktree(taskId, {
          execGit: (args, hostCwd) => this._execGit(args, hostCwd),
          projectRoot: this.projectRoot,
          taskStore: this.taskStore
        });
      }
      /** Force-remove the git worktree (discards uncommitted changes). Delegates to removeWorktree. */
      _removeWorktreeForce(taskId) {
        this.removeWorktree(taskId);
      }
      /** Discard all uncommitted changes in the worktree. Works on both host and container. */
      _cleanWorktree(taskId) {
        cleanWorktree(taskId, {
          execGit: (args, hostCwd) => this._execGit(args, hostCwd),
          projectRoot: this.projectRoot,
          taskStore: this.taskStore
        });
      }
      sessionOpts(role, cwd, taskId, logFile) {
        return buildSessionOpts(this.projectRoot, role, cwd, taskId, logFile);
      }
      _writeQaFeedback(pipeline, report) {
        writeQaFeedback(pipeline.specPath, report, pipeline.persistedCriterionFailCounts);
      }
      _writeCompletionSummary(pipeline) {
        writeCompletionSummary(pipeline.specPath, pipeline.qaAttempt, pipeline.taskId, this.taskStore);
      }
      _phaseHeader(logFile, phase) {
        phaseHeader(logFile, phase);
      }
      /** Schedule a wakeup timer (ADR 002). Follows the handleRateLimit setTimeout pattern. */
      _scheduleWakeup(pipeline) {
        const wakeupAt = new Date(pipeline.wakeupUntil).getTime();
        let waitMs = Math.max(wakeupAt - Date.now(), 0);
        if (waitMs === 0 && Date.now() - wakeupAt > 5 * 60 * 1e3) {
          waitMs = 5 * 60 * 1e3;
        }
        const MAX_DELAY_MS = 2147483647;
        waitMs = Math.min(waitMs, MAX_DELAY_MS);
        this.taskStore.update(pipeline.taskId, { wakeupUntil: pipeline.wakeupUntil, wakeupSubtaskId: pipeline.wakeupSubtaskId });
        processManager.emit("phase-change", { taskId: pipeline.taskId, phase: pipeline.phase, projectRoot: this.projectRoot, wakeupUntil: pipeline.wakeupUntil });
        this.activeTasks.add(pipeline.taskId);
        this.pipelines.set(pipeline.taskId, pipeline);
        const mins = Math.ceil(waitMs / 6e4);
        console.log(`[wakeup] Task ${pipeline.taskId} paused for ~${mins}min. Resuming at ${pipeline.wakeupUntil}`);
        setTimeout(async () => {
          const task = this.taskStore.getById(pipeline.taskId);
          if (!task || NO_RESUME_PHASES.has(task.phase)) {
            console.log(`[wakeup] Task ${pipeline.taskId} is in terminal phase "${task?.phase}" \u2014 skipping resume`);
            this.taskStore.update(pipeline.taskId, { wakeupUntil: void 0 });
            return;
          }
          const currentPipeline = this.pipelines.get(pipeline.taskId);
          if (currentPipeline !== pipeline) {
            console.log(`[wakeup] Task ${pipeline.taskId} pipeline was replaced \u2014 skipping stale resume`);
            this.taskStore.update(pipeline.taskId, { wakeupUntil: void 0 });
            return;
          }
          console.log(`[wakeup] Resuming task ${pipeline.taskId}`);
          this.taskStore.update(pipeline.taskId, { wakeupUntil: void 0 });
          try {
            await this.executePhase(pipeline);
          } catch (e) {
            const errMsg = e instanceof Error ? `${e.message}
${e.stack ?? ""}` : String(e);
            appendFileSync15(path14.join(pipeline.specPath, "output.log"), `
[ERROR] Task failed after wakeup: ${errMsg}
`);
            console.error(`[orchestrator] Task ${pipeline.taskId} failed after wakeup:`, e);
            this.advancePhase(pipeline, "failed");
          } finally {
            this.pipelines.delete(pipeline.taskId);
            this.activeTasks.delete(pipeline.taskId);
          }
        }, waitMs);
      }
      // Delegates to artifact-commit.commitArtifactsToWorktree
      _commitArtifactsToWorktree(pipeline) {
        commitArtifactsToWorktree(pipeline, {
          restoreWorktreeGitFileToHostPaths: (hostWorktreePath) => this._restoreWorktreeGitFileToHostPaths(hostWorktreePath),
          worktreeGitEnv: (hostCwd, containerWs) => this._worktreeGitEnv(hostCwd, containerWs)
        });
      }
      // Delegates to git-push.gitPush
      _gitPush(pushArgs, logFile) {
        gitPush(this.projectRoot, pushArgs, logFile);
      }
    };
    g = global;
    if (!g.__orchestrators) g.__orchestrators = /* @__PURE__ */ new Map();
    orchestrators = g.__orchestrators;
  }
});

// server.ts
init_process_manager();
init_container_manager();
import { createServer } from "http";
import { parse } from "url";
import next from "next";
import { WebSocketServer, WebSocket } from "ws";

// src/lib/recovery.ts
init_logger();
import { readFileSync as readFileSync16, readdirSync as readdirSync5, existsSync as existsSync18, statSync as statSync2, writeFileSync as writeFileSync14 } from "fs";
import { join as join5 } from "path";
import { homedir } from "os";
var IN_PROGRESS_PHASES = /* @__PURE__ */ new Set([
  "spec",
  "plan",
  "implement",
  "qa-review",
  "merge",
  "create-pr"
]);
function findInterruptedTasks() {
  const projects = _loadProjects();
  const interrupted = [];
  for (const project of projects) {
    if (_isDemoProject(project.path)) continue;
    const teamaiDir = join5(project.path, ".teamai");
    if (!existsSync18(teamaiDir)) continue;
    let entries = [];
    try {
      entries = readdirSync5(teamaiDir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const taskFile = join5(teamaiDir, entry, "task.json");
      if (!existsSync18(taskFile)) continue;
      try {
        const task = JSON.parse(readFileSync16(taskFile, "utf-8"));
        if (IN_PROGRESS_PHASES.has(task.phase)) {
          interrupted.push({
            taskId: task.id,
            title: task.title,
            phase: task.phase,
            projectPath: project.path,
            projectName: project.name,
            rateLimitedUntil: task.rateLimitedUntil
          });
        }
      } catch {
      }
    }
  }
  return interrupted;
}
function findOrphanedWorktrees() {
  const projects = _loadProjects();
  const orphaned = [];
  for (const project of projects) {
    const worktreesDir = join5(project.path, ".teamai", "worktrees");
    if (!existsSync18(worktreesDir)) continue;
    let entries = [];
    try {
      entries = readdirSync5(worktreesDir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const wtPath = join5(worktreesDir, entry);
      try {
        if (!statSync2(wtPath).isDirectory()) continue;
      } catch {
        continue;
      }
      const taskIdMatch = entry.match(/^task-(.+)$/);
      if (!taskIdMatch) continue;
      const taskId = taskIdMatch[1];
      const teamaiDir = join5(project.path, ".teamai");
      let taskFound = false;
      let taskActive = false;
      try {
        for (const taskDir of readdirSync5(teamaiDir)) {
          const taskFile = join5(teamaiDir, taskDir, "task.json");
          if (!existsSync18(taskFile)) continue;
          try {
            const task = JSON.parse(readFileSync16(taskFile, "utf-8"));
            if (task.id === taskId) {
              taskFound = true;
              taskActive = IN_PROGRESS_PHASES.has(task.phase);
              break;
            }
          } catch {
          }
        }
      } catch {
      }
      if (!taskFound || !taskActive) {
        orphaned.push({
          path: wtPath,
          projectPath: project.path,
          projectName: project.name
        });
      }
    }
  }
  return orphaned;
}
function autoClearExpiredRateLimits() {
  const projects = _loadProjects();
  let cleared = 0;
  for (const project of projects) {
    const teamaiDir = join5(project.path, ".teamai");
    if (!existsSync18(teamaiDir)) continue;
    let entries = [];
    try {
      entries = readdirSync5(teamaiDir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const taskFile = join5(teamaiDir, entry, "task.json");
      if (!existsSync18(taskFile)) continue;
      try {
        const raw = readFileSync16(taskFile, "utf-8");
        const task = JSON.parse(raw);
        if (task.rateLimitedUntil && new Date(task.rateLimitedUntil).getTime() <= Date.now()) {
          delete task.rateLimitedUntil;
          writeFileSync14(taskFile, JSON.stringify(task, null, 2));
          cleared++;
        }
      } catch {
      }
    }
  }
  return cleared;
}
function reconcileTaskArtifacts() {
  const projects = _loadProjects();
  const inconsistencies = [];
  const phaseRequirements = {
    plan: ["spec.md"],
    implement: ["spec.md", "plan.json"],
    "qa-review": ["spec.md", "plan.json"],
    merge: ["spec.md", "plan.json"],
    "create-pr": ["spec.md", "plan.json"]
  };
  for (const project of projects) {
    const teamaiDir = join5(project.path, ".teamai");
    if (!existsSync18(teamaiDir)) continue;
    let entries = [];
    try {
      entries = readdirSync5(teamaiDir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const taskFile = join5(teamaiDir, entry, "task.json");
      if (!existsSync18(taskFile)) continue;
      try {
        const task = JSON.parse(readFileSync16(taskFile, "utf-8"));
        const required = phaseRequirements[task.phase];
        if (!required) continue;
        for (const artifact of required) {
          const artifactPath = join5(teamaiDir, entry, artifact);
          if (!existsSync18(artifactPath)) {
            inconsistencies.push({
              taskId: task.id,
              title: task.title,
              phase: task.phase,
              projectPath: project.path,
              projectName: project.name,
              issue: `Missing required artifact '${artifact}' for phase '${task.phase}'`
            });
          }
        }
      } catch {
      }
    }
  }
  return inconsistencies;
}
var _lastAutoResumeTime = 0;
var AUTO_RESUME_DEBOUNCE_MS = 15e3;
var STALLED_TASK_THRESHOLD_MS = 30 * 6e4;
async function autoResumeInterruptedTasks() {
  const now = Date.now();
  if (now - _lastAutoResumeTime < AUTO_RESUME_DEBOUNCE_MS) {
    return 0;
  }
  _lastAutoResumeTime = now;
  const { getOrchestrator: getOrchestrator2 } = await Promise.resolve().then(() => (init_orchestrator(), orchestrator_exports));
  const interrupted = findInterruptedTasks();
  let resumed = 0;
  for (const task of interrupted) {
    try {
      const orchestrator = getOrchestrator2(task.projectPath);
      if (task.rateLimitedUntil) {
        const expiresAt = new Date(task.rateLimitedUntil).getTime();
        if (expiresAt > Date.now()) {
          console.log(`[auto-resume] Task ${task.taskId} "${task.title}" is still rate-limited until ${task.rateLimitedUntil} \u2014 skipping (will retry on expiry)`);
          continue;
        }
        console.log(`[auto-resume] Task ${task.taskId} "${task.title}" rate limit expired (was ${task.rateLimitedUntil}) \u2014 resuming`);
      }
      console.log(`[auto-resume] Resuming task ${task.taskId} "${task.title}" at phase ${task.phase} in ${task.projectName}`);
      orchestrator.resumeTask(task.taskId).catch((err) => {
        warn("auto-resume", `Task ${task.taskId} "${task.title}" failed to resume:`, err);
      });
      resumed++;
    } catch (err) {
      warn("auto-resume", `Failed to create orchestrator for ${task.projectPath}:`, err);
    }
  }
  return resumed;
}
function startupCleanup(staleSessionCount) {
  const interruptedTasks = findInterruptedTasks();
  const orphanedWorktrees = findOrphanedWorktrees();
  const autoClearedRateLimits = autoClearExpiredRateLimits();
  const artifactInconsistencies = reconcileTaskArtifacts();
  return {
    interruptedTasks,
    staleSessions: staleSessionCount,
    orphanedWorktrees,
    autoClearedRateLimits,
    artifactInconsistencies
  };
}
async function sweepStalledTasks() {
  const { getOrchestrator: getOrchestrator2 } = await Promise.resolve().then(() => (init_orchestrator(), orchestrator_exports));
  const { processManager: processManager2 } = await Promise.resolve().then(() => (init_process_manager(), process_manager_exports));
  const projects = _loadProjects();
  let resumed = 0;
  for (const project of projects) {
    if (_isDemoProject(project.path)) continue;
    const teamaiDir = join5(project.path, ".teamai");
    if (!existsSync18(teamaiDir)) continue;
    let entries = [];
    try {
      entries = readdirSync5(teamaiDir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const taskFile = join5(teamaiDir, entry, "task.json");
      if (!existsSync18(taskFile)) continue;
      try {
        const raw = readFileSync16(taskFile, "utf-8");
        const task = JSON.parse(raw);
        if (!IN_PROGRESS_PHASES.has(task.phase)) continue;
        if (task.rateLimitedUntil) {
          const expiresAt = new Date(task.rateLimitedUntil).getTime();
          if (expiresAt > Date.now()) continue;
          try {
            const orchestrator = getOrchestrator2(project.path);
            if (orchestrator.isTaskActive(task.id)) continue;
          } catch {
          }
          console.log(`[sweep] Task ${task.id} "${task.title}" has expired rate limit (was ${task.rateLimitedUntil}) \u2014 clearing and resuming`);
          delete task.rateLimitedUntil;
          try {
            writeFileSync14(taskFile, JSON.stringify(task, null, 2));
          } catch {
          }
        } else {
          try {
            const orchestrator = getOrchestrator2(project.path);
            if (orchestrator.isTaskActive(task.id)) continue;
          } catch {
          }
          const activeSession = processManager2.getAllSessions().find(
            (s) => s.taskId === task.id && s.status === "running"
          );
          if (activeSession) continue;
          const updatedAt = task.updatedAt ? new Date(task.updatedAt).getTime() : 0;
          const staleThreshold = Date.now() - STALLED_TASK_THRESHOLD_MS;
          if (updatedAt > staleThreshold) continue;
          console.log(`[sweep] Task ${task.id} "${task.title}" stalled >30min in phase "${task.phase}" \u2014 resuming`);
        }
        try {
          const orchestrator = getOrchestrator2(project.path);
          orchestrator.resumeTask(task.id).catch((err) => {
            warn("sweep", `Stalled task ${task.id} "${task.title}" failed to resume:`, err);
          });
          resumed++;
        } catch (err) {
          warn("sweep", `Failed to create orchestrator for ${project.path}:`, err);
        }
      } catch {
      }
    }
  }
  return resumed;
}
function _loadProjects() {
  const projectsFile = join5(homedir(), ".teamai", "projects.json");
  if (!existsSync18(projectsFile)) return [];
  try {
    return JSON.parse(readFileSync16(projectsFile, "utf-8"));
  } catch {
    return [];
  }
}
function _isDemoProject(projectPath) {
  try {
    const cfgPath = join5(projectPath, ".teamai", "pipeline.json");
    if (existsSync18(cfgPath)) {
      const cfg = JSON.parse(readFileSync16(cfgPath, "utf-8"));
      return cfg.demo === true;
    }
  } catch {
  }
  return false;
}

// src/lib/auto-mode.ts
init_task_store();
init_orchestrator();
init_process_manager();
import { execFileSync as execFileSync12 } from "child_process";
import { existsSync as existsSync20, readFileSync as readFileSync18, writeFileSync as writeFileSync16, mkdirSync as mkdirSync7 } from "fs";
import { join as join7 } from "path";

// src/lib/project-store.ts
import { readFileSync as readFileSync17, writeFileSync as writeFileSync15, mkdirSync as mkdirSync6, existsSync as existsSync19, cpSync, readdirSync as readdirSync6, renameSync as renameSync5, rmSync as rmSync6, appendFileSync as appendFileSync16 } from "fs";
import { join as join6 } from "path";
import { homedir as homedir2 } from "os";
import { createHash } from "crypto";
function resolveConfigDir() {
  if (process.env.TEAMAI_CONFIG_DIR) {
    return join6(process.env.TEAMAI_CONFIG_DIR, ".teamai");
  }
  try {
    const e2ePathFile = join6(process.cwd(), ".teamai-e2e-config-path");
    if (existsSync19(e2ePathFile)) {
      const dir = readFileSync17(e2ePathFile, "utf-8").trim();
      if (dir) return join6(dir, ".teamai");
    }
  } catch {
  }
  return join6(homedir2(), ".teamai");
}
var CONFIG_DIR = resolveConfigDir();
var PROJECTS_FILE = join6(CONFIG_DIR, "projects.json");
var BACKUP_FILE = PROJECTS_FILE + ".backup";
var TMP_FILE = PROJECTS_FILE + ".tmp";
var DEFAULTS_DIR3 = join6(process.cwd(), "defaults");
var ProjectStore = class {
  constructor() {
    mkdirSync6(CONFIG_DIR, { recursive: true });
    this._restoreFromBackup();
  }
  getAll() {
    try {
      return JSON.parse(readFileSync17(PROJECTS_FILE, "utf-8"));
    } catch {
      return [];
    }
  }
  getByPath(projectPath) {
    return this.getAll().find((p) => p.path === projectPath) || null;
  }
  /**
   * Register a new project. Scaffolds .claude/roles/, .claude/commands/,
   * .teamai/, and CLAUDE.md with defaults if they don't already exist.
   */
  add(projectPath, name) {
    const projects = this.getAll();
    const existing = projects.find((p) => p.path === projectPath);
    if (existing) throw new Error("already_registered");
    this.scaffold(projectPath);
    const project = {
      name: name || projectPath.split(/[\\/]/).pop() || projectPath,
      path: projectPath,
      addedAt: (/* @__PURE__ */ new Date()).toISOString()
    };
    projects.push(project);
    this._atomicWrite(() => projects);
    return project;
  }
  remove(projectPath) {
    const projects = this.getAll().filter((p) => p.path !== projectPath);
    this._atomicWrite(() => projects);
  }
  // ── Atomic write helpers ─────────────────────────────────────────
  /**
   * Write projects atomically: backup → temp file → rename → cleanup.
   * If the process crashes mid-write, the real file is untouched and
   * the next startup restores from the backup.
   */
  _atomicWrite(compute) {
    if (existsSync19(PROJECTS_FILE)) {
      writeFileSync15(BACKUP_FILE, readFileSync17(PROJECTS_FILE, "utf-8"));
    }
    writeFileSync15(TMP_FILE, JSON.stringify(compute(), null, 2));
    renameSync5(TMP_FILE, PROJECTS_FILE);
    try {
      rmSync6(BACKUP_FILE);
    } catch {
    }
  }
  /**
   * Check for a leftover backup from a crashed write and restore it.
   * Called once at startup so the user's project registry is never
   * left in a corrupted or partially-modified state.
   */
  _restoreFromBackup() {
    if (!existsSync19(BACKUP_FILE)) return;
    try {
      writeFileSync15(PROJECTS_FILE, readFileSync17(BACKUP_FILE, "utf-8"));
      rmSync6(BACKUP_FILE);
    } catch {
    }
  }
  // ── Defaults version tracking ────────────────────────────────────
  /** Manifest path for tracking which default versions were copied to a project. */
  _manifestPath(projectPath) {
    return join6(projectPath, ".claude", ".teamai-scaffold.json");
  }
  /** Compute a SHA-256 checksum for content comparison. */
  _computeChecksum(content) {
    return "sha256:" + createHash("sha256").update(content).digest("hex").slice(0, 16);
  }
  /**
   * Compute checksums for all default files that get copied into .claude/.
   * Returns a map of relative-path → checksum.
   */
  _getDefaultsManifest() {
    const manifest = {};
    const scanDirs = [
      { src: join6(DEFAULTS_DIR3, "commands"), prefix: "commands" }
    ];
    for (const { src, prefix } of scanDirs) {
      if (!existsSync19(src)) continue;
      for (const file of readdirSync6(src)) {
        const relPath = `${prefix}/${file}`;
        manifest[relPath] = this._computeChecksum(readFileSync17(join6(src, file), "utf-8"));
      }
    }
    const workflowSrc = join6(DEFAULTS_DIR3, "teamai-workflow.md");
    if (existsSync19(workflowSrc)) {
      manifest["teamai-workflow.md"] = this._computeChecksum(readFileSync17(workflowSrc, "utf-8"));
    }
    return manifest;
  }
  /**
   * Ensure the project's .gitignore excludes transient TeamAI files that
   * should never be version-controlled (sensitive terminal output, crash-
   * recovery state). Appends entries only if they are not already present.
   */
  _updateGitignore(projectPath) {
    const gitignorePath = join6(projectPath, ".gitignore");
    const TEAMAI_PATTERNS = [".teamai/*"];
    const buildBlock = (patterns) => "# TeamAI \u2014 exclude transient pipeline files\n" + patterns.join("\n") + "\n";
    if (!existsSync19(gitignorePath)) {
      try {
        writeFileSync15(gitignorePath, buildBlock(TEAMAI_PATTERNS));
      } catch {
      }
      return;
    }
    try {
      const existing = readFileSync17(gitignorePath, "utf-8");
      const lines = existing.split("\n");
      const missing = TEAMAI_PATTERNS.filter(
        (pattern) => !lines.some((line) => line.trim() === pattern)
      );
      if (missing.length === 0) return;
      const separator = existing.endsWith("\n") ? "" : "\n";
      appendFileSync16(gitignorePath, separator + "\n" + buildBlock(missing));
    } catch {
    }
  }
  /**
   * Sync default files in a project that have NOT been customized.
   * If a default file was updated in TeamAI and the project's copy still
   * matches the old default (i.e., was never customized), update it.
   *
   * When `dryRun` is true, computes what WOULD be updated but does not
   * write any files. Returns the list of file paths that were (or would
   * be) updated.
   */
  syncDefaults(projectPath, dryRun = false) {
    const updated = [];
    const manifestPath = this._manifestPath(projectPath);
    let storedManifest = {};
    if (existsSync19(manifestPath)) {
      try {
        const parsed = JSON.parse(readFileSync17(manifestPath, "utf-8"));
        if (parsed.files) storedManifest = parsed.files;
      } catch {
      }
    }
    const currentManifest = this._getDefaultsManifest();
    const newManifest = { ...storedManifest };
    for (const [relPath, currentChecksum] of Object.entries(currentManifest)) {
      const storedChecksum = storedManifest[relPath];
      if (!storedChecksum) {
        const destFile = join6(projectPath, ".claude", relPath);
        if (!existsSync19(destFile)) {
          if (!dryRun) {
            const srcFile = join6(DEFAULTS_DIR3, relPath);
            if (existsSync19(srcFile)) cpSync(srcFile, destFile);
          }
          newManifest[relPath] = currentChecksum;
          updated.push(relPath);
        } else {
          const projectChecksum2 = this._computeChecksum(readFileSync17(destFile, "utf-8"));
          if (projectChecksum2 === currentChecksum) {
            newManifest[relPath] = currentChecksum;
          } else {
            newManifest[relPath] = projectChecksum2;
            updated.push(relPath);
          }
        }
        continue;
      }
      if (storedChecksum === currentChecksum) {
        continue;
      }
      const projectFile = join6(projectPath, ".claude", relPath);
      if (!existsSync19(projectFile)) {
        if (!dryRun) {
          const srcFile = join6(DEFAULTS_DIR3, relPath);
          if (existsSync19(srcFile)) cpSync(srcFile, projectFile);
        }
        updated.push(relPath);
        newManifest[relPath] = currentChecksum;
        continue;
      }
      const projectChecksum = this._computeChecksum(readFileSync17(projectFile, "utf-8"));
      if (projectChecksum === storedChecksum) {
        if (!dryRun) {
          const srcFile = join6(DEFAULTS_DIR3, relPath);
          if (existsSync19(srcFile)) cpSync(srcFile, projectFile);
        }
        updated.push(relPath);
        newManifest[relPath] = currentChecksum;
      } else {
        newManifest[relPath] = currentChecksum;
      }
    }
    if (!dryRun && (updated.length > 0 || Object.keys(storedManifest).length === 0)) {
      try {
        writeFileSync15(manifestPath, JSON.stringify({ version: 1, files: newManifest }, null, 2));
      } catch (err) {
        console.error(`[ProjectStore] Failed to write scaffold manifest at ${manifestPath}:`, err);
      }
    }
    return updated;
  }
  /**
   * Check all registered projects for stale default files that could be
   * updated. Uses a dry-run of syncDefaults for each project.
   * Returns only projects that have at least one outdated file.
   */
  getStaleDefaults() {
    const results = [];
    for (const project of this.getAll()) {
      const outdated = this.syncDefaults(project.path, true);
      if (outdated.length > 0) {
        results.push({
          projectName: project.name,
          projectPath: project.path,
          outdatedFiles: outdated
        });
      }
    }
    return results;
  }
  /**
   * Copy default roles and commands into the target project
   * if they don't already exist. Never overwrites existing files.
   */
  scaffold(projectPath) {
    const targets = [
      { src: join6(DEFAULTS_DIR3, "roles"), dest: join6(projectPath, ".claude", "roles") },
      { src: join6(DEFAULTS_DIR3, "commands"), dest: join6(projectPath, ".claude", "commands") }
    ];
    for (const { src, dest } of targets) {
      mkdirSync6(dest, { recursive: true });
      for (const file of readdirSync6(src)) {
        const destFile = join6(dest, file);
        if (!existsSync19(destFile)) {
          cpSync(join6(src, file), destFile);
        }
      }
    }
    mkdirSync6(join6(projectPath, ".teamai"), { recursive: true });
    const pipelineDest = join6(projectPath, ".teamai", "pipeline.json");
    if (!existsSync19(pipelineDest)) {
      cpSync(join6(DEFAULTS_DIR3, "pipeline.json"), pipelineDest);
    }
    const providersDest = join6(projectPath, ".teamai", "providers.json");
    if (!existsSync19(providersDest)) {
      cpSync(join6(DEFAULTS_DIR3, "providers.json"), providersDest);
    }
    const workflowDest = join6(projectPath, ".claude", "teamai-workflow.md");
    if (!existsSync19(workflowDest)) {
      cpSync(join6(DEFAULTS_DIR3, "teamai-workflow.md"), workflowDest);
    }
    const IMPORT_LINE = "@.claude/teamai-workflow.md";
    const claudeMdPath = join6(projectPath, "CLAUDE.md");
    if (!existsSync19(claudeMdPath)) {
      writeFileSync15(claudeMdPath, IMPORT_LINE + "\n");
    } else {
      const content = readFileSync17(claudeMdPath, "utf-8");
      if (!content.includes(IMPORT_LINE)) {
        writeFileSync15(claudeMdPath, IMPORT_LINE + "\n" + content);
      }
    }
    this._updateGitignore(projectPath);
    this.syncDefaults(projectPath);
  }
};
var projectStore = new ProjectStore();

// src/lib/auto-mode.ts
var projectStates = global.__autoModeProjectStates ?? (global.__autoModeProjectStates = /* @__PURE__ */ new Map());
function autoModeStatePath(projectRoot) {
  return join7(projectRoot, ".teamai", "auto-mode.json");
}
function saveAutoModeState(projectRoot, state) {
  try {
    mkdirSync7(join7(projectRoot, ".teamai"), { recursive: true });
    writeFileSync16(autoModeStatePath(projectRoot), JSON.stringify({
      enabled: state.enabled,
      maxParallel: state.maxParallel
    }, null, 2));
  } catch {
  }
}
function loadAutoModeState(projectRoot) {
  try {
    const p = autoModeStatePath(projectRoot);
    if (!existsSync20(p)) return null;
    return JSON.parse(readFileSync18(p, "utf-8"));
  } catch {
    return null;
  }
}
function getState(projectRoot) {
  let state = projectStates.get(projectRoot);
  if (!state) {
    state = {
      enabled: false,
      maxParallel: 1,
      autoApprovedIds: /* @__PURE__ */ new Set(),
      startingIds: /* @__PURE__ */ new Set(),
      tickTimer: null,
      ciPollTimers: /* @__PURE__ */ new Map(),
      eventCleanup: null
    };
    projectStates.set(projectRoot, state);
  }
  return state;
}
function setAutoModeState(projectRoot, enabled, maxParallel = 1) {
  const state = getState(projectRoot);
  const changed = enabled !== state.enabled || maxParallel !== state.maxParallel;
  state.maxParallel = maxParallel;
  if (changed) {
    if (enabled) {
      _start(projectRoot, state);
    } else {
      _stop(state);
    }
  }
  saveAutoModeState(projectRoot, state);
}
function _isDemoProject2(projectRoot) {
  try {
    const cfgPath = join7(projectRoot, ".teamai", "pipeline.json");
    if (existsSync20(cfgPath)) {
      const cfg = JSON.parse(readFileSync18(cfgPath, "utf-8"));
      return cfg.demo === true;
    }
  } catch {
  }
  return false;
}
var TERMINAL_PHASES = /* @__PURE__ */ new Set(["backlog", "done", "failed"]);
var PAUSED_PHASES = /* @__PURE__ */ new Set(["awaiting-review", "pr-open", "create-pr"]);
function _start(projectRoot, state) {
  if (state.enabled) return;
  state.enabled = true;
  const onPhaseChange = ({ taskId, phase, projectRoot: eventProject }) => {
    if (eventProject !== projectRoot || !state.enabled) return;
    if (phase === "awaiting-review") {
      _autoApprove(taskId, projectRoot, state);
    } else if (phase === "pr-open") {
      state.autoApprovedIds.delete(taskId);
      _startCIPolling(taskId, projectRoot, state);
    }
    if (phase !== "backlog" && state.startingIds.has(taskId)) {
      state.startingIds.delete(taskId);
    }
  };
  processManager.on("phase-change", onPhaseChange);
  state.eventCleanup = () => processManager.off("phase-change", onPhaseChange);
  state.tickTimer = setInterval(() => _tick(projectRoot, state), 5e3);
  _adoptStalledTasks(projectRoot, state);
  _tick(projectRoot, state);
  console.log(`[auto-mode] Started for ${projectRoot} (max parallel: ${state.maxParallel})`);
}
function _autoApprove(taskId, projectRoot, state) {
  if (state.autoApprovedIds.has(taskId)) return;
  state.autoApprovedIds.add(taskId);
  try {
    new TaskStore(projectRoot).update(taskId, { autoProcessed: true });
  } catch {
  }
  getOrchestrator(projectRoot).approveTask(taskId, "pull-request").catch((err) => {
    console.error(`[auto-mode] Failed to auto-approve task ${taskId}:`, err);
    state.autoApprovedIds.delete(taskId);
  });
}
function _adoptStalledTasks(projectRoot, state) {
  if (_isDemoProject2(projectRoot)) return;
  let taskStore;
  try {
    taskStore = new TaskStore(projectRoot);
  } catch {
    return;
  }
  const allTasks = taskStore.getAll();
  let adopted = 0;
  for (const task of allTasks) {
    if (task.phase === "awaiting-review") {
      adopted++;
      _autoApprove(task.id, projectRoot, state);
    } else if (task.phase === "pr-open") {
      adopted++;
      _startCIPolling(task.id, projectRoot, state);
    }
  }
  if (adopted > 0) {
    console.log(`[auto-mode] Re-adopted ${adopted} stalled task(s) in paused phases`);
  }
}
function _stop(state) {
  state.enabled = false;
  if (state.tickTimer) {
    clearInterval(state.tickTimer);
    state.tickTimer = null;
  }
  if (state.eventCleanup) {
    state.eventCleanup();
    state.eventCleanup = null;
  }
  for (const timer of state.ciPollTimers.values()) {
    clearInterval(timer);
  }
  state.ciPollTimers.clear();
  state.autoApprovedIds.clear();
  state.startingIds.clear();
  console.log("[auto-mode] Stopped");
}
function _tick(projectRoot, state) {
  if (!state.enabled) return;
  if (_isDemoProject2(projectRoot)) return;
  let taskStore;
  try {
    taskStore = new TaskStore(projectRoot);
  } catch {
    return;
  }
  const allTasks = taskStore.getAll();
  const activeCount = allTasks.filter(
    (t) => !TERMINAL_PHASES.has(t.phase) && !PAUSED_PHASES.has(t.phase)
  ).length;
  if (activeCount >= state.maxParallel) return;
  const slots = state.maxParallel - activeCount;
  if (slots <= 0) return;
  const eligible = allTasks.filter((t) => {
    if (t.phase !== "backlog") return false;
    if (state.startingIds.has(t.id)) return false;
    if (!t.dependencies || t.dependencies.length === 0) return true;
    return t.dependencies.every((depId) => {
      const dep = allTasks.find((dt) => dt.id === depId);
      return dep && dep.phase === "done";
    });
  });
  if (eligible.length === 0) return;
  eligible.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const toStart = eligible.slice(0, slots);
  for (const task of toStart) {
    state.startingIds.add(task.id);
    const orchestrator = getOrchestrator(projectRoot);
    orchestrator.resumeTask(task.id).catch((err) => {
      console.error(`[auto-mode] Failed to start task ${task.id}:`, err);
      state.startingIds.delete(task.id);
    });
    console.log(`[auto-mode] Started task: ${task.title} (${task.id})`);
  }
}
function _startCIPolling(taskId, projectRoot, state) {
  if (state.ciPollTimers.has(taskId)) return;
  const taskStore = new TaskStore(projectRoot);
  const task = taskStore.getById(taskId);
  if (!task?.prUrl) return;
  const prMatch = task.prUrl.match(/\/pull\/(\d+)/);
  if (!prMatch) return;
  const prNumber = prMatch[1];
  console.log(`[auto-mode] Starting CI polling for PR #${prNumber} (task ${taskId})`);
  const timer = setInterval(() => {
    if (!state.enabled) {
      clearInterval(timer);
      state.ciPollTimers.delete(taskId);
      return;
    }
    try {
      const currentTask = new TaskStore(projectRoot).getById(taskId);
      if (!currentTask || currentTask.phase !== "pr-open") {
        clearInterval(timer);
        state.ciPollTimers.delete(taskId);
        return;
      }
      const prData = JSON.parse(execFileSync12("gh", [
        "pr",
        "view",
        prNumber,
        "--json",
        "state,statusCheckRollup"
      ], { cwd: projectRoot, encoding: "utf-8", stdio: "pipe", timeout: 1e4 }));
      if (prData.state === "MERGED") {
        clearInterval(timer);
        state.ciPollTimers.delete(taskId);
        _finishTask(taskId, projectRoot, state);
        return;
      }
      if (prData.state !== "OPEN") {
        clearInterval(timer);
        state.ciPollTimers.delete(taskId);
        console.log(`[auto-mode] PR #${prNumber} closed without merge \u2014 stopping CI poll`);
        return;
      }
      const checks = prData.statusCheckRollup ?? [];
      const allPassed = checks.length > 0 && checks.every(
        (c) => c.conclusion === "SUCCESS" || c.conclusion === "NEUTRAL" || c.conclusion === "SKIPPED"
      );
      if (allPassed) {
        console.log(`[auto-mode] All CI checks passed for PR #${prNumber} \u2014 auto-merging`);
        clearInterval(timer);
        state.ciPollTimers.delete(taskId);
        try {
          execFileSync12("gh", ["pr", "merge", prNumber, "--merge"], {
            cwd: projectRoot,
            encoding: "utf-8",
            stdio: "pipe",
            timeout: 15e3
          });
          console.log(`[auto-mode] PR #${prNumber} merged successfully`);
        } catch (mergeErr) {
          const msg = mergeErr instanceof Error ? mergeErr.message : String(mergeErr);
          console.error(`[auto-mode] Failed to merge PR #${prNumber}: ${msg}`);
          return;
        }
        _finishTask(taskId, projectRoot, state);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[auto-mode] CI poll error for PR #${prNumber}: ${msg}`);
    }
  }, 3e4);
  state.ciPollTimers.set(taskId, timer);
}
function _finishTask(taskId, projectRoot, _state) {
  const taskStore = new TaskStore(projectRoot);
  taskStore.update(taskId, { autoProcessed: true });
  const orchestrator = getOrchestrator(projectRoot);
  orchestrator.markTaskDone(taskId).then(() => {
    console.log(`[auto-mode] Task ${taskId} marked as done (auto-processed)`);
  }).catch((err) => {
    console.error(`[auto-mode] Failed to mark task ${taskId} as done:`, err);
  });
}
function restoreAutoModeStates() {
  let projects;
  try {
    projects = projectStore.getAll();
  } catch {
    return 0;
  }
  let restored = 0;
  for (const project of projects) {
    const saved = loadAutoModeState(project.path);
    if (!saved || !saved.enabled) continue;
    const existing = projectStates.get(project.path);
    if (existing?.enabled) continue;
    console.log(`[auto-mode] Restoring auto mode for ${project.name} (max parallel: ${saved.maxParallel})`);
    setAutoModeState(project.path, true, saved.maxParallel);
    restored++;
  }
  return restored;
}

// server.ts
init_logger();
var app = next({ dev: process.env.NODE_ENV !== "production" });
var handle = app.getRequestHandler();
app.prepare().then(() => {
  const server = createServer((req, res) => {
    handle(req, res, parse(req.url, true));
  });
  const wss = new WebSocketServer({ noServer: true });
  function broadcastToProject(event, msg) {
    const eventProject = typeof event.projectRoot === "string" ? event.projectRoot : void 0;
    for (const client of wss.clients) {
      const pws = client;
      if (pws.readyState !== WebSocket.OPEN) continue;
      if (!pws.projectRoot || !eventProject || pws.projectRoot === eventProject) {
        pws.send(msg);
      }
    }
  }
  wss.on("connection", (ws) => {
    const agentHandler = ({ sessionId, event }) => {
      const taskId = processManager.getSession(sessionId)?.taskId;
      ws.send(JSON.stringify({ sessionId, taskId, event }));
    };
    processManager.on("event", agentHandler);
    processManager.on("error", agentHandler);
    const terminalHandler = ({ sessionId, data }) => {
      ws.send(JSON.stringify({ type: "terminal", sessionId, data }));
    };
    processManager.on("terminal-data", terminalHandler);
    ws.on("message", (msg) => {
      try {
        const parsed = JSON.parse(msg.toString());
        if (parsed.type === "terminal-input") {
          processManager.writeToTerminal(parsed.sessionId, parsed.data);
        } else if (parsed.type === "terminal-resize") {
          processManager.resizeTerminal(parsed.sessionId, parsed.cols, parsed.rows);
        }
      } catch (err) {
        error("ws", "Failed to parse client message", err);
      }
    });
    ws.on("close", () => {
      processManager.off("event", agentHandler);
      processManager.off("error", agentHandler);
      processManager.off("terminal-data", terminalHandler);
    });
  });
  processManager.on("phase-change", (data) => {
    const msg = JSON.stringify({ type: "phase-change", taskId: data.taskId, phase: data.phase, prUrl: data.prUrl, platform: data.platform });
    broadcastToProject(data, msg);
  });
  containerManager.on("container-state", (data) => {
    const msg = JSON.stringify({ type: "container-state", projectRoot: data.projectRoot, state: data.state });
    broadcastToProject(data, msg);
  });
  containerManager.on("container-log", (data) => {
    const msg = JSON.stringify({ type: "container-log", projectRoot: data.projectRoot, message: data.message });
    broadcastToProject(data, msg);
  });
  containerManager.on("container-validation", (data) => {
    const msg = JSON.stringify({ type: "container-validation", projectRoot: data.projectRoot, step: data.step });
    broadcastToProject(data, msg);
  });
  server.on("upgrade", (request, socket, head) => {
    const reqUrl = new URL(request.url, `http://${request.headers.host || "127.0.0.1:3000"}`);
    const pathname = reqUrl.pathname;
    const project = reqUrl.searchParams.get("project");
    if (pathname === "/ws") {
      wss.handleUpgrade(request, socket, head, (client) => {
        if (typeof project === "string") {
          client.projectRoot = project;
        }
        wss.emit("connection", client, request);
      });
    }
  });
  const host = process.env.HOST || "0.0.0.0";
  process.on("unhandledRejection", (reason) => {
    error("server", "Unhandled rejection", reason instanceof Error ? reason : String(reason));
  });
  process.on("uncaughtException", (err) => {
    error("server", "Uncaught exception", err);
  });
  server.listen(3e3, host, () => {
    console.log(`> Ready on http://${host}:3000`);
    const staleSessions = processManager.getStaleSessions();
    const report = startupCleanup(staleSessions.length);
    const parts = [];
    if (report.interruptedTasks.length > 0) {
      parts.push(`${report.interruptedTasks.length} interrupted task(s)`);
    }
    if (report.staleSessions > 0) {
      parts.push(`${report.staleSessions} stale session(s)`);
    }
    if (report.orphanedWorktrees.length > 0) {
      parts.push(`${report.orphanedWorktrees.length} orphaned worktree(s)`);
    }
    if (report.autoClearedRateLimits > 0) {
      parts.push(`${report.autoClearedRateLimits} expired rate limit(s) auto-cleared`);
    }
    if (report.artifactInconsistencies.length > 0) {
      parts.push(`${report.artifactInconsistencies.length} artifact inconsistency(s)`);
    }
    if (parts.length > 0) {
      console.log(`[recovery] ${parts.join(", ")} detected:`);
      for (const t of report.interruptedTasks) {
        console.log(`  \u2022 interrupted: ${t.title} (${t.phase}) in ${t.projectName}`);
      }
      for (const s of staleSessions) {
        console.log(`  \u2022 stale session: ${s.id.substring(0, 8)}\u2026 task=${s.taskId} role=${s.role}`);
        processManager.removeStaleSession(s.id);
      }
      for (const w of report.orphanedWorktrees) {
        console.log(`  \u2022 orphaned worktree: ${w.path}`);
      }
      for (const a of report.artifactInconsistencies) {
        console.log(`  \u2022 artifact inconsistency: ${a.title} (${a.phase}) in ${a.projectName} \u2014 ${a.issue}`);
      }
    } else {
      console.log("[recovery] clean \u2014 no stale state detected");
    }
    if (report.interruptedTasks.length > 0) {
      autoResumeInterruptedTasks().then((count) => {
        console.log(`[auto-resume] Queued ${count} interrupted task(s) for resumption`);
      }).catch((err) => {
        error("auto-resume", "Failed to auto-resume interrupted tasks", err);
      });
    }
    try {
      const restored = restoreAutoModeStates();
      if (restored > 0) {
        console.log(`[auto-mode] Restored auto mode for ${restored} project(s) from disk`);
      }
    } catch (err) {
      error("auto-mode", "Failed to restore auto-mode states from disk", err);
    }
    const SWEEP_INTERVAL_MS = 5 * 6e4;
    setInterval(() => {
      sweepStalledTasks().then((count) => {
        if (count > 0) {
          console.log(`[sweep] Re-queued ${count} stalled task(s)`);
        }
      }).catch((err) => {
        error("sweep", "Periodic stall-detection sweep failed", err);
      });
    }, SWEEP_INTERVAL_MS);
  });
  containerManager.on("container-state", (data) => {
    if (data.state === "running") {
      console.log(`[auto-resume] Container for ${data.projectRoot} became available \u2014 checking for interrupted tasks`);
      autoResumeInterruptedTasks().then((count) => {
        if (count > 0) {
          console.log(`[auto-resume] Queued ${count} interrupted task(s) after container became available`);
        }
      }).catch((err) => {
        error("auto-resume", "Failed to auto-resume after container became available", err);
      });
    }
  });
});
