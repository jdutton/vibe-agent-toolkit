/**
 * The harness pass inside `populate`'s closure fixpoint.
 *
 * A declared `claude-import` closure whose root is NOT an entry point is
 * invisible to the pass before the closure stratum runs — its declaration only
 * reaches `zone_provenance` when its contributor first runs. So the pass must
 * run INSIDE the fixpoint, and the fixpoint must iterate again once it has, or
 * the closure settles on the members whose facts happened to exist on its
 * first pass: silently wrong membership that `assertHarnessSettled` cannot see,
 * because the post-fixpoint pass derives the missing facts after the fact.
 */

import { mkdir, writeFile } from 'node:fs/promises';

import { compareCodeUnits, safePath } from '@vibe-agent-toolkit/utils';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { ContributorRegistry } from '../src/projection/contributor.js';
import {
  CLAUDE_IMPORT_KIND,
  ClaudeImportExtentContributor,
  claudeImportContributorId,
  claudeImportExtentDeclaration,
} from '../src/projection/contributors/claude-import-extent.js';
import { extentContextId } from '../src/projection/contributors/context-id.js';
import { FilesystemExtentContributor } from '../src/projection/contributors/filesystem-extent.js';
import { ClosureNonConvergenceError, DISCARD_BLOB_POPULATION, populate } from '../src/projection/merge.js';
import type { JsonValue } from '../src/schemas/projection-shared.js';

import { setupSubdirTestSuite } from './test-helpers.js';

const suite = setupSubdirTestSuite('harness-fixpoint-');

/** Not an entry point, so only its declaration makes the harness reach it. */
const START = 'docs/start.md';

/** A three-file chain whose tail is reachable only through its middle's imports. */
const CHAIN: Readonly<Record<string, string>> = {
  [START]: '# acme start\n\n@d1.md\n',
  'docs/d1.md': '# acme d1\n\n@d2.md\n',
  'docs/d2.md': '# acme widgets — the end\n',
};

/** Populate {@link CHAIN} with one claude-import extent declared at {@link START}. */
function populateChain(maxIterations?: number) {
  const registry = new ContributorRegistry();
  registry.register(new FilesystemExtentContributor());
  registry.register(new ClaudeImportExtentContributor(START));
  return populate({
    root: suite.tempDir,
    registry,
    parameters: { [claudeImportContributorId(START)]: claudeImportExtentDeclaration(START) as unknown as JsonValue },
    onBlobPopulation: DISCARD_BLOB_POPULATION,
    ...(maxIterations === undefined ? {} : { maxIterations }),
  });
}

describe('the harness pass inside the closure fixpoint', () => {
  beforeAll(suite.beforeAll);
  afterAll(suite.afterAll);
  beforeEach(suite.beforeEach);
  beforeEach(async () => {
    await mkdir(safePath.join(suite.tempDir, 'docs'), { recursive: true });
    await Promise.all(Object.entries(CHAIN).map(([path, content]) =>
      writeFile(safePath.join(suite.tempDir, path), content, 'utf-8')));
  });

  it('settles a declared closure on every member, once the pass has derived its imports', async () => {
    const projection = await populateChain();

    const rootId = projection.roots[0]?.id ?? '';
    const extentId = extentContextId(CLAUDE_IMPORT_KIND, rootId, START);
    const members = projection.resourceRealizations
      .filter((row) => row.extentId === extentId)
      .map((row) => row.path)
      .sort(compareCodeUnits);
    expect(members).toEqual(Object.keys(CHAIN).sort(compareCodeUnits));
  });

  it('names the harness pass when the fixpoint runs out of iterations while it still derives', async () => {
    const error = await populateChain(1).catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(ClosureNonConvergenceError);
    expect((error as ClosureNonConvergenceError).contributorIds).toContain('harness-pass');
  });
});
