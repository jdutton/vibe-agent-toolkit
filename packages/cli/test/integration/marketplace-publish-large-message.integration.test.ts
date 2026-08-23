/**
 * Regression test: a marketplace publish commit message larger than Linux's
 * per-argument cap must still commit.
 *
 * The publish commit message embeds the release's whole `[Unreleased]` CHANGELOG
 * section. When that section grew past 131,072 bytes (`MAX_ARG_STRLEN` — a
 * *per-argv-entry* limit, separate from and far smaller than `ARG_MAX`), passing
 * it as `git commit -m <message>` made the kernel refuse the exec with `E2BIG`.
 * The process never ran, so `spawnSync` returned `status: null` with the cause in
 * `result.error` — which the git helper discarded, reporting a confident and
 * entirely fictional "exit 1" with empty stderr.
 *
 * This bit a real release: npm publish had already succeeded, so the tag was
 * permanent while the marketplace branch silently stayed a version behind.
 *
 * macOS has no per-argument cap, so this test's *failure* mode is Linux-only —
 * it is kept as a full round-trip (commit + push to a real local bare remote,
 * then read the message back) so it verifies the message survives intact on
 * every platform rather than merely that the call did not throw.
 */
import { runGitOrThrow, safePath } from '@vibe-agent-toolkit/utils';
import { afterEach, describe, expect, it } from 'vitest';

import { publishToGitBranch } from '../../src/commands/claude/marketplace/git-publish.js';
import { createTempDirTracker, fs } from '../system/test-common.js';

const { createTempDir, cleanupTempDirs } = createTempDirTracker('vat-mp-big-msg-');

/** Linux `MAX_ARG_STRLEN` — 32 × 4 KB pages. */
const MAX_ARG_STRLEN = 131_072;

const silentLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

describe('marketplace publish with an oversized commit message', () => {
  afterEach(() => {
    cleanupTempDirs();
  });

  it('commits and pushes a message larger than MAX_ARG_STRLEN', async () => {
    const root = createTempDir();
    const bareRemote = safePath.join(root, 'remote.git');
    const publishDir = safePath.join(root, 'publish');

    fs.mkdirSync(bareRemote, { recursive: true });
    fs.mkdirSync(publishDir, { recursive: true });
    runGitOrThrow(['init', '--bare', '--initial-branch=main', bareRemote], { cwd: root });

    fs.writeFileSync(
      safePath.join(publishDir, 'marketplace.json'),
      JSON.stringify({ name: 'test-marketplace', plugins: [] }, null, 2),
    );

    // Comfortably over the cap, and NOT a single repeated character — a realistic
    // changelog is many distinct lines, and we assert the whole thing round-trips.
    // No trailing whitespace on any line: git's default `whitespace` cleanup strips
    // it, which would make the round-trip assertion fail for a reason unrelated to
    // the size limit under test.
    const body = Array.from(
      { length: 1200 },
      (_, i) =>
        `- entry ${i}: ${'a release note that describes one adopter-visible change.'.repeat(2)}`,
    ).join('\n');
    const commitMessage = `publish v9.9.9\n\n${body}`;

    expect(Buffer.byteLength(commitMessage, 'utf8')).toBeGreaterThan(MAX_ARG_STRLEN);

    await publishToGitBranch({
      publishDir,
      branch: 'claude-marketplace',
      remote: bareRemote,
      commitMessage,
      force: false,
      dryRun: false,
      noPush: false,
      logger: silentLogger,
    });

    const landed = String(
      runGitOrThrow(['log', '-1', '--format=%B', 'claude-marketplace'], {
        cwd: bareRemote,
      }),
    );

    // Round-trip, not just "did not throw": git strips trailing whitespace from the
    // message, so compare against the same normalization rather than loosening this
    // to a substring check, which would pass on a truncated message.
    expect(landed.trimEnd()).toBe(commitMessage.trimEnd());
  });
});
