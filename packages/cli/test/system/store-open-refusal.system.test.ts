/**
 * A projection store that will not open refuses the RUN once, as v0.2.0-rc.17
 * did, never once per phase that enumerates.
 *
 * The run opens its store on its first enumeration, so a read-only
 * `VAT_CACHE_DIR` is first met inside the first phase. That phase does not claim
 * the refusal, and no later phase runs to meet it again: the verb publishes one
 * run refusal (`INTERNAL_ERROR`, nothing finished, exit 2), its message said
 * once on stderr.
 *
 * `chmod 555` on the cache root is the whole fixture, so the suite is POSIX-only
 * and refuses to run as root, where the write is not denied.
 */

import { chmodSync } from 'node:fs';

import { VAT_CACHE_DIR_ENV } from '@vibe-agent-toolkit/resources';
import { CANNOT_DENY_READS } from '@vibe-agent-toolkit/utils/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parse } from 'yaml';

import { commitTestFixture } from '../test-helpers.js';

import { createSkillMarkdown, createSuiteContext, executeCli, join, writeFileTree } from './test-common.js';

const context = createSuiteContext('vat-store-open-', import.meta.url);

const FILES: Readonly<Record<string, string>> = {
  'vibe-agent-toolkit.config.yaml': 'resources:\n  include:\n    - "**/*.md"\nskills:\n  include:\n    - "skills/**/SKILL.md"\n',
  'README.md': '# Corpus\n\nSee [the guide](./docs/guide.md).\n',
  'docs/guide.md': '# Guide\n',
  'skills/one/SKILL.md': `${createSkillMarkdown('one')}\nSee [the guide](../../docs/guide.md).\n`,
};

/** The OS's sentence for the store directory the run could not create. */
const DENIED = 'EACCES: permission denied, mkdir';

interface RunReport {
  readonly error?: { readonly code: string; readonly message: string };
  readonly data: unknown;
}

describe.skipIf(CANNOT_DENY_READS)('a projection store that will not open', () => {
  let root: string;
  let cacheDir: string;

  beforeAll(() => {
    context.setup();
    root = join(context.createTempDir(), 'corpus');
    writeFileTree(root, FILES);
    commitTestFixture(root);
    cacheDir = context.createTempDir();
    chmodSync(cacheDir, 0o555);
  });

  afterAll(() => {
    chmodSync(cacheDir, 0o755);
    context.cleanup();
  });

  async function runVat(args: string[]) {
    const tmp = context.createTempDir();
    const result = await executeCli(context.binPath, args, {
      cwd: root,
      env: { [VAT_CACHE_DIR_ENV]: cacheDir, TMPDIR: tmp, TEMP: tmp, TMP: tmp },
    });
    return { ...result, report: parse(result.stdout) as RunReport };
  }

  /** How many times `needle` appears in `haystack`. */
  function occurrences(haystack: string, needle: string): number {
    return haystack.split(needle).length - 1;
  }

  it.each([
    { verb: ['validate'], banner: '▶ Surface: ', banners: 1 },
    { verb: ['verify'], banner: '▶ Phase: ', banners: 1 },
    { verb: ['resources', 'validate'], banner: '▶ ', banners: 0 },
    { verb: ['skills', 'validate'], banner: '▶ ', banners: 0 },
  ])('refuses `vat $verb` once, as the run, and runs no later phase', async ({ verb, banner, banners }) => {
    const { status, stdout, stderr, report } = await runVat(verb);

    expect(status, `${stdout}\n${stderr}`).toBe(2);
    expect(report.error?.code).toBe('INTERNAL_ERROR');
    expect(report.error?.message).toContain(DENIED);
    // Nothing finished: the refusal is the run's, not one phase's among others.
    expect(report.data).toBeNull();
    // Said once: the message line, and the `Error:` line of its stack.
    expect(occurrences(stderr, DENIED), stderr).toBe(2);
    // Only the phase that enumerated first was announced.
    expect(occurrences(stderr, banner), stderr).toBe(banners);
  });
});
