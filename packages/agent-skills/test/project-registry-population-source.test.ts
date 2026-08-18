/* eslint-disable security/detect-non-literal-fs-filename -- every path here is under a per-test temp directory */
/**
 * `createProjectRegistry`'s optional `populationSource` — the packaging lanes'
 * entry onto the projection lane.
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
 */

import { writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { createAllowUsageLedger } from '@vibe-agent-toolkit/schema';
import { mkdirSyncReal, safePath } from '@vibe-agent-toolkit/utils';
import { describe, expect, it } from 'vitest';

import { createProjectRegistry, packageSkills } from '../src/skill-packager.js';

import { setupTempDir } from './test-helpers.js';

const { getTempDir } = setupTempDir('vat-project-registry-population-');

/** Write `content` at `rel` under `root`, creating parents. */
function write(root: string, rel: string, content: string): string {
  const absolute = safePath.join(root, rel);
  mkdirSyncReal(dirname(absolute), { recursive: true });
  writeFileSync(absolute, content, 'utf-8');
  return absolute;
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
      populationSource: async (enumeratedRoot) => {
        offeredRoots.push(enumeratedRoot);
        return [kept];
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
      populationSource: async () => [markdown, html, text, vendored],
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
        populationSource: async (enumeratedRoot) => {
          offeredRoots.push(enumeratedRoot);
          return [skillPath];
        },
      },
    );

    expect(outcomes.map((outcome) => outcome.status)).toEqual(['built']);
    expect(offeredRoots).toEqual([safePath.resolve(root)]);
  });
});
