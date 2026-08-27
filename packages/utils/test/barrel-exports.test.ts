import { describe, expect, it } from 'vitest';

/**
 * The `.` barrel's runtime export set, sorted.
 *
 * **How to react when this test fails.**
 *
 * - A **removal** (a name in this list that the barrel no longer exports) is a
 *   BREAKING CHANGE. There are ~500 in-repo importers plus published adopters
 *   reaching for these names. Do not "fix" the test by deleting the line: either
 *   restore the export, or — if the removal is intended under the pre-1.0 policy —
 *   delete the line AND add a `### Removed` / breaking-change entry to
 *   `CHANGELOG.md` naming every symbol dropped and where it moved to.
 * - An **addition** is fine to accept. Add the name in sorted position; no
 *   changelog obligation beyond the usual "Added" note for a new public helper.
 *
 * This guard exists because the subpath work moved seven pure path helpers off
 * `./fs` and nothing noticed: no test enumerated any entry's export set, so a
 * published subpath silently lost half its surface. Enumerating the barrel — the
 * entry with the most consumers — makes that class of change impossible to ship
 * unremarked.
 *
 * **An addition here is not automatically fine.** This list and
 * `subpath-purity.test.ts`'s `index.ts` row are two halves of one rule: a module
 * that brings a third-party dependency — directly, or transitively through
 * anything it imports — belongs on a subpath. Adding such a name to the barrel
 * reddens the purity row, and the fix is a subpath entry, not a longer list
 * here. Names whose modules reach only `node:*` are the ones this list is for.
 *
 * Type-only exports do not appear here: this is the runtime namespace.
 */
const BARREL_EXPORTS = [
  '__readCrawlTimingSnapshot',
  '__setCrawlTimingForTest',
  '__writeCrawlTimingDumpForTest',
  'classifyFilenameCaseFrom',
  'compareCodeUnits',
  'copyDirectory',
  'CRAWL_BLOB_POPULATE_ID',
  'CRAWL_CLOSURE_CONTRIBUTE_ID',
  'CRAWL_CLOSURE_RESOLVE_ID',
  'CRAWL_PASS_INSIDE',
  'CRAWL_REGISTRY_ADMIT_ID',
  'CRAWL_REGISTRY_ENUMERATE_ID',
  'CRAWL_REGISTRY_ID_PREFIX',
  'CRAWL_REGISTRY_RESOLVE_LINKS_ID',
  'CRAWL_SHARED_GIT_TRACKER_ID',
  'CRAWL_STORE_READ_ID',
  'CRAWL_STORE_WRITE_ID',
  'CRAWL_STRATA',
  'CRAWL_WALKER_GITIGNORE_ID',
  'CRAWL_WALKER_ID',
  'crawlTimingStart',
  'createSymlink',
  'createSymlinkAsync',
  'decodeTextContent',
  'detachGitEnv',
  'dynamicImportPath',
  'ensureTimingDirectory',
  'fileContentHash',
  'fillRealpaths',
  'fillSiblingNames',
  'findConfigFile',
  'findNodeWorkspaceRoot',
  'findProjectRoot',
  'FsLookupCache',
  'getRelativePath',
  'getTestOutputBase',
  'getTestOutputDir',
  'getZodTypeName',
  'globMagicRemainder',
  'hasParentTraversalSegment',
  'INHERITED_GIT_ENV',
  'isAbsoluteAnyPlatform',
  'isAbsolutePath',
  'isFilesystemAccessError',
  'isGlob',
  'issueLocation',
  'isZodNullable',
  'isZodOptional',
  'isZodType',
  'mkdirSyncReal',
  'normalizedTmpdir',
  'normalizePath',
  'normalizeTimingDirectory',
  'parseWholeNumberAtLeast',
  'readTextContent',
  'readTextContentSync',
  'readTimingProcess',
  'realpathFrom',
  'recordContributorInvocation',
  'recordCrawlPass',
  'recordRegistryPass',
  'recordSharedPass',
  'removeScratchDir',
  'resetProjectRootCaches',
  'resolveAssetReference',
  'resolveFromImportMeta',
  'resolveSkillTarget',
  'safePath',
  'setupAsyncTempDirSuite',
  'setupSyncTempDirSuite',
  'SKILL_SCOPE_NAMES',
  'SKILL_TARGET_NAMES',
  'SKILL_TARGETS',
  'staticGlobBase',
  'symlinkCapability',
  'toAbsolutePath',
  'toForwardSlash',
  'toNfc',
  'unwrapZodType',
  'withContributorStratum',
  'withOuterBracket',
  'writeTimingDump',
  'ZodTypeNames',
];

describe('the `.` barrel export surface', () => {
  it('exports exactly the recorded set — a removal is a breaking change', async () => {
    const barrel: Record<string, unknown> = await import('../src/index.js');
    const actual = Object.keys(barrel).sort((a, b) => a.localeCompare(b));

    expect(actual).toEqual(BARREL_EXPORTS);
  });

  // Named separately so a removal reports as "missing X" rather than as a diff of
  // two 85-element arrays, which is the failure mode people skim past.
  it('has dropped no previously exported name', async () => {
    const barrel: Record<string, unknown> = await import('../src/index.js');
    const actual = new Set(Object.keys(barrel));
    const removed = BARREL_EXPORTS.filter((name) => !actual.has(name));

    expect(removed).toEqual([]);
  });
});
