import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

/** Custom rule: warns when useTransition + useRouter are imported together. */
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
  // Exempts the hook's own source file which legitimately combines both.
  {
    files: ["src/**/*.tsx"],
    ignores: ["**/hooks/use-server-mutation.ts"],
    plugins: {
      local: localPlugin,
    },
    rules: {
      "local/no-useTransition-useRouter": "warn",
    },
  },
]);

export default eslintConfig;
