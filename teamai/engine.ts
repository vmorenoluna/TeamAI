// Must be the first import: static imports evaluate before any of this
// file's own top-level statements run, so an imperative polyfill placed
// here in source order would still lose the race against the modules below.
// Putting the polyfill in its own module and importing it first guarantees it
// runs before the engine's module graph does. See that module for why this is
// needed.
import './src/lib/node-environment-polyfill';

import './src/engine/engine-main';
