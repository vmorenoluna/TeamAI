// Next's app-router internals (e.g. next/dist/server/app-render/async-local-storage)
// require globalThis.AsyncLocalStorage to already be set. Next normally sets it itself,
// via node-environment-baseline, but only reliably as the very first thing `next start`
// loads. This project runs Next from a custom server (server.ts) instead, and depending
// on the runtime (tsx, esbuild-bundled CJS, Electron's Node), Next's own internal
// require chain can end up loading app-router modules before its bootstrap sets the
// global, crashing with "Invariant: AsyncLocalStorage accessed in runtime where it is
// not available". Polyfilling it ourselves — imported first, before `next` — sidesteps
// the ordering entirely.
import { AsyncLocalStorage } from 'async_hooks';

if (typeof globalThis.AsyncLocalStorage !== 'function') {
  globalThis.AsyncLocalStorage = AsyncLocalStorage;
}
