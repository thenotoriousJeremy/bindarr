import { lazy } from 'react';
import { reloadingImport, reloadForStaleBuild } from './chunkReload';

// React.lazy for a code-split component. A chunk that an upgrade removed reloads
// the page once instead of crashing the view (see chunkReload.js).
export const lazyWithReload = (factory) => lazy(reloadingImport(factory, reloadForStaleBuild));

// One named export of a code-split module, for a module holding several.
export const lazyNamed = (factory, name) => lazyWithReload(() => factory().then(m => ({ default: m[name] })));
