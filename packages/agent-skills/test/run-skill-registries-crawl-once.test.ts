/**
 * `RunSkillRegistries.crawlOnce`: one skill discovery crawl per key per run, the first caller's
 * answer, a rejection included, handed to every later caller of the key. The memo is the run's
 * (`RunPopulation.crawlOnce`), never the registries': every registries object over one run shares it.
 */

import { memoized } from '@vibe-agent-toolkit/utils';
import { describe, expect, it, vi } from 'vitest';

import { RunSkillRegistries, type RunSkillRegistriesOptions, withSkillRegistries } from '../src/validators/run-skill-registries.js';

import { setupTempDir } from './test-helpers.js';

const { getTempDir } = setupTempDir('run-skill-registries-crawl-once-');

describe('RunSkillRegistries.crawlOnce', () => {
  it('crawls once per key and hands every later caller the first answer', async () => {
    const crawl = vi.fn(() => Promise.resolve(['skills/a/SKILL.md']));
    await withSkillRegistries(getTempDir(), async (run) => {
      expect(await run.crawlOnce('skills', crawl)).toEqual(['skills/a/SKILL.md']);
      expect(await run.crawlOnce('skills', crawl)).toEqual(['skills/a/SKILL.md']);
    });
    expect(crawl).toHaveBeenCalledTimes(1);
  });

  it('crawls each key apart', async () => {
    await withSkillRegistries(getTempDir(), async (run) => {
      expect(await run.crawlOnce('a', () => Promise.resolve(['a']))).toEqual(['a']);
      expect(await run.crawlOnce('b', () => Promise.resolve(['b']))).toEqual(['b']);
    });
  });

  it('keeps a rejection: a later caller of the key meets it and crawls nothing', async () => {
    const failure = new Error('unlistable');
    const again = vi.fn(() => Promise.resolve([]));
    await withSkillRegistries(getTempDir(), async (run) => {
      await expect(run.crawlOnce('skills', () => Promise.reject(failure))).rejects.toBe(failure);
      await expect(run.crawlOnce('skills', again)).rejects.toBe(failure);
    });
    expect(again).not.toHaveBeenCalled();
  });

  it('holds no memo of its own: two registries over one run crawl a key once between them', async () => {
    const memo = new Map<string, Promise<readonly string[]>>();
    // Only the run's crawl memo is touched: no registry, population or dispatcher is used.
    const options = { crawlOnce: (key: string, crawl: () => Promise<readonly string[]>) => memoized(memo, key, crawl) } as Partial<RunSkillRegistriesOptions> as RunSkillRegistriesOptions;
    const crawl = vi.fn(() => Promise.resolve(['skills/a/SKILL.md']));
    await new RunSkillRegistries(options).crawlOnce('skills', crawl);
    expect(await new RunSkillRegistries(options).crawlOnce('skills', crawl)).toEqual(['skills/a/SKILL.md']);
    expect(crawl).toHaveBeenCalledTimes(1);
  });

  it('is per run: a second run crawls the key again', async () => {
    const crawl = vi.fn(() => Promise.resolve([]));
    await withSkillRegistries(getTempDir(), (run) => run.crawlOnce('skills', crawl));
    await withSkillRegistries(getTempDir(), (run) => run.crawlOnce('skills', crawl));
    expect(crawl).toHaveBeenCalledTimes(2);
  });
});
