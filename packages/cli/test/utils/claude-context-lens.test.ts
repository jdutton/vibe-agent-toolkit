import { safePath } from '@vibe-agent-toolkit/utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { buildClaudeContextPopulationMock } = vi.hoisted(() => ({ buildClaudeContextPopulationMock: vi.fn() }));

vi.mock('@vibe-agent-toolkit/resources', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  buildClaudeContextPopulation: buildClaudeContextPopulationMock,
  claudeContextRelations: () => ({ claude_context_chains: [], claude_context_loads: [] }),
}));

vi.mock('../../src/commands/audit/distributed-tree.js', () => ({
  gitTrackerForProjectRoot: async () => undefined,
}));

// eslint-disable-next-line import/first -- must come after vi.mock calls
import { evaluateClaudeContextLens } from '../../src/utils/claude-context-lens.js';

const HIT = { population: 'store', stored: 'hit' } as const;
const WRITTEN = { population: 'derived', stored: 'written' } as const;

const LOGGER = { info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined };

describe('evaluateClaudeContextLens — the lens population is store only when BOTH passes were', () => {
  beforeEach(() => {
    buildClaudeContextPopulationMock.mockReset();
  });

  it.each([
    { importRoots: 'store', outcome: HIT, expected: 'store' },
    // The real pass hit, but the root list was derived: part of the answer was derived.
    { importRoots: 'derived', outcome: HIT, expected: 'derived' },
    { importRoots: 'store', outcome: WRITTEN, expected: 'derived' },
    { importRoots: 'derived', outcome: WRITTEN, expected: 'derived' },
  ] as const)('root list $importRoots, real pass $outcome.stored ⇒ $expected', async ({ importRoots, outcome, expected }) => {
    buildClaudeContextPopulationMock.mockResolvedValue({ projection: {}, outcome, importRoots });

    const { population } = await evaluateClaudeContextLens({
      root: safePath.resolve('/project'),
      logger: LOGGER,
      cache: undefined,
    });

    expect(population).toBe(expected);
  });
});
