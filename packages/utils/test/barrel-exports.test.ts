/**
 * The `.` barrel's runtime export set — a ratchet, both ways. How to react when
 * this fails is written on `findBarrelDrift` in
 * `packages/dev-tools/src/pin-barrel-exports.ts`; in one line: a removal is a
 * breaking change (restore it, or record it in CHANGELOG.md), an addition is
 * deliberate and needs a consumer outside this package before it is added here.
 */

import { describe, expect, it } from 'vitest';

import { findBarrelDrift } from '../../dev-tools/src/pin-barrel-exports.js';

// This list and `subpath-purity.test.ts`'s `index.ts` row are two halves of one
// rule: a module that brings a third-party dependency — directly, or
// transitively through anything it imports — belongs on a subpath. Adding such
// a name here reddens the purity row, and the fix is a subpath entry, not a
// longer list. Names whose modules reach only `node:*` are the ones this list
// is for. Test scaffolding (the temp-dir suite family, the fs-refusal fakes,
// the crawl-timing `__*ForTest` seams) is on `./testing`, never here.
const BARREL_EXPORTS = [
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
  'CopyLinkEscapesSourceError',
  'DirectorySpellingIndex',
  'DirectoryWalkRevisitedError',
  'FollowedWalk',
  'FsLookupCache',
  'INHERITED_GIT_ENV',
  'PathEscapesRootError',
  'SKILL_SCOPE_NAMES',
  'SKILL_TARGETS',
  'SKILL_TARGET_NAMES',
  'VatError',
  'ZodTypeNames',
  'canonicalPath',
  'compareCodeUnits',
  'copyDirectory',
  'crawlTimingStart',
  'createSymlink',
  'createSymlinkAsync',
  'decodeTextContent',
  'detachGitEnv',
  'direntKind',
  'direntKindFollowing',
  'direntKindFollowingSync',
  'dynamicImportPath',
  'ensureTimingDirectory',
  'errnoError',
  'fileContentHash',
  'fillPathSpellings',
  'fillRealpaths',
  'findConfigFile',
  'findNodeWorkspaceRoot',
  'findProjectRoot',
  'getRelativePath',
  'getZodTypeName',
  'globMagicRemainder',
  'hasParentTraversalSegment',
  'isAbsoluteAnyPlatform',
  'isAbsolutePath',
  'isFilesystemAccessError',
  'isGlob',
  'isPathAbsentError',
  'isSingleFsSegment',
  'isUnderRoot',
  'isVatError',
  'isZodNullable',
  'isZodOptional',
  'isZodType',
  'issueLocation',
  'mkdirSyncReal',
  'normalizePath',
  'normalizeTimingDirectory',
  'normalizedTmpdir',
  'parseEnvBoolean',
  'parseWholeNumberAtLeast',
  'pathSpellingFrom',
  'prefixMessageOnce',
  'readTextContent',
  'readTextContentSync',
  'readTimingProcess',
  'realpathFrom',
  'recordContributorInvocation',
  'recordCrawlPass',
  'recordRegistryPass',
  'recordSharedPass',
  'relativeEscapesRoot',
  'resetProjectRootCaches',
  'resolveAssetReference',
  'resolveFromImportMeta',
  'resolveSkillTarget',
  'safePath',
  'spellingWalkRoot',
  'staticGlobBase',
  'symlinkCapability',
  'toAbsolutePath',
  'toForwardSlash',
  'toForwardSlashAnyPlatform',
  'toNfc',
  'transientRefusalClause',
  'unwrapZodType',
  'withContributorStratum',
  'withOuterBracket',
  'writeTimingDump',
];

describe('@vibe-agent-toolkit/utils — the `.` barrel export surface', () => {
  it('exports exactly the recorded set, sorted — nothing added, dropped, or out of order', async () => {
    expect(findBarrelDrift(await import('../src/index.js'), BARREL_EXPORTS)).toEqual({ added: [], removed: [], unsorted: [] });
  });
});
