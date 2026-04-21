#!/usr/bin/env node
/**
 * Wrapper script that runs jscpd-check-new.ts.
 *
 * Windows support requires the bun patch at patches/@jscpd%2Ffinder@4.0.4.patch
 * (bypasses a realpathSync() call in @jscpd/finder that prevents output
 * generation on Windows — upstream unfixed, tracked at
 * https://github.com/kucherenko/jscpd/issues/143).
 */

await import('./jscpd-check-new.js');
