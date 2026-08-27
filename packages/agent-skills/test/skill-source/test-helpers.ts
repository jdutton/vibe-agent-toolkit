/* eslint-disable security/detect-non-literal-fs-filename -- tmpdir paths constructed in test setup */
/**
 * Shared test helpers for skill-source unit tests.
 *
 * Two clusters of duplicated infrastructure are eliminated here:
 *
 * **Cluster A — git helpers**
 * `runGit()` is a thin wrapper around `runGitOrThrow()` with a
 * descriptive error message; `makeBareRepoWithSkill()` creates a
 * self-contained bare repo + working-tree fixture with a SKILL.md so that
 * tests can exercise git-based skill sources without hitting real remotes.
 *
 * **Cluster B — skill-source context setup**
 * `setupSkillSourceTestSuite()` provisions a temp root directory and a
 * `ResolveSkillSourceContext` before each test, and tears down after.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import {
  mkdirSyncReal,
  normalizedTmpdir,
  safePath,
} from '@vibe-agent-toolkit/utils';
import {
  runGitOrThrow,
} from '@vibe-agent-toolkit/utils/git';
import { afterEach, beforeEach } from 'vitest';

import type { ResolveSkillSourceContext } from '../../src/skill-source/types.js';

// ---------------------------------------------------------------------------
// Cluster A — git helpers
// ---------------------------------------------------------------------------

/** Default SKILL.md content written into git fixture repos. */
const FIXTURE_SKILL_MD =
  `---\nname: test-skill\ndescription: A test skill\ntriggers: []\n---\nContent\n`;

/**
 * Run an arbitrary git command in `cwd`.
 * Throws a descriptive error when the command exits non-zero so test failures
 * are readable without manual log-diving.
 *
 * @param args - Arguments forwarded to git (e.g. `['init', '--bare']`)
 * @param cwd  - Working directory for the git invocation
 */
export function runGit(args: string[], cwd: string): void {
  runGitOrThrow(args, { cwd });
}

/**
 * Options for `makeBareRepoWithSkill`.
 */
export interface BareRepoOptions {
  /** Content for the SKILL.md committed to the repo (defaults to a minimal valid skill). */
  skillContent?: string;
  /** Subdirectory within the work-tree to place SKILL.md (defaults to repo root). */
  skillSubdir?: string;
}

/**
 * Create a bare git repository that contains a committed SKILL.md.
 *
 * Returns the `file://` URL of the bare repo and a cleanup function.  The
 * caller is responsible for calling `cleanup()` in `afterAll` / `afterEach`.
 *
 * @param options - Optional overrides for skill content and placement
 * @returns `{ bareUrl, cleanup }`
 */
export function makeBareRepoWithSkill(options: BareRepoOptions = {}): {
  bareUrl: string;
  cleanup: () => void;
} {
  const {
    skillContent = FIXTURE_SKILL_MD,
    skillSubdir,
  } = options;

  const bareDir = mkdtempSync(safePath.join(normalizedTmpdir(), 'vat-ss-bare-'));
  const workDir = mkdtempSync(safePath.join(normalizedTmpdir(), 'vat-ss-work-'));

  runGit(['init', '--bare', '--initial-branch=main'], bareDir);
  runGit(['init', '--initial-branch=main'], workDir);
  runGit(['config', 'user.email', 'test@example.com'], workDir);
  runGit(['config', 'user.name', 'Test'], workDir);
  runGit(['remote', 'add', 'origin', bareDir], workDir);

  const skillTargetDir = skillSubdir
    ? safePath.join(workDir, skillSubdir)
    : workDir;

  if (skillSubdir) {
    mkdirSyncReal(skillTargetDir, { recursive: true });
  }

  writeFileSync(safePath.join(skillTargetDir, 'SKILL.md'), skillContent);
  runGit(['add', '-A'], workDir);
  runGit(['commit', '-m', 'init'], workDir);
  runGit(['push', 'origin', 'main'], workDir);

  const bareUrl = pathToFileURL(bareDir).href;

  return {
    bareUrl,
    cleanup: () => {
      rmSync(bareDir, { recursive: true, force: true });
      rmSync(workDir, { recursive: true, force: true });
    },
  };
}

// ---------------------------------------------------------------------------
// Cluster B — skill-source context setup
// ---------------------------------------------------------------------------

/**
 * Suite state returned by `setupSkillSourceTestSuite`.
 * Access `.root` and `.ctx` only inside test bodies (they are empty strings /
 * objects before `beforeEach` fires).
 */
export interface SkillSourceSuite {
  /** Temp root dir, populated by beforeEach */
  root: string;
  /** Ready-to-use ResolveSkillSourceContext, populated by beforeEach */
  ctx: ResolveSkillSourceContext;
  /** beforeEach hook — wire with `beforeEach(suite.beforeEach)` */
  beforeEach: () => void;
  /** afterEach hook — wire with `afterEach(suite.afterEach)` */
  afterEach: () => void;
}

/**
 * Set up a standard skill-source test suite with a fresh temp root directory
 * and a `ResolveSkillSourceContext` pointing at `<root>/staging` and
 * `<root>/cache`.  A minimal `package.json` (`{ name: 'host' }`) is written to
 * root so that resolvers that walk up to find a host package succeed.
 *
 * @param prefix - `mkdtempSync` prefix (e.g. `'vat-path-'`)
 * @returns Suite object whose `root` and `ctx` fields are populated during beforeEach
 *
 * @example
 * ```typescript
 * const suite = setupSkillSourceTestSuite('vat-path-');
 *
 * describe('resolvePathSource', () => {
 *   beforeEach(suite.beforeEach);
 *   afterEach(suite.afterEach);
 *
 *   it('stages the skill', async () => {
 *     const result = await resolvePathSource('./plugin', suite.ctx);
 *     expect(result.identity).toMatch(/^path:/);
 *   });
 * });
 * ```
 */
export function setupSkillSourceTestSuite(prefix: string): SkillSourceSuite {
  const suite: SkillSourceSuite = {
    root: '',
    ctx: {} as ResolveSkillSourceContext,
    beforeEach: () => {
      suite.root = mkdtempSync(safePath.join(normalizedTmpdir(), prefix));
      writeFileSync(
        safePath.join(suite.root, 'package.json'),
        JSON.stringify({ name: 'host' }),
      );
      suite.ctx = {
        repoRoot: suite.root,
        stagingRoot: safePath.join(suite.root, 'staging'),
        fetchCacheDir: safePath.join(suite.root, 'cache'),
      };
    },
    afterEach: () => {
      rmSync(suite.root, { recursive: true, force: true });
    },
  };

  return suite;
}

/**
 * Wire a `SkillSourceSuite` into the surrounding describe block.
 *
 * Convenience wrapper for the common pattern:
 * ```typescript
 * const suite = setupSkillSourceTestSuite('prefix-');
 * beforeEach(suite.beforeEach);
 * afterEach(suite.afterEach);
 * ```
 *
 * @param prefix - mkdtempSync prefix
 * @returns Wired suite (same object as `setupSkillSourceTestSuite`)
 */
export function useSkillSourceSuite(prefix: string): SkillSourceSuite {
  const suite = setupSkillSourceTestSuite(prefix);
  beforeEach(suite.beforeEach);
  afterEach(suite.afterEach);
  return suite;
}
