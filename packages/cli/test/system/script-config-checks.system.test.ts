/**
 * The repo's typecheck-script rule, run as the `vat resources check` it ships as: a workspace member
 * with a `tsconfig.eslint.json` program declares `typecheck` exactly, one without declares none, and
 * the root declares `typecheck:root` exactly when `tsconfig.root.json` exists.
 *
 * The rule is the `typecheck-scripts` entry of the repo's own `vibe-agent-toolkit.config.yaml`, which
 * also holds the only copy of the two script strings. The suite harness reads the entry FROM that
 * file, so a case exercises the shipped statement, never a copy.
 */

import { describe, it } from 'vitest';

import { brokenSubjectCase, shippedCheckTest, UNPARSEABLE, type CaseTree, type ShippedCheckCase } from '../helpers/shipped-check-suite.js';

const MEMBER_SCRIPT = 'node ../../typecheck-task.js tsconfig.eslint.json';
const ROOT_SCRIPT = 'node typecheck-task.js tsconfig.root.json';
const ROOT = 'package.json';
const PKG_A = 'packages/a/package.json';
const PKG_B = 'packages/b/package.json';
const PROGRAM_A = 'packages/a/tsconfig.eslint.json';
const PROGRAM_B = 'packages/b/tsconfig.eslint.json';
const ROOT_PROGRAM = 'tsconfig.root.json';
const PROGRAM = { extends: '../../tsconfig.base.json', compilerOptions: { noEmit: true } };

/** The tree every case starts from: package a has a program and its script, package b has neither. */
const CLEAN: CaseTree = {
  [ROOT]: { name: 'root', private: true, workspaces: ['packages/*'], scripts: { 'typecheck:root': ROOT_SCRIPT } },
  [ROOT_PROGRAM]: { include: ['*.ts'] },
  [PKG_A]: { name: 'a', scripts: { build: 'tsc', typecheck: MEMBER_SCRIPT } },
  [PROGRAM_A]: PROGRAM,
  [PKG_B]: { name: 'b', scripts: { build: 'true' } },
};

// The messages, written out in full: a case pins what a finding SAYS, not only where it is.
function memberWrong(path: string, program: string, declared: string): string {
  return `${path} declares ${declared}, but ${program} exists, so typecheck must be exactly "${MEMBER_SCRIPT}". Without it the package's test files are never type-checked.`;
}

function memberExtra(path: string, program: string, shown: string): string {
  return `${path} declares typecheck as ${shown}, but there is no ${program} program for it to check. Remove the script, or add the program (bun run generate:lint-config writes it for a package ESLint lints TypeScript in).`;
}

function rootWrong(declared: string): string {
  return `${ROOT} declares ${declared}, but tsconfig.root.json exists, so typecheck:root must be exactly "${ROOT_SCRIPT}". Without it the tsconfig.root.json program is checked unguarded, or not at all.`;
}

const CASES: readonly ShippedCheckCase[] = [
  { name: 'a clean workspace is silent', files: {}, expected: [] },
  {
    name: 'a wrong typecheck script is a finding',
    files: { [PKG_A]: { name: 'a', scripts: { typecheck: 'tsc --noEmit' } } },
    expected: [[PKG_A, memberWrong(PKG_A, PROGRAM_A, 'typecheck as "tsc --noEmit"')]],
  },
  {
    name: 'a missing typecheck script is a finding',
    files: { [PKG_A]: { name: 'a', scripts: { build: 'tsc' } } },
    expected: [[PKG_A, memberWrong(PKG_A, PROGRAM_A, 'no typecheck script')]],
  },
  {
    name: 'a manifest with no scripts at all is a finding',
    files: { [PKG_A]: { name: 'a' } },
    expected: [[PKG_A, memberWrong(PKG_A, PROGRAM_A, 'no typecheck script')]],
  },
  {
    name: 'a non-string typecheck script is a finding that names its type',
    files: { [PKG_A]: { name: 'a', scripts: { typecheck: true } } },
    expected: [[PKG_A, memberWrong(PKG_A, PROGRAM_A, 'typecheck as a boolean (true)')]],
  },
  {
    name: 'a typecheck script with no program is a finding',
    files: { [PKG_B]: { name: 'b', scripts: { typecheck: MEMBER_SCRIPT } } },
    expected: [[PKG_B, memberExtra(PKG_B, PROGRAM_B, `"${MEMBER_SCRIPT}"`)]],
  },
  {
    name: 'the rule follows the program: a package that gains one needs the script, one that loses it needs none',
    files: { [PROGRAM_A]: null, [PROGRAM_B]: PROGRAM },
    expected: [
      [PKG_A, memberExtra(PKG_A, PROGRAM_A, `"${MEMBER_SCRIPT}"`)],
      [PKG_B, memberWrong(PKG_B, PROGRAM_B, 'no typecheck script')],
    ],
  },
  {
    name: 'a wrong typecheck:root is a finding',
    files: { [ROOT]: { name: 'root', private: true, workspaces: ['packages/*'], scripts: { 'typecheck:root': 'node typecheck-task.js tsconfig.json' } } },
    expected: [[ROOT, rootWrong('typecheck:root as "node typecheck-task.js tsconfig.json"')]],
  },
  {
    name: 'a missing typecheck:root is a finding',
    files: { [ROOT]: { name: 'root', private: true, workspaces: ['packages/*'] } },
    expected: [[ROOT, rootWrong('no typecheck:root script')]],
  },
  {
    name: 'a typecheck:root with no tsconfig.root.json is a finding',
    files: { [ROOT_PROGRAM]: null },
    expected: [[ROOT, `${ROOT} declares typecheck:root as "${ROOT_SCRIPT}", but there is no tsconfig.root.json program for it to check. Remove the script.`]],
  },
  {
    name: 'no tsconfig.root.json and no typecheck:root is silent',
    files: { [ROOT_PROGRAM]: null, [ROOT]: { name: 'root', private: true, workspaces: ['packages/*'] } },
    expected: [],
  },
  {
    // The package set is the workspace's: a directory the patterns exclude is not checked.
    name: 'a directory that is not a workspace member is not checked',
    files: {
      [ROOT]: { name: 'root', private: true, workspaces: ['packages/*', '!packages/b'], scripts: { 'typecheck:root': ROOT_SCRIPT } },
      [PKG_B]: { name: 'b', scripts: { typecheck: 'anything' } },
    },
    expected: [],
  },
  {
    // The root rule does not depend on a workspace; with none there are no members to check.
    name: 'a tree that declares no workspace still checks the root',
    files: { [ROOT]: { name: 'root', private: true }, [PKG_A]: { name: 'a' } },
    expected: [[ROOT, rootWrong('no typecheck:root script')]],
  },
  brokenSubjectCase('a member manifest that does not parse is not a finding', PKG_A, {
    files: { [PKG_B]: { name: 'b', scripts: { typecheck: MEMBER_SCRIPT } } },
    expected: [[PKG_B, memberExtra(PKG_B, PROGRAM_B, `"${MEMBER_SCRIPT}"`)]],
  }),
  {
    // The root manifest decides membership, so with no rows the workspace relations are refused and
    // the check cannot run; its DATA_FILE_NO_ROWS finding names the file.
    name: 'a root manifest that does not parse refuses the check',
    files: { [ROOT]: UNPARSEABLE },
    expected: { broken: 'INPUT_UNREADABLE' },
  },
  // A program that does not parse still exists, so the script it needs is still required.
  brokenSubjectCase('a program that does not parse still requires the script', PROGRAM_A, {
    files: { [PKG_A]: { name: 'a' } },
    expected: [[PKG_A, memberWrong(PKG_A, PROGRAM_A, 'no typecheck script')]],
  }),
];

const SUITE = { checks: ['typecheck-scripts'], base: CLEAN, cases: CASES, prefix: 'script-config' } as const;

describe(`the shipped ${SUITE.checks.join(', ')} check`, () => {
  it.each(CASES)('$name', shippedCheckTest(SUITE));
});
