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

const LOGGER = { info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined };

describe('evaluateClaudeContextLens — publishes the population the claude-context lane combined', () => {
  beforeEach(() => {
    buildClaudeContextPopulationMock.mockReset();
  });

  // The rule that combines the root list and the real pass lives in resources
  // (`claudeContextProvenance`); the lens reads its one field and nothing else.
  it.each(['store', 'derived'] as const)('%s ⇒ %s', async (population) => {
    buildClaudeContextPopulationMock.mockResolvedValue({ projection: {}, population });

    const result = await evaluateClaudeContextLens({
      root: safePath.resolve('/project'),
      logger: LOGGER,
      cache: undefined,
    });

    expect(result.population).toBe(population);
  });
});
