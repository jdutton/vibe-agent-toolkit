/* eslint-disable security/detect-non-literal-fs-filename -- controlled temp fixture tree */
/**
 * RESOURCE_UNREADABLE issue shape.
 *
 * `ValidationIssue`'s contract (see `packages/schema/src/validation-issue.ts`)
 * says every issue's `location` must be a project-relative path so it never leaks
 * the developer's home directory into CI logs, and so `validation.allow` globs
 * (which match against `location`) can address it. `collectUnreadableResourceErrors`
 * computes the sanitized relative path (`issueLocation`) but historically only used
 * it inside the message string -- never as the `location` extra -- and interpolated
 * the raw filesystem error message, which embeds the absolute path, straight into
 * the issue text. Both are asserted against here, using a nonexistent file (ENOENT
 * is a `READ_FAILURE_CODES` member and reproduces cross-platform, unlike EACCES via
 * chmod which is POSIX-only).
 */
import { chmodSync, writeFileSync } from 'node:fs';

import {
  mkdirSyncReal,
  safePath,
  setupAsyncTempDirSuite,
  toForwardSlash,
  withReaddirSyncRefused,
} from '@vibe-agent-toolkit/utils';
import { type DirectoryRefusal, DirectoryListingRefusedError } from '@vibe-agent-toolkit/utils/crawl';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { type RegistryUnreadablePolicy, ResourceRegistry } from '../src/resource-registry.js';
import type { ValidationIssue } from '../src/schemas/validation-result.js';

const MISSING_FILE_NAME = 'missing.md';
const OPEN_FILE = 'docs/open/ok.md';
const LOCKED_TARGET = 'docs/sub/target.md';

/** `chmod 000` denies nothing to uid 0 and binds nothing on Windows. */
const CANNOT_DENY_READS =
  process.platform === 'win32' || (typeof process.getuid === 'function' && process.getuid() === 0);

/** Register a nonexistent file under `tempDir` and return its RESOURCE_UNREADABLE issue. */
async function unreadableIssue(tempDir: string): Promise<ValidationIssue | undefined> {
  const missingPath = safePath.join(tempDir, MISSING_FILE_NAME);
  const registry = new ResourceRegistry({ baseDir: tempDir });
  await registry.addResources([missingPath]);
  const result = await registry.validate({ skipGitIgnoreCheck: true });
  return result.issues.find((i) => i.code === 'RESOURCE_UNREADABLE');
}

describe('ResourceRegistry RESOURCE_UNREADABLE issues', () => {
  const suite = setupAsyncTempDirSuite('resource-registry-unreadable');
  let tempDir: string;

  beforeAll(suite.beforeAll);
  afterAll(suite.afterAll);

  beforeEach(async () => {
    await suite.beforeEach();
    tempDir = suite.getTempDir();
  });

  it('reports a project-relative location for a file that could not be read', async () => {
    const issue = await unreadableIssue(tempDir);
    expect(issue).toBeDefined();
    expect(issue?.location).toBe(MISSING_FILE_NAME);
  });

  it('never leaks the absolute filesystem path into the message', async () => {
    const issue = await unreadableIssue(tempDir);
    expect(issue).toBeDefined();
    expect(issue?.message).not.toContain(tempDir);
    expect(issue?.message).not.toContain(safePath.join(tempDir, MISSING_FILE_NAME));
  });
});

/**
 * Crawl `tempDir` with `locked` refusing to list under `policy`, and return what
 * the crawl threw (or `undefined`).
 *
 * `policy` may be `undefined` on purpose: that arm is the untyped caller (a test
 * file, a JS adopter) the required field cannot reach, cast past the type.
 */
async function crawlRefusal(
  tempDir: string,
  locked: string,
  code: string,
  policy: RegistryUnreadablePolicy | undefined,
): Promise<{ registry: ResourceRegistry; thrown: unknown }> {
  const registry = new ResourceRegistry({ baseDir: tempDir });
  const thrown = await withReaddirSyncRefused(locked, code, async () => {
    try {
      await registry.crawl({ unreadable: policy as RegistryUnreadablePolicy, baseDir: tempDir, include: ['**/*.md'] });
      return undefined;
    } catch (error) {
      return error;
    }
  });
  return { registry, thrown };
}

/**
 * A `docs/` tree with one open file and one directory the tests then refuse to
 * list — registered on the enclosing `describe`'s hooks. Shared by the refuse
 * suite and the policy suite below, so the fixture cannot drift between them.
 *
 * @param name - The temp-dir suite name
 * @returns Getters for the tree root and the directory to refuse
 */
function useLockedDocsTree(name: string): { tempDir: () => string; locked: () => string } {
  const suite = setupAsyncTempDirSuite(name);
  let tempDir = '';
  let locked = '';
  beforeAll(suite.beforeAll);
  afterAll(suite.afterAll);
  beforeEach(async () => {
    await suite.beforeEach();
    tempDir = suite.getTempDir();
    locked = safePath.join(tempDir, 'docs', 'locked');
    mkdirSyncReal(safePath.join(tempDir, 'docs', 'open'), { recursive: true });
    mkdirSyncReal(locked, { recursive: true });
    writeFileSync(safePath.join(tempDir, OPEN_FILE), '# ok\n');
    writeFileSync(safePath.join(locked, 't.md'), '# t\n');
  });
  return { tempDir: () => tempDir, locked: () => locked };
}

/**
 * The crawl that defines the population REFUSES a directory it could not
 * enter — the same answer the projection lane gives, by the same class and
 * the same sentence, so `VAT_RESOURCES_CRAWL=walk` cannot exit 0 or 1 over a
 * tree the default lane exits 2 on.
 *
 * 🪤 Two earlier shapes were both wrong. `crawlDirectory` used to swallow the
 * refusal and hand back a shorter list, so `docs/locked/t.md` — in the
 * declared population, never opened — was in no count and no finding. Then
 * this lane recorded it as a `SCAN_PATH_UNREADABLE` WARNING and validated the
 * rest, while the projection lane aborted the identical tree at exit 2: two
 * lanes documented as cost models rather than behaviours reached opposite exit
 * codes, and the warning prescribed `resources.exclude` — a knob the default
 * lane does not read. The standing ruling: a locked non-ignored directory
 * refuses by name on both lanes with one sentence.
 *
 * This temp tree has no `.git` above it, so the remedy is the no-repository
 * one: there is no ignore rule to send the adopter to.
 */
describe("ResourceRegistry refuses the crawl for a directory it could not list under 'refuse'", () => {
  const tree = useLockedDocsTree('resource-registry-unlistable');

  it('throws DirectoryListingRefusedError naming the directory project-relative with its errno, and admits nothing', async () => {
    const { registry, thrown } = await crawlRefusal(tree.tempDir(), tree.locked(), 'EACCES', 'refuse');

    expect(thrown).toBeInstanceOf(DirectoryListingRefusedError);
    const message = (thrown as Error).message;
    expect(message).toContain("the directory 'docs/locked'");
    expect(message).toContain('EACCES');
    expect(message).not.toContain(tree.tempDir());
    // Not a warning that prescribes a knob the default lane ignores.
    expect(message).not.toMatch(/add it to resources\.exclude/);
    // No repository above this tree: the remedy must not send the adopter to
    // an ignore file that nothing here reads.
    expect(message).toMatch(/no git repository/i);
    expect(message).not.toMatch(/gitignore it/);
    expect((thrown as DirectoryListingRefusedError).refusal.directory).toBe(toForwardSlash(tree.locked()));
    expect(registry.getAllResources()).toEqual([]);
  });

  it('tells the reader to re-run first when the refusal was transient', async () => {
    const { thrown } = await crawlRefusal(tree.tempDir(), tree.locked(), 'EMFILE', 'refuse');
    expect(thrown).toBeInstanceOf(DirectoryListingRefusedError);
    expect((thrown as Error).message).toContain('EMFILE');
    expect((thrown as Error).message).toMatch(/re-run/i);
  });

  it('crawls the whole tree when nothing refuses (control)', async () => {
    const tempDir = tree.tempDir();
    const registry = new ResourceRegistry({ baseDir: tempDir });
    await registry.crawl({ unreadable: 'refuse', baseDir: tempDir, include: ['**/*.md'] });
    const admitted = registry.getAllResources().map((r) => toForwardSlash(safePath.relative(tempDir, r.filePath)));
    expect(admitted.toSorted((a, b) => a.localeCompare(b))).toEqual(['docs/locked/t.md', OPEN_FILE]);
  });
});

/**
 * The refusal above is ONE of two rulings, and which one applies is the
 * CALLER's knowledge: the registry takes its `unreadable` policy as a required
 * field with no default, because the two standing rulings are per-verb and
 * both stand — `vat resources validate`/`scan`/`check`, `vat skills
 * validate`/`build`, `vat build`, `vat claude context` refuse (above), and
 * `vat audit` degrades: status describes what was found, exit describes
 * whether the run completed, so the refusal is handed over and filed as
 * `SCAN_PATH_UNREADABLE` while every readable sibling is validated.
 *
 * 🪤 With the policy fixed inside the registry, whichever ruling it encoded
 * was wrong for the other verb: `vat audit` on a tree with one `chmod 000`
 * sibling exited 2 with zero findings (issue #180's exact shape) the moment
 * the crawl was switched to refuse for the build verbs.
 */
describe('ResourceRegistry.crawl takes its unreadable policy from the caller', () => {
  const tree = useLockedDocsTree('resource-registry-unreadable-policy');

  it('{ degrade } hands the refusal to the caller and admits every readable sibling', async () => {
    const handed: DirectoryRefusal[] = [];
    const { registry, thrown } = await crawlRefusal(tree.tempDir(), tree.locked(), 'EACCES', { degrade: (refusal) => { handed.push(refusal); } });

    expect(thrown).toBeUndefined();
    expect(handed.map((r) => ({ directory: r.directory, code: r.code }))).toEqual([
      { directory: toForwardSlash(tree.locked()), code: 'EACCES' },
    ]);
    const admitted = registry.getAllResources().map((r) => toForwardSlash(safePath.relative(tree.tempDir(), r.filePath)));
    expect(admitted).toEqual([OPEN_FILE]);
  });

  it('an omitted policy is refused by name before any directory is listed', async () => {
    const { registry, thrown } = await crawlRefusal(tree.tempDir(), tree.locked(), 'EACCES', undefined);

    expect(thrown).toBeInstanceOf(TypeError);
    expect((thrown as Error).message).toContain('ResourceRegistry.crawl');
    expect((thrown as Error).message).toContain('`unreadable` is required');
    expect(registry.getAllResources()).toEqual([]);
  });

  it('a population source decides its own refusals, so { degrade } beside one is refused by name', async () => {
    const tempDir = tree.tempDir();
    const registry = new ResourceRegistry({ baseDir: tempDir });
    await expect(
      registry.crawl({
        baseDir: tempDir,
        include: ['**/*.md'],
        unreadable: { degrade: () => {} },
        populationSource: { root: tempDir, enumerate: async () => ({ paths: [], conditions: [] }) },
      }),
    ).rejects.toThrow(/populationSource.*degrade|degrade.*populationSource/);
  });
});

/**
 * A link WITH an anchor into a file the registry enumerated but could not read
 * is a gap, not a clean result — the judge has the finding
 * (`LINK_TARGET_UNREADABLE`, pinned in `link-validator-unreadable-target.test.ts`)
 * but only if the registry hands it the `unreadableResources` log. Without that
 * wiring the anchor is silently `skip`ped and the run says nothing about the
 * link, while `RESOURCE_UNREADABLE` says only that a FILE was skipped.
 *
 * A real `chmod 000`, because the target must EXIST (a missing one is
 * `LINK_BROKEN_FILE`, a different and already-covered answer) — so POSIX-only
 * and not as root, like every other chmod-backed suite here.
 */
describe.skipIf(CANNOT_DENY_READS)('ResourceRegistry LINK_TARGET_UNREADABLE for an anchor into a file it could not read', () => {
  const suite = setupAsyncTempDirSuite('resource-registry-unreadable-target');
  let tempDir: string;
  let target: string;

  beforeAll(suite.beforeAll);
  afterAll(suite.afterAll);

  beforeEach(async () => {
    await suite.beforeEach();
    tempDir = suite.getTempDir();
    target = safePath.join(tempDir, LOCKED_TARGET);
    mkdirSyncReal(safePath.join(tempDir, 'docs', 'sub'), { recursive: true });
    writeFileSync(target, '# target\n\n## real\n');
    writeFileSync(
      safePath.join(tempDir, 'docs', 'a.md'),
      '# a\n[x](./sub/target.md#nope)\n[y](./sub/target.md#real)\n[z](./sub/target.md)\n',
    );
  });

  async function validateWithTargetLocked(): Promise<ValidationIssue[]> {
    chmodSync(target, 0o000);
    try {
      const registry = new ResourceRegistry({ baseDir: tempDir });
      await registry.crawl({ unreadable: 'refuse', baseDir: tempDir, include: ['**/*.md'] });
      return (await registry.validate({ skipGitIgnoreCheck: true })).issues;
    } finally {
      chmodSync(target, 0o644);
    }
  }

  it('reports every anchored link into the locked file, once per link, with the errno', async () => {
    const issues = await validateWithTargetLocked();

    expect(issues.filter((i) => i.code === 'RESOURCE_UNREADABLE')).toHaveLength(1);
    const unverified = issues.filter((i) => i.code === 'LINK_TARGET_UNREADABLE');
    // x (#nope) and y (#real) both carry it: neither anchor could be looked up.
    // z has no anchor, so its verdict is complete without reading the file.
    expect(unverified.map((i) => i.line).sort((a, b) => (a ?? 0) - (b ?? 0))).toEqual([2, 3]);
    for (const issue of unverified) {
      expect(issue.location).toBe('docs/a.md');
      expect(issue.message).toContain('EACCES');
      expect(issue.message).not.toContain(tempDir);
    }
    // Not misreported as a broken anchor: nothing was checked, so nothing is broken.
    expect(issues.filter((i) => i.code === 'LINK_BROKEN_ANCHOR')).toEqual([]);
  });

  it('reports LINK_BROKEN_ANCHOR for #nope and nothing for #real once the file is readable (control)', async () => {
    const registry = new ResourceRegistry({ baseDir: tempDir });
    await registry.crawl({ unreadable: 'refuse', baseDir: tempDir, include: ['**/*.md'] });
    const { issues } = await registry.validate({ skipGitIgnoreCheck: true });

    expect(issues.filter((i) => i.code === 'LINK_TARGET_UNREADABLE')).toEqual([]);
    expect(issues.filter((i) => i.code === 'LINK_BROKEN_ANCHOR').map((i) => i.line)).toEqual([2]);
  });
});
