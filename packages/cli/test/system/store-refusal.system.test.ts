/**
 * A projection store that fails refuses the RUN once, never once per phase that meets it.
 *
 * - **A store that will not open.** The run opens its store on its first enumeration, so a
 *   read-only `VAT_CACHE_DIR` is first met inside the first phase. That phase does not claim the
 *   refusal, and no later phase runs to meet it again: the verb publishes one run refusal
 *   (`INTERNAL_ERROR`, nothing finished, exit 2), its message said once on stderr, as v0.2.0-rc.17
 *   did. `chmod 555` on the cache root is the whole fixture, so that suite is POSIX-only and
 *   refuses to run as root, where the write is not denied.
 * - **A store whose blob tier cannot be read back.** The first run files the tree in a real SQLite
 *   store. Then every stored `blobs.anchors` value is made something that is not JSON, so the warm
 *   run's extent read still hits and its one blob-tier read rejects: the store's failure, refused
 *   by the store's own code, never as a defect in VAT.
 */

import { chmodSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import { VAT_CACHE_DIR_ENV } from '@vibe-agent-toolkit/resources';
import { CANNOT_DENY_READS } from '@vibe-agent-toolkit/utils/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parse } from 'yaml';

import { commitTestFixture } from '../test-helpers.js';

import { createSkillMarkdown, createSuiteContext, executeCli, join, oneDocOneSkillTree, writeFileTree } from './test-common.js';

const context = createSuiteContext('vat-store-refusal-', import.meta.url);

/** The OS's sentence for the store directory the run could not create. */
const DENIED = 'EACCES: permission denied, mkdir';

/** The start of the blob-tier refusal's own sentence. */
const UNREADABLE_TIER = "The projection store's blob facts could not be read";

interface RunReport {
  readonly error?: { readonly code: string; readonly message: string };
  readonly data: unknown;
}

/**
 * Run `vat` over `tree` with its store under `cacheRoot`.
 *
 * @param tree - The committed tree
 * @param args - The verb and its arguments
 * @param cacheRoot - The run's `VAT_CACHE_DIR`
 * @returns The run, and its report as parsed from stdout
 */
async function vat(tree: string, args: readonly string[], cacheRoot: string) {
  const tmp = context.createTempDir();
  const result = await executeCli(context.binPath, [...args], {
    cwd: tree,
    env: { [VAT_CACHE_DIR_ENV]: cacheRoot, TMPDIR: tmp, TEMP: tmp, TMP: tmp },
  });
  return { ...result, report: parse(result.stdout) as RunReport };
}

/** How many times `needle` appears in `haystack`. */
function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

/**
 * The one `projection.db` beneath the cache root.
 *
 * @param cacheRoot - The run's `VAT_CACHE_DIR`
 * @returns Its path
 */
function storeDatabase(cacheRoot: string): string {
  const found = readdirSync(cacheRoot, { recursive: true, encoding: 'utf-8' })
    .filter((entry) => entry.endsWith('projection.db'));
  expect(found, 'one store database under the cache root').toHaveLength(1);
  return join(cacheRoot, found[0] ?? '');
}

/**
 * Make every stored `blobs.anchors` value unreadable as JSON.
 *
 * @param cacheRoot - The cache root the store lives under
 */
function damageBlobTier(cacheRoot: string): void {
  const database = new DatabaseSync(storeDatabase(cacheRoot));
  try {
    const changed = database.prepare("UPDATE blobs SET anchors = 'not json'").run().changes;
    expect(Number(changed), 'the first run filed blob rows').toBeGreaterThan(0);
  } finally {
    database.close();
  }
}

/** A project whose one skill is plugin-local: its `skills.include` matches no pool skill. */
const PLUGIN_LOCAL_TREE: Readonly<Record<string, string>> = {
  'vibe-agent-toolkit.config.yaml': [
    'skills:',
    '  include:',
    '    - "pool-that-does-not-exist/**/SKILL.md"',
    'claude:',
    '  marketplaces:',
    '    m:',
    '      owner:',
    '        name: Test Org',
    '      plugins:',
    '        - name: p',
    '          description: A plugin whose skill is plugin-local',
    '          skills: "*"',
    '',
  ].join('\n'),
  'plugins/p/skills/demo/SKILL.md': createSkillMarkdown('demo'),
};

let tree: string;

beforeAll(() => {
  context.setup();
  tree = join(context.createTempDir(), 'corpus');
  writeFileTree(tree, oneDocOneSkillTree());
  commitTestFixture(tree);
});

afterAll(() => {
  context.cleanup();
});

describe.skipIf(CANNOT_DENY_READS)('a projection store that will not open', () => {
  let cacheDir: string;

  beforeAll(() => {
    cacheDir = context.createTempDir();
    chmodSync(cacheDir, 0o555);
  });

  afterAll(() => {
    chmodSync(cacheDir, 0o755);
  });

  it.each([
    { verb: ['validate'], banner: '▶ Surface: ', banners: 1 },
    { verb: ['verify'], banner: '▶ Phase: ', banners: 1 },
    { verb: ['resources', 'validate'], banner: '▶ ', banners: 0 },
    { verb: ['skills', 'validate'], banner: '▶ ', banners: 0 },
  ])('refuses `vat $verb` once, as the run, and runs no later phase', async ({ verb, banner, banners }) => {
    const { status, stdout, stderr, report } = await vat(tree, verb, cacheDir);

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

  // A project whose skills are all plugin-local: no delegated phase enumerates the home, so the
  // first thing to ask the store is the in-process phases' stored-document question. That
  // question is optional: a store that will not open answers it with nothing, and the phases
  // read the files themselves. As at c3236b26f, which opened no store here: every in-process
  // phase runs, and the exit is the findings' (the marketplace's missing license, 1), never the
  // run's refusal (2).
  it('runs `vat verify`\'s in-process phases when only their optional store question meets it', async () => {
    const pluginLocal = join(context.createTempDir(), 'plugin-local');
    writeFileTree(pluginLocal, PLUGIN_LOCAL_TREE);
    commitTestFixture(pluginLocal);
    const built = await vat(pluginLocal, ['build'], context.createTempDir());
    expect(built.status, `${built.stdout}\n${built.stderr}`).toBe(0);

    const { status, stdout, stderr, report } = await vat(pluginLocal, ['verify'], cacheDir);

    expect(report.error, `${stdout}\n${stderr}`).toBeUndefined();
    expect(occurrences(stderr, DENIED), stderr).toBe(0);
    const phases = (report.data as { phases: ReadonlyArray<{ name: string }> }).phases.map((phase) => phase.name);
    expect(phases).toEqual(expect.arrayContaining(['files-config-dests', 'packaged-content', 'consistency']));
    expect(status, `${stdout}\n${stderr}`).toBe(1);
  });
});

describe('a store whose blob tier cannot be read back', () => {
  it.each([
    { args: ['validate'] },
    { args: ['resources', 'validate'] },
  ])('refuses `vat $args` once, as the store\'s refusal, not a defect', async ({ args }) => {
    // A store of its own: each case primes it.
    const cacheRoot = context.createTempDir();
    const primed = await vat(tree, args, cacheRoot);
    expect(primed.report.error, `${primed.stdout}\n${primed.stderr}`).toBeUndefined();
    damageBlobTier(cacheRoot);

    const { status, stdout, stderr, report } = await vat(tree, args, cacheRoot);

    expect(status, `${stdout}\n${stderr}`).toBe(2);
    expect(report.error?.code).toBe('BACKEND_UNAVAILABLE');
    expect(report.error?.message).toContain(UNREADABLE_TIER);
    expect(report.data).toBeNull();
    expect(occurrences(stderr, UNREADABLE_TIER), stderr).toBe(1);
  });
});
