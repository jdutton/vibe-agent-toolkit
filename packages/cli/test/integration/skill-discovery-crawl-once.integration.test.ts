/**
 * Skill discovery crawls each include base once per run: a refusing crawl goes through the run's
 * `crawlOnce`, keyed by everything its result depends on, so a second discovery in the same run
 * (`vat validate`'s skills phase after its resources phase) lists nothing again. A degrading crawl
 * hands its refusals to its own caller and is never shared.
 */

import fs from 'node:fs';

import { type SkillTextRun, withSkillTextRun } from '@vibe-agent-toolkit/agent-skills';
import type { SkillsConfig } from '@vibe-agent-toolkit/resources';
import { normalizedTmpdir, safePath } from '@vibe-agent-toolkit/utils';
import { mkdirSyncReal } from '@vibe-agent-toolkit/utils/fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { discoverSkillsFromConfig } from '../../src/commands/skills/skill-discovery.js';

/** Two include bases, one skill each. */
const CONFIG: SkillsConfig = { include: ['a/skills/**/SKILL.md', 'b/skills/**/SKILL.md'] };

/** A run that holds each crawl, and how often each key was crawled. */
function recordingRun(lane: SkillTextRun): { run: SkillTextRun; asked: string[]; crawled: string[] } {
  const held = new Map<string, Promise<readonly string[]>>();
  const asked: string[] = [];
  const crawled: string[] = [];
  const run: SkillTextRun = {
    source: lane.source,
    dispatcher: lane.dispatcher,
    content: lane.content,
    crawlOnce: (key, crawl) => {
      asked.push(key);
      let result = held.get(key);
      if (result === undefined) {
        crawled.push(key);
        result = crawl();
        held.set(key, result);
      }
      return result;
    },
  };
  return { run, asked, crawled };
}

describe('skill discovery crawls each base once per run', () => {
  let projectRoot: string;

  beforeAll(() => {
    projectRoot = fs.mkdtempSync(safePath.join(normalizedTmpdir(), 'vat-discovery-once-'));
    for (const [dir, name] of [['a/skills/one', 'one'], ['b/skills/two', 'two']] as const) {
      mkdirSyncReal(safePath.join(projectRoot, dir), { recursive: true });
      fs.writeFileSync(safePath.join(projectRoot, dir, 'SKILL.md'), `---\nname: ${name}\ndescription: Skill ${name}.\n---\n# ${name}\n`);
    }
  });

  afterAll(() => {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  it('crawls each base once for two refusing discoveries in one run, and serves both the same skills', async () => {
    await withSkillTextRun(async (lane) => {
      const { run, asked, crawled } = recordingRun(lane);
      const first = await discoverSkillsFromConfig(CONFIG, projectRoot, 'refuse', run);
      const second = await discoverSkillsFromConfig(CONFIG, projectRoot, 'refuse', run);
      expect(first.skills.map((skill) => skill.name).sort((x, y) => x.localeCompare(y))).toEqual(['one', 'two']);
      expect(second).toEqual(first);
      expect(asked).toHaveLength(4);
      expect(crawled).toHaveLength(2);
      expect(new Set(crawled).size).toBe(2);
    }, undefined);
  });

  it('shares the crawl across two spellings of one project root', async () => {
    // `vat validate`'s phases name the root differently (one its config's directory, one the cwd;
    // on Windows, `D:/x` and `D:\x`): the key is the root, not its spelling.
    await withSkillTextRun(async (lane) => {
      const { run, crawled } = recordingRun(lane);
      await discoverSkillsFromConfig(CONFIG, projectRoot, 'refuse', run);
      await discoverSkillsFromConfig(CONFIG, `${projectRoot}/.`, 'refuse', run);
      expect(crawled).toHaveLength(2);
    }, undefined);
  });

  it.runIf(process.platform === 'win32')('shares the crawl across the slash and backslash spellings of one root on Windows', async () => {
    await withSkillTextRun(async (lane) => {
      const { run, crawled } = recordingRun(lane);
      await discoverSkillsFromConfig(CONFIG, projectRoot, 'refuse', run);
      await discoverSkillsFromConfig(CONFIG, projectRoot.replaceAll('/', '\\'), 'refuse', run);
      expect(crawled).toHaveLength(2);
    }, undefined);
  });

  it('never shares a degrading crawl', async () => {
    await withSkillTextRun(async (lane) => {
      const { run, asked } = recordingRun(lane);
      const degrade = { degrade: (): void => undefined };
      await discoverSkillsFromConfig(CONFIG, projectRoot, degrade, run);
      await discoverSkillsFromConfig(CONFIG, projectRoot, degrade, run);
      expect(asked).toEqual([]);
    }, undefined);
  });
});
