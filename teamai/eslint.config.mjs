import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

/** Custom rules for useServerMutation migration enforcement. */
const localPlugin = {
  rules: {
    /**
     * Detects the pattern `useState(false)` + `useEffect(() => {...}, [])`
     * where the effect async-fetches the real state on mount.
     *
     * Antipattern:
     *   const [enabled, setEnabled] = useState(false);
     *   useEffect(() => { fetchState().then(s => setEnabled(s.enabled)); }, []);
     *
     * Correct pattern: pass initial state as a server prop.
     *   // Server component: <Button initialEnabled={state.enabled} />
     *   // Client component: const [enabled, setEnabled] = useState(initialEnabled);
     */
    "no-async-fetch-on-mount": {
      meta: {
        type: "suggestion",
        docs: {
          description:
            "Prevent useState(false) + useEffect(() => ..., []) async-fetch-on-mount antipattern",
        },
      },
      create(context) {
        // Track useState calls with literal initializers: { setterName, node }
        const stateDecls = [];
        // Track mount effects that perform async work
        const mountEffectsWithAsync = [];

        function isLiteral(node) {
          return (
            node.type === "Literal" ||
            node.type === "TemplateLiteral" ||
            (node.type === "Identifier" &&
              (node.name === "undefined" || node.name === "null"))
          );
        }

        /** Check if a node or its descendants contain an async operation. */
        function containsAsyncOperation(node) {
          if (!node) return false;
          // await expression
          if (node.type === "AwaitExpression") return true;
          // .then() / .catch() / .finally() calls
          if (
            node.type === "CallExpression" &&
            node.callee.type === "MemberExpression" &&
            (node.callee.property.name === "then" ||
              node.callee.property.name === "catch" ||
              node.callee.property.name === "finally")
          ) {
            return true;
          }
          // Generic recursion: only recurse into nodes that could contain async
          // expressions (skip literals, identifiers to avoid O(n²))
          for (const key of Object.keys(node)) {
            if (key === "parent" || key === "range" || key === "loc") continue;
            const child = node[key];
            if (Array.isArray(child)) {
              for (const c of child) {
                if (c && typeof c.type === "string" && containsAsyncOperation(c))
                  return true;
              }
            } else if (child && typeof child.type === "string") {
              if (containsAsyncOperation(child)) return true;
            }
          }
          return false;
        }

        /** Check if a node or its descendants call `name` as a function. */
        function callsSetter(node, name) {
          if (!node) return false;
          if (
            node.type === "CallExpression" &&
            node.callee.type === "Identifier" &&
            node.callee.name === name
          ) {
            return true;
          }
          for (const key of Object.keys(node)) {
            if (key === "parent" || key === "range" || key === "loc") continue;
            const child = node[key];
            if (Array.isArray(child)) {
              for (const c of child) {
                if (c && typeof c.type === "string" && callsSetter(c, name))
                  return true;
              }
            } else if (child && typeof child.type === "string") {
              if (callsSetter(child, name)) return true;
            }
          }
          return false;
        }

        return {
          // Match: const [x, setX] = useState(literalValue)
          VariableDeclarator(node) {
            if (
              node.init &&
              node.init.type === "CallExpression" &&
              node.init.callee.type === "Identifier" &&
              node.init.callee.name === "useState" &&
              node.init.arguments.length === 1 &&
              isLiteral(node.init.arguments[0]) &&
              node.id.type === "ArrayPattern" &&
              node.id.elements.length === 2 &&
              node.id.elements[1].type === "Identifier"
            ) {
              stateDecls.push({
                setter: node.id.elements[1].name,
                node,
              });
            }
          },

          // Match: useEffect(() => { ... }, [])
          CallExpression(node) {
            if (
              node.callee.type === "Identifier" &&
              node.callee.name === "useEffect" &&
              node.arguments.length >= 2 &&
              node.arguments[0].type === "ArrowFunctionExpression"
            ) {
              const deps = node.arguments[1];
              // Empty dependency array: useEffect(..., [])
              if (
                deps &&
                deps.type === "ArrayExpression" &&
                deps.elements.length === 0
              ) {
                const body = node.arguments[0].body;
                if (containsAsyncOperation(body)) {
                  mountEffectsWithAsync.push({ node, body });
                }
              }
            }
          },

          "Program:exit"() {
            // Cross-reference: for each mount effect with async work,
            // check if it calls any setter from a useState(literal)
            for (const effect of mountEffectsWithAsync) {
              for (const decl of stateDecls) {
                if (callsSetter(effect.body, decl.setter)) {
                  context.report({
                    node: decl.node,
                    message:
                      `useState(literal) + useEffect(async, []) antipattern detected. ` +
                      `The state "${decl.setter}" is initialised with a literal default then ` +
                      `async-fetched in a mount effect — it will reset on router.refresh(). ` +
                      `Pass the initial value as a server prop instead (e.g. <Comp initialX={val} />).`,
                  });
                }
              }
            }
          },
        };
      },
    },
    "no-useTransition-useRouter": {
      meta: { type: "suggestion" },
      create(context) {
        let transitionNode = null;
        let hasUseRouter = false;

        return {
          ImportDeclaration(node) {
            if (
              node.source.value === 'react' &&
              node.specifiers.some(s => s.imported?.name === 'useTransition')
            ) {
              transitionNode = node;
            }
            if (
              (node.source.value === 'next/navigation' ||
               node.source.value === 'next/router') &&
              node.specifiers.some(s => s.imported?.name === 'useRouter')
            ) {
              hasUseRouter = true;
            }
          },
          "Program:exit"() {
            if (transitionNode && hasUseRouter) {
              context.report({
                node: transitionNode,
                message:
                  'useTransition + useRouter detected — use the useServerMutation hook instead.',
              });
            }
          },
        };
      },
    },
    "no-raw-router-refresh": {
      meta: { type: "suggestion" },
      create(context) {
        let hasRefreshCall = false;
        let refreshNode = null;
        let hasUseServerMutation = false;
        let refreshFromUseRouter = false;

        return {
          CallExpression(node) {
            // router.refresh() member expression
            if (
              node.callee.type === 'MemberExpression' &&
              node.callee.object.type === 'Identifier' &&
              node.callee.object.name === 'router' &&
              node.callee.property.type === 'Identifier' &&
              node.callee.property.name === 'refresh'
            ) {
              hasRefreshCall = true;
              refreshNode = node;
            }
            // destructured refresh() from useRouter()
            if (
              refreshFromUseRouter &&
              node.callee.type === 'Identifier' &&
              node.callee.name === 'refresh'
            ) {
              hasRefreshCall = true;
              if (!refreshNode) refreshNode = node;
            }
          },
          // Detect const { refresh } = useRouter()
          VariableDeclarator(node) {
            if (
              node.id.type === 'ObjectPattern' &&
              node.init &&
              node.init.type === 'CallExpression' &&
              node.init.callee.type === 'Identifier' &&
              node.init.callee.name === 'useRouter'
            ) {
              for (const prop of node.id.properties) {
                if (
                  prop.type === 'Property' &&
                  prop.key.type === 'Identifier' &&
                  prop.key.name === 'refresh'
                ) {
                  refreshFromUseRouter = true;
                }
              }
            }
          },
          ImportDeclaration(node) {
            if (
              node.source.value.endsWith('/hooks/use-server-mutation') &&
              node.specifiers.some(s => s.imported?.name === 'useServerMutation')
            ) {
              hasUseServerMutation = true;
            }
          },
          "Program:exit"() {
            if (hasRefreshCall && !hasUseServerMutation) {
              context.report({
                node: refreshNode,
                message:
                  'router.refresh() called outside useServerMutation — use the useServerMutation hook instead.',
              });
            }
          },
        };
      },
    },
    /**
     * Detects test files that write to the real ~/.teamai/projects.json
     * without mocking 'os' (to redirect homedir) or '@/lib/project-store'
     * (to intercept the project store), or without using env-var isolation
     * (TEAMAI_CONFIG_DIR / TEAMAI_TEST_HOME).
     *
     * This prevents tests from accidentally corrupting the user's real
     * project registry during a test run.
     *
     * Catches: writeFileSync, appendFileSync, writeFile (promises), writeSync
     *
     * Safe patterns:
     *   vi.mock('os', () => ({ homedir: () => '/tmp/test' }))
     *   vi.mock('@/lib/project-store', () => ({ projectStore: { getAll: vi.fn() } }))
     *   const HOME = process.env.TEAMAI_TEST_HOME;
     */
    "no-real-projects-json": {
      meta: {
        type: "problem",
        docs: {
          description:
            "Prevent tests from writing to the real ~/.teamai/projects.json without a mock or env-var isolation",
        },
      },
      create(context) {
        let hasWriteFileSync = false;
        let hasProjectsJsonString = false;
        let projectsJsonNode = null;
        let hasMockOrIsolation = false;

        /** Recursively check if a node contains a string literal with substring. */
        function containsStringWith(node, substring) {
          if (!node) return false;
          if (
            node.type === "Literal" &&
            typeof node.value === "string" &&
            node.value.includes(substring)
          ) {
            return true;
          }
          if (
            node.type === "TemplateLiteral" &&
            node.quasis.some(q => q.value.raw.includes(substring))
          ) {
            return true;
          }
          for (const key of Object.keys(node)) {
            if (key === "parent" || key === "range" || key === "loc") continue;
            const child = node[key];
            if (Array.isArray(child)) {
              for (const c of child) {
                if (c && typeof c.type === "string" && containsStringWith(c, substring))
                  return true;
              }
            } else if (child && typeof child.type === "string") {
              if (containsStringWith(child, substring)) return true;
            }
          }
          return false;
        }

        return {
          // Detect file-write calls: writeFileSync, appendFileSync, writeFile (promises)
          CallExpression(node) {
            const callee = node.callee;
            // writeFileSync(...), appendFileSync(...), writeFile(...) or
            // fs.writeFileSync(...), fs.appendFileSync(...), fs.promises.writeFile(...)
            const name =
              callee.type === "Identifier" ? callee.name :
              callee.type === "MemberExpression" && callee.property?.type === "Identifier" ? callee.property.name :
              null;
            const fileWriteMethods = ["writeFileSync", "appendFileSync", "writeFile", "writeSync"];
            if (fileWriteMethods.includes(name)) {
              hasWriteFileSync = true;
              // Check if any argument contains a string with 'projects.json'
              if (node.arguments.some(arg => containsStringWith(arg, "projects.json"))) {
                hasProjectsJsonString = true;
                projectsJsonNode = node;
              }
            }

            // Detect vi.mock('os') or vi.mock('@/lib/project-store') or vi.doMock(...)
            if (
              callee.type === "MemberExpression" &&
              callee.object?.type === "Identifier" &&
              callee.object.name === "vi" &&
              callee.property?.type === "Identifier" &&
              (callee.property.name === "mock" || callee.property.name === "doMock") &&
              node.arguments.length >= 1 &&
              node.arguments[0].type === "Literal"
            ) {
              const mockTarget = node.arguments[0].value;
              if (mockTarget === "os" || mockTarget === "@/lib/project-store") {
                hasMockOrIsolation = true;
              }
            }
          },

          // Detect env-var isolation: TEAMAI_CONFIG_DIR or TEAMAI_TEST_HOME
          MemberExpression(node) {
            if (
              node.object?.type === "MemberExpression" &&
              node.object.object?.type === "Identifier" &&
              node.object.object.name === "process" &&
              node.object.property?.type === "Identifier" &&
              node.object.property.name === "env" &&
              node.property?.type === "Identifier" &&
              (node.property.name === "TEAMAI_CONFIG_DIR" ||
               node.property.name === "TEAMAI_TEST_HOME")
            ) {
              hasMockOrIsolation = true;
            }
          },

          "Program:exit"() {
            if (hasWriteFileSync && hasProjectsJsonString && !hasMockOrIsolation) {
              context.report({
                node: projectsJsonNode,
                message:
                  "Test writes to projects.json (via writeFileSync/appendFileSync/writeFile/writeSync) without " +
                  "mocking 'os' or '@/lib/project-store' or using TEAMAI_CONFIG_DIR/TEAMAI_TEST_HOME " +
                  "env-var isolation. This can corrupt the real ~/.teamai/projects.json. " +
                  "Add vi.mock('os', ...) or vi.mock('@/lib/project-store', ...) to isolate the test.",
              });
            }
          },
        };
      },
    },
  },
};

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Playwright output
    "test-results/**",
    // One-off migration scripts use Node require() naturally
    "scripts/**",
    // Electron build output (generated by electron-builder)
    "dist-electron/**",
    // Bundled server output (generated by build:server)
    "dist-server/**",
  ]),
  // Test files mock private internals and need `any` for type casting.
  // expect.any(), (obj as any).privateMethod, and mock (...args: any[]) signatures
  // are intentional test patterns — disabling the rule prevents 244 warnings
  // that would block CI if --max-warnings 0 is ever added.
  {
    files: ["tests/**/*.{ts,tsx}"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
    },
  },
  // Enforce no-real-projects-json on test files to prevent accidental writes
  // to the user's real ~/.teamai/projects.json without a mock or env-var isolation.
  {
    files: ["tests/**/*.{ts,tsx}"],
    plugins: {
      local: localPlugin,
    },
    rules: {
      "local/no-real-projects-json": "error",
    },
  },
  // Allow underscore-prefixed unused variables (intentionally ignored)
  // Covers source, test, and Electron main-process files
  {
    files: ["src/**/*.{ts,tsx}", "tests/**/*.{ts,tsx}", "electron/**/*.js"],
    rules: {
      "@typescript-eslint/no-unused-vars": ["warn", {
        "argsIgnorePattern": "^_",
        "varsIgnorePattern": "^_",
        "caughtErrorsIgnorePattern": "^_",
      }],
    },
  },
  // Warn when useTransition + useRouter are used together in the same component —
  // they should be replaced with the useServerMutation hook.
  // Also warn when router.refresh() is called outside of useServerMutation.
  // Exempts the hook's own source file which legitimately combines both.
  {
    files: ["src/**/*.tsx"],
    ignores: ["**/hooks/use-server-mutation.ts"],
    plugins: {
      local: localPlugin,
    },
    rules: {
      "local/no-useTransition-useRouter": "warn",
      "local/no-raw-router-refresh": "warn",
      "local/no-async-fetch-on-mount": "warn",
    },
  },
]);

export default eslintConfig;
export { localPlugin };
