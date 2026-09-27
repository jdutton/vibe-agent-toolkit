/**
 * A reached blob with no harness facts is a producer bug, so `vat claude
 * context` could not do its job: exit 2, the error rendered — never exit 0
 * with the file silently charged nothing.
 *
 * The query is stubbed to throw exactly what the resources package throws
 * (`HarnessFactsAbsentError`, carrying `code: HARNESS_FACTS_ABSENT`), and the
 * assertion is on the exit code, the published document and the coded label on
 * stderr — the command recognises the error by `code`, never by message.
 */

import { HarnessFactsAbsentError, type Projection } from '@vibe-agent-toolkit/resources';
import { ExitCode } from '@vibe-agent-toolkit/schema';
import { afterEach, describe, expect, it, vi } from 'vitest';

const BLOB = 'markdown.' + 'a'.repeat(64);

vi.mock('@vibe-agent-toolkit/resources', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  // The REAL class, off the real module — exactly what the query throws.
  const Absent = actual['HarnessFactsAbsentError'] as typeof HarnessFactsAbsentError;
  return {
    ...actual,
    buildClaudeContextPopulation: vi.fn(() => Promise.resolve({} as Projection)),
    whatLoadsAt: vi.fn(() => {
      throw new Absent('claude-code', BLOB, 'acme/CLAUDE.md');
    }),
  };
});

vi.mock('../../../src/utils/projection-store.js', () => ({
  withPopulationCache: (_options: unknown, run: (cache: undefined) => Promise<unknown>) => run(undefined),
}));

vi.mock('../../../src/utils/population-wiring.js', () => ({
  populationWiring: () => ({}),
}));

vi.mock('../../../src/commands/audit/distributed-tree.js', () => ({
  gitTrackerForProjectRoot: () => Promise.resolve(undefined),
}));

const { claudeContextCommand } = await import('../../../src/commands/claude/context.js');

describe('vat claude context — a reached blob with no harness facts', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('exits 2 (could not do its job) and publishes the error, never exit 0', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const outSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    await claudeContextCommand(['.'], { format: 'json' });

    expect(exitSpy).toHaveBeenCalledWith(ExitCode.ERROR);
    expect(exitSpy).not.toHaveBeenCalledWith(ExitCode.OK);
    const published = outSpy.mock.calls.map((call) => String(call[0])).join('');
    expect(published).toContain(BLOB);
    expect(published).toContain('acme/CLAUDE.md');
    // Named by its code on stderr, so an operator can tell VAT's bug from the tree's.
    const diagnostics = errSpy.mock.calls.map((call) => String(call[0])).join('');
    expect(diagnostics).toContain('claude context (HARNESS_FACTS_ABSENT) failed');
  });

  it('is the coded error the resources package exports — dispatchable by code, not message', () => {
    const error = new HarnessFactsAbsentError('claude-code', BLOB, null);
    expect(error.code).toBe(HarnessFactsAbsentError.code);
    expect(error.code).toBe('HARNESS_FACTS_ABSENT');
    expect(error).toBeInstanceOf(Error);
  });
});
