/**
 * The one reader, for tests, of the TypeScript version `resources` declares. `build`'s vendor step
 * (`packages/dev-tools/src/vendor-typescript.ts`) refuses unless that declaration is one exact
 * version and the installed copy is it, so the declaration is the version the vendored copy holds.
 */

import { readFileSync } from 'node:fs';

/** @returns The exact version `resources` declares for its `typescript` devDependency */
export function declaredTypeScriptVersion(): string {
  const manifest = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf-8')) as {
    devDependencies: Record<string, string>;
  };
  const declared = manifest.devDependencies['typescript'];
  if (declared === undefined) throw new Error('resources declares no typescript devDependency');
  return declared;
}
