/**
 * Every command that offers `--format` must publish its FAILURE in that format.
 *
 * ## The defect
 *
 * The old failure helper grew a `format` parameter whose docstring said *"a
 * caller that has a `--format` option MUST pass it"*, and the change that added
 * it missed two commands the same change created — `vat claude context`. So on
 * the one path a scripted consumer most needs to parse, `--format json`
 * silently produced YAML.
 *
 * The helper is gone: every failure now leaves through the one writer, whose
 * `format` parameter is REQUIRED, so a new caller cannot forget it. These
 * behaviour cases pin the lanes that once dropped it.
 */

import { ExitCode } from '@vibe-agent-toolkit/schema';
import { safePath } from '@vibe-agent-toolkit/utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import yaml from 'yaml';

import { claudeContextCommand } from '../../src/commands/claude/context.js';
import { inventoryCommand } from '../../src/commands/inventory.js';
import { missingBackendError } from '../../src/utils/optional-backend.js';
import type * as ProjectionStoreModule from '../../src/utils/projection-store.js';

/**
 * The population, replaced so a test can make it throw what the sqlite store
 * throws when its optional backend is not installed — without uninstalling it.
 * Every other call runs the real one.
 */
const { withPopulationCache } = vi.hoisted(() => ({ withPopulationCache: vi.fn() }));
vi.mock('../../src/utils/projection-store.js', async (importOriginal) => {
  const actual = await importOriginal<typeof ProjectionStoreModule>();
  withPopulationCache.mockImplementation(actual.withPopulationCache);
  return { ...actual, withPopulationCache };
});

/** What the mocked `process.exit` throws, so the caller unwinds instead of dying. */
const PROCESS_EXIT_ERROR_MESSAGE = 'process.exit called';

/**
 * A path argument that resolves outside any discovered corpus root.
 *
 * The cheapest reachable throw in both commands: `targetPathWithin` refuses it
 * BEFORE the projection is populated, which is the whole reason the guard runs
 * first. A test that had to build a population to reach the catch arm would cost
 * minutes and measure the population instead of the format.
 */
const OUTSIDE_ROOT = '/';

/** This package's directory: one that exists and holds no plugin, marketplace or skill manifest. */
const CLI_PACKAGE_DIR = safePath.resolve(import.meta.dirname, '../..');

describe('a failing command honours the --format it was given', () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let stdoutSpy: ReturnType<typeof vi.spyOn>;
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((): never => {
      throw new Error(PROCESS_EXIT_ERROR_MESSAGE);
    }) as unknown as ReturnType<typeof vi.spyOn>;
    stdoutSpy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation((): boolean => true) as unknown as ReturnType<typeof vi.spyOn>;
    stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation((): boolean => true) as unknown as ReturnType<typeof vi.spyOn>;
  });

  afterEach(() => {
    exitSpy.mockRestore();
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
  });

  /** Everything the command wrote to stdout, joined. */
  const publishedDocument = (): string =>
    stdoutSpy.mock.calls.map((call) => String(call[0])).join('');

  it('publishes `vat claude context --format json` failures as JSON', async () => {
    await expect(
      claudeContextCommand([OUTSIDE_ROOT], { format: 'json' }),
    ).rejects.toThrow(PROCESS_EXIT_ERROR_MESSAGE);

    const parsed = JSON.parse(publishedDocument()) as { status: string; error: { code: string; message: string } };
    expect(parsed.status).toBe('error');
    // A path outside the corpus is the invocation's mistake, coded where it is raised.
    expect(parsed.error.code).toBe('USAGE_INVALID');
    expect(parsed.error.message).toContain('outside the corpus root');
    expect(exitSpy).toHaveBeenCalledWith(ExitCode.ERROR);
  });

  it('publishes a missing projection backend as BACKEND_UNAVAILABLE, never INTERNAL_ERROR', async () => {
    withPopulationCache.mockImplementationOnce(() => {
      throw missingBackendError({ feature: 'The projection store', packageName: '@vibe-agent-toolkit/projection-sqlite' });
    });

    await expect(claudeContextCommand([], { format: 'yaml' })).rejects.toThrow(PROCESS_EXIT_ERROR_MESSAGE);

    const parsed = yaml.parse(publishedDocument()) as { status: string; error: { code: string } };
    expect(parsed).toMatchObject({ status: 'error', error: { code: 'BACKEND_UNAVAILABLE' } });
    expect(exitSpy).toHaveBeenCalledWith(ExitCode.ERROR);
  });

  // The plugin lane scopes its extraction in the projection store, so a missing
  // sqlite backend reaches `vat inventory`'s catch as the same coded throw.
  it('publishes `vat inventory --format json` with a missing projection backend as BACKEND_UNAVAILABLE', async () => {
    withPopulationCache.mockImplementationOnce(() => {
      throw missingBackendError({ feature: 'The projection store', packageName: '@vibe-agent-toolkit/projection-sqlite' });
    });

    // A directory with no marketplace.json and no SKILL.md name: the plugin lane.
    await expect(inventoryCommand(CLI_PACKAGE_DIR, { format: 'json' })).rejects.toThrow(PROCESS_EXIT_ERROR_MESSAGE);

    const parsed = JSON.parse(publishedDocument()) as { status: string; error: { code: string } };
    expect(parsed).toMatchObject({ status: 'error', error: { code: 'BACKEND_UNAVAILABLE' } });
    expect(exitSpy).toHaveBeenCalledWith(ExitCode.ERROR);
  });
});
