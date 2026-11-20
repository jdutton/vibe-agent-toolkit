/**
 * `RunSkillRegistries`: one run's views of its registry, one per (include set, root), crawled
 * once per run and served to every later caller.
 *
 * Two callers of one root may hold different `unreadable` rulings (`vat audit` degrades, every
 * other verb refuses), so a view keeps the refusals its one crawl met and settles them again under
 * EACH later caller's policy. A crawl that rejected is never served. What a caller writes decides
 * which side a fault is on, never which files the crawl finds, so it never splits a view.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import type { ResourceRegistry } from '@vibe-agent-toolkit/resources';
import { FS_FAULT_CODE, mkdirSyncReal, normalizedTmpdir, safePath, toForwardSlash } from '@vibe-agent-toolkit/utils';
import { type DirectoryRefusal, DirectoryListingRefusedError } from '@vibe-agent-toolkit/utils/crawl';
import { gitExecutable, withReaddirSyncRefused } from '@vibe-agent-toolkit/utils/testing';
import { afterAll, describe, expect, it } from 'vitest';

import { validateSkillForPackaging } from '../../src/validators/packaging-validator.js';
import { type SkillRegistryRuling, withSkillRegistries } from '../../src/validators/run-skill-registries.js';

/** Every scratch root this file made, removed once at the end. */
const scratchRoots: string[] = [];

afterAll(() => {
  for (const root of scratchRoots) rmSync(root, { recursive: true, force: true });
});

/** A fresh scratch root holding `files` (root-relative path to content), registered for teardown. */
function rootWith(files: Record<string, string>): string {
  const root = mkdtempSync(safePath.join(normalizedTmpdir(), 'vat-run-skill-registries-'));
  scratchRoots.push(root);
  for (const [relative, content] of Object.entries(files)) write(root, relative, content);
  return root;
}

/** Write `content` at `relative` under `root`, creating parents. */
function write(root: string, relative: string, content: string): string {
  const absolute = safePath.join(root, relative);
  mkdirSyncReal(dirname(absolute), { recursive: true });
  writeFileSync(absolute, content, 'utf-8');
  return absolute;
}

/** Every admitted resource, root-relative and sorted. */
function membersOf(root: string, registry: ResourceRegistry): string[] {
  return registry
    .getAllResources()
    .map((resource) => toForwardSlash(safePath.relative(root, resource.filePath)))
    .toSorted((a, b) => a.localeCompare(b));
}

const REFUSE: SkillRegistryRuling = { unreadable: 'refuse', outputs: [] };

/** A ruling that degrades, recording each refusal it is handed into `into`. */
function degradeInto(into: DirectoryRefusal[]): SkillRegistryRuling {
  return { unreadable: { degrade: (refusal) => { into.push(refusal); } }, outputs: [] };
}

describe('RunSkillRegistries.packagingRegistry', () => {
  it('admits the markdown of the population only', async () => {
    const root = rootWith({
      'docs/guide.md': '# guide\n',
      'docs/guide.html': '<p>guide</p>',
      'notes.txt': 'notes',
      'node_modules/pkg/readme.md': '# vendored\n',
    });

    const members = await withSkillRegistries(root, async (registries) =>
      membersOf(root, await registries.packagingRegistry(root, [])));

    expect(members).toEqual(['docs/guide.md']);
  });
});

describe('RunSkillRegistries.forRoot: what the caller writes', () => {
  it('serves one view to callers that each declare a different output', async () => {
    const root = rootWith({ 'a.md': '# A\n' });

    const views = await withSkillRegistries(root, async (registries) => {
      const seen = new Set<ResourceRegistry>();
      for (const skill of ['one', 'two', 'three']) {
        seen.add(await registries.forRoot(root, { unreadable: 'refuse', outputs: [safePath.join(root, 'out', skill)] }));
      }
      return seen;
    });

    expect(views.size).toBe(1);
  });

  it('classifies a vanished root as the destination\'s only when it holds a declared output', async () => {
    const root = rootWith({ 'a.md': '# A\n' });
    const crawlVanished = (outputs: string[]): Promise<ResourceRegistry> =>
      withSkillRegistries(root, (registries) =>
        withReaddirSyncRefused(root, 'ENOENT', () => registries.forRoot(root, { unreadable: 'refuse', outputs })));

    await expect(crawlVanished([])).rejects.toMatchObject({ code: FS_FAULT_CODE, side: 'source', faultClass: 'absent' });
    await expect(crawlVanished([safePath.join(root, 'dist')]))
      .rejects.toMatchObject({ code: FS_FAULT_CODE, side: 'destination', faultClass: 'absent' });
  });
});

/** A root with a built skill under `out/` and the staging residue an interrupted build leaves beside it. */
function rootWithStagedOutput(): { root: string; output: string } {
  const root = rootWith({
    'a.md': '# A\n',
    'out/skill/SKILL.md': '# Built\n',
    'out/.skill.vat-staged-0a1b2c3d/SKILL.md': '# Built\n',
  });
  return { root, output: safePath.join(root, 'out', 'skill') };
}

/** Crawl `root` twice in one run (the second declaring `output`) and assert the served view holds no residue. */
async function expectServedViewWithoutResidue(root: string, output: string): Promise<void> {
  const members = await withSkillRegistries(root, async (registries) => {
    const first = await registries.forRoot(root, REFUSE);
    const served = await registries.forRoot(root, { unreadable: 'refuse', outputs: [output] });
    expect(served).toBe(first);
    return membersOf(root, served);
  });
  expect(members).toContain('a.md');
  expect(members).not.toContain('out/.skill.vat-staged-0a1b2c3d/SKILL.md');
}

/**
 * A view never holds a build's staging residue (`.<name>.vat-staged-*`): it is the tree-change
 * primitive's transient copy, and a skill served a view holding it would resolve links into a
 * directory that is renamed away. Asserted on a served view, on both routes the population takes.
 */
describe('RunSkillRegistries.forRoot: the build\'s staging residue is never in a view', () => {
  it('on the filesystem route', async () => {
    const { root, output } = rootWithStagedOutput();
    await expectServedViewWithoutResidue(root, output);
  });

  it('on the git route', async () => {
    const { root, output } = rootWithStagedOutput();
    spawnSync(gitExecutable(), ['init', '-q', root], { stdio: 'ignore' });
    await expectServedViewWithoutResidue(root, output);
  });
});

/** A root whose `docs/locked` directory the first crawl is refused. */
function lockedRoot(): { root: string; locked: string } {
  const root = rootWith({ 'docs/open/ok.md': '# ok\n', 'docs/locked/t.md': '# t\n' });
  return { root, locked: safePath.join(root, 'docs', 'locked') };
}

describe('RunSkillRegistries.forRoot replays a view\'s refusals under each caller\'s policy', () => {
  it("a 'refuse' caller served a degrade-built view gets the throw the crawl would have given it", async () => {
    const { root, locked } = lockedRoot();
    const handed: DirectoryRefusal[] = [];

    await withSkillRegistries(root, async (registries) => {
      await withReaddirSyncRefused(locked, 'EACCES', () => registries.forRoot(root, degradeInto(handed)));
      expect(handed.map((refusal) => refusal.directory)).toEqual([toForwardSlash(locked)]);

      // The directory is readable again by now: the view, not the filesystem, must answer.
      await expect(registries.forRoot(root, REFUSE)).rejects.toBeInstanceOf(DirectoryListingRefusedError);
      await expect(registries.forRoot(root, REFUSE)).rejects.toThrow("the directory 'docs/locked'");
    });
  });

  it('a second { degrade } caller is told about the refusal the one crawl met, and served the same gap', async () => {
    const { root, locked } = lockedRoot();

    const second: DirectoryRefusal[] = [];
    const members = await withSkillRegistries(root, async (registries) => {
      await withReaddirSyncRefused(locked, 'EACCES', () => registries.forRoot(root, degradeInto([])));
      return membersOf(root, await registries.forRoot(root, degradeInto(second)));
    });

    expect(second.map((refusal) => ({ directory: refusal.directory, code: refusal.code }))).toEqual([
      { directory: toForwardSlash(locked), code: 'EACCES' },
    ]);
    expect(members).toEqual(['docs/open/ok.md']);
  });

  it("a view built under 'refuse' carries no refusals, so a later { degrade } caller's handler is never called", async () => {
    const { root } = lockedRoot();
    const handed: DirectoryRefusal[] = [];

    const members = await withSkillRegistries(root, async (registries) => {
      const first = await registries.forRoot(root, REFUSE);
      const second = await registries.forRoot(root, degradeInto(handed));
      expect(second).toBe(first);
      return membersOf(root, first);
    });

    expect(handed).toEqual([]);
    expect(members).toEqual(['docs/locked/t.md', 'docs/open/ok.md']);
  });

  // A rejection was decided under the ruling of the caller that started it, so it must not
  // decide the NEXT caller's outcome: a { degrade } caller after a 'refuse' rejection is served a view.
  it("a crawl that rejected is never served: the next caller's crawl is its own", async () => {
    const { root, locked } = lockedRoot();

    const members = await withSkillRegistries(root, async (registries) => {
      await expect(withReaddirSyncRefused(locked, 'EACCES', () => registries.forRoot(root, REFUSE)))
        .rejects.toBeInstanceOf(DirectoryListingRefusedError);
      return membersOf(root, await registries.forRoot(root, degradeInto([])));
    });

    expect(members).toContain('docs/open/ok.md');
  });
});

describe('a built skill validated against a view that predates the build', () => {
  // The view "covers" the bundle by directory alone (it was crawled before the build wrote it),
  // so the bundle must be layered over it.
  it('layers the bundle over the view, so its links are followed', async () => {
    const root = rootWith({ 'vibe-agent-toolkit.config.yaml': '{}\n', 'docs/readme.md': '# Readme\n' });

    const result = await withSkillRegistries(root, async (registries) => {
      await registries.forRoot(root, REFUSE);
      const builtSkillPath = write(root, 'out/demo/SKILL.md', [
        '---',
        'name: demo',
        'description: A built skill validated against a view crawled before the build wrote it.',
        '---',
        '',
        '# Demo',
        '',
        'See [the reference](./reference.md).',
        '',
      ].join('\n'));
      write(root, 'out/demo/reference.md', '# Reference\n');
      return validateSkillForPackaging(builtSkillPath, {}, undefined, 'built', {
        dispatcher: undefined,
        registries,
        unreadable: 'refuse',
        outputs: [safePath.join(root, 'out', 'demo')],
      });
    });

    // SKILL.md and the reference it links: both read, from the bundle the view lacks.
    expect(result.metadata.fileCount).toBe(2);
  });
});
