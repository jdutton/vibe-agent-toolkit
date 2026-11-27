/**
 * The repo's workspace-config rules, run as the `vat resources check` they ship as: every package
 * tsconfig is composite and extends the shared base, and every internal dependency uses the
 * workspace protocol (CLAUDE.md, "TypeScript Monorepo Build System"; docs/build-system.md).
 *
 * The rules are `resources.checks` entries in the repo's own `vibe-agent-toolkit.config.yaml`. The
 * suite harness reads them FROM that file, so a case exercises the shipped statements, never a copy.
 * All three run in every case, so a case also proves the other two stay silent.
 *
 * workspace-protocol reads membership from the workspace relations, so every tree declares its
 * workspace (`workspaces` in the root package.json, as bun reads it); a tree that declares none has
 * no members, so workspace-protocol examines nothing and fails the run.
 */

import { describe, it } from 'vitest';

import { brokenSubjectCase, shippedCheckTest, type CaseTree, type ShippedCheckCase } from '../helpers/shipped-check-suite.js';

const BASE = '../../tsconfig.base.json';
const TS_A = 'packages/a/tsconfig.json';
const TS_B = 'packages/b/tsconfig.json';
const PKG_A = 'packages/a/package.json';
const PKG_B = 'packages/b/package.json';
const SCOPED = '@scope/b';

const TSCONFIG = { extends: BASE, compilerOptions: { composite: true, outDir: './dist' } };

const WORKSPACES = ['packages/*'];

/** The tree every case starts from: a bun workspace of two packages, one depending on the other (scoped) through the workspace. */
const CLEAN: CaseTree = {
  'package.json': { name: 'root', private: true, workspaces: WORKSPACES, devDependencies: { [SCOPED]: 'workspace:*', typescript: '^5.0.0' } },
  [PKG_A]: { name: 'a', dependencies: { [SCOPED]: 'workspace:*', zod: '^3.0.0' } },
  [PKG_B]: { name: SCOPED, version: '0.1.5' },
  [TS_A]: TSCONFIG,
  [TS_B]: TSCONFIG,
};

// The messages, written out in full: a case pins what a finding SAYS, not only where it is.
function notComposite(path: string): string {
  return `${path} does not set compilerOptions.composite to true. Every package tsconfig must, because the build is tsc --build over project references (docs/build-system.md).`;
}

function wrongBase(path: string, shown: string): string {
  return `${path} ${shown} instead of extending "${BASE}". Every package tsconfig must extend the shared base so all packages compile under one set of compiler options.`;
}

function notWorkspace(path: string, section: string, dep: string, shown: string): string {
  return `${path} declares ${section} "${dep}" as ${shown}. "${dep}" is a package in this workspace, so the range must use the workspace protocol ("workspace:*"); a registry range builds against a published copy instead of the local source (docs/build-system.md).`;
}

const CASES: readonly ShippedCheckCase[] = [
  { name: 'a clean workspace is silent', files: {}, expected: [] },
  {
    name: 'composite false is a finding',
    files: { [TS_B]: { ...TSCONFIG, compilerOptions: { composite: false } } },
    expected: [[TS_B, notComposite(TS_B)]],
  },
  {
    name: 'composite as the string "true" is a finding',
    files: { [TS_B]: { ...TSCONFIG, compilerOptions: { composite: 'true' } } },
    expected: [[TS_B, notComposite(TS_B)]],
  },
  {
    // `1` is stored as INTEGER 1, the same value as `true`; only the JSON type refuses it.
    name: 'composite as the number 1 is a finding',
    files: { [TS_B]: { ...TSCONFIG, compilerOptions: { composite: 1 } } },
    expected: [[TS_B, notComposite(TS_B)]],
  },
  {
    name: 'a tsconfig with no compilerOptions is a finding',
    files: { [TS_B]: { extends: BASE } },
    expected: [[TS_B, notComposite(TS_B)]],
  },
  {
    name: 'a missing extends is a finding',
    files: { [TS_B]: { compilerOptions: { composite: true } } },
    expected: [[TS_B, wrongBase(TS_B, 'sets no extends')]],
  },
  {
    name: 'extending another file is a finding that names it',
    files: { [TS_B]: { ...TSCONFIG, extends: '../tsconfig.base.json' } },
    expected: [[TS_B, wrongBase(TS_B, 'extends "../tsconfig.base.json"')]],
  },
  {
    name: 'an extends array is a finding, even one naming the base',
    files: { [TS_B]: { ...TSCONFIG, extends: [BASE] } },
    expected: [[TS_B, wrongBase(TS_B, 'sets extends to an array')]],
  },
  {
    name: 'a JSONC tsconfig with comments and trailing commas is read',
    files: {
      [TS_B]: `{\n  // the shared base\n  "extends": "${BASE}",\n  /* block */\n  "compilerOptions": { "composite": false, },\n}\n`,
    },
    expected: [[TS_B, notComposite(TS_B)]],
  },
  {
    // Only packages/<name>/tsconfig.json: a test fixture's or a build-variant tsconfig is not a package's.
    name: 'a nested or variant tsconfig is not checked',
    files: {
      'packages/a/test/fixtures/proj/tsconfig.json': { compilerOptions: {} },
      'packages/a/tsconfig.build.json': { compilerOptions: {} },
      'tsconfig.json': { compilerOptions: {} },
    },
    expected: [],
  },
  {
    name: 'a package with no tsconfig.json is not a finding',
    files: { [TS_B]: null },
    expected: [],
  },
  {
    // bun links this range to packages/b (its version satisfies it), and it is still a finding.
    name: 'a scoped internal dependency on a registry range is a finding',
    files: { [PKG_A]: { name: 'a', dependencies: { [SCOPED]: '^0.1.0' } } },
    expected: [[PKG_A, notWorkspace(PKG_A, 'dependencies', SCOPED, '"^0.1.0"')]],
  },
  {
    // The range links nothing (targetPath null), and that is the published copy the rule exists to catch.
    name: 'a registry range the member\'s version does not satisfy is a finding',
    files: { [PKG_A]: { name: 'a', dependencies: { [SCOPED]: '^2.0.0' } } },
    expected: [[PKG_A, notWorkspace(PKG_A, 'dependencies', SCOPED, '"^2.0.0"')]],
  },
  {
    // Membership is the root's `workspaces`, not a packages/* glob in the check.
    name: 'a member outside packages/ is internal and checked',
    files: {
      'package.json': { name: 'root', private: true, workspaces: [...WORKSPACES, 'tools/*'] },
      'tools/t/package.json': { name: 't', dependencies: { a: '^1.0.0' } },
      [PKG_A]: { name: 'a', dependencies: { t: '1.0.0' } },
    },
    expected: [
      [PKG_A, notWorkspace(PKG_A, 'dependencies', 't', '"1.0.0"')],
      ['tools/t/package.json', notWorkspace('tools/t/package.json', 'dependencies', 'a', '"^1.0.0"')],
    ],
  },
  {
    // With no `workspaces` there is no workspace: no member, so nothing is internal, and the
    // rule examined nothing, which fails the run rather than passing a rule that lost its subjects.
    name: 'a tree that declares no workspace examines nothing, and fails',
    files: {
      'package.json': { name: 'root', private: true },
      [PKG_A]: { name: 'a', dependencies: { [SCOPED]: '^0.1.0' } },
    },
    expected: [],
    examined: { 'workspace-protocol': 0 },
  },
  {
    // A member pnpm's or bun's pattern does not match is not a member, whatever its directory.
    name: 'a packages/ directory the workspace patterns exclude is not a member',
    files: {
      'package.json': { name: 'root', private: true, workspaces: [...WORKSPACES, '!packages/b'] },
      [PKG_A]: { name: 'a', dependencies: { [SCOPED]: '^0.1.0' } },
    },
    expected: [],
  },
  {
    name: 'every dependency section is checked, the root manifest too',
    files: {
      'package.json': { name: 'root', private: true, workspaces: WORKSPACES, devDependencies: { [SCOPED]: '0.1.0' } },
      [PKG_A]: {
        name: 'a',
        peerDependencies: { [SCOPED]: '>=0.1.0' },
        optionalDependencies: { [SCOPED]: 'latest' },
      },
    },
    expected: [
      ['package.json', notWorkspace('package.json', 'devDependencies', SCOPED, '"0.1.0"')],
      [PKG_A, notWorkspace(PKG_A, 'optionalDependencies', SCOPED, '"latest"')],
      [PKG_A, notWorkspace(PKG_A, 'peerDependencies', SCOPED, '">=0.1.0"')],
    ],
  },
  {
    // `/` in a key is `~1` in its JSON Pointer and `~` is `~0`; the check matches on the decoded key.
    name: 'a name with ~ and / is matched decoded, not as its pointer escape',
    files: {
      [PKG_B]: { name: '@s~x/b~1' },
      [PKG_A]: { name: 'a', dependencies: { '@s~x/b~1': '1.0.0' } },
    },
    expected: [[PKG_A, notWorkspace(PKG_A, 'dependencies', '@s~x/b~1', '"1.0.0"')]],
  },
  {
    name: 'a non-string range is a finding that names its type',
    files: { [PKG_A]: { name: 'a', dependencies: { [SCOPED]: 1 } } },
    expected: [[PKG_A, notWorkspace(PKG_A, 'dependencies', SCOPED, 'a number (1)')]],
  },
  {
    name: 'an external dependency is never flagged',
    files: { [PKG_A]: { name: 'a', dependencies: { zod: '^3.0.0', '@types/node': '^22.0.0' } } },
    expected: [],
  },
  {
    // A name only counts when a packages/<name>/package.json declares it, not a nested fixture.
    name: 'a dependency on a nested fixture name is not internal',
    files: {
      'packages/a/test/fixtures/p/package.json': { name: 'fixture-pkg' },
      [PKG_A]: { name: 'a', dependencies: { 'fixture-pkg': '^1.0.0' } },
    },
    expected: [],
  },
  {
    // peerDependenciesMeta keys name internal packages, but its values are objects, not ranges.
    name: 'peerDependenciesMeta is not a dependency section',
    files: { [PKG_A]: { name: 'a', peerDependenciesMeta: { [SCOPED]: { optional: true } } } },
    expected: [],
  },
  {
    // Only a direct member of a section is a dependency: a malformed entry's own keys are not.
    name: 'a key nested under a dependency entry is not a dependency',
    files: { [PKG_A]: { name: 'a', dependencies: { zod: { [SCOPED]: '^0.1.0' } } } },
    expected: [],
  },
  {
    // The root manifest is the workspace, not a package in it: nothing depends on it by name.
    name: "a dependency named like the root manifest is not internal",
    files: { [PKG_A]: { name: 'a', dependencies: { root: '^1.0.0' } } },
    expected: [],
  },
  // The member's name is unknown, so the check cannot see the dependency on it and says nothing;
  // the file is one DATA_FILE_NO_ROWS finding, which fails the run, so the defect never reads as clean.
  brokenSubjectCase('a member that does not parse fails the run without a second finding', PKG_B, {
    files: { [PKG_A]: { name: 'a', dependencies: { [SCOPED]: '^0.1.0' } } },
  }),
  brokenSubjectCase('a tsconfig that does not parse is not a finding of the tsconfig checks', TS_B, {
    files: { [TS_A]: { ...TSCONFIG, compilerOptions: { composite: false } } },
    expected: [[TS_A, notComposite(TS_A)]],
  }),
  {
    name: 'a nested fixture manifest is not checked',
    files: { 'packages/a/test/fixtures/p/package.json': { name: 'f', dependencies: { [SCOPED]: '^0.1.0' } } },
    expected: [],
  },
];

const SUITE = {
  checks: ['tsconfig-composite', 'tsconfig-extends-base', 'workspace-protocol'],
  base: CLEAN,
  cases: CASES,
  prefix: 'workspace-config',
} as const;

describe(`the shipped ${SUITE.checks.join(', ')} checks`, () => {
  it.each(CASES)('$name', shippedCheckTest(SUITE));
});
