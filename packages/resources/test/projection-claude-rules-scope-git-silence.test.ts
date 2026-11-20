/**
 * The rules scope asks git's collapsed ignored listing when a rule's glob has
 * no witness and no probe is ignored. A listing git did not answer is refused,
 * coded by cause: read as empty, it would call every glob over ignored
 * territory `inert`, the answer for a tree with no repository. The listing is
 * the seam, mocked so the silence needs no broken repository.
 */
import type * as GitModule from '@vibe-agent-toolkit/utils/git';
import { describe, expect, it, vi } from 'vitest';

import { addFileWithFacts } from './helpers/claude-context-fixture.js';

const gitLsOthers = vi.fn<() => string[] | null>();

vi.mock('@vibe-agent-toolkit/utils/git', async (importOriginal) => ({
  ...(await importOriginal<typeof GitModule>()),
  gitLsOthers: () => gitLsOthers(),
}));

const { RunContentCache } = await import('../src/projection/content-cache.js');
const { ClaudeRulesScopeContributor } = await import('../src/projection/contributors/claude-rules-scope.js');
const { ProjectionBuilder } = await import('../src/projection/projection.js');

const ROOT = '/vat-corpus/rules-scope-git-silence';

/** A usable tracker that ignores no probe, so the scope must ask the listing. */
const TRACKER = { isUsable: () => true, isIgnoredByActiveSet: () => false } as unknown as GitModule.GitTracker;

/** Contribute over one rule scoped to `build/**`, a glob with no witness in the tree. */
function contribute(): Promise<unknown> {
  const builder = new ProjectionBuilder({ root: ROOT, contentCache: new RunContentCache() });
  addFileWithFacts(builder, { path: '.claude/rules/build.md', refs: [], markdown: '---\npaths:\n  - "build/**"\n---\n\n# Build\n', deferred: false }, ROOT);
  // The tracker joins after the files: the scope is the one asker under test.
  return new ClaudeRulesScopeContributor().contribute({ ...builder.base(), gitTracker: TRACKER }, null);
}

describe('the rules scope over an ignored listing git did not answer', () => {
  it('reads an answered listing (positive control)', async () => {
    gitLsOthers.mockReturnValue(['build/']);
    await expect(contribute()).resolves.toBeDefined();
    expect(gitLsOthers).toHaveBeenCalled();
  });

  it('refuses, coded by cause, rather than calling the glob inert', async () => {
    gitLsOthers.mockReturnValue(null);
    // Through a promise, so a refusal thrown before the contributor's first await counts too.
    await expect(Promise.resolve().then(contribute)).rejects.toMatchObject({ code: 'GIT_NO_ANSWER' });
  });
});
