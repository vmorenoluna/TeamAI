import { RuleTester } from 'eslint';
import { localPlugin } from '../../eslint.config.mjs';

const ruleTester = new RuleTester({
  languageOptions: {
    ecmaVersion: 2022,
    sourceType: 'module',
  },
});

// ---------------------------------------------------------------------------
// no-useTransition-useRouter
// ---------------------------------------------------------------------------

 
const noTransitionUseRouterRule = localPlugin.rules['no-useTransition-useRouter'] as any;
 
const noRawRouterRefreshRule = localPlugin.rules['no-raw-router-refresh'] as any;

ruleTester.run(
  'no-useTransition-useRouter',
  noTransitionUseRouterRule,
  {
    valid: [
      // Only useTransition — no useRouter
      {
        code: `
          import { useTransition } from 'react';
          function Foo() { return null; }
        `,
      },
      // Only useRouter — no useTransition
      {
        code: `
          import { useRouter } from 'next/navigation';
          function Foo() { return null; }
        `,
      },
      // Neither import
      {
        code: `
          import { useState } from 'react';
          function Foo() { return null; }
        `,
      },
      // useTransition from react, but useRouter from a non-target source
      {
        code: `
          import { useTransition } from 'react';
          import { useRouter } from 'some-other-package';
          function Foo() { return null; }
        `,
      },
    ],
    invalid: [
      // Both from 'react' and 'next/navigation'
      {
        code: `
          import { useTransition } from 'react';
          import { useRouter } from 'next/navigation';
          function Foo() { return null; }
        `,
        errors: [
          {
            message:
              'useTransition + useRouter detected — use the useServerMutation hook instead.',
          },
        ],
      },
      // Both from 'react' and 'next/router' (Pages Router)
      {
        code: `
          import { useTransition } from 'react';
          import { useRouter } from 'next/router';
          function Foo() { return null; }
        `,
        errors: [
          {
            message:
              'useTransition + useRouter detected — use the useServerMutation hook instead.',
          },
        ],
      },
      // useTransition in a multi-import line
      {
        code: `
          import { useState, useTransition } from 'react';
          import { useRouter } from 'next/navigation';
          function Foo() { return null; }
        `,
        errors: [
          {
            message:
              'useTransition + useRouter detected — use the useServerMutation hook instead.',
          },
        ],
      },
    ],
  },
);

// ---------------------------------------------------------------------------
// no-raw-router-refresh
// ---------------------------------------------------------------------------

ruleTester.run(
  'no-raw-router-refresh',
  noRawRouterRefreshRule,
  {
    valid: [
      // router.refresh() but useServerMutation is imported (like defaults-updater)
      {
        code: `
          import { useRouter } from 'next/navigation';
          import { useServerMutation } from '@/hooks/use-server-mutation';

          function Foo() {
            const router = useRouter();
            router.refresh();
            return null;
          }
        `,
      },
      // No router.refresh() at all
      {
        code: `
          import { useRouter } from 'next/navigation';

          function Foo() {
            const router = useRouter();
            return null;
          }
        `,
      },
      // router.refresh() with useServerMutation from a relative path
      {
        code: `
          import { useRouter } from 'next/navigation';
          import { useServerMutation } from '../../hooks/use-server-mutation';

          function Foo() {
            const router = useRouter();
            router.refresh();
            return null;
          }
        `,
      },
    ],
    invalid: [
      // router.refresh() WITHOUT useServerMutation
      {
        code: `
          import { useRouter } from 'next/navigation';

          function Foo() {
            const router = useRouter();
            router.refresh();
            return null;
          }
        `,
        errors: [
          {
            message:
              'router.refresh() called outside useServerMutation — use the useServerMutation hook instead.',
          },
        ],
      },
    ],
  },
);
