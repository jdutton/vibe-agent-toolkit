/**
 * A broken INSTALL fails the inventory; it is never a row on the skill.
 *
 * Both of the skill extractor's catches used to file EVERYTHING they caught as a
 * `parseErrors` row on SKILL.md. The parser loads lazily — only on a cache miss —
 * so with SKILL.md's frontmatter answered and its link walk missing, a broken
 * install surfaced as one `link walk failed: …` row, which `vat audit` then drops
 * (`appendInventoryParseErrors` keeps only refused and unreadable rows): the run
 * exited 0 having walked nothing. Each catch now classifies what it caught with
 * `classifyParseFailure`, an allowlist, and every VAT defect is rethrown.
 *
 * The seam is the resources barrel: `ResourceRegistry.addResources` is where the
 * link walk's parses run, and `parseFrontmatter` is where the frontmatter decode's
 * does. Everything else — the classifier included — is the shipped code.
 */

import { writeFileSync } from 'node:fs';

import type * as AgentSkillsModule from '@vibe-agent-toolkit/agent-skills';
import type * as ResourcesModule from '@vibe-agent-toolkit/resources';
import { ParserUnavailableError } from '@vibe-agent-toolkit/resources';
import { mkdirSyncReal, resetProjectRootCaches, safePath } from '@vibe-agent-toolkit/utils';
import { setupAsyncTempDirSuite } from '@vibe-agent-toolkit/utils/testing';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { extractClaudeSkillInventory, NO_GIT_TRACKER } from '../../src/inventory/extract-skill.js';

/** What the armed seam rejects with, or nothing. */
const armed = vi.hoisted(() => ({ walk: undefined as unknown, frontmatter: undefined as unknown }));

vi.mock('@vibe-agent-toolkit/resources', async (importOriginal) => {
  const actual = await importOriginal<typeof ResourcesModule>();
  class ArmedRegistry extends actual.ResourceRegistry {
    override async addResources(...args: Parameters<ResourcesModule.ResourceRegistry['addResources']>): ReturnType<ResourcesModule.ResourceRegistry['addResources']> {
      if (armed.walk !== undefined) throw armed.walk;
      return super.addResources(...args);
    }
  }
  return { ...actual, ResourceRegistry: ArmedRegistry };
});

vi.mock('@vibe-agent-toolkit/agent-skills', async (importOriginal) => {
  const actual = await importOriginal<typeof AgentSkillsModule>();
  const parseFrontmatter: typeof actual.parseFrontmatter = async (content, route) => {
    if (armed.frontmatter !== undefined) throw armed.frontmatter;
    return actual.parseFrontmatter(content, route);
  };
  return { ...actual, parseFrontmatter };
});

const SKILL_MD = ['---', 'name: broken-install', 'description: Links one document', '---', '', '[Ref](./ref.md)', ''].join('\n');

/** The failure a missing worker entry produces, from the real exported class. */
function brokenInstall(): ParserUnavailableError {
  return new ParserUnavailableError('markdown', 'parse-worker.js', Object.assign(new Error('Cannot find module'), { code: 'ERR_MODULE_NOT_FOUND' }));
}

describe('a broken parser install during skill extraction', () => {
  const suite = setupAsyncTempDirSuite('extract-skill-broken-install');
  let skillPath = '';

  beforeAll(async () => {
    await suite.beforeAll();
    await suite.beforeEach();
    const root = safePath.join(suite.getTempDir(), 'plain');
    mkdirSyncReal(root, { recursive: true });
    skillPath = safePath.join(root, 'SKILL.md');
    writeFileSync(skillPath, SKILL_MD, 'utf-8');
    writeFileSync(safePath.join(root, 'ref.md'), '# ref\n', 'utf-8');
    resetProjectRootCaches();
  });

  afterAll(suite.afterAll);

  afterEach(() => {
    armed.walk = undefined;
    armed.frontmatter = undefined;
  });

  const extract = () => extractClaudeSkillInventory(skillPath, { gitTrackerSource: NO_GIT_TRACKER });

  it('rejects when the link walk meets it, instead of filing a `link walk failed` row', async () => {
    const thrown = brokenInstall();
    armed.walk = thrown;

    await expect(extract()).rejects.toBe(thrown);
  });

  it('rejects when the link walk meets any other VAT defect: the allowlist, not one type', async () => {
    const thrown = new Error('VAT defect: an unbranded worker failure');
    armed.walk = thrown;

    await expect(extract()).rejects.toBe(thrown);
  });

  it('rejects when the frontmatter decode meets it, instead of filing a row on SKILL.md', async () => {
    const thrown = brokenInstall();
    armed.frontmatter = thrown;

    await expect(extract()).rejects.toBe(thrown);
  });

  it('walks the skill with nothing armed — the control the rejections are read against', async () => {
    const inventory = await extract();

    expect(inventory.parseErrors).toEqual([]);
    expect(inventory.files.linked).toEqual([safePath.join(safePath.resolve(skillPath, '..'), 'ref.md')]);
  });
});
