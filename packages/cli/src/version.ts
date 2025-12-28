/**
 * Version information and context detection
 */

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Read version from package.json at build time
const packageJson = JSON.parse(
  readFileSync(resolve(__dirname, '../package.json'), 'utf-8')
);

export const version: string = packageJson.version;

export interface VersionContext {
  type: 'dev' | 'local' | 'global';
  path?: string;
}

/**
 * Format version string with optional context
 */
export function getVersionString(
  ver: string,
  context: VersionContext | null
): string {
  if (!context) {
    return ver;
  }

  switch (context.type) {
    case 'dev':
      return `${ver}-dev (${context.path ?? 'unknown'})`;
    case 'local':
      return `${ver} (local: ${context.path ?? 'unknown'})`;
    case 'global':
      return ver;
  }
}
