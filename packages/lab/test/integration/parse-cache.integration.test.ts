/**
 * Asking a build where its parse cache lives — under the SAME environment its
 * arm's VAT steps run in, and accepted only when the answer lies under the
 * arm's own `tmp/`. A build whose parse root follows an inherited variable
 * would otherwise answer with the developer's directory, and the cold rule
 * would look for shards somewhere the arm never wrote.
 *
 * The build is a stand-in: an entry file beside a fake
 * `@vibe-agent-toolkit/resources` whose `parseCacheDirectory()` follows
 * {@link FAKE_ROOT_ENV} when set, else the OS temp directory, as VAT's does.
 *
 * Integration-tier: spawns node to ask the stand-in.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';

import { mkdirSyncReal, normalizedTmpdir, safePath } from '@vibe-agent-toolkit/utils';
import { NODE_EXECUTABLE } from '@vibe-agent-toolkit/utils/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { armDirectories, prepareArmDirectories } from '../../src/harness/arm-dirs.js';
import { resolveParseCacheDirectory } from '../../src/harness/parse-cache.js';
import type { ResolvedInstrument } from '../../src/harness/types.js';
import { PROBE_VERSION } from '../command-probe.js';

/** An inherited VAT_* variable the stand-in's parse root follows — one an arm's VAT step never inherits. */
const FAKE_ROOT_ENV = 'VAT_LAB_FAKE_PARSE_ROOT';
/** A non-VAT variable that survives the clearing: the stand-in answers this fixed path when it is set. */
const FAKE_FIXED_ENV = 'LAB_FAKE_PARSE_FIXED';

let scratch: string;

beforeEach(() => {
  scratch = mkdtempSync(safePath.join(normalizedTmpdir(), 'lab-parse-cache-'));
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(scratch, { recursive: true, force: true });
});

/** @returns A stand-in build under the scratch directory */
function standInBuild(): ResolvedInstrument {
  const build = mkdirSyncReal(safePath.join(scratch, 'build'));
  const entry = safePath.join(build, 'bin.js');
  writeFileSync(entry, '');
  const resources = mkdirSyncReal(safePath.join(build, 'node_modules', '@vibe-agent-toolkit', 'resources'), { recursive: true });
  writeFileSync(
    safePath.join(resources, 'package.json'),
    JSON.stringify({ name: '@vibe-agent-toolkit/resources', type: 'module', exports: { '.': { default: './index.js' } } }),
  );
  writeFileSync(
    safePath.join(resources, 'index.js'),
    [
      "import { tmpdir } from 'node:os';",
      "import { join } from 'node:path';",
      'export function parseCacheDirectory() {',
      `  if (process.env.${FAKE_FIXED_ENV}) return process.env.${FAKE_FIXED_ENV};`,
      `  return join(process.env.${FAKE_ROOT_ENV} ?? tmpdir(), '.vat-cache', 'ns', 'parse');`,
      '}',
      '',
    ].join('\n'),
  );
  return { command: NODE_EXECUTABLE, leadingArgs: [entry], version: PROBE_VERSION };
}

/** @returns A prepared arm under the scratch directory */
function arm(): ReturnType<typeof armDirectories> {
  const dirs = armDirectories({ root: safePath.join(scratch, 'arms'), build: 'b', arm: 'parse', state: 'cold' });
  prepareArmDirectories(dirs);
  return dirs;
}

describe('resolveParseCacheDirectory', () => {
  it('asks under the arm’s own environment, so an inherited VAT_* parse root never decides the answer', () => {
    vi.stubEnv(FAKE_ROOT_ENV, safePath.join(scratch, 'developer-cache'));
    const dirs = arm();

    expect(resolveParseCacheDirectory(standInBuild(), dirs)).toStrictEqual({
      ok: true,
      dir: safePath.join(dirs.tmp, '.vat-cache', 'ns', 'parse'),
    });
  });

  it('refuses an answer outside the arm’s tmp — the cold rule would look where the arm never wrote', () => {
    const elsewhere = safePath.join(scratch, 'elsewhere', 'parse');
    vi.stubEnv(FAKE_FIXED_ENV, elsewhere);

    const resolved = resolveParseCacheDirectory(standInBuild(), arm());

    expect(resolved.ok).toBe(false);
    expect(resolved.ok ? '' : resolved.reason).toMatch(/not under the arm's tmp/u);
  });
});
