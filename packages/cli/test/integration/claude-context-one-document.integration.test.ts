/**
 * `vat claude context` writes ONE document to stdout, and resolves its
 * refused-file findings under the ONE config answer its population read.
 *
 * The population reads the project config first, through `loadConfigCached`.
 * The findings ask the same cache, so they are never resolved under a second
 * reading of the file — and they are resolved BEFORE the answer is written, so a
 * config read that fails at findings time is a refusal with stdout still empty,
 * never a second document after the answer.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';

import type * as resources from '@vibe-agent-toolkit/resources';
import { mkdirSyncReal, normalizedTmpdir, safePath } from '@vibe-agent-toolkit/utils';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { claudeContextCommand } from '../../src/commands/claude/context.js';
import type * as configLoader from '../../src/utils/config-loader.js';

type ConfigLoader = typeof configLoader;
type Resources = typeof resources;

const CONFIG_FAILURE = 'Failed to load config: seeded for this test';

/**
 * What the mocked loader does: every read fails when `failing`, and uncached reads are
 * counted. `failAfterPopulation` sets `failing` once the answers are being built — after
 * the population's own config read, before the findings' one.
 */
const loader = vi.hoisted(() => ({ failing: false, failAfterPopulation: false, uncachedReads: 0 }));

vi.mock('@vibe-agent-toolkit/resources', async (importOriginal) => {
  const actual = await importOriginal<Resources>();
  return {
    ...actual,
    whatLoadsAt: (...args: Parameters<typeof actual.whatLoadsAt>) => {
      if (loader.failAfterPopulation) loader.failing = true;
      return actual.whatLoadsAt(...args);
    },
  };
});

vi.mock('../../src/utils/config-loader.js', async (importOriginal) => {
  const actual = await importOriginal<ConfigLoader>();
  const fail = (): never => {
    throw new Error(CONFIG_FAILURE);
  };
  return {
    ...actual,
    loadConfig: (...args: Parameters<ConfigLoader['loadConfig']>) => {
      loader.uncachedReads++;
      return loader.failing ? fail() : actual.loadConfig(...args);
    },
    loadConfigCached: (...args: Parameters<ConfigLoader['loadConfigCached']>) =>
      (loader.failing ? fail() : actual.loadConfigCached(...args)),
  };
});

/** One import more than the default `outputRows` cap allows a single read. */
const PAST_THE_CAP = Array.from({ length: 16_385 }, (_, index) => `@a${index}.md`).join('\n');

/** Run the command over a project whose scoped rule is refused; return what reached stdout. */
async function runOverRefusedRule(roots: string[]): Promise<string> {
  const root = safePath.resolve(mkdtempSync(safePath.join(normalizedTmpdir(), 'context-one-document-')));
  roots.push(root);
  mkdirSyncReal(safePath.join(root, '.claude', 'rules'), { recursive: true });
  mkdirSyncReal(safePath.join(root, 'docs'), { recursive: true });
  writeFileSync(safePath.join(root, 'vibe-agent-toolkit.config.yaml'), '{}\n');
  writeFileSync(safePath.join(root, 'CLAUDE.md'), '# Root\n');
  writeFileSync(safePath.join(root, 'docs', 'readme.md'), '# Readme\n');
  writeFileSync(safePath.join(root, '.claude', 'rules', 'scoped.md'), `---\npaths: ['src/**/*.ts']\n---\n\n${PAST_THE_CAP}\n`);

  vi.spyOn(process, 'cwd').mockReturnValue(root);
  vi.spyOn(process.stderr, 'write').mockReturnValue(true);
  const written: string[] = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
    written.push(String(chunk));
    return true;
  });
  // The process ends at its FIRST exit: what stdout held then is what a reader got. (The stub
  // throws to stop the run, and the command's own catch would otherwise write after it.)
  class Exited extends Error {}
  let atExit: string | undefined;
  vi.spyOn(process, 'exit').mockImplementation(() => {
    atExit ??= written.join('');
    throw new Exited();
  });

  await claudeContextCommand(['docs'], { format: 'json' }).catch((error: unknown) => {
    if (!(error instanceof Exited)) throw error;
  });
  return atExit ?? written.join('');
}

describe('vat claude context over a refused rules file', () => {
  const roots: string[] = [];
  afterEach(() => {
    vi.restoreAllMocks();
    loader.failing = false;
    loader.failAfterPopulation = false;
    loader.uncachedReads = 0;
    for (const root of roots) rmSync(root, { recursive: true, force: true });
  });

  it('resolves the refused file\'s finding through the population\'s config read, never a second one', async () => {
    const stdout = await runOverRefusedRule(roots);

    expect((JSON.parse(stdout) as { status?: string }).status).not.toBe('error');
    expect(loader.uncachedReads).toBe(0);
  });

  // Only the findings-time read fails: the population read it fine. Written after the answer,
  // the refusal would be a second document on stdout.
  it('writes exactly one document — the refusal — when the findings\' config read fails', async () => {
    loader.failAfterPopulation = true;
    const stdout = await runOverRefusedRule(roots);

    const document = JSON.parse(stdout) as { status?: string; error?: { message: string } };
    expect(document.status).toBe('error');
    expect(document.error?.message).toContain(CONFIG_FAILURE);
  });
});
