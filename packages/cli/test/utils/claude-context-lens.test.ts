import { emptyBlobRows } from '@vibe-agent-toolkit/resources';
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
// eslint-disable-next-line import/first -- must come after vi.mock calls
import { createLogger } from '../../src/utils/logger.js';

/** A projection whose only rows are one blob declined as not text, at a path typed as markdown. */
function declinedMarkdown(): object {
  return {
    ...emptyBlobRows(),
    resourceRealizations: [{ path: 'notes.md', contentKey: 'markdown.bin', contentState: 'keyed', mime: 'text/markdown' }],
    blobConditions: [{ blob: 'markdown.bin', code: 'BLOB_NOT_TEXT', severity: 'warning', message: 'NUL', line: null }],
  };
}

describe('evaluateClaudeContextLens — publishes the population the claude-context lane combined', () => {
  beforeEach(() => {
    buildClaudeContextPopulationMock.mockReset();
  });

  // The rule that combines the root list and the real pass lives in resources
  // (`claudeContextProvenance`); the lens reads its one field and nothing else.
  it.each(['store', 'derived'] as const)('%s ⇒ %s', async (population) => {
    buildClaudeContextPopulationMock.mockResolvedValue({ projection: { ...emptyBlobRows(), resourceRealizations: [] }, population });

    const result = await evaluateClaudeContextLens({
      root: safePath.resolve('/project'),
      cache: undefined,
      logger: createLogger(),
    });

    expect(result.population).toBe(population);
  });

  it("reports its OWN population's refusals, named, because an @-import can reach a file the query lane never holds", async () => {
    buildClaudeContextPopulationMock.mockResolvedValue({ projection: declinedMarkdown(), population: 'derived' });
    const logger = createLogger();
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);

    await evaluateClaudeContextLens({ root: safePath.resolve('/project'), cache: undefined, logger });

    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toMatch(/^claude-context population: blob derivation declined 1 of 1 blob\(s\)/);
  });
});
