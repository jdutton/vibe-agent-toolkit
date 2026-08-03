/**
 * Version information and context detection
 */

import { readFileSync } from 'node:fs';
import {  dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { safePath } from '@vibe-agent-toolkit/utils';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Read version from package.json at build time
const packageJson = JSON.parse(
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- path resolved from known __dirname and constant package.json name
  readFileSync(safePath.resolve(__dirname, '../package.json'), 'utf-8')
);

export const version: string = packageJson.version;

export interface VersionContext {
  type: 'dev' | 'local' | 'global';
  path?: string;
}

/**
 * The version line alone: `<ver>` plus whatever the cwd-derived context adds.
 *
 * Kept private because it is exactly the string that could not identify a
 * binary — `global` and "no context" both collapse to a bare `<ver>`.
 */
function formatVersionLine(ver: string, context: VersionContext | null): string {
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

/**
 * Format the `--version` output: the version line, then the resolved path of
 * the binary that produced it.
 *
 * **Why the binary path is unconditional.** The `-dev (<path>)` suffix is
 * CWD-derived: `bin/vat.ts` computes its context from
 * `findNodeWorkspaceRoot(process.cwd())`, so the *same* branch build invoked by
 * absolute path from an adopter checkout resolves `Context: global` and printed
 * a bare `0.1.41-rc.8` — byte-identical to what the released rc.8 prints. The
 * only way to tell them apart was `VAT_DEBUG=1` plus knowing to look for the
 * `Binary:` line. Every adopter delta test runs in exactly that directory, so
 * the identity check the whole testing protocol depends on was unperformable
 * where the tests actually run.
 *
 * `binaryPath` is a property of what ACTUALLY ran (derived from the entry
 * module's own `import.meta.filename`, not from the cwd), which is why it can
 * answer the question the context label cannot. It is a required parameter on
 * purpose: a defaulted one would let a caller be added that silently ships the
 * old, unidentifiable output.
 *
 * The version stays on line 1 so `--version` output still matches
 * `/^\d+\.\d+\.\d+/`; the provenance is appended, never prepended.
 */
export function getVersionString(
  ver: string,
  context: VersionContext | null,
  binaryPath: string
): string {
  return `${formatVersionLine(ver, context)}\n  binary: ${binaryPath}`;
}
