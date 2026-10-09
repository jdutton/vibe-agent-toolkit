/**
 * `ResourceRegistry.crawl` hands the caller's `outputs` — what its verb writes — to the walk
 * and to a population source as is. Only the caller knows which trees it writes (a packaging
 * run's project root holds its own output), and every side a crawl fault is classified on is
 * derived from that one declaration: the registry must neither drop it nor decide it.
 */
import type * as Crawl from '@vibe-agent-toolkit/utils/crawl';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ResourceRegistry } from '../src/resource-registry.js';

const seen = vi.hoisted(() => ({ options: [] as unknown[] }));

vi.mock('@vibe-agent-toolkit/utils/crawl', async (importOriginal) => {
  const original = await importOriginal<typeof Crawl>();
  return {
    ...original,
    crawlDirectory: (options: Crawl.CrawlOptions) => {
      seen.options.push(options);
      return Promise.resolve([]);
    },
  };
});

const OUTPUT = '/p/dist/skills';

describe('ResourceRegistry.crawl - what the verb writes', () => {
  afterEach(() => {
    seen.options.length = 0;
  });

  it('forwards the declared outputs to the walk', async () => {
    await new ResourceRegistry().crawl({ baseDir: '.', unreadable: 'refuse', outputs: [OUTPUT] });

    expect(seen.options).toEqual([expect.objectContaining({ outputs: [OUTPUT] })]);
  });

  it('forwards an empty declaration to the walk: required, never defaulted', async () => {
    await new ResourceRegistry().crawl({ baseDir: '.', unreadable: 'refuse', outputs: [] });

    expect(seen.options).toEqual([expect.objectContaining({ outputs: [] })]);
  });
});

describe('ResourceRegistry.crawl - what a population source is told the verb writes', () => {
  it('hands the declared outputs to the population source, whichever they are', async () => {
    const asked: unknown[] = [];
    const populationSource = {
      root: '/p',
      enumerate: (root: string, outputs: readonly string[]) => {
        asked.push([root, outputs]);
        return Promise.resolve({ paths: [], conditions: [] });
      },
    };

    await new ResourceRegistry().crawl({ baseDir: '/p', unreadable: 'refuse', populationSource, outputs: [OUTPUT] });
    await new ResourceRegistry().crawl({ baseDir: '/p', unreadable: 'refuse', populationSource, outputs: [] });

    expect(asked).toEqual([['/p', [OUTPUT]], ['/p', []]]);
  });
});
