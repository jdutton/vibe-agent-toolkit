/**
 * The publish-tree lane's one seam: `publishToGitBranch` spawns git (init, commit, push), a child
 * process no in-process fault reaches, so it is replaced. Every fs call the case makes is then the
 * composer's (`composePublishTree`), and none is the mock's.
 *
 * The stand-in does the one thing the real lane does with the tree that matters to the matrix: it
 * TAKES it. The composed tree lives under $TMPDIR and is disposed of before the after-snapshot, so
 * a case with no unit compared nothing the verb produced — an injected fault that made the composer
 * omit a file while the verb exited 0 passed every invariant. The mock copies the tree it is handed
 * to {@link PUBLISHED_TREE_CAPTURE} in the project, which the case declares as its unit: "what was
 * published" is now held to golden like any other output.
 *
 * Imported FIRST by each publish-tree matrix file, before anything that loads the publish command:
 * the mock is registered as this module evaluates, ahead of the command importing `git-publish.js`.
 */
import { cpSync } from 'node:fs';

import { safePath } from '@vibe-agent-toolkit/utils';
import { untracedFs } from '@vibe-agent-toolkit/utils/testing';
import { vi } from 'vitest';

import type * as GitPublish from '../../../src/commands/claude/marketplace/git-publish.js';

import { PUBLISHED_TREE_CAPTURE } from './tree-files.js';

vi.mock('../../../src/commands/claude/marketplace/git-publish.js', async (importOriginal) => ({
  ...(await importOriginal<typeof GitPublish>()),
  publishToGitBranch: vi.fn((options: Parameters<typeof GitPublish.publishToGitBranch>[0]): Promise<unknown> => {
    // Untraced: the capture is the harness's own bookkeeping, never an injection point of the verb.
    untracedFs(() => cpSync(options.publishDir, safePath.join(process.cwd(), PUBLISHED_TREE_CAPTURE), { recursive: true }));
    return Promise.resolve(undefined);
  }),
}));
