import { RuleTester } from 'eslint';
import { localPlugin } from '../../eslint.config.mjs';
import tsParser from '@typescript-eslint/parser';

const ruleTester = new RuleTester({
  languageOptions: {
    ecmaVersion: 2022,
    sourceType: 'module',
    parser: tsParser,
  },
});

// ---------------------------------------------------------------------------
// no-useTransition-useRouter
// ---------------------------------------------------------------------------

 
const noTransitionUseRouterRule = localPlugin.rules['no-useTransition-useRouter'] as any;

const noRawRouterRefreshRule = localPlugin.rules['no-raw-router-refresh'] as any;

const noAsyncFetchOnMountRule = localPlugin.rules['no-async-fetch-on-mount'] as any;

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
      // Aliased import: useRouter as foo (imported.name is still 'useRouter')
      {
        code: `
          import { useTransition } from 'react';
          import { useRouter as foo } from 'next/navigation';
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
      // Bare refresh() without destructuring from useRouter — not flagged
      {
        code: `
          import { useRouter } from 'next/navigation';

          function Foo() {
            const refresh = () => {};
            refresh();
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
      // Destructured refresh() from useRouter() — now caught by VariableDeclarator visitor
      {
        code: `
          import { useRouter } from 'next/navigation';

          function Foo() {
            const { refresh } = useRouter();
            refresh();
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
      // Multiple router.refresh() calls — still fires (reports the last call)
      {
        code: `
          import { useRouter } from 'next/navigation';

          function Foo() {
            const router = useRouter();
            router.refresh();
            router.refresh();
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

// ---------------------------------------------------------------------------
// no-async-fetch-on-mount
// ---------------------------------------------------------------------------

ruleTester.run(
  'no-async-fetch-on-mount',
  noAsyncFetchOnMountRule,
  {
    valid: [
      // Initialized from a prop (not a literal) — correct pattern
      {
        code: `
          import { useState } from 'react';
          function AutoModeButton({ initialEnabled }: { initialEnabled: boolean }) {
            const [enabled, setEnabled] = useState(initialEnabled);
            return null;
          }
        `,
      },
      // useState(literal) + useEffect without async — no fetch on mount
      {
        code: `
          import { useState, useEffect } from 'react';
          function Foo() {
            const [ready, setReady] = useState(false);
            useEffect(() => {
              setReady(true);
            }, []);
            return null;
          }
        `,
      },
      // useState(literal) + useEffect(async, []) but setter not called in effect
      {
        code: `
          import { useState, useEffect } from 'react';
          function Foo() {
            const [flag, setFlag] = useState(false);
            const [items, setItems] = useState([] as string[]);
            useEffect(() => {
              fetchItems().then(setItems);
            }, []);
            return null;
          }
        `,
      },
      // useState(literal) + useEffect with non-empty deps — not a mount effect
      {
        code: `
          import { useState, useEffect } from 'react';
          function Foo() {
            const [count, setCount] = useState(0);
            useEffect(() => {
              fetchData().then((d) => setCount(d.count));
            }, [someDep]);
            return null;
          }
        `,
      },
      // No useState at all — only useEffect(async, [])
      {
        code: `
          import { useEffect } from 'react';
          function Foo() {
            useEffect(() => {
              fetch('/api/health').then((r) => r.json()).then(console.log);
            }, []);
            return null;
          }
        `,
      },
      // useState with non-literal initializer (function call)
      {
        code: `
          import { useState, useEffect } from 'react';
          function Foo() {
            const [data, setData] = useState(getInitialData());
            useEffect(() => {
              fetchMore().then(setData);
            }, []);
            return null;
          }
        `,
      },
      // useState with array/object literal — not flagged (data containers)
      {
        code: `
          import { useState, useEffect } from 'react';
          function Foo() {
            const [items, setItems] = useState([] as string[]);
            useEffect(() => {
              fetchItems().then(setItems);
            }, []);
            return null;
          }
        `,
      },
      // Only the non-literal useState setter is called in the async effect — no cross-match
      {
        code: `
          import { useState, useEffect } from 'react';
          function Foo() {
            const [a, setA] = useState(false);
            const [b, setB] = useState(getInitial());
            useEffect(() => {
              doAsyncWork().then(() => setB(true));
            }, []);
            return null;
          }
        `,
      },
      // Known limitation: setter passed as direct callback reference (.then(setState))
      // is NOT detected — callsSetter only matches CallExpression nodes (e.g. setState(x)),
      // not Identifier references. The wrapped form (.then((x) => setState(x))) is required.
      {
        code: `
          import { useState, useEffect } from 'react';
          function Foo() {
            const [enabled, setEnabled] = useState(false);
            useEffect(() => {
              fetchState().then(setEnabled);
            }, []);
            return null;
          }
        `,
      },
    ],
    invalid: [
      // Classic antipattern: useState(false) + useEffect(async, []) with await
      {
        code: `
          import { useState, useEffect } from 'react';
          function AutoModeButton() {
            const [enabled, setEnabled] = useState(false);
            useEffect(async () => {
              const state = await getAutoModeState();
              setEnabled(state.enabled);
            }, []);
            return null;
          }
        `,
        errors: [
          {
            message:
              'useState(literal) + useEffect(async, []) antipattern detected. ' +
              'The state "setEnabled" is initialised with a literal default then ' +
              'async-fetched in a mount effect — it will reset on router.refresh(). ' +
              'Pass the initial value as a server prop instead (e.g. <Comp initialX={val} />).',
          },
        ],
      },
      // Using .then() instead of await
      {
        code: `
          import { useState, useEffect } from 'react';
          function Foo() {
            const [ready, setReady] = useState(false);
            useEffect(() => {
              checkReady().then((result) => setReady(result));
            }, []);
            return null;
          }
        `,
        errors: [
          {
            message:
              'useState(literal) + useEffect(async, []) antipattern detected. ' +
              'The state "setReady" is initialised with a literal default then ' +
              'async-fetched in a mount effect — it will reset on router.refresh(). ' +
              'Pass the initial value as a server prop instead (e.g. <Comp initialX={val} />).',
          },
        ],
      },
      // useState(null) — also a literal
      {
        code: `
          import { useState, useEffect } from 'react';
          function Foo() {
            const [session, setSession] = useState(null);
            useEffect(() => {
              createSession().then((s) => setSession(s));
            }, []);
            return null;
          }
        `,
        errors: [
          {
            message:
              'useState(literal) + useEffect(async, []) antipattern detected. ' +
              'The state "setSession" is initialised with a literal default then ' +
              'async-fetched in a mount effect — it will reset on router.refresh(). ' +
              'Pass the initial value as a server prop instead (e.g. <Comp initialX={val} />).',
          },
        ],
      },
      // useState(0) — numeric literal
      {
        code: `
          import { useState, useEffect } from 'react';
          function Foo() {
            const [count, setCount] = useState(0);
            useEffect(() => {
              fetchCount().then((c) => setCount(c));
            }, []);
            return null;
          }
        `,
        errors: [
          {
            message:
              'useState(literal) + useEffect(async, []) antipattern detected. ' +
              'The state "setCount" is initialised with a literal default then ' +
              'async-fetched in a mount effect — it will reset on router.refresh(). ' +
              'Pass the initial value as a server prop instead (e.g. <Comp initialX={val} />).',
          },
        ],
      },
      // useState("") — string literal
      {
        code: `
          import { useState, useEffect } from 'react';
          function Foo() {
            const [name, setName] = useState("");
            useEffect(() => {
              getUserName().then((n) => setName(n));
            }, []);
            return null;
          }
        `,
        errors: [
          {
            message:
              'useState(literal) + useEffect(async, []) antipattern detected. ' +
              'The state "setName" is initialised with a literal default then ' +
              'async-fetched in a mount effect — it will reset on router.refresh(). ' +
              'Pass the initial value as a server prop instead (e.g. <Comp initialX={val} />).',
          },
        ],
      },
      // .catch() chain — also detected as async operation
      {
        code: `
          import { useState, useEffect } from 'react';
          function Foo() {
            const [enabled, setEnabled] = useState(false);
            useEffect(() => {
              fetchState().then((s) => setEnabled(s.enabled)).catch(() => setEnabled(false));
            }, []);
            return null;
          }
        `,
        errors: [
          {
            message:
              'useState(literal) + useEffect(async, []) antipattern detected. ' +
              'The state "setEnabled" is initialised with a literal default then ' +
              'async-fetched in a mount effect — it will reset on router.refresh(). ' +
              'Pass the initial value as a server prop instead (e.g. <Comp initialX={val} />).',
          },
        ],
      },
    ],
  },
);
