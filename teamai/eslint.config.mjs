import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

/** Custom rules for useServerMutation migration enforcement. */
const localPlugin = {
  rules: {
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
  // Allow underscore-prefixed unused variables (intentionally ignored)
  {
    files: ["src/**/*.{ts,tsx}", "tests/**/*.{ts,tsx}"],
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
    },
  },
]);

export default eslintConfig;
export { localPlugin };
