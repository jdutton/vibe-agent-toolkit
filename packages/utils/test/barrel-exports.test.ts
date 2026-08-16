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
 * Type-only exports do not appear here: this is the runtime namespace.
 */
const BARREL_EXPORTS = [
  '__readCrawlTimingSnapshot',
  '__setCrawlTimingForTest',
  '__writeCrawlTimingDumpForTest',
  'applyDeclaredEnv',
  'assembleClaudeArgs',
  'AuthPreflightError',
  'BUILD_OUTPUT_GLOBS',
  'buildForwardedEnv',
  'buildWindowsShellLine',
  'canCreateSymlinks',
  'classifyFilenameCaseFrom',
  'CommandExecutionError',
  'compareCodeUnits',
  'copyDirectory',
  'CRAWL_BLOB_POPULATE_ID',
  'CRAWL_CLOSURE_CONTRIBUTE_ID',
  'CRAWL_CLOSURE_RESOLVE_ID',
  'CRAWL_PASS_INSIDE',
  'CRAWL_REGISTRY_ADD_RESOURCE_ID',
  'CRAWL_REGISTRY_ENUMERATE_ID',
  'CRAWL_REGISTRY_ID_PREFIX',
  'CRAWL_REGISTRY_RESOLVE_LINKS_ID',
  'CRAWL_SEAM_DUMP_VERSION',
  'CRAWL_SHARED_GIT_TRACKER_ID',
  'CRAWL_STRATA',
  'CRAWL_WALKER_GITIGNORE_ID',
  'CRAWL_WALKER_ID',
  'crawlDirectory',
  'crawlDirectorySync',
  'crawlPathFilter',
  'crawlTimingStart',
  'defaultRunCommand',
  'describeStdioBlocking',
  'detectInvocationFromTranscript',
  'dynamicImportPath',
  'ensureTimingDirectory',
  'expandMacro',
  'fileContentHash',
  'fillRealpaths',
  'fillSiblingNames',
  'findConfigFile',
  'findNodeWorkspaceRoot',
  'findProjectRoot',
  'formatForwardedEnvLine',
  'FsLookupCache',
  'getRelativePath',
  'getTestOutputBase',
  'getTestOutputDir',
  'getToolVersion',
  'getZodTypeName',
  'GIT_MODE_GITLINK',
  'GIT_MODE_SYMLINK',
  'gitFindRoot',
  'gitLsFiles',
  'GitTracker',
  'gitTreeSnapshot',
  'globMagicRemainder',
  'hasParentTraversalSegment',
  'hasShellSyntax',
  'isAbsoluteAnyPlatform',
  'isAbsolutePath',
  'isFilesystemAccessError',
  'isGitIgnored',
  'isGitUrl',
  'isGlob',
  'isPathLike',
  'issueLocation',
  'isToolAvailable',
  'isZodNullable',
  'isZodOptional',
  'isZodType',
  'killAllActiveClaudeChildren',
  'loadGitignoreRules',
  'makeStdioBlocking',
  'mkdirSyncReal',
  'NEVER_CRAWL_GLOBS',
  'nonInteractiveGitOverrides',
  'normalizedTmpdir',
  'normalizePath',
  'normalizeTimingDirectory',
  'parseGitUrl',
  'parseStreamJsonTranscript',
  'parseWholeNumberAtLeast',
  'probeAuthStatus',
  'protectedEnvNames',
  'readTimingProcess',
  'realpathFrom',
  'recordContributorInvocation',
  'recordCrawlPass',
  'recordRegistryPass',
  'recordSharedPass',
  'renderTemplate',
  'resetProjectRootCaches',
  'resolveAssetReference',
  'resolveAuth',
  'resolveAuthenticatedUrl',
  'resolveFromImportMeta',
  'resolveShellCommandToken',
  'resolveSkillTarget',
  'safeExecFromString',
  'safeExecResult',
  'safeExecSync',
  'safePath',
  'setupAsyncTempDirSuite',
  'setupSyncTempDirSuite',
  'shouldUseShell',
  'SKILL_SCOPE_NAMES',
  'SKILL_TARGET_NAMES',
  'SKILL_TARGETS',
  'spawnHardened',
  'spawnHeadlessClaude',
  'staticGlobBase',
  'toAbsolutePath',
  'toForwardSlash',
  'toNfc',
  'UnknownMacroError',
  'unwrapZodType',
  'updateYamlIn',
  'verifyConfinedYamlEdit',
  'windowsShellQuote',
  'withContributorStratum',
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
