/* eslint-disable security/detect-non-literal-fs-filename -- controlled temp fixture tree */
import { mkdtempSync, writeFileSync } from 'node:fs';

import { GitTracker, mkdirSyncReal, normalizedTmpdir, runGitOrThrow, safePath, toForwardSlash } from '@vibe-agent-toolkit/utils';
import { beforeEach, describe, expect, it } from 'vitest';

import { extentDigest, type ExtentContribution } from '../src/projection/contributor.js';
import { extentContextId } from '../src/projection/contributors/context-id.js';
import { FilesystemExtentContributor } from '../src/projection/contributors/filesystem-extent.js';
import { ProjectionBuilder } from '../src/projection/projection.js';

import { expectContributionRowsValid } from './test-helpers.js';

// Hoisted: sonarjs/no-duplicate-string blocks a literal used 3+ times.
const BUILD_OUTPUT = 'dist/bundle.js';
const BUILD_DIR = 'dist';
const NESTED_FILE = 'docs/guides/setup.md';
const NESTED_DIR = 'docs/guides';
const DECOY = 'node_modules/decoy/index.js';
const DECOY_PREFIX = 'node_modules/';
const IGNORED_LOG = 'ignored.log';
const GITIGNORE = '.gitignore';

let root: string;

/** Every root-relative path the contributor realized, in emission order. */
function pathsOf(contribution: ExtentContribution): string[] {
  return contribution.realizations.map((row) => row.path);
}

/** Run the contributor against a fresh base over the fixture root. */
async function contribute(): Promise<ExtentContribution> {
  const base = new ProjectionBuilder(root).base();
  return new FilesystemExtentContributor().contribute(base, null);
}

/**
 * Run the contributor against a base carrying a real git oracle.
 *
 * `gitignored` is the one column only this extent can fill: the git extent
 * enumerates tracked ∪ (untracked ∧ ¬ignored), so every row it emits is
 * `gitignored: false` by construction and it cannot observe an ignored path
 * even in principle. No commit is needed — `isIgnored` falls back to
 * `git check-ignore`, which reads `.gitignore` directly.
 */
async function contributeInRepo(): Promise<ExtentContribution> {
  runGitOrThrow(['init'], { cwd: root, stdio: 'pipe' });
  const tracker = new GitTracker(root);
  await tracker.initialize();
  const base = new ProjectionBuilder(root, tracker).base();
  return new FilesystemExtentContributor().contribute(base, null);
}

function writeFixtureFile(relativePath: string, contents: string): void {
  const absolute = safePath.join(root, relativePath);
  const lastSlash = absolute.lastIndexOf('/');
  mkdirSyncReal(absolute.slice(0, lastSlash), { recursive: true });
  writeFileSync(absolute, contents);
}

beforeEach(() => {
  root = toForwardSlash(mkdtempSync(safePath.join(normalizedTmpdir(), 'vat-fs-extent-')));
  writeFixtureFile('README.md', '# readme\n');
  writeFixtureFile(NESTED_FILE, '# setup\n');
  // Build output: gitignored in any real repo, and the whole reason this extent
  // exists — Claude reads it, the git extent cannot see it.
  writeFixtureFile(BUILD_OUTPUT, 'export const x = 1;\n');
  writeFixtureFile(IGNORED_LOG, 'noise\n');
  writeFixtureFile(GITIGNORE, `${BUILD_DIR}/\n${IGNORED_LOG}\n`);
  // Decoy: NEVER_CRAWL_GLOBS territory, never user content.
  writeFixtureFile(DECOY, 'module.exports = {};\n');
});

describe('FilesystemExtentContributor gitignored column', () => {
  it('marks build output gitignored while still admitting it to the extent', async () => {
    const contribution = await contributeInRepo();
    const built = contribution.realizations.find((row) => row.path === BUILD_OUTPUT);

    expect(built?.gitignored).toBe(true);
  });

  it('leaves a tracked-able path not gitignored, so the column discriminates', async () => {
    // Without this the previous assertion would pass against a tracker that
    // simply answered `true` for everything.
    const contribution = await contributeInRepo();
    const readme = contribution.realizations.find((row) => row.path === 'README.md');

    expect(readme?.gitignored).toBe(false);
  });

  it('reports gitignored false for every row when no tracker is available', async () => {
    // The no-repo default, pinned so the tracker's contribution stays visible:
    // this is exactly the state the column was stuck in before ProjectionBase
    // exposed the oracle.
    const contribution = await contribute();

    expect(contribution.realizations.every((row) => !row.gitignored)).toBe(true);
  });
});

describe('FilesystemExtentContributor identity', () => {
  it('declares the contributor triple the registry and provenance key on', () => {
    const contributor = new FilesystemExtentContributor();

    expect(contributor.id).toBe('builtin:filesystem');
    expect(contributor.kind).toBe('filesystem');
    expect(contributor.stratum).toBe('base');
  });
});

describe('FilesystemExtentContributor membership', () => {
  it('includes build output the git extent cannot see', async () => {
    // Red if the implementation lets BUILD_OUTPUT_GLOBS (or the crawler's
    // DEFAULT_EXCLUDE) through: `dist/` would simply be absent.
    expect(pathsOf(await contribute())).toContain(BUILD_OUTPUT);
  });

  it('excludes node_modules — NEVER_CRAWL_GLOBS still applies', async () => {
    // Red if the implementation passes no exclude list at all.
    const paths = pathsOf(await contribute());

    expect(paths).not.toContain(DECOY);
    expect(paths.some((path) => toForwardSlash(path).startsWith(DECOY_PREFIX))).toBe(false);
  });

  it('realizes directories as well as files — a directory is a resource', async () => {
    const contribution = await contribute();
    const paths = pathsOf(contribution);

    expect(paths).toContain(NESTED_DIR);
    expect(paths).toContain(BUILD_DIR);
    const nestedDir = contribution.realizations.find((row) => row.path === NESTED_DIR);
    expect(nestedDir?.isDirectory).toBe(true);
  });

  it('kinds a directory row "directory" and a file row "file"', async () => {
    const contribution = await contribute();
    const kindOf = (path: string): string | undefined => {
      const realization = contribution.realizations.find((row) => row.path === path);
      return contribution.resources.find((row) => row.resourceId === realization?.resourceId)?.kind;
    };

    expect(kindOf(NESTED_DIR)).toBe('directory');
    expect(kindOf(NESTED_FILE)).toBe('file');
  });

  it('sees dot-files, which picomatch would otherwise hide', async () => {
    expect(pathsOf(await contribute())).toContain(GITIGNORE);
  });

  it('gives every enumerated identity exactly one membership in this extent', async () => {
    const contribution = await contribute();
    const contextId = contribution.contexts[0]?.contextId;

    expect(contribution.memberships).toHaveLength(contribution.resources.length);
    expect(contribution.memberships.every((row) => row.extentId === contextId)).toBe(true);
    expect(new Set(contribution.memberships.map((row) => row.resourceId)).size)
      .toBe(contribution.memberships.length);
  });

  it('realizes every path against the extent it just declared', async () => {
    const contribution = await contribute();
    const contextId = contribution.contexts[0]?.contextId;

    expect(contribution.realizations.length).toBeGreaterThan(0);
    expect(contribution.realizations.every((row) => row.extentId === contextId)).toBe(true);
  });
});

describe('FilesystemExtentContributor rows', () => {
  it('emits one extent context that is its own base', async () => {
    const contribution = await contribute();
    const context = contribution.contexts[0];

    expect(contribution.contexts).toHaveLength(1);
    expect(context?.species).toBe('extent');
    expect(context?.kind).toBe('filesystem');
    expect(context?.extentContextId).toBeNull();
    expect(context?.role).toBeNull();
  });

  it('scopes the context — column AND id — to the root ids were minted under', async () => {
    // The id, not just the column: `resolution_contexts` is keyed on
    // `contextId` alone, so a federated projection over two roots keeps these
    // extents apart only if the root is inside the id.
    const builder = new ProjectionBuilder(root);
    const contribution = await new FilesystemExtentContributor().contribute(builder.base(), null);

    expect(contribution.contexts[0]?.rootId).toBe(builder.identities.rootId);
    expect(contribution.contexts[0]?.contextId)
      .toBe(extentContextId('filesystem', builder.identities.rootId));
  });

  it('produces rows the shipped schemas accept', async () => {
    expectContributionRowsValid(await contribute());
  });

  it('contributes no tags and no conditions — membership is all it claims', async () => {
    const contribution = await contribute();

    expect(contribution.tags).toEqual([]);
    expect(contribution.conditions).toEqual([]);
  });
});

describe('FilesystemExtentContributor digest', () => {
  it('digests identically across two runs over an unchanged tree', async () => {
    // Crawl order is filesystem-defined, so this is the property that makes
    // §7.4's convergence oracle usable at all.
    expect(extentDigest(await contribute())).toBe(extentDigest(await contribute()));
  });

  it('moves when a file is added to the tree', async () => {
    const before = extentDigest(await contribute());
    writeFixtureFile('added.md', '# added\n');

    expect(extentDigest(await contribute())).not.toBe(before);
  });
});
