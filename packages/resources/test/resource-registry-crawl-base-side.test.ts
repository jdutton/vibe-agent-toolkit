/**
 * `ResourceRegistry.crawl` hands the caller's `outputs` — what its verb writes — to the
 * population source as is. Only the caller knows which trees it writes (a packaging run's
 * project root holds its own output), and every side a crawl fault is classified on is
 * derived from that one declaration: the registry must neither drop it nor decide it.
 */
import { safePath } from '@vibe-agent-toolkit/utils';
import { normalizedTmpdir } from '@vibe-agent-toolkit/utils/fs';
import { describe, expect, it } from 'vitest';

import type { ResourcePopulationSource } from '../src/projection/resource-population.js';
import { ResourceRegistry } from '../src/resource-registry.js';

/** Spelled as the registry resolves it (a `/`-rooted literal gains a drive letter on Windows). Never made: no test here reads or writes under it. */
const ROOT = safePath.resolve(normalizedTmpdir(), 'vat-crawl-base-side');
const OUTPUT = safePath.join(ROOT, 'dist/skills');

describe('ResourceRegistry.crawl - what a population source is told the verb writes', () => {
  it('hands the declared outputs to the population source, whichever they are, an empty declaration included', async () => {
    const asked: unknown[] = [];
    const populationSource: ResourcePopulationSource = {
      enumerate: (root, outputs) => {
        asked.push([root, outputs]);
        return Promise.resolve({ paths: [], conditions: [], outcome: { population: 'derived', stored: 'no-store' }, extentSource: 'filesystem' });
      },
    };

    await new ResourceRegistry().crawl({ ignoredRefusals: 'record', baseDir: ROOT, unreadable: 'refuse', populationSource, outputs: [OUTPUT] });
    await new ResourceRegistry().crawl({ ignoredRefusals: 'record', baseDir: ROOT, unreadable: 'refuse', populationSource, outputs: [] });

    expect(asked).toEqual([[ROOT, [OUTPUT]], [ROOT, []]]);
  });
});
