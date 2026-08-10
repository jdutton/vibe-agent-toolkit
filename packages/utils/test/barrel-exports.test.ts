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
  'applyDeclaredEnv',
  'assembleClaudeArgs',
  'AuthPreflightError',
  'BUILD_OUTPUT_GLOBS',
  'buildForwardedEnv',
  'buildWindowsShellLine',
  'canCreateSymlinks',
  'classifyFilenameCaseFrom',
  'CommandExecutionError',
  'copyDirectory',
  'crawlDirectory',
  'crawlDirectorySync',
  'defaultRunCommand',
  'describeStdioBlocking',
  'detectInvocationFromTranscript',
  'dynamicImportPath',
  'expandMacro',
  'fileContentHash',
  'fillRealpaths',
  'fillSiblingNames',
  'findConfigFile',
  // 'findGitRoot' — REMOVED. A body-for-body alias of `gitFindRoot`; see
  // `module-subpaths.test.ts` and the CHANGELOG's Removed entry.
  'findNodeWorkspaceRoot',
  'findProjectRoot',
  'formatForwardedEnvLine',
  'FsLookupCache',
  'getRelativePath',
  'getTestOutputBase',
  'getTestOutputDir',
  'getToolVersion',
  'getZodTypeName',
  'gitFindRoot',
  'gitLsFiles',
  'GitTracker',
  'globMagicRemainder',
  'hasParentTraversalSegment',
  'hasShellSyntax',
  'isAbsoluteAnyPlatform',
  'isAbsolutePath',
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
  'parseGitUrl',
  'parseStreamJsonTranscript',
  'parseWholeNumberAtLeast',
  'probeAuthStatus',
  'protectedEnvNames',
  'realpathFrom',
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
