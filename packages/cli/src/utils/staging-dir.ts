/**
 * A staging directory under the OS temp dir, for a verb whose staging outlives one call (a
 * clone handed to an audit, a resolved install source) and so cannot be held by `withTempDir`.
 */

import { mkdtemp } from 'node:fs/promises';

import { normalizedTmpdir, safePath, withFsFault } from '@vibe-agent-toolkit/utils';

/** A fresh staging directory under the OS temp dir; one the OS will not create is an `environment` fault. */
export function makeStagingDir(prefix: string): Promise<string> {
  const template = safePath.join(normalizedTmpdir(), prefix);
  return withFsFault({ side: 'environment', action: 'create a staging directory', path: template }, () => mkdtemp(template));
}
