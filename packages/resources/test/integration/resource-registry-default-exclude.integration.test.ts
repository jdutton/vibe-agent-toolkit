/**
 * `ResourceRegistry.crawl`'s DEFAULT exclude drops only what can never be authored content:
 * dependencies, git internals, worktree copies, a build's staging residue, and `dist/`.
 *
 * A directory named for a tool's output (`coverage/`, `.test-output/`, `.turbo/`) is not that.
 * `references/coverage/workers-comp.md` is an author's markdown, and a registry that drops it
 * leaves its links unfollowed and its targets out of every bundle — with exit 0. Asserted on
 * each route the crawl can take: the walk, the git route, and a real projection population.
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';

import { mkdirSyncReal, normalizedTmpdir, safePath } from '@vibe-agent-toolkit/utils';
import { gitExecutable } from '@vibe-agent-toolkit/utils/testing';
import { afterAll, describe, expect, it } from 'vitest';

import { buildResourcePopulation } from '../../src/projection/resource-population.js';
import type { ResourcePopulationSource } from '../../src/projection/resource-population.js';
import { ResourceRegistry } from '../../src/resource-registry.js';

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

/** Authored markdown under directories a tool's output is often named for. */
const AUTHORED = {
  'README.md': '# Root\n\nSee [coverage](./docs/coverage/x.md), [output](./docs/.test-output/t.md) and [turbo](./docs/.turbo/u.md).\n',
  'docs/coverage/x.md': '# X\n\nSee [y](./y.md).\n',
  'docs/coverage/y.md': '# Y\n',
  'docs/.test-output/t.md': '# T\n',
  'docs/.turbo/u.md': '# U\n',
  // Never content: each must stay out.
  'node_modules/pkg/README.md': '# dependency\n',
  'dist/built.md': '# built\n',
  '.claude/worktrees/copy/README.md': '# worktree copy\n',
  'out/.skill.vat-staged-0a1b2c3d/SKILL.md': '# staged\n',
} as const;

function fixture(git: boolean): string {
  const root = mkdtempSync(safePath.join(normalizedTmpdir(), 'vat-registry-default-exclude-'));
  roots.push(root);
  for (const [relative, content] of Object.entries(AUTHORED)) {
    const path = safePath.join(root, relative);
    mkdirSyncReal(safePath.join(path, '..'), { recursive: true });
    writeFileSync(path, content);
  }
  if (git) spawnSync(gitExecutable(), ['init', '-q', root], { stdio: 'ignore' });
  return root;
}

async function crawled(root: string, populationSource?: ResourcePopulationSource): Promise<ResourceRegistry> {
  const registry = new ResourceRegistry({ baseDir: root });
  await registry.crawl({ baseDir: root, outputs: [], unreadable: 'refuse', ...(populationSource !== undefined && { populationSource }) });
  registry.resolveLinks();
  return registry;
}

const ROUTES: ReadonlyArray<readonly [string, () => Promise<{ root: string; registry: ResourceRegistry }>]> = [
  ['the walk', async () => { const root = fixture(false); return { root, registry: await crawled(root) }; }],
  ['the git route', async () => { const root = fixture(true); return { root, registry: await crawled(root) }; }],
  ['a projection population', async () => {
    const root = fixture(true);
    const source: ResourcePopulationSource = { root, enumerate: (at, outputs) => buildResourcePopulation({ outputs, root: at }) };
    return { root, registry: await crawled(root, source) };
  }],
];

describe.each(ROUTES)('ResourceRegistry.crawl default exclude — %s', (_route, run) => {
  it('admits authored markdown under a tool-output-named directory, and follows its links', async () => {
    const { root, registry } = await run();
    const at = (relative: string) => safePath.join(root, relative);

    for (const member of ['README.md', 'docs/coverage/x.md', 'docs/coverage/y.md', 'docs/.test-output/t.md', 'docs/.turbo/u.md']) {
      expect(registry.getResource(at(member)), member).toBeDefined();
    }
    // `resolvedId` is set only when the target is a member, and every target was asserted one above.
    const targetsOf = (relative: string) => registry.getResource(at(relative))?.links.map((link) => link.resolvedId);
    const idOf = (relative: string) => registry.getResource(at(relative))?.id;
    expect(targetsOf('README.md')).toEqual([idOf('docs/coverage/x.md'), idOf('docs/.test-output/t.md'), idOf('docs/.turbo/u.md')]);
    expect(targetsOf('docs/coverage/x.md')).toEqual([idOf('docs/coverage/y.md')]);
  });

  it('still drops what can never be content', async () => {
    const { root, registry } = await run();
    for (const never of ['node_modules/pkg/README.md', 'dist/built.md', '.claude/worktrees/copy/README.md', 'out/.skill.vat-staged-0a1b2c3d/SKILL.md']) {
      expect(registry.getResource(safePath.join(root, never)), never).toBeUndefined();
    }
  });
});
