/* eslint-disable security/detect-non-literal-fs-filename -- every path here is under a per-test temp directory */
/**
 * `createProjectRegistry`'s optional `populationSource` — the packaging lanes'
 * entry onto the projection lane — and the ROOT-IDENTITY GUARD that decides
 * whether a given lane may answer a given crawl at all.
 *
 * The single claim worth a test here is the one the whole approach rests on:
 * handing the builder a projection-supplied population must NOT widen what the
 * registry admits. `createProjectRegistry` scopes itself with
 * `include: ['**\/*.md']`, and a population source enumerates a whole tree —
 * every file, of every extension, ignored territory included. If the source's
 * answer were taken verbatim the packaging registry would silently grow from
 * "the project's markdown" to "the project", which is a population change
 * wearing a cache's clothes.
 *
 * `ResourceRegistry.populationFrom` is what prevents that, by re-applying the
 * crawl's own `include`/`exclude` through `crawlPathFilter`. These tests pin
 * that behaviour at the packaging builder's own grain, because that is where
 * the `['**\/*.md']` scoping is written and where a future edit could drop it.
 *
 * The final suite pins the guard at the grain that motivated it: the packaging
 * VALIDATOR resolves its own project root with
 * `findProjectRoot(...) ?? dirname(skillPath)`, which in an adopter layout with no
 * config and no `.git` above the build output lands on the OUTPUT directory. A
 * source bound to the project root must be declined there — and, critically, its
 * store must end up holding no extent keyed to that output root, because a
 * poisoned key outlives the run that wrote it.
 */

import { writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import {
  buildResourcePopulation,
  emptyBlobRows,
  type BlobScopedRows,
  type ExtentKey,
  type ExtentScopedRows,
  type ProjectionStore,
  type ResourcePopulationSource,
} from '@vibe-agent-toolkit/resources';
import { createAllowUsageLedger } from '@vibe-agent-toolkit/schema';
import { mkdirSyncReal, resetProjectRootCaches, safePath } from '@vibe-agent-toolkit/utils';
import { beforeEach, describe, expect, it } from 'vitest';

import { createProjectRegistry, packageSkills } from '../src/skill-packager.js';
import { resetPackagingRegistryCache, validateSkillForPackaging } from '../src/validators/packaging-validator.js';

import { setupTempDir } from './test-helpers.js';

const { getTempDir } = setupTempDir('vat-project-registry-population-');

/** Write `content` at `rel` under `root`, creating parents. */
function write(root: string, rel: string, content: string): string {
  const absolute = safePath.join(root, rel);
  mkdirSyncReal(dirname(absolute), { recursive: true });
  writeFileSync(absolute, content, 'utf-8');
  return absolute;
}

/** Frontmatter valid enough for the validator to reach the crawl. */
const SKILL_MD = [
  '---',
  'name: demo',
  'description: A built skill used to pin which root a population source may answer for.',
  '---',
  '',
  '# Demo',
  '',
  'Nothing linked.',
  '',
].join('\n');

/**
 * A store that records the extent keys it is asked about and holds nothing.
 *
 * Every read is a miss, so the projection always enumerates and always writes —
 * which is what makes "no key was ever written" a statement about the guard and
 * not about a lucky cache hit.
 */
function recordingStore(): ProjectionStore & { touchedRootIds: string[] } {
  const touchedRootIds: string[] = [];
  return {
    touchedRootIds,
    writeBlobFacts: () => Promise.resolve(),
    readBlobFacts: (): Promise<BlobScopedRows> => Promise.resolve(emptyBlobRows()),
    writeExtent: (key: ExtentKey) => {
      touchedRootIds.push(key.rootId);
      return Promise.resolve();
    },
    readExtent: (key: ExtentKey): Promise<ExtentScopedRows | undefined> => {
      touchedRootIds.push(key.rootId);
      return Promise.resolve(undefined);
    },
    close: () => Promise.resolve(),
  };
}

/**
 * A REAL projection-backed source bound to `boundRoot`, over `store`.
 *
 * Real rather than a stub because the claim under test is about the STORE: a stub
 * source touches no store, so it could not show a key being written or not
 * written.
 */
function projectionSource(
  boundRoot: string,
  store: ProjectionStore,
): { source: ResourcePopulationSource; offeredRoots: string[] } {
  const offeredRoots: string[] = [];
  return {
    offeredRoots,
    source: {
      root: boundRoot,
      enumerate: async (root: string) => {
        offeredRoots.push(root);
        const population = await buildResourcePopulation({
          root,
          cache: { store, treeHash: 'test-tree-hash' },
        });
        return population.paths;
      },
    },
  };
}

/** Registry members as root-relative forward-slashed paths, sorted. */
function memberPaths(root: string, registry: { getAllResources: () => { filePath: string }[] }): string[] {
  return registry
    .getAllResources()
    .map((resource) => safePath.relative(root, resource.filePath))
    .sort((left, right) => left.localeCompare(right));
}

describe('createProjectRegistry populationSource', () => {
  it('sources its population from the supplied source instead of walking', async () => {
    const root = getTempDir();
    const kept = write(root, 'docs/kept.md', '# kept\n');
    write(root, 'docs/walked-but-not-offered.md', '# invisible\n');

    // The source offers exactly ONE of the two markdown files on disk. A walk
    // would find both, so a registry holding one file can only have come from
    // here.
    const offeredRoots: string[] = [];
    const registry = await createProjectRegistry(root, {
      populationSource: {
        root,
        enumerate: async (enumeratedRoot) => {
          offeredRoots.push(enumeratedRoot);
          return [kept];
        },
      },
    });

    expect(offeredRoots).toEqual([safePath.resolve(root)]);
    expect(memberPaths(root, registry)).toEqual(['docs/kept.md']);
  });

  it("narrows the supplied population through its own '**/*.md' include", async () => {
    const root = getTempDir();
    const markdown = write(root, 'docs/guide.md', '# guide\n');
    const html = write(root, 'docs/guide.html', '<p>guide</p>');
    const text = write(root, 'notes.txt', 'notes');
    const vendored = write(root, 'node_modules/pkg/readme.md', '# vendored\n');

    // Everything the extent would enumerate, handed over verbatim — the shape a
    // real projection population arrives in.
    const registry = await createProjectRegistry(root, {
      populationSource: { root, enumerate: async () => [markdown, html, text, vendored] },
    });

    expect(memberPaths(root, registry)).toEqual(['docs/guide.md']);
  });

  it('keeps walking when no source is supplied', async () => {
    const root = getTempDir();
    write(root, 'docs/a.md', '# a\n');
    write(root, 'docs/b.md', '# b\n');

    const registry = await createProjectRegistry(root);

    expect(memberPaths(root, registry)).toEqual(['docs/a.md', 'docs/b.md']);
  });
});

describe('packageSkills populationSource', () => {
  it('threads the source through to the run-wide registry it builds', async () => {
    const root = getTempDir();
    const skillPath = write(
      root,
      'skills/demo/SKILL.md',
      '---\nname: demo\ndescription: A demo skill used to prove the population source is threaded through.\n---\n\n# Demo\n\nNothing linked.\n',
    );

    // `packageSkills` builds THE registry for the run itself, so the only way a
    // caller can put that build on the projection lane is through this option.
    // A source that records its invocation is the smallest thing that can tell
    // "threaded" from "silently dropped" — the failure mode this lane keeps
    // hitting is an opt-in that quietly does nothing while the run still
    // succeeds.
    const offeredRoots: string[] = [];
    const outcomes = await packageSkills(
      [{ skillPath, options: { outputPath: safePath.join(root, 'out', 'demo') } }],
      root,
      createAllowUsageLedger(),
      {
        populationSource: {
          root,
          enumerate: async (enumeratedRoot) => {
            offeredRoots.push(enumeratedRoot);
            return [skillPath];
          },
        },
      },
    );

    expect(outcomes.map((outcome) => outcome.status)).toEqual(['built']);
    expect(offeredRoots).toEqual([safePath.resolve(root)]);
  });
});

describe('the packaging validator\'s own project root, against a source bound to another', () => {
  // Both caches are process-global and both are keyed on a directory, so a test
  // reusing a sibling temp tree would otherwise read the previous test's answer.
  beforeEach(() => {
    resetProjectRootCaches();
    resetPackagingRegistryCache();
  });

  it('serves the source when the validator climbs back to the SAME root', async () => {
    const root = getTempDir();
    // A config at the root is what makes `findProjectRoot` climb OUT of the build
    // output and back to the tree the source describes — the layout in which
    // forwarding a source into a built-tree validation is legal.
    write(root, 'vibe-agent-toolkit.config.yaml', 'skills:\n  discovery: []\n');
    const builtSkillPath = write(root, 'dist/skills/demo/SKILL.md', SKILL_MD);
    const store = recordingStore();
    const { source, offeredRoots } = projectionSource(root, store);

    await validateSkillForPackaging(builtSkillPath, undefined, 'built', { populationSource: source });

    // The POSITIVE CONTROL for the next test: same helper, same store shape, and
    // here the lane really does run and really does key an extent. Without it,
    // "the store holds nothing" would be satisfied by a store nobody can write to.
    expect(offeredRoots).toEqual([safePath.resolve(root)]);
    expect(store.touchedRootIds.length).toBeGreaterThan(0);
  });

  it('declines the source — and writes NO extent — when it lands on the output root', async () => {
    const root = getTempDir();
    // No config and no `.git` above the output, so `findProjectRoot` returns null
    // and the validator's project root becomes `<root>/out/demo`. This is the
    // revert's exact case.
    const outputRoot = safePath.join(root, 'out', 'demo');
    const builtSkillPath = write(root, 'out/demo/SKILL.md', SKILL_MD);
    const store = recordingStore();
    const { source, offeredRoots } = projectionSource(root, store);

    const result = await validateSkillForPackaging(builtSkillPath, undefined, 'built', {
      populationSource: source,
    });

    // The enumeration never happened, so nothing could be keyed to the output
    // root — the poisoning, not merely the wrong offer, is what must be
    // impossible. Asserted on the whole store rather than on one absent key: the
    // output root is the only root this source could have been asked about.
    expect(store.touchedRootIds).toEqual([]);
    expect(offeredRoots).toEqual([]);
    expect(outputRoot).not.toBe(safePath.resolve(root));
    // And the validation still ran, on the walk. A guard that declined by
    // returning an empty population would report a confident green over a corpus
    // it never looked at.
    expect(result.metadata.fileCount).toBeGreaterThan(0);
  });
});
